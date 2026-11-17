'use strict';

const { getDb, getServerTimestamp } = require('./firebaseAdmin');
const {
  ApiError,
  hashPin,
  verifyPinHash,
  verifyOrInitWithdrawPin,
  acquireLock,
  releaseLock,
  writeBalanceLedger,
  writeAuditLog,
  pushNotification
} = require('./securityEngine');

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function posAmount(v, label = 'Amount') {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ApiError(400, `${label} অবশ্যই ০ থেকে বেশি হতে হবে।`, 'INVALID_AMOUNT');
  }
  return Math.round(n * 100) / 100;
}

// Keep a temporary listener attached during the RTDB transaction so firebase-admin
// reads the live server value before running the update callback (prevents cur === null aborts).
async function safeTransaction(ref, updateFn) {
  const noop = () => {};
  ref.on('value', noop);
  try {
    await ref.once('value');
    return await ref.transaction(updateFn);
  } finally {
    ref.off('value', noop);
  }
}

async function txIncrement(path, delta) {
  const db = getDb();
  let beforeVal = 0;
  let afterVal = 0;
  const res = await safeTransaction(db.ref(path), cur => {
    const curNum = toNum(cur, 0);
    const nextNum = curNum + delta;
    if (nextNum < 0) return undefined;
    beforeVal = curNum;
    afterVal = nextNum;
    return nextNum;
  });
  return { committed: res.committed, before: beforeVal, after: afterVal, val: res.snapshot.val() };
}

async function resolveUserLimitsAndBonusConfig(adminUid) {
  const db = getDb();
  const [cmsSnap, gSnap, admCfgSnap, admProfSnap, uaOnSnap] = await Promise.all([
    db.ref('config/cms').once('value'),
    db.ref('userPanelConfig/global').once('value'),
    adminUid ? db.ref(`userPanelConfig/byAdmin/${adminUid}`).once('value') : Promise.resolve({ val: () => null }),
    adminUid ? db.ref(`admins/${adminUid}`).once('value') : Promise.resolve({ val: () => null }),
    db.ref('adminSettings/userAdminOn').once('value')
  ]);

  const cms = cmsSnap.val() || {};
  const gCfg = gSnap.val() || {};
  const aCfg = admCfgSnap.val() || {};
  const aProf = admProfSnap.val() || {};
  const uaOn = uaOnSnap.val() !== false;

  const mergedLimits = Object.assign(
    { minDeposit: 200, maxDeposit: 50000, minWithdraw: 500, maxWithdraw: 50000 },
    cms.limits || {},
    gCfg.limits || {},
    uaOn && aCfg.limits ? aCfg.limits : {}
  );

  // Admin-specific bonus/turnover settings from index.html (settings/* or admins/{uid}/*)
  const settingsSnap = await db.ref('settings').once('value');
  const legacySettings = settingsSnap.val() || {};

  const depositBonusEnabled =
    aProf.bonusEnabled !== undefined
      ? aProf.bonusEnabled === true
      : legacySettings.depositBonusEnabled === true || String(legacySettings.depositBonusEnabled) === 'true';

  const depositBonusPercent =
    aProf.bonusPercent !== undefined ? toNum(aProf.bonusPercent, 0) : toNum(legacySettings.depositBonusPercent, 0);
  const turnoverMultiplier =
    aProf.turnoverPercent !== undefined
      ? toNum(aProf.turnoverPercent, 1)
      : toNum(legacySettings.turnoverMultiplier, 1);

  const minDepositForBonus = toNum(legacySettings.minDepositForBonus, 0);
  const maxBonusAmount = toNum(legacySettings.maxBonusAmount, 0);
  const turnoverBase = legacySettings.turnoverBase || 'deposit_plus_bonus';
  const depositBonusTiers = Array.isArray(aProf.depositBonusTiers)
    ? aProf.depositBonusTiers
    : Array.isArray(legacySettings.depositBonusTiers)
      ? legacySettings.depositBonusTiers
      : [];

  const feat = Object.assign(
    {},
    cms.features || {},
    gCfg.features || {},
    uaOn && aCfg.features ? aCfg.features : {}
  );

  const dailyBonusEnabled =
    uaOn && aCfg.dailyBonusEnabled !== undefined
      ? aCfg.dailyBonusEnabled !== false
      : gCfg.dailyBonusEnabled !== undefined
        ? gCfg.dailyBonusEnabled !== false
        : cms.dailyBonusEnabled !== false;

  const dailyBonusAmount = toNum(
    uaOn && aCfg.dailyBonusAmount !== undefined
      ? aCfg.dailyBonusAmount
      : gCfg.dailyBonusAmount !== undefined
        ? gCfg.dailyBonusAmount
        : cms.dailyBonusAmount,
    50
  );

  return {
    limits: mergedLimits,
    features: feat,
    dailyBonusEnabled,
    dailyBonusAmount,
    bonus: {
      depositBonusEnabled,
      depositBonusPercent,
      turnoverMultiplier,
      minDepositForBonus,
      maxBonusAmount,
      turnoverBase,
      depositBonusTiers
    },
    gameApi: (uaOn && aCfg.gameApi) || gCfg.gameApi || cms.gameApi || {}
  };
}

function calculateDepositBonusAndTurnover(depAmt, promoId, bonusCfg) {
  if (promoId) {
    return { bonusPct: 0, mult: bonusCfg.turnoverMultiplier || 1, bonusAmt: 0, turnoverAdded: 0 };
  }
  const isBonusActive = !!bonusCfg.depositBonusEnabled;
  let bonusPct = toNum(bonusCfg.depositBonusPercent, 0);
  let mult = toNum(bonusCfg.turnoverMultiplier, 1);
  const minDepForBonus = toNum(bonusCfg.minDepositForBonus, 0);
  const maxBonus = toNum(bonusCfg.maxBonusAmount, 0);
  const tBase = bonusCfg.turnoverBase || 'deposit_plus_bonus';

  const tiers = Array.isArray(bonusCfg.depositBonusTiers) ? bonusCfg.depositBonusTiers : [];
  let matchedTier = null;
  if (tiers.length > 0) {
    const sorted = [...tiers].sort((a, b) => toNum(b.minDeposit, 0) - toNum(a.minDeposit, 0));
    matchedTier = sorted.find(t => depAmt >= toNum(t.minDeposit, 0));
    if (matchedTier) {
      bonusPct = toNum(matchedTier.bonusPercent, 0);
      mult = toNum(matchedTier.turnoverMultiplier, 1);
    }
  }

  let bonusAmt = 0;
  if (isBonusActive && (matchedTier || depAmt >= minDepForBonus)) {
    let calc = Math.round((depAmt * bonusPct) / 100);
    if (maxBonus > 0 && calc > maxBonus) calc = maxBonus;
    bonusAmt = calc;
  }

  let turnoverAdded = 0;
  if (tBase === 'deposit_plus_bonus') {
    turnoverAdded = Math.round((depAmt + bonusAmt) * mult);
  } else if (tBase === 'bonus_only') {
    turnoverAdded = Math.round(bonusAmt * mult);
  } else {
    turnoverAdded = Math.round(depAmt * mult);
  }

  return { bonusPct, mult, bonusAmt, turnoverAdded };
}

/* ==================== MASTER ADMIN OPERATIONS ==================== */

async function masterSetBalance(actor, body, ip) {
  const db = getDb();
  const nextBal = Number(body.balance);
  if (!Number.isFinite(nextBal) || nextBal < 0) {
    throw new ApiError(400, 'Master ব্যালেন্স ০ বা তার বেশি হতে হবে।', 'INVALID_BALANCE');
  }
  const note = String(body.note || 'Master fund update').slice(0, 200);
  await db.ref('master/balance').set(nextBal);
  await writeBalanceLedger({ type: 'MASTER_SET', amount: nextBal, note, actor: actor.email });
  await writeAuditLog(actor.email, 'MASTER_BALANCE_SET', 'master/balance', `Set to ৳${nextBal} (${note})`, ip);
  return { balance: nextBal };
}

async function masterTransferAdmin(actor, body, ip) {
  const db = getDb();
  const adminUid = String(body.adminUid || '').trim();
  const amt = posAmount(body.amount, 'ট্রান্সফার পরিমাণ');
  const direction = body.direction === 'from_admin' ? 'from_admin' : 'to_admin';
  const note = String(body.note || '').slice(0, 200);
  const type = String(body.type || (direction === 'to_admin' ? 'MASTER_CREDIT' : 'MASTER_RECLAIM')).slice(0, 40);
  if (!adminUid) throw new ApiError(400, 'Admin UID প্রয়োজন।', 'MISSING_ADMIN_UID');

  const admSnap = await db.ref(`admins/${adminUid}`).once('value');
  const adm = admSnap.val();
  if (!adm) throw new ApiError(404, 'অ্যাডমিন পাওয়া যায়নি।', 'ADMIN_NOT_FOUND');

  if (direction === 'to_admin') {
    const mTx = await txIncrement('master/balance', -amt);
    if (!mTx.committed) throw new ApiError(400, 'Master ব্যালেন্স যথেষ্ট নয়।', 'INSUFFICIENT_MASTER_BALANCE');
    const aTx = await txIncrement(`admins/${adminUid}/balance`, amt);
    if (!aTx.committed) {
      await txIncrement('master/balance', amt).catch(() => {});
      throw new ApiError(500, 'ট্রান্সফার ব্যর্থ, Master ব্যালেন্স ফেরত দেওয়া হয়েছে।', 'TRANSFER_FAILED');
    }
    await writeBalanceLedger({
      type,
      uid: adminUid,
      email: adm.email || '',
      amount: amt,
      note: note || 'Direct send',
      reqId: body.reqId || ''
    });
    await writeAuditLog(actor.email, 'MASTER_TO_ADMIN', adminUid, `Sent ৳${amt} (${note || 'Direct send'})`, ip);
    return { masterBalance: mTx.after, adminBalance: aTx.after };
  }

  const aTx = await txIncrement(`admins/${adminUid}/balance`, -amt);
  if (!aTx.committed) throw new ApiError(400, 'অ্যাডমিনের ব্যালেন্স যথেষ্ট নয়।', 'INSUFFICIENT_ADMIN_BALANCE');
  const mTx = await txIncrement('master/balance', amt);
  await writeBalanceLedger({
    type: 'MASTER_RECLAIM',
    uid: adminUid,
    email: adm.email || '',
    amount: amt,
    note: note || 'Reclaim'
  });
  await writeAuditLog(actor.email, 'MASTER_RECLAIM_ADMIN', adminUid, `Reclaimed ৳${amt} (${note || 'Reclaim'})`, ip);
  return { masterBalance: mTx.after, adminBalance: aTx.after };
}

