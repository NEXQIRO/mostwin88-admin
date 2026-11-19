'use strict';

const crypto = require('crypto');
const { getDb, getAuth, getServerTimestamp } = require('./firebaseAdmin');

const MASTER_EMAIL = String(process.env.MASTER_ADMIN_EMAIL || 'mijanbabu2015@gmail.com')
  .trim()
  .toLowerCase();

const MAX_BODY_BYTES = 256 * 1024;
const rateBuckets = new Map();

// Periodically prune stale rate-limit windows
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of rateBuckets.entries()) {
    if (!b || b.resetAt <= now) rateBuckets.delete(key);
  }
}, 60 * 1000).unref();

class ApiError extends Error {
  constructor(statusCode, message, code = 'API_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

function parseAllowedOrigins() {
  const raw = String(process.env.ALLOWED_ORIGINS || '*').trim();
  if (!raw || raw === '*') return null; // wildcard
  return new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
}

function getCorsOrigin(req) {
  const allow = parseAllowedOrigins();
  const origin = req.headers.origin;
  if (!allow) return origin || '*';
  if (origin && allow.has(origin)) return origin;
  return Array.from(allow)[0] || '*';
}

function applySecurityHeaders(req, res) {
  const corsOrigin = getCorsOrigin(req);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-API-Key, X-Sign, X-Signature, X-Webhook-Secret, X-Hub-Signature-256'
  );
  res.setHeader('Vary', 'Origin');
}

function sendJson(req, res, statusCode, payload) {
  applySecurityHeaders(req, res);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function readRawAndJsonBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'Request body too large', 'PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({ raw: '', json: {} });
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({ raw: '', json: {} });
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new ApiError(400, 'JSON body must be an object', 'INVALID_JSON'));
        }
        resolve({ raw, json: parsed });
      } catch (err) {
        reject(new ApiError(400, 'Invalid JSON body', 'INVALID_JSON'));
      }
    });
    req.on('error', err => reject(new ApiError(400, err.message || 'Body read error', 'READ_ERROR')));
  });
}

async function readJsonBody(req) {
  const { json } = await readRawAndJsonBody(req);
  return json;
}

function checkRateLimit(bucketKey, maxRequests = 30, windowMs = 60 * 1000) {
  const now = Date.now();
  let b = rateBuckets.get(bucketKey);
  if (!b || b.resetAt <= now) {
    b = { count: 1, resetAt: now + windowMs };
    rateBuckets.set(bucketKey, b);
    return;
  }
  b.count += 1;
  if (b.count > maxRequests) {
    throw new ApiError(429, 'অতিরিক্ত রিকোয়েস্ট পাঠানো হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।', 'RATE_LIMITED');
  }
}

async function verifyBearerUser(req) {
  const authHeader = String(req.headers.authorization || '').trim();
  if (!authHeader.startsWith('Bearer ')) {
    throw new ApiError(401, 'Missing Authorization Bearer token', 'UNAUTHORIZED');
  }
  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    throw new ApiError(401, 'Empty Bearer token', 'UNAUTHORIZED');
  }
  try {
    const decoded = await getAuth().verifyIdToken(idToken, true);
    return decoded;
  } catch (err) {
    if (err.statusCode === 503) throw err;
    throw new ApiError(401, 'Invalid or expired authentication token', 'INVALID_TOKEN');
  }
}

function isMasterEmail(email) {
  return String(email || '').trim().toLowerCase() === MASTER_EMAIL;
}

async function assertMaster(req) {
  const user = await verifyBearerUser(req);
  if (!isMasterEmail(user.email)) {
    throw new ApiError(403, 'শুধুমাত্র Master Administrator এই কাজটি করতে পারবেন।', 'FORBIDDEN_MASTER_ONLY');
  }
  return user;
}

async function assertActiveAdmin(req) {
  const user = await verifyBearerUser(req);
  const db = getDb();
  const [admSnap, userAdminOnSnap] = await Promise.all([
    db.ref(`admins/${user.uid}`).once('value'),
    db.ref('adminSettings/userAdminOn').once('value')
  ]);
  const adm = admSnap.val();
  if (!adm || adm.active === false) {
    throw new ApiError(403, 'আপনার Admin অ্যাকাউন্ট সক্রিয় নয়।', 'FORBIDDEN_ADMIN');
  }
  if (userAdminOnSnap.val() === false && !isMasterEmail(user.email)) {
    throw new ApiError(403, 'Master Administrator কর্তৃক User Admin সাইড বর্তমানে বন্ধ আছে।', 'USER_ADMIN_DISABLED');
  }
  return { user, admin: adm };
}

async function assertActiveAgent(req) {
  const user = await verifyBearerUser(req);
  const db = getDb();
  const agSnap = await db.ref(`agents/${user.uid}`).once('value');
  const agent = agSnap.val();
  if (!agent || agent.active === false || agent.status === 'suspended' || agent.status === 'inactive') {
    throw new ApiError(403, 'আপনার Agent অ্যাকাউন্ট সক্রিয় নয়।', 'FORBIDDEN_AGENT');
  }
  return { user, agent };
}

