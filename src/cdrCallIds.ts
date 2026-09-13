import { useEffect, useSyncExternalStore } from 'react';
import { hostProps, identityNamespaceFor } from './host';
import { HorizonExtensionContext } from './horizon';

// Getting a call log row's SIP Call-ID, which the row itself does not carry.
//
// This was the first design's mistaken assumption, and it is worth stating why
// it is wrong, because every published source says otherwise. NetSapiens keeps
// CDRs in monthly tables split by shape — `YYYYMM_{r,d,m,u,g}` — and the `cdrs2`
// object a call log reads is the `_d` one, which has no `orig_callid` column at
// all. `fields.csv` and `openapi.json` both list `call-orig-call-id` for cdrs2,
// but the composed field map is built by iterating the Table class's own
// `schemaApiToDb`, and CdrDsTable has no entry for it: the CSV can rename a
// field, never add one. Horizon's own `useResolveSipFlowCdrId` is the tell —
// it exists precisely because a row carries only the CDR id.
//
// What a row DOES carry is `call-parent-cdr-id`, and the raw `_r` row keyed by
// it holds the Call-ID. `Cdrs2Controller::addExtraData` merges that raw row
// into every row of a response when `raw` is set OR the limit is 100 or less.
// Horizon asks for `pageSize: 5000`, which is exactly why its own rows lack it,
// and ours does not have to: one request for the same window at limit 100
// returns the CDR id and the Call-ID together, for up to a hundred rows.
//
// The other route — `?orig_callid=X` — is hard-limited to `->limit(1)` in
// `createModel`, one call per request, and would also be wrong here: two CDR
// rows can share one orig_callid (seen in practice: the same session, 6 s and
// 3 s, same subscriber, same second), so resolving in that direction finds one
// row and leaves its twin bare. Resolving per CDR id gets both, and both
// correctly show the same recordings.

// A CDR id's Call-ID is a fact about a finished call; it never changes. The TTL
// is here to bound the map's lifetime, not because the answer can go stale.
const READY_TTL_MS = 30 * 60 * 1000;
// A failed lookup stands briefly so a whole page of rows does not retry at once.
const ERROR_TTL_MS = 60 * 1000;
// Long enough for a screen of virtualised rows to mount, short enough to be
// invisible. Slightly longer than the platform batcher's: the rows resolve
// here first and the recordings lookup follows from the result.
const BATCH_WINDOW_MS = 60;
// The limit at or below which the host merges the raw row. Asking for more
// would return more rows AND stop answering the question they were fetched for.
const PAGE_LIMIT = 100;
// Rows the batch did not resolve get one narrow request each — but only a few.
// A grid sorted by something other than time can render rows scattered across
// days, and chasing every one of them would be a request per row.
const MAX_STRAGGLERS = 3;
// Horizon rate-limits an app to 100 API calls a minute across everything it
// does. Staying well under that is this module's business: tripping the limiter
// would break the app's other calls, not just this lookup.
const BUDGET_MAX = 30;
const BUDGET_WINDOW_MS = 60 * 1000;

// The row fields the Call-ID can arrive under. `getRawById` reads the raw table
// outside the v2 aliasing path, so the merged keys are the database's own
// spelling — but a host that aliases them would send the v2 name, and the
// difference is one comparison.
const CALL_ID_FIELDS = ['call-orig-call-id', 'orig_callid'];
const CDR_ID_FIELDS = ['call-parent-cdr-id', 'cdr_id'];

interface Entry {
  state: 'ready' | 'error';
  callId: string | null;
  at: number;
}

interface Wanted {
  startedAt: number;   // ms; the window a lookup has to cover
  path: string;        // which cdrs collection this row belongs to
}

let namespace = '';
const cache = new Map<string, Entry>();
const wanted = new Map<string, Wanted>();
// Cdr ids whose batch has left but not landed — see the same guard in
// ./callGroups for what goes wrong without it.
const inFlight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let requestTimes: number[] = [];
// What the last lookup asked and what came back. This module fails into "no
// buttons", which is the right behaviour and a terrible diagnostic — inside
// Horizon there is no page of ours to show an error on, so the state is kept
// here and exposed through ./probe instead.
let lastBatch: { path: string; from: number; to: number } | null = null;
let lastError: string | null = null;
let lastRowKeys: string[] = [];
let lastRowCount = -1;
// The last row a button was handed, and what was made of it. Recorded because
// "no lookup was attempted" has two very different causes — the component never
// ran, or it ran and the row did not carry what it needs — and nothing else can
// tell them apart from outside the browser.
let lastRow: Record<string, unknown> | null = null;
let renders = 0;

