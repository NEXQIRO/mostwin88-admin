'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { getStatus } = require('./firebaseAdmin');
const { applySecurityHeaders } = require('./securityEngine');
const { handleApiRequest } = require('./routes');

const PORT = Number(process.env.PORT) || 3000;
const BACKEND_DIR = __dirname;
const PUBLIC_ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// STRICT PUBLIC ALLOWLIST ONLY
// Private backend & secret files (backend/*, server.js, serviceAccountKey.json, .env,
// database.rules.json, package.json, render.yaml, *.test.js) ALWAYS return 404.
const ALLOWED_ROOT_FILES = new Set([
  'user.html',
  'index.html',
  'master.html',
  'agent.html',
  'affiliate.html',
  'firebase-config.js',
  'pwa.js',
  'passkey.js',
  'user-manifest.json',
  'admin-manifest.json',
  'master-manifest.json',
  'agent-manifest.json',
  'affiliate-manifest.json',
  'user-sw.js',
  'admin-sw.js',
  'master-sw.js',
  'agent-sw.js',
  'affiliate-sw.js',
  'icon-192.png',
  'icon-512.png',
  'admin-icon-192.png',
  'admin-icon-512.png',
  'master-icon-192.png',
  'master-icon-512.png',
  'agent-icon-192.png',
  'agent-icon-512.png',
  'affiliate-icon-192.png',
  'affiliate-icon-512.png'
]);

const ROUTE_ALIASES = {
  '/': 'user.html',
  '/user': 'user.html',
  '/admin': 'index.html',
  '/master': 'master.html',
  '/agent': 'agent.html',
  '/affiliate': 'affiliate.html'
};

function resolveSafeFile(reqPath) {
  const clean = reqPath.replace(/\/+$/, '') || '/';
  if (ROUTE_ALIASES[clean]) {
    return path.join(PUBLIC_ROOT, ROUTE_ALIASES[clean]);
  }
  const rel = clean.replace(/^\/+/, '');
  if (!rel || rel.includes('..') || rel.includes('\0') || rel.startsWith('.')) return null;

  const lower = rel.toLowerCase();
  if (
    lower === 'backend' ||
    lower.startsWith('backend/') ||
    lower.startsWith('secrets/') ||
    lower.startsWith('private/') ||
    lower.includes('serviceaccount') ||
    lower.includes('firebase-adminsdk') ||
    lower.startsWith('.env') ||
    lower === 'server.js' ||
    lower === 'database.rules.json' ||
    lower === 'package.json' ||
    lower === 'package-lock.json' ||
    lower === 'render.yaml' ||
    lower === 'firebase.json' ||
    lower === 'metadata.json'
  ) {
    return null;
  }

  if (ALLOWED_ROOT_FILES.has(rel)) {
    return path.join(PUBLIC_ROOT, rel);
  }

  if (rel.startsWith('assets/')) {
    const target = path.resolve(PUBLIC_ROOT, 'public', rel);
    if (target.startsWith(path.resolve(PUBLIC_ROOT, 'public', 'assets') + path.sep)) return target;
  }
  if (rel.startsWith('public/assets/')) {
    const target = path.resolve(PUBLIC_ROOT, rel);
    if (target.startsWith(path.resolve(PUBLIC_ROOT, 'public', 'assets') + path.sep)) return target;
  }

  return null;
}

function createAppServer() {
  return http.createServer(async (req, res) => {
    const parsed = url.parse(req.url || '/', true);
    let pathname = '/';
    try {
      pathname = decodeURIComponent(parsed.pathname || '/');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('400 Bad Request');
    }

    applySecurityHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (pathname === '/health' || pathname === '/api/health' || pathname === '/api/ip' || pathname.startsWith('/api/')) {
      const handled = await handleApiRequest(req, res, pathname);
      if (handled) return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
    }

    const filePath = resolveSafeFile(pathname);
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        // When `backend/` is deployed standalone on Render without parent HTML files,
        // return a clean API status response on `/` instead of a 404.
        if (pathname === '/' || pathname === '') {
          const st = getStatus();
          const payload = JSON.stringify({
            ok: true,
            service: 'MOSTWIN88 Private Backend API',
            mode: 'backend-only',
            firebaseConfigured: st.configured
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(req.method === 'HEAD' ? undefined : payload);
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      const isSw = filePath.endsWith('-sw.js');
      const cacheControl = (ext === '.html' || isSw) ? 'no-cache, no-store, must-revalidate' : 'public, max-age=300';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': cacheControl
      });

      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath).pipe(res);
    });
  });
}

if (require.main === module) {
  const server = createAppServer();
  server.listen(PORT, '0.0.0.0', () => {
    const st = getStatus();
    console.log(`MOSTWIN88 Private Backend Server running on http://0.0.0.0:${PORT}`);
    console.log(`Backend root: ${BACKEND_DIR}`);
    console.log(`Backend Firebase Admin status: ${st.configured ? 'READY (' + st.credentialSource + ')' : 'NOT CONFIGURED - ' + st.error}`);
  });
}

module.exports = { createAppServer, resolveSafeFile, ALLOWED_ROOT_FILES };
