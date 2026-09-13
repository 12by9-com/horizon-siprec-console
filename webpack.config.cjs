// Webpack, not Vite, because Horizon loads a remote container as a CLASSIC
// script:
//
//     const script = document.createElement('script');
//     script.type = 'text/javascript';      // not type="module"
//     script.src = url;
//
// and then expects `window[webpack_module]` to exist with .init()/.get().
//
// @originjs/vite-plugin-federation emits an ES module with a top-level
// `export`, which a classic script cannot parse — the browser throws a
// SyntaxError before the container is ever defined. That failure is invisible
// from the host side (RemoteComponent's errorFallback returns null), and shows
// up only as remoteEntry.js being fetched 200 repeatedly while the exposed
// chunk is never requested.
//
// ModuleFederationPlugin is the reference implementation Horizon was built
// against — the registry field is literally called `webpack_module`.

const path = require('path');
const webpack = require('webpack');
const { ModuleFederationPlugin } = require('webpack').container;
const { SubresourceIntegrityPlugin } = require('webpack-subresource-integrity');
const pkg = require('./package.json');

// Must equal the app's `webpack_module` in the Horizon registry. camelCase:
// HorizonExtensionsController rejects underscores with a 400.
const FEDERATION_NAME = 'siprecConsole';

// Where the chunks are fetched from, relative to the entry.
//
// 'auto' resolves them against whatever URL remoteEntry.js was itself loaded
// from, which is the only correct answer for a bundle published once and
// loaded by portals that each name it differently. A literal prefix would
// pin the chunks to one deployment's layout and 404 everywhere else.
// Set PUBLIC_PATH to override for a self-hosted copy under a fixed path.
const PUBLIC_PATH = process.env.PUBLIC_PATH || 'auto';

module.exports = (env, argv) => {
const isProduction = argv.mode !== 'development';
return {
  mode: isProduction ? 'production' : 'development',
  entry: './src/bootstrap.ts',
  // Horizon verifies a bundle before it will load it (api-v2
  // HorizonBundleVerifier + HorizonBundleAnalyzer, live since Horizon 46).
  // `missing-source-map` is one of the analyser's synthetic
  // rules and its severity is 'reject' — and HorizonRulePolicy::validate()
  // refuses to let an operator relax it, so there is no server-side setting
  // that makes a map-less bundle loadable. The maps must also carry
  // sourcesContent, so never 'nosources-source-map'.
  devtool: 'source-map',
  output: {
    path: path.resolve(__dirname, 'dist/assets'),
    publicPath: PUBLIC_PATH,
    // Content-hashed chunk names. Without them webpack reuses small integer
    // ids, so two different builds both emit a "540.js" with different
    // contents — and a browser holding the old one serves it to the new
    // container. That failure is near-invisible: the app loads, but half of
    // it is from a previous deploy.
    //
    // remoteEntry.js keeps its fixed name (ModuleFederationPlugin sets it
    // below) because the Horizon registry stores that URL; it is the one file
    // that must not move, which is why it is also served no-cache.
    filename: '[name].[contenthash].js',
    chunkFilename: '[name].[contenthash].js',
    // Required by SubresourceIntegrityPlugin, and required for the integrity
    // values to mean anything: a browser cannot check a hash against an opaque
    // response. We are served same-origin with the portal today, so the
    // verifier's cors-required rule exempts us — but the attribute has to be
    // on the tags regardless, or the plugin refuses to emit at all.
    crossOriginLoading: 'anonymous',
    clean: true,
  },
  resolve: { extensions: ['.tsx', '.ts', '.jsx', '.js'] },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ['@babel/preset-env', { targets: { esmodules: true } }],
              ['@babel/preset-react', { runtime: 'automatic' }],
              '@babel/preset-typescript',
            ],
          },
        },
      },
    ],
  },
  plugins: [
    new webpack.DefinePlugin({
      __APP_VERSION__: JSON.stringify(pkg.version),
      // When these bytes were produced. The version alone does not settle
      // "is this the build I just deployed?" — the entry URL is stable and a
      // rebuild at the same version is invisible without it, which is exactly
      // the question this app makes hardest to answer: it runs on pages it
      // does not own, and a stale bundle looks like a feature that never
      // shipped. UTC, and to the minute rather than the day, because two
      // deploys in an afternoon is the normal case here.
      __BUILD_DATE__: JSON.stringify(
        new Date().toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z')),
    }),
    new ModuleFederationPlugin({
      name: FEDERATION_NAME,
      filename: 'remoteEntry.js',
      exposes: { './App': './src/App' },
      // singleton so the host's React instance is reused. Two React copies in
      // one tree breaks hooks in ways that are painful to diagnose.
      // requiredVersion false: Horizon is on React 19, but pinning a range
      // here only creates a version-mismatch warning we cannot act on.
      //
      // import: false — no bundled fallback. Horizon registers react and
      // react-dom in the share scope (it is one of only five modules it
      // shares), so the fallback was dead weight that could only ever be
      // reached in the one case where using it is WRONG: a host that did not
      // provide React, where loading our own copy gives two Reacts in one tree.
      // Failing loudly there is better than rendering with broken hooks.
      //
      // It is also what makes the SRI build work at all. With a fallback,
      // webpack emits a `consume-shared-module|…|react` chunk that holds only
      // the consume stub and therefore has NO OUTPUT FILE. Nothing hashes it,
      // so its `sriHashes` entry keeps the plugin's magic placeholder and the
      // build dies with "Asset remoteEntry.js contains unresolved integrity
      // placeholders" — a message that names neither React nor a chunk id. If
      // that error ever comes back, look for a chunk with `files: []` before
      // suspecting the plugin. (hashLoading: 'lazy' does NOT fix it; the
      // ordering was never the problem.)
      shared: {
        react: { singleton: true, requiredVersion: false, import: false },
        'react-dom': { singleton: true, requiredVersion: false, import: false },
      },
    }),
    // Emits `__webpack_require__.sriHashes = {<id>: "sha384-…"}` into
    // remoteEntry.js. This is the one check with no way around it:
    // HorizonBundleVerifier returns REJECTED outright when
    // detectChunkSri() finds no sriHashes map — pinning the entry alone would
    // validate a loader and nothing it loads. Production only; the plugin
    // warns under mode: development and offers the dev server nothing.
    ...(isProduction
      ? [new SubresourceIntegrityPlugin({ hashFuncNames: ['sha384'] })]
      : []),
  ],
  devServer: {
    port: 5011,
    server: 'https',
    headers: { 'Access-Control-Allow-Origin': '*' },
    static: { directory: path.resolve(__dirname, 'public') },
  },
  infrastructureLogging: { level: 'warn' },
  stats: 'errors-warnings',
};
};