let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  listeners.forEach(l => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getVersion(): number {
  return version;
}

function ensureNamespace(): void {
  const ns = identityNamespaceFor(hostProps);
  if (ns === namespace) return;
  namespace = ns;
  cache.clear();
  wanted.clear();
  inFlight.clear();
}

function fresh(entry: Entry): boolean {
  const ttl = entry.state === 'error' ? ERROR_TTL_MS : READY_TTL_MS;
  return Date.now() - entry.at < ttl;
}

function spend(): boolean {
  const now = Date.now();
  requestTimes = requestTimes.filter(t => now - t < BUDGET_WINDOW_MS);
  if (requestTimes.length >= BUDGET_MAX) return false;
  requestTimes.push(now);
  return true;
}

function pick(row: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

// The NetSapiens API's datetime format: local clock parts with the IANA zone
// appended, e.g. 2026-08-21T13:00:00Z[America/Los_Angeles]. The trailing Z is
// part of the shape rather than a UTC marker — this mirrors Horizon's own
// formatDateWithTimezone exactly, because a window in any other spelling
// silently selects the wrong monthly CDR table.
function nsDateTime(date: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    + `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}Z[${zone}]`;
}

// Reading a datetime the host put on a row.
//
// The NetSapiens API returns `2026-08-21T14:50:17Z[America/Los_Angeles]` — ISO
// 8601 with a named zone in brackets, and the `Z` is part of that shape rather
// than a UTC marker. `Date.parse` returns NaN for it: the bracketed suffix is
// not ISO 8601, and no browser accepts it.
//
// That NaN is what silently disabled every button in the first build. The row
// had its CDR id, the route matched, both extensions were registered — and each
// one decided it could not build a lookup window, so nothing was ever asked.
//
// Horizon's own `formatDate` does the same strip (helpers/format/date.ts), and
// reads the remainder as LOCAL wall-clock time, which is also what makes the
// round trip through nsDateTime() below correct: that emits local parts plus
// the zone name, so parsing and formatting agree.
export function parseHostDateTime(value: unknown): number {
  // Defensive: a host that ever sends the underlying unix column instead.
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value !== 'string' || value.trim() === '') return NaN;
  const zoned = value.match(/^(.+?)Z\[(.+?)\]$/);
  return Date.parse(zoned ? zoned[1] : value);
}

// Said once per session: a row that carries a CDR id but no readable start time
// cannot be looked up, and that must never again be invisible.
let dateWarned = false;

// Which cdrs collection to ask. Mirrors what the call-logs page itself queries,
// because that is the path each scope is known to be allowed:
//
//   /home/call-logs          CallList isMyAccount  -> the user's own calls
//   /manage/:domain/...      a domain in the path  -> that domain
//   anything else            the row's own domain, or the whole platform
//
// The row's domain is preferred over the user's for the general case: a
// system-level list carries rows from several domains, and each is asked for
// under its own.
function cdrPathFor(context: HorizonExtensionContext, row: Record<string, unknown>): string | null {
  const user = context.user;
  if (context.route === '/home/call-logs') {
    return user?.domain && user?.username
      ? `/domains/${user.domain}/users/${user.username}/cdrs`
      : null;
  }
  const routeDomain = (context.params?.domain ?? '').trim();
  if (routeDomain) return `/domains/${routeDomain}/cdrs`;
  const rowDomain = pick(row, ['domain']);
  if (rowDomain) return `/domains/${rowDomain}/cdrs`;
  return '/cdrs';
}

// One request covering a time window, indexing every row it returns — including
// rows nobody asked about, which are free and likely to be asked about next.
async function lookup(path: string, from: number, to: number): Promise<number> {
  const api = hostProps.api;
  if (!api?.get || !spend()) return 0;

  lastBatch = { path, from, to };
  const rows = await api.get(path, {
    'datetime-start': nsDateTime(new Date(from)),
    'datetime-end': nsDateTime(new Date(to)),
    limit: PAGE_LIMIT,
    // Belt and braces: `raw` is read by createModel, and the limit above is the
    // other half of the same condition in addExtraData. Either one alone would
    // do; both together survive one of them changing.
    raw: 'yes',
  });

  lastRowCount = Array.isArray(rows) ? rows.length : -1;
  lastRowKeys = Array.isArray(rows) && rows[0] && typeof rows[0] === 'object'
    ? Object.keys(rows[0] as Record<string, unknown>) : [];
  if (!Array.isArray(rows)) return 0;
  const at = Date.now();
  let learned = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const cdrId = pick(row, CDR_ID_FIELDS);
    if (!cdrId) continue;
    cache.set(cdrId, { state: 'ready', callId: pick(row, CALL_ID_FIELDS), at });
    learned += 1;
  }
  return learned;
}

