'use strict';

const crypto = require('crypto');
const { getDb, getServerTimestamp } = require('./firebaseAdmin');
const {
  ApiError,
  acquireLock,
  releaseLock,
  writeAuditLog
} = require('./securityEngine');

const MAX_LOG_STR = 500;

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(toNum(n, 0) * 100) / 100;
}

function slugify(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'custom';
}

function safeEqualStr(a, b) {
  const s1 = String(a || '');
  const s2 = String(b || '');
  if (!s1 || !s2) return false;
  const b1 = Buffer.from(s1, 'utf8');
  const b2 = Buffer.from(s2, 'utf8');
  if (b1.length !== b2.length) return false;
  return crypto.timingSafeEqual(b1, b2);
}

async function txIncrement(path, delta) {
  const db = getDb();
  const ref = db.ref(path);
  const keepAlive = () => {};
  if (typeof ref.on === 'function') ref.on('value', keepAlive);

  try {
    const preSnap = await ref.once('value');
    const preExists = preSnap.exists();
    const preVal = preExists ? toNum(preSnap.val(), 0) : 0;

    let beforeVal = preVal;
    let afterVal = preVal;
    let sawServerValue = false;

    const result = await ref.transaction(cur => {
      const isSpeculativeNull = cur === null && !sawServerValue && preExists;
      const base = isSpeculativeNull ? preVal : toNum(cur, 0);
      sawServerValue = true;
      const next = round2(base + delta);
      if (next < 0) return undefined;
      beforeVal = base;
      afterVal = next;
      return next;
    });

    if (!result.committed) {
      return { committed: false, before: beforeVal, after: beforeVal };
    }
    const snapVal = result.snapshot ? result.snapshot.val() : afterVal;
    return {
      committed: true,
      before: beforeVal,
      after: snapVal !== null && snapVal !== undefined ? toNum(snapVal, afterVal) : afterVal
    };
  } finally {
    if (typeof ref.off === 'function') ref.off('value', keepAlive);
  }
}

async function writeAggLog(entry) {
  try {
    const db = getDb();
    await db.ref('aggregatorLogs').push({
      type: String(entry.type || 'EVENT'),
      status: String(entry.status || 'INFO'),
      httpStatus: Number(entry.httpStatus || 200),
      uid: String(entry.uid || ''),
      trxId: String(entry.trxId || ''),
      gameCode: String(entry.gameCode || ''),
      provider: String(entry.provider || ''),
      amount: entry.amount !== undefined ? toNum(entry.amount, 0) : null,
      latencyMs: entry.latencyMs !== undefined ? Number(entry.latencyMs) : null,
      message: String(entry.message || '').slice(0, MAX_LOG_STR),
      ip: String(entry.ip || ''),
      timestamp: Date.now()
    });
  } catch (_) {}
}

function normalizeConfig(rawSecretCfg, rawPublicCfg) {
  const s = rawSecretCfg && typeof rawSecretCfg === 'object' ? rawSecretCfg : {};
  const p = rawPublicCfg && typeof rawPublicCfg === 'object' ? rawPublicCfg : {};
  const pick = (k, def = '') => {
    if (s[k] !== undefined && s[k] !== null && s[k] !== '') return s[k];
    if (p[k] !== undefined && p[k] !== null && p[k] !== '') return p[k];
    return def;
  };
  return {
    enabled: s.enabled !== undefined ? !!s.enabled : !!p.enabled,
    providerName: String(pick('providerName', 'Custom Game Aggregator')).trim(),
    walletMode: String(pick('walletMode', 'seamless')).trim() || 'seamless',
    mode: String(pick('mode', 'rest_post')).trim() || 'rest_post',
    openMode: String(pick('openMode', 'iframe')).trim() || 'iframe',
    baseUrl: String(pick('baseUrl', '')).trim(),
    launchUrl: String(pick('launchUrl', '')).trim(),
    gameListUrl: String(pick('gameListUrl', '')).trim(),
    callbackUrl: String(pick('callbackUrl', '')).trim(),
    operatorCode: String(pick('operatorCode', '')).trim(),
    agentId: String(pick('agentId', '')).trim(),
    apiKey: String(pick('apiKey', '')).trim(),
    apiSecret: String(pick('apiSecret', '')).trim(),
    webhookSecret: String(pick('webhookSecret', '')).trim(),
    authMethod: String(pick('authMethod', 'bearer_xapikey')).trim() || 'bearer_xapikey',
    signHeader: String(pick('signHeader', 'X-Sign')).trim() || 'X-Sign',
    currency: String(pick('currency', 'BDT')).trim() || 'BDT',
    lang: String(pick('lang', 'bn')).trim() || 'bn',
    whitelistIps: String(pick('whitelistIps', '')).trim(),
    customHeadersJson: String(pick('customHeadersJson', '')).trim(),
    updatedAt: s.updatedAt || p.updatedAt || null
  };
}

async function loadMergedConfig() {
  const db = getDb();
  const [secSnap, pubSnap] = await Promise.all([
    db.ref('gameAggregatorSecrets/config').once('value'),
    db.ref('userPanelConfig/global/gameApi').once('value')
  ]);
  return normalizeConfig(secSnap.val(), pubSnap.val());
}

async function getAggregatorConfig() {
  const cfg = await loadMergedConfig();
  return {
    config: {
      ...cfg,
      hasApiKey: !!cfg.apiKey,
      hasApiSecret: !!cfg.apiSecret,
      hasWebhookSecret: !!cfg.webhookSecret
    }
  };
}

