import { useEffect, useSyncExternalStore } from 'react';
import { AccessInfo, ConsentParty, PendingConsentRequest, UserConsentAnswer, siprec } from './api';
import { identityNamespaceFor } from './host';
import { HorizonProps } from './horizon';

// One lookup for a page of the Users grid, not one per row.
//
// Same shape and the same reasons as ./callGroups: the button is drawn inside
// Horizon's own table once per row, and each one has to know whether this
// platform holds a consent record for that person before it draws anything at
// all. Most seats on a Users page have never been on a recorded call, so a
// button on every row that usually reports "nothing recorded" is worse than no
// button — and a request per row would be a token-checked round trip per line.
//
// The cache is module-level rather than component state because MUI's grid
// virtualises rows: scrolling unmounts and remounts the same rows constantly,
// and per-component state would re-ask every time.

export type ConsentState = 'loading' | 'ready' | 'error';

export interface UserConsent {
  state: ConsentState;
  // Null once the answer has landed and this platform holds no visible record
  // for the person — which is an answer, not an absence.
  party: ConsentParty | null;
  // Whether this caller may ASK this person for consent. Decided by the
  // platform, never inferred here: seeing a record and being allowed to
  // request one are different permissions on the same person, and a user with
  // no record is exactly the case a stored row cannot answer.
  mayRequest: boolean;
  // An outstanding request, so the popup can show the link that is already out
  // rather than offering to mint a second one beside it.
  pendingRequest: PendingConsentRequest | null;
  // The uid the answer was found under — the spelling to act on, which is not
  // necessarily the first candidate the row offered.
  uid: string | null;
  // The domain's standing policy, seeding the offer form.
  defaultPurposes: string[];
  // Every purpose the platform recognises, so the popup can show one that was
  // NOT consented to rather than silently omitting it. Empty until the first
  // answer arrives.
  purposes: string[];
  error?: string;
  // Where a change would have to be made. This module never writes; the popup
  // uses it only to word the sentence pointing at the Consent page.
  canModify: boolean;
}

// Long enough that paging back and forth through a domain's users is free,
// short enough that a decision made elsewhere while the page is open is not
// hidden all day.
const READY_TTL_MS = 5 * 60 * 1000;
// A failure must not become permanent for the session — but nor should every
// row retry it at once, so a failed batch stands for half a minute.
const ERROR_TTL_MS = 30 * 1000;
// Long enough to collect a viewport of rows, short enough to be invisible.
const BATCH_WINDOW_MS = 40;
// The platform refuses more than this in one request (after de-duplication).
// A row can contribute two candidate uids, so this is half a page of users at
// worst and a full one in the ordinary case where user and extension agree.
const BATCH_MAX = 200;

interface Entry {
  state: 'ready' | 'error';
  answer: UserConsentAnswer | null;
  error?: string;
  at: number;
}

// Everything below is keyed to ONE identity — see identityNamespaceFor().
let namespace = '';
const cache = new Map<string, Entry>();
const waiting = new Set<string>();
// Uids of a batch that has left but not landed. Without this a re-render during
// the request re-queues every id in it: `waiting` is emptied when the batch is
// sent and the cache is not written until the answer arrives, so the window
// between the two looks exactly like "never asked" — and these rows re-render
// constantly. Same bug, same fix, as ./callGroups.
const inFlight = new Set<string>();
let access: AccessInfo | null = null;
let purposes: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
// This fails into "no button", so the failure has to be reachable from
// somewhere. See ./probe.
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
  purposes = [];
}

function fresh(entry: Entry): boolean {
  const ttl = entry.state === 'error' ? ERROR_TTL_MS : READY_TTL_MS;
  return Date.now() - entry.at < ttl;
}

async function flush(host: Partial<HorizonProps>): Promise<void> {
  timer = null;
  const uids = Array.from(waiting).slice(0, BATCH_MAX);
  uids.forEach(uid => { waiting.delete(uid); inFlight.add(uid); });
  // More rows than one request may carry — send this batch now and the rest
  // straight after, rather than dropping them or exceeding the platform's cap.
  if (waiting.size > 0) {
    timer = setTimeout(() => { void flush(host); }, 0);
  }
  if (uids.length === 0) return;

  // The identity these uids were asked under. If it changes while the request
  // is in flight, the answer belongs to nobody on screen and is discarded.
  const asked = namespace;
  const at = Date.now();
  lastAsked = uids;
  try {
    const answer = await siprec.userConsent(host, uids);
    if (asked !== namespace) return;
    access = answer.access;
    purposes = answer.purposes ?? [];
    uids.forEach(uid => cache.set(uid, {
      state: 'ready',
      // A missing key would mean the platform did not answer for this uid at
      // all; it always does, and treating that as "no record" keeps a
      // truncated answer from looking like a permanent negative.
      answer: answer.parties?.[uid] ?? null,
      at,
    }));
  } catch (e: any) {
    if (asked !== namespace) return;
    const error = e?.message || 'Could not reach the recording platform';
    lastError = error;
    console.error('[siprec] consent lookup failed for', uids.length, 'user(s) -', error);
    uids.forEach(uid => cache.set(uid, { state: 'error', answer: null, error, at }));
  } finally {
    uids.forEach(uid => inFlight.delete(uid));
    notify();
  }
}

