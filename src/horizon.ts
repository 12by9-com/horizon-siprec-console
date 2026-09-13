// The contract Horizon actually passes to a federated app.
//
// Taken from a running Horizon 46 bundle rather than
// from the Federation SDK planning document, which describes a different and
// older shape (it documents `user.login` / `user.uid`; the live host passes
// `user.extension` and no uid). Where the two disagree, this file follows the
// host, because that is what actually arrives at runtime.

export interface HorizonUser {
  displayName: string;          // "Guest User" when unknown
  domain: string;               // "unknown.com" when unknown
  email?: string;
  extension?: string;           // the correlation key — see aorFor()
  scope?: string;               // permission scope of the logged-in user
  department?: string;
  site?: string;
}

export interface RemoteAuthToken {
  vendorId: string;
  accessToken: string;
  tokenType: string;
  expiresAt: number;
  refreshToken?: string;
  metadata?: unknown;
}

export interface HorizonAuth {
  isAuthenticated: () => boolean;
  // Brokered OAuth2: Horizon's BACKEND calls /oauth2/remote-auth/initiate and
  // passes the user identity server-to-server, so the vendor never has to
  // trust a browser-supplied claim. Gated on the app's remote_auth_enabled
  // flag, the remote-auth:request permission, and allowed_hostnames.
  // callbackUrl was removed in SDK 0.2.x: the webhook destination is set by an
  // administrator on the app registration, and an app with none configured is
  // refused with 409 [RA010] before any backend is contacted.
  requestRemoteAuth: (
    request: { vendorId: string; scopes?: string[]; metadata?: unknown },
    options?: { timeout?: number },
  ) => Promise<unknown>;
  getRemoteAuthToken: (vendorId: string) => RemoteAuthToken | null;
  clearRemoteAuthToken: (vendorId: string) => void;
}

// An authenticated client for the NetSapiens API, provided by the host — the
// app never handles the session token itself.
export interface HorizonApi {
  get: (path: string, params?: unknown) => Promise<any>;
  post: (path: string, body?: unknown) => Promise<any>;
  put: (path: string, body?: unknown) => Promise<any>;
  delete: (path: string) => Promise<any>;
  getBaseUrl: () => string;
}

export interface HorizonEventBus {
  on: (event: string, handler: (data: any) => void) => void;
  off: (event: string, handler: (data: any) => void) => void;
  emit: (event: string, data?: any) => void;
}

export interface HorizonProps {
  user: HorizonUser;
  auth: HorizonAuth;
  api: HorizonApi;
  theme: 'light' | 'dark';
  locale: string;
  t: (key: string, opts?: unknown) => string;
  navigate: (path: string) => void;
  eventBus: HorizonEventBus;
  ui?: { templates?: Record<string, unknown> };
}

// The identity bridge to the SIPREC platform.
//
// party_consent.party_tel and vcon_index_party.party_tel hold SIP AORs in the
// form "sip:1002@vbox.netsapiens.com", and the recorder derives the consent
// domain from the part after '@'. A Horizon user's extension + domain
// reconstructs exactly that.
//
// Returns null rather than a half-formed AOR when either part is missing —
// a lookup on "sip:@domain" would be a silent mis-match.
export function aorFor(user: HorizonUser): string | null {
  const ext = (user.extension ?? '').trim();
  const domain = (user.domain ?? '').trim();
  if (!ext || !domain || domain === 'unknown.com') {
    return null;
  }
  return `sip:${ext}@${domain}`;
}

// ---------------------------------------------------------------- extensions

// What Horizon hands a component registered into an extension zone.
//
// Taken from the host's DynamicExtensionRenderer rather than from the SDK
// package (which this app does not install): it builds this object, memoised on
// route/user/theme, and passes `pageContext` straight through from whatever the
// zone's host page supplied. For `table-row-actions` that is `{ row }` — the
// grid row exactly as the page's data gave it, which for Call Logs is a raw
// CDR object.
//
// `ui` is the same surface a page gets as `horizonContext.ui`: the host's own
// pre-themed components, so a button rendered from it matches the table around
// it and follows the light/dark toggle without this app shipping MUI. It is
// optional because the host builds it from a lazily-filled slot, so an
// extension must be able to render without it.
export interface HorizonExtensionContext {
  route: string;
  params?: Record<string, string>;
  user?: { domain: string; username: string };
  pageContext?: unknown;
  ui?: any;
  eventBus?: HorizonEventBus;
  theme: 'light' | 'dark';
  t?: (key: string, opts?: Record<string, unknown>) => string;
}

export interface HorizonExtensionProps {
  context: HorizonExtensionContext;
  zone: string;
  close?: () => void;
}