async function saveAggregatorConfig(actor, body, ip) {
  const db = getDb();
  const existing = await loadMergedConfig();

  const resolveSecret = (newVal, clearFlag, oldVal) => {
    if (clearFlag) return '';
    const s = String(newVal === undefined || newVal === null ? '' : newVal).trim();
    if (!s || s === '__KEEP__') return oldVal || '';
    return s;
  };

  let customHeadersJson = String(body.customHeadersJson !== undefined ? body.customHeadersJson : existing.customHeadersJson || '').trim();
  if (customHeadersJson) {
    try {
      const parsed = JSON.parse(customHeadersJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Custom Headers অবশ্যই JSON Object হতে হবে');
      }
      customHeadersJson = JSON.stringify(parsed);
    } catch (err) {
      throw new ApiError(400, 'Custom Headers JSON সঠিক নয়: ' + err.message, 'INVALID_CUSTOM_HEADERS');
    }
  }

  const nextCfg = {
    enabled: body.enabled !== undefined ? !!body.enabled : existing.enabled,
    providerName: String(body.providerName !== undefined ? body.providerName : existing.providerName || 'Custom Game Aggregator').trim().slice(0, 80),
    walletMode: ['seamless', 'transfer', 'direct'].includes(body.walletMode) ? body.walletMode : existing.walletMode,
    mode: ['rest_post', 'rest_get', 'direct_iframe'].includes(body.mode) ? body.mode : existing.mode,
    openMode: ['iframe', 'newtab'].includes(body.openMode) ? body.openMode : existing.openMode,
    baseUrl: String(body.baseUrl !== undefined ? body.baseUrl : existing.baseUrl).trim(),
    launchUrl: String(body.launchUrl !== undefined ? body.launchUrl : existing.launchUrl).trim(),
    gameListUrl: String(body.gameListUrl !== undefined ? body.gameListUrl : existing.gameListUrl).trim(),
    callbackUrl: String(body.callbackUrl !== undefined ? body.callbackUrl : existing.callbackUrl).trim(),
    operatorCode: String(body.operatorCode !== undefined ? body.operatorCode : existing.operatorCode).trim(),
    agentId: String(body.agentId !== undefined ? body.agentId : existing.agentId).trim(),
    apiKey: resolveSecret(body.apiKey, !!body.clearApiKey, existing.apiKey),
    apiSecret: resolveSecret(body.apiSecret, !!body.clearApiSecret, existing.apiSecret),
    webhookSecret: resolveSecret(body.webhookSecret, !!body.clearWebhookSecret, existing.webhookSecret),
    authMethod: ['bearer_xapikey', 'hmac_sha256', 'hmac_sha1', 'md5_sign', 'body_credentials'].includes(body.authMethod)
      ? body.authMethod
      : existing.authMethod,
    signHeader: String(body.signHeader !== undefined ? body.signHeader : existing.signHeader || 'X-Sign').trim().slice(0, 40) || 'X-Sign',
    currency: String(body.currency !== undefined ? body.currency : existing.currency || 'BDT').trim().slice(0, 10) || 'BDT',
    lang: String(body.lang !== undefined ? body.lang : existing.lang || 'bn').trim().slice(0, 10) || 'bn',
    whitelistIps: String(body.whitelistIps !== undefined ? body.whitelistIps : existing.whitelistIps).trim(),
    customHeadersJson,
    updatedAt: Date.now(),
    updatedBy: actor.email || actor.uid
  };

  if (nextCfg.enabled && !nextCfg.launchUrl) {
    throw new ApiError(400, 'Game Aggregator চালু রাখতে Launch Endpoint / URL Template দিন।', 'MISSING_LAUNCH_URL');
  }

  // Public non-secret config exposed to user.html via userPanelConfig
  const publicGameApi = {
    enabled: nextCfg.enabled,
    providerName: nextCfg.providerName,
    walletMode: nextCfg.walletMode,
    mode: nextCfg.mode,
    openMode: nextCfg.openMode,
    currency: nextCfg.currency,
    lang: nextCfg.lang,
    launchUrl: nextCfg.mode === 'direct_iframe' ? nextCfg.launchUrl : '',
    updatedAt: nextCfg.updatedAt
  };

  const updates = {};
  updates['gameAggregatorSecrets/config'] = nextCfg;
  updates['userPanelConfig/global/gameApi'] = publicGameApi;
  await db.ref().update(updates);

  await writeAggLog({
    type: 'CONFIG_SAVE',
    status: 'OK',
    httpStatus: 200,
    message: `Saved ${nextCfg.providerName} (${nextCfg.walletMode}, ${nextCfg.mode}, enabled=${nextCfg.enabled})`,
    ip
  });
  await writeAuditLog(
    actor.email || actor.uid,
    'GAME_AGGREGATOR_CONFIG_SAVE',
    'gameAggregatorSecrets/config',
    `Provider=${nextCfg.providerName}, Mode=${nextCfg.mode}, Wallet=${nextCfg.walletMode}, Enabled=${nextCfg.enabled}`,
    ip
  );

  return { config: nextCfg };
}