async function flush(): Promise<void> {
  timer = null;
  const batch = Array.from(wanted.entries());
  wanted.clear();
  if (batch.length === 0) return;
  batch.forEach(([cdrId]) => inFlight.add(cdrId));

  // Usually one path for the whole page; a system-level list can hold rows from
  // several domains, and each domain is one request.
  const byPath = new Map<string, Array<[string, Wanted]>>();
  batch.forEach(entry => {
    const list = byPath.get(entry[1].path);
    if (list) list.push(entry); else byPath.set(entry[1].path, [entry]);
  });

  const asked = namespace;
  for (const [path, entries] of byPath) {
    const times = entries.map(e => e[1].startedAt);
    // Two seconds of slack at each end: the window is compared against the
    // call's start on the server, and a row's rendered timestamp is a formatted
    // second, not the exact one.
    const from = Math.min(...times) - 2000;
    const to = Math.max(...times) + 2000;

    try {
      await lookup(path, from, to);
      if (asked !== namespace) return;

      // Rows the window did not answer for. With the grid in its default time
      // order the rendered rows are contiguous and there are none; sorted by
      // another column they can be scattered, and the batch's window may hold
      // more than PAGE_LIMIT calls.
      const missing = entries.filter(([cdrId]) => !cache.has(cdrId));
      for (const [cdrId, want] of missing.slice(0, MAX_STRAGGLERS)) {
        await lookup(path, want.startedAt - 2000, want.startedAt + 2000);
        if (asked !== namespace) return;
        if (!cache.has(cdrId)) {
          cache.set(cdrId, { state: 'error', callId: null, at: Date.now() });
        }
      }
      // Anything still unaccounted for is recorded as unresolved rather than
      // retried on every render; the TTL lets a later pass try again.
      const at = Date.now();
      missing.slice(MAX_STRAGGLERS).forEach(([cdrId]) => {
        if (!cache.has(cdrId)) cache.set(cdrId, { state: 'error', callId: null, at });
      });
    } catch (e: any) {
      if (asked !== namespace) return;
      lastError = e?.message || String(e);
      // Said once, loudly. The rows degrade to no buttons either way, but a
      // console with nothing in it is what turns a broken lookup into an
      // afternoon of guessing.
      console.error('[siprec] call-log Call-ID lookup failed for', path, '-', lastError);
      const at = Date.now();
      // A refused or failed lookup means no buttons on those rows, which is the
      // safe outcome — better than a button that cannot answer when pressed.
      entries.forEach(([cdrId]) => {
        if (!cache.has(cdrId)) cache.set(cdrId, { state: 'error', callId: null, at });
      });
    }
  }
  batch.forEach(([cdrId]) => inFlight.delete(cdrId));
  notify();
}

function request(cdrId: string, startedAt: number, path: string): void {
  ensureNamespace();
  const entry = cache.get(cdrId);
  if (entry && fresh(entry)) return;
  if (wanted.has(cdrId) || inFlight.has(cdrId)) return;
  wanted.set(cdrId, { startedAt, path });
  if (timer === null) {
    timer = setTimeout(() => { void flush(); }, BATCH_WINDOW_MS);
  }
}

export interface RowCallId {
  state: 'loading' | 'ready' | 'error';
  // The SIP Call-ID of the row's session, which is the SIPREC group id. Null
  // once resolved if this CDR has none — a call that never reached the raw
  // table, for instance.
  callId: string | null;
}