async function masterDeleteAdmin(actor, body, ip) {
  const db = getDb();
  const adminUid = String(body.adminUid || '').trim();
  if (!adminUid) throw new ApiError(400, 'Admin UID প্রয়োজন।', 'MISSING_ADMIN_UID');

  const admSnap = await db.ref(`admins/${adminUid}`).once('value');
  const adm = admSnap.val();
  if (!adm) throw new ApiError(404, 'অ্যাডমিন পাওয়া যায়নি।', 'ADMIN_NOT_FOUND');

  const bal = Math.max(0, toNum(adm.balance, 0));
  if (bal > 0) {
    const aTx = await txIncrement(`admins/${adminUid}/balance`, -bal);
    if (!aTx.committed) throw new ApiError(409, 'অ্যাডমিনের ব্যালেন্স রিফান্ড ব্যর্থ হয়েছে।', 'RECLAIM_FAILED');
    await txIncrement('master/balance', bal);
    await writeBalanceLedger({
      type: 'MASTER_RECLAIM',
      uid: adminUid,
      email: adm.email || '',
      amount: bal,
      note: 'Admin deleted - balance reclaimed'
    });
  }

  await db.ref(`admins/${adminUid}`).remove();
  await db.ref(`adminLinks/${adminUid}`).remove().catch(() => {});
  await writeAuditLog(actor.email, 'ADMIN_DELETE', adminUid, `${adm.email || ''}${bal > 0 ? ', reclaimed: ' + bal : ''}`, ip);
  return { deleted: adminUid, reclaimed: bal };
}

async function masterBalanceRequestDecision(actor, body, ip) {
  const db = getDb();
  const reqId = String(body.reqId || '').trim();
  const decision = body.decision === 'reject' ? 'reject' : 'approve';
  if (!reqId) throw new ApiError(400, 'Request ID প্রয়োজন।', 'MISSING_REQ_ID');

  const reqSnap = await db.ref(`balanceRequests/${reqId}`).once('value');
  const reqData = reqSnap.val();
  if (!reqData) throw new ApiError(404, 'রিকোয়েস্ট পাওয়া যায়নি।', 'REQUEST_NOT_FOUND');

  if (decision === 'reject') {
    if (String(reqData.status || '').toLowerCase() !== 'pending') {
      throw new ApiError(409, 'রিকোয়েস্ট ইতিমধ্যে প্রসেস হয়েছে।', 'ALREADY_PROCESSED');
    }
    await db.ref(`balanceRequests/${reqId}`).update({
      status: 'rejected',
      processedAt: getServerTimestamp(),
      processedBy: actor.uid
    });
    await writeAuditLog(actor.email, 'ADMIN_BAL_REQ_REJECT', reqId, `Rejected ৳${reqData.amount}`, ip);
    return { status: 'rejected' };
  }

  const admSnap = await db.ref(`admins/${reqData.uid}`).once('value');
  const adm = admSnap.val();
  if (!adm || adm.active === false) {
    throw new ApiError(400, 'অ্যাডমিন সক্রিয় নয়।', 'ADMIN_INACTIVE');
  }

  const lockTx = await safeTransaction(
    db.ref(`balanceRequests/${reqId}/status`),
    s => (String(s || '').toLowerCase() === 'pending' ? 'processing' : undefined)
  );
  if (!lockTx.committed) throw new ApiError(409, 'রিকোয়েস্ট ইতিমধ্যে প্রক্রিয়াধীন।', 'ALREADY_PROCESSED');

  const amt = posAmount(reqData.amount, 'ব্যালেন্স পরিমাণ');
  try {
    const res = await masterTransferAdmin(
      actor,
      { adminUid: reqData.uid, amount: amt, direction: 'to_admin', type: 'REQUEST_APPROVED', note: reqData.note || '', reqId },
      ip
    );
    await db.ref(`balanceRequests/${reqId}`).update({
      status: 'approved',
      processedAt: getServerTimestamp(),
      processedBy: actor.uid
    });
    return { status: 'approved', ...res };
  } catch (err) {
    await db.ref(`balanceRequests/${reqId}/status`).set('pending').catch(() => {});
    throw err;
  }
}

async function masterTransferAgent(actor, body, ip) {
  const db = getDb();
  const agentUid = String(body.agentUid || '').trim();
  const amt = posAmount(body.amount, 'পরিমাণ');
  const direction = body.direction === 'from_agent' ? 'from_agent' : 'to_agent';
  if (!agentUid) throw new ApiError(400, 'Agent UID প্রয়োজন।', 'MISSING_AGENT_UID');

  const agSnap = await db.ref(`agents/${agentUid}`).once('value');
  const ag = agSnap.val();
  if (!ag) throw new ApiError(404, 'এজেন্ট পাওয়া যায়নি।', 'AGENT_NOT_FOUND');

  if (direction === 'to_agent') {
    const mTx = await txIncrement('master/balance', -amt);
    if (!mTx.committed) throw new ApiError(400, 'Master ব্যালেন্স যথেষ্ট নয়।', 'INSUFFICIENT_MASTER_BALANCE');
    const aTx = await txIncrement(`agents/${agentUid}/balance`, amt);
    if (!aTx.committed) {
      await txIncrement('master/balance', amt).catch(() => {});
      throw new ApiError(500, 'এজেন্ট ট্রান্সফার ব্যর্থ।', 'TRANSFER_FAILED');
    }
    await writeBalanceLedger({ type: 'AGENT_CREDIT', uid: agentUid, email: ag.email || '', amount: amt, note: 'Master -> Agent direct fund' });
    await writeAuditLog(actor.email, 'MASTER_AGENT_CREDIT', agentUid, `Sent ৳${amt}`, ip);
    return { masterBalance: mTx.after, agentBalance: aTx.after };
  }

  const aTx = await txIncrement(`agents/${agentUid}/balance`, -amt);
  if (!aTx.committed) throw new ApiError(400, 'এজেন্ট ব্যালেন্স যথেষ্ট নয়।', 'INSUFFICIENT_AGENT_BALANCE');
  const mTx = await txIncrement('master/balance', amt);
  await writeBalanceLedger({ type: 'AGENT_RECLAIM', uid: agentUid, email: ag.email || '', amount: amt, note: 'Agent -> Master reclaim' });
  await writeAuditLog(actor.email, 'MASTER_AGENT_RECLAIM', agentUid, `Reclaimed ৳${amt}`, ip);
  return { masterBalance: mTx.after, agentBalance: aTx.after };
}

async function masterAgentReqDecision(actor, body, ip) {
  const db = getDb();
  const reqId = String(body.reqId || '').trim();
  const decision = body.decision === 'reject' ? 'reject' : 'approve';
  if (!reqId) throw new ApiError(400, 'Request ID প্রয়োজন।', 'MISSING_REQ_ID');

  const reqSnap = await db.ref(`agentBalanceRequests/${reqId}`).once('value');
  const r = reqSnap.val();
  if (!r || !r.agentUid) throw new ApiError(404, 'এজেন্ট রিকোয়েস্ট পাওয়া যায়নি।', 'NOT_FOUND');

  if (decision === 'reject') {
    await db.ref(`agentBalanceRequests/${reqId}`).update({ status: 'rejected', processedAt: getServerTimestamp() });
    await writeAuditLog(actor.email, 'MASTER_AGENT_REQ_REJECT', reqId, 'Rejected by Master', ip);
    return { status: 'rejected' };
  }

  const agSnap = await db.ref(`agents/${r.agentUid}`).once('value');
  const ag = agSnap.val();
  if (!ag || ag.active === false) throw new ApiError(400, 'এজেন্ট সক্রিয় নয়।', 'AGENT_INACTIVE');

  const amt = posAmount(r.amount, 'ব্যালেন্স');
  const lockTx = await safeTransaction(
    db.ref(`agentBalanceRequests/${reqId}/status`),
    s => (String(s || '').toLowerCase() === 'pending' ? 'processing' : undefined)
  );
  if (!lockTx.committed) throw new ApiError(409, 'রিকোয়েস্ট ইতিমধ্যে প্রসেস হয়েছে।', 'ALREADY_PROCESSED');

  const mTx = await txIncrement('master/balance', -amt);
  if (!mTx.committed) {
    await db.ref(`agentBalanceRequests/${reqId}/status`).set('pending').catch(() => {});
    throw new ApiError(400, 'Master ব্যালেন্স যথেষ্ট নয়।', 'INSUFFICIENT_MASTER_BALANCE');
  }
  const aTx = await txIncrement(`agents/${r.agentUid}/balance`, amt);
  if (!aTx.committed) {
    await txIncrement('master/balance', amt).catch(() => {});
    await db.ref(`agentBalanceRequests/${reqId}/status`).set('pending').catch(() => {});
    throw new ApiError(500, 'এজেন্ট ব্যালেন্স আপডেট ব্যর্থ।', 'TRANSFER_FAILED');
  }
  await db.ref(`agentBalanceRequests/${reqId}`).update({ status: 'approved', approvedBy: 'MASTER', processedAt: getServerTimestamp() });
  await writeBalanceLedger({ type: 'AGENT_REQ_APPROVED', uid: r.agentUid, email: ag.email || '', amount: amt, note: r.note || '' });
  await writeAuditLog(actor.email, 'MASTER_AGENT_REQ_APPROVE', reqId, `Approved ৳${amt} for ${r.agentUid}`, ip);
  return { status: 'approved', masterBalance: mTx.after, agentBalance: aTx.after };
}

