'use strict';

const fs = require('fs');
const path = require('path');

let adminSdk = null;
let appInstance = null;
let initError = null;
let credentialSource = null;

function loadDotEnvIfPresent() {
  const envCandidates = [
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '..', '.env')
  ];
  for (const envPath of envCandidates) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    } catch (err) {
      // Ignore unreadable .env
    }
  }
}

loadDotEnvIfPresent();

function parseServiceAccountJson(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith('{')) {
      return JSON.parse(trimmed);
    }
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded.trim().startsWith('{')) {
      return JSON.parse(decoded);
    }
  } catch (err) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON or base64 JSON: ' + err.message);
  }
  throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must be a JSON object or base64-encoded JSON');
}

function findServiceAccountFile() {
  const explicit = (process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim();
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  candidates.push('/etc/secrets/serviceAccountKey.json');
  candidates.push(path.resolve(__dirname, 'secrets', 'serviceAccountKey.json'));
  candidates.push(path.resolve(__dirname, 'serviceAccountKey.json'));
  candidates.push(path.resolve(__dirname, '..', 'serviceAccountKey.json'));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_) {}
  }

  // Fallback scan for *firebase-adminsdk*.json in backend/secrets, backend/, or root (never served statically)
  for (const dir of [path.resolve(__dirname, 'secrets'), __dirname, path.resolve(__dirname, '..')]) {
    try {
      if (!fs.existsSync(dir)) continue;
      const hit = fs.readdirSync(dir).find(f => /firebase-adminsdk.*\.json$/i.test(f));
      if (hit) return path.join(dir, hit);
    } catch (_) {}
  }
  return null;
}

function initFirebaseAdmin() {
  if (appInstance) return appInstance;

  try {
    adminSdk = require('firebase-admin');
  } catch (err) {
    initError = 'firebase-admin package is not installed yet (run npm install).';
    return null;
  }

  if (adminSdk.apps && adminSdk.apps.length > 0) {
    appInstance = adminSdk.app();
    credentialSource = credentialSource || 'existing-app';
    initError = null;
    return appInstance;
  }

  const databaseURL =
    (process.env.FIREBASE_DATABASE_URL || '').trim() ||
    'https://mostwin88-febbf-default-rtdb.asia-southeast1.firebasedatabase.app';

  try {
    let serviceAccount = null;
    const rawJsonEnv = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (rawJsonEnv) {
      serviceAccount = parseServiceAccountJson(rawJsonEnv);
      credentialSource = 'env:FIREBASE_SERVICE_ACCOUNT_JSON';
    } else {
      const filePath = findServiceAccountFile();
      if (filePath) {
        const content = fs.readFileSync(filePath, 'utf8');
        serviceAccount = JSON.parse(content);
        credentialSource = 'file:' + path.basename(filePath);
      }
    }

    if (!serviceAccount) {
      initError =
        'Firebase Admin credentials not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON or mount serviceAccountKey.json in Render Secret Files (/etc/secrets/serviceAccountKey.json).';
      return null;
    }

    if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
      initError = 'Service account JSON is missing required fields (project_id, client_email, private_key).';
      return null;
    }

    appInstance = adminSdk.initializeApp({
      credential: adminSdk.credential.cert(serviceAccount),
      databaseURL
    });
    initError = null;
    return appInstance;
  } catch (err) {
    initError = err.message || String(err);
    appInstance = null;
    return null;
  }
}

initFirebaseAdmin();

function isReady() {
  if (!appInstance) initFirebaseAdmin();
  return !!appInstance;
}

function getStatus() {
  isReady();
  return {
    configured: !!appInstance,
    databaseURL:
      (process.env.FIREBASE_DATABASE_URL || '').trim() ||
      'https://mostwin88-febbf-default-rtdb.asia-southeast1.firebasedatabase.app',
    masterEmailConfigured: !!(process.env.MASTER_ADMIN_EMAIL || 'mijanbabu2015@gmail.com'),
    credentialSource: credentialSource || null,
    error: appInstance ? null : initError
  };
}

function getDb() {
  if (!isReady()) {
    const err = new Error(initError || 'Firebase Admin SDK is not configured on backend.');
    err.statusCode = 503;
    err.code = 'BACKEND_NOT_CONFIGURED';
    throw err;
  }
  return adminSdk.database();
}

function getAuth() {
  if (!isReady()) {
    const err = new Error(initError || 'Firebase Admin SDK is not configured on backend.');
    err.statusCode = 503;
    err.code = 'BACKEND_NOT_CONFIGURED';
    throw err;
  }
  return adminSdk.auth();
}

function getServerTimestamp() {
  if (adminSdk && adminSdk.database && adminSdk.database.ServerValue) {
    return adminSdk.database.ServerValue.TIMESTAMP;
  }
  return Date.now();
}

module.exports = {
  isReady,
  getStatus,
  getDb,
  getAuth,
  getServerTimestamp
};
