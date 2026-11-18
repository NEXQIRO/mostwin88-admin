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

    const res = await ref.transaction(cur => {
      // Firebase Admin RTDB can invoke updateFn(null) on its speculative first pass
      // before local cache synchronization. Keep a temporary listener active and fall back
      // to preVal only on the initial speculative pass when preExists is true.
      const isSpeculativeNull = cur === null && !sawServerValue && preExists;
      const curNum = isSpeculativeNull ? preVal : toNum(cur, 0);
      sawServerValue = true;
      const nextNum = Math.round((curNum + delta) * 100) / 100;
      if (nextNum < 0) return undefined;
      beforeVal = curNum;
      afterVal = nextNum;
      return nextNum;
    });

    if (!res.committed) {
      return {
        committed: false,
        before: beforeVal,
        after: beforeVal,
        val: res.snapshot ? res.snapshot.val() : preVal
      };
    }
    const snapVal = res.snapshot ? res.snapshot.val() : afterVal;
    const committedVal = snapVal !== null && snapVal !== undefined ? toNum(snapVal, afterVal) : afterVal;
    return { committed: true, before: beforeVal, after: committedVal, val: committedVal };
  } finally {
    if (typeof ref.off === 'function') ref.off('value', keepAlive);
  }
}

async function lockStatus(statusPath, fromStatuses = ['pending'], toStatus = 'processing') {
  const db = getDb();
  const ref = db.ref(statusPath);
  const keepAlive = () => {};
  if (typeof ref.on === 'function') ref.on('value', keepAlive);

  try {
    const preSnap = await ref.once('value');
    const preExists = preSnap.exists();
    const preVal = preExists ? String(preSnap.val() || '') : '';
    const allowed = new Set(fromStatuses.map(s => String(s || '').toLowerCase()));
    if (!allowed.has(preVal.toLowerCase())) {
      return { committed: false, snapshot: preSnap };
    }

    let sawServerValue = false;
    return await ref.transaction(cur => {
      const isSpeculativeNull = cur === null && !sawServerValue && preExists;
      const effective = isSpeculativeNull ? preVal : String(cur || '');
      sawServerValue = true;
      return allowed.has(effective.toLowerCase()) ? toStatus : undefined;
    });
  } finally {
    if (typeof ref.off === 'function') ref.off('value', keepAlive);
  }
}

async function acquireWithdrawalLock(withKey, ownerUid) {
  const db = getDb();
  const lockPath = `withdrawalRequests/${withKey}/actionLock`;
  const lockAtPath = `withdrawalRequests/${withKey}/actionLockAt`;

  const preSnap = await db.ref(`withdrawalRequests/${withKey}`).once('value');
  const existing = preSnap.val();
  if (existing && existing.actionLock !== undefined && existing.actionLock !== null) {
    const now = Date.now();
    const lockAt = toNum(existing.actionLockAt, 0);
    const updatedAt = toNum(existing.statusUpdatedAt || existing.updatedAt || existing.createdAt || existing.timestamp, 0);
    const isStaleByLockAt = lockAt > 0 && now - lockAt > 30000;
    const isStaleFallback = lockAt === 0 && (updatedAt === 0 || now - updatedAt > 45000);
    if (isStaleByLockAt || isStaleFallback) {
      await Promise.all([
        db.ref(lockPath).remove().catch(() => {}),
        db.ref(lockAtPath).remove().catch(() => {})
      ]);
    }
  }

  await acquireLock(lockPath, ownerUid);
  await db.ref(lockAtPath).set(Date.now()).catch(() => {});
  return lockPath;
}

async function releaseWithdrawalLock(withKey) {
  const db = getDb();
  await releaseLock(`withdrawalRequests/${withKey}/actionLock`);
  await db.ref(`withdrawalRequests/${withKey}/actionLockAt`).remove().catch(() => {});
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

  const lockTx = await lockStatus(`balanceRequests/${reqId}/status`, ['pending'], 'processing');
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
    if (String(r.status || '').toLowerCase() !== 'pending') {
      throw new ApiError(409, 'রিকোয়েস্ট ইতিমধ্যে প্রসেস হয়েছে।', 'ALREADY_PROCESSED');
    }
    await db.ref(`agentBalanceRequests/${reqId}`).update({ status: 'rejected', processedAt: getServerTimestamp() });
    await writeAuditLog(actor.email, 'MASTER_AGENT_REQ_REJECT', reqId, 'Rejected by Master', ip);
    return { status: 'rejected' };
  }

  const agSnap = await db.ref(`agents/${r.agentUid}`).once('value');
  const ag = agSnap.val();
  if (!ag || ag.active === false) throw new ApiError(400, 'এজেন্ট সক্রিয় নয়।', 'AGENT_INACTIVE');

  const amt = posAmount(r.amount, 'ব্যালেন্স');
  const lockTx = await lockStatus(`agentBalanceRequests/${reqId}/status`, ['pending'], 'processing');
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

  const lockTx = await lockStatus(`affiliateCommissionRequests/${reqId}/status`, ['pending'], 'processing');
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