async function masterAffiliateCredit(actor, body, ip) {
  const db = getDb();
  const affiliateUid = String(body.affiliateUid || '').trim();
  const amt = posAmount(body.amount, 'কমিশন পরিমাণ');
  if (!affiliateUid) throw new ApiError(400, 'Affiliate UID প্রয়োজন।', 'MISSING_AFF_UID');

  const afSnap = await db.ref(`affiliates/${affiliateUid}`).once('value');
  const af = afSnap.val();
  if (!af) throw new ApiError(404, 'অ্যাফিলিয়েট পাওয়া যায়নি।', 'AFF_NOT_FOUND');

  const tx = await txIncrement(`affiliates/${affiliateUid}/commissionBalance`, amt);
  if (!tx.committed) throw new ApiError(500, 'ক্রেডিট ব্যর্থ হয়েছে।', 'TX_FAILED');
  await writeBalanceLedger({ type: 'AFF_COMMISSION_CREDIT', uid: affiliateUid, email: af.email || '', amount: amt, note: 'Master Affiliate Commission Credit' });
  await writeAuditLog(actor.email, 'MASTER_AFF_CREDIT', affiliateUid, `Credited ৳${amt}`, ip);
  return { commissionBalance: tx.after };
}

async function masterAffiliateReqDecision(actor, body, ip) {
  const db = getDb();
  const reqId = String(body.reqId || '').trim();
  const decision = body.decision === 'reject' ? 'reject' : 'approve';
  if (!reqId) throw new ApiError(400, 'Request ID প্রয়োজন।', 'MISSING_REQ_ID');

  const reqSnap = await db.ref(`affiliateCommissionRequests/${reqId}`).once('value');
  const r = reqSnap.val();
  if (!r || !r.affiliateUid) throw new ApiError(404, 'রিকোয়েস্ট পাওয়া যায়নি।', 'NOT_FOUND');

  if (decision === 'reject') {
    await db.ref(`affiliateCommissionRequests/${reqId}`).update({ status: 'rejected', processedAt: getServerTimestamp() });
    await writeAuditLog(actor.email, 'MASTER_AFF_REQ_REJECT', reqId, 'Rejected', ip);
    return { status: 'rejected' };
  }

  const afSnap = await db.ref(`affiliates/${r.affiliateUid}`).once('value');
  const af = afSnap.val();
  if (!af) throw new ApiError(404, 'অ্যাফিলিয়েট পাওয়া যায়নি।', 'AFF_NOT_FOUND');

  const lockTx = await safeTransaction(
    db.ref(`affiliateCommissionRequests/${reqId}/status`),
    s => (String(s || '').toLowerCase() === 'pending' ? 'processing' : undefined)
  );
  if (!lockTx.committed) throw new ApiError(409, 'রিকোয়েস্ট ইতিমধ্যে প্রসেস হয়েছে।', 'ALREADY_PROCESSED');

  const amt = posAmount(r.amount, 'পেআউট');
  if (toNum(af.commissionBalance, 0) >= amt) {
    await txIncrement(`affiliates/${r.affiliateUid}/commissionBalance`, -amt).catch(() => {});
  }
  await txIncrement(`affiliates/${r.affiliateUid}/totalCommissionPaid`, amt);
  await db.ref(`affiliateCommissionRequests/${reqId}`).update({ status: 'approved', approvedBy: 'MASTER', processedAt: getServerTimestamp() });
  await writeBalanceLedger({ type: 'AFF_COMMISSION_PAID', uid: r.affiliateUid, email: af.email || '', amount: amt, note: r.paymentInfo || 'Commission Payout' });
  await writeAuditLog(actor.email, 'MASTER_AFF_REQ_APPROVE', reqId, `Paid ৳${amt}`, ip);
  return { status: 'approved' };
}

async function masterAdjustUserBalance(actor, body, ip) {
  const db = getDb();
  const uid = String(body.uid || '').trim();
  const amount = Number(body.amount);
  const reason = String(body.reason || 'ম্যানুয়াল সমন্বয়').slice(0, 200);
  const returnAdminUid = body.returnAdminUid ? String(body.returnAdminUid).trim() : '';
  if (!uid) throw new ApiError(400, 'User UID প্রয়োজন।', 'MISSING_UID');
  if (!Number.isFinite(amount) || amount === 0) throw new ApiError(400, 'সঠিক পরিমাণ দিন।', 'INVALID_AMOUNT');

  const uSnap = await db.ref(`users/${uid}`).once('value');
  const u = uSnap.val();
  if (!u) throw new ApiError(404, 'প্লেয়ার পাওয়া যায়নি।', 'USER_NOT_FOUND');

  const uTx = await txIncrement(`users/${uid}/balance`, amount);
  if (!uTx.committed) {
    throw new ApiError(400, 'ব্যালেন্স আপডেট হয়নি (ঋণাত্মক হয়ে যাবে)।', 'NEGATIVE_BALANCE');
  }

  let returnedAdmin = null;
  if (amount < 0) {
    const admUid = returnAdminUid || (u.adminUid || '');
    if (admUid) {
      const admSnap = await db.ref(`admins/${admUid}`).once('value');
      if (admSnap.exists()) {
        const aTx = await txIncrement(`admins/${admUid}/balance`, -amount);
        if (!aTx.committed) {
          await txIncrement(`users/${uid}/balance`, -amount).catch(() => {});
          throw new ApiError(500, 'অ্যাডমিনকে ফেরত দেওয়া যায়নি, তাই কাটা বাতিল করা হয়েছে।', 'ADMIN_RETURN_FAILED');
        }
        returnedAdmin = admSnap.val();
        if (!u.adminUid) await db.ref(`users/${uid}/adminUid`).set(admUid).catch(() => {});
        await writeBalanceLedger({
          type: 'USER_DEDUCT_RETURN',
          uid: admUid,
          email: returnedAdmin.email || '',
          amount: -amount,
          note: `${u.name || uid}: ${reason}`
        });
      }
    }
  }

  const trxKey = db.ref('transactions').push().key;
  await db.ref(`transactions/${trxKey}`).set({
    trxId: trxKey,
    uid,
    type: amount > 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
    amount: Math.abs(amount),
    beforeBal: uTx.before,
    afterBal: uTx.after,
    date: new Date().toLocaleString('bn-BD'),
    timestamp: getServerTimestamp(),
    note: 'Master Adjustment: ' + reason + (returnedAdmin ? ` (অ্যাডমিনকে ফেরত: ${returnedAdmin.name || returnedAdmin.email})` : '')
  });

  await writeAuditLog(
    actor.email,
    'BALANCE_ADJUST',
    uid,
    `Amount: ${amount}, Reason: ${reason}${returnedAdmin ? ', Returned to admin: ' + (returnedAdmin.email || returnAdminUid) : ''}`,
    ip
  );
  return { balance: uTx.after, beforeBal: uTx.before, returnedAdminUid: returnedAdmin ? (returnAdminUid || u.adminUid) : null };
}

async function masterClearAdminTransactions(actor, ip) {
  const db = getDb();
  const paths = ['balanceLedger', 'balanceRequests', 'admin_wallet_ledger', 'admin_fund_requests'];
  const snaps = await Promise.all(paths.map(p => db.ref(p).once('value')));
  const backup = {};
  const deletes = {};
  let count = 0;

  paths.forEach((p, idx) => {
    const val = snaps[idx].val() || {};
    backup[p] = val;
    Object.keys(val).forEach(k => {
      deletes[`${p}/${k}`] = null;
      count++;
    });
  });

  if (count > 0) {
    const keys = Object.keys(deletes);
    for (let i = 0; i < keys.length; i += 400) {
      const chunk = {};
      keys.slice(i, i + 400).forEach(k => {
        chunk[k] = null;
      });
      await db.ref().update(chunk);
    }
  }
  await writeAuditLog(actor.email, 'CLEAR_ADMIN_TRANSACTIONS', 'all', `${count} records deleted`, ip);
  return { deletedCount: count, backup };
}

/* ==================== USER ADMIN OPERATIONS ==================== */

async function adminRequestMasterFund(actor, body, ip) {
  const db = getDb();
  const amt = Math.floor(posAmount(body.amount, 'ব্যালেন্স'));
  const note = String(body.note || '').slice(0, 200);
  const reqRef = db.ref('balanceRequests').push();
  const payload = {
    id: reqRef.key,
    uid: actor.uid,
    email: actor.email || '',
    amount: amt,
    note,
    status: 'pending',
    createdAt: getServerTimestamp()
  };
  await reqRef.set(payload);
  await writeAuditLog(actor.email || actor.uid, 'ADMIN_FUND_REQUEST', reqRef.key, `Requested ৳${amt}`, ip);
  return { id: reqRef.key, request: payload };
}

