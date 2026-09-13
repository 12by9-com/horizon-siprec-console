# SIPREC Console — a federated NetSapiens Horizon app

Adds a **SIPREC Console** page inside NetSapiens Horizon at `/apps/siprec-console`,
giving Horizon users their recordings and their consent without leaving the portal.

| Tab | What it does |
|---|---|
| **Recordings** | Search and in-page playback of the conversations the signed-in user may see |
| **Consent** | Per-purpose consent (recording / transcription / analysis / AI training), issuing an Ed25519-signed receipt identical to the data-subject portal's |
| **Access** | Super User only — raises or lowers every other role's reach, without a deploy |
| **Diagnostics** | What Horizon actually passes to the app; the fastest check on a fresh deploy |

The page renders **"My Recordings" / "My Consent"** only when the platform grants
`own` visibility, and plain nouns for a manager looking at a whole domain, so
whose data is on screen is never ambiguous.

## What it adds to Horizon's own pages

Recordings and Consent also register as menu entries after **Call Logs** — under
Manage for Admin / Super User / Reseller, under My Account for everyone else.
Beyond that, the app draws into pages it does not own, through the host's
`table-row-actions` zone, which the shared `DataTable` renders at the end of
every row's action column on any page that declares native actions:

| Host page | Button | What it opens |
|---|---|---|
| Call Logs | ▶ Play | The recording of that call — or the list, when a transfer split it into several segments |
| Call Logs | vCon | The stored conversation document behind it |
| Users | Consent | What consent is recorded for that person and the signed receipt behind it — or, where nothing is recorded, a link that asks them for it |

The Users button never *changes* a decision. Changing consent stays on the
Consent page, which shows the agreement, issues a receipt and rewrites the
person's conversations; a bulk-administration page is the wrong place to put
that one mis-click from Delete.

The one thing it does write is a **request**. A seat only enters the consent
registry once it has been on a recorded conversation, so most rows have no
record — and the answer to that is not to let an administrator invent one. The
popup mints a portal invite, the person opens the link and decides, and the
result is stored as self-asserted. An administrator asking is not an
administrator answering. A live request is never duplicated: asking again hands
back the link that is already out, and it can be cancelled, which kills the link
immediately.

Requests are delivered out of band — this platform emails nobody. Turning the
invite into a link an operator can send needs `PORTAL_BASE_URL` in the API's
`config.php`, which is per-host and must name the portal in front of *this*
database; unset, the popup shows the path and says so rather than offering a
link that goes nowhere.

Neither surface needs cooperation from the host page, and neither gates itself
on a role: the platform answers under the caller's own scope, so a row with
nothing visible behind it simply gets no button.

## The security model

The page never asserts who the user is, and a modified bundle cannot widen what
it sees.

1. The app calls `auth.requestRemoteAuth()`. Horizon's **backend** — not the
   browser — POSTs an HMAC-signed webhook to `horizon_auth_callback.php` on the
   SIPREC platform, carrying an identity bound to the session token.
2. That endpoint redeems the webhook's PKCE code against the NetSapiens API to
   read the caller's **verified** scope and territory, then mints its own
   short-lived opaque token.
3. Every request carries that token. The platform re-derives the role from it
   and builds the visibility predicate **in SQL** (`horizonScopeClause`).

Defaults: Basic User and Call Center Agent see only themselves; Office Manager
and Call Center Supervisor their domain; Reseller their territory; Super User
everything. All of it is editable from the Access tab.

Scoping keys on **`party_uid`** — the person — never the AOR. One user may answer
on several devices, and their records follow them, not a handset.

## Build

**The build carries no hostname.** The app fetches from a same-origin
`/siprec-api/`, and each Horizon instance maps that prefix to its own platform
with an Apache stanza on the portal host:

```apache
ProxyPass        /siprec-api/ https://<that cluster's platform>/api/
ProxyPassReverse /siprec-api/ https://<that cluster's platform>/api/
```

So one build serves every instance, and which recorder an instance talks to is
a config decision on that instance rather than a property of these bytes. A
portal with no such stanza 404s on every request — the intended failure, since
the alternative is a bundle silently talking to someone else's platform.

The remote-auth **callback URL** is unrelated to this and is not built in
either: since SDK 0.2.x it is registration data
(`horizon_extensions.remote_callback_url`), set per instance by an
administrator. It can never be `localhost`, because Horizon's backend is what
posts to it.

```bash
npm install
npm run build

npm run typecheck   # tsc --noEmit
npm run harness     # standalone Vite harness, no Horizon required
```

Output lands in `dist/assets/`, with `publicPath: 'auto'` so the chunks resolve
against wherever `remoteEntry.js` was itself loaded from. That is what lets one
published copy be loaded by portals that each name it differently.

### Publishing

Pushing to `main` builds and publishes `dist/assets/` to GitHub Pages, which
serves it as a CDN with `Access-Control-Allow-Origin: *`:

```
https://12by9-com.github.io/horizon-siprec-console/remoteEntry.js
```

