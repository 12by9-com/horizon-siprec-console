import { useEffect, useSyncExternalStore } from 'react';
import { AccessInfo, CallRecording, siprec } from './api';
import { identityNamespaceFor } from './host';
import { HorizonProps } from './horizon';

// One lookup for a page of call logs, not one per row.
//
// The buttons are drawn inside Horizon's own table, once per row, and each of
// them has to know whether this call has any visible recording before it draws
// anything at all — a button on every call log that usually reports "no
// recording" is worse than no button. A request per row would be a
// token-checked round trip per line; instead every row that mounts asks this
// module, and the asks inside one animation frame or so are answered together.
//
// The cache is module-level rather than component state on purpose: MUI's grid
// virtualises rows, so scrolling unmounts and remounts the same rows
// constantly, and per-component state would re-ask every time.

export type GroupState = 'loading' | 'ready' | 'error';

export interface GroupRecordings {
  state: GroupState;
  recordings: CallRecording[];
  error?: string;
  // False only when the platform says this role may not listen. Until the
  // first answer arrives there is nothing to go on, and the buttons that
  // consult it are not rendered before then anyway.
  canPlay: boolean;
}

// Long enough that paging back and forth through a call log is free, short
// enough that a recording made while the page is open is not hidden all day.
const READY_TTL_MS = 5 * 60 * 1000;
// A failure must not become permanent for the session — but nor should every
// row retry it at once, so a failed batch stands for half a minute.
const ERROR_TTL_MS = 30 * 1000;
// Long enough to collect a viewport of rows, short enough to be invisible.
const BATCH_WINDOW_MS = 40;
// The platform refuses more than this in one request (after de-duplication).
const BATCH_MAX = 100;

interface Entry {
  state: 'ready' | 'error';
  recordings: CallRecording[];
  error?: string;
  at: number;
}

// Everything below is keyed to ONE identity — see identityNamespaceFor().
let namespace = '';
const cache = new Map<string, Entry>();
const waiting = new Set<string>();
// Ids of a batch that has left but not landed. Without this a re-render during
// the request re-queues every id in it: `waiting` is emptied when the batch is
// sent, and the cache is not written until the answer arrives, so the window
// between the two looks exactly like "never asked". Rows re-render constantly
// here — the grid virtualises them and every answer bumps the version — so that
// window was being hit on every page, sending the same batch several times.
const inFlight = new Set<string>();
let access: AccessInfo | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
// Same reasoning as ./cdrCallIds: this fails into "no buttons", so the failure
// has to be reachable from somewhere. See ./probe.
let lastError: string | null = null;
let lastAsked: string[] = [];

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

function ensureNamespace(host: Partial<HorizonProps>): void {
  const ns = identityNamespaceFor(host);
  if (ns === namespace) return;
  namespace = ns;
  cache.clear();
  waiting.clear();
  // Requests already out are discarded on arrival (they check the namespace
  // they were asked under), so their ids must not stay marked as in flight.
  inFlight.clear();
  access = null;
}

function fresh(entry: Entry): boolean {
  const ttl = entry.state === 'error' ? ERROR_TTL_MS : READY_TTL_MS;
  return Date.now() - entry.at < ttl;
}

async function flush(host: Partial<HorizonProps>): Promise<void> {
  timer = null;
  const ids = Array.from(waiting).slice(0, BATCH_MAX);
  ids.forEach(id => { waiting.delete(id); inFlight.add(id); });
  // More rows than one request may carry — send this batch now and the rest
  // straight after, rather than dropping them or exceeding the platform's cap.
  if (waiting.size > 0) {
    timer = setTimeout(() => { void flush(host); }, 0);
  }
  if (ids.length === 0) return;

  // The identity these ids were asked under. If it changes while the request
  // is in flight, the answer belongs to nobody on screen and is discarded.
  const asked = namespace;
  const at = Date.now();
  lastAsked = ids;
  try {
    const answer = await siprec.callRecordings(host, ids);
    if (asked !== namespace) return;
    access = answer.access;
    ids.forEach(id => cache.set(id, {
      state: 'ready',
      // Absent rather than empty would mean the platform did not answer for
      // this id at all; it always does, and treating a missing key as "none"
      // keeps a truncated answer from looking like a permanent negative.
      recordings: answer.groups?.[id] ?? [],
      at,
    }));
  } catch (e: any) {
    if (asked !== namespace) return;
    const error = e?.message || 'Could not reach the recording platform';
    lastError = error;
    console.error('[siprec] recordings lookup failed for', ids.length, 'call id(s) -', error);
    ids.forEach(id => cache.set(id, { state: 'error', recordings: [], error, at }));
  } finally {
    ids.forEach(id => inFlight.delete(id));
    notify();
  }
}

function request(host: Partial<HorizonProps>, groupId: string): void {
  ensureNamespace(host);
  const entry = cache.get(groupId);
  if (entry && fresh(entry)) return;
  if (waiting.has(groupId) || inFlight.has(groupId)) return;
  waiting.add(groupId);
  if (timer === null) {
    timer = setTimeout(() => { void flush(host); }, BATCH_WINDOW_MS);
  }
}

// What is known about one call log row's recordings, asking for them if they
// are not known yet.
//
// `version` is in the effect's dependencies deliberately, and does not loop:
// request() returns without notifying whenever the answer is already cached or
// already in flight, so the only thing that raises the version is an answer
// arriving. It is what makes the hook re-ask after the cache is cleared for a
// new identity.
export function useCallRecordings(
  host: Partial<HorizonProps>, groupId: string | null,
): GroupRecordings {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);

  useEffect(() => {
    if (groupId) request(host, groupId);
  }, [host, groupId, v]);

  // No group id is an answer, not a wait: there is nothing to look up, so
  // there is nothing behind this row. (Callers resolving a group id of their
  // own report their own 'loading' until they have one.)
  if (!groupId) {
    return { state: 'ready', recordings: [], canPlay: access?.can_play_audio !== false };
  }

  const entry = cache.get(groupId);
  return {
    state: entry?.state ?? 'loading',
    recordings: entry?.recordings ?? [],
    error: entry?.error,
    canPlay: access?.can_play_audio !== false,
  };
}

// ------------------------------------------------------------------ probe
// Read-only state for ./probe. Not part of how the buttons work.
export function groupDiagnostics() {
  return {
    namespace,
    lastError,
    lastAsked,
    access,
    known: Array.from(cache.entries()).map(([groupId, e]) => ({
      groupId, state: e.state, recordings: e.recordings.length, error: e.error,
    })),
    pending: Array.from(waiting),
    inFlight: Array.from(inFlight),
  };
}

// Asks the platform directly for one group id, returning whatever it says.
export async function probeRecordings(
  host: Partial<HorizonProps>, groupId: string,
): Promise<unknown> {
  try {
    return await siprec.callRecordings(host, [groupId]);
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}