async function adminDepositDecision(actor, admin, body, ip) {
  const db = getDb();
  const depId = String(body.depId || '').trim();
  const decision = body.decision === 'reject' ? 'reject' : 'approve';
  const reason = String(body.reason || 'ভুল ট্রানজেকশন আইডি').slice(0, 200);
  if (!depId) throw new ApiError(400, 'Deposit ID প্রয়োজন।', 'MISSING_DEP_ID');

  const lockPath = `depositRequests/${depId}/approvalLock`;
  await acquireLock(lockPath, actor.uid);

  try {
    const depSnap = await db.ref(`depositRequests/${depId}`).once('value');
    const dep = depSnap.val();
    if (!dep) throw new ApiError(404, 'ডিপোজিট রিকোয়েস্ট পাওয়া যায়নি।', 'NOT_FOUND');
    if (String(dep.status || '').toLowerCase() !== 'pending') {
      throw new ApiError(409, 'এই ডিপোজিট ইতিমধ্যে প্রসেস হয়েছে।', 'ALREADY_PROCESSED');
    }

    // Strict ownership check for User Admin
    if (dep.adminUid && dep.adminUid !== actor.uid) {
      throw new ApiError(403, 'এই ডিপোজিট অন্য User Admin-এর অধীনে।', 'FORBIDDEN_SCOPE');
    }

    if (decision === 'reject') {
      await db.ref(`depositRequests/${depId}`).update({
        status: 'Rejected',
        adminNote: reason,
        reason,
        rejectedAt: getServerTimestamp(),
        rejectedBy: actor.uid,
        approvalLock: null
      });
      await pushNotification({
        title: 'ডিপোজিট বাতিল হয়েছে',
        body: `৳${toNum(dep.amount, 0)} ডিপোজিট বাতিল হয়েছে। কারণ: ${reason}`,
        targetUid: dep.uid,
        adminUid: dep.adminUid || actor.uid,
        category: 'WALLET'
      });
      await writeAuditLog(actor.email || actor.uid, 'DEPOSIT_REJECTED', depId, `Reason: ${reason}`, ip);
      return { status: 'Rejected' };
    }

    const depAmt = posAmount(dep.amount, 'ডিপোজিট পরিমাণ');
    const effective = await resolveUserLimitsAndBonusConfig(actor.uid);
    const { bonusAmt, turnoverAdded, mult } = calculateDepositBonusAndTurnover(depAmt, dep.promoId || '', effective.bonus);
    const totalCredited = depAmt + bonusAmt;

    // 1. Atomically deduct base deposit amount from Admin pool
    const admTx = await txIncrement(`admins/${actor.uid}/balance`, -depAmt);
    if (!admTx.committed) {
      throw new ApiError(400, `আপনার ব্যালেন্স পর্যাপ্ত নয় (প্রয়োজন ৳${depAmt})। Master-এর কাছে রিকোয়েস্ট করুন।`, 'INSUFFICIENT_ADMIN_BALANCE');
    }

    // 2. Atomically credit player wallet, bonus & turnover
    let uData = {};
    try {
      const uSnap = await db.ref(`users/${dep.uid}`).once('value');
      uData = uSnap.val() || {};
      const uBalTx = await txIncrement(`users/${dep.uid}/balance`, totalCredited);
      if (!uBalTx.committed) throw new Error('User balance update failed');

      if (bonusAmt > 0) await txIncrement(`users/${dep.uid}/bonusBalance`, bonusAmt);
      if (turnoverAdded > 0) await txIncrement(`users/${dep.uid}/turnoverRequired`, turnoverAdded);

      const trxKey = db.ref('transactions').push().key;
      const updates = {};
      updates[`depositRequests/${depId}/status`] = 'Approved';
      updates[`depositRequests/${depId}/approvedAt`] = getServerTimestamp();
      updates[`depositRequests/${depId}/approvedBy`] = actor.uid;
      updates[`depositRequests/${depId}/bonusAmount`] = bonusAmt;
      updates[`depositRequests/${depId}/totalCredited`] = totalCredited;
      updates[`depositRequests/${depId}/turnoverAdded`] = turnoverAdded;
      updates[`depositRequests/${depId}/turnoverMultiplier`] = mult;
      updates[`depositRequests/${depId}/adminUid`] = actor.uid;
      updates[`depositRequests/${depId}/approvalLock`] = null;

      if (uData.turnoverDone === undefined) {
        const curTurnDone = toNum(uData.turnoverCompleted, 0);
        updates[`users/${dep.uid}/turnoverDone`] = curTurnDone;
        updates[`users/${dep.uid}/turnoverCompleted`] = curTurnDone;
      }
      if (!uData.adminUid) updates[`users/${dep.uid}/adminUid`] = actor.uid;

      const noteText = `${dep.method || 'bKash'} TrxID: ${dep.trxId || ''} Approved. Credited: ৳${totalCredited} (Deposit: ৳${depAmt}${bonusAmt > 0 ? ` + ৳${bonusAmt} Bonus` : ''}, Turnover: ৳${turnoverAdded})`;
      updates[`transactions/${trxKey}`] = {
        trxId: trxKey,
        refId: depId,
        uid: dep.uid,
        adminUid: actor.uid,
        type: 'DEPOSIT_CREDIT',
        amount: totalCredited,
        depositAmount: depAmt,
        bonusAmount: bonusAmt,
        turnoverAdded,
        beforeBal: uBalTx.before,
        afterBal: uBalTx.after,
        date: new Date().toLocaleString('bn-BD'),
        timestamp: getServerTimestamp(),
        note: noteText
      };

      await db.ref().update(updates);
      await writeAuditLog(
        actor.email || actor.uid,
        'DEPOSIT_APPROVED',
        depId,
        `৳${depAmt} + ৳${bonusAmt} Bonus credited to ${dep.uid}, AdminBal: ৳${admTx.after}`,
        ip
      );
      return {
        status: 'Approved',
        depositAmount: depAmt,
        bonusAmount: bonusAmt,
        totalCredited,
        turnoverAdded,
        adminBalance: admTx.after,
        userBalance: uBalTx.after
      };
    } catch (innerErr) {
      // Roll back admin deduction on failure
      await txIncrement(`admins/${actor.uid}/balance`, depAmt).catch(() => {});
      throw innerErr;
    }
  } finally {
    await releaseLock(lockPath);
  }
}

async function adminWithdrawalDecision(actor, body, ip) {
  const db = getDb();
  const withKey = String(body.withKey || '').trim();
  const decision = body.decision === 'reject' ? 'reject' : 'complete';
  const paymentRef = String(body.paymentRef || '').trim().slice(0, 120);
  const reason = String(body.reason || 'ভুল একাউন্ট নাম্বার').slice(0, 200);
  if (!withKey) throw new ApiError(400, 'Withdrawal ID প্রয়োজন।', 'MISSING_WITHDRAW_ID');

  const lockPath = `withdrawalRequests/${withKey}/actionLock`;
  await acquireLock(lockPath, actor.uid);

  try {
    const wSnap = await db.ref(`withdrawalRequests/${withKey}`).once('value');
    const w = wSnap.val();
    if (!w) throw new ApiError(404, 'উইথড্র রিকোয়েস্ট পাওয়া যায়নি।', 'NOT_FOUND');

    const st = String(w.status || '').toLowerCase();
    if (st !== 'pending' && st !== 'processing' && st !== 'approved') {
      throw new ApiError(409, 'এই উইথড্র ইতিমধ্যে সম্পন্ন বা বাতিল হয়েছে।', 'ALREADY_PROCESSED');
    }
    if (w.adminUid && w.adminUid !== actor.uid) {
      throw new ApiError(403, 'এই উইথড্র অন্য User Admin-এর অধীনে।', 'FORBIDDEN_SCOPE');
    }

    const wAmt = posAmount(w.amount, 'উইথড্র পরিমাণ');

    if (decision === 'complete') {
      if (!paymentRef) throw new ApiError(400, 'পেমেন্ট TrxID দিন।', 'MISSING_PAYMENT_REF');
      const admTx = await txIncrement(`admins/${actor.uid}/balance`, wAmt);
      if (!admTx.committed) throw new ApiError(500, 'অ্যাডমিন ব্যালেন্স ক্রেডিট ব্যর্থ।', 'CREDIT_FAILED');

      const updates = {};
      updates[`withdrawalRequests/${withKey}/status`] = 'Completed';
      updates[`withdrawalRequests/${withKey}/paymentRef`] = paymentRef;
      updates[`withdrawalRequests/${withKey}/processedAt`] = getServerTimestamp();
      updates[`withdrawalRequests/${withKey}/statusUpdatedAt`] = getServerTimestamp();
      updates[`withdrawalRequests/${withKey}/adminUid`] = actor.uid;
      updates[`withdrawalRequests/${withKey}/actionLock`] = null;
      await db.ref().update(updates);

      await writeAuditLog(
        actor.email || actor.uid,
        'WITHDRAWAL_COMPLETED',
        withKey,
        `Paid ৳${wAmt}. Ref: ${paymentRef}, Admin Balance: ৳${admTx.after}`,
        ip
      );
      return { status: 'Completed', adminBalance: admTx.after };
    }

    // Reject -> Refund atomically to player
    const uTx = await txIncrement(`users/${w.uid}/balance`, wAmt);
    if (!uTx.committed) throw new ApiError(500, 'প্লেয়ার ব্যালেন্স রিফান্ড ব্যর্থ।', 'REFUND_FAILED');

    const trxKey = db.ref('transactions').push().key;
    const updates = {};
    updates[`withdrawalRequests/${withKey}/status`] = 'Rejected';
    updates[`withdrawalRequests/${withKey}/adminNote`] = reason;
    updates[`withdrawalRequests/${withKey}/rejectedAt`] = getServerTimestamp();
    updates[`withdrawalRequests/${withKey}/rejectedBy`] = actor.uid;
    updates[`withdrawalRequests/${withKey}/actionLock`] = null;
    updates[`transactions/${trxKey}`] = {
      trxId: trxKey,
      uid: w.uid,
      adminUid: actor.uid,
      type: 'WITHDRAW_REFUND',
      amount: wAmt,
      beforeBal: uTx.before,
      afterBal: uTx.after,
      date: new Date().toLocaleString('bn-BD'),
      timestamp: getServerTimestamp(),
      note: `Withdrawal ${withKey} Rejected: Refunded (${reason})`
    };
    await db.ref().update(updates);
    await writeAuditLog(actor.email || actor.uid, 'WITHDRAWAL_REJECTED', withKey, `Refunded ৳${wAmt}. Reason: ${reason}`, ip);
    return { status: 'Rejected', refunded: wAmt, userBalance: uTx.after };
  } finally {
    await releaseLock(lockPath);
  }
}

