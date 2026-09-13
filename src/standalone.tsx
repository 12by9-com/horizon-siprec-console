import React from 'react';
import ReactDOM from 'react-dom/client';
import App, { Console, SectionConsent, SectionRecordings } from './App';
import { CallLogPlayButton, CallLogVconButton } from './CallLogActions';
import { UserConsentButton } from './UserConsentActions';
import { identityKey } from './api';
import { HorizonExtensionContext, HorizonProps } from './horizon';

// A standalone harness so the app can be developed and inspected without
// Horizon. It fakes the props the host would pass, using a real-looking
// extension and domain from the SIPREC test data so the derived AOR is
// something that actually exists in party_consent.
//
// This is NOT how it runs in Horizon — there, ./App is loaded via Module
// Federation and the host supplies these props for real. The harness exists
// only so a broken render is caught before touching the registry.

// What the harness sends as its platform token.
//
// Horizon's broker mints these for real and the harness has no broker, so this
// is a well-formed placeholder rather than a credential: the dev server's /api
// proxy replaces the Authorization header with a real token when one is in its
// environment (see vite.config.ts). Without that, the platform answers 401 and
// the buttons show nothing — which is the correct answer, not a harness bug.
//
// It has to satisfy the platform's bearer format (32-64 alphanumerics) or the
// request is rejected before the proxy's header is ever considered.
const harnessToken = 'harnessplaceholdertokenharnessplaceholder';

const fakeProps: Partial<HorizonProps> = {
  user: {
    displayName: 'Boba Fett',
    domain: 'vbox.netsapiens.com',
    extension: '1002',
    email: 'boba@vbox.netsapiens.com',
    scope: 'Basic User',
  },
  auth: {
    isAuthenticated: () => true,
    requestRemoteAuth: async () => ({ note: 'harness: no broker' }),
    getRemoteAuthToken: () => harnessToken
      ? { vendorId: 'siprec', accessToken: harnessToken, tokenType: 'Bearer',
          expiresAt: Math.floor(Date.now() / 1000) + 3600 }
      : null,
    clearRemoteAuthToken: () => undefined,
  },
  api: {
    // Stands in for the host's authenticated NetSapiens client. Logs what was
    // asked so the window format and the collection path can be eyeballed —
    // both are contracts with a server the harness cannot reach.
    get: async (path: string, params?: unknown) => {
      console.log('[harness] api.get', path, params);
      return FAKE_CDR_ROWS;
    },
    post: async () => ({}),
    put: async () => ({}),
    delete: async () => ({}),
    getBaseUrl: () => 'https://portal.example.com/ns-api/v2 (harness)',
  },
  theme: 'light',
  locale: 'en-US',
  t: (k: string) => k,
  navigate: (p: string) => console.log('[harness] navigate', p),
  eventBus: {
    on: () => undefined,
    off: () => undefined,
    emit: (e: string, d?: unknown) => console.log('[harness] emit', e, d),
  },
};

// The API layer discards any held token whose identity marker does not match
// the signed-in user — a guard against reusing the previous person's token
// after a login switch. In the harness there is no login to have written the
// marker, so a supplied token would be thrown away on first use and the mint
// that replaced it would fail. Writing the marker for the faked user is what
// makes the harness token usable on the first render rather than the second.
try {
  localStorage.setItem('siprec.platform-token.identity', identityKey(fakeProps));
} catch { /* storage disabled; the token simply will not be reused */ }