function request(host: Partial<HorizonProps>, uid: string): void {
  ensureNamespace(host);
  const entry = cache.get(uid);
  if (entry && fresh(entry)) return;
  if (waiting.has(uid) || inFlight.has(uid)) return;
  waiting.add(uid);
  if (timer === null) {
    timer = setTimeout(() => { void flush(host); }, BATCH_WINDOW_MS);
  }
}

// What the platform records for one person, asking for it if it is not known
// yet.
//
// Takes CANDIDATE uids rather than one, because a NetSapiens seat does not
// always answer to a single spelling: `user` is the account name and
// `extension` is the number, they are usually the same string, and the SIP AOR
// the recorder saw could have been built from either. Both are asked for in
// the same batch (the platform dedupes, and on most seats they collapse to one
// id), and the first that comes back with a record is the person.
//
// `version` is in the effect's dependencies deliberately, and does not loop:
// request() returns without notifying whenever the answer is already cached or
// already in flight, so the only thing that raises the version is an answer
// arriving. It is what makes the hook re-ask after the cache is cleared for a
// new identity.
export function useUserConsent(
  host: Partial<HorizonProps>, candidates: string[],
): UserConsent {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  // Stable across renders so the effect does not re-run on a fresh array with
  // the same contents — these rows re-render on every answer that lands.
  const key = candidates.join('|');

  useEffect(() => {
    if (!key) return;
    key.split('|').forEach(uid => request(host, uid));
  }, [host, key, v]);

  const canModify = access?.can_modify_consent !== false;
  const empty = {
    party: null, mayRequest: false, pendingRequest: null, uid: null,
    defaultPurposes: [] as string[], purposes, canModify,
  };

  // No candidate uid is an answer, not a wait: there is nothing to look up, so
  // there is nothing behind this row.
  if (!key) {
    return { state: 'ready', ...empty };
  }

  const uids = key.split('|');
  const entries = uids.map(uid => cache.get(uid));
  // One candidate still outstanding means the row is not yet known to have no
  // record — the other spelling may be the one that has it.
  if (entries.some(e => e === undefined)) {
    return { state: 'loading', ...empty };
  }

  // The spelling that HAS a record wins. Failing that, the first the platform
  // says may be asked — a row with no record still needs one uid to act on,
  // and it should be the one the platform accepted rather than whichever the
  // row happened to list first.
  let at = entries.findIndex(e => e?.answer?.consent);
  if (at < 0) at = entries.findIndex(e => e?.answer?.pending_request);
  if (at < 0) at = entries.findIndex(e => e?.answer?.may_request);

  if (at >= 0) {
    const a = entries[at]!.answer!;
    return {
      state: 'ready',
      party: a.consent,
      mayRequest: a.may_request,
      pendingRequest: a.pending_request,
      uid: uids[at],
      defaultPurposes: a.default_purposes ?? [],
      purposes,
      canModify,
    };
  }

  // Nothing found. An error on any candidate makes the negative unreliable, so
  // report the error rather than "no record".
  const failed = entries.find(e => e?.state === 'error');
  if (failed) {
    return { state: 'error', ...empty, error: failed.error };
  }
  return { state: 'ready', ...empty };
}

// Forgets what is cached for one uid, so the next render asks again.
//
// Called after a consent request is minted or cancelled. The popup already
// knows what changed and could patch the entry in place, but re-asking is the
// honest move: the platform clamps the expiry, intersects the purposes and may
// hand back a DIFFERENT invite than the one that was asked for (a live request
// already out is returned rather than duplicated), so the row should show what
// the platform has rather than what the popup sent.
export function forgetUserConsent(uid: string): void {
  cache.delete(uid);
  notify();
}

// ------------------------------------------------------------------ probe
// Read-only state for ./probe. Not part of how the button works.
export function consentDiagnostics() {
  return {
    namespace,
    lastError,
    lastAsked,
    access,
    purposes,
    known: Array.from(cache.entries()).map(([uid, e]) => ({
      uid, state: e.state,
      hasRecord: !!e.answer?.consent,
      mayRequest: !!e.answer?.may_request,
      pendingRequest: e.answer?.pending_request?.id ?? null,
      error: e.error,
    })),
    pending: Array.from(waiting),
    inFlight: Array.from(inFlight),
  };
}

// Asks the platform directly about one uid, returning whatever it says.
export async function probeUserConsent(
  host: Partial<HorizonProps>, partyUid: string,
): Promise<unknown> {
  try {
    return await siprec.userConsent(host, [partyUid]);
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}
