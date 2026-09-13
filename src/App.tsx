import React, { useEffect, useState } from 'react';
import { HorizonProps, aorFor } from './horizon';
import { SIPREC_API, siprec, WhoAmI } from './api';
import { RecordingsPage } from './RecordingsPage';
import { ConsentPage } from './ConsentPage';
import { AccessAdmin } from './AccessAdmin';
import { hostProps, parkHostProps } from './host';
import { CallLogPlayButton, CallLogVconButton } from './CallLogActions';
import { UserConsentButton } from './UserConsentActions';
import { installProbe } from './probe';

// The exported ./App is a REGISTRAR, not the page.
//
// Horizon's RootComponent renders <HorizonAppsLoader/>, which mounts every
// enabled app headlessly (fallback: null) purely so its code can run. The app
// is expected to register routes and extensions on mount and render nothing
// itself. The page the user sees is the `component` handed to route:register,
// which the host's DynamicRouteLoader renders when the URL matches.
//
// Getting this wrong is why the first version showed "Route Not Found": it
// rendered UI directly and registered no route, so /apps/siprec-console had
// nothing behind it and DynamicRouteLoader gave up after its 5s grace period.

// Folded in at build time by webpack's DefinePlugin, so the probe can say which
// build is running without a second place to keep the number in step.
declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : '';

// Which build is on screen.
//
// This app needs the answer more than most things do. It runs inside a host it
// does not own, its bundle is injected dynamically (so a hard reload does not
// necessarily refetch it), the entry URL is stable across releases, and its
// most visible features are buttons on someone else's pages — where a stale
// bundle and a feature that never shipped look identical. The probe has
// carried the version for a while, but only for someone who knows to open a
// console; this puts it on every page this app owns — the Apps console and the
// Recordings and Consent entries — so the answer is wherever the doubt is.
//
// Stamped by the bundler, never written here: see webpack.config.cjs. The Vite
// harness reports 'harness' rather than a number, because it is not a build
// anybody deployed.
const BuildStamp: React.FC<{ dark: boolean }> = ({ dark }) => (
  <div style={{
    margin: '28px 24px 0',
    paddingTop: 12,
    borderTop: '1px solid rgba(128,128,128,0.25)',
    fontSize: 12,
    opacity: 0.6,
    color: dark ? '#e8e8ea' : '#1E2130',
  }}>
    {APP_VERSION === 'harness'
      ? 'Standalone harness build'
      : <>SIPREC Console version <b>{APP_VERSION}</b></>}
    {BUILD_DATE && <> · built {BUILD_DATE}</>}
  </div>
);

const APP_ID = 'siprec-console';
const ROUTE_ID = 'siprec-console.page';
const RECORDINGS_ROUTE_ID = 'siprec-console.recordings';
const CONSENT_ROUTE_ID = 'siprec-console.consent';
const CALL_LOG_PLAY_EXT_ID = 'siprec-console.calllog-play';
const CALL_LOG_VCON_EXT_ID = 'siprec-console.calllog-vcon';
const USER_CONSENT_EXT_ID = 'siprec-console.user-consent';

// Where Horizon's own Call Logs table lives. Four routes render it — Manage
// with and without a domain in the path, My Account, and My Account's domain
// view — and the host matches an extension's pattern against the WHOLE path
// (patternToRegex anchors both ends; `exact` only tightens it further), so a
// prefix like '/manage' matches none of them and every route needs its own
// entry. '*' stands for exactly one segment.
const CALL_LOG_ROUTES = [
  { pattern: '/manage/call-logs' },
  { pattern: '/manage/*/call-logs' },
  { pattern: '/home/call-logs' },
  { pattern: '/home/*/call-logs' },
];

