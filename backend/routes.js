'use strict';

const { getStatus } = require('./firebaseAdmin');
const {
  ApiError,
  getClientIp,
  sendJson,
  readJsonBody,
  readRawAndJsonBody,
  checkRateLimit,
  verifyBearerUser,
  assertMaster,
  assertActiveAdmin,
  assertActiveAgent,
  assertActiveAffiliate
} = require('./securityEngine');
const balance = require('./balanceEngine');
const aggregator = require('./aggregatorEngine');

const ROUTES = {
  // Health & Client IP
  'GET /health': async (req, res) => {
    const st = getStatus();
    sendJson(req, res, 200, {
      ok: true,
      service: 'mostwin88-platform',
      backendReady: st.configured,
      timestamp: Date.now(),
      panels: ['user.html', 'index.html', 'master.html', 'agent.html', 'affiliate.html']
    });
  },
  'GET /api/health': async (req, res) => {
    const st = getStatus();
    sendJson(req, res, 200, {
      ok: true,
      service: 'mostwin88-platform',
      backendReady: st.configured,
      databaseURL: st.databaseURL,
      credentialSource: st.credentialSource,
      configError: st.error,
      timestamp: Date.now()
    });
  },
  'GET /api/ip': async (req, res) => {
    sendJson(req, res, 200, { ip: getClientIp(req) });
  },

  // Master Admin Financial Routes
  'POST /api/v1/master/set-balance': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 30, 60000);
    const body = await readJsonBody(req);
    const data = await balance.masterSetBalance(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/transfer-admin': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 40, 60000);
    const body = await readJsonBody(req);
    const data = await balance.masterTransferAdmin(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/admin/delete': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 15, 60000);
    const body = await readJsonBody(req);
    const data = await balance.masterDeleteAdmin(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/balance-requests/decision': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 40, 60000);
    const body = await readJsonBody(req);
    const data = await balance.masterBalanceRequestDecision(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/transfer-agent': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 40, 60000);
    const body = await readJsonBody(req);
    const data = await balance.masterTransferAgent(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/agent-requests/decision': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 40, 60000);
    const body = await readJsonBody(req);
    const data = await balance.masterAgentReqDecision(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/affiliate/credit': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 40, 60000);
    const body = await readJsonBody(req);
    const data = await balance.masterAffiliateCredit(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/affiliate-requests/decision': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 40, 60000);
    const body = await readJsonBody(req);
    const data = await balance.masterAffiliateReqDecision(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/user/adjust': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 40, 60000);
    const body = await readJsonBody(req);
    const data = await balance.masterAdjustUserBalance(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/clear-admin-tx': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 5, 60000);
    const data = await balance.masterClearAdminTransactions(actor, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/withdrawals/complete': async (req, res, ip) => {
    const actor = await assertMaster(req);
    await balance.masterWithdrawalCompleteForbidden(actor, ip);
  },
  'POST /api/v1/master/withdrawals/decision': async (req, res, ip) => {
    const actor = await assertMaster(req);
    await balance.masterWithdrawalCompleteForbidden(actor, ip);
  },

  // Master Admin Game Aggregator Routes
  'POST /api/v1/master/aggregator/get': async (req, res) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 60, 60000);
    const data = await aggregator.getAggregatorConfig();
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/aggregator/save': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 30, 60000);
    const body = await readJsonBody(req);
    const data = await aggregator.saveAggregatorConfig(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/aggregator/test': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 20, 60000);
    const body = await readJsonBody(req);
    const data = await aggregator.testAggregatorConnection(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/aggregator/sync-games': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 10, 60000);
    const body = await readJsonBody(req);
    const data = await aggregator.syncAggregatorGames(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/master/aggregator/simulate-webhook': async (req, res, ip) => {
    const actor = await assertMaster(req);
    checkRateLimit(`master:${actor.uid}`, 30, 60000);
    const body = await readJsonBody(req);
    const data = await aggregator.simulateSeamlessWebhook(actor, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },

  // User Admin Financial Routes
  'POST /api/v1/admin/balance-request': async (req, res, ip) => {
    const { user } = await assertActiveAdmin(req);
    checkRateLimit(`admin:${user.uid}`, 20, 60000);
    const body = await readJsonBody(req);
    const data = await balance.adminRequestMasterFund(user, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/admin/deposits/decision': async (req, res, ip) => {
    const { user, admin } = await assertActiveAdmin(req);
    checkRateLimit(`admin:${user.uid}`, 60, 60000);
    const body = await readJsonBody(req);
    const data = await balance.adminDepositDecision(user, admin, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/admin/withdrawals/decision': async (req, res, ip) => {
    const { user } = await assertActiveAdmin(req);
    checkRateLimit(`admin:${user.uid}`, 60, 60000);
    const body = await readJsonBody(req);
    const data = await balance.adminWithdrawalDecision(user, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/admin/agent/transfer': async (req, res, ip) => {
    const { user } = await assertActiveAdmin(req);
    checkRateLimit(`admin:${user.uid}`, 40, 60000);
    const body = await readJsonBody(req);
    const data = await balance.adminAgentTransfer(user, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/admin/agent-requests/decision': async (req, res, ip) => {
    const { user } = await assertActiveAdmin(req);
    checkRateLimit(`admin:${user.uid}`, 40, 60000);
    const body = await readJsonBody(req);
    const data = await balance.adminAgentReqDecision(user, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/admin/affiliate/credit': async (req, res, ip) => {
    const { user } = await assertActiveAdmin(req);
    checkRateLimit(`admin:${user.uid}`, 40, 60000);
    const body = await readJsonBody(req);
    const data = await balance.adminAffiliateCredit(user, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/admin/affiliate-requests/decision': async (req, res, ip) => {
    const { user } = await assertActiveAdmin(req);
    checkRateLimit(`admin:${user.uid}`, 40, 60000);
    const body = await readJsonBody(req);
    const data = await balance.adminAffiliateReqDecision(user, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },

  // Agent Financial Routes
  'POST /api/v1/agent/deposits/decision': async (req, res, ip) => {
    const { user, agent } = await assertActiveAgent(req);
    checkRateLimit(`agent:${user.uid}`, 60, 60000);
    const body = await readJsonBody(req);
    const data = await balance.agentDepositDecision(user, agent, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/agent/withdrawals/complete': async (req, res, ip) => {
    const { user, agent } = await assertActiveAgent(req);
    checkRateLimit(`agent:${user.uid}`, 60, 60000);
    const body = await readJsonBody(req);
    const data = await balance.agentWithdrawalComplete(user, agent, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/agent/balance-request': async (req, res) => {
    const { user, agent } = await assertActiveAgent(req);
    checkRateLimit(`agent:${user.uid}`, 20, 60000);
    const body = await readJsonBody(req);
    const data = await balance.agentSubmitBalanceRequest(user, agent, body);
    sendJson(req, res, 200, { ok: true, ...data });
  },

  // Affiliate Financial Routes
  'POST /api/v1/affiliate/commission-request': async (req, res) => {
    const { user, affiliate } = await assertActiveAffiliate(req);
    checkRateLimit(`aff:${user.uid}`, 20, 60000);
    const body = await readJsonBody(req);
    const data = await balance.affiliateCommissionRequest(user, affiliate, body);
    sendJson(req, res, 200, { ok: true, ...data });
  },

  // Player (User) Financial & Security Routes
  'POST /api/v1/user/pin': async (req, res) => {
    const user = await verifyBearerUser(req);
    checkRateLimit(`pin:${user.uid}`, 10, 60000);
    const body = await readJsonBody(req);
    const data = await balance.userSetWithdrawPin(user, body);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/user/deposit': async (req, res) => {
    const user = await verifyBearerUser(req);
    checkRateLimit(`dep:${user.uid}`, 15, 60000);
    const body = await readJsonBody(req);
    const data = await balance.userSubmitDeposit(user, body);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/user/withdraw': async (req, res, ip) => {
    const user = await verifyBearerUser(req);
    checkRateLimit(`wd:${user.uid}`, 10, 60000);
    const body = await readJsonBody(req);
    const data = await balance.userRequestWithdrawal(user, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/user/claim-daily-bonus': async (req, res) => {
    const user = await verifyBearerUser(req);
    checkRateLimit(`bonus:${user.uid}`, 10, 60000);
    const data = await balance.userClaimDailyBonus(user);
    sendJson(req, res, 200, { ok: true, ...data });
  },
  'POST /api/v1/game/launch': async (req, res, ip) => {
    const user = await verifyBearerUser(req);
    checkRateLimit(`launch:${user.uid}`, 30, 60000);
    const body = await readJsonBody(req);
    const data = await aggregator.launchGameForUser(user, body, ip);
    sendJson(req, res, 200, { ok: true, ...data });
  },

  // Seamless Wallet Aggregator Webhook Callbacks
  'POST /api/v1/aggregator/callback': async (req, res, ip) => {
    const { body, rawBody } = await readRawAndJsonBody(req);
    const data = await aggregator.handleSeamlessCallback(req, '', body, rawBody, ip);
    sendJson(req, res, 200, data);
  },
  'POST /api/v1/aggregator/callback/balance': async (req, res, ip) => {
    const { body, rawBody } = await readRawAndJsonBody(req);
    const data = await aggregator.handleSeamlessCallback(req, 'balance', body, rawBody, ip);
    sendJson(req, res, 200, data);
  },
  'POST /api/v1/aggregator/callback/bet': async (req, res, ip) => {
    const { body, rawBody } = await readRawAndJsonBody(req);
    const data = await aggregator.handleSeamlessCallback(req, 'bet', body, rawBody, ip);
    sendJson(req, res, 200, data);
  },
  'POST /api/v1/aggregator/callback/win': async (req, res, ip) => {
    const { body, rawBody } = await readRawAndJsonBody(req);
    const data = await aggregator.handleSeamlessCallback(req, 'win', body, rawBody, ip);
    sendJson(req, res, 200, data);
  },
  'POST /api/v1/aggregator/callback/bet_win': async (req, res, ip) => {
    const { body, rawBody } = await readRawAndJsonBody(req);
    const data = await aggregator.handleSeamlessCallback(req, 'bet_win', body, rawBody, ip);
    sendJson(req, res, 200, data);
  },
  'POST /api/v1/aggregator/callback/rollback': async (req, res, ip) => {
    const { body, rawBody } = await readRawAndJsonBody(req);
    const data = await aggregator.handleSeamlessCallback(req, 'rollback', body, rawBody, ip);
    sendJson(req, res, 200, data);
  }
};

async function handleApiRequest(req, res, pathname) {
  const key = `${String(req.method || 'GET').toUpperCase()} ${pathname}`;
  const handler = ROUTES[key];
  if (!handler) {
    if (pathname.startsWith('/api/')) {
      sendJson(req, res, 404, { ok: false, error: 'API route not found', code: 'NOT_FOUND' });
      return true;
    }
    return false;
  }

  const ip = getClientIp(req);
  try {
    checkRateLimit(`ip:${ip}`, 180, 60000);
    await handler(req, res, ip);
  } catch (err) {
    const status = err instanceof ApiError || err.statusCode ? err.statusCode : 500;
    const code = err.code || 'INTERNAL_ERROR';
    const message = err.message || 'Server error occurred';
    if (status >= 500) {
      console.error(`[API ${key}]`, err);
    }
    sendJson(req, res, status, { ok: false, error: message, code });
  }
  return true;
}

module.exports = {
  handleApiRequest
};
