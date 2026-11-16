'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createAppServer, resolveSafeFile } = require('../server');
const security = require('../securityEngine');
const balance = require('../balanceEngine');

function httpRequest(port, method, reqPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          ...headers,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        }
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('Private files & directories are strictly blocked from static HTTP access', () => {
  const blocked = [
    '/.env',
    '/.env.example',
    '/backend/.env',
    '/backend/.env.example',
    '/backend/.gitignore',
    '/serviceAccountKey.json',
    '/mostwin88-febbf-firebase-adminsdk-1234.json',
    '/server.js',
    '/backend/server.js',
    '/package.json',
    '/backend/package.json',
    '/render.yaml',
    '/backend/render.yaml',
    '/database.rules.json',
    '/backend/database.rules.json',
    '/backend/firebaseAdmin.js',
    '/backend/securityEngine.js',
    '/backend/balanceEngine.js',
    '/backend/routes.js',
    '/../etc/passwd'
  ];
  for (const p of blocked) {
    assert.equal(resolveSafeFile(p), null, `Expected ${p} to be blocked`);
  }

  const allowed = ['/user.html', '/index.html', '/master.html', '/agent.html', '/affiliate.html', '/firebase-config.js', '/icon-192.png'];
  for (const p of allowed) {
    assert.ok(resolveSafeFile(p), `Expected ${p} to be publicly served`);
  }
});

test('scrypt PIN hashing and timing-safe verification work accurately', () => {
  const hash = security.hashPin('4829', 'user_abc');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(security.verifyPinHash('4829', 'user_abc', hash), true);
  assert.equal(security.verifyPinHash('9999', 'user_abc', hash), false);
  assert.equal(security.verifyPinHash('4829', 'other_uid', hash), false);
  assert.throws(() => security.hashPin('12', 'user_abc'));
});

test('Server-side tiered deposit bonus and turnover computation is deterministic', () => {
  const res = balance.calculateDepositBonusAndTurnover(1000, '', {
    depositBonusEnabled: true,
    depositBonusPercent: 5,
    turnoverMultiplier: 2,
    minDepositForBonus: 200,
    maxBonusAmount: 500,
    turnoverBase: 'deposit_plus_bonus',
    depositBonusTiers: [
      { minDeposit: 300, bonusPercent: 5, turnoverMultiplier: 1 },
      { minDeposit: 1000, bonusPercent: 10, turnoverMultiplier: 3 }
    ]
  });
  assert.deepEqual(res, {
    bonusPct: 10,
    mult: 3,
    bonusAmt: 100,
    turnoverAdded: 3300
  });
});

test('Rate limiter blocks excessive calls cleanly', () => {
  const key = 'test_rate_' + Date.now();
  security.checkRateLimit(key, 2, 10000);
  security.checkRateLimit(key, 2, 10000);
  assert.throws(() => security.checkRateLimit(key, 2, 10000), /RATE_LIMITED|অতিরিক্ত রিকোয়েস্ট/);
});

test('Live HTTP server serves health/public files and blocks private files + unauthenticated financial APIs', async () => {
  const server = createAppServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const h = await httpRequest(port, 'GET', '/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);

    const priv1 = await httpRequest(port, 'GET', '/backend/balanceEngine.js');
    assert.equal(priv1.status, 404);

    const priv2 = await httpRequest(port, 'GET', '/.env');
    assert.equal(priv2.status, 404);

    const priv3 = await httpRequest(port, 'GET', '/serviceAccountKey.json');
    assert.equal(priv3.status, 404);

    const priv4 = await httpRequest(port, 'GET', '/database.rules.json');
    assert.equal(priv4.status, 404);

    const pub = await httpRequest(port, 'GET', '/firebase-config.js');
    assert.equal(pub.status, 200);
    assert.ok(pub.text.includes('window.mwApi'));

    const unauth = await httpRequest(port, 'POST', '/api/v1/user/withdraw', { amount: 500 });
    assert.ok(unauth.status === 401 || unauth.status === 503);
    assert.equal(unauth.json.ok, false);

    const unauthMaster = await httpRequest(port, 'POST', '/api/v1/master/set-balance', { balance: 999999 });
    assert.ok(unauthMaster.status === 401 || unauthMaster.status === 503);
    assert.equal(unauthMaster.json.ok, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