// Where Horizon's own Users table lives. Three routes render it — Manage
// without a domain, Manage drilled into one, and My Account's domain view —
// and, as above, the host matches the WHOLE path, so each needs its own entry.
//
// '/home/domain/users' is a LITERAL segment, not a placeholder: My Account's
// users view is always the signed-in user's own domain and never names it in
// the path. The wildcard beside it costs nothing and covers a host that ever
// starts putting one there.
const USERS_ROUTES = [
  { pattern: '/manage/users' },
  { pattern: '/manage/*/users' },
  { pattern: '/home/domain/users' },
  { pattern: '/home/*/users' },
];


// Where the pages live in Horizon's navigation.
//
// A parentPath has to satisfy two different consumers at once:
//
//   - the ROUTER resolves the URL through `/_protected/<prefix>/$`, which
//     renders <DynamicZoneRoute parentPath="/<prefix>" />
//   - the MENU is built by mergeDynamicRoutes, which looks up child routes for
//     the section's route prefix
//
// For apps, manage and platform the section id equals the URL prefix, so both
// always agreed. My Account did NOT — its section id is "myaccount" while its
// only routable prefix is "/home" — and the menu side keyed off '/' + section
// id, so registering under '/home' gave a working URL with no menu entry, and
// under '/myaccount' a menu entry pointing at an unroutable URL.
//
// FIXED upstream in netsapiens-horizon 42c6e0ff (6 Aug 2026): NAVIGATION_SECTIONS
// is now one table both consumers read, carrying
// { placement:'home', sectionId:'myaccount', routePath:'/home' }, and the menu
// merge resolves getRoutePathForSectionId(section.id) before falling back to
// '/' + id. Confirmed present in the Horizon 46 host we develop against
// (46.0.0-staging.43, commit db8b0893, built 10 Aug 2026) by grepping
// NAVIGATION_SECTIONS out of the served bundle — version.json alone is not
// proof, so check both before assuming a host has it.
//
// Nesting is still not a way out: DynamicRouteLoader walks the URL a segment at
// a time and requires every segment to be a registered dynamic route, so
// '/home/call-logs/recordings' cannot resolve while 'call-logs' is static.
// Direct children of the prefix only, positioned with `placement`.
const MANAGE_PATH = '/manage';
const HOME_PATH = '/home';
const APPS_PATH = '/apps';

// Scopes that can see Horizon's Manage section at all: manageMenu declares
// requiredScopes: SCOPE_GROUPS.ADMINS. Registering a Manage route for anyone
// else produces an entry their role will not render.
//
// Admin is included because Horizon groups it with the other two; leaving it
// out would orphan it for no reason.
//
// Everyone else now gets My Account instead — myAccountMenu carries NO
// section-level requiredScopes, so /home renders for every scope. That is also
// why this stays an either/or rather than "My Account for all": registering
// there unconditionally would give an admin the same two pages twice, once
// under Manage and once under My Account, with no way to tell which is which.
const MANAGE_SCOPES = ['Admin', 'Super User', 'Reseller'];

// Which navigation section this user's Recordings and Consent live in.
//
// Navigation placement only — never an authorisation decision. What each page
// is allowed to show is settled server-side by horizonScopeClause() from the
// scope on the platform's own token, so a tampered host prop changes which menu
// an entry appears under and nothing else. That is what makes it safe to key
// this on a host-supplied string.
function sectionPathFor(props: Partial<HorizonProps>): string {
  return MANAGE_SCOPES.includes((props.user?.scope ?? '').trim())
    ? MANAGE_PATH
    : HOME_PATH;
}

// Anchor for both entries, in either section. findAnchor tries id/pathName
// exactly first, then a NORMALIZED match on name/key/id — which is what makes
// one string work for both trees:
//
//   Manage      Call Logs  pathName 'call-logs'        → exact hit
//   My Account  Call Logs  name 'CALL_LOGS',
//                          pathName 'my-account-call'  → normalized hit
//                                                        ('calllogs' both ways)
//
// So the anchor matches a menu LABEL, not a path — My Account's Call Logs sits
// at /home/call-logs but is found by its name. An unmatched anchor is not an
// error: findAnchor logs and places the entry at the end of the menu.
//
// Both pages anchor to the same item; mergeExtensionsIntoMenu splices a
// same-anchor group "at once, in their original order", so registering
// Recordings before Consent yields Call Logs → Recordings → Consent.
const AFTER_CALL_LOGS = { after: 'call-logs' };