async function assertActiveAffiliate(req) {
  const user = await verifyBearerUser(req);
  const db = getDb();
  const afSnap = await db.ref(`affiliates/${user.uid}`).once('value');
  const affiliate = afSnap.val();
  if (!affiliate || affiliate.active === false || affiliate.status === 'suspended') {
    throw new ApiError(403, 'আপনার Affiliate অ্যাকাউন্ট সক্রিয় নয়।', 'FORBIDDEN_AFFILIATE');
  }
  return { user, affiliate };
}

// Per-user salted scrypt PIN hashing
function hashPin(pin, uid) {
  const p = String(pin || '').trim();
  if (!/^\d{4,6}$/.test(p)) {
    throw new ApiError(400, '৪ থেকে ৬ সংখ্যার সঠিক পিন দিন।', 'INVALID_PIN_FORMAT');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const serverPepper = process.env.BACKEND_API_SECRET || 'mw88_pin_pepper';
  const derived = crypto.scryptSync(`${p}:${uid}:${serverPepper}`, salt, 32).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPinHash(pin, uid, storedHash) {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.startsWith('scrypt$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [, salt, hexDigest] = parts;
  const serverPepper = process.env.BACKEND_API_SECRET || 'mw88_pin_pepper';
  const derived = crypto.scryptSync(`${String(pin)}:${uid}:${serverPepper}`, salt, 32);
  const expected = Buffer.from(hexDigest, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

async function verifyOrInitWithdrawPin(uid, inputPin) {
  const p = String(inputPin || '').trim();
  if (!/^\d{4,6}$/.test(p)) {
    throw new ApiError(400, '৪-৬ সংখ্যার Withdrawal PIN দিন।', 'INVALID_PIN');
  }
  const db = getDb();
  const [secSnap, legacySnap] = await Promise.all([
    db.ref(`userSecuritySecrets/${uid}/withdrawPinHash`).once('value'),
    db.ref(`users/${uid}/withdrawPin`).once('value')
  ]);
  const secHash = secSnap.val();
  const legacyPin = legacySnap.val();

  if (secHash) {
    if (!verifyPinHash(p, uid, secHash)) {
      throw new ApiError(403, 'ভুল Withdrawal PIN দেওয়া হয়েছে।', 'WRONG_PIN');
    }
    return { verified: true, initialized: false };
  }

  if (legacyPin && typeof legacyPin === 'string') {
    if (legacyPin !== p) {
      throw new ApiError(403, 'ভুল Withdrawal PIN দেওয়া হয়েছে।', 'WRONG_PIN');
    }
    const hashed = hashPin(p, uid);
    await db.ref().update({
      [`userSecuritySecrets/${uid}/withdrawPinHash`]: hashed,
      [`userSecuritySecrets/${uid}/updatedAt`]: getServerTimestamp(),
      [`users/${uid}/hasWithdrawPin`]: true,
      [`users/${uid}/withdrawPin`]: null
    });
    return { verified: true, initialized: false, migrated: true };
  }

  const hashed = hashPin(p, uid);
  await db.ref().update({
    [`userSecuritySecrets/${uid}/withdrawPinHash`]: hashed,
    [`userSecuritySecrets/${uid}/updatedAt`]: getServerTimestamp(),
    [`users/${uid}/hasWithdrawPin`]: true,
    [`users/${uid}/withdrawPin`]: null
  });
  return { verified: true, initialized: true };
}

async function acquireLock(lockPath, ownerUid) {
  const db = getDb();
  const ref = db.ref(lockPath);
  const pre = await ref.once('value');
  if (pre.val() !== null) {
    throw new ApiError(409, 'এই রিকোয়েস্টটি ইতিমধ্যে প্রক্রিয়াধীন বা সম্পন্ন হয়েছে।', 'LOCK_CONFLICT');
  }
  const tx = await ref.transaction(cur => (cur === null ? ownerUid : undefined));
  if (!tx.committed) {
    throw new ApiError(409, 'এই রিকোয়েস্টটি ইতিমধ্যে প্রক্রিয়াধীন বা সম্পন্ন হয়েছে।', 'LOCK_CONFLICT');
  }
  return ref;
}

async function releaseLock(lockPath) {
  const db = getDb();
  await db.ref(lockPath).remove().catch(() => {});
}

async function writeBalanceLedger(entry) {
  const db = getDb();
  await db.ref('balanceLedger').push({
    ...entry,
    time: getServerTimestamp()
  });
}

async function writeAuditLog(admin, action, target, details, ip = '') {
  const db = getDb();
  await db.ref('adminAuditLogs').push({
    admin: String(admin || 'SYSTEM'),
    action: String(action || 'ACTION'),
    target: String(target || ''),
    details: String(details || ''),
    ip: String(ip || ''),
    timestamp: Date.now()
  }).catch(() => {});
}

async function pushNotification(payload) {
  const db = getDb();
  await db.ref('notifications').push({
    ...payload,
    timestamp: getServerTimestamp()
  }).catch(() => {});
}

module.exports = {
  ApiError,
  MASTER_EMAIL,
  getClientIp,
  applySecurityHeaders,
  sendJson,
  readRawAndJsonBody,
  readJsonBody,
  checkRateLimit,
  verifyBearerUser,
  isMasterEmail,
  assertMaster,
  assertActiveAdmin,
  assertActiveAgent,
  assertActiveAffiliate,
  hashPin,
  verifyPinHash,
  verifyOrInitWithdrawPin,
  acquireLock,
  releaseLock,
  writeBalanceLedger,
  writeAuditLog,
  pushNotification
};