async function adminAgentTransfer(actor, body, ip) {
  const db = getDb();
  const agentUid = String(body.agentUid || '').trim();
  const amt = Math.floor(posAmount(body.amount, 'পরিমাণ'));
  const direction = body.direction === 'reclaim' ? 'reclaim' : 'send';
  if (!agentUid) throw new ApiError(400, 'Agent UID প্রয়োজন।', 'MISSING_AGENT_UID');

  const agSnap = await db.ref(`agents/${agentUid}`).once('value');
  const ag = agSnap.val();
  if (!ag) throw new ApiError(404, 'এজেন্ট পাওয়া যায়নি।', 'AGENT_NOT_FOUND');
  if (ag.parentAdminId && ag.parentAdminId !== actor.uid) {
    throw new ApiError(403, 'এই এজেন্ট আপনার অধীনে নয়।', 'FORBIDDEN_SCOPE');
  }

  if (direction === 'send') {
    const admTx = await txIncrement(`admins/${actor.uid}/balance`, -amt);
    if (!admTx.committed) throw new ApiError(400, 'আপনার ব্যালেন্স পর্যাপ্ত নয়।', 'INSUFFICIENT_ADMIN_BALANCE');
    const agTx = await txIncrement(`agents/${agentUid}/balance`, amt);
    if (!agTx.committed) {
      await txIncrement(`admins/${actor.uid}/balance`, amt).catch(() => {});
      throw new ApiError(500, 'এজেন্ট ফান্ড ট্রান্সফার ব্যর্থ।', 'TRANSFER_FAILED');
    }
    await txIncrement(`agents/${agentUid}/receivedFromAdmin`, amt).catch(() => {});
    const trxKey = db.ref('transactions').push().key;
    await db.ref(`transactions/${trxKey}`).set({
      trxId: trxKey,
      uid: agentUid,
      agentUid,
      adminUid: actor.uid,
      type: 'AGENT_ALLOCATE',
      amount: amt,
      beforeBal: agTx.before,
      afterBal: agTx.after,
      date: new Date().toLocaleString('bn-BD'),
      timestamp: getServerTimestamp(),
      note: `Admin fund allocation to Agent ${ag.name || agentUid}`
    });
    await writeAuditLog(actor.email || actor.uid, 'AGENT_ALLOCATE', agentUid, `Allocated ৳${amt}`, ip);
    return { adminBalance: admTx.after, agentBalance: agTx.after };
  }

  const agTx = await txIncrement(`agents/${agentUid}/balance`, -amt);
  if (!agTx.committed) throw new ApiError(400, 'এজেন্টের ব্যালেন্স পর্যাপ্ত নয়।', 'INSUFFICIENT_AGENT_BALANCE');
  const admTx = await txIncrement(`admins/${actor.uid}/balance`, amt);
  const trxKey = db.ref('transactions').push().key;
  await db.ref(`transactions/${trxKey}`).set({
    trxId: trxKey,
    uid: agentUid,
    agentUid,
    adminUid: actor.uid,
    type: 'AGENT_RETRIEVE',
    amount: amt,
    beforeBal: agTx.before,
    afterBal: agTx.after,
    date: new Date().toLocaleString('bn-BD'),
    timestamp: getServerTimestamp(),
    note: `Reclaimed from Agent ${ag.name || agentUid}`
  });
  await writeAuditLog(actor.email || actor.uid, 'AGENT_RETRIEVE', agentUid, `Retrieved ৳${amt}`, ip);
  return { adminBalance: admTx.after, agentBalance: agTx.after };
}

async function adminAgentReqDecision(actor, body, ip) {
  const db = getDb();
  const reqId = String(body.reqId || '').trim();
  const decision = body.decision === 'reject' ? 'reject' : 'approve';
  if (!reqId) throw new ApiError(400, 'Request ID প্রয়োজন।', 'MISSING_REQ_ID');

  const reqSnap = await db.ref(`agentBalanceRequests/${reqId}`).once('value');
  const r = reqSnap.val();
  if (!r || !r.agentUid) throw new ApiError(404, 'রিকোয়েস্ট পাওয়া যায়নি।', 'NOT_FOUND');
  if (r.parentAdminId && r.parentAdminId !== actor.uid) {
    throw new ApiError(403, 'এই এজেন্ট রিকোয়েস্ট অন্য Admin-এর অধীনে।', 'FORBIDDEN_SCOPE');
  }

  if (decision === 'reject') {
    await db.ref(`agentBalanceRequests/${reqId}`).update({ status: 'rejected', processedAt: getServerTimestamp() });
    return { status: 'rejected' };
  }

  const amt = posAmount(r.amount, 'ব্যালেন্স');
  const lockTx = await safeTransaction(
    db.ref(`agentBalanceRequests/${reqId}/status`),
    s => (String(s || '').toLowerCase() === 'pending' ? 'processing' : undefined)
  );
  if (!lockTx.committed) throw new ApiError(409, 'রিকোয়েস্ট ইতিমধ্যে প্রসেস হয়েছে।', 'ALREADY_PROCESSED');

  const admTx = await txIncrement(`admins/${actor.uid}/balance`, -amt);
  if (!admTx.committed) {
    await db.ref(`agentBalanceRequests/${reqId}/status`).set('pending').catch(() => {});
    throw new ApiError(400, 'আপনার ব্যালেন্স পর্যাপ্ত নয়।', 'INSUFFICIENT_ADMIN_BALANCE');
  }

  const agTx = await txIncrement(`agents/${r.agentUid}/balance`, amt);
  if (!agTx.committed) {
    await txIncrement(`admins/${actor.uid}/balance`, amt).catch(() => {});
    await db.ref(`agentBalanceRequests/${reqId}/status`).set('pending').catch(() => {});
    throw new ApiError(500, 'এজেন্ট ব্যালেন্স আপডেট ব্যর্থ।', 'TRANSFER_FAILED');
  }
  await txIncrement(`agents/${r.agentUid}/receivedFromAdmin`, amt).catch(() => {});
  await db.ref(`agentBalanceRequests/${reqId}`).update({
    status: 'approved',
    approvedBy: actor.uid,
    processedAt: getServerTimestamp()
  });
  await writeAuditLog(actor.email || actor.uid, 'AGENT_REQ_APPROVED', reqId, `Approved ৳${amt} for ${r.agentUid}`, ip);
  return { status: 'approved', adminBalance: admTx.after, agentBalance: agTx.after };
}

async function adminAffiliateCredit(actor, body, ip) {
  const db = getDb();
  const affiliateUid = String(body.affiliateUid || '').trim();
  const amt = Math.floor(posAmount(body.amount, 'কমিশন'));
  if (!affiliateUid) throw new ApiError(400, 'Affiliate UID প্রয়োজন।', 'MISSING_AFF_UID');

  const afSnap = await db.ref(`affiliates/${affiliateUid}`).once('value');
  const af = afSnap.val();
  if (!af) throw new ApiError(404, 'অ্যাফিলিয়েট পাওয়া যায়নি।', 'AFF_NOT_FOUND');
  if (af.parentAdminId && af.parentAdminId !== actor.uid) {
    throw new ApiError(403, 'এই অ্যাফিলিয়েট আপনার অধীনে নয়।', 'FORBIDDEN_SCOPE');
  }

  const admTx = await txIncrement(`admins/${actor.uid}/balance`, -amt);
  if (!admTx.committed) throw new ApiError(400, 'আপনার ব্যালেন্স পর্যাপ্ত নয়।', 'INSUFFICIENT_ADMIN_BALANCE');

  const afTx = await txIncrement(`affiliates/${affiliateUid}/commissionBalance`, amt);
  if (!afTx.committed) {
    await txIncrement(`admins/${actor.uid}/balance`, amt).catch(() => {});
    throw new ApiError(500, 'কমিশন ক্রেডিট ব্যর্থ।', 'CREDIT_FAILED');
  }

  const trxKey = db.ref('transactions').push().key;
  await db.ref(`transactions/${trxKey}`).set({
    trxId: trxKey,
    uid: affiliateUid,
    adminUid: actor.uid,
    type: 'AFF_COMMISSION_CREDIT',
    amount: amt,
    beforeBal: afTx.before,
    afterBal: afTx.after,
    date: new Date().toLocaleString('bn-BD'),
    timestamp: getServerTimestamp(),
    note: `Affiliate commission credit to ${af.name || affiliateUid}`
  });
  await writeAuditLog(actor.email || actor.uid, 'AFF_COMMISSION_CREDIT', affiliateUid, `Credited ৳${amt}`, ip);
  return { adminBalance: admTx.after, commissionBalance: afTx.after };
}