// Horizon's own Call Logs table, faked down to the fields the buttons read.
//
// A REAL row carries `call-parent-cdr-id` and no Call-ID at all — that is the
// whole reason cdrCallIds exists — so most of these are that shape and reach
// their recordings only through the resolution step below. The last pair carry
// the Call-ID directly, which is the fast path a host would give us if it ever
// merged the raw fields into its own listing.
//
// The ids are real: the group ids come from the local recorder database (a call
// recorded in five segments, one in four, one never recorded), and the cdr ids
// have the shape NetSapiens uses — the leading digits are the call's start as a
// unix timestamp.
//
// The start times carry the `Z[Zone]` suffix the NetSapiens API really sends.
// An earlier version of this fixture used plain ISO, which Date.parse accepts —
// so the harness passed while every row in Horizon silently failed to resolve.
// A fixture that is easier to parse than the real thing tests nothing.
const FAKE_ROWS = [
  { label: 'cdr id only, 5 segments',
    'call-parent-cdr-id': '1786594344aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'call-start-datetime': '2026-08-13T04:12:24Z[America/Los_Angeles]',
    domain: 'vbox.netsapiens.com' },
  { label: 'cdr id only, 4 segments',
    'call-parent-cdr-id': '1787347159bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'call-start-datetime': '2026-08-18T04:18:59Z[America/Los_Angeles]',
    domain: 'vbox.netsapiens.com' },
  { label: 'cdr id only, never recorded',
    'call-parent-cdr-id': '1787349017cccccccccccccccccccccccccccccccc',
    'call-start-datetime': '2026-08-21T21:50:17Z[America/Los_Angeles]',
    domain: 'vbox.netsapiens.com' },
  { label: 'call id on the row, 5 segments',
    'call-parent-cdr-id': '1786594344dddddddddddddddddddddddddddddddd',
    'call-orig-call-id': '467474936-54054-208577@BJC.BGI.A.BEE',
    'call-start-datetime': '2026-08-13T04:12:24Z[America/Los_Angeles]',
    domain: 'vbox.netsapiens.com' },
];

