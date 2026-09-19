// Talking to the SIPREC platform from inside Horizon.
//
// The page never asserts who the user is. It asks Horizon's broker for a
// token (auth.requestRemoteAuth), which makes NetSapiens' BACKEND post an
// HMAC-signed webhook to the platform carrying the session-bound identity;
// the platform mints its own opaque token and returns it. Everything here
// then travels as that bearer token, and the platform re-derives the caller's
// role from it server-side.
//
// So a modified page cannot see more than its user's role allows: the
// visibility predicate lives in SQL on the platform, not in this bundle.

import { HorizonProps } from './horizon';

// Where the SIPREC platform lives.
//
// The bundle is instance-independent — one build, published once, loaded by any
// number of Horizon clusters that each record to a different platform — so it
// cannot have an address built in. Horizon also cannot tell it: the only thing
// the operator configures there is the Remote Entry URL, the Callback URL and
// the Callback secret, and Horizon rebuilds the token response, forwarding only
// accessToken/tokenType/expiresAt/user, so an extra field would be dropped.
//
// The access token IS passed through verbatim, so the platform puts its own
// address in it: `<base64url(api_base)>.<random>`. The app reads where to call
// out of the token it was just given. That cannot point anywhere wrong — the
// token only exists because the registration's Callback URL reached that
// platform, so it can only name that platform.
//
// SIPREC_API is the FALLBACK, for a token that names no address: a platform
// that does not announce one, or the standalone harness, whose Vite dev server
// proxies this same-origin path. It used to be the only route, via a reverse
// proxy stanza on every portal; that stanza is no longer needed.
export const SIPREC_API = '/siprec-api';

// The last address a token announced. Kept for the one call that carries no
// token — receipt verification, which is unauthenticated by design — and which
// only ever happens after the page has already loaded data with one.
let announcedBase: string | null = null;