// The Call-ID for one call log row, resolving it if it is not known yet.
//
// A row that already carries it — a host that aliases the merged raw fields, or
// any listing fetched at a limit that merged them — is answered immediately and
// costs nothing.
export function useRowCallId(
  context: HorizonExtensionContext, row: Record<string, unknown> | null,
): RowCallId {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);

  const direct = row ? pick(row, CALL_ID_FIELDS) : null;
  const cdrId = row ? pick(row, CDR_ID_FIELDS) : null;
  const startedRaw = row ? row['call-start-datetime'] : null;
  const startedAt = parseHostDateTime(startedRaw);
  const path = row ? cdrPathFor(context, row) : null;
  const resolvable = !direct && !!cdrId && !!path && Number.isFinite(startedAt);

  // Diagnostic only, and deliberately a plain assignment during render: it
  // depends on nothing, affects nothing, and the alternative (an effect) would
  // not run for the case worth catching, where the component renders and bails.
  renders += 1;
  lastRow = row;
  if (!direct && cdrId && !Number.isFinite(startedAt) && !dateWarned) {
    dateWarned = true;
    console.error('[siprec] cannot read a call log row\'s start time, so its '
      + 'recordings cannot be looked up. Value was:', startedRaw);
  }

  useEffect(() => {
    if (resolvable) request(cdrId as string, startedAt, path as string);
    // `v` is deliberate and does not loop: request() returns without notifying
    // whenever the answer is cached or already queued, so only an answer
    // arriving raises the version. It is what makes this re-ask after the cache
    // is cleared for a new identity.
  }, [resolvable, cdrId, startedAt, path, v]);

  if (direct) return { state: 'ready', callId: direct };
  if (!resolvable) return { state: 'error', callId: null };
  const entry = cdrId ? cache.get(cdrId) : undefined;
  if (!entry) return { state: 'loading', callId: null };
  return { state: entry.state, callId: entry.callId };
}

// ------------------------------------------------------------------ probe
// Read-only state for ./probe. Not part of how the buttons work.
export function callIdDiagnostics() {
  return {
    namespace,
    lastBatch,
    lastError,
    lastRowCount,
    // The field names the host actually returned. Whether the raw CDR row was
    // merged in — and under which spelling — is the single thing this whole
    // module depends on, and it is invisible from anywhere else.
    lastRowKeys,
    // What the buttons have actually seen. `renders` at 0 means the components
    // were never rendered into the row at all, which is a host-side question,
    // not a lookup one.
    renders,
    lastRow: lastRow === null ? null : {
      keys: Object.keys(lastRow),
      cdrId: pick(lastRow, CDR_ID_FIELDS),
      callIdOnRow: pick(lastRow, CALL_ID_FIELDS),
      startedRaw: lastRow['call-start-datetime'] ?? null,
      startedType: typeof lastRow['call-start-datetime'],
      domain: lastRow['domain'] ?? null,
    },
    resolved: Array.from(cache.entries()).map(([cdrId, e]) => ({
      cdrId, state: e.state, callId: e.callId,
    })),
    pending: Array.from(wanted.keys()),
    inFlight: Array.from(inFlight),
    hasApi: !!hostProps.api?.get,
  };
}

// Re-runs the last lookup and hands back what the host answered, unfiltered.
// The point is to see the error or the row shape, so nothing is swallowed.
export async function probeCallIdLookup(): Promise<unknown> {
  if (!hostProps.api?.get) return { error: 'the host gave this app no api client' };
  const b = lastBatch;
  if (!b) return { error: 'no lookup has been attempted yet — open a call log first' };
  try {
    const rows = await hostProps.api.get(b.path, {
      'datetime-start': nsDateTime(new Date(b.from)),
      'datetime-end': nsDateTime(new Date(b.to)),
      limit: PAGE_LIMIT,
      raw: 'yes',
    });
    const list = Array.isArray(rows) ? rows : [];
    return {
      asked: { ...b, from: new Date(b.from).toISOString(), to: new Date(b.to).toISOString() },
      count: list.length,
      keys: list[0] ? Object.keys(list[0]) : [],
      sample: list.slice(0, 2),
    };
  } catch (e: any) {
    return { asked: b, error: e?.message || String(e) };
  }
}
