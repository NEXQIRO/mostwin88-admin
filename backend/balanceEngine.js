'use strict';

const crypto = require('crypto');
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
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[৳,\s]/g, '');
    if (cleaned) {
      const n = Number(cleaned);
      if (Number.isFinite(n)) return n;
    }
  }
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
    let nullPassCount = 0;

    const runPass = async (seedExists, seedVal) => {
      sawServerValue = false;
      nullPassCount = 0;
      return ref.transaction(cur => {
        // Firebase Admin RTDB can invoke updateFn(null) on speculative local passes
        // before cache synchronization. Only treat cur as authoritative once we either
        // receive a non-null value or exhaust speculative null passes.
        if (cur === null || cur === undefined) {
          if (!sawServerValue && seedExists && nullPassCount < 5) {
            nullPassCount += 1;
            const nextSeed = Math.round((seedVal + delta) * 100) / 100;
            if (nextSeed < 0) return undefined;
            beforeVal = seedVal;
            afterVal = nextSeed;
            return nextSeed;
          }
        } else {
          sawServerValue = true;
        }
        const curNum = toNum(cur, 0);
        const nextNum = Math.round((curNum + delta) * 100) / 100;
        if (nextNum < 0) return undefined;
        beforeVal = curNum;
        afterVal = nextNum;
        return nextNum;
      });
    };

    let res = await runPass(preExists, preVal);

    if (!res.committed) {
      const retrySnap = await ref.once('value');
      const retryExists = retrySnap.exists();
      const retryVal = retryExists ? toNum(retrySnap.val(), 0) : 0;
      if (retryExists && Math.round((retryVal + delta) * 100) / 100 >= 0) {
        await new Promise(r => setTimeout(r, 60));
        res = await runPass(retryExists, retryVal);
      }
    }

    if (!res.committed) {
      const latestSnap = res.snapshot && res.snapshot.val() !== null && res.snapshot.val() !== undefined
        ? res.snapshot
        : await ref.once('value').catch(() => res.snapshot);
      return {
        committed: false,
        before: beforeVal,
        after: beforeVal,
        val: latestSnap ? latestSnap.val() : preVal
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

/* ==================== GAME AGGREGATOR & SEAMLESS WALLET ENGINE ==================== */

function safeRtdbKey(raw, fallback = 'item') {
  const s = String(raw || '')
    .trim()
    .replace(/[.#$\[\]\/\\\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return s || fallback;
}

function aggSlug(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function normalizeAggCategory(rawCat, defaultCat = '') {
  if (defaultCat) return defaultCat;
  const s = String(rawCat || '').toLowerCase();
  if (/live|dealer|baccarat|roulette|blackjack|teen|andar|crazy|monopoly/.test(s)) return 'Live Casino';
  if (/crash|arcade|aviator|mines|plinko|jetx|instant|mini/.test(s)) return 'Crash & Arcade';
  if (/fish|fishing|ocean|hunter/.test(s)) return 'Fishing';
  if (/table|poker|holdem|ludo|carrom|sic/.test(s)) return 'Table Games';
  if (/sport|cricket|football|soccer|virtual/.test(s)) return 'Sports';
  return 'Slots';
}

function categoryIconFor(cat) {
  switch (cat) {
    case 'Live Casino': return '🎡';
    case 'Crash & Arcade': return '🚀';
    case 'Fishing': return '🐟';
    case 'Table Games': return '🃏';
    case 'Sports': return '🏏';
    default: return '🎰';
  }
}

function fillAggTemplate(tpl, vars) {
  return String(tpl || '')
    .replace(/\{uid\}/g, encodeURIComponent(String(vars.uid || '')))
    .replace(/\{username\}/g, encodeURIComponent(String(vars.username || '')))
    .replace(/\{gameCode\}/g, encodeURIComponent(String(vars.gameCode || '')))
    .replace(/\{provider\}/g, encodeURIComponent(String(vars.provider || '')))
    .replace(/\{currency\}/g, encodeURIComponent(String(vars.currency || 'BDT')))
    .replace(/\{lang\}/g, encodeURIComponent(String(vars.lang || 'bn')))
    .replace(/\{balance\}/g, encodeURIComponent(String(vars.balance != null ? vars.balance : 0)))
    .replace(/\{operator\}/g, encodeURIComponent(String(vars.operatorCode || '')))
    .replace(/\{agentId\}/g, encodeURIComponent(String(vars.agentId || '')))
    .replace(/\{sessionToken\}/g, encodeURIComponent(String(vars.sessionToken || '')))
    .replace(/\{token\}/g, encodeURIComponent(String(vars.sessionToken || '')))
    .replace(/\{returnUrl\}/g, encodeURIComponent(String(vars.returnUrl || '')))
    .replace(/\{callbackUrl\}/g, encodeURIComponent(String(vars.callbackUrl || '')))
    .replace(/\{apiKey\}/g, encodeURIComponent(String(vars.apiKey || '')));
}

function normalizeIp(ip) {
  const raw = String(ip || '').trim();
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function isMaskedSecret(v) {
  return typeof v === 'string' && (/^[•*]+$/.test(v.trim()) || v.trim() === '__KEEP__');
}

async function getStoredAggregatorConfig(adminUid = '') {
  const db = getDb();
  const [secSnap, gApiSnap, aApiSnap, uaOnSnap] = await Promise.all([
    db.ref('gameAggregatorSecrets/config').once('value'),
    db.ref('userPanelConfig/global/gameApi').once('value'),
    adminUid ? db.ref(`userPanelConfig/byAdmin/${adminUid}/gameApi`).once('value') : Promise.resolve({ val: () => null }),
    db.ref('adminSettings/userAdminOn').once('value')
  ]);
  const sec = secSnap.val() || {};
  const pub = gApiSnap.val() || {};
  const uaOn = uaOnSnap.val() !== false;
  const admPub = uaOn && aApiSnap.val() ? aApiSnap.val() : {};

  return {
    enabled: sec.enabled !== undefined ? !!sec.enabled : !!(admPub.enabled !== undefined ? admPub.enabled : pub.enabled),
    providerName: sec.providerName || admPub.providerName || pub.providerName || '',
    walletMode: sec.walletMode || admPub.walletMode || pub.walletMode || 'seamless',
    mode: sec.mode || admPub.mode || pub.mode || 'rest_post',
    openMode: sec.openMode || admPub.openMode || pub.openMode || 'iframe',
    baseUrl: sec.baseUrl || pub.baseUrl || '',
    launchUrl: sec.launchUrl || admPub.launchUrl || pub.launchUrl || '',
    gameListUrl: sec.gameListUrl || '',
    callbackUrl: sec.callbackUrl || '',
    operatorCode: sec.operatorCode || admPub.operatorCode || pub.operatorCode || '',
    agentId: sec.agentId || '',
    apiKey: sec.apiKey || pub.apiKey || '',
    apiSecret: sec.apiSecret || pub.apiSecret || '',
    webhookSecret: sec.webhookSecret || '',
    authMethod: sec.authMethod || 'bearer_xapikey',
    signHeader: sec.signHeader || 'X-Sign',
    currency: sec.currency || admPub.currency || pub.currency || 'BDT',
    lang: sec.lang || admPub.lang || pub.lang || 'bn',
    whitelistIps: sec.whitelistIps || '',
    customHeadersJson: sec.customHeadersJson || '',
    updatedAt: sec.updatedAt || pub.updatedAt || null,
    updatedBy: sec.updatedBy || ''
  };
}

function buildAggAuthRequest(cfg, rawUrl, method, payloadObj, templateVars) {
  const httpMethod = String(method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const resolvedUrl = fillAggTemplate(rawUrl, Object.assign({}, templateVars, {
    operatorCode: cfg.operatorCode || '',
    agentId: cfg.agentId || '',
    apiKey: cfg.apiKey || '',
    currency: cfg.currency || 'BDT',
    lang: cfg.lang || 'bn',
    callbackUrl: cfg.callbackUrl || ''
  }));

  let parsedCustomHeaders = {};
  if (cfg.customHeadersJson) {
    try {
      const parsed = JSON.parse(cfg.customHeadersJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedCustomHeaders = parsed;
      }
    } catch (_) {}
  }

  const headers = Object.assign({ Accept: 'application/json' }, parsedCustomHeaders);
  const bodyObj = Object.assign({}, payloadObj || {});

  if (cfg.authMethod === 'body_credentials') {
    if (cfg.apiKey && bodyObj.apiKey === undefined) bodyObj.apiKey = cfg.apiKey;
    if (cfg.apiSecret && bodyObj.apiSecret === undefined) bodyObj.apiSecret = cfg.apiSecret;
    if (cfg.operatorCode && bodyObj.operatorCode === undefined) bodyObj.operatorCode = cfg.operatorCode;
    if (cfg.agentId && bodyObj.agentId === undefined) bodyObj.agentId = cfg.agentId;
  } else if (cfg.authMethod === 'bearer_xapikey' || !cfg.authMethod) {
    if (cfg.apiKey) {
      if (!headers['X-API-Key']) headers['X-API-Key'] = cfg.apiKey;
      if (!headers['Authorization']) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }
  } else {
    if (cfg.apiKey && !headers['X-API-Key']) headers['X-API-Key'] = cfg.apiKey;
  }

  const rawBodyStr = httpMethod === 'GET' ? '' : JSON.stringify(bodyObj);
  const signTarget = httpMethod === 'GET' ? resolvedUrl : rawBodyStr;
  const signKey = cfg.apiSecret || cfg.apiKey || '';
  const signHdr = cfg.signHeader || 'X-Sign';

  if (cfg.authMethod === 'hmac_sha256' && signKey) {
    headers[signHdr] = crypto.createHmac('sha256', signKey).update(signTarget).digest('hex');
  } else if (cfg.authMethod === 'hmac_sha1' && signKey) {
    headers[signHdr] = crypto.createHmac('sha1', signKey).update(signTarget).digest('hex');
  } else if (cfg.authMethod === 'md5_sign' && signKey) {
    const md5Hex = crypto.createHash('md5').update(signTarget + signKey).digest('hex');
    headers[signHdr] = md5Hex;
    if (httpMethod !== 'GET') bodyObj.sign = md5Hex;
  }

  const fetchOpts = {
    method: httpMethod,
    headers
  };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    fetchOpts.signal = AbortSignal.timeout(15000);
  }
  if (httpMethod !== 'GET') {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = cfg.authMethod === 'md5_sign' ? JSON.stringify(bodyObj) : rawBodyStr;
  }

  return { resolvedUrl, fetchOpts };
}

function extractGamesArrayFromPayload(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const candidates = [
    json.games,
    json.data,
    json.list,
    json.items,
    json.result,
    json.response,
    json.data && json.data.games,
    json.data && json.data.list,
    json.data && json.data.items,
    json.result && json.result.games,
    json.result && json.result.list
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function extractLaunchUrlFromPayload(json) {
  if (!json || typeof json !== 'object') return '';
  return String(
    json.gameUrl ||
    json.url ||
    json.launch_url ||
    json.launchUrl ||
    json.game_url ||
    (json.data && (json.data.url || json.data.gameUrl || json.data.launch_url || json.data.launchUrl || json.data.game_url)) ||
    (json.result && (json.result.url || json.result.gameUrl || json.result.launch_url)) ||
    ''
  ).trim();
}

async function logAggregatorEvent(entry) {
  try {
    const db = getDb();
    await db.ref('aggregatorLogs').push({
      type: String(entry.type || 'EVENT'),
      status: String(entry.status || 'INFO'),
      httpStatus: entry.httpStatus != null ? entry.httpStatus : null,
      latencyMs: entry.latencyMs != null ? entry.latencyMs : null,
      uid: String(entry.uid || ''),
      trxId: String(entry.trxId || ''),
      provider: String(entry.provider || ''),
      gameCode: String(entry.gameCode || ''),
      amount: entry.amount != null ? toNum(entry.amount, 0) : null,
      message: String(entry.message || '').slice(0, 350),
      ip: String(entry.ip || ''),
      timestamp: Date.now()
    });
  } catch (_) {}
}

async function masterAggregatorSave(actor, body, ip = '') {
  const db = getDb();
  const prev = await getStoredAggregatorConfig();
  const pickSecret = (nextVal, prevVal) => {
    if (nextVal === undefined || isMaskedSecret(nextVal)) return String(prevVal || '');
    return String(nextVal || '').trim();
  };

  if (body.customHeadersJson) {
    let parsed;
    try {
      parsed = JSON.parse(String(body.customHeadersJson));
    } catch (err) {
      throw new ApiError(400, 'Extra Custom Headers JSON সঠিক নয়।', 'INVALID_HEADERS_JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 'Extra Custom Headers অবশ্যই JSON Object হতে হবে।', 'INVALID_HEADERS_JSON');
    }
  }

  const nowTs = Date.now();
  const nextCfg = {
    enabled: body.enabled !== undefined ? !!body.enabled : !!prev.enabled,
    providerName: String(body.providerName !== undefined ? body.providerName : prev.providerName || 'Custom Game Aggregator').trim(),
    walletMode: String(body.walletMode || prev.walletMode || 'seamless').trim(),
    mode: String(body.mode || prev.mode || 'rest_post').trim(),
    openMode: String(body.openMode || prev.openMode || 'iframe').trim(),
    baseUrl: String(body.baseUrl !== undefined ? body.baseUrl : prev.baseUrl || '').trim(),
    launchUrl: String(body.launchUrl !== undefined ? body.launchUrl : prev.launchUrl || '').trim(),
    gameListUrl: String(body.gameListUrl !== undefined ? body.gameListUrl : prev.gameListUrl || '').trim(),
    callbackUrl: String(body.callbackUrl !== undefined ? body.callbackUrl : prev.callbackUrl || '').trim(),
    operatorCode: String(body.operatorCode !== undefined ? body.operatorCode : prev.operatorCode || '').trim(),
    agentId: String(body.agentId !== undefined ? body.agentId : prev.agentId || '').trim(),
    apiKey: pickSecret(body.apiKey, prev.apiKey),
    apiSecret: pickSecret(body.apiSecret, prev.apiSecret),
    webhookSecret: pickSecret(body.webhookSecret, prev.webhookSecret),
    authMethod: String(body.authMethod || prev.authMethod || 'bearer_xapikey').trim(),
    signHeader: String(body.signHeader || prev.signHeader || 'X-Sign').trim(),
    currency: String(body.currency || prev.currency || 'BDT').trim(),
    lang: String(body.lang || prev.lang || 'bn').trim(),
    whitelistIps: String(body.whitelistIps !== undefined ? body.whitelistIps : prev.whitelistIps || '').trim(),
    customHeadersJson: String(body.customHeadersJson !== undefined ? body.customHeadersJson : prev.customHeadersJson || '').trim(),
    updatedAt: nowTs,
    updatedBy: actor.email || actor.uid
  };

  if (nextCfg.enabled && !nextCfg.launchUrl) {
    throw new ApiError(400, 'Aggregator চালু রাখতে Launch Endpoint / URL Template দিন।', 'MISSING_LAUNCH_URL');
  }

  // Strictly separated: secrets stored ONLY in gameAggregatorSecrets/config,
  // safe public metadata projected to userPanelConfig/global/gameApi.
  const publicGameApi = {
    enabled: nextCfg.enabled,
    providerName: nextCfg.providerName,
    walletMode: nextCfg.walletMode,
    mode: nextCfg.mode,
    openMode: nextCfg.openMode,
    operatorCode: nextCfg.operatorCode,
    currency: nextCfg.currency,
    lang: nextCfg.lang,
    launchUrl: nextCfg.mode === 'direct_iframe' ? nextCfg.launchUrl : '',
    updatedAt: nowTs
  };

  await db.ref().update({
    'gameAggregatorSecrets/config': nextCfg,
    'userPanelConfig/global/gameApi': publicGameApi
  });

  await Promise.all([
    logAggregatorEvent({
      type: 'CONFIG_SAVE',
      status: 'OK',
      httpStatus: 200,
      uid: actor.uid,
      provider: nextCfg.providerName,
      message: `Saved aggregator config (enabled=${nextCfg.enabled}, mode=${nextCfg.mode}, wallet=${nextCfg.walletMode})`,
      ip
    }),
    writeAuditLog(
      actor.email || actor.uid,
      'AGGREGATOR_CONFIG_SAVED',
      nextCfg.providerName,
      `enabled=${nextCfg.enabled}, mode=${nextCfg.mode}, walletMode=${nextCfg.walletMode}`,
      ip
    )
  ]);

  return { config: nextCfg, publicConfig: publicGameApi };
}

async function masterAggregatorTest(actor, body, ip = '') {
  const stored = await getStoredAggregatorConfig();
  const cfg = Object.assign({}, stored, {
    providerName: body.providerName !== undefined ? String(body.providerName).trim() : stored.providerName,
    mode: body.mode || stored.mode,
    baseUrl: body.baseUrl !== undefined ? String(body.baseUrl).trim() : stored.baseUrl,
    launchUrl: body.launchUrl !== undefined ? String(body.launchUrl).trim() : stored.launchUrl,
    gameListUrl: body.gameListUrl !== undefined ? String(body.gameListUrl).trim() : stored.gameListUrl,
    callbackUrl: body.callbackUrl !== undefined ? String(body.callbackUrl).trim() : stored.callbackUrl,
    operatorCode: body.operatorCode !== undefined ? String(body.operatorCode).trim() : stored.operatorCode,
    agentId: body.agentId !== undefined ? String(body.agentId).trim() : stored.agentId,
    apiKey: body.apiKey && !isMaskedSecret(body.apiKey) ? String(body.apiKey).trim() : stored.apiKey,
    apiSecret: body.apiSecret && !isMaskedSecret(body.apiSecret) ? String(body.apiSecret).trim() : stored.apiSecret,
    authMethod: body.authMethod || stored.authMethod,
    signHeader: body.signHeader || stored.signHeader,
    currency: body.currency || stored.currency,
    lang: body.lang || stored.lang,
    customHeadersJson: body.customHeadersJson !== undefined ? String(body.customHeadersJson).trim() : stored.customHeadersJson
  });

  const testType = body.testType === 'gamelist' ? 'gamelist' : 'launch';
  const targetUrl = testType === 'gamelist' ? cfg.gameListUrl : cfg.launchUrl;
  if (!targetUrl) {
    throw new ApiError(400, `${testType === 'gamelist' ? 'Game List' : 'Launch'} Endpoint URL দেওয়া হয়নি।`, 'MISSING_ENDPOINT');
  }

  const gameCode = String(body.gameCode || 'aviator').trim();
  const sessionToken = 'test_' + crypto.randomBytes(8).toString('hex');
  const vars = {
    uid: actor.uid,
    username: 'master_test',
    gameCode,
    provider: cfg.providerName || 'casino',
    balance: 1000,
    sessionToken,
    returnUrl: 'https://mostwin88.app',
    callbackUrl: cfg.callbackUrl || ''
  };

  if (testType === 'launch' && cfg.mode === 'direct_iframe') {
    const resolved = fillAggTemplate(targetUrl, Object.assign({}, vars, cfg));
    await logAggregatorEvent({
      type: 'API_TEST_LAUNCH',
      status: 'OK',
      httpStatus: 200,
      latencyMs: 0,
      uid: actor.uid,
      provider: cfg.providerName,
      gameCode,
      message: 'Direct iframe template resolved',
      ip
    });
    return {
      httpStatus: 200,
      latencyMs: 0,
      resolvedUrl: resolved,
      extractedLaunchUrl: resolved,
      preview: 'Direct Iframe Template Mode (no outbound proxy call needed).'
    };
  }

  const httpMethod = testType === 'gamelist' ? 'GET' : (cfg.mode === 'rest_get' ? 'GET' : 'POST');
  const payload = testType === 'gamelist'
    ? {}
    : {
        operatorCode: cfg.operatorCode || '',
        agentId: cfg.agentId || '',
        uid: vars.uid,
        username: vars.username,
        gameCode,
        provider: vars.provider,
        currency: cfg.currency || 'BDT',
        lang: cfg.lang || 'bn',
        balance: vars.balance,
        sessionToken,
        returnUrl: vars.returnUrl,
        callbackUrl: vars.callbackUrl
      };

  const { resolvedUrl, fetchOpts } = buildAggAuthRequest(cfg, targetUrl, httpMethod, payload, vars);
  const t0 = Date.now();
  let resp;
  let text = '';
  try {
    resp = await fetch(resolvedUrl, fetchOpts);
    text = await resp.text();
  } catch (err) {
    const latencyMs = Date.now() - t0;
    await logAggregatorEvent({
      type: testType === 'gamelist' ? 'API_TEST_GAMELIST' : 'API_TEST_LAUNCH',
      status: 'ERROR',
      httpStatus: 502,
      latencyMs,
      uid: actor.uid,
      provider: cfg.providerName,
      gameCode,
      message: err.message || 'Fetch failed',
      ip
    });
    throw new ApiError(502, `Aggregator সংযোগ ব্যর্থ: ${err.message || err}`, 'AGGREGATOR_UNREACHABLE');
  }

  const latencyMs = Date.now() - t0;
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  const extractedLaunchUrl = testType === 'launch' ? extractLaunchUrlFromPayload(json) : '';
  const extractedGames = testType === 'gamelist' ? extractGamesArrayFromPayload(json) : [];
  const extractedGamesCount = extractedGames.length;
  const preview = (json ? JSON.stringify(json, null, 2) : text).slice(0, 1200);

  await logAggregatorEvent({
    type: testType === 'gamelist' ? 'API_TEST_GAMELIST' : 'API_TEST_LAUNCH',
    status: resp.ok ? 'OK' : 'WARN',
    httpStatus: resp.status,
    latencyMs,
    uid: actor.uid,
    provider: cfg.providerName,
    gameCode,
    message: testType === 'gamelist'
      ? `HTTP ${resp.status} · Detected ${extractedGamesCount} games`
      : `HTTP ${resp.status} · Launch URL ${extractedLaunchUrl ? 'found' : 'missing'}`,
    ip
  });

  return {
    httpStatus: resp.status,
    latencyMs,
    resolvedUrl,
    extractedLaunchUrl,
    extractedGamesCount,
    preview
  };
}

async function masterAggregatorSyncGames(actor, body, ip = '') {
  const db = getDb();
  const cfg = await getStoredAggregatorConfig();
  const providerFilter = String(body.providerFilter || '').trim().toLowerCase();
  const defaultCategory = String(body.defaultCategory || '').trim();
  const alsoAddPopular = !!body.alsoAddPopular;

  let rawItems = [];
  if (body.gamesJson !== undefined && body.gamesJson !== '') {
    let parsed = body.gamesJson;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch (err) {
        throw new ApiError(400, 'Bulk JSON ফরম্যাট সঠিক নয়: ' + err.message, 'INVALID_GAMES_JSON');
      }
    }
    rawItems = extractGamesArrayFromPayload(parsed);
    if (!rawItems.length) {
      throw new ApiError(400, 'JSON থেকে কোনো গেম অ্যারে পাওয়া যায়নি।', 'EMPTY_GAME_LIST');
    }
  } else {
    const gameListUrl = String(body.gameListUrl || cfg.gameListUrl || '').trim();
    if (!gameListUrl) {
      throw new ApiError(400, 'Game List API Endpoint URL দিন।', 'MISSING_GAMELIST_URL');
    }
    const listMethod = String(body.listMethod || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
    const payload = listMethod === 'POST' ? {
      operatorCode: cfg.operatorCode || '',
      agentId: cfg.agentId || '',
      currency: cfg.currency || 'BDT',
      lang: cfg.lang || 'bn'
    } : {};
    const { resolvedUrl, fetchOpts } = buildAggAuthRequest(cfg, gameListUrl, listMethod, payload, {
      uid: actor.uid,
      username: 'master_sync',
      gameCode: '',
      provider: cfg.providerName || ''
    });
    const resp = await fetch(resolvedUrl, fetchOpts).catch(err => {
      throw new ApiError(502, `Game List API সংযোগ ব্যর্থ: ${err.message || err}`, 'GAMELIST_FETCH_FAILED');
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok || !json) {
      throw new ApiError(502, `Game List API থেকে বৈধ JSON পাওয়া যায়নি (HTTP ${resp.status})।`, 'INVALID_GAMELIST_RESPONSE');
    }
    rawItems = extractGamesArrayFromPayload(json);
    if (!rawItems.length) {
      throw new ApiError(400, 'Aggregator Response-এ কোনো গেম পাওয়া যায়নি।', 'EMPTY_GAME_LIST');
    }
  }

  const existingProvsSnap = await db.ref('providers').once('value');
  const existingProvs = existingProvsSnap.val() || {};
  const provLookupByNameCat = new Map();
  const provLookupByName = new Map();
  Object.entries(existingProvs).forEach(([pid, pv]) => {
    if (!pv || !pv.name) return;
    const nm = String(pv.name).trim().toLowerCase();
    const ct = String(pv.category || 'Slots').trim().toLowerCase();
    provLookupByNameCat.set(`${nm}::${ct}`, pid);
    if (!provLookupByName.has(nm)) provLookupByName.set(nm, pid);
  });

  const nowTs = Date.now();
  const updates = {};
  const syncedProviders = new Set();
  let gamesCount = 0;
  let popularCount = 0;
  let maxProvOrder = Object.keys(existingProvs).length + 90;

  rawItems.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    const gName = String(raw.name || raw.gameName || raw.game_name || raw.title || '').trim();
    if (!gName) return;
    const provName = String(
      raw.provider || raw.providerName || raw.provider_name || raw.vendor || raw.brand || cfg.providerName || 'Aggregator'
    ).trim();
    if (providerFilter && !provName.toLowerCase().includes(providerFilter)) return;

    const cat = normalizeAggCategory(raw.category || raw.game_type || raw.type || '', defaultCategory);
    const gCode = String(
      raw.gameCode || raw.game_code || raw.apiGameCode || raw.code || raw.game_id || raw.slug || raw.id || aggSlug(gName)
    ).trim();
    const provApiCode = String(raw.providerApi || raw.providerCode || raw.provider_code || raw.vendorCode || provName).trim();
    const img = String(raw.image || raw.imageUrl || raw.img || raw.thumbnail || raw.thumb || raw.icon || raw.logo || '').trim();
    const directUrl = String(raw.url || raw.gameUrl || raw.game_url || '').trim();
    const isPop = alsoAddPopular || raw.popular === true || raw.pop === 1 || raw.hot === true;

    const canonicalId = `${aggSlug(provName)}_${aggSlug(cat)}`;
    const matchedPid =
      (existingProvs[canonicalId] ? canonicalId : null) ||
      provLookupByNameCat.get(`${provName.toLowerCase()}::${cat.toLowerCase()}`) ||
      provLookupByName.get(provName.toLowerCase()) ||
      canonicalId;
    const provId = safeRtdbKey(matchedPid, 'agg_provider');

    if (!syncedProviders.has(provId)) {
      syncedProviders.add(provId);
      const prevP = existingProvs[provId] || {};
      maxProvOrder += 1;
      updates[`providers/${provId}`] = {
        id: provId,
        name: prevP.name || provName,
        category: prevP.category || cat,
        apiCode: prevP.apiCode || provApiCode,
        logo: prevP.logo || '',
        banner: prevP.banner || '',
        order: prevP.order != null ? prevP.order : maxProvOrder,
        active: prevP.active !== false,
        maintenance: !!prevP.maintenance,
        source: prevP.isDefault ? (prevP.source || 'merged') : 'aggregator',
        updatedAt: nowTs
      };
    }

    const gameId = safeRtdbKey(raw.id || `${provId}_${gCode || aggSlug(gName) || idx}`, `g_${idx}`);
    updates[`provider_games/${provId}/${gameId}`] = {
      id: gameId,
      name: gName,
      gameCode: gCode,
      apiGameCode: gCode,
      code: gCode,
      provider: provName,
      providerApi: provApiCode,
      category: cat,
      thumbnail: img,
      img,
      image: img,
      url: directUrl,
      order: raw.order != null ? Number(raw.order) : idx,
      active: raw.active !== false && raw.status !== 'Inactive',
      maintenance: !!raw.maintenance,
      source: 'aggregator',
      updatedAt: nowTs
    };
    gamesCount += 1;

    if (isPop) {
      popularCount += 1;
      updates[`games/${gameId}`] = {
        id: gameId,
        name: gName,
        icon: categoryIconFor(cat),
        category: cat,
        image: img,
        imageUrl: img,
        img,
        url: directUrl,
        gameUrl: directUrl,
        gameCode: gCode,
        apiGameCode: gCode,
        provider: provName,
        providerApi: provApiCode,
        popular: true,
        status: 'Active',
        active: true,
        isActive: true,
        source: 'aggregator',
        order: raw.order != null ? Number(raw.order) : (200 + idx),
        updatedAt: nowTs
      };
    }
  });

  if (!gamesCount) {
    throw new ApiError(400, 'ফিল্টারের সাথে মিলে এমন কোনো বৈধ গেম পাওয়া যায়নি।', 'NO_MATCHING_GAMES');
  }

  // Commit in chunks of 400 multi-path entries to stay comfortably within RTDB payload limits
  const allEntries = Object.entries(updates);
  for (let i = 0; i < allEntries.length; i += 400) {
    const chunk = Object.fromEntries(allEntries.slice(i, i + 400));
    await db.ref().update(chunk);
  }

  await Promise.all([
    logAggregatorEvent({
      type: 'SYNC_GAMES',
      status: 'OK',
      httpStatus: 200,
      uid: actor.uid,
      provider: cfg.providerName,
      message: `Synced ${gamesCount} games across ${syncedProviders.size} providers (popular: ${popularCount})`,
      ip
    }),
    writeAuditLog(
      actor.email || actor.uid,
      'AGGREGATOR_SYNC_GAMES',
      cfg.providerName || 'Aggregator',
      `Providers=${syncedProviders.size}, Games=${gamesCount}, Popular=${popularCount}`,
      ip
    )
  ]);

  return {
    providersCount: syncedProviders.size,
    gamesCount,
    popularCount
  };
}

async function resolveUidForAggregator(body) {
  const db = getDb();
  const directUid = String(body.uid || body.userId || body.user_id || body.playerId || body.player_id || '').trim();
  const token = String(body.sessionToken || body.token || body.session_id || '').trim();
  let session = null;

  if (token) {
    const sSnap = await db.ref(`aggregatorSessions/${safeRtdbKey(token, '')}`).once('value');
    if (sSnap.exists()) session = sSnap.val();
  }

  if (directUid) {
    const uSnap = await db.ref(`users/${directUid}`).once('value');
    if (uSnap.exists()) return { uid: directUid, user: uSnap.val(), session };
  }

  if (session && session.uid) {
    const uSnap = await db.ref(`users/${session.uid}`).once('value');
    if (uSnap.exists()) return { uid: session.uid, user: uSnap.val(), session };
  }

  const username = String(body.username || body.account || '').trim().toLowerCase();
  if (username) {
    const unSnap = await db.ref(`usernames/${safeRtdbKey(username, '')}`).once('value');
    const unVal = unSnap.val();
    const mappedUid = typeof unVal === 'string' ? unVal : (unVal && unVal.uid);
    if (mappedUid) {
      const uSnap = await db.ref(`users/${mappedUid}`).once('value');
      if (uSnap.exists()) return { uid: mappedUid, user: uSnap.val(), session };
    }
  }

  return { uid: '', user: null, session };
}

function normalizeCallbackAction(rawAction) {
  const a = String(rawAction || 'balance').trim().toLowerCase();
  if (['balance', 'get_balance', 'getbalance', 'check_balance', 'wallet'].includes(a)) return 'balance';
  if (['bet', 'debit', 'place_bet', 'placebet', 'withdraw', 'wager'].includes(a)) return 'bet';
  if (['win', 'credit', 'payout', 'settle', 'deposit', 'prize'].includes(a)) return 'win';
  if (['bet_win', 'betwin', 'debit_credit', 'spin', 'play', 'bet_and_win'].includes(a)) return 'bet_win';
  if (['rollback', 'refund', 'cancel', 'void', 'reverse'].includes(a)) return 'rollback';
  return a;
}

async function applyAggregatorBetTurnoverAndTx({ uid, u, adminUid, gameName, provider, gameCode, betAmount, winAmount, trxId, sessionToken, gameSessionId, afterTotalBal }) {
  const db = getDb();
  const nowTs = Date.now();
  const updates = {};

  if (betAmount > 0) {
    await txIncrement(`users/${uid}/betCount`, 1);
    await txIncrement(`users/${uid}/turnoverDone`, betAmount);
    await txIncrement(`users/${uid}/turnoverCompleted`, betAmount);
    const xpGain = Math.floor(betAmount / 10);
    if (xpGain > 0) {
      await txIncrement(`users/${uid}/xp`, xpGain);
    }

    // Update all incomplete Promo Turnover trackers for this player
    const promoSnap = await db.ref(`promoTurnover/${uid}`).once('value');
    if (promoSnap.exists()) {
      const promos = promoSnap.val() || {};
      for (const [pid, p] of Object.entries(promos)) {
        if (!p || p.completed === true) continue;
        const req = toNum(p.required, 0);
        const curDone = toNum(p.completedAmount != null ? p.completedAmount : p.progress, 0);
        const nextDone = Math.round((curDone + betAmount) * 100) / 100;
        const isDone = req > 0 ? nextDone >= req : false;
        updates[`promoTurnover/${uid}/${pid}/completedAmount`] = nextDone;
        updates[`promoTurnover/${uid}/${pid}/progress`] = nextDone;
        updates[`promoTurnover/${uid}/${pid}/completed`] = isDone;
        updates[`promoTurnover/${uid}/${pid}/updatedAt`] = nowTs;
        if (isDone && !p.completedAt) {
          updates[`promoTurnover/${uid}/${pid}/completedAt`] = nowTs;
        }
      }
    }

    const betTxKey = db.ref('game_transactions').push().key;
    updates[`game_transactions/${betTxKey}`] = {
      id: betTxKey,
      uid,
      adminUid: adminUid || u.adminUid || '',
      game: gameName,
      gameName,
      provider,
      gameCode,
      type: 'game_bet',
      amount: betAmount,
      bet: betAmount,
      win: 0,
      payout: 0,
      net: -betAmount,
      balance: winAmount > 0 ? Math.max(0, Math.round((afterTotalBal - winAmount) * 100) / 100) : afterTotalBal,
      trxId,
      sessionToken: sessionToken || '',
      source: 'aggregator',
      time: nowTs,
      timestamp: nowTs
    };
  }

  if (winAmount > 0) {
    const winTxKey = db.ref('game_transactions').push().key;
    updates[`game_transactions/${winTxKey}`] = {
      id: winTxKey,
      uid,
      adminUid: adminUid || u.adminUid || '',
      game: gameName,
      gameName,
      provider,
      gameCode,
      type: 'game_win',
      amount: winAmount,
      bet: 0,
      win: winAmount,
      payout: winAmount,
      net: winAmount,
      balance: afterTotalBal,
      trxId,
      sessionToken: sessionToken || '',
      source: 'aggregator',
      time: nowTs,
      timestamp: nowTs
    };
  }

  if (Object.keys(updates).length) {
    await db.ref().update(updates);
  }

  if (gameSessionId) {
    const gsRef = db.ref(`game_sessions/${safeRtdbKey(gameSessionId, '')}`);
    const gsSnap = await gsRef.once('value').catch(() => null);
    if (gsSnap && gsSnap.exists()) {
      const gs = gsSnap.val() || {};
      const nextBetCnt = toNum(gs.betCount, 0) + (betAmount > 0 ? 1 : 0);
      const nextBetAmt = Math.round((toNum(gs.betAmt, 0) + betAmount) * 100) / 100;
      const nextWinAmt = Math.round((toNum(gs.winAmt, 0) + winAmount) * 100) / 100;
      const entryBal = toNum(gs.entryBalance, afterTotalBal);
      await gsRef.update({
        betCount: nextBetCnt,
        betAmt: nextBetAmt,
        winAmt: nextWinAmt,
        exitBalance: afterTotalBal,
        netWinLoss: Math.round((afterTotalBal - entryBal) * 100) / 100,
        lastBetAt: nowTs
      }).catch(() => {});
    }
  }
}

async function processAggregatorCallback(rawAction, body, opts = {}) {
  const db = getDb();
  const cfg = await getStoredAggregatorConfig();
  const dryRun = !!opts.dryRun;
  const isSimulated = !!opts.isSimulated;
  const ip = String(opts.ip || '');

  if (!isSimulated && cfg.enabled === false) {
    throw new ApiError(403, 'Game Aggregator API বর্তমানে বন্ধ আছে।', 'AGGREGATOR_DISABLED');
  }

  const action = normalizeCallbackAction(rawAction || body.action || body.type || body.cmd || body.method || 'balance');
  if (!['balance', 'bet', 'win', 'bet_win', 'rollback'].includes(action)) {
    throw new ApiError(400, `অজানা Callback অ্যাকশন: ${action}`, 'INVALID_CALLBACK_ACTION');
  }

  const { uid, user, session } = await resolveUidForAggregator(body);
  if (!uid || !user) {
    throw new ApiError(404, 'প্লেয়ার পাওয়া যায়নি।', 'PLAYER_NOT_FOUND');
  }
  const statusStr = String(user.status || '').toLowerCase();
  if (statusStr === 'banned' || statusStr === 'suspended') {
    throw new ApiError(403, 'প্লেয়ার অ্যাকাউন্ট স্থগিত আছে।', 'PLAYER_SUSPENDED');
  }

  const currency = String(body.currency || (session && session.currency) || cfg.currency || 'BDT');
  const gameCode = String(body.gameCode || body.game_code || (session && session.gameCode) || 'aggregator_game').trim();
  const provider = String(body.provider || (session && session.provider) || cfg.providerName || 'Aggregator').trim();
  const gameName = String(body.gameName || body.game || (session && session.gameName) || gameCode || 'Aggregator Game').trim();
  const sessionToken = String(body.sessionToken || body.token || body.session_id || (session && session.sessionToken) || '').trim();
  const gameSessionId = session && session.gameSessionId ? String(session.gameSessionId) : '';
  const trxIdRaw = String(body.trxId || body.txId || body.transactionId || body.transaction_id || body.roundId || `${action}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`).trim();
  const trxKey = safeRtdbKey(trxIdRaw, `tx_${Date.now()}`);

  const curMain = toNum(user.balance, 0);
  const curBonus = toNum(user.bonusBalance, 0);
  const beforeTotal = Math.round((curMain + curBonus) * 100) / 100;

  let betAmount = 0;
  let winAmount = 0;
  if (action === 'bet') {
    betAmount = posAmount(body.betAmount !== undefined ? body.betAmount : (body.amount !== undefined ? body.amount : body.debit), 'বেট পরিমাণ');
  } else if (action === 'win') {
    const rawW = toNum(body.winAmount !== undefined ? body.winAmount : (body.amount !== undefined ? body.amount : body.credit), 0);
    if (rawW < 0) throw new ApiError(400, 'উইন পরিমাণ ঋণাত্মক হতে পারবে না।', 'INVALID_AMOUNT');
    winAmount = Math.round(rawW * 100) / 100;
  } else if (action === 'bet_win') {
    betAmount = Math.max(0, Math.round(toNum(body.betAmount !== undefined ? body.betAmount : body.amount, 0) * 100) / 100);
    winAmount = Math.max(0, Math.round(toNum(body.winAmount !== undefined ? body.winAmount : body.payout, 0) * 100) / 100);
    if (betAmount <= 0 && winAmount <= 0) {
      throw new ApiError(400, 'Bet অথবা Win পরিমাণ ০ থেকে বেশি হতে হবে।', 'INVALID_AMOUNT');
    }
  }

  if (dryRun) {
    let simAfter = beforeTotal;
    if (action === 'bet' || action === 'bet_win') {
      if (beforeTotal < betAmount) {
        throw new ApiError(400, `পর্যাপ্ত ব্যালেন্স নেই (বর্তমান: ৳${beforeTotal}, প্রয়োজন: ৳${betAmount})।`, 'INSUFFICIENT_BALANCE');
      }
      simAfter = Math.round((beforeTotal - betAmount + winAmount) * 100) / 100;
    } else if (action === 'win') {
      simAfter = Math.round((beforeTotal + winAmount) * 100) / 100;
    } else if (action === 'rollback') {
      const rbAmt = Math.max(0, toNum(body.amount, 0));
      simAfter = Math.round((beforeTotal + rbAmt) * 100) / 100;
    }
    return {
      ok: true,
      status: 0,
      code: 0,
      dryRun: true,
      simulated: isSimulated,
      action,
      uid,
      gameName,
      gameCode,
      provider,
      currency,
      beforeBalance: beforeTotal,
      afterBalance: simAfter,
      balance: simAfter,
      turnoverAdded: betAmount,
      turnoverDone: Math.round((toNum(user.turnoverDone != null ? user.turnoverDone : user.turnoverCompleted, 0) + betAmount) * 100) / 100,
      trxId: trxIdRaw
    };
  }

  if (action === 'balance') {
    await logAggregatorEvent({
      type: isSimulated ? 'SIM_BALANCE' : 'CB_BALANCE',
      status: 'OK',
      httpStatus: 200,
      uid,
      provider,
      gameCode,
      amount: beforeTotal,
      message: `Balance check: ৳${beforeTotal}`,
      ip
    });
    return {
      ok: true,
      status: 0,
      code: 0,
      action: 'balance',
      uid,
      currency,
      balance: beforeTotal,
      mainBalance: curMain,
      bonusBalance: curBonus
    };
  }

  const lockPath = `aggregatorTransactionLocks/${trxKey}`;
  await acquireLock(lockPath, uid);

  try {
    const existingSnap = await db.ref(`aggregatorTransactions/${trxKey}`).once('value');
    if (existingSnap.exists()) {
      const prevTx = existingSnap.val() || {};
      const freshUSnap = await db.ref(`users/${uid}`).once('value');
      const fu = freshUSnap.val() || {};
      const freshTot = Math.round((toNum(fu.balance, 0) + toNum(fu.bonusBalance, 0)) * 100) / 100;
      return {
        ok: true,
        status: 0,
        code: 0,
        idempotent: true,
        action: prevTx.action || action,
        uid,
        currency,
        balance: freshTot,
        trxId: trxIdRaw
      };
    }

    let afterMain = curMain;
    let afterBonus = curBonus;
    let fromMain = 0;
    let fromBonus = 0;

    if (action === 'bet' || action === 'bet_win') {
      // Re-read fresh wallet balance inside lock to prevent stale concurrent deductions
      const freshSnap = await db.ref(`users/${uid}`).once('value');
      const fu = freshSnap.val() || user;
      const liveMain = toNum(fu.balance, 0);
      const liveBonus = toNum(fu.bonusBalance, 0);
      const liveTotal = Math.round((liveMain + liveBonus) * 100) / 100;

      if (betAmount > 0) {
        if (liveTotal < betAmount) {
          throw new ApiError(400, 'আপনার ওয়ালেট ব্যালেন্স পর্যাপ্ত নয়।', 'INSUFFICIENT_BALANCE');
        }
        fromMain = Math.min(liveMain, betAmount);
        fromMain = Math.round(fromMain * 100) / 100;
        fromBonus = Math.round((betAmount - fromMain) * 100) / 100;

        if (fromMain > 0) {
          const mTx = await txIncrement(`users/${uid}/balance`, -fromMain);
          if (!mTx.committed) {
            throw new ApiError(400, 'ব্যালেন্স কর্তন সম্ভব হয়নি (পর্যাপ্ত ব্যালেন্স নেই)।', 'INSUFFICIENT_BALANCE');
          }
          afterMain = mTx.after;
        } else {
          afterMain = liveMain;
        }

        if (fromBonus > 0) {
          const bTx = await txIncrement(`users/${uid}/bonusBalance`, -fromBonus);
          if (!bTx.committed) {
            if (fromMain > 0) await txIncrement(`users/${uid}/balance`, fromMain).catch(() => {});
            throw new ApiError(400, 'বোনাস ব্যালেন্স পর্যাপ্ত নয়।', 'INSUFFICIENT_BALANCE');
          }
          afterBonus = bTx.after;
        } else {
          afterBonus = liveBonus;
        }
      } else {
        afterMain = liveMain;
        afterBonus = liveBonus;
      }

      if (winAmount > 0) {
        const wTx = await txIncrement(`users/${uid}/balance`, winAmount);
        if (!wTx.committed) {
          throw new ApiError(500, 'উইন ব্যালেন্স যোগ করা যায়নি।', 'WIN_CREDIT_FAILED');
        }
        afterMain = wTx.after;
      }

      const afterTotal = Math.round((afterMain + afterBonus) * 100) / 100;
      await applyAggregatorBetTurnoverAndTx({
        uid,
        u: fu,
        adminUid: fu.adminUid || '',
        gameName,
        provider,
        gameCode,
        betAmount,
        winAmount,
        trxId: trxIdRaw,
        sessionToken,
        gameSessionId,
        afterTotalBal: afterTotal
      });

      const txRecord = {
        trxId: trxIdRaw,
        trxKey,
        action,
        uid,
        adminUid: fu.adminUid || '',
        gameName,
        gameCode,
        provider,
        betAmount,
        winAmount,
        fromMain,
        fromBonus,
        beforeBalance: liveTotal,
        afterBalance: afterTotal,
        currency,
        sessionToken,
        simulated: isSimulated,
        rolledBack: false,
        timestamp: Date.now()
      };
      await db.ref(`aggregatorTransactions/${trxKey}`).set(txRecord);

      await logAggregatorEvent({
        type: isSimulated ? `SIM_${action.toUpperCase()}` : `CB_${action.toUpperCase()}`,
        status: 'OK',
        httpStatus: 200,
        uid,
        trxId: trxIdRaw,
        provider,
        gameCode,
        amount: betAmount || winAmount,
        message: `${action}: bet=৳${betAmount}, win=৳${winAmount}, turnover+৳${betAmount}, bal=৳${afterTotal}`,
        ip
      });

      const latestUSnap = await db.ref(`users/${uid}`).once('value');
      const lu = latestUSnap.val() || fu;
      return {
        ok: true,
        status: 0,
        code: 0,
        action,
        uid,
        currency,
        betAmount,
        winAmount,
        balance: afterTotal,
        mainBalance: afterMain,
        bonusBalance: afterBonus,
        turnoverAdded: betAmount,
        turnoverDone: toNum(lu.turnoverDone != null ? lu.turnoverDone : lu.turnoverCompleted, 0),
        trxId: trxIdRaw
      };
    }

    if (action === 'win') {
      const freshSnap = await db.ref(`users/${uid}`).once('value');
      const fu = freshSnap.val() || user;
      afterMain = toNum(fu.balance, 0);
      afterBonus = toNum(fu.bonusBalance, 0);

      if (winAmount > 0) {
        const wTx = await txIncrement(`users/${uid}/balance`, winAmount);
        if (!wTx.committed) throw new ApiError(500, 'উইন ব্যালেন্স যোগ করা যায়নি।', 'WIN_CREDIT_FAILED');
        afterMain = wTx.after;
      }

      const afterTotal = Math.round((afterMain + afterBonus) * 100) / 100;
      await applyAggregatorBetTurnoverAndTx({
        uid,
        u: fu,
        adminUid: fu.adminUid || '',
        gameName,
        provider,
        gameCode,
        betAmount: 0,
        winAmount,
        trxId: trxIdRaw,
        sessionToken,
        gameSessionId,
        afterTotalBal: afterTotal
      });

      await db.ref(`aggregatorTransactions/${trxKey}`).set({
        trxId: trxIdRaw,
        trxKey,
        action: 'win',
        uid,
        adminUid: fu.adminUid || '',
        gameName,
        gameCode,
        provider,
        betAmount: 0,
        winAmount,
        fromMain: 0,
        fromBonus: 0,
        beforeBalance: Math.round((toNum(fu.balance, 0) + afterBonus) * 100) / 100,
        afterBalance: afterTotal,
        currency,
        sessionToken,
        simulated: isSimulated,
        rolledBack: false,
        timestamp: Date.now()
      });

      await logAggregatorEvent({
        type: isSimulated ? 'SIM_WIN' : 'CB_WIN',
        status: 'OK',
        httpStatus: 200,
        uid,
        trxId: trxIdRaw,
        provider,
        gameCode,
        amount: winAmount,
        message: `Win credited: +৳${winAmount}, bal=৳${afterTotal}`,
        ip
      });

      return {
        ok: true,
        status: 0,
        code: 0,
        action: 'win',
        uid,
        currency,
        winAmount,
        balance: afterTotal,
        mainBalance: afterMain,
        bonusBalance: afterBonus,
        trxId: trxIdRaw
      };
    }

    // Rollback / Refund
    const origKey = safeRtdbKey(body.refTrxId || body.originalTrxId || body.roundId || body.trxId, '');
    let orig = null;
    if (origKey && origKey !== trxKey) {
      const oSnap = await db.ref(`aggregatorTransactions/${origKey}`).once('value');
      if (oSnap.exists()) orig = oSnap.val();
    }

    let refunded = 0;
    if (orig && !orig.rolledBack && orig.uid === uid) {
      const rMain = toNum(orig.fromMain, 0);
      const rBonus = toNum(orig.fromBonus, 0);
      if (rMain > 0) await txIncrement(`users/${uid}/balance`, rMain);
      if (rBonus > 0) await txIncrement(`users/${uid}/bonusBalance`, rBonus);
      const wRev = toNum(orig.winAmount, 0);
      if (wRev > 0) await txIncrement(`users/${uid}/balance`, -wRev).catch(() => {});

      const origBet = toNum(orig.betAmount, 0);
      if (origBet > 0) {
        const uNowSnap = await db.ref(`users/${uid}`).once('value');
        const uNow = uNowSnap.val() || {};
        const decDone = Math.min(origBet, toNum(uNow.turnoverDone, 0));
        const decComp = Math.min(origBet, toNum(uNow.turnoverCompleted, 0));
        if (decDone > 0) await txIncrement(`users/${uid}/turnoverDone`, -decDone).catch(() => {});
        if (decComp > 0) await txIncrement(`users/${uid}/turnoverCompleted`, -decComp).catch(() => {});
        if (toNum(uNow.betCount, 0) >= 1) await txIncrement(`users/${uid}/betCount`, -1).catch(() => {});
      }

      refunded = Math.round((rMain + rBonus) * 100) / 100;
      await db.ref(`aggregatorTransactions/${origKey}`).update({
        rolledBack: true,
        rolledBackAt: Date.now(),
        rollbackTrxId: trxIdRaw
      });
    }

    const postSnap = await db.ref(`users/${uid}`).once('value');
    const pu = postSnap.val() || user;
    const postMain = toNum(pu.balance, 0);
    const postBonus = toNum(pu.bonusBalance, 0);
    const postTotal = Math.round((postMain + postBonus) * 100) / 100;

    await db.ref(`aggregatorTransactions/${trxKey}`).set({
      trxId: trxIdRaw,
      trxKey,
      action: 'rollback',
      refTrxId: origKey,
      uid,
      refunded,
      afterBalance: postTotal,
      currency,
      simulated: isSimulated,
      timestamp: Date.now()
    });

    await logAggregatorEvent({
      type: isSimulated ? 'SIM_ROLLBACK' : 'CB_ROLLBACK',
      status: 'OK',
      httpStatus: 200,
      uid,
      trxId: trxIdRaw,
      provider,
      gameCode,
      amount: refunded,
      message: orig ? `Rollback refunded ৳${refunded} for ${origKey}` : 'Rollback accepted (no prior matching bet)',
      ip
    });

    return {
      ok: true,
      status: 0,
      code: 0,
      action: 'rollback',
      uid,
      currency,
      refunded,
      balance: postTotal,
      mainBalance: postMain,
      bonusBalance: postBonus,
      trxId: trxIdRaw
    };
  } finally {
    await releaseLock(lockPath);
  }
}

function safeCompareSecret(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || !sb) return false;
  const ba = Buffer.from(sa);
  const bb = Buffer.from(sb);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function verifyAggregatorWebhookAuth(req, rawBody, body, ip) {
  const cfg = await getStoredAggregatorConfig();
  if (cfg.whitelistIps) {
    const allowed = cfg.whitelistIps
      .split(',')
      .map(s => normalizeIp(s))
      .filter(Boolean);
    const clientIp = normalizeIp(ip);
    if (allowed.length && clientIp && !allowed.includes(clientIp)) {
      throw new ApiError(403, `অননুমোদিত Webhook IP: ${clientIp}`, 'IP_NOT_WHITELISTED');
    }
  }

  const whSecret = String(cfg.webhookSecret || '').trim();
  if (!whSecret) return; // No webhook secret configured; allow payload/session verification

  const headers = (req && req.headers) || {};
  const signHdrName = String(cfg.signHeader || 'X-Sign').toLowerCase();
  const candidates = [
    headers['x-webhook-secret'],
    headers[signHdrName],
    headers['x-sign'],
    headers['x-signature'],
    headers['x-hub-signature-256'],
    headers['authorization'] && String(headers['authorization']).startsWith('Bearer ')
      ? String(headers['authorization']).slice(7).trim()
      : '',
    body.webhookSecret,
    body.secret,
    body.sign,
    body.signature
  ].filter(Boolean).map(v => String(v).trim());

  const rawStr = String(rawBody || '');
  const hmac256 = crypto.createHmac('sha256', whSecret).update(rawStr).digest('hex');
  const hmac1 = crypto.createHmac('sha1', whSecret).update(rawStr).digest('hex');
  const md5Hex = crypto.createHash('md5').update(rawStr + whSecret).digest('hex');

  const valid = candidates.some(cand => {
    const cleaned = cand.replace(/^sha256=/i, '').replace(/^sha1=/i, '');
    return (
      safeCompareSecret(cleaned, whSecret) ||
      safeCompareSecret(cleaned.toLowerCase(), hmac256.toLowerCase()) ||
      safeCompareSecret(cleaned.toLowerCase(), hmac1.toLowerCase()) ||
      safeCompareSecret(cleaned.toLowerCase(), md5Hex.toLowerCase())
    );
  });

  if (!valid) {
    await logAggregatorEvent({
      type: 'CB_AUTH_FAIL',
      status: 'ERROR',
      httpStatus: 401,
      message: 'Webhook signature / secret mismatch',
      ip
    });
    throw new ApiError(401, 'Invalid Webhook Secret or Signature', 'INVALID_WEBHOOK_SIGNATURE');
  }
}

async function aggregatorCallbackHttp(req, forcedAction, rawBody, body, ip = '') {
  await verifyAggregatorWebhookAuth(req, rawBody, body, ip);
  return processAggregatorCallback(forcedAction, body, { dryRun: false, isSimulated: false, ip });
}

async function masterAggregatorSimulateWebhook(actor, body, ip = '') {
  const res = await processAggregatorCallback(body.action || 'balance', body, {
    dryRun: body.dryRun !== false,
    isSimulated: true,
    ip
  });
  await writeAuditLog(
    actor.email || actor.uid,
    'AGGREGATOR_SIMULATE_WEBHOOK',
    body.uid || 'unknown',
    `action=${res.action}, dryRun=${!!body.dryRun}, bal=৳${res.balance}`,
    ip
  );
  return res;
}

/* ==================== GAME LAUNCH PROXY ==================== */

async function userLaunchGameProxy(actor, body) {
  const db = getDb();
  const uSnap = await db.ref(`users/${actor.uid}`).once('value');
  const u = uSnap.val() || {};
  if (['banned', 'suspended'].includes(String(u.status || '').toLowerCase())) {
    throw new ApiError(403, 'আপনার অ্যাকাউন্ট স্থগিত করা হয়েছে।', 'ACCOUNT_SUSPENDED');
  }

  const adminUid = u.adminUid || '';
  const cfg = await resolveUserLimitsAndBonusConfig(adminUid);
  const storedAgg = await getStoredAggregatorConfig(adminUid);
  const gApi = Object.assign({}, cfg.gameApi || {}, storedAgg);

  if (!gApi.enabled || !gApi.launchUrl) {
    throw new ApiError(400, 'Game API কনফিগার করা নেই।', 'GAME_API_DISABLED');
  }

  const gameCode = String(body.gameCode || '').trim() || 'game';
  const provider = String(body.provider || 'casino').trim();
  const gameName = String(body.gameName || '').trim() || gameCode;
  const currency = String(gApi.currency || 'BDT');
  const lang = String(gApi.lang || 'bn');
  const returnUrl = String(body.returnUrl || '');
  const balance = Math.round((toNum(u.balance, 0) + toNum(u.bonusBalance, 0)) * 100) / 100;
  const sessionToken = 'mw_' + crypto.randomBytes(16).toString('hex');

  await db.ref(`aggregatorSessions/${sessionToken}`).set({
    sessionToken,
    uid: actor.uid,
    adminUid,
    username: u.username || u.name || actor.uid,
    provider,
    gameCode,
    gameName,
    currency,
    gameSessionId: String(body.gameSessionId || ''),
    createdAt: Date.now()
  });

  const vars = {
    uid: actor.uid,
    username: u.username || u.name || actor.uid,
    gameCode,
    provider,
    currency,
    lang,
    balance,
    operatorCode: gApi.operatorCode || '',
    agentId: gApi.agentId || '',
    sessionToken,
    returnUrl,
    callbackUrl: gApi.callbackUrl || '',
    apiKey: gApi.apiKey || ''
  };

  if (gApi.mode === 'direct_iframe') {
    const resolvedUrl = fillAggTemplate(gApi.launchUrl, vars);
    await logAggregatorEvent({
      type: 'GAME_LAUNCH_DIRECT',
      status: 'OK',
      httpStatus: 200,
      uid: actor.uid,
      provider,
      gameCode,
      amount: balance,
      message: `Direct template launched for ${gameName}`
    });
    return { gameUrl: resolvedUrl, sessionToken, openMode: gApi.openMode || 'iframe' };
  }

  const method = gApi.mode === 'rest_get' ? 'GET' : 'POST';
  const payload = method === 'GET' ? {} : {
    operatorCode: gApi.operatorCode || '',
    agentId: gApi.agentId || '',
    uid: actor.uid,
    username: u.username || u.name || actor.uid,
    gameCode,
    provider,
    gameName,
    currency,
    lang,
    balance,
    sessionToken,
    callbackUrl: gApi.callbackUrl || '',
    returnUrl
  };

  const { resolvedUrl, fetchOpts } = buildAggAuthRequest(gApi, gApi.launchUrl, method, payload, vars);
  const t0 = Date.now();
  const resp = await fetch(resolvedUrl, fetchOpts).catch(err => {
    throw new ApiError(502, `Game API সংযোগ ব্যর্থ: ${err.message || err}`, 'GAME_LAUNCH_UNREACHABLE');
  });
  const latencyMs = Date.now() - t0;
  const json = await resp.json().catch(() => null);
  const gameUrl = extractLaunchUrlFromPayload(json);

  await logAggregatorEvent({
    type: 'GAME_LAUNCH',
    status: gameUrl ? 'OK' : 'ERROR',
    httpStatus: resp.status,
    latencyMs,
    uid: actor.uid,
    provider,
    gameCode,
    amount: balance,
    message: gameUrl ? `Launched ${gameName}` : `No Launch URL returned (HTTP ${resp.status})`
  });

  if (!gameUrl) {
    throw new ApiError(502, 'Game API থেকে Launch URL পাওয়া যায়নি।', 'GAME_LAUNCH_FAILED');
  }
  return { gameUrl, sessionToken, openMode: gApi.openMode || 'iframe' };
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
  masterAggregatorSave,
  masterAggregatorTest,
  masterAggregatorSyncGames,
  masterAggregatorSimulateWebhook,
  aggregatorCallbackHttp,
  processAggregatorCallback,
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