function buildOutboundRequest(cfg, targetUrlTpl, params, extraPayload = {}) {
  const sessionToken = params.sessionToken || '';
  const resolvedUrl = String(targetUrlTpl || '')
    .replace(/\{uid\}/g, encodeURIComponent(params.uid || ''))
    .replace(/\{username\}/g, encodeURIComponent(params.username || params.uid || ''))
    .replace(/\{gameCode\}/g, encodeURIComponent(params.gameCode || ''))
    .replace(/\{provider\}/g, encodeURIComponent(params.provider || 'casino'))
    .replace(/\{currency\}/g, encodeURIComponent(cfg.currency || 'BDT'))
    .replace(/\{lang\}/g, encodeURIComponent(cfg.lang || 'bn'))
    .replace(/\{balance\}/g, encodeURIComponent(String(params.balance ?? 0)))
    .replace(/\{operator\}/g, encodeURIComponent(cfg.operatorCode || ''))
    .replace(/\{agentId\}/g, encodeURIComponent(cfg.agentId || ''))
    .replace(/\{apiKey\}/g, encodeURIComponent(cfg.apiKey || ''))
    .replace(/\{sessionToken\}/g, encodeURIComponent(sessionToken))
    .replace(/\{returnUrl\}/g, encodeURIComponent(params.returnUrl || ''))
    .replace(/\{callbackUrl\}/g, encodeURIComponent(cfg.callbackUrl || ''));

  const payloadObj = {
    operatorCode: cfg.operatorCode || '',
    agentId: cfg.agentId || '',
    uid: params.uid || '',
    username: params.username || params.uid || '',
    gameCode: params.gameCode || '',
    provider: params.provider || 'casino',
    gameName: params.gameName || '',
    currency: cfg.currency || 'BDT',
    lang: cfg.lang || 'bn',
    balance: toNum(params.balance, 0),
    sessionToken,
    returnUrl: params.returnUrl || '',
    callbackUrl: cfg.callbackUrl || '',
    timestamp: Math.floor(Date.now() / 1000),
    ...extraPayload
  };

  if (cfg.authMethod === 'body_credentials') {
    payloadObj.apiKey = cfg.apiKey || '';
    if (cfg.apiSecret) payloadObj.apiSecret = cfg.apiSecret;
  }

  const payloadString = JSON.stringify(payloadObj);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };

  if (cfg.apiKey) {
    headers['X-API-Key'] = cfg.apiKey;
    headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  }
  if (cfg.operatorCode) {
    headers['X-Merchant-Id'] = cfg.operatorCode;
  }

  const signHeader = cfg.signHeader || 'X-Sign';
  if (cfg.apiSecret) {
    if (cfg.authMethod === 'hmac_sha256') {
      headers[signHeader] = crypto.createHmac('sha256', cfg.apiSecret).update(payloadString).digest('hex');
    } else if (cfg.authMethod === 'hmac_sha1') {
      headers[signHeader] = crypto.createHmac('sha1', cfg.apiSecret).update(payloadString).digest('hex');
    } else if (cfg.authMethod === 'md5_sign') {
      const md5Sig = crypto.createHash('md5').update(payloadString + cfg.apiSecret).digest('hex');
      headers[signHeader] = md5Sig;
      payloadObj.sign = md5Sig;
    }
  }

  if (cfg.customHeadersJson) {
    try {
      const extraHdrs = JSON.parse(cfg.customHeadersJson);
      Object.entries(extraHdrs).forEach(([k, v]) => {
        if (k && v !== undefined && v !== null) headers[String(k)] = String(v);
      });
    } catch (_) {}
  }

  return { resolvedUrl, headers, payloadObj, payloadString: JSON.stringify(payloadObj) };
}

function extractLaunchUrl(json) {
  if (!json || typeof json !== 'object') return '';
  return String(
    json.gameUrl ||
    json.url ||
    json.launch_url ||
    json.launchUrl ||
    json.game_url ||
    (json.data && (json.data.gameUrl || json.data.url || json.data.launch_url || json.data.launchUrl || json.data.game_url)) ||
    (json.result && (json.result.gameUrl || json.result.url || json.result.launch_url)) ||
    ''
  ).trim();
}