Horizon's `approved_cdn_origins` ships with `*.github.io` in it, so no operator
change is needed to load from there.

To self-host instead, copy `dist/assets/` under the portal's docroot and build
with `PUBLIC_PATH=/platform/siprec-app/assets/` so the chunks resolve against
that fixed prefix. Note that a host resolving to a private address may not be
fetchable by the platform's bundle verifier — which is a second reason to
prefer a public origin.

**Webpack, not Vite.** Horizon injects the remote container as a *classic*
script and expects `window[webpack_module]`. `@originjs/vite-plugin-federation`
emits an ES module, which a classic script cannot parse — and the failure is
invisible from the host side.

**Chunks are content-hashed.** Webpack otherwise reuses small integer ids, so
two builds both emit a `540.js` with different contents and a browser holding
the old one hands it to the new container: an app that loads, with half of it
from a previous deploy. `remoteEntry.js` keeps a fixed name because the Horizon
registry stores that URL.

## Registering it in Horizon

Row in `NsApi.horizon_extensions`:

| Field | Value |
|---|---|
| `webpack_module` | `siprecConsole` — must match `FEDERATION_NAME` in `webpack.config.cjs`, and must be camelCase (underscores are rejected with a 400) |
| `remote_entry_url` | `https://12by9-com.github.io/horizon-siprec-console/remoteEntry.js` (or your self-hosted path) |
| `remote_auth_enabled` | `yes` |
| `allowed_hostnames` | the origin of the callback URL |
| `remote_callback_secret` | must equal `HORIZON_CALLBACK_SECRET` in the platform's `siprec-api/config.php` |

Also needs an enabling row in `NsApi.horizon_extension_config`, or the app is
registered but never mounts.

The exported `./App` is a **registrar, not a page**: Horizon mounts it headlessly
and expects it to emit `route:register` and render `null`. Rendering UI directly
produces "Route Not Found".

## Deployment gotchas

These cost real hours. All four are host configuration, none live in this repo.

1. **Serve the bundle `no-cache`.** With only ETag/Last-Modified, browsers invent
   a freshness lifetime (~10% of file age). Worse, `remoteEntry.js` is injected
   *dynamically*, and a hard reload does **not** bypass the cache for
   dynamically-injected scripts — only for the document and parser-inserted
   subresources. A redeploy then generates zero network requests and Horizon
   keeps running the old build. To escape an already-poisoned cache entry, bump
   `remote_entry_url` with a `?v=` query.

2. **Reverse-proxy the API under the Horizon origin — this one is required, not
   an option.** The app asks for a same-origin `/siprec-api/` and has no
   fallback, so a portal without the stanza 404s every request. It also solves
   mixed content, CORS and backend reachability for the callback in one move,
   and gives you somewhere server-side to attach a per-instance credential that
   a browser bundle could never hold. The Diagnostics tab names the prefix and
   where it resolves, which is the first thing to check when a fresh install
   shows nothing.

3. **`scope_priv` blocks every federated app below Reseller — via TWO models.**
   Only Super User, Super User Read Only, Reseller and Route Manager Reseller
   have a wildcard `model='*'` row; every other scope needs explicit rows for
   **both** of these, or no app mounts at all:

   | Endpoint | `scope_priv` model | Effect when 403 |
   |---|---|---|
   | `/ns-api/v2/ui-extensions` | `horizon_extensions` | no app list |
   | `/ns-api/v2/ui-extensions/settings` | `horizon_extension_settings` | empty approved-CDN list |

   The second is the one that will waste a day. `getSdkSettings()` swallows the
   403 and falls back to defaults with an empty `approved-cdn-origins`;
   `setApprovedDomains([])` then leaves only `localhost`/`127.0.0.1` approved,
   so `isApprovedDomain()` rejects the host's own URL and `moduleLoader.load()`
   throws "Domain not approved" before a script tag is ever created —
   invisibly, because `RemoteComponent`'s `errorFallback` returns null. Static
   menu entries still render, so the section looks fine and only the federated
   entries are missing.

   Minimum working grant for each is `territory_list` + `territory_read` (user-
   and domain-level do not pass; `global_list` alone does not either).
   `scope_priv` is cached ~20 minutes, so the change looks inert until the
   `_oauth_token_` cache entries are cleared:

   ```bash
   sudo find /usr/local/NetSapiens/netsapiens-api-v2/tmp/cache/models \
     -name 'apiv2__oauth_token_oauth_model*horizon*' -delete
   ```

4. **PHP behind mod_php doesn't see `Authorization`.** Apache withholds it from
   the CGI environment unless `CGIPassAuth` is on, so the API also reads
   `apache_request_headers()`.

## Related

- `siprec-api` — `horizon_*.php` (auth callback, recordings, consent, scope access)
- `siprec_recorder` — `schema_horizon_access.sql`, `schema_receipt_no_invite.sql`
- `siprec-viewer` — the standalone console and data-subject consent portal
