const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');

/* ==================== IN-MEMORY RTDB SIMULATOR ==================== */
function clone(v) {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

function createMockRtdb(initialData = {}) {
  const store = clone(initialData) || {};
  let autoSeq = 1;

  function splitPath(p) {
    return String(p || '')
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean);
  }

  function getAt(p) {
    const parts = splitPath(p);
    let cur = store;
    for (const seg of parts) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[seg];
    }
    return cur === undefined ? null : clone(cur);
  }

  function setAt(p, val) {
    const parts = splitPath(p);
    if (!parts.length) {
      for (const k of Object.keys(store)) delete store[k];
      if (val && typeof val === 'object') Object.assign(store, clone(val));
      return;
    }
    let cur = store;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    const last = parts[parts.length - 1];
    if (val === null || val === undefined) {
      delete cur[last];
    } else {
      cur[last] = clone(val);
    }
  }

  function updateAt(p, patch) {
    if (!patch || typeof patch !== 'object') return;
    const base = splitPath(p);
    for (const [relKey, v] of Object.entries(patch)) {
      const fullParts = base.concat(splitPath(relKey));
      setAt(fullParts.join('/'), v);
    }
  }

  function makeSnap(val, key = null) {
    return {
      key,
      val: () => clone(val),
      exists: () => val !== null && val !== undefined
    };
  }

  function ref(p = '') {
    const clean = splitPath(p).join('/');
    const key = clean ? clean.split('/').pop() : null;
    const api = {
      key,
      once: async () => makeSnap(getAt(clean), key),
      set: async (val) => {
        setAt(clean, val);
      },
      update: async (patch) => {
        updateAt(clean, patch);
      },
      remove: async () => {
        setAt(clean, null);
      },
      push: (val) => {
        const pushKey = `-mock_${autoSeq++}_${Date.now().toString(36)}`;
        const childPath = clean ? `${clean}/${pushKey}` : pushKey;
        const p = val !== undefined ? Promise.resolve(setAt(childPath, val)) : Promise.resolve();
        const childRef = Object.assign(p, ref(childPath), { key: pushKey });
        return childRef;
      },
      transaction: async (updater) => {
        // Simulate Firebase RTDB speculative null pass followed by real value pass
        const speculative = updater(null);
        const current = getAt(clean);
        const nextVal = current === null ? speculative : updater(clone(current));
        if (nextVal === undefined) {
          return { committed: false, snapshot: makeSnap(current, key) };
        }
        setAt(clean, nextVal);
        return { committed: true, snapshot: makeSnap(nextVal, key) };
      }
    };
    return api;
  }

  return { ref, _raw: store, getAt };
}

/* ==================== MOCK MODULES FOR OFFLINE TESTS ==================== */
let activeMockDb = createMockRtdb();

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') {
    return {
      apps: [{ name: '[DEFAULT]' }],
      database: Object.assign(() => activeMockDb, { ServerValue: { TIMESTAMP: Date.now() } }),
      auth: () => ({ verifyIdToken: async () => ({ uid: 'mock' }) })
    };
  }
  return originalLoad.apply(this, arguments);
};

// Prime firebaseAdmin cache with our controlled mock DB wrapper
const faPath = path.resolve(__dirname, '../firebaseAdmin.js');
require.cache[faPath] = {
  id: faPath,
  filename: faPath,
  loaded: true,
  exports: {
    isReady: () => true,
    getStatus: () => ({ configured: true }),
    getDb: () => activeMockDb,
    getAuth: () => ({}),
    getServerTimestamp: () => Date.now(),
    MASTER_EMAIL: 'mijanbabu2015@gmail.com'
  }
};

const {
  masterAggregatorSave,
  masterAggregatorTest,
  masterAggregatorSyncGames,
  aggregatorCallbackHttp,
  masterAggregatorSimulateWebhook,
  userLaunchGameProxy,
  masterTransferAdmin,
  userRequestWithdrawal
} = require('../balanceEngine');
const { ApiError } = require('../securityEngine');

const MASTER_ACTOR = { uid: 'master_1', email: 'mijanbabu2015@gmail.com' };
const PLAYER_UID = 'player_abc';
const ADMIN_UID = 'admin_1';