async function adminAffiliateReqDecision(actor, body, ip) {
  const db = getDb();
  const reqId = String(body.reqId || '').trim();
  const decision = body.decision === 'reject' ? 'reject' : 'approve';
  if (!reqId) throw new ApiError(400, 'Request ID প্রয়োজন।', 'MISSING_REQ_ID');

  const reqSnap = await db.ref(`affiliateCommissionRequests/${reqId}`).once('value');
  const r = reqSnap.val();
  if (!r || !r.affiliateUid) throw new ApiError(404, 'রিকোয়েস্ট পাওয়া যায়নি।', 'NOT_FOUND');
  if (r.parentAdminId && r.parentAdminId !== actor.uid) {
    throw new ApiError(403, 'এই অ্যাফিলিয়েট রিকোয়েস্ট আপনার অধীনে নয়।', 'FORBIDDEN_SCOPE');
  }

  if (decision === 'reject') {
    await db.ref(`affiliateCommissionRequests/${reqId}`).update({ status: 'rejected', processedAt: getServerTimestamp() });
    return { status: 'rejected' };
  }

  const lockTx = await safeTransaction(
    db.ref(`affiliateCommissionRequests/${reqId}/status`),
    s => (String(s || '').toLowerCase() === 'pending' ? 'processing' : undefined)
  );
  if (!lockTx.committed) throw new ApiError(409, 'রিকোয়েস্ট ইতিমধ্যে প্রসেস হয়েছে।', 'ALREADY_PROCESSED');

  const amt = posAmount(r.amount, 'পেআউট');
  const afSnap = await db.ref(`affiliates/${r.affiliateUid}`).once('value');
  const af = afSnap.val() || {};
  if (toNum(af.commissionBalance, 0) >= amt) {
    await txIncrement(`affiliates/${r.affiliateUid}/commissionBalance`, -amt).catch(() => {});
  }
  await txIncrement(`affiliates/${r.affiliateUid}/totalCommissionPaid`, amt);
  await db.ref(`affiliateCommissionRequests/${reqId}`).update({
    status: 'approved',
    approvedBy: actor.uid,
    processedAt: getServerTimestamp()
  });
  await writeAuditLog(actor.email || actor.uid, 'AFF_COMM_PAYOUT_APPROVED', reqId, `Paid ৳${amt} to ${r.affiliateUid}`, ip);
  return { status: 'approved' };
}

/* ==================== AGENT OPERATIONS ==================== */

async function agentDepositDecision(actor, agent, body, ip) {
  const db = getDb();
  const depId = String(body.depId || '').trim();
  const decision = body.decision === 'Rejected' || body.decision === 'reject' ? 'Rejected' : 'Approved';
  const reason = String(body.reason || 'তথ্য সঠিক নয়').slice(0, 200);
  if (!depId) throw new ApiError(400, 'Deposit ID প্রয়োজন।', 'MISSING_DEP_ID');

  const lockPath = `depositRequests/${depId}/approvalLock`;
  await acquireLock(lockPath, actor.uid);

  try {
    const depSnap = await db.ref(`depositRequests/${depId}`).once('value');
    const fresh = depSnap.val();
    if (!fresh) throw new ApiError(404, 'ডিপোজিট পাওয়া যায়নি।', 'NOT_FOUND');
    if (String(fresh.status || '').toLowerCase() !== 'pending') {
      throw new ApiError(409, 'এই ডিপোজিট ইতিমধ্যে আপডেট হয়ে গেছে।', 'ALREADY_PROCESSED');
    }

    const parentAdm = agent.parentAdminId || '';
    const inScope = fresh.assignedAgentId === actor.uid || (parentAdm && fresh.adminUid === parentAdm);
    if (!inScope) {
      throw new ApiError(403, 'এই ডিপোজিট আপনার স্কোপের মধ্যে নয়।', 'FORBIDDEN_SCOPE');
    }

    const amt = posAmount(fresh.amount, 'ডিপোজিট পরিমাণ');

    if (decision === 'Rejected') {
      await db.ref(`depositRequests/${depId}`).update({
        status: 'Rejected',
        adminNote: reason,
        reason,
        rejectedAt: getServerTimestamp(),
        rejectedByAgent: actor.uid,
        approvalLock: null
      });
      await pushNotification({
        title: 'ডিপোজিট বাতিল হয়েছে',
        body: `৳${amt} ডিপোজিট রিকোয়েস্ট বাতিল হয়েছে। কারণ: ${reason}`,
        targetUid: fresh.uid,
        category: 'WALLET'
      });
      await writeAuditLog(agent.email || actor.uid, 'AGENT_DEPOSIT_REJECT', fresh.uid, `Deposit ${depId} rejected: ${reason}`, ip);
      return { status: 'Rejected' };
    }

    const agTx = await txIncrement(`agents/${actor.uid}/balance`, -amt);
    if (!agTx.committed) {
      throw new ApiError(400, 'পর্যাপ্ত এজেন্ট ব্যালেন্স নেই! Admin থেকে ব্যালেন্স নিন।', 'INSUFFICIENT_AGENT_BALANCE');
    }

    try {
      const uTx = await txIncrement(`users/${fresh.uid}/balance`, amt);
      if (!uTx.committed) throw new Error('প্লেয়ার ব্যালেন্স আপডেট ব্যর্থ হয়েছে');

      const trxKey = db.ref('transactions').push().key;
      const updates = {};
      updates[`depositRequests/${depId}/status`] = 'Approved';
      updates[`depositRequests/${depId}/approvedAt`] = getServerTimestamp();
      updates[`depositRequests/${depId}/approvedByAgent`] = actor.uid;
      updates[`depositRequests/${depId}/assignedAgentId`] = actor.uid;
      updates[`depositRequests/${depId}/approvalLock`] = null;
      updates[`transactions/${trxKey}`] = {
        trxId: trxKey,
        refId: depId,
        uid: fresh.uid,
        playerName: fresh.playerName || fresh.userName || 'Player',
        agentUid: actor.uid,
        adminUid: fresh.adminUid || parentAdm || '',
        type: 'DEPOSIT',
        amount: amt,
        afterBal: uTx.after,
        method: fresh.method || 'bKash',
        paymentRef: fresh.trxId || fresh.trx || '',
        timestamp: getServerTimestamp(),
        note: `Verified & Approved by Agent ${agent.name || actor.uid} (Agent Wallet -${amt})`
      };
      await db.ref().update(updates);
      await txIncrement(`agents/${actor.uid}/totalProcessedDeposits`, amt).catch(() => {});
      await pushNotification({
        title: 'ডিপোজিট অনুমোদিত হয়েছে',
        body: `৳${amt} ডিপোজিট আপনার ওয়ালেটে যুক্ত হয়েছে (Trx: ${fresh.trxId || depId})।`,
        targetUid: fresh.uid,
        category: 'WALLET'
      });
      await writeAuditLog(agent.email || actor.uid, 'AGENT_DEPOSIT_APPROVE', fresh.uid, `Deposit ${depId} approved (৳${amt})`, ip);
      return { status: 'Approved', agentBalance: agTx.after, userBalance: uTx.after };
    } catch (innerErr) {
      await txIncrement(`agents/${actor.uid}/balance`, amt).catch(() => {});
      throw innerErr;
    }
  } finally {
    await releaseLock(lockPath);
  }
}

async function agentWithdrawalComplete(actor, agent, body, ip) {
  const db = getDb();
  const withKey = String(body.withKey || '').trim();
  const paymentRef = String(body.paymentRef || '').trim().slice(0, 120);
  if (!withKey) throw new ApiError(400, 'Withdrawal ID প্রয়োজন।', 'MISSING_WITHDRAW_ID');
  if (!paymentRef) throw new ApiError(400, 'পেমেন্টের Transaction ID / রেফারেন্স নম্বর লিখুন।', 'MISSING_PAYMENT_REF');

  const lockPath = `withdrawalRequests/${withKey}/actionLock`;
  await acquireLock(lockPath, actor.uid);

  try {
    const wSnap = await db.ref(`withdrawalRequests/${withKey}`).once('value');
    const fresh = wSnap.val();
    const st = String(fresh?.status || '').toLowerCase();
    const open = st === 'pending' || st === 'processing' || st === 'approved';
    if (!fresh || !open || fresh.assignedAgentId !== actor.uid) {
      throw new ApiError(409, 'এই উইথড্র রিকোয়েস্ট আপনার কাছে অ্যাসাইন নেই বা ইতিমধ্যে সম্পন্ন হয়েছে।', 'NOT_ASSIGNED');
    }

    const amt = posAmount(fresh.amount, 'উইথড্র পরিমাণ');
    const agTx = await txIncrement(`agents/${actor.uid}/balance`, amt);
    if (!agTx.committed) throw new ApiError(500, 'এজেন্ট ব্যালেন্স আপডেট ব্যর্থ হয়েছে!', 'TX_FAILED');

    try {
      const trxKey = db.ref('transactions').push().key;
      const updates = {};
      updates[`withdrawalRequests/${withKey}/status`] = 'Completed';
      updates[`withdrawalRequests/${withKey}/paymentRef`] = paymentRef;
      updates[`withdrawalRequests/${withKey}/processedAt`] = getServerTimestamp();
      updates[`withdrawalRequests/${withKey}/statusUpdatedAt`] = getServerTimestamp();
      updates[`withdrawalRequests/${withKey}/completedByAgent`] = actor.uid;
      updates[`withdrawalRequests/${withKey}/actionLock`] = null;
      updates[`transactions/${trxKey}`] = {
        trxId: trxKey,
        refId: withKey,
        uid: fresh.uid,
        playerName: fresh.playerName || fresh.userName || 'Player',
        agentUid: actor.uid,
        adminUid: fresh.adminUid || agent.parentAdminId || '',
        type: 'WITHDRAWAL',
        amount: amt,
        method: fresh.method || 'bKash',
        paymentRef,
        timestamp: getServerTimestamp(),
        note: `Withdrawal Paid by Agent ${agent.name || actor.uid} (Agent Wallet +${amt}, Trx: ${paymentRef})`
      };
      await db.ref().update(updates);
      await txIncrement(`agents/${actor.uid}/totalProcessedWithdrawals`, amt).catch(() => {});
      await pushNotification({
        title: 'উইথড্র পেমেন্ট সম্পন্ন',
        body: `আপনার ৳${amt} উইথড্র পেমেন্ট সম্পন্ন হয়েছে। TrxID: ${paymentRef}`,
        targetUid: fresh.uid,
        category: 'WALLET'
      });
      await writeAuditLog(agent.email || actor.uid, 'AGENT_WITHDRAW_COMPLETE', fresh.uid, `Withdrawal ${withKey} paid (৳${amt}, Trx: ${paymentRef})`, ip);
      return { status: 'Completed', agentBalance: agTx.after };
    } catch (innerErr) {
      await txIncrement(`agents/${actor.uid}/balance`, -amt).catch(() => {});
      throw innerErr;
    }
  } finally {
    await releaseLock(lockPath);
  }
}