// The API address a token carries, or null. Only https is accepted: the
// console runs inside an HTTPS portal, where a browser refuses plain http as
// mixed content, and nothing but an https URL should ever be fetched from.
export function apiBaseFromToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  let b64 = token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
  // The platform strips base64 padding to keep the token URL-safe. Restore it:
  // some decoders tolerate its absence, and one that does not silently drops
  // the final characters instead of failing.
  while (b64.length % 4) b64 += '=';
  try {
    const url = new URL(atob(b64));
    if (url.protocol !== 'https:') return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// Where to send a request made with this token.
function baseFor(token: string): string {
  const base = apiBaseFromToken(token);
  if (base) announcedBase = base;
  return base ?? SIPREC_API;
}

// Where an unauthenticated request should go — the last announced address.
export function currentApiBase(): string {
  return announcedBase ?? SIPREC_API;
}

export const VENDOR_ID = 'siprec';

export type Visibility = 'none' | 'own' | 'domain' | 'territory' | 'all';

export interface Identity {
  party_uid: string;
  domain: string;
  // Which Horizon instance asserted this identity. A uid is unique within one
  // instance and nowhere else, so party_uid alone does not identify a person
  // across clusters. Null on a token minted before the platform started
  // sending it.
  cluster_id: string | null;
  cluster_name: string | null;
  platform_hostname: string | null;
  territory: string | null;
  scope: string;
  display_name: string | null;
}

export interface AccessInfo {
  visibility: Visibility;
  requested_visibility: Visibility;
  can_play_audio?: boolean;
  // Separate from can_play_audio on purpose: starting transcription is not a
  // read. It spends money at Google, rewrites the stored vCon and appends to
  // its lifecycle ledger, so a role trusted to listen is not automatically a
  // role trusted to bill for recognising.
  can_transcribe?: boolean;
  can_modify_consent?: boolean;
  unknown_scope: boolean;
}

export interface RecordingParty {
  name: string | null;
  uid: string | null;
  tel: string | null;
  is_you: boolean;
}

// Why a recording has or has not been transcribed. A null status means it was
// never attempted, which is a different answer from 'empty' (attempted, no
// speech found) — the page says which, rather than showing nothing either way.
export type TranscriptStatus =
  'done' | 'pending' | 'no_consent' | 'no_audio' | 'empty' | 'failed' | null;

export interface Recording {
  uuid: string;
  filename: string;
  created_at: string | null;
  size_bytes: number;
  parties: RecordingParty[];
  transcript_status: TranscriptStatus;
  transcript_chars: number | null;
  transcript_note: string | null;
  has_transcript: boolean;
}

// One recording behind a Horizon Call Logs row.
//
// A call log entry names a SIP session by its orig_callid, and the SBC copies
// that into the SIPREC group id — so one entry can front several recordings:
// a transfer ends one and starts the next under the same group_id with the
// following group_seq. `group_seq` is what orders them; it arrives as a string
// because the recorder stores the rs-metadata value verbatim rather than
// assuming it is a number.
export interface CallRecording {
  uuid: string;
  filename: string;
  // The recorder's own Call-ID for the recording session, not the call log's.
  // Shown nowhere; kept because it is what a recorder log is searchable by.
  call_id: string;
  group_id: string;
  group_seq: string;
  created_at: string | null;
  size_bytes: number;
  // Null while a session is open, or if it ended without a BYE.
  duration_ms: number | null;
  transcript_status: TranscriptStatus;
  transcript_note: string | null;
  has_transcript: boolean;
  parties: RecordingParty[];
}

// Keyed by every group id that was ASKED for, empty array included. That is
// what lets the cache record "asked, and there is none" — without it every
// re-render would re-ask about the calls that were never recorded, which on a
// normal call log is most of them.
export interface CallRecordingsAnswer {
  identity: Identity;
  access: AccessInfo;
  groups: Record<string, CallRecording[]>;
}

// What the recogniser recorded about a single segment it produced. Per-segment,
// because a stereo call is recognised one channel at a time and the two sides
// do not score alike.
export interface GeneratedBy {
  engine?: string;
  model?: string;
  language?: string;
  channel?: number;
  confidence?: number;
}

export interface TranscriptSegment {
  index: number;
  speaker?: string;
  start?: string | null;
  duration?: number | null;
  text?: string;
  is_transcript?: boolean;
  generated_by?: GeneratedBy;
  audio_omitted?: boolean;
  body_omitted?: boolean;
}

export interface Transcript {
  uuid: string;
  status: TranscriptStatus;
  note: string | null;
  engine: string | null;
  model: string | null;
  language: string | null;
  confidence: number | null;
  completed_at: string | null;
  parties: string[];
  segments: TranscriptSegment[];
  text_chars: number;
}

// The stored vCon document, with its bulky inline bodies cut to a preview.
// Always abbreviated over this API: a recorded call carries its audio inline as
// base64 and runs to megabytes, which is not something to push into an embedded
// app to render as text. Truncated entries are marked `body_truncated` and
// carry `body_total_chars`, so a reader can tell a short body from a shortened
// one.
export interface VconDocument {
  uuid: string;
  filename: string;
  size_bytes: number;
  abbreviated: boolean;
  document: Record<string, any>;
}

// What the PLATFORM resolved the caller to be, as opposed to what Horizon
// handed the browser. The two can disagree, and when a page shows the wrong
// person's records that difference is the first thing worth seeing.
export interface WhoAmI {
  identity: Identity;
  access: {
    visibility: Visibility;
    requested_visibility: Visibility;
    consent_visibility: Visibility;
    can_play_audio: boolean;
    can_modify_consent: boolean;
    unknown_scope: boolean;
  };
}

// What an on-demand transcription did. `status` is the same vocabulary the
// listing reports, so a run that ends 'no_consent' or 'empty' is an ANSWER
// rather than an error — and `message` is the sentence explaining it.
//
// `ledgered` says whether the lifecycle entry was appended. The transcript is
// written either way, so a false here means the recording changed without the
// evidence trail recording it, which is worth surfacing rather than leaving in
// a log.
export interface TranscribeResult {
  status: TranscriptStatus;
  ledgered?: boolean;
  message?: string;
  consent_note?: string;
  language?: string;
  model?: string;
  segments?: number;
  chars?: number;
  confidence?: number | null;
  audio_seconds?: number;
  billed_seconds?: number;
  error?: string;
}

// The most recent signed receipt behind a party's consent state.
export interface ConsentReceipt {
  receipt_id: string;
  action: 'grant' | 'revoke' | string;
  purposes: string[];
  applied_to_existing: number;
  agreement_version: string | null;
  signed_at: string | null;
}

export interface ConsentParty {
  id: number;
  party_uid: string;
  party_tel: string | null;
  party_name: string | null;
  domain: string;
  purposes: string[];
  proof_type: string | null;
  proof_reference: string | null;
  receipt: ConsentReceipt | null;
  source: string | null;
  vcon_count: number;
  // Conversations a decision would actually reach, counted from the index.
  conversations: number;
  last_seen_at: string | null;
  is_you: boolean;
}

// An outstanding consent request — a portal invite that has been minted and
// not yet answered, cancelled or expired.
export interface PendingConsentRequest {
  id: number;
  offered_purposes: string[];
  created_by: string | null;
  created_at: string | null;
  expires_at: string | null;
}

// What a minted (or already-live) request came back as. `portal_url` is null
// when the platform has no configured portal origin — the path is still
// returned, and the caller says so rather than offering a broken link.
export interface ConsentRequest extends PendingConsentRequest {
  success: boolean;
  already_pending: boolean;
  party_uid: string;
  portal_path: string;
  portal_url: string | null;
}

// What the platform says about one person on a Users page. Three separate
// facts, because the button has three states: a record, permission to ask for
// one, and whether asking has already happened.
export interface UserConsentAnswer {
  consent: ConsentParty | null;
  may_request: boolean;
  pending_request: PendingConsentRequest | null;
  // The domain's standing policy — what a request offers unless the operator
  // narrows it. Shown so the form states the position already taken for that
  // customer rather than inviting one to be invented per person.
  default_purposes: string[];
}

// The terms shown before a decision, and the ones the receipt binds to.
export interface ConsentAgreement {
  version: string;
  text: string;
  organization: string;
}

export interface ReceiptVerification {
  receipt: Record<string, any>;
  receipt_json: string;
  signature_b64: string;
  public_key_b64: string;
  algorithm: string;
  signature_valid: boolean;
}

export interface ScopePolicy {
  scope: string;
  recordings_visibility: Visibility;
  consent_visibility: Visibility;
  can_play_audio: boolean;
  can_transcribe: boolean;
  can_modify_consent: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

// The page opens with more than one request in flight — the recordings list and
// the probe that decides whether the Access tab exists — and each would
// otherwise mint its own token. Every mint is a full round trip through
// Horizon's backend to this platform's webhook, so the first caller's request
// is shared with everyone who arrives while it is still running.
let minting: Promise<string> | null = null;

// Which identity the currently-held platform token belongs to.
//
// Horizon persists remote-auth tokens in localStorage under
// "horizon-remote-auth-storage", keyed by appId:vendorId ALONE — no user in
// the key — and signing out does not clear them. So without this check, the
// next person to sign in on the same browser reuses the previous person's
// token and is served their scope and their recordings until the token
// expires. The marker lives in localStorage too, so it survives the page
// reload that a login performs, exactly like the token it guards.
const IDENTITY_MARKER = 'siprec.platform-token.identity';

// The person, as the platform knows them: uid = extension@domain. Not the AOR
// — one person may answer on several devices, and their records follow them,
// not a handset.
export function hostUid(props: Partial<HorizonProps>): string | null {
  const ext = (props.user?.extension ?? '').trim();
  const domain = (props.user?.domain ?? '').trim();
  if (!ext || !domain || domain === 'unknown.com') {
    return null;
  }
  return `${ext}@${domain}`;
}

// Scope is part of the key as well: a role change has to re-mint, or the page
// would keep enforcing the old role's visibility.
export function identityKey(props: Partial<HorizonProps>): string {
  return `${hostUid(props) ?? 'unknown'}|${props.user?.scope ?? ''}`;
}

function readMarker(): string | null {
  try {
    return localStorage.getItem(IDENTITY_MARKER);
  } catch {
    return null; // storage disabled; fall through to always re-minting
  }
}

function writeMarker(key: string): void {
  try {
    localStorage.setItem(IDENTITY_MARKER, key);
  } catch { /* nothing to do — worst case we mint more often */ }
}

// Obtains (or reuses) the platform token through Horizon's broker.
// `force` discards whatever is held first — used when the platform rejects the
// token, or reports it belongs to someone else.
async function bearer(props: Partial<HorizonProps>, force = false): Promise<string> {
  const auth = props.auth;
  if (!auth) {
    throw new Error('Horizon did not provide an auth context');
  }

  const key = identityKey(props);
  if (force || readMarker() !== key) {
    auth.clearRemoteAuthToken(VENDOR_ID);
    minting = null;
    writeMarker(key);
  } else {
    const existing = auth.getRemoteAuthToken?.(VENDOR_ID);
    if (existing?.accessToken) {
      return existing.accessToken;
    }
  }

  if (!minting) {
    minting = (async () => {
      // No callbackUrl. As of SDK 0.2.x the destination is registration data
      // on the app, not a browser-supplied value — it decided where a
      // redeemable auth code plus its PKCE verifier was POSTed, which is not a
      // choice that belongs to the client. Passing it does not error, it is
      // simply ignored, so leaving it in would read as configuration while
      // doing nothing.
      await auth.requestRemoteAuth(
        { vendorId: VENDOR_ID },
        { timeout: 30000 },
      );
      const token = auth.getRemoteAuthToken?.(VENDOR_ID)?.accessToken;
      if (!token) {
        throw new Error('The recording platform did not issue a token');
      }
      return token;
    })().finally(() => { minting = null; });
  }
  return minting;
}

async function call<T>(
  props: Partial<HorizonProps>, path: string, init: RequestInit = {}, attempt = 0,
): Promise<T> {
  const token = await bearer(props, attempt > 0);
  const res = await fetch(`${baseFor(token)}/${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });

  // A token the platform no longer accepts — expired, or revoked. Discard it
  // and mint once more rather than showing the user an error they can only
  // resolve by reloading.
  if (res.status === 401 && attempt === 0) {
    return call<T>(props, path, init, 1);
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* non-JSON error body */ }
    throw new Error(message);
  }

  const body = await res.json();

  // Second line of defence behind the identity marker. The platform tells us
  // whose token it just honoured; if that is not the person Horizon says is
  // signed in, we are holding someone else's token and must not render what
  // came back with it.
  const served = body?.identity?.party_uid;
  const expected = hostUid(props);
  if (attempt === 0 && served && expected
      && String(served).toLowerCase() !== expected.toLowerCase()) {
    return call<T>(props, path, init, 1);
  }

  return body as T;
}

export const siprec = {
  recordings: (props: Partial<HorizonProps>, search = '') =>
    call<{ identity: Identity; access: AccessInfo; recordings: Recording[] }>(
      props, `horizon_recordings.php?limit=100${search ? `&search=${encodeURIComponent(search)}` : ''}`),

  // Goes through call(), so it inherits the token minting, the 401 retry and
  // the identity check that guards against reading someone else's records.
  transcript: (props: Partial<HorizonProps>, uuid: string) =>
    call<Transcript>(props, `horizon_recordings.php?transcript=${encodeURIComponent(uuid)}`),

  vcon: (props: Partial<HorizonProps>, uuid: string) =>
    call<VconDocument>(props, `horizon_recordings.php?vcon=${encodeURIComponent(uuid)}`),

  // The recordings behind one page of Horizon call logs, asked for in one
  // request. Batched rather than per-row: a row must know whether anything
  // exists before it draws a button at all, and a request per row would be a
  // token-checked round trip per line of the call log.
  callRecordings: (props: Partial<HorizonProps>, groupIds: string[]) =>
    call<CallRecordingsAnswer>(props, 'horizon_call_recordings.php', {
      method: 'POST',
      body: JSON.stringify({ group_ids: groupIds }),
    }),

  whoami: (props: Partial<HorizonProps>) =>
    call<WhoAmI>(props, 'horizon_whoami.php'),

  // Recognition is a network round trip measured in seconds, not a lookup —
  // the platform raises its own time limit to 600s for it, so this must not be
  // given a short client timeout.
  transcribe: (props: Partial<HorizonProps>, uuid: string, language?: string) =>
    call<TranscribeResult>(props, 'horizon_transcribe.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(language ? { uuid, language } : { uuid }),
    }),

  // Audio needs the same bearer token, so it is fetched rather than pointed at
  // with an <audio src>. The blob URL is revoked by the caller.
  audioUrl: async (props: Partial<HorizonProps>, uuid: string, attempt = 0): Promise<string> => {
    const token = await bearer(props, attempt > 0);
    const res = await fetch(`${baseFor(token)}/horizon_recordings.php?audio=${encodeURIComponent(uuid)}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 && attempt === 0) {
      return siprec.audioUrl(props, uuid, 1);
    }
    if (!res.ok) {
      throw new Error(`Playback refused (${res.status})`);
    }
    return URL.createObjectURL(await res.blob());
  },

  consent: (props: Partial<HorizonProps>) =>
    call<{
      identity: Identity; access: AccessInfo; purposes: string[];
      agreement: ConsentAgreement; parties: ConsentParty[];
    }>(props, 'horizon_consent.php'),

  // What this platform records for a named set of people, asked for in one
  // request. Read-only and deliberately separate from consent() above: that
  // one lists everything the caller may see, which is the wrong question on a
  // Users page — there the rows are already chosen, and what each needs to
  // know is whether there is a record behind it.
  //
  // Keyed by every uid that was ASKED for, so the caller can cache "asked, and
  // there is none" — on a Users page that is most rows.
  userConsent: (props: Partial<HorizonProps>, partyUids: string[]) =>
    call<{
      identity: Identity; access: AccessInfo; purposes: string[];
      parties: Record<string, UserConsentAnswer>;
    }>(props, 'horizon_user_consent.php', {
      method: 'POST',
      body: JSON.stringify({ party_uids: partyUids }),
    }),

  // Ask a person for their consent: mints a portal invite, or hands back the
  // live one if a request is already out. Never asserts a decision — the link
  // is how the person makes it themselves, which is what records it as
  // self-asserted rather than as something an administrator decided for them.
  requestConsent: (
    props: Partial<HorizonProps>,
    body: { party_uid: string; party_tel?: string; party_name?: string;
            purposes?: string[]; expires_days?: number },
  ) =>
    call<ConsentRequest>(props, 'horizon_consent_request.php', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  cancelConsentRequest: (props: Partial<HorizonProps>, id: number) =>
    call<{ success: boolean; cancelled: number }>(props, 'horizon_consent_request.php', {
      method: 'POST',
      body: JSON.stringify({ cancel: true, id }),
    }),

  setConsent: (
    props: Partial<HorizonProps>, party_uid: string, purposes: string[],
    applyExisting = true,
  ) =>
    call<{
      success: boolean; receipt: any; signature_b64: string; public_key_b64: string;
      existing_conversations_updated: number;
    }>(props, 'horizon_consent.php',
      { method: 'POST',
        body: JSON.stringify({ party_uid, purposes, apply_existing: applyExisting }) }),

  // Receipt verification is deliberately unauthenticated — the platform
  // re-checks the Ed25519 signature server-side, but the response also carries
  // the signed bytes, the signature and the public key so the same check can be
  // repeated by anyone, without this platform's involvement. No bearer token,
  // because holding the receipt is the only thing that should be required.
  verifyReceipt: async (receiptId: string): Promise<ReceiptVerification> => {
    const res = await fetch(
      `${currentApiBase()}/portal_receipt_verify.php?receipt_id=${encodeURIComponent(receiptId)}`);
    if (!res.ok) {
      let message = `Verification failed (${res.status})`;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch { /* non-JSON error body */ }
      throw new Error(message);
    }
    return res.json();
  },

  receiptUrl: (receiptId: string) =>
    `${currentApiBase()}/portal_receipt_verify.php?receipt_id=${encodeURIComponent(receiptId)}`,

  scopeAccess: (props: Partial<HorizonProps>) =>
    call<{ visibilities: Visibility[]; scopes: ScopePolicy[] }>(props, 'horizon_scope_access.php'),

  setScopeAccess: (props: Partial<HorizonProps>, body: Partial<ScopePolicy> & { scope: string }) =>
    call<{ success: boolean }>(props, 'horizon_scope_access.php',
      { method: 'POST', body: JSON.stringify(body) }),
};

// "My Recordings" only when the user can see nothing but their own. A manager
// looking at their whole domain is not looking at "my" anything, and the
// title is the clearest signal of whose data is on screen.
export function scopedTitle(base: string, visibility?: Visibility): string {
  return visibility === 'own' ? `My ${base}` : base;
}

export function visibilityLabel(v?: Visibility, identity?: Identity): string {
  switch (v) {
    case 'all': return 'the whole platform';
    case 'territory': return `territory ${identity?.territory ?? ''}`.trim();
    case 'domain': return `domain ${identity?.domain ?? ''}`.trim();
    case 'own': return 'your own records';
    default: return 'nothing';
  }
}
