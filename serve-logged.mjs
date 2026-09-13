// HTTPS static server for dist/ that LOGS every request.
//
// `vite preview` serves the federated bundle fine but logs nothing, so when
// Horizon fails to load a remote there is no way to tell whether it never
// asked, asked and got a 404, or asked and was refused by the browser before
// the request left. This answers that.
//
// Reuses the cert @vitejs/plugin-basic-ssl already generated, so a browser
// that has accepted the dev cert does not have to accept a new one.

import { createServer } from 'node:https';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const ROOT = new URL('./dist/', import.meta.url).pathname;
const CERT = new URL('./node_modules/.vite/basic-ssl/_cert.pem', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 5011);

const pem = readFileSync(CERT);
const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

const server = createServer({ key: pem, cert: pem }, (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `https://${req.headers.host}`);
  // Contain the path: this serves a build directory to the local network.
  const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(ROOT, rel === '/' ? 'index.html' : rel);

  // Module Federation fetches are cross-origin from Horizon's page.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    log(req, url, 204, started);
    return;
  }

  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    log(req, url, 404, started);
    return;
  }

  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
  log(req, url, 200, started);
});

function log(req, url, status, started) {
  const who = req.socket.remoteAddress?.replace('::ffff:', '') || '?';
  const origin = req.headers.origin || req.headers.referer || '-';
  console.log(
    `${new Date().toISOString()}  ${status}  ${req.method} ${url.pathname}` +
    `  from=${who}  origin=${origin}  ${Date.now() - started}ms`,
  );
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`serving ${ROOT} on https://0.0.0.0:${PORT} (logging every request)`);
});