async function agentSubmitBalanceRequest(actor, agent, body) {
  const db = getDb();
  const amt = posAmount(body.amount, 'টাকার পরিমাণ');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new ApiError(400, 'Balance Request-এর কারণ লিখুন।', 'MISSING_REASON');

  const reqRef = db.ref('agentBalanceRequests').push();
  const payload = {
    id: reqRef.key,
    agentUid: actor.uid,
    agentName: agent.name || 'Agent',
    agentEmail: agent.email || '',
    parentAdminId: agent.parentAdminId || '',
    amount: amt,
    reason,
    status: 'pending',
    createdAt: getServerTimestamp()
  };
  await reqRef.set(payload);
  return { id: reqRef.key, request: payload };
}

/* ==================== AFFILIATE OPERATIONS ==================== */

async function affiliateCommissionRequest(actor, affiliate, body) {
  const db = getDb();
  const amt = posAmount(body.amount, 'কমিশন পরিমাণ');
  const paymentInfo = String(body.paymentInfo || '').trim().slice(0, 200);
  const minP = Math.max(0, toNum(affiliate.minCommissionPayout, 500));
  const avail = toNum(affiliate.commissionBalance, 0);

  if (amt < minP) throw new ApiError(400, `ন্যূনতম ৳${minP} রিকোয়েস্ট করতে হবে।`, 'BELOW_MIN');
  if (amt > avail) throw new ApiError(400, `আপনার ক্রেডিটকৃত কমিশন ব্যালেন্স: ৳${Math.round(avail)}।`, 'INSUFFICIENT_COMMISSION');
  if (!paymentInfo) throw new ApiError(400, 'পেমেন্ট মেথড ও নম্বর লিখুন।', 'MISSING_PAYMENT_INFO');

  const reqRef = db.ref('affiliateCommissionRequests').push();
  const payload = {
    id: reqRef.key,
    affiliateUid: actor.uid,
    affiliateName: affiliate.name || affiliate.email || 'Affiliate',
    affiliateEmail: affiliate.email || '',
    parentAdminId: affiliate.parentAdminId || '',
    amount: amt,
    paymentInfo,
    status: 'pending',
    createdAt: getServerTimestamp()
  };
  await reqRef.set(payload);
  return { id: reqRef.key, request: payload };
}

/* ==================== USER (PLAYER) OPERATIONS ==================== */

async function userSetWithdrawPin(actor, body) {
  const db = getDb();
  const newPin = String(body.pin || '').trim();
  const currentPin = String(body.currentPin || '').trim();
  const hashed = hashPin(newPin, actor.uid);

  const [secSnap, legacySnap] = await Promise.all([
    db.ref(`userSecuritySecrets/${actor.uid}/withdrawPinHash`).once('value'),
    db.ref(`users/${actor.uid}/withdrawPin`).once('value')
  ]);
  const existingHash = secSnap.val();
  const legacyPin = legacySnap.val();

  if (existingHash && currentPin && !verifyPinHash(currentPin, actor.uid, existingHash)) {
    throw new ApiError(403, 'বর্তমান Withdrawal PIN সঠিক নয়।', 'WRONG_CURRENT_PIN');
  }
  if (!existingHash && legacyPin && currentPin && legacyPin !== currentPin) {
    throw new ApiError(403, 'বর্তমান Withdrawal PIN সঠিক নয়।', 'WRONG_CURRENT_PIN');
  }

  await db.ref().update({
    [`userSecuritySecrets/${actor.uid}/withdrawPinHash`]: hashed,
    [`userSecuritySecrets/${actor.uid}/updatedAt`]: getServerTimestamp(),
    [`users/${actor.uid}/hasWithdrawPin`]: true,
    [`users/${actor.uid}/withdrawPin`]: null
  });
  return { saved: true };
}

async function userSubmitDeposit(actor, body) {
  const db = getDb();
  const uSnap = await db.ref(`users/${actor.uid}`).once('value');
  const u = uSnap.val() || {};
  if (u.status === 'banned' || u.status === 'suspended') {
    throw new ApiError(403, 'আপনার অ্যাকাউন্ট স্থগিত করা হয়েছে।', 'ACCOUNT_SUSPENDED');
  }
  if (u.responsibleGaming && u.responsibleGaming.selfExclusion) {
    throw new ApiError(403, 'Self-exclusion সক্রিয় থাকায় ডিপোজিট বন্ধ।', 'SELF_EXCLUSION');
  }

  const adminUid = u.adminUid || String(body.adminUid || '').trim();
  const cfg = await resolveUserLimitsAndBonusConfig(adminUid);
  if (cfg.features && cfg.features.deposits === false) {
    throw new ApiError(403, 'ডিপোজিট অপশন বর্তমানে বন্ধ রয়েছে।', 'DEPOSITS_DISABLED');
  }

  const amt = posAmount(body.amount, 'ডিপোজিট পরিমাণ');
  const minD = toNum(cfg.limits.minDeposit, 200);
  const maxD = toNum(cfg.limits.maxDeposit, 50000);
  if (amt < minD) throw new ApiError(400, `ন্যূনতম ডিপোজিট ৳${minD}`, 'BELOW_MIN_DEPOSIT');
  if (amt > maxD) throw new ApiError(400, `সর্বোচ্চ ডিপোজিট ৳${maxD}`, 'ABOVE_MAX_DEPOSIT');

  const method = String(body.method || 'bKash').trim();
  const senderNumber = String(body.senderNumber || '').trim();
  const trxId = String(body.trxId || '').trim().toUpperCase();
  const isMob = !['Bank', 'USDT'].includes(method);
  if (isMob ? !/^01\d{9}$/.test(senderNumber) : senderNumber.length < 4) {
    throw new ApiError(400, 'সঠিক প্রেরক নম্বর / অ্যাকাউন্ট দিন।', 'INVALID_SENDER');
  }
  if (trxId.length < 6) {
    throw new ApiError(400, 'সঠিক Transaction ID (কমপক্ষে ৬ অক্ষর) দিন।', 'INVALID_TRX');
  }

  // Server-side daily limit check if enabled
  if (u.responsibleGaming && u.responsibleGaming.dailyLimit) {
    const depSnap = await db.ref('depositRequests').orderByChild('uid').equalTo(actor.uid).once('value');
    const todayStr = new Date().toISOString().slice(0, 10);
    let todayTotal = 0;
    depSnap.forEach(c => {
      const d = c.val() || {};
      if (d.status !== 'Rejected') {
        const dt = new Date(d.timestamp || d.createdAt || 0).toISOString().slice(0, 10);
        if (dt === todayStr) todayTotal += toNum(d.amount, 0);
      }
    });
    if (todayTotal + amt > 10000) {
      throw new ApiError(400, 'দৈনিক ডিপোজিট লিমিট (৳10,000) অতিক্রম করেছে।', 'DAILY_LIMIT_EXCEEDED');
    }
  }

  // Pick live assigned agent on server if active
  let assignedAgentId = String(body.assignedAgentId || '');
  let agentWalletNumber = String(body.agentWalletNumber || '');
  if (!assignedAgentId) {
    const awSnap = await db.ref('agentWallets').once('value');
    const wallets = awSnap.val() || {};
    for (const [agUid, aw] of Object.entries(wallets)) {
      if (!aw || aw.enabled !== true || aw.active === false) continue;
      if (adminUid && aw.parentAdminId && aw.parentAdminId !== adminUid) continue;
      const num = aw.numbers && (aw.numbers[method] || aw.numbers[method.toLowerCase()]);
      const tog = !aw.toggles || aw.toggles[method] !== false;
      if (num && tog) {
        assignedAgentId = agUid;
        agentWalletNumber = String(num);
        break;
      }
    }
  }

  const reqRef = db.ref('depositRequests').push();
  const payload = {
    id: reqRef.key,
    uid: actor.uid,
    userName: u.name || u.username || actor.name || 'Player',
    userPhone: u.phone || senderNumber,
    method,
    amount: amt,
    senderNumber,
    trxId,
    promoId: String(body.promoId || ''),
    promoName: String(body.promoName || ''),
    bonusOptIn: !!body.bonusOptIn,
    status: 'Pending',
    adminUid: adminUid || '',
    assignedAgentId,
    agentWalletNumber,
    affiliateUid: u.affiliateUid || '',
    timestamp: Date.now(),
    createdAt: getServerTimestamp()
  };
  await reqRef.set(payload);
  return { id: reqRef.key, request: payload };
}