function seedBaseState() {
  activeMockDb = createMockRtdb({
    master: { balance: 100000 },
    admins: {
      [ADMIN_UID]: { name: 'User Admin', balance: 5000, active: true }
    },
    users: {
      [PLAYER_UID]: {
        uid: PLAYER_UID,
        name: 'Rafiq Player',
        username: 'rafiq88',
        adminUid: ADMIN_UID,
        balance: 1000,
        bonusBalance: 200,
        turnoverRequired: 1500,
        turnoverDone: 0,
        turnoverCompleted: 0,
        betCount: 0,
        xp: 0,
        status: 'Active'
      }
    },
    promoTurnover: {
      [PLAYER_UID]: {
        promo_welcome: {
          promoId: 'promo_welcome',
          required: 1500,
          completedAmount: 0,
          progress: 0,
          completed: false
        }
      }
    },
    game_sessions: {
      sess_rtdb_1: {
        uid: PLAYER_UID,
        gameName: 'Aviator',
        provider: 'Spribe',
        status: 'ACTIVE',
        entryBalance: 1200,
        exitBalance: 1200,
        betCount: 0,
        betAmt: 0,
        winAmt: 0
      }
    }
  });
}

test('masterAggregatorSave separates secrets from public config and preserves masked secrets', async () => {
  seedBaseState();
  const saved = await masterAggregatorSave(MASTER_ACTOR, {
    enabled: true,
    providerName: 'PlayNexus',
    walletMode: 'seamless',
    mode: 'rest_post',
    openMode: 'iframe',
    launchUrl: 'https://agg.example.com/api/launch',
    gameListUrl: 'https://agg.example.com/api/games',
    callbackUrl: 'https://api.mostwin.example/api/v1/aggregator/callback',
    operatorCode: 'OP88',
    agentId: 'AG01',
    apiKey: 'secret_key_123',
    apiSecret: 'secret_hmac_999',
    webhookSecret: 'wh_secret_777',
    authMethod: 'hmac_sha256',
    signHeader: 'X-Sign',
    currency: 'BDT',
    lang: 'bn',
    whitelistIps: '127.0.0.1, 10.0.0.5'
  });

  assert.equal(saved.config.apiKey, 'secret_key_123');
  assert.equal(saved.config.webhookSecret, 'wh_secret_777');

  const pub = activeMockDb.getAt('userPanelConfig/global/gameApi');
  assert.equal(pub.enabled, true);
  assert.equal(pub.providerName, 'PlayNexus');
  assert.equal(pub.apiKey, undefined, 'apiKey must NOT leak into public userPanelConfig');
  assert.equal(pub.apiSecret, undefined, 'apiSecret must NOT leak into public userPanelConfig');
  assert.equal(pub.webhookSecret, undefined, 'webhookSecret must NOT leak into public userPanelConfig');

  // Re-save with masked placeholders
  const resaved = await masterAggregatorSave(MASTER_ACTOR, {
    enabled: true,
    apiKey: '••••••••',
    apiSecret: '••••',
    webhookSecret: '__KEEP__'
  });
  assert.equal(resaved.config.apiKey, 'secret_key_123');
  assert.equal(resaved.config.apiSecret, 'secret_hmac_999');
  assert.equal(resaved.config.webhookSecret, 'wh_secret_777');
});

test('masterAggregatorSyncGames imports games into providers, provider_games, and popular games nodes', async () => {
  seedBaseState();
  const res = await masterAggregatorSyncGames(MASTER_ACTOR, {
    alsoAddPopular: false,
    gamesJson: JSON.stringify([
      {
        name: 'Aviator',
        gameCode: 'spribe_aviator',
        provider: 'Spribe',
        providerCode: 'spribe',
        category: 'crash',
        image: 'https://cdn.example.com/aviator.jpg',
        popular: true
      },
      {
        name: 'Super Ace',
        gameCode: 'jili_super_ace',
        provider: 'JILI',
        providerCode: 'jili',
        category: 'slots',
        thumbnail: 'https://cdn.example.com/superace.jpg'
      }
    ])
  });

  assert.equal(res.providersCount, 2);
  assert.equal(res.gamesCount, 2);
  assert.equal(res.popularCount, 1);

  const spribeGames = activeMockDb.getAt('provider_games/spribe_crash_arcade');
  assert.ok(spribeGames, 'Spribe provider_games node should exist');
  const firstSpribe = Object.values(spribeGames)[0];
  assert.equal(firstSpribe.gameCode, 'spribe_aviator');
  assert.equal(firstSpribe.providerApi, 'spribe');
  assert.equal(firstSpribe.source, 'aggregator');

  const popGames = activeMockDb.getAt('games');
  assert.equal(Object.keys(popGames).length, 1);
  assert.equal(Object.values(popGames)[0].name, 'Aviator');
});