async function masterWithdrawalCompleteForbidden(actor, ip) {
  await writeAuditLog(
    actor.email || actor.uid,
    'MASTER_WITHDRAW_COMPLETE_BLOCKED',
    'withdrawalRequests',
    'Master Admin attempted direct withdrawal completion — blocked by policy (Assigned Agent only)',
    ip
  );
  throw new ApiError(
    403,
    'Master Admin বা Admin সরাসরি উইথড্র Complete করতে পারবেন না। শুধুমাত্র নির্দিষ্ট Assigned Agent পেমেন্ট কনফার্ম করে Complete করতে পারবেন।',
    'FORBIDDEN_ROLE'
  );
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
  const rawDecision = String(body.decision || '').trim().toLowerCase();
  const reason = String(body.reason || 'ভুল একাউন্ট নাম্বার').slice(0, 200);
  const adminNote = String(body.adminNote || '').trim().slice(0, 240);

  if (rawDecision === 'complete') {
    await writeAuditLog(
      actor.email || actor.uid,
      'ADMIN_WITHDRAW_COMPLETE_BLOCKED',
      withKey || 'withdrawalRequests',
      'User Admin attempted direct withdrawal completion — blocked by policy (Assigned Agent only)',
      ip
    );
    throw new ApiError(
      403,
      'User Admin সরাসরি উইথড্র Complete করতে পারবেন না। অনুগ্রহ করে যাচাই করে Assigned Agent-এর কাছে পাঠান; শুধু নির্ধারিত Assigned Agent-ই পেমেন্ট কনফার্ম করে Complete করতে পারবেন।',
      'FORBIDDEN_ROLE'
    );
  }

  if (!withKey) throw new ApiError(400, 'Withdrawal ID প্রয়োজন।', 'MISSING_WITHDRAW_ID');

  const isReject = rawDecision === 'reject';
  const isVerifying = ['verifying', 'verify_hold', 'hold'].includes(rawDecision);
  const isAdjust = ['adjust', 'forfeit', 'confiscate', 'deduct'].includes(rawDecision);
  const isVerifyForward = ['verify_forward', 'processing', 'verify', 'forward', 'assign'].includes(rawDecision);
  if (!isReject && !isVerifying && !isAdjust && !isVerifyForward) {
    throw new ApiError(
      400,
      'বৈধ অ্যাকশন নির্বাচন করুন (verifying, verify_forward/processing, adjust বা reject)।',
      'INVALID_DECISION'
    );
  }

  await acquireWithdrawalLock(withKey, actor.uid);

  try {
    const wSnap = await db.ref(`withdrawalRequests/${withKey}`).once('value');
    const w = wSnap.val();
    if (!w) throw new ApiError(404, 'উইথড্র রিকোয়েস্ট পাওয়া যায়নি।', 'NOT_FOUND');

    const st = String(w.status || '').toLowerCase();
    const openStatuses = ['pending', 'verifying', 'verified', 'processing', 'assignedtoagent'];
    if (!openStatuses.includes(st)) {
      throw new ApiError(409, 'এই উইথড্র ইতিমধ্যে সম্পন্ন বা বাতিল হয়েছে।', 'ALREADY_PROCESSED');
    }
    if (w.adminUid && w.adminUid !== actor.uid) {
      throw new ApiError(403, 'এই উইথড্র অন্য User Admin-এর অধীনে।', 'FORBIDDEN_SCOPE');
    }

    const wAmt = posAmount(w.amount, 'উইথড্র পরিমাণ');
    const stamp = getServerTimestamp();

    if (isReject) {
      // Reject -> Refund atomically to player
      const uTx = await txIncrement(`users/${w.uid}/balance`, wAmt);
      if (!uTx.committed) throw new ApiError(500, 'প্লেয়ার ব্যালেন্স রিফান্ড ব্যর্থ।', 'REFUND_FAILED');

      const trxKey = db.ref('transactions').push().key;
      const updates = {};
      updates[`withdrawalRequests/${withKey}/status`] = 'Rejected';
      updates[`withdrawalRequests/${withKey}/stage`] = 'REJECTED';
      updates[`withdrawalRequests/${withKey}/adminNote`] = reason;
      updates[`withdrawalRequests/${withKey}/rejectedAt`] = stamp;
      updates[`withdrawalRequests/${withKey}/rejectedBy`] = actor.uid;
      updates[`withdrawalRequests/${withKey}/statusUpdatedAt`] = stamp;
      updates[`withdrawalRequests/${withKey}/actionLock`] = null;
      updates[`withdrawalRequests/${withKey}/actionLockAt`] = null;
      updates[`transactions/${trxKey}`] = {
        trxId: trxKey,
        refId: withKey,
        requestId: withKey,
        uid: w.uid,
        adminUid: actor.uid,
        type: 'WITHDRAW_REFUND',
        amount: wAmt,
        beforeBal: uTx.before,
        afterBal: uTx.after,
        status: 'Rejected',
        date: new Date().toLocaleString('bn-BD'),
        timestamp: stamp,
        note: `Withdrawal ${withKey} Rejected by User Admin: Refunded ৳${wAmt} (${reason})`
      };
      await db.ref().update(updates);
      await pushNotification({
        title: 'উইথড্র বাতিল ও রিফান্ড সম্পন্ন',
        body: `আপনার ৳${wAmt} উইথড্র বাতিল হয়েছে এবং ব্যালেন্স ওয়ালেটে ফেরত দেওয়া হয়েছে। কারণ: ${reason}`,
        targetUid: w.uid,
        adminUid: actor.uid,
        category: 'WALLET'
      });
      await writeAuditLog(
        actor.email || actor.uid,
        'WITHDRAWAL_REJECTED',
        withKey,
        `Rejected & Refunded ৳${wAmt} to ${w.uid}. Reason: ${reason}`,
        ip
      );
      return { status: 'Rejected', refunded: wAmt, userBalance: uTx.after };
    }

    if (isVerifying) {
      const holdNote = adminNote || reason || 'সন্দেহজনক লেনদেন — Admin যাচাই চলছে';
      const updates = {};
      updates[`withdrawalRequests/${withKey}/status`] = 'Verifying';
      updates[`withdrawalRequests/${withKey}/stage`] = 'ADMIN_VERIFYING';
      updates[`withdrawalRequests/${withKey}/adminVerified`] = false;
      updates[`withdrawalRequests/${withKey}/forwardedToAgent`] = false;
      updates[`withdrawalRequests/${withKey}/verifyingBy`] = actor.uid;
      updates[`withdrawalRequests/${withKey}/verifyingAt`] = stamp;
      updates[`withdrawalRequests/${withKey}/statusUpdatedAt`] = stamp;
      updates[`withdrawalRequests/${withKey}/adminUid`] = w.adminUid || actor.uid;
      updates[`withdrawalRequests/${withKey}/adminNote`] = holdNote;
      updates[`withdrawalRequests/${withKey}/actionLock`] = null;
      updates[`withdrawalRequests/${withKey}/actionLockAt`] = null;
      await db.ref().update(updates);

      await pushNotification({
        title: 'উইথড্র যাচাই (Verify) চলছে',
        body: `আপনার ৳${wAmt} উইথড্র রিকোয়েস্টটি নিরাপত্তার কারণে Admin চেক ও যাচাইয়ের জন্য হোল্ডে রয়েছে। (${holdNote})`,
        targetUid: w.uid,
        adminUid: actor.uid,
        category: 'WALLET'
      });
      await writeAuditLog(
        actor.email || actor.uid,
        'WITHDRAWAL_VERIFYING',
        withKey,
        `Placed ৳${wAmt} withdrawal for Player ${w.uid} on Verifying hold: ${holdNote}`,
        ip
      );
      return {
        status: 'Verifying',
        stage: 'ADMIN_VERIFYING',
        adminNote: holdNote
      };
    }

    if (isAdjust) {
      const adjReason = String(body.reason || body.adminNote || 'দুর্নীতি / অনিয়মের কারণে টাকা কর্তন').trim().slice(0, 200);
      const extraDeduct = Math.max(0, Math.round(toNum(body.extraDeduct, 0) * 100) / 100);
      const uSnap = await db.ref(`users/${w.uid}`).once('value');
      const u = uSnap.val() || {};
      let userAfterBal = toNum(u.balance, 0);
      let userBeforeBal = userAfterBal;

      if (extraDeduct > 0) {
        const uTx = await txIncrement(`users/${w.uid}/balance`, -extraDeduct);
        if (!uTx.committed) {
          throw new ApiError(
            400,
            `অতিরিক্ত ৳${extraDeduct} কাটার জন্য প্লেয়ারের অবশিষ্ট ওয়ালেট ব্যালেন্স পর্যাপ্ত নয় (বর্তমান: ৳${Math.round(userBeforeBal)})।`,
            'INSUFFICIENT_USER_BALANCE'
          );
        }
        userBeforeBal = uTx.before;
        userAfterBal = uTx.after;
      }

      const totalDeducted = Math.round((wAmt + extraDeduct) * 100) / 100;
      const trxKey = db.ref('transactions').push().key;
      const updates = {};
      updates[`withdrawalRequests/${withKey}/status`] = 'Adjusted';
      updates[`withdrawalRequests/${withKey}/stage`] = 'ADJUSTED';
      updates[`withdrawalRequests/${withKey}/adminVerified`] = false;
      updates[`withdrawalRequests/${withKey}/forwardedToAgent`] = false;
      updates[`withdrawalRequests/${withKey}/assignedAgentId`] = '';
      updates[`withdrawalRequests/${withKey}/assignedAgentName`] = '';
      updates[`withdrawalRequests/${withKey}/adminNote`] = adjReason;
      updates[`withdrawalRequests/${withKey}/adjustReason`] = adjReason;
      updates[`withdrawalRequests/${withKey}/extraDeducted`] = extraDeduct;
      updates[`withdrawalRequests/${withKey}/totalDeducted`] = totalDeducted;
      updates[`withdrawalRequests/${withKey}/adjustedAt`] = stamp;
      updates[`withdrawalRequests/${withKey}/adjustedBy`] = actor.uid;
      updates[`withdrawalRequests/${withKey}/statusUpdatedAt`] = stamp;
      updates[`withdrawalRequests/${withKey}/adminUid`] = w.adminUid || actor.uid;
      updates[`withdrawalRequests/${withKey}/actionLock`] = null;
      updates[`withdrawalRequests/${withKey}/actionLockAt`] = null;

      updates[`transactions/${trxKey}`] = {
        trxId: trxKey,
        refId: withKey,
        requestId: withKey,
        uid: w.uid,
        adminUid: actor.uid,
        type: 'WITHDRAW_ADJUSTED',
        amount: totalDeducted,
        confiscatedWithdrawal: wAmt,
        extraDeducted: extraDeduct,
        beforeBal: userBeforeBal,
        afterBal: userAfterBal,
        status: 'Adjusted',
        date: new Date().toLocaleString('bn-BD'),
        timestamp: stamp,
        note: `Withdrawal ${withKey} Adjusted (Confiscated ৳${wAmt}${extraDeduct > 0 ? ` + Extra Wallet Deduct ৳${extraDeduct}` : ''}): ${adjReason}`
      };

      try {
        await db.ref().update(updates);
      } catch (innerErr) {
        if (extraDeduct > 0) {
          await txIncrement(`users/${w.uid}/balance`, extraDeduct).catch(() => {});
        }
        throw innerErr;
      }

      await pushNotification({
        title: 'উইথড্র বাজেয়াপ্ত ও ব্যালেন্স সমন্বয় (Adjusted)',
        body: `অনিয়ম/দুর্নীতির কারণে আপনার ৳${wAmt} উইথড্র${extraDeduct > 0 ? ` এবং ওয়ালেট থেকে আরও ৳${extraDeduct}` : ''} কর্তন করা হয়েছে। কারণ: ${adjReason}`,
        targetUid: w.uid,
        adminUid: actor.uid,
        category: 'WALLET'
      });
      await writeAuditLog(
        actor.email || actor.uid,
        'WITHDRAWAL_ADJUSTED',
        withKey,
        `Adjusted Player ${w.uid}: Confiscated ৳${wAmt} + Extra ৳${extraDeduct} = ৳${totalDeducted}. Reason: ${adjReason}`,
        ip
      );

      return {
        status: 'Adjusted',
        stage: 'ADJUSTED',
        confiscatedWithdrawal: wAmt,
        extraDeducted: extraDeduct,
        totalDeducted,
        userBalance: userAfterBal
      };
    }

    // Verify & Forward to Assigned Agent (status set to 'Processing' until Assigned Agent confirms payment)
    const agentUid = String(body.agentUid || '').trim();
    if (!agentUid) {
      throw new ApiError(400, 'যাচাই শেষে পাঠানোর জন্য একজন নির্ধারিত Agent নির্বাচন করুন।', 'MISSING_AGENT_UID');
    }

    const [agSnap, awSnap, uSnap] = await Promise.all([
      db.ref(`agents/${agentUid}`).once('value'),
      db.ref(`agentWallets/${agentUid}`).once('value'),
      db.ref(`users/${w.uid}`).once('value')
    ]);
    const ag = agSnap.val();
    const aw = awSnap.val() || {};
    const u = uSnap.val() || {};

    if (!ag || ag.active === false || ag.status === 'suspended' || ag.status === 'inactive') {
      throw new ApiError(400, 'নির্বাচিত Agent বর্তমানে সক্রিয় নয়।', 'AGENT_INACTIVE');
    }
    const agParent = ag.parentAdminId || ag.adminUid || aw.parentAdminId || aw.adminUid || '';
    if (agParent && agParent !== actor.uid) {
      throw new ApiError(403, 'এই Agent আপনার User Admin লাইনের অধীনে নয়।', 'FORBIDDEN_AGENT_SCOPE');
    }

    const agentName = String(ag.name || ag.email || 'Agent').trim();
    const reqTo = toNum(u.turnoverRequired, 0);
    const doneTo = toNum(u.turnoverDone != null ? u.turnoverDone : u.turnoverCompleted, 0);
    const remTo = Math.max(0, Math.round((reqTo - doneTo) * 100) / 100);
    const liveBal = toNum(u.balance, 0);

    const trxKey = db.ref('transactions').push().key;
    const updates = {};
    // Set status to 'Processing' and forward strictly to Assigned Agent (Completed only by Assigned Agent)
    updates[`withdrawalRequests/${withKey}/status`] = 'Processing';
    updates[`withdrawalRequests/${withKey}/adminVerified`] = true;
    updates[`withdrawalRequests/${withKey}/forwardedToAgent`] = true;
    updates[`withdrawalRequests/${withKey}/stage`] = 'AGENT_ASSIGNED';
    updates[`withdrawalRequests/${withKey}/assignedAgentId`] = agentUid;
    updates[`withdrawalRequests/${withKey}/assignedAgentName`] = agentName;
    updates[`withdrawalRequests/${withKey}/verifiedBy`] = actor.uid;
    updates[`withdrawalRequests/${withKey}/verifiedByEmail`] = actor.email || '';
    updates[`withdrawalRequests/${withKey}/verifiedAt`] = stamp;
    updates[`withdrawalRequests/${withKey}/forwardedAt`] = stamp;
    updates[`withdrawalRequests/${withKey}/assignedAt`] = stamp;
    updates[`withdrawalRequests/${withKey}/processingAt`] = stamp;
    updates[`withdrawalRequests/${withKey}/statusUpdatedAt`] = stamp;
    updates[`withdrawalRequests/${withKey}/adminUid`] = w.adminUid || actor.uid;
    updates[`withdrawalRequests/${withKey}/verifiedUserBalance`] = liveBal;
    updates[`withdrawalRequests/${withKey}/verifiedTurnoverRemaining`] = remTo;
    if (adminNote) updates[`withdrawalRequests/${withKey}/adminNote`] = adminNote;
    updates[`withdrawalRequests/${withKey}/actionLock`] = null;
    updates[`withdrawalRequests/${withKey}/actionLockAt`] = null;

    updates[`transactions/${trxKey}`] = {
      trxId: trxKey,
      refId: withKey,
      requestId: withKey,
      uid: w.uid,
      playerName: w.userName || u.name || 'Player',
      adminUid: actor.uid,
      agentUid,
      type: 'WITHDRAW_FORWARDED',
      amount: wAmt,
      beforeBal: liveBal,
      afterBal: liveBal,
      method: w.method || 'bKash',
      status: 'Processing',
      date: new Date().toLocaleString('bn-BD'),
      timestamp: stamp,
      note: `User Admin verified ৳${wAmt} withdrawal & forwarded to Assigned Agent: ${agentName}${adminNote ? ' · Note: ' + adminNote : ''}`
    };

    await db.ref().update(updates);

    await pushNotification({
      title: 'নতুন উইথড্র পেমেন্ট অ্যাসাইন হয়েছে',
      body: `User Admin যাচাই করে ৳${wAmt} (${w.method || 'Wallet'} · ${w.receiverNumber || w.accountNumber || ''}) উইথড্র পেমেন্ট আপনার কাছে পাঠিয়েছেন। ম্যানুয়ালি টাকা পাঠিয়ে Confirm করুন।`,
      targetUid: agentUid,
      adminUid: actor.uid,
      category: 'WITHDRAWAL'
    });
    await pushNotification({
      title: 'উইথড্র প্রসেসিং হচ্ছে',
      body: `আপনার ৳${wAmt} উইথড্র রিকোয়েস্ট যাচাই সম্পন্ন করে পেমেন্ট এজেন্ট (${agentName})-এর কাছে পাঠানো হয়েছে।`,
      targetUid: w.uid,
      adminUid: actor.uid,
      category: 'WALLET'
    });
    await writeAuditLog(
      actor.email || actor.uid,
      'WITHDRAWAL_VERIFIED_FORWARDED',
      withKey,
      `Verified Player ${w.uid} (Bal: ৳${liveBal}, TurnoverRem: ৳${remTo}) & forwarded ৳${wAmt} to Agent ${agentName} (${agentUid})`,
      ip
    );

    return {
      status: 'Processing',
      stage: 'AGENT_ASSIGNED',
      adminVerified: true,
      forwardedToAgent: true,
      assignedAgentId: agentUid,
      assignedAgentName: agentName
    };
  } finally {
    await releaseWithdrawalLock(withKey);
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
  const agParent = ag.parentAdminId || ag.adminUid || '';
  if (agParent && agParent !== actor.uid) {
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
  const reqParent = r.parentAdminId || r.adminUid || '';
  if (reqParent && reqParent !== actor.uid) {
    throw new ApiError(403, 'এই এজেন্ট রিকোয়েস্ট অন্য Admin-এর অধীনে।', 'FORBIDDEN_SCOPE');
  }

  if (decision === 'reject') {
    if (String(r.status || '').toLowerCase() !== 'pending') {
      throw new ApiError(409, 'রিকোয়েস্ট ইতিমধ্যে প্রসেস হয়েছে।', 'ALREADY_PROCESSED');
    }
    await db.ref(`agentBalanceRequests/${reqId}`).update({ status: 'rejected', processedAt: getServerTimestamp() });
    await writeAuditLog(actor.email || actor.uid, 'AGENT_REQ_REJECTED', reqId, `Rejected ৳${r.amount}`, ip);
    return { status: 'rejected' };
  }

  const amt = posAmount(r.amount, 'ব্যালেন্স');
  const lockTx = await lockStatus(`agentBalanceRequests/${reqId}/status`, ['pending'], 'processing');
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
  const afParent = af.parentAdminId || af.adminUid || '';
  if (afParent && afParent !== actor.uid) {
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
  const reqParent = r.parentAdminId || r.adminUid || '';
  if (reqParent && reqParent !== actor.uid) {
    throw new ApiError(403, 'এই অ্যাফিলিয়েট রিকোয়েস্ট আপনার অধীনে নয়।', 'FORBIDDEN_SCOPE');
  }

  if (decision === 'reject') {
    await db.ref(`affiliateCommissionRequests/${reqId}`).update({ status: 'rejected', processedAt: getServerTimestamp() });
    return { status: 'rejected' };
  }

  const lockTx = await lockStatus(`affiliateCommissionRequests/${reqId}/status`, ['pending'], 'processing');
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

    const parentAdm = agent.parentAdminId || agent.adminUid || '';
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

    const effectiveAdmin = fresh.adminUid || parentAdm || '';
    const effective = await resolveUserLimitsAndBonusConfig(effectiveAdmin);
    const { bonusAmt, turnoverAdded, mult } = calculateDepositBonusAndTurnover(amt, fresh.promoId || '', effective.bonus);
    const totalCredited = amt + bonusAmt;

    const agTx = await txIncrement(`agents/${actor.uid}/balance`, -amt);
    if (!agTx.committed) {
      throw new ApiError(400, 'পর্যাপ্ত এজেন্ট ব্যালেন্স নেই! Admin থেকে ব্যালেন্স নিন।', 'INSUFFICIENT_AGENT_BALANCE');
    }

    try {
      const uTx = await txIncrement(`users/${fresh.uid}/balance`, totalCredited);
      if (!uTx.committed) throw new Error('প্লেয়ার ব্যালেন্স আপডেট ব্যর্থ হয়েছে');

      if (bonusAmt > 0) await txIncrement(`users/${fresh.uid}/bonusBalance`, bonusAmt);
      if (turnoverAdded > 0) await txIncrement(`users/${fresh.uid}/turnoverRequired`, turnoverAdded);

      const trxKey = db.ref('transactions').push().key;
      const updates = {};
      updates[`depositRequests/${depId}/status`] = 'Approved';
      updates[`depositRequests/${depId}/approvedAt`] = getServerTimestamp();
      updates[`depositRequests/${depId}/approvedByAgent`] = actor.uid;
      updates[`depositRequests/${depId}/assignedAgentId`] = actor.uid;
      updates[`depositRequests/${depId}/bonusAmount`] = bonusAmt;
      updates[`depositRequests/${depId}/totalCredited`] = totalCredited;
      updates[`depositRequests/${depId}/turnoverAdded`] = turnoverAdded;
      updates[`depositRequests/${depId}/turnoverMultiplier`] = mult;
      updates[`depositRequests/${depId}/approvalLock`] = null;
      updates[`transactions/${trxKey}`] = {
        trxId: trxKey,
        refId: depId,
        uid: fresh.uid,
        playerName: fresh.playerName || fresh.userName || 'Player',
        agentUid: actor.uid,
        adminUid: effectiveAdmin,
        type: 'DEPOSIT',
        amount: totalCredited,
        depositAmount: amt,
        bonusAmount: bonusAmt,
        turnoverAdded,
        beforeBal: uTx.before,
        afterBal: uTx.after,
        method: fresh.method || 'bKash',
        paymentRef: fresh.trxId || fresh.trx || '',
        timestamp: getServerTimestamp(),
        note: `Verified & Approved by Agent ${agent.name || actor.uid} (Agent Wallet -${amt}${bonusAmt > 0 ? ` + Bonus ${bonusAmt}` : ''})`
      };
      await db.ref().update(updates);
      await txIncrement(`agents/${actor.uid}/totalProcessedDeposits`, amt).catch(() => {});
      await pushNotification({
        title: 'ডিপোজিট অনুমোদিত হয়েছে',
        body: `৳${amt}${bonusAmt > 0 ? ` + ৳${bonusAmt} বোনাস` : ''} ডিপোজিট আপনার ওয়ালেটে যুক্ত হয়েছে (Trx: ${fresh.trxId || depId})।`,
        targetUid: fresh.uid,
        category: 'WALLET'
      });
      await writeAuditLog(agent.email || actor.uid, 'AGENT_DEPOSIT_APPROVE', fresh.uid, `Deposit ${depId} approved (৳${amt}, Bonus ৳${bonusAmt})`, ip);
      return { status: 'Approved', agentBalance: agTx.after, userBalance: uTx.after, bonusAmount: bonusAmt, totalCredited };
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

  await acquireWithdrawalLock(withKey, actor.uid);

  try {
    const wSnap = await db.ref(`withdrawalRequests/${withKey}`).once('value');
    const fresh = wSnap.val();
    if (!fresh) {
      throw new ApiError(404, 'উইথড্র রিকোয়েস্ট পাওয়া যায়নি।', 'NOT_FOUND');
    }

    const st = String(fresh.status || '').toLowerCase();
    if (!['pending', 'processing', 'assignedtoagent'].includes(st)) {
      throw new ApiError(409, 'এই উইথড্র রিকোয়েস্ট ইতিমধ্যে সম্পন্ন বা বাতিল হয়েছে।', 'ALREADY_PROCESSED');
    }

    // Strict Condition: User Admin Verification + Forward MUST happen first
    if (fresh.adminVerified !== true || fresh.forwardedToAgent !== true) {
      throw new ApiError(
        403,
        'User Admin-এর যাচাই (Verification) ছাড়া কোনো উইথড্র Complete করা যাবে না!',
        'NOT_ADMIN_VERIFIED'
      );
    }

    // Strict Condition: ONLY the specifically Assigned Agent can complete
    if (fresh.assignedAgentId !== actor.uid) {
      throw new ApiError(
        403,
        'শুধুমাত্র নির্ধারিত Assigned Agent-ই এই উইথড্র পেমেন্ট কনফার্ম করে Complete করতে পারবেন।',
        'NOT_ASSIGNED'
      );
    }

    const amt = posAmount(fresh.amount, 'উইথড্র পরিমাণ');
    const agTx = await txIncrement(`agents/${actor.uid}/balance`, amt);
    if (!agTx.committed) throw new ApiError(500, 'এজেন্ট ব্যালেন্স আপডেট ব্যর্থ হয়েছে!', 'TX_FAILED');

    try {
      const stamp = getServerTimestamp();
      const trxKey = db.ref('transactions').push().key;
      const agentName = agent.name || agent.email || 'Agent';
      const updates = {};
      updates[`withdrawalRequests/${withKey}/status`] = 'Completed';
      updates[`withdrawalRequests/${withKey}/stage`] = 'COMPLETED';
      updates[`withdrawalRequests/${withKey}/paymentRef`] = paymentRef;
      updates[`withdrawalRequests/${withKey}/completedAt`] = stamp;
      updates[`withdrawalRequests/${withKey}/processedAt`] = stamp;
      updates[`withdrawalRequests/${withKey}/statusUpdatedAt`] = stamp;
      updates[`withdrawalRequests/${withKey}/completedByAgent`] = actor.uid;
      updates[`withdrawalRequests/${withKey}/completedByAgentName`] = agentName;
      updates[`withdrawalRequests/${withKey}/agentWalletBefore`] = agTx.before;
      updates[`withdrawalRequests/${withKey}/agentWalletAfter`] = agTx.after;
      updates[`withdrawalRequests/${withKey}/actionLock`] = null;
      updates[`withdrawalRequests/${withKey}/actionLockAt`] = null;

      updates[`transactions/${trxKey}`] = {
        trxId: trxKey,
        refId: withKey,
        requestId: withKey,
        uid: fresh.uid,
        playerName: fresh.playerName || fresh.userName || 'Player',
        agentUid: actor.uid,
        agentName,
        adminUid: fresh.adminUid || agent.parentAdminId || agent.adminUid || '',
        type: 'WITHDRAWAL',
        amount: amt,
        beforeBal: agTx.before,
        afterBal: agTx.after,
        method: fresh.method || 'bKash',
        paymentRef,
        status: 'Completed',
        date: new Date().toLocaleString('bn-BD'),
        timestamp: stamp,
        note: `Withdrawal Paid Manually & Confirmed by Assigned Agent ${agentName} (Agent Wallet +৳${amt}: ৳${agTx.before} -> ৳${agTx.after}, Trx: ${paymentRef})`
      };
      await db.ref().update(updates);
      await txIncrement(`agents/${actor.uid}/totalProcessedWithdrawals`, amt).catch(() => {});

      await pushNotification({
        title: 'উইথড্র পেমেন্ট সম্পন্ন',
        body: `আপনার ৳${amt} উইথড্র পেমেন্ট (${paymentRef}) এজেন্ট ${agentName} কর্তৃক সম্পন্ন হয়েছে।`,
        targetUid: fresh.uid,
        adminUid: fresh.adminUid || agent.parentAdminId || agent.adminUid || '',
        category: 'WALLET'
      });
      if (fresh.adminUid || agent.parentAdminId || agent.adminUid) {
        await pushNotification({
          title: 'উইথড্র পেমেন্ট কনফার্ম হয়েছে',
          body: `এজেন্ট ${agentName} ৳${amt} উইথড্র (${withKey}) পেমেন্ট সম্পন্ন করেছেন (Trx: ${paymentRef})। এজেন্ট ওয়ালেটে +৳${amt} যোগ হয়েছে।`,
          targetUid: fresh.adminUid || agent.parentAdminId || agent.adminUid,
          category: 'WITHDRAWAL'
        });
      }
      await writeAuditLog(
        agent.email || actor.uid,
        'AGENT_WITHDRAW_COMPLETE',
        withKey,
        `Player: ${fresh.uid}, Paid ৳${amt} (Trx: ${paymentRef}), Agent Wallet credited +৳${amt} (Before: ৳${agTx.before}, After: ৳${agTx.after})`,
        ip
      );
      return {
        status: 'Completed',
        stage: 'COMPLETED',
        agentBalance: agTx.after,
        agentWalletBefore: agTx.before,
        agentWalletAfter: agTx.after
      };
    } catch (innerErr) {
      await txIncrement(`agents/${actor.uid}/balance`, -amt).catch(() => {});
      throw innerErr;
    }
  } finally {
    await releaseWithdrawalLock(withKey);
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
    parentAdminId: agent.parentAdminId || agent.adminUid || '',
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
    parentAdminId: affiliate.parentAdminId || affiliate.adminUid || '',
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
      const awParent = aw.parentAdminId || aw.adminUid || '';
      if (adminUid && awParent && awParent !== adminUid) continue;
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

async function userRequestWithdrawal(actor, body, ip = '') {
  const db = getDb();
  const uSnap = await db.ref(`users/${actor.uid}`).once('value');
  const u = uSnap.val() || {};
  if (u.status === 'banned' || u.status === 'suspended') {
    throw new ApiError(403, 'আপনার অ্যাকাউন্ট স্থগিত করা হয়েছে।', 'ACCOUNT_SUSPENDED');
  }

  const adminUid = u.adminUid || String(body.adminUid || '').trim();
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
    const trxKey = db.ref('transactions').push().key;
    const stamp = getServerTimestamp();

    // STRICT WORKFLOW: Withdrawal goes to User Admin FIRST.
    // Never forwarded or assigned to any Agent until User Admin verifies & forwards!
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
      stage: 'ADMIN_PENDING',
      adminVerified: false,
      forwardedToAgent: false,
      assignedAgentId: '',
      assignedAgentName: '',
      preferredAgentId: String(u.assignedAgentId || ''),
      adminUid: adminUid || '',
      affiliateUid: u.affiliateUid || '',
      timestamp: Date.now(),
      createdAt: stamp
    };

    const updates = {};
    updates[`withdrawalRequests/${reqRef.key}`] = payload;
    updates[`transactions/${trxKey}`] = {
      trxId: trxKey,
      refId: reqRef.key,
      requestId: reqRef.key,
      uid: actor.uid,
      playerName: u.name || u.username || 'Player',
      adminUid: adminUid || '',
      type: 'WITHDRAW_REQUEST',
      amount: amt,
      beforeBal: balTx.before,
      afterBal: balTx.after,
      method,
      status: 'Pending',
      date: new Date().toLocaleString('bn-BD'),
      timestamp: stamp,
      note: `Withdrawal Request submitted to User Admin (${method}: ${accountDetails})`
    };
    await db.ref().update(updates);

    await writeAuditLog(
      u.email || u.phone || actor.uid,
      'WITHDRAWAL_REQUESTED',
      reqRef.key,
      `User requested ৳${amt} via ${method} (${accountDetails}) -> Routed to User Admin ${adminUid || 'NONE'} (Bal: ৳${balTx.before} -> ৳${balTx.after})`,
      ip
    );
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
  masterWithdrawalCompleteForbidden,
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