// What the NetSapiens API would answer for those cdr ids. The harness has no
// NetSapiens behind it, so `api.get` below serves this — which is enough to
// exercise the real path: the batching, the window, and the two spellings the
// merged raw row can arrive under.
const FAKE_CDR_ROWS: Array<Record<string, string>> = [
  { 'call-parent-cdr-id': '1786594344aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    orig_callid: '467474936-54054-208577@BJC.BGI.A.BEE' },
  { 'call-parent-cdr-id': '1787347159bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'call-orig-call-id': 'dea5c0216b62735182812f9f503a5e16' },
  { 'call-parent-cdr-id': '1787349017cccccccccccccccccccccccccccccccc',
    orig_callid: 'no-such-call-id@example.com' },
];

const extensionContext = (row: Record<string, unknown>): HorizonExtensionContext => ({
  route: '/manage/vbox.netsapiens.com/call-logs',
  params: { domain: 'vbox.netsapiens.com' },
  user: { domain: 'vbox.netsapiens.com', username: '1002' },
  // Exactly what the host's DataTable passes into the `table-row-actions`
  // zone. `ui` is absent here, which also exercises the fallback chrome the
  // buttons need before the host's UI surface exists.
  pageContext: { row },
  theme: 'light',
});

// Horizon's own Users table, faked down to the fields the consent button reads.
//
// The uids are real seats in the local recorder database, chosen to cover the
// answers the popup has to render: a person with a signed receipt, one whose
// consent came from a prior agreement and has none, and a seat this platform
// has never seen — which is not an empty popup but the ask-for-consent path,
// since most rows of a real Users page are in exactly that state.
//
// The last row has `user` and `extension` deliberately DIFFERENT. That is
// allowed on a NetSapiens seat, and it is the case the two-candidate lookup
// exists for: the AOR the recorder saw could have been built from either, so
// both spellings are asked about and whichever has a record is the person.
//
// Which rows actually show a button depends on the SCOPE OF THE HARNESS TOKEN,
// not on anything here: consent visibility is a server-side predicate. The
// default mint is Super User, so all four resolve; mint as a Basic User
// (`php scripts/mint-harness-token.php 1002@vbox.netsapiens.com 'Basic User'`)
// and only Boba Fett's own row keeps its button — which is the feature working,
// not the harness failing.
const FAKE_USER_ROWS = [
  { label: 'receipt on file',
    user: '1002', extension: '1002', domain: 'vbox.netsapiens.com',
    'name-first-name': 'Boba', 'name-last-name': 'Fett' },
  { label: 'prior agreement, no receipt',
    user: '1003', extension: '1003', domain: 'vbox.netsapiens.com',
    'name-first-name': 'Luke', 'name-last-name': 'Skywalker' },
  { label: 'never recorded — the ask-for-consent path',
    user: '1099', extension: '1099', domain: 'vbox.netsapiens.com',
    'name-first-name': 'Nobody', 'name-last-name': 'Here' },
  { label: 'user ≠ extension, record under the extension',
    user: 'leia.organa', extension: '1004', domain: 'vbox.netsapiens.com',
    'name-first-name': 'Leia', 'name-last-name': 'Organa' },
];

const usersContext = (row: Record<string, unknown>): HorizonExtensionContext => ({
  route: '/manage/vbox.netsapiens.com/users',
  params: { domain: 'vbox.netsapiens.com' },
  user: { domain: 'vbox.netsapiens.com', username: '1002' },
  // Exactly what the host's DataTable passes into the `table-row-actions`
  // zone — the grid row as the Users page's own query returned it.
  pageContext: { row },
  theme: 'light',
});

const FakeUsers: React.FC = () => (
  <div style={{ padding: 12, fontFamily: 'system-ui, sans-serif' }}>
    <h3>Users (faked host table)</h3>
    <p style={{ opacity: 0.7, fontSize: 13, marginTop: -8 }}>
      A row shows what is recorded, or — where nothing is — the way to ask for
      it. Consent is never changed here; that stays on the Consent page. Which
      rows carry a button at all is the platform&rsquo;s answer, under the
      signed-in role.
    </p>
    <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
      <tbody>
        {FAKE_USER_ROWS.map(row => (
          <tr key={row.user}
              style={{ borderBottom: '1px solid rgba(128,128,128,0.2)' }}>
            <td style={{ padding: '8px 12px' }}>
              {row['name-first-name']} {row['name-last-name']}
              <div style={{ opacity: 0.6, fontSize: 11 }}>{row.label}</div>
            </td>
            <td style={{ padding: '8px 12px', fontFamily: 'ui-monospace, monospace',
                         fontSize: 11 }}>
              {row.user}@{row.domain}
              {row.user !== row.extension && (
                <div style={{ opacity: 0.6 }}>{row.extension}@{row.domain}</div>
              )}
            </td>
            <td style={{ padding: '8px 12px' }}>
              <UserConsentButton context={usersContext(row)} zone="table-row-actions" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const FakeCallLogs: React.FC = () => (
  <div style={{ padding: 12, fontFamily: 'system-ui, sans-serif' }}>
    <h3>Call Logs (faked host table)</h3>
    <p style={{ opacity: 0.7, fontSize: 13, marginTop: -8 }}>
      Buttons appear only where the platform reports a visible recording. Start
      the dev server with SIPREC_HARNESS_TOKEN set, or every row answers 401.
    </p>
    <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
      <tbody>
        {FAKE_ROWS.map(row => (
          <tr key={row['call-parent-cdr-id']}
              style={{ borderBottom: '1px solid rgba(128,128,128,0.2)' }}>
            <td style={{ padding: '8px 12px' }}>{row.label}</td>
            <td style={{ padding: '8px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
              {row['call-parent-cdr-id']}
              <div style={{ opacity: 0.6 }}>
                {row['call-orig-call-id'] ?? '(Call-ID resolved via api.get)'}
              </div>
            </td>
            <td style={{ padding: '8px 12px' }}>
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <CallLogPlayButton context={extensionContext(row)} zone="table-row-actions" />
                <CallLogVconButton context={extensionContext(row)} zone="table-row-actions" />
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div style={{ padding: 12, background: '#fff8e1', borderBottom: '1px solid #e6cfa6' }}>
      <strong>Standalone harness</strong> — props below are faked. In Horizon
      these come from the host.
    </div>
    {/* App is headless (it only registers routes), so the harness renders
        the page component directly after letting App park the props. */}
    <App {...fakeProps} />
    <FakeCallLogs />
    <FakeUsers />
    {/* The two menu-entry pages, as the host router renders them — reading the
        parked host props rather than receiving them as JSX, which is the part
        worth exercising here. Previously absent from the harness entirely, so
        a change to either could only be seen by deploying. */}
    <SectionRecordings />
    <SectionConsent />
    <Console />
  </React.StrictMode>,
);