async function userRequestWithdrawal(actor, body) {
  const db = getDb();
  const uSnap = await db.ref(`users/${actor.uid}`).once('value');
  const u = uSnap.val() || {};
  if (u.status === 'banned' || u.status === 'suspended') {
    throw new ApiError(403, 'আপনার অ্যাকাউন্ট স্থগিত করা হয়েছে।', 'ACCOUNT_SUSPENDED');
  }

  const adminUid = u.adminUid || '';
  const cfg = await resolveUserLimitsAndBonusConfig(adminUid);
  if (cfg.features && cfg.features.withdrawals === false) {
    throw new ApiError(403, 'উইথড্র অপশন বর্তমানে বন্ধ রয়েছে।', 'WITHDRAWALS_DISABLED');
  }

  const amt = posAmount(body.amount, 'উইথড্র পরিমাণ');
  const minW = toNum(cfg.limits.minWithdraw, 500);
  const maxW = toNum(cfg.limits.maxWithdraw, 50000);
  if (amt < minW) throw new ApiError(400, `ন্যূনতম উইথড্র ৳${minW}`, 'BELOW_MIN_WITHDRAW');
  if (amt > maxW) throw new ApiError(400, `প্রতি রিকোয়েস্টে সর্বোচ্চ ৳${maxW}`, 'ABOVE_MAX_WITHDRAW');

  const reqTo = toNum(u.turnoverRequired, 0);
  const doneTo = toNum(u.turnoverDone != null ? u.turnoverDone : u.turnoverCompleted, 0);
  const remTo = Math.max(0, reqTo - doneTo);
  if (remTo > 0) {
    throw new ApiError(400, `উইথড্র করার আগে আরও ৳${Math.ceil(remTo)} টার্নওভার সম্পন্ন করুন।`, 'TURNOVER_INCOMPLETE');
  }

  const method = String(body.method || 'bKash').trim();
  const accountNumber = String(body.accountNumber || '').trim();
  const bankName = String(body.bankName || '').trim();
  const accountHolder = String(body.accountHolder || '').trim();
  if (method === 'Bank' && (!bankName || !accountHolder || accountNumber.length < 6)) {
    throw new ApiError(400, 'সঠিক ব্যাংক তথ্য ও অ্যাকাউন্ট নম্বর দিন।', 'INVALID_BANK_INFO');
  }
  if (method !== 'Bank' && !/^01\d{9}$/.test(accountNumber)) {
    throw new ApiError(400, 'সঠিক ১১ সংখ্যার মোবাইল নম্বর দিন।', 'INVALID_ACCOUNT');
  }

  // Server-side scrypt PIN verification (with legacy plaintext auto-migration)
  await verifyOrInitWithdrawPin(actor.uid, body.pin);

  // Atomic server balance deduction
  const balTx = await txIncrement(`users/${actor.uid}/balance`, -amt);
  if (!balTx.committed) {
    throw new ApiError(400, 'আপনার উইথড্রযোগ্য ব্যালেন্স পর্যাপ্ত নয়।', 'INSUFFICIENT_BALANCE');
  }

  try {
    const accountDetails = method === 'Bank' ? `${bankName} · ${accountHolder} · ${accountNumber}` : accountNumber;
    const reqRef = db.ref('withdrawalRequests').push();
    const payload = {
      id: reqRef.key,
      uid: actor.uid,
      userName: u.name || u.username || 'Player',
      userPhone: u.phone || accountNumber,
      method,
      amount: amt,
      receiverNumber: accountDetails,
      accountNumber: accountDetails,
      currentBalance: balTx.after,
      status: 'Pending',
      adminUid: adminUid || '',
      affiliateUid: u.affiliateUid || '',
      timestamp: Date.now(),
      createdAt: getServerTimestamp()
    };
    await reqRef.set(payload);
    return { id: reqRef.key, balance: balTx.after, request: payload };
  } catch (err) {
    // Refund user if request creation failed
    await txIncrement(`users/${actor.uid}/balance`, amt).catch(() => {});
    throw err;
  }
}

async function userClaimDailyBonus(actor) {
  const db = getDb();
  const lockPath = `users/${actor.uid}/dailyBonusLock`;
  await acquireLock(lockPath, actor.uid);

  try {
    const uSnap = await db.ref(`users/${actor.uid}`).once('value');
    const u = uSnap.val() || {};
    const adminUid = u.adminUid || '';
    const cfg = await resolveUserLimitsAndBonusConfig(adminUid);

    if ((cfg.features && cfg.features.dailyBonus === false) || cfg.dailyBonusEnabled === false) {
      throw new ApiError(403, 'ডেইলি বোনাস বর্তমানে বন্ধ রয়েছে।', 'DAILY_BONUS_DISABLED');
    }

    const todayKey = new Date().toISOString().slice(0, 10);
    if (u.lastDailyBonusAt && new Date(Number(u.lastDailyBonusAt)).toISOString().slice(0, 10) === todayKey) {
      throw new ApiError(409, 'আজকের ডেইলি বোনাস ইতিমধ্যে নেওয়া হয়েছে।', 'ALREADY_CLAIMED_TODAY');
    }

    const bonusAmt = Math.max(0, toNum(cfg.dailyBonusAmount, 50));
    if (!bonusAmt) throw new ApiError(400, 'ডেইলি বোনাস বর্তমানে ০।', 'ZERO_BONUS');

    const bTx = await txIncrement(`users/${actor.uid}/bonusBalance`, bonusAmt);
    if (!bTx.committed) throw new ApiError(500, 'বোনাস যোগ করা যায়নি।', 'TX_FAILED');

    const now = Date.now();
    await db.ref(`users/${actor.uid}/lastDailyBonusAt`).set(now);
    const trxKey = db.ref('transactions').push().key;
    await db.ref(`transactions/${trxKey}`).set({
      trxId: trxKey,
      uid: actor.uid,
      adminUid: adminUid || '',
      type: 'Bonus',
      amount: bonusAmt,
      status: 'Success',
      note: 'Daily Login Bonus',
      timestamp: now
    });

    return { bonusAmount: bonusAmt, bonusBalance: bTx.after, claimedAt: now };
  } finally {
    await releaseLock(lockPath);
  }
}

/* ==================== GAME LAUNCH PROXY ==================== */

async function userLaunchGameProxy(actor, body) {
  const db = getDb();
  const uSnap = await db.ref(`users/${actor.uid}`).once('value');
  const u = uSnap.val() || {};
  const adminUid = u.adminUid || '';
  const cfg = await resolveUserLimitsAndBonusConfig(adminUid);
  const gApi = cfg.gameApi || {};

  if (!gApi.enabled || !gApi.launchUrl) {
    throw new ApiError(400, 'Game API কনফিগার করা নেই।', 'GAME_API_DISABLED');
  }

  const gameCode = String(body.gameCode || '').trim() || 'game';
  const provider = String(body.provider || 'casino').trim();
  const gameName = String(body.gameName || '').trim();
  const balance = toNum(u.balance, 0) + toNum(u.bonusBalance, 0);

  let resolvedUrl = String(gApi.launchUrl)
    .replace(/\{uid\}/g, encodeURIComponent(actor.uid))
    .replace(/\{username\}/g, encodeURIComponent(u.username || u.name || actor.uid))
    .replace(/\{gameCode\}/g, encodeURIComponent(gameCode))
    .replace(/\{provider\}/g, encodeURIComponent(provider))
    .replace(/\{currency\}/g, encodeURIComponent(gApi.currency || 'BDT'))
    .replace(/\{lang\}/g, encodeURIComponent(gApi.lang || 'bn'))
    .replace(/\{balance\}/g, encodeURIComponent(String(balance)))
    .replace(/\{operator\}/g, encodeURIComponent(gApi.operatorCode || ''))
    .replace(/\{apiKey\}/g, encodeURIComponent(gApi.apiKey || ''));

  if (gApi.mode === 'direct_iframe') {
    return { gameUrl: resolvedUrl };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (gApi.apiKey) {
    headers['X-API-Key'] = gApi.apiKey;
    headers['Authorization'] = `Bearer ${gApi.apiKey}`;
  }

  const fetchOpts =
    gApi.mode === 'rest_get'
      ? { method: 'GET', headers }
      : {
          method: 'POST',
          headers,
          body: JSON.stringify({
            operatorCode: gApi.operatorCode || '',
            apiKey: gApi.apiKey || '',
            uid: actor.uid,
            username: u.username || u.name || actor.uid,
            gameCode,
            provider,
            gameName,
            currency: gApi.currency || 'BDT',
            lang: gApi.lang || 'bn',
            balance,
            returnUrl: String(body.returnUrl || '')
          })
        };

  const resp = await fetch(resolvedUrl, fetchOpts);
  const json = await resp.json().catch(() => null);
  const gameUrl =
    json &&
    (json.gameUrl ||
      json.url ||
      json.launch_url ||
      json.launchUrl ||
      (json.data && (json.data.url || json.data.gameUrl || json.data.launch_url)));

  if (!gameUrl) {
    throw new ApiError(502, 'Game API থেকে Launch URL পাওয়া যায়নি।', 'GAME_LAUNCH_FAILED');
  }
  return { gameUrl };
}

module.exports = {
  safeTransaction,
  calculateDepositBonusAndTurnover,
  masterSetBalance,
  masterTransferAdmin,
  masterDeleteAdmin,
  masterBalanceRequestDecision,
  masterTransferAgent,
  masterAgentReqDecision,
  masterAffiliateCredit,
  masterAffiliateReqDecision,
  masterAdjustUserBalance,
  masterClearAdminTransactions,
  adminRequestMasterFund,
  adminDepositDecision,
  adminWithdrawalDecision,
  adminAgentTransfer,
  adminAgentReqDecision,
  adminAffiliateCredit,
  adminAffiliateReqDecision,
  agentDepositDecision,
  agentWithdrawalComplete,
  agentSubmitBalanceRequest,
  affiliateCommissionRequest,
  userSetWithdrawPin,
  userSubmitDeposit,
  userRequestWithdrawal,
  userClaimDailyBonus,
  userLaunchGameProxy
};