test('masterAggregatorTest and userLaunchGameProxy build authenticated calls & create aggregatorSessions', async () => {
  seedBaseState();
  await masterAggregatorSave(MASTER_ACTOR, {
    enabled: true,
    providerName: 'PlayNexus',
    mode: 'rest_post',
    openMode: 'iframe',
    launchUrl: 'https://agg.example.com/launch',
    gameListUrl: 'https://agg.example.com/list',
    operatorCode: 'OP88',
    apiKey: 'key_abc',
    apiSecret: 'sec_xyz',
    authMethod: 'hmac_sha256'
  });

  const origFetch = global.fetch;
  let capturedFetch = null;
  global.fetch = async (url, opts) => {
    capturedFetch = { url, opts };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { url: 'https://play.example.com/table/aviator?s=1' } }),
      json: async () => ({ data: { url: 'https://play.example.com/table/aviator?s=1' } })
    };
  };

  try {
    const testOut = await masterAggregatorTest(MASTER_ACTOR, { testType: 'launch', gameCode: 'spribe_aviator' });
    assert.equal(testOut.httpStatus, 200);
    assert.equal(testOut.extractedLaunchUrl, 'https://play.example.com/table/aviator?s=1');
    assert.ok(capturedFetch.opts.headers['X-Sign'], 'HMAC signature header should be sent');

    const launchOut = await userLaunchGameProxy(
      { uid: PLAYER_UID, email: 'rafiq@example.com' },
      { gameCode: 'spribe_aviator', provider: 'Spribe', gameName: 'Aviator', returnUrl: 'https://mostwin.app/user.html', gameSessionId: 'sess_rtdb_1' }
    );
    assert.equal(launchOut.gameUrl, 'https://play.example.com/table/aviator?s=1');
    assert.ok(launchOut.sessionToken.startsWith('mw_'));

    const aggSess = activeMockDb.getAt(`aggregatorSessions/${launchOut.sessionToken}`);
    assert.equal(aggSess.uid, PLAYER_UID);
    assert.equal(aggSess.gameCode, 'spribe_aviator');
    assert.equal(aggSess.gameSessionId, 'sess_rtdb_1');
  } finally {
    global.fetch = origFetch;
  }
});