const row: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '190px 1fr',
  gap: '8px 16px',
  padding: '6px 0',
  borderBottom: '1px solid rgba(128,128,128,0.18)',
};

// Horizon hands expiresAt back in SECONDS, and Date() wants milliseconds — so
// rendering it directly showed every token expiring on 21 January 1970. Any
// plausible expiry in seconds is far below the millisecond epoch of a present
// date, which is what makes the two safely distinguishable.
function formatExpiry(expiresAt: number): string {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return 'unknown';
  const ms = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  return new Date(ms).toLocaleString();
}

// Where the same-origin prefix lands on the page we are running on. Rendered
// unconditionally, and above the platform's own answers on purpose: the case
// this exists for is the one where those answers never arrive.
function resolvedApi(): string {
  try {
    return new URL(SIPREC_API, window.location.origin).href;
  } catch {
    return SIPREC_API;
  }
}

const Field: React.FC<{ label: string; value?: React.ReactNode; muted?: boolean }> = ({
  label, value, muted,
}) => (
  <div style={row}>
    <div style={{ fontWeight: 600, opacity: 0.7 }}>{label}</div>
    <div style={{
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      opacity: muted ? 0.55 : 1,
      wordBreak: 'break-all',
    }}>
      {value === undefined || value === null || value === '' ? '—' : value}
    </div>
  </div>
);