async function testAggregatorConnection(actor, body, ip) {
  const existing = await loadMergedConfig();
  const cfg = normalizeConfig({
    ...existing,
    ...body,
    apiKey: body.apiKey && body.apiKey !== '__KEEP__' ? body.apiKey : existing.apiKey,
    apiSecret: body.apiSecret && body.apiSecret !== '__KEEP__' ? body.apiSecret : existing.apiSecret
  }, {});

  const testType = body.testType === 'gamelist' ? 'gamelist' : 'launch';
  const targetTpl = testType === 'gamelist' ? cfg.gameListUrl : cfg.launchUrl;
  if (!targetTpl) {
    throw new ApiError(400, testType === 'gamelist' ? 'Game List Endpoint URL দিন।' : 'Launch Endpoint / URL Template দিন।', 'MISSING_URL');
  }

  const reqData = buildOutboundRequest(cfg, targetTpl, {
    uid: 'test_player_01',
    username: 'test_player_01',
    gameCode: String(body.gameCode || 'aviator').trim(),
    provider: String(body.provider || 'spribe').trim(),
    gameName: 'Test Connection Game',
    balance: 1000,
    sessionToken: 'test_sess_' + Date.now(),
    returnUrl: String(body.returnUrl || '')
  });

  if (testType === 'launch' && cfg.mode === 'direct_iframe') {
    await writeAggLog({
      type: 'TEST_LAUNCH_TPL',
      status: 'OK',
      httpStatus: 200,
      message: `Direct template resolved: ${reqData.resolvedUrl}`,
      ip
    });
    return {
      ok: true,
      mode: 'direct_iframe',
      httpStatus: 200,
      latencyMs: 0,
      resolvedUrl: reqData.resolvedUrl,
      preview: 'Direct URL template resolved cleanly'
    };
  }

  const startedAt = Date.now();
  const method = testType === 'gamelist' && !body.listMethod ? 'GET' : (cfg.mode === 'rest_get' ? 'GET' : 'POST');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch(reqData.resolvedUrl, {
      method,
      headers: reqData.headers,
      body: method === 'POST' ? reqData.payloadString : undefined,
      signal: controller.signal
    });
    const rawTxt = await resp.text();
    const latencyMs = Date.now() - startedAt;
    let parsedJson = null;
    try { parsedJson = JSON.parse(rawTxt); } catch (_) {}

    const extractedUrl = testType === 'launch' ? extractLaunchUrl(parsedJson) : '';
    const extractedGames = testType === 'gamelist' ? extractGamesArray(parsedJson) : [];

    await writeAggLog({
      type: testType === 'gamelist' ? 'TEST_GAMELIST' : 'TEST_LAUNCH_API',
      status: resp.ok ? 'OK' : 'WARN',
      httpStatus: resp.status,
      latencyMs,
      message: `${method} ${reqData.resolvedUrl} -> HTTP ${resp.status} (${rawTxt.slice(0, 180)})`,
      ip
    });

    return {
      httpStatus: resp.status,
      apiOk: resp.ok,
      latencyMs,
      resolvedUrl: reqData.resolvedUrl,
      extractedLaunchUrl: extractedUrl,
      extractedGamesCount: extractedGames.length,
      preview: rawTxt.slice(0, 450)
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    await writeAggLog({
      type: 'TEST_ERROR',
      status: 'ERROR',
      httpStatus: 502,
      latencyMs,
      message: err.message || 'Aggregator connection failed',
      ip
    });
    throw new ApiError(502, 'অ্যাগ্রিগেটর সার্ভারে সংযোগ ব্যর্থ: ' + (err.message || err), 'AGGREGATOR_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }
}

function extractGamesArray(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (typeof json !== 'object') return [];
  const candidates = [
    json.games,
    json.list,
    json.data && json.data.games,
    json.data && json.data.list,
    json.data,
    json.result && json.result.games,
    json.result,
    json.items
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function mapCategory(rawCat) {
  const c = String(rawCat || '').toLowerCase();
  if (c.includes('live') || c.includes('dealer') || c.includes('casino')) return 'Live Casino';
  if (c.includes('crash') || c.includes('arcade') || c.includes('aviator') || c.includes('instant')) return 'Crash & Arcade';
  if (c.includes('fish')) return 'Fishing';
  if (c.includes('sport')) return 'Sports';
  if (c.includes('table') || c.includes('card') || c.includes('poker') || c.includes('roulette')) return 'Table Games';
  return 'Slots';
}

async function syncAggregatorGames(actor, body, ip) {
  const db = getDb();
  const cfg = await loadMergedConfig();
  let rawGames = [];

  if (body.gamesJson) {
    let parsed;
    try {
      parsed = typeof body.gamesJson === 'string' ? JSON.parse(body.gamesJson) : body.gamesJson;
    } catch (err) {
      throw new ApiError(400, 'গেম JSON সঠিক ফরম্যাটে নেই: ' + err.message, 'INVALID_GAMES_JSON');
    }
    rawGames = extractGamesArray(parsed);
  } else {
    const listUrl = String(body.gameListUrl || cfg.gameListUrl || '').trim();
    if (!listUrl) {
      throw new ApiError(400, 'Game List Endpoint URL দিন অথবা Bulk JSON পেস্ট করুন।', 'MISSING_GAMELIST_URL');
    }
    const reqData = buildOutboundRequest(cfg, listUrl, {
      uid: actor.uid,
      username: 'master',
      gameCode: '',
      provider: String(body.providerFilter || '').trim(),
      balance: 0
    });
    const method = body.listMethod === 'POST' ? 'POST' : 'GET';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let json = null;
    try {
      const resp = await fetch(reqData.resolvedUrl, {
        method,
        headers: reqData.headers,
        body: method === 'POST' ? reqData.payloadString : undefined,
        signal: controller.signal
      });
      json = await resp.json().catch(() => null);
      if (!resp.ok || !json) {
        throw new ApiError(502, `Game List API HTTP ${resp.status} ফেরত দিয়েছে।`, 'GAMELIST_HTTP_ERROR');
      }
    } finally {
      clearTimeout(timer);
    }
    rawGames = extractGamesArray(json);
  }

  if (!rawGames.length) {
    throw new ApiError(400, 'কোনো গেম পাওয়া যায়নি (Empty game list)।', 'EMPTY_GAME_LIST');
  }

  const defaultCategory = body.defaultCategory ? String(body.defaultCategory).trim() : '';
  const alsoPopular = !!body.alsoAddPopular;
  const provFilter = String(body.providerFilter || '').trim().toLowerCase();

  const updates = {};
  const providersMap = new Map();
  let gameCount = 0;
  let popularCount = 0;

  for (const item of rawGames.slice(0, 600)) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || item.gameName || item.title || item.game_name || '').trim();
    const gameCode = String(item.gameCode || item.game_code || item.code || item.id || item.slug || '').trim();
    if (!name && !gameCode) continue;

    const provName = String(item.provider || item.providerName || item.vendor || item.provider_name || cfg.providerName || 'Aggregator').trim();
    if (provFilter && !provName.toLowerCase().includes(provFilter)) continue;

    const provId = slugify(provName);
    const cat = defaultCategory || mapCategory(item.category || item.type || item.gameType || '');
    const img = String(item.image || item.thumbnail || item.img || item.icon || item.banner || '').trim();
    const gid = slugify(gameCode || name);

    if (!providersMap.has(provId)) {
      providersMap.set(provId, {
        id: provId,
        name: provName,
        category: cat,
        apiCode: String(item.providerCode || item.provider_code || provId).trim(),
        active: true,
        maintenance: false,
        order: providersMap.size + 1,
        updatedAt: Date.now()
      });
    }

    updates[`provider_games/${provId}/${gid}`] = {
      id: gid,
      name: name || gameCode,
      gameCode: gameCode || gid,
      apiGameCode: gameCode || gid,
      provider: provName,
      providerId: provId,
      category: cat,
      thumbnail: img,
      img,
      active: item.active !== false && item.status !== 'Inactive',
      maintenance: false,
      order: gameCount + 1,
      updatedAt: Date.now()
    };
    gameCount++;

    if (alsoPopular && (item.popular || popularCount < 16)) {
      updates[`games/${gid}`] = {
        id: gid,
        name: name || gameCode,
        category: cat,
        icon: '🎰',
        image: img,
        imageUrl: img,
        img,
        apiGameCode: gameCode || gid,
        gameCode: gameCode || gid,
        provider: provName,
        popular: true,
        integrated: false,
        status: 'Active',
        active: true,
        isActive: true,
        order: popularCount + 1,
        updatedAt: Date.now()
      };
      popularCount++;
    }
  }

  for (const [provId, provObj] of providersMap.entries()) {
    updates[`providers/${provId}`] = provObj;
  }

  const keys = Object.keys(updates);
  if (!keys.length) {
    throw new ApiError(400, 'ম্যাচিং কোনো গেম ইমপোর্ট করা যায়নি।', 'NO_GAMES_MATCHED');
  }

  for (let i = 0; i < keys.length; i += 300) {
    const chunk = {};
    keys.slice(i, i + 300).forEach(k => { chunk[k] = updates[k]; });
    await db.ref().update(chunk);
  }

  await writeAggLog({
    type: 'SYNC_GAMES',
    status: 'OK',
    httpStatus: 200,
    message: `Synced ${gameCount} games across ${providersMap.size} providers`,
    ip
  });
  await writeAuditLog(
    actor.email || actor.uid,
    'GAME_AGGREGATOR_SYNC',
    'provider_games',
    `Providers=${providersMap.size}, Games=${gameCount}, Popular=${popularCount}`,
    ip
  );

  return { providersCount: providersMap.size, gamesCount: gameCount, popularCount };
}

async function resolveAdminPublicGameApi(adminUid) {
  if (!adminUid) return {};
  const db = getDb();
  const snap = await db.ref(`userPanelConfig/byAdmin/${adminUid}/gameApi`).once('value');
  return snap.val() || {};
}

async function launchGameForUser(actor, body, ip = '') {
  const db = getDb();
  const uSnap = await db.ref(`users/${actor.uid}`).once('value');
  const u = uSnap.val();
  if (!u) throw new ApiError(404, 'প্লেয়ার প্রোফাইল পাওয়া যায়নি।', 'USER_NOT_FOUND');
  if (String(u.status || '').toUpperCase() === 'SUSPENDED') {
    throw new ApiError(403, 'আপনার অ্যাকাউন্ট সাময়িকভাবে স্থগিত আছে।', 'USER_SUSPENDED');
  }

  const [globalCfg, admGameApi] = await Promise.all([
    loadMergedConfig(),
    resolveAdminPublicGameApi(u.adminUid || '')
  ]);

  const gApi = {
    ...globalCfg,
    ...(admGameApi && admGameApi.launchUrl ? { openMode: admGameApi.openMode || globalCfg.openMode } : {})
  };

  if (!gApi.enabled || !gApi.launchUrl) {
    throw new ApiError(400, 'Game Aggregator API এখনো চালু বা কনফিগার করা হয়নি।', 'GAME_API_DISABLED');
  }

  const gameCode = String(body.gameCode || '').trim() || 'game';
  const provider = String(body.provider || 'casino').trim();
  const gameName = String(body.gameName || '').trim();
  const balance = round2(toNum(u.balance, 0) + toNum(u.bonusBalance, 0));
  const sessionToken = crypto.randomBytes(16).toString('hex');

  await db.ref(`aggregatorSessions/${sessionToken}`).set({
    uid: actor.uid,
    username: u.username || u.name || actor.uid,
    adminUid: u.adminUid || '',
    gameCode,
    provider,
    gameName,
    createdAt: Date.now(),
    expiresAt: Date.now() + 12 * 60 * 60 * 1000
  });

  const reqData = buildOutboundRequest(gApi, gApi.launchUrl, {
    uid: actor.uid,
    username: u.username || u.name || actor.uid,
    gameCode,
    provider,
    gameName,
    balance,
    sessionToken,
    returnUrl: String(body.returnUrl || '')
  });

  if (gApi.mode === 'direct_iframe') {
    await writeAggLog({
      type: 'GAME_LAUNCH_DIRECT',
      status: 'OK',
      httpStatus: 200,
      uid: actor.uid,
      gameCode,
      provider,
      message: `Launched ${gameCode} (${provider}) via Direct Template`,
      ip
    });
    return { gameUrl: reqData.resolvedUrl, sessionToken };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(reqData.resolvedUrl, {
      method: gApi.mode === 'rest_get' ? 'GET' : 'POST',
      headers: reqData.headers,
      body: gApi.mode === 'rest_get' ? undefined : reqData.payloadString,
      signal: controller.signal
    });
    const json = await resp.json().catch(() => null);
    const gameUrl = extractLaunchUrl(json);
    const latencyMs = Date.now() - startedAt;

    if (!gameUrl) {
      await writeAggLog({
        type: 'GAME_LAUNCH_FAIL',
        status: 'ERROR',
        httpStatus: resp.status || 502,
        uid: actor.uid,
        gameCode,
        provider,
        latencyMs,
        message: `No launch URL returned (${JSON.stringify(json || {}).slice(0, 180)})`,
        ip
      });
      throw new ApiError(502, 'Game API থেকে Launch URL পাওয়া যায়নি।', 'GAME_LAUNCH_FAILED');
    }

    await writeAggLog({
      type: 'GAME_LAUNCH',
      status: 'OK',
      httpStatus: resp.status || 200,
      uid: actor.uid,
      gameCode,
      provider,
      latencyMs,
      message: `Launched ${gameCode} (${provider})`,
      ip
    });

    return { gameUrl, sessionToken };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '').trim();
}

function verifyInboundWebhookSecurity(req, cfg, rawBody, body, ip) {
  if (!cfg.enabled) {
    throw new ApiError(503, 'Game Aggregator API is currently disabled', 'AGGREGATOR_DISABLED');
  }

  if (cfg.whitelistIps) {
    const allowed = new Set(
      cfg.whitelistIps.split(',').map(s => normalizeIp(s)).filter(Boolean)
    );
    const clientIp = normalizeIp(ip);
    if (allowed.size && !allowed.has(clientIp)) {
      throw new ApiError(403, `IP ${clientIp} not in aggregator whitelist`, 'IP_NOT_WHITELISTED');
    }
  }

  const secret = cfg.webhookSecret || cfg.apiSecret || '';
  const apiKey = cfg.apiKey || '';
  if (!secret && !apiKey) {
    throw new ApiError(401, 'Webhook secret/API key is not configured in Master Admin', 'WEBHOOK_NOT_CONFIGURED');
  }

  const hdrAuth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const hdrApiKey = String(req.headers['x-api-key'] || '').trim();
  const hdrSign = String(
    req.headers[String(cfg.signHeader || 'x-sign').toLowerCase()] ||
    req.headers['x-sign'] ||
    req.headers['x-signature'] ||
    body.sign ||
    body.signature ||
    ''
  ).trim();
  const bodyToken = String(body.secret || body.apiSecret || body.apiKey || body.token || '').trim();

  if (secret && (safeEqualStr(hdrAuth, secret) || safeEqualStr(hdrApiKey, secret) || safeEqualStr(bodyToken, secret))) {
    return true;
  }
  if (apiKey && (safeEqualStr(hdrAuth, apiKey) || safeEqualStr(hdrApiKey, apiKey) || safeEqualStr(bodyToken, apiKey))) {
    return true;
  }

  if (secret && hdrSign) {
    const payloadStr = rawBody || JSON.stringify(body);
    const sha256 = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
    const sha1 = crypto.createHmac('sha1', secret).update(payloadStr).digest('hex');
    const md5 = crypto.createHash('md5').update(payloadStr + secret).digest('hex');
    if (safeEqualStr(hdrSign.toLowerCase(), sha256) || safeEqualStr(hdrSign.toLowerCase(), sha1) || safeEqualStr(hdrSign.toLowerCase(), md5)) {
      return true;
    }
  }

  throw new ApiError(401, 'Invalid aggregator webhook signature or API secret', 'INVALID_SIGNATURE');
}

async function resolveTargetUser(body) {
  const db = getDb();
  let uid = String(body.uid || body.user_id || body.player_id || body.member_id || '').trim();

  if (!uid && body.sessionToken) {
    const sessSnap = await db.ref(`aggregatorSessions/${String(body.sessionToken).trim()}`).once('value');
    const sess = sessSnap.val();
    if (sess && sess.uid) uid = sess.uid;
  }

  if (!uid && body.username) {
    const uname = String(body.username).trim().toLowerCase();
    const uRefSnap = await db.ref(`usernames/${uname}`).once('value');
    const uRef = uRefSnap.val();
    if (uRef && uRef.uid) uid = uRef.uid;
  }

  if (!uid) throw new ApiError(400, 'Player uid or username is required', 'MISSING_PLAYER_ID');

  const uSnap = await db.ref(`users/${uid}`).once('value');
  const u = uSnap.val();
  if (!u) throw new ApiError(404, 'Player not found', 'USER_NOT_FOUND');
  return { uid, user: u };
}

function normalizeAction(actionFromUrl, body) {
  const raw = String(actionFromUrl || body.action || body.cmd || body.type || body.method || '').trim().toLowerCase();
  if (['balance', 'getbalance', 'get_balance'].includes(raw)) return 'balance';
  if (['bet', 'withdraw', 'debit', 'place_bet'].includes(raw)) return 'bet';
  if (['win', 'deposit', 'credit', 'settle', 'payout'].includes(raw)) return 'win';
  if (['bet_win', 'betwin', 'place_and_settle'].includes(raw)) return 'bet_win';
  if (['rollback', 'refund', 'cancel'].includes(raw)) return 'rollback';
  return raw;
}

async function executeSeamlessAction(action, body, cfg, ip, opts = {}) {
  const db = getDb();
  const { uid, user } = await resolveTargetUser(body);
  const currentBal = round2(toNum(user.balance, 0));
  const currency = cfg.currency || 'BDT';

  if (action === 'balance') {
    if (!opts.silent) {
      await writeAggLog({
        type: 'WEBHOOK_BALANCE',
        status: 'OK',
        httpStatus: 200,
        uid,
        amount: currentBal,
        message: `Balance check -> ${currentBal} ${currency}`,
        ip
      });
    }
    return {
      ok: true,
      status: 1,
      uid,
      username: user.username || user.name || uid,
      balance: currentBal,
      currency
    };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      action,
      uid,
      currentBalance: currentBal,
      currency,
      message: `Dry-run simulation OK for action "${action}"`
    };
  }

  const rawTrxId = String(body.trxId || body.transaction_id || body.tx_id || body.round_tx_id || '').trim();
  const trxId = rawTrxId ? rawTrxId.replace(/[^a-zA-Z0-9_-]/g, '_') : `agg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const gameCode = String(body.gameCode || body.game_code || body.game || 'casino').trim();
  const gameName = String(body.gameName || body.game_name || gameCode).trim();
  const provider = String(body.provider || cfg.providerName || 'Aggregator').trim();
  const roundId = String(body.roundId || body.round_id || trxId).trim();

  if (action === 'bet') {
    const amt = round2(toNum(body.amount !== undefined ? body.amount : body.betAmount, 0));
    if (!(amt > 0)) throw new ApiError(400, 'Bet amount must be > 0', 'INVALID_AMOUNT');

    const lockPath = `aggregatorTransactions/${trxId}/_lock`;
    const existingSnap = await db.ref(`aggregatorTransactions/${trxId}`).once('value');
    if (existingSnap.exists() && existingSnap.val().status === 'APPLIED') {
      return {
        ok: true,
        status: 1,
        duplicate: true,
        trxId,
        uid,
        balance: currentBal,
        currency
      };
    }

    await acquireLock(lockPath, uid);
    try {
      const uTx = await txIncrement(`users/${uid}/balance`, -amt);
      if (!uTx.committed) {
        await writeAggLog({
          type: 'WEBHOOK_BET_FAIL',
          status: 'WARN',
          httpStatus: 400,
          uid,
          trxId,
          gameCode,
          provider,
          amount: amt,
          message: `Insufficient balance (${currentBal} < ${amt})`,
          ip
        });
        throw new ApiError(400, 'Insufficient player balance', 'INSUFFICIENT_FUNDS');
      }

      await txIncrement(`users/${uid}/turnoverDone`, amt).catch(() => {});
      await txIncrement(`users/${uid}/betCount`, 1).catch(() => {});

      const gtxKey = db.ref('game_transactions').push().key;
      const stamp = getServerTimestamp();
      const updates = {};
      updates[`aggregatorTransactions/${trxId}`] = {
        trxId,
        roundId,
        uid,
        action: 'bet',
        amount: amt,
        beforeBal: uTx.before,
        afterBal: uTx.after,
        gameCode,
        provider,
        status: 'APPLIED',
        createdAt: stamp
      };
      updates[`game_transactions/${gtxKey}`] = {
        id: gtxKey,
        uid,
        adminUid: user.adminUid || '',
        type: 'GAME_BET',
        amount: amt,
        beforeBal: uTx.before,
        afterBal: uTx.after,
        gameName,
        gameCode,
        provider,
        roundId,
        extTrxId: trxId,
        timestamp: stamp
      };
      await db.ref().update(updates);

      await writeAggLog({
        type: 'WEBHOOK_BET',
        status: 'OK',
        httpStatus: 200,
        uid,
        trxId,
        gameCode,
        provider,
        amount: amt,
        message: `Bet -${amt} -> Bal ${uTx.after}`,
        ip
      });

      return { ok: true, status: 1, trxId, uid, balance: uTx.after, currency };
    } finally {
      await releaseLock(lockPath);
    }
  }

  if (action === 'win') {
    const amt = round2(toNum(body.amount !== undefined ? body.amount : body.winAmount, 0));
    if (!(amt >= 0)) throw new ApiError(400, 'Win amount must be >= 0', 'INVALID_AMOUNT');

    const existingSnap = await db.ref(`aggregatorTransactions/${trxId}`).once('value');
    if (existingSnap.exists() && existingSnap.val().status === 'APPLIED') {
      return {
        ok: true,
        status: 1,
        duplicate: true,
        trxId,
        uid,
        balance: currentBal,
        currency
      };
    }

    const lockPath = `aggregatorTransactions/${trxId}/_lock`;
    await acquireLock(lockPath, uid);
    try {
      let beforeBal = currentBal;
      let afterBal = currentBal;
      if (amt > 0) {
        const uTx = await txIncrement(`users/${uid}/balance`, amt);
        if (!uTx.committed) throw new ApiError(500, 'Failed to credit win amount', 'CREDIT_FAILED');
        beforeBal = uTx.before;
        afterBal = uTx.after;
      }

      const gtxKey = db.ref('game_transactions').push().key;
      const stamp = getServerTimestamp();
      const updates = {};
      updates[`aggregatorTransactions/${trxId}`] = {
        trxId,
        roundId,
        uid,
        action: 'win',
        amount: amt,
        beforeBal,
        afterBal,
        gameCode,
        provider,
        status: 'APPLIED',
        createdAt: stamp
      };
      updates[`game_transactions/${gtxKey}`] = {
        id: gtxKey,
        uid,
        adminUid: user.adminUid || '',
        type: 'GAME_WIN',
        amount: amt,
        payout: amt,
        beforeBal,
        afterBal,
        gameName,
        gameCode,
        provider,
        roundId,
        extTrxId: trxId,
        timestamp: stamp
      };
      await db.ref().update(updates);

      await writeAggLog({
        type: 'WEBHOOK_WIN',
        status: 'OK',
        httpStatus: 200,
        uid,
        trxId,
        gameCode,
        provider,
        amount: amt,
        message: `Win +${amt} -> Bal ${afterBal}`,
        ip
      });

      return { ok: true, status: 1, trxId, uid, balance: afterBal, currency };
    } finally {
      await releaseLock(lockPath);
    }
  }

  if (action === 'bet_win') {
    const betAmt = round2(toNum(body.betAmount !== undefined ? body.betAmount : body.bet, 0));
    const winAmt = round2(toNum(body.winAmount !== undefined ? body.winAmount : body.win, 0));
    if (!(betAmt > 0) || !(winAmt >= 0)) {
      throw new ApiError(400, 'Invalid betAmount or winAmount', 'INVALID_AMOUNT');
    }

    const existingSnap = await db.ref(`aggregatorTransactions/${trxId}`).once('value');
    if (existingSnap.exists() && existingSnap.val().status === 'APPLIED') {
      return { ok: true, status: 1, duplicate: true, trxId, uid, balance: currentBal, currency };
    }

    const lockPath = `aggregatorTransactions/${trxId}/_lock`;
    await acquireLock(lockPath, uid);
    try {
      const bTx = await txIncrement(`users/${uid}/balance`, -betAmt);
      if (!bTx.committed) throw new ApiError(400, 'Insufficient player balance', 'INSUFFICIENT_FUNDS');

      let finalBal = bTx.after;
      if (winAmt > 0) {
        const wTx = await txIncrement(`users/${uid}/balance`, winAmt);
        if (wTx.committed) finalBal = wTx.after;
      }

      await txIncrement(`users/${uid}/turnoverDone`, betAmt).catch(() => {});
      await txIncrement(`users/${uid}/betCount`, 1).catch(() => {});

      const gtxBetKey = db.ref('game_transactions').push().key;
      const gtxWinKey = db.ref('game_transactions').push().key;
      const stamp = getServerTimestamp();
      const updates = {};
      updates[`aggregatorTransactions/${trxId}`] = {
        trxId,
        roundId,
        uid,
        action: 'bet_win',
        betAmount: betAmt,
        winAmount: winAmt,
        beforeBal: bTx.before,
        afterBal: finalBal,
        gameCode,
        provider,
        status: 'APPLIED',
        createdAt: stamp
      };
      updates[`game_transactions/${gtxBetKey}`] = {
        id: gtxBetKey,
        uid,
        adminUid: user.adminUid || '',
        type: 'GAME_BET',
        amount: betAmt,
        beforeBal: bTx.before,
        afterBal: bTx.after,
        gameName,
        gameCode,
        provider,
        roundId,
        extTrxId: trxId,
        timestamp: stamp
      };
      if (winAmt > 0) {
        updates[`game_transactions/${gtxWinKey}`] = {
          id: gtxWinKey,
          uid,
          adminUid: user.adminUid || '',
          type: 'GAME_WIN',
          amount: winAmt,
          payout: winAmt,
          beforeBal: bTx.after,
          afterBal: finalBal,
          gameName,
          gameCode,
          provider,
          roundId,
          extTrxId: trxId,
          timestamp: stamp
        };
      }
      await db.ref().update(updates);

      await writeAggLog({
        type: 'WEBHOOK_BET_WIN',
        status: 'OK',
        httpStatus: 200,
        uid,
        trxId,
        gameCode,
        provider,
        amount: winAmt - betAmt,
        message: `Bet -${betAmt}, Win +${winAmt} -> Bal ${finalBal}`,
        ip
      });

      return { ok: true, status: 1, trxId, uid, balance: finalBal, currency };
    } finally {
      await releaseLock(lockPath);
    }
  }

  if (action === 'rollback') {
    const targetTrxId = String(body.refTrxId || body.origTrxId || body.betTrxId || rawTrxId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!targetTrxId) throw new ApiError(400, 'Original bet transaction ID is required for rollback', 'MISSING_TRX_ID');

    const rbKey = `rb_${targetTrxId}`;
    const rbSnap = await db.ref(`aggregatorTransactions/${rbKey}`).once('value');
    if (rbSnap.exists() && rbSnap.val().status === 'APPLIED') {
      return { ok: true, status: 1, duplicate: true, trxId: rbKey, uid, balance: currentBal, currency };
    }

    const origSnap = await db.ref(`aggregatorTransactions/${targetTrxId}`).once('value');
    const orig = origSnap.val();
    const refundAmt = orig && orig.action === 'bet'
      ? round2(toNum(orig.amount, 0))
      : round2(toNum(body.amount, 0));
    if (!(refundAmt > 0)) {
      throw new ApiError(404, 'Original bet record not found or invalid rollback amount', 'ORIG_BET_NOT_FOUND');
    }

    const lockPath = `aggregatorTransactions/${rbKey}/_lock`;
    await acquireLock(lockPath, uid);
    try {
      const rTx = await txIncrement(`users/${uid}/balance`, refundAmt);
      if (!rTx.committed) throw new ApiError(500, 'Rollback credit failed', 'ROLLBACK_FAILED');

      const gtxKey = db.ref('game_transactions').push().key;
      const stamp = getServerTimestamp();
      const updates = {};
      updates[`aggregatorTransactions/${rbKey}`] = {
        trxId: rbKey,
        origTrxId: targetTrxId,
        uid,
        action: 'rollback',
        amount: refundAmt,
        beforeBal: rTx.before,
        afterBal: rTx.after,
        gameCode,
        provider,
        status: 'APPLIED',
        createdAt: stamp
      };
      updates[`game_transactions/${gtxKey}`] = {
        id: gtxKey,
        uid,
        adminUid: user.adminUid || '',
        type: 'GAME_ROLLBACK',
        amount: refundAmt,
        beforeBal: rTx.before,
        afterBal: rTx.after,
        gameName,
        gameCode,
        provider,
        roundId,
        extTrxId: rbKey,
        timestamp: stamp
      };
      await db.ref().update(updates);

      await writeAggLog({
        type: 'WEBHOOK_ROLLBACK',
        status: 'OK',
        httpStatus: 200,
        uid,
        trxId: rbKey,
        gameCode,
        provider,
        amount: refundAmt,
        message: `Rollback +${refundAmt} for ${targetTrxId} -> Bal ${rTx.after}`,
        ip
      });

      return { ok: true, status: 1, trxId: rbKey, uid, balance: rTx.after, currency };
    } finally {
      await releaseLock(lockPath);
    }
  }

  throw new ApiError(400, `Unsupported aggregator callback action: ${action}`, 'UNSUPPORTED_ACTION');
}

async function handleSeamlessCallback(req, actionFromUrl, body, rawBody, ip) {
  const cfg = await loadMergedConfig();
  verifyInboundWebhookSecurity(req, cfg, rawBody, body, ip);
  const action = normalizeAction(actionFromUrl, body);
  return executeSeamlessAction(action, body, cfg, ip);
}

async function simulateSeamlessWebhook(actor, body, ip) {
  const cfg = await loadMergedConfig();
  const action = normalizeAction(body.action || 'balance', body);
  const dryRun = body.dryRun !== false;
  const res = await executeSeamlessAction(action, body, cfg, ip, { dryRun, silent: false });
  await writeAuditLog(
    actor.email || actor.uid,
    'AGGREGATOR_WEBHOOK_SIMULATE',
    String(res.uid || ''),
    `Action=${action}, DryRun=${dryRun}`,
    ip
  );
  return res;
}

module.exports = {
  getAggregatorConfig,
  saveAggregatorConfig,
  testAggregatorConnection,
  syncAggregatorGames,
  launchGameForUser,
  handleSeamlessCallback,
  simulateSeamlessWebhook
};