test('Seamless Wallet callbacks verify signature/IP, debit main+bonus wallet, update turnover & sessions, handle idempotency & rollback, and unlock withdrawal', async () => {
  seedBaseState();
  await masterAggregatorSave(MASTER_ACTOR, {
    enabled: true,
    providerName: 'PlayNexus',
    launchUrl: 'https://agg.example.com/launch',
    webhookSecret: 'wh_top_secret_99',
    whitelistIps: '203.0.113.10'
  });

  // Link session token
  await activeMockDb.ref('aggregatorSessions/tok_live_1').set({
    sessionToken: 'tok_live_1',
    uid: PLAYER_UID,
    adminUid: ADMIN_UID,
    provider: 'Spribe',
    gameCode: 'spribe_aviator',
    gameName: 'Aviator',
    currency: 'BDT',
    gameSessionId: 'sess_rtdb_1'
  });

  // 1. Blocked non-whitelisted IP
  await assert.rejects(
    () => aggregatorCallbackHttp({ headers: { 'x-webhook-secret': 'wh_top_secret_99' } }, 'balance', '{}', { sessionToken: 'tok_live_1' }, '198.51.100.7'),
    (e) => e instanceof ApiError && e.statusCode === 403 && e.code === 'IP_NOT_WHITELISTED'
  );

  // 2. Blocked invalid signature
  await assert.rejects(
    () => aggregatorCallbackHttp({ headers: { 'x-sign': 'bad_sig' } }, 'balance', '{}', { sessionToken: 'tok_live_1' }, '203.0.113.10'),
    (e) => e instanceof ApiError && e.statusCode === 401
  );

  // 3. Withdrawal BEFORE turnover met must fail with TURNOVER_INCOMPLETE
  await activeMockDb.ref(`users/${PLAYER_UID}/hasWithdrawPin`).set(false);
  await assert.rejects(
    () => userRequestWithdrawal({ uid: PLAYER_UID }, { method: 'bKash', accountNumber: '01711111111', amount: 600, pin: '1234' }),
    (e) => e.code === 'TURNOVER_INCOMPLETE'
  );

  // 4. Valid HMAC balance check
  const balBody = { action: 'balance', sessionToken: 'tok_live_1' };
  const balRaw = JSON.stringify(balBody);
  const balHmac = crypto.createHmac('sha256', 'wh_top_secret_99').update(balRaw).digest('hex');
  const balRes = await aggregatorCallbackHttp({ headers: { 'x-sign': balHmac } }, 'balance', balRaw, balBody, '203.0.113.10');
  assert.equal(balRes.balance, 1200); // 1000 main + 200 bonus

  // 5. Bet 1100 (debits 1000 main -> 0, and 100 bonus -> 100) using X-Webhook-Secret
  const bet1Res = await aggregatorCallbackHttp(
    { headers: { 'x-webhook-secret': 'wh_top_secret_99' } },
    'bet',
    '{}',
    { sessionToken: 'tok_live_1', trxId: 'TRX_BET_1', betAmount: 1100 },
    '203.0.113.10'
  );
  assert.equal(bet1Res.balance, 100);
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/balance`), 0);
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/bonusBalance`), 100);
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/turnoverDone`), 1100);
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/turnoverCompleted`), 1100);
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/betCount`), 1);
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/xp`), 110);

  // 6. Idempotent replay of TRX_BET_1 must NOT double-charge or double turnover
  const replayRes = await aggregatorCallbackHttp(
    { headers: { 'x-webhook-secret': 'wh_top_secret_99' } },
    'bet',
    '{}',
    { sessionToken: 'tok_live_1', trxId: 'TRX_BET_1', betAmount: 1100 },
    '203.0.113.10'
  );
  assert.equal(replayRes.idempotent, true);
  assert.equal(replayRes.balance, 100);
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/turnoverDone`), 1100);

  // 7. Win 1100 on separate trxId
  const winRes = await aggregatorCallbackHttp(
    { headers: { 'x-webhook-secret': 'wh_top_secret_99' } },
    'win',
    '{}',
    { sessionToken: 'tok_live_1', trxId: 'TRX_WIN_1', winAmount: 1100 },
    '203.0.113.10'
  );
  assert.equal(winRes.balance, 1200); // 1100 main + 100 bonus

  // 8. bet_win spin: bet 500, win 200 -> finishes turnoverRequired (1100 + 500 = 1600 >= 1500)
  const bwRes = await aggregatorCallbackHttp(
    { headers: { 'x-webhook-secret': 'wh_top_secret_99' } },
    'bet_win',
    '{}',
    { sessionToken: 'tok_live_1', trxId: 'TRX_BW_1', betAmount: 500, winAmount: 200 },
    '203.0.113.10'
  );
  assert.equal(bwRes.balance, 900); // main 1100 - 500 + 200 = 800, bonus 100 => 900
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/turnoverDone`), 1600);
  assert.equal(activeMockDb.getAt(`promoTurnover/${PLAYER_UID}/promo_welcome/completed`), true);

  // Check game_sessions updated accurately
  const gs = activeMockDb.getAt('game_sessions/sess_rtdb_1');
  assert.equal(gs.betCount, 2);
  assert.equal(gs.betAmt, 1600);
  assert.equal(gs.winAmt, 1300);
  assert.equal(gs.exitBalance, 900);

  // Check game_transactions created
  const gtx = Object.values(activeMockDb.getAt('game_transactions') || {});
  assert.ok(gtx.some(t => t.type === 'game_bet' && t.bet === 1100));
  assert.ok(gtx.some(t => t.type === 'game_win' && t.win === 1100));

  // 9. Rollback TRX_BW_1 and verify exact refund + turnover reversal
  const rbRes = await aggregatorCallbackHttp(
    { headers: { 'x-webhook-secret': 'wh_top_secret_99' } },
    'rollback',
    '{}',
    { sessionToken: 'tok_live_1', trxId: 'TRX_RB_1', refTrxId: 'TRX_BW_1' },
    '203.0.113.10'
  );
  assert.equal(rbRes.balance, 1200);
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/turnoverDone`), 1100);

  // 10. Simulate bet_win 400 dryRun:true does NOT mutate DB
  const simRes = await masterAggregatorSimulateWebhook(MASTER_ACTOR, {
    action: 'bet_win',
    uid: PLAYER_UID,
    betAmount: 400,
    winAmount: 100,
    dryRun: true
  });
  assert.equal(simRes.beforeBalance, 1200);
  assert.equal(simRes.afterBalance, 900);
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/turnoverDone`), 1100);

  // 11. Real bet 400 completes turnover (1100 + 400 = 1500), unlocking withdrawal!
  await aggregatorCallbackHttp(
    { headers: { 'x-webhook-secret': 'wh_top_secret_99' } },
    'bet',
    '{}',
    { sessionToken: 'tok_live_1', trxId: 'TRX_BET_FINAL', betAmount: 400 },
    '203.0.113.10'
  );
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/turnoverDone`), 1500);

  // Balance is now 800 total (700 main, 100 bonus); withdraw 500 from main balance succeeds!
  const wdRes = await userRequestWithdrawal(
    { uid: PLAYER_UID },
    { method: 'bKash', accountNumber: '01711111111', amount: 500, pin: '1234' }
  );
  assert.equal(wdRes.request.status, 'Pending');
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/balance`), 200);
});

