const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

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

// Publicly allowed root files and safe asset directories
const ALLOWED_ROOT_FILES = new Set([
  'user.html',
  'index.html',
  'master.html',
  'agent.html',
  'affiliate.html',
  'firebase-config.js'
]);

const ROUTE_ALIASES = {
  '/': 'user.html',
  '/user': 'user.html',
  '/admin': 'index.html',
  '/master': 'master.html',
  '/agent': 'agent.html',
  '/affiliate': 'affiliate.html'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

function resolveSafeFile(reqPath) {
  const clean = reqPath.replace(/\/+$/, '') || '/';
  if (ROUTE_ALIASES[clean]) {
    return path.join(ROOT, ROUTE_ALIASES[clean]);
  }
  const rel = clean.replace(/^\/+/, '');
  if (!rel || rel.includes('..') || rel.includes('\0')) return null;

  if (ALLOWED_ROOT_FILES.has(rel)) {
    return path.join(ROOT, rel);
  }

  // Allow static assets inside public/assets/ via /assets/... or /public/assets/...
  if (rel.startsWith('assets/')) {
    const target = path.resolve(ROOT, 'public', rel);
    if (target.startsWith(path.resolve(ROOT, 'public', 'assets') + path.sep)) return target;
  }
  if (rel.startsWith('public/assets/')) {
    const target = path.resolve(ROOT, rel);
    if (target.startsWith(path.resolve(ROOT, 'public', 'assets') + path.sep)) return target;
  }

  return null;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url || '/', true);
  const pathname = decodeURIComponent(parsed.pathname || '/');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // Render health check
  if (pathname === '/health' || pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'mostwin88-platform',
      timestamp: Date.now(),
      panels: ['user.html', 'index.html', 'master.html', 'agent.html', 'affiliate.html']
    });
  }

  // Real client IP endpoint for security/device logging
  if (pathname === '/api/ip') {
    return sendJson(res, 200, { ip: getClientIp(req) });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  const filePath = resolveSafeFile(pathname);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const cacheControl = ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=300';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl
    });

    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MOSTWIN88 Server running on http://0.0.0.0:${PORT}`);
});