// Kept from the stub: on a fresh deploy this is the fastest way to see what
// the host is actually passing and whether the platform token was minted.
export const DiagnosticsPage: React.FC<{ host: Partial<HorizonProps> }> = ({ host }) => {
  const { user, auth, api, theme, locale } = host;
  const aor = user ? aorFor(user) : null;
  const token = auth?.getRemoteAuthToken?.('siprec') ?? null;

  // What the PLATFORM resolved, which is not necessarily what Horizon handed
  // the browser above.
  const [who, setWho] = useState<WhoAmI | null>(null);
  const [whoError, setWhoError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const ask = React.useCallback(async () => {
    setAsking(true);
    setWhoError(null);
    try {
      setWho(await siprec.whoami(host));
    } catch (e: any) {
      setWhoError(e?.message || 'Could not reach the recording platform');
    } finally {
      setAsking(false);
    }
  }, [host]);

  // Fetched automatically ONLY when a token is already held. Minting one costs
  // a full round trip through Horizon's backend to the platform's webhook, and
  // doing that from a diagnostics tab would also make the "platform token"
  // field below permanently untrue — it could never read "none yet".
  useEffect(() => {
    if (token?.accessToken && !who && !whoError && !asking) {
      void ask();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.accessToken]);

  const identity = who?.identity;

  return (
    <div style={{ padding: 24, maxWidth: 860 }}>
      <h3 style={{ marginTop: 0 }}>Identity from Horizon</h3>
      <Field label="displayName" value={user?.displayName} />
      <Field label="extension" value={user?.extension} />
      <Field label="domain" value={user?.domain} />
      <Field label="email" value={user?.email} />
      <Field label="scope" value={user?.scope} />
      <Field label="department" value={user?.department} muted />
      <Field label="site" value={user?.site} muted />

      <h3>Derived SIPREC identity</h3>
      <Field label="AOR (device address)" value={aor ?? (
        <span style={{ color: '#A63D40' }}>cannot derive — extension and/or domain missing</span>
      )} />
      <p style={{ opacity: 0.7, fontSize: 13 }}>
        The pages above key on the <b>user ID</b>, not this address: one person may
        answer on several devices, each with its own AOR, and their consent and
        recordings follow the person.
      </p>

      <h3>Recording platform endpoint</h3>
      <Field label="API prefix" value={SIPREC_API} />
      <Field label="resolves to" value={resolvedApi()} />
      <p style={{ opacity: 0.7, fontSize: 13 }}>
        The prefix is the same in every build — this app is deliberately not
        tied to one platform. Where it actually goes is decided by a proxy
        stanza on <b>this portal</b>, so the resolved URL above names the portal,
        not the recorder behind it. If everything below fails with 404, that
        stanza is missing or misrouted on this host; nothing needs rebuilding.
      </p>

      <h3>Identity from the recording platform</h3>
      {!who && !whoError && (
        <p style={{ opacity: 0.7, fontSize: 13 }}>
          {token?.accessToken
            ? 'Asking the platform…'
            : 'Not fetched yet — this needs a platform token, which costs a round trip through Horizon\u2019s backend.'}
          {!token?.accessToken && (
            <>
              {' '}
              <button type="button" onClick={ask} disabled={asking} style={{
                fontSize: 13, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                border: '1px solid rgba(128,128,128,0.45)', background: 'transparent',
                color: 'inherit', fontFamily: 'inherit',
              }}>
                {asking ? 'Asking…' : 'Ask the platform'}
              </button>
            </>
          )}
        </p>
      )}
      {whoError && <div style={{ color: '#A63D40' }}>{whoError}</div>}
      {identity && (
        <>
          <Field label="party_uid (the person)" value={identity.party_uid} />
          <Field label="domain" value={identity.domain} />
          <Field label="territory" value={identity.territory} />
          <Field label="scope (as the platform sees it)" value={identity.scope} />
          <Field label="cluster_id" value={identity.cluster_id} />
          <Field label="cluster_name" value={identity.cluster_name} muted />
          <Field label="cluster hostname" value={identity.platform_hostname} muted />
          <Field label="recordings visible" value={who?.access.visibility} />
          <Field label="may play audio" value={String(who?.access.can_play_audio)} />
          <p style={{ opacity: 0.7, fontSize: 13 }}>
            A NetSapiens user ID is unique within <b>one</b> Horizon instance and
            nowhere else, so the cluster is part of who this is. It is read from
            the signed webhook rather than the browser.
            {identity.cluster_id === null && (
              <> This host sent none. Horizon derives it from a NetSapiens
              Insight token on the Horizon server
              (<code>/etc/netsapiens/insight.d/token.jwt</code>); with no such
              file there are no claims to send, and a host that is not
              registered with Insight will always show this. A token minted
              before this platform started recording the cluster shows it
              too.</>
            )}
          </p>
          {user?.scope && identity.scope !== user.scope && (
            <div style={{ color: '#A63D40', fontSize: 13 }}>
              Horizon says the scope is <b>{user.scope}</b> but the platform resolved{' '}
              <b>{identity.scope}</b>. The platform&rsquo;s answer is the one enforced.
            </div>
          )}
        </>
      )}

      <h3>Host capabilities</h3>
      <Field label="authenticated" value={String(auth?.isAuthenticated?.() ?? 'n/a')} />
      <Field label="api.getBaseUrl()" value={api?.getBaseUrl?.() ?? 'n/a'} />
      <Field label="theme / locale" value={`${theme ?? '?'} / ${locale ?? '?'}`} />
      <Field label="platform token" value={token
        ? `held for "siprec", expires ${formatExpiry(token.expiresAt)}`
        : 'none yet — minted on first page load'} muted={!token} />
    </div>
  );
};

// Standalone pages for the section entries — Manage for admins, My Account for
// everyone else. The host router renders these outside this module's React
// tree, so they read the parked host props rather than receiving them through
// JSX.
//
// Both carry the build stamp. These are registered as their own menu entries
// under Manage or My Account, and for most people they are the ONLY part of
// this app they ever open — routing someone to the Apps console just to read a
// version number is a worse trade than a quiet line at the foot of the page
// they were already on. It also puts the answer next to the thing being
// doubted: "the Consent page is missing the button I was told about" is asked
// while looking at the Consent page.
export const SectionRecordings: React.FC = () => (
  <>
    <RecordingsPage host={hostProps} />
    <BuildStamp dark={hostProps.theme === 'dark'} />
  </>
);
export const SectionConsent: React.FC = () => (
  <>
    <ConsentPage host={hostProps} />
    <BuildStamp dark={hostProps.theme === 'dark'} />
  </>
);

type TabId = 'access' | 'diagnostics';

// The page behind /apps/siprec-console.
//
// Recordings and Consent are NOT tabs here any more. Every scope now has them
// as real menu entries after Call Logs — Manage for admins, My Account for
// everyone else — and carrying a second copy here would leave two routes
// rendering the same page with nothing to say which one is real. What is left
// is the two things that have no other home: Diagnostics, and Access for a role
// the PLATFORM accepts as platform-wide — the probe below is the authority for
// that, not the host-supplied scope string, and the same check is enforced
// server-side on every call.
//
// ⚠️ This assumes a host carrying netsapiens-horizon 42c6e0ff. On an older one
// the /home entries resolve as URLs but render no menu item, so a below-Reseller
// user would have no way to reach them. Check the host bundle for
// NAVIGATION_SECTIONS before deploying this to a host you have not checked.
export const Console: React.FC = () => {
  const host = hostProps;
  const [tab, setTab] = useState<TabId>('diagnostics');
  const [canAdmin, setCanAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    siprec.scopeAccess(host)
      .then(() => { if (!cancelled) setCanAdmin(true); })
      .catch(() => { if (!cancelled) setCanAdmin(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dark = host.theme === 'dark';
  const tabs: Array<{ id: TabId; label: string }> = [
    ...(canAdmin ? [{ id: 'access' as TabId, label: 'Access' }] : []),
    { id: 'diagnostics', label: 'Diagnostics' },
  ];

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif',
                  color: dark ? '#e8e8ea' : '#1E2130' }}>
      <nav style={{ display: 'flex', gap: 4, padding: '0 24px',
                    borderBottom: '1px solid rgba(128,128,128,0.25)' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{
              appearance: 'none', border: 'none', background: 'none', cursor: 'pointer',
              padding: '12px 14px', fontSize: 14,
              color: 'inherit',
              opacity: tab === t.id ? 1 : (t.id === 'diagnostics' ? 0.5 : 0.7),
              fontWeight: tab === t.id ? 600 : 400,
              borderBottom: tab === t.id ? '2px solid #C8862F' : '2px solid transparent',
            }}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'access' && canAdmin && <AccessAdmin host={host} />}
      {tab === 'diagnostics' && <DiagnosticsPage host={host} />}

      <BuildStamp dark={dark} />
    </div>
  );
};

const App: React.FC<Partial<HorizonProps>> = (props) => {
  parkHostProps(props);
  const eventBus = props.eventBus;
  // Registration depends on the scope, and the scope arrives with the host
  // props — which are not necessarily populated on the first render.
  const scope = props.user?.scope;

  useEffect(() => {
    if (!eventBus) {
      return;
    }
    const sectionPath = sectionPathFor(props);
    const ids = [ROUTE_ID, RECORDINGS_ROUTE_ID, CONSENT_ROUTE_ID];

    // The Apps console is always registered: Diagnostics for everyone, Access
    // for platform-wide roles.
    eventBus.emit('route:register', {
      id: ROUTE_ID,
      appId: APP_ID,
      parentPath: APPS_PATH,
      path: APP_ID,
      label: 'SIPREC Console',
      icon: 'material-symbols:graphic-eq',
      component: Console,
    });

    // Recordings and Consent as their own entries immediately after Call Logs,
    // in whichever section this scope actually renders. Registered in this
    // order because a same-anchor group is spliced in registration order.
    eventBus.emit('route:register', {
      id: RECORDINGS_ROUTE_ID,
      appId: APP_ID,
      parentPath: sectionPath,
      path: 'recordings',
      label: 'Recordings',
      icon: 'material-symbols:graphic-eq',
      placement: AFTER_CALL_LOGS,
      component: SectionRecordings,
    });
    eventBus.emit('route:register', {
      id: CONSENT_ROUTE_ID,
      appId: APP_ID,
      parentPath: sectionPath,
      path: 'consent',
      label: 'Consent',
      icon: 'material-symbols:verified-user-outline',
      placement: AFTER_CALL_LOGS,
      component: SectionConsent,
    });

    // Play and vCon on every row of Horizon's own Call Logs table.
    //
    // The host's shared DataTable renders the `table-row-actions` zone at the
    // end of each row's action column, so this needs no cooperation from the
    // call-logs page — but it does need that page to declare at least one
    // native action, since the column only exists when it does. Call Logs
    // declares three.
    //
    // Registered as TWO extensions rather than one drawing two buttons: the
    // action column reserves its width as one icon slot per REGISTERED
    // extension, so a single registration painting two buttons has its second
    // clipped past the cell's right edge.
    //
    // No scope gate. Which recordings a row has is settled by the platform
    // under the caller's own role, so a user who may not see this call's
    // recording gets no buttons on it — that is a server-side answer, not a
    // menu decision, and gating here as well would only hide the buttons from
    // people the platform would have answered.
    eventBus.emit('dynamic-extension:register', {
      id: CALL_LOG_PLAY_EXT_ID,
      appId: APP_ID,
      zone: 'table-row-actions',
      routes: CALL_LOG_ROUTES,
      // Higher renders first: listening to the call is the common errand, and
      // reading its record is the specialist one.
      priority: 20,
      component: CallLogPlayButton,
    });
    eventBus.emit('dynamic-extension:register', {
      id: CALL_LOG_VCON_EXT_ID,
      appId: APP_ID,
      zone: 'table-row-actions',
      routes: CALL_LOG_ROUTES,
      priority: 10,
      component: CallLogVconButton,
    });

    // Consent on every row of Horizon's own Users table.
    //
    // Same mechanism as the call-log buttons above, and the same reason it
    // needs no cooperation from the page: the shared DataTable renders this
    // zone at the end of each row's action column whenever the page declares
    // native actions, and the Users list declares three.
    //
    // One registration, drawing one button — the action column reserves its
    // width as one icon slot per REGISTERED extension, so this adds 36px to a
    // column that already has Masquerade, Edit and Delete in it.
    //
    // No scope gate, for the same reason as the call-log buttons: whether a
    // person has a consent record the caller may see is settled server-side by
    // the consent visibility predicate, so a row outside that scope gets no
    // button. Gating here as well would only hide it from people the platform
    // would have answered.
    eventBus.emit('dynamic-extension:register', {
      id: USER_CONSENT_EXT_ID,
      appId: APP_ID,
      zone: 'table-row-actions',
      routes: USERS_ROUTES,
      priority: 10,
      component: UserConsentButton,
    });

    // A console handle for a bundle whose failures are otherwise invisible —
    // see ./probe. Installed after registering so it can report what was.
    installProbe(
      [CALL_LOG_PLAY_EXT_ID, CALL_LOG_VCON_EXT_ID, USER_CONSENT_EXT_ID, ...ids],
      APP_VERSION, BUILD_DATE);

    return () => {
      ids.forEach(id => eventBus.emit('route:unregister', id));
      // The extension registry takes an object here, not a bare id, unlike
      // route:unregister above.
      [CALL_LOG_PLAY_EXT_ID, CALL_LOG_VCON_EXT_ID, USER_CONSENT_EXT_ID].forEach(
        id => eventBus.emit('dynamic-extension:unregister', { id }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventBus, scope]);

  // Headless: the loader mounts this at the app root, so anything rendered
  // here would appear on every Horizon page.
  return null;
};

export default App;