test('routes.js dispatches /api/v1/aggregator/callback and /api/v1/health properly', async () => {
  seedBaseState();
  await masterAggregatorSave(MASTER_ACTOR, {
    enabled: true,
    providerName: 'PlayNexus',
    launchUrl: 'https://agg.example.com/launch',
    webhookSecret: 'wh_route_secret'
  });

  const { Readable } = require('node:stream');
  const { handleApiRequest } = require('../routes');

  function makeReqRes(method, url, headers = {}, bodyStr = '') {
    const req = Readable.from(bodyStr ? [Buffer.from(bodyStr, 'utf8')] : []);
    req.method = method;
    req.url = url;
    req.headers = Object.assign({ host: 'localhost' }, headers);
    req.socket = { remoteAddress: '127.0.0.1' };
    let statusCode = 0;
    let outBody = '';
    const outHeaders = {};
    const res = {
      setHeader(k, v) { outHeaders[k] = v; },
      writeHead(code, hdrs) {
        statusCode = code;
        if (hdrs) Object.assign(outHeaders, hdrs);
      },
      end(chunk) {
        if (chunk) outBody += chunk.toString();
      }
    };
    return { req, res, getResult: () => ({ statusCode, headers: outHeaders, json: JSON.parse(outBody || '{}') }) };
  }

  // Health endpoint
  const h = makeReqRes('GET', '/api/health');
  assert.equal(await handleApiRequest(h.req, h.res, '/api/health'), true);
  assert.equal(h.getResult().statusCode, 200);
  assert.equal(h.getResult().json.ok, true);

  // Seamless wallet callback over POST /api/v1/aggregator/callback
  const cbPayload = JSON.stringify({ action: 'bet', uid: PLAYER_UID, amount: 100, trxId: 'ROUTE_TRX_1' });
  const sig = crypto.createHmac('sha256', 'wh_route_secret').update(cbPayload).digest('hex');
  const cb = makeReqRes('POST', '/api/v1/aggregator/callback', { 'x-sign': sig }, cbPayload);
  assert.equal(await handleApiRequest(cb.req, cb.res, '/api/v1/aggregator/callback'), true);
  const cbJson = cb.getResult().json;
  assert.equal(cb.getResult().statusCode, 200);
  assert.equal(cbJson.ok, true);
  assert.equal(cbJson.balance, 1100);
  assert.equal(activeMockDb.getAt(`users/${PLAYER_UID}/turnoverDone`), 100);
});

test('Regression: masterTransferAdmin succeeds even when RTDB master/balance is formatted string', async () => {
  seedBaseState();
  await activeMockDb.ref('master/balance').set('45,000');

  const out = await masterTransferAdmin(MASTER_ACTOR, {
    adminUid: ADMIN_UID,
    amount: 10000,
    note: 'String balance test'
  });
  assert.equal(out.masterBalance, 35000);
  assert.equal(out.adminBalance, 15000);
});
