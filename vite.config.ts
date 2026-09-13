import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import federation from '@originjs/vite-plugin-federation';

// Horizon loads a remote as:
//   RemoteComponent{ url: remoteEntryUrl, moduleFederationScope: webpack_module, module: "./App" }
// so `name` here must equal the app's `webpack_module` in the Horizon
// registry, and "./App" must be exposed. Those two strings are the contract;
// everything else is ours.
//
// camelCase, NOT snake_case: HorizonExtensionsController validates
// webpack_module against /^[a-zA-Z][a-zA-Z0-9]*$/ and rejects underscores
// with a 400 ("must be in camelCase format"), even though snake_case is the
// usual Module Federation convention.
const FEDERATION_NAME = 'siprecConsole';

// The harness is served under the same path a self-hosted deployment uses,
// so the federated chunks resolve against that prefix rather than '/'.
// Override with VITE_BASE for any other layout.
const BASE = process.env.VITE_BASE ?? '/platform/siprec-app/';

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    // Horizon is served over HTTPS, so a plain http:// remoteEntry would be
    // blocked as mixed content and never load. The dev server therefore has
    // to be HTTPS too — self-signed is fine, but the browser must be told to
    // trust it once (open the dev URL directly and accept) before Horizon
    // can pull the script.
    //
    // HARNESS_HTTP=1 turns that off. Nothing about the STANDALONE harness
    // needs TLS — it is opened directly, not pulled by Horizon — and a
    // self-signed certificate is an interstitial (or an outright refusal, in
    // an automated browser) between a developer and the page they are trying
    // to look at. Leave it unset whenever Horizon is the consumer.
    ...(process.env.HARNESS_HTTP ? [] : [basicSsl()]),
    federation({
      name: FEDERATION_NAME,
      filename: 'remoteEntry.js',
      exposes: {
        './App': './src/App.tsx',
      },
      // Horizon initialises shared React/ReactDOM. Sharing them prevents a
      // second React instance, which breaks hooks in subtle ways.
      shared: ['react', 'react-dom'],
    }),
  ],
  // The harness talks to the LOCAL platform through the dev server rather than
  // directly: it is served over HTTPS (basicSsl, above), and a page on https
  // may not fetch http://localhost:8080 — the browser blocks it as mixed
  // content before any CORS header is considered. Proxying keeps the API
  // same-origin, which also makes horizonCors() irrelevant here.
  define: {
    // No __SIPREC_API__ here any more: api.ts holds the same-origin path as a
    // literal, and the proxy below maps it the way a portal's Apache stanza
    // does. The harness therefore exercises the SAME code path as a deployed
    // build rather than a near-miss of it.
    //
    // The harness is never a deployed build, and saying so is more useful than
    // a number that would look like one.
    __APP_VERSION__: JSON.stringify('harness'),
    __BUILD_DATE__: JSON.stringify(''),
  },
  server: {
    proxy: {
      // Same prefix the app asks for in production; only the far end differs.
      // The local API is served at /api, so the prefix is rewritten rather
      // than the app being told to ask for something else.
      '/siprec-api': {
        target: 'http://localhost:8080',
        changeOrigin: false,
        rewrite: (path: string) => path.replace(/^\/siprec-api/, '/api'),
        // The harness has no Horizon broker, so it cannot mint a platform
        // token — but the endpoints all require one. Start the dev server with
        // a token in the environment and the proxy attaches it, replacing the
        // placeholder the page sends:
        //
        //   SIPREC_HARNESS_TOKEN=$(php scripts/mint-harness-token.php) npm run harness
        //
        // The token stays in the shell and the server process. It is never in
        // the page, in local storage, in the URL, or in anything the browser
        // can read back — which is the point: a harness should not need a
        // credential pasted into it.
        //
        // The instance key rides alongside, from the environment for the same
        // reason: a portal injects one server-side to say which Horizon
        // instance a request came through, and a platform that enforces this
        // refuses anything without it. The harness IS another instance as far
        // as the platform is concerned, so it presents its own key rather than
        // being exempted — an exemption for loopback is the kind that quietly
        // becomes the way in.
        //
        //   php horizon_instance_admin.php add "local dev harness"
        headers: {
          ...(process.env.SIPREC_HARNESS_TOKEN
            ? { Authorization: `Bearer ${process.env.SIPREC_HARNESS_TOKEN}` }
            : {}),
          ...(process.env.SIPREC_INSTANCE_KEY
            ? { 'X-Siprec-Instance-Key': process.env.SIPREC_INSTANCE_KEY }
            : {}),
        },
      },
    },
    port: 5011,
    strictPort: true,
    // The remote is fetched by Horizon's origin, not ours.
    cors: true,
    headers: { 'Access-Control-Allow-Origin': '*' },
  },
  preview: {
    port: 5011,
    strictPort: true,
    cors: true,
    headers: { 'Access-Control-Allow-Origin': '*' },
  },
  build: {
    // Module Federation needs these for the container format.
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
  },
});
