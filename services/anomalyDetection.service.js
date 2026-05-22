// services/anomalyDetection.service.js — v2
//
// Hybrid ensemble anomaly detection for vousFin.
//
// Pipeline:
//   1. Multi-tier transaction fetch
//   2. Skip transactions already user-reviewed (marked_legit / ignored)
//   3. Build 14-feature matrix (was 10) with behavioural + velocity + frequency features
//   4. Ensemble scoring:
//        IF score  · 35%     — isolation forest (seeded → deterministic)
//        Z-score   · 15%     — robust z-score on amount
//        Heuristic · 20%     — rule-based hour/weekend/round-amount/micro
//        Behaviour · 15%     — vendor & account-pair deviation
//        Frequency · 10%     — daily-count anomaly
//        Velocity  ·  5%     — recent activity burst
//   5. Threshold (calibrated per dataset size)
//   6. Build explanation + triggered-rules list (Step 7)
//   7. Upsert into AnomalyAlert (Step 2) — never duplicates same journalEntryId
//
// Determinism: same input → same output (seeded RNG, sorted indices).

const crypto                   = require('crypto');
const mongoose                 = require('mongoose');
const { IsolationForest, seedFromString } = require('./isolationForest.service');
const anomalyRepository        = require('../repositories/anomaly.repository');
const JournalEntry             = require('../models/JournalEntry.model');
const {
  ANOMALY_STATUS,
  ANOMALY_SUPPRESS_STATUSES,
} = require('../config/constants');
const logger = require('../config/logger');

// ── Encoding maps ─────────────────────────────────────────────────────────────
const TX_TYPE_IDX = {
  'Income': 0, 'Expense': 1, 'Transfer': 2, 'Credit Sale': 3,
  'Credit Purchase': 4, 'Payment Received': 5, 'Payment Made': 6,
  'Installment Payment': 7, 'Loan Disbursement': 8, 'Loan Repayment': 9,
  'Owner Investment': 10, 'Owner Withdrawal': 11, 'Asset Purchase': 12,
};
const TX_MODE_IDX = { cash: 0, credit: 1, installment: 2, partial_settlement: 3 };

// ── Math utilities ────────────────────────────────────────────────────────────
function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function std(arr, mu) {
  if (arr.length < 2) return 1;
  const v = arr.reduce((s, x) => s + (x - mu) ** 2, 0) / arr.length;
  return Math.sqrt(v) || 1;
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Median absolute deviation — robust to outliers, used for fraud z-score. */
function mad(arr, med) {
  if (arr.length < 2) return 1;
  const dev = arr.map(x => Math.abs(x - med));
  return median(dev) || 1;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function safeNum(v, fallback = 0) { return Number.isFinite(v) ? v : fallback; }

// ── Transaction fingerprint ──────────────────────────────────────────────────
// Hash of the salient transaction attributes.  If ANY of them change, the
// fingerprint changes → triggers a 'rescanned' status on the existing alert.
function fingerprint(tx) {
  const parts = [
    String(tx._id),
    String(tx.amount),
    String(tx.debitAccountId  || ''),
    String(tx.creditAccountId || ''),
    new Date(tx.transactionDate).toISOString().slice(0, 10),
    String(tx.transactionType || ''),
    String(tx.transactionMode || ''),
    String(tx.description || '').toLowerCase().trim().substring(0, 80),
  ].join('|');
  return crypto.createHash('md5').update(parts).digest('hex');
}

// ── Multi-tier transaction fetching ───────────────────────────────────────────
async function fetchTransactions(businessId) {
  let bId;
  try {
    const hex = businessId instanceof mongoose.Types.ObjectId
      ? businessId.toHexString()
      : String(businessId);
    bId = new mongoose.Types.ObjectId(hex);
  } catch (e) {
    logger.error(`[AnomalyDetection] Could not convert businessId "${businessId}": ${e.message}`);
    return [];
  }
  const since90 = new Date();
  since90.setDate(since90.getDate() - 90);

  let txns = await JournalEntry.find({
    businessId: bId,
    transactionDate: { $gte: since90 },
    status: { $in: ['posted', 'partially_settled', 'settled'] },
    isArchived: { $ne: true },
  }).sort({ transactionDate: 1 }).lean();
  logger.info(`[AnomalyDetection] Tier1 (90d + status filter): ${txns.length} txns`);

  if (txns.length < 2) {
    txns = await JournalEntry.find({
      businessId: bId,
      transactionDate: { $gte: since90 },
    }).sort({ transactionDate: 1 }).lean();
    logger.info(`[AnomalyDetection] Tier2 (90d, no status): ${txns.length} txns`);
  }
  if (txns.length < 2) {
    txns = await JournalEntry.find({ businessId: bId })
      .sort({ transactionDate: 1 }).lean();
    logger.info(`[AnomalyDetection] Tier3 (all-time): ${txns.length} txns`);
  }
  return txns;
}

// ── Feature engineering (v2 — 14 features) ───────────────────────────────────
function buildAggregates(txns) {
  const amounts = txns.map(t => t.amount);
  const mu      = mean(amounts);
  const sigma   = std(amounts, mu);
  const med     = median(amounts);
  const madVal  = mad(amounts, med);
  const minTs   = Math.min(...txns.map(t => new Date(t.transactionDate).getTime()));
  const maxTs   = Math.max(...txns.map(t => new Date(t.transactionDate).getTime()));
  const tsRange = maxTs - minTs || 1;

  // Account-pair frequency
  const pairCount = {};
  for (const tx of txns) {
    const k = `${tx.debitAccountId}_${tx.creditAccountId}`;
    pairCount[k] = (pairCount[k] || 0) + 1;
  }

  // Daily counts (for velocity / frequency)
  const dailyCount = {};
  for (const tx of txns) {
    const day = new Date(tx.transactionDate).toISOString().slice(0, 10);
    dailyCount[day] = (dailyCount[day] || 0) + 1;
  }
  const avgDaily = mean(Object.values(dailyCount)) || 1;

  // Per-transaction-type baselines (for behavioural deviation)
  const typeAmounts = {};
  for (const tx of txns) {
    const t = tx.transactionType || 'Unknown';
    if (!typeAmounts[t]) typeAmounts[t] = [];
    typeAmounts[t].push(tx.amount);
  }
  const typeStats = {};
  for (const [t, amts] of Object.entries(typeAmounts)) {
    const m = mean(amts);
    typeStats[t] = { mu: m, sigma: std(amts, m), count: amts.length };
  }

  // Description / vendor-like frequency by description prefix
  const descPrefixCount = {};
  for (const tx of txns) {
    const key = String(tx.description || '').toLowerCase().split(/\s+/).slice(0, 3).join(' ');
    if (key) descPrefixCount[key] = (descPrefixCount[key] || 0) + 1;
  }

  return {
    amounts, mu, sigma, med, madVal,
    minTs, maxTs, tsRange,
    pairCount, dailyCount, avgDaily,
    typeStats, descPrefixCount,
  };
}

function buildFeatureMatrix(txns, agg) {
  return txns.map(tx => {
    const date    = new Date(tx.transactionDate);
    const created = new Date(tx.createdAt || tx.transactionDate);

    const logAmt      = safeNum(Math.log(Math.abs(tx.amount) + 1));
    const zScore      = safeNum(clamp((tx.amount - agg.mu) / agg.sigma, -5, 5));
    const robustZ     = safeNum(clamp((tx.amount - agg.med) / (agg.madVal * 1.4826), -5, 5)); // MAD-based
    const dow         = date.getDay() / 6;
    const hr          = created.getHours() / 23;
    const mo          = date.getMonth() / 11;
    const relDate     = safeNum((date.getTime() - agg.minTs) / agg.tsRange);
    const typeIdx     = (TX_TYPE_IDX[tx.transactionType] ?? 1) / 12;
    const modeIdx     = (TX_MODE_IDX[tx.transactionMode] ?? 0) / 3;
    const pairKey     = `${tx.debitAccountId}_${tx.creditAccountId}`;
    const pairRarity  = safeNum(1 - (agg.pairCount[pairKey] || 1) / txns.length);
    const day         = date.toISOString().slice(0, 10);
    const velocity    = safeNum(clamp((agg.dailyCount[day] || 1) / agg.avgDaily, 0, 3) / 3);

    // NEW behavioural features
    const t           = tx.transactionType || 'Unknown';
    const typeStat    = agg.typeStats[t];
    const typeDev     = (typeStat && typeStat.sigma)
      ? safeNum(clamp(Math.abs(tx.amount - typeStat.mu) / typeStat.sigma, 0, 5) / 5)
      : 0;
    const descKey     = String(tx.description || '').toLowerCase().split(/\s+/).slice(0, 3).join(' ');
    const descRarity  = descKey ? safeNum(1 - (agg.descPrefixCount[descKey] || 1) / txns.length) : 0;
    const isWeekend   = (date.getDay() === 0 || date.getDay() === 6) ? 1 : 0;

    return [
      logAmt, zScore, robustZ, dow, hr, mo, relDate,
      typeIdx, modeIdx, pairRarity, velocity,
      typeDev, descRarity, isWeekend,
    ];
  });
}

// ── Rule-based heuristic scoring ─────────────────────────────────────────────
function heuristicScore(tx, agg) {
  let score = 0;
  const flags = [];

  const z = Math.abs((tx.amount - agg.mu) / (agg.sigma || 1));
  if      (z > 3.5) { score += 0.45; flags.push('extreme_amount_spike'); }
  else if (z > 2.5) { score += 0.30; flags.push('high_amount_deviation'); }
  else if (z > 1.8) { score += 0.15; flags.push('elevated_amount'); }

  const hr = new Date(tx.createdAt || tx.transactionDate).getHours();
  if (hr < 6 || hr >= 23) { score += 0.15; flags.push('off_hours_entry'); }

  const dow = new Date(tx.transactionDate).getDay();
  if (dow === 0 || dow === 6) { score += 0.08; flags.push('weekend_transaction'); }

  if (tx.amount >= 500000 && tx.amount % 100000 === 0) { score += 0.15; flags.push('round_large_amount'); }
  else if (tx.amount >= 100000 && tx.amount % 50000 === 0) { score += 0.08; flags.push('round_medium_amount'); }

  if (tx.amount < 50) { score += 0.28; flags.push('micro_transaction'); }

  // Rare account pair
  const pairKey = `${tx.debitAccountId}_${tx.creditAccountId}`;
  const pairFreq = agg.pairCount[pairKey] || 0;
  if (pairFreq === 1 && Object.keys(agg.pairCount).length > 5) {
    score += 0.10; flags.push('rare_account_pair');
  }

  return { score: clamp(score, 0, 1), flags };
}

// ── Behavioural & frequency sub-scores ───────────────────────────────────────
function behaviouralScore(tx, agg) {
  // How far this txn's amount is from the type-specific mean (in std-devs)
  const t       = tx.transactionType || 'Unknown';
  const typeSt  = agg.typeStats[t];
  if (!typeSt || typeSt.count < 3 || !typeSt.sigma) return { score: 0, flags: [] };
  const dev     = Math.abs(tx.amount - typeSt.mu) / typeSt.sigma;
  const flags   = [];
  let   score   = 0;
  if      (dev > 4) { score = 0.85; flags.push('extreme_type_deviation'); }
  else if (dev > 3) { score = 0.60; flags.push('strong_type_deviation'); }
  else if (dev > 2) { score = 0.35; flags.push('mild_type_deviation'); }
  return { score, flags };
}

function frequencyScore(tx, agg) {
  // Description-prefix based: brand-new description in last 90 days → suspicious
  const key = String(tx.description || '').toLowerCase().split(/\s+/).slice(0, 3).join(' ');
  if (!key) return { score: 0, flags: [] };
  const freq = agg.descPrefixCount[key] || 0;
  const flags = [];
  let   score = 0;
  if (freq === 1 && Object.keys(agg.descPrefixCount).length > 5) {
    score = 0.40; flags.push('novel_vendor_or_description');
  } else if (freq >= 10) {
    // Very common — usually legit (suppress)
    score = -0.10;
  }
  return { score: clamp(score, 0, 1), flags };
}

function velocityScore(tx, agg) {
  // Burst activity: same day has > 3× average transactions
  const day  = new Date(tx.transactionDate).toISOString().slice(0, 10);
  const cnt  = agg.dailyCount[day] || 1;
  const ratio = cnt / (agg.avgDaily || 1);
  const flags = [];
  let   score = 0;
  if      (ratio > 4) { score = 0.55; flags.push('extreme_daily_burst'); }
  else if (ratio > 3) { score = 0.35; flags.push('high_daily_burst'); }
  else if (ratio > 2) { score = 0.15; flags.push('moderate_daily_burst'); }
  return { score: clamp(score, 0, 1), flags };
}

// ── Score & severity mapping ─────────────────────────────────────────────────
function toSeverity(score) {
  if (score >= 0.82) return 'critical';
  if (score >= 0.68) return 'high';
  if (score >= 0.54) return 'medium';
  return 'low';
}
function toFraudRisk(score)    { return toSeverity(score); }
function toAnomalyStatus(score) {
  if (score >= 0.78) return 'potentially_fraudulent';
  if (score >= 0.62) return 'highly_suspicious';
  return 'suspicious';
}

// ── Explanation builder ──────────────────────────────────────────────────────
function buildExplanation(tx, breakdown, allFlags, agg) {
  const facts = [];

  // Amount comparison
  const z = (tx.amount - agg.mu) / (agg.sigma || 1);
  if (Math.abs(z) > 1.5) {
    const dir = tx.amount > agg.mu ? 'above' : 'below';
    facts.push(`Amount PKR ${Math.round(tx.amount).toLocaleString()} is ${Math.abs(z).toFixed(1)}σ ${dir} the business's average (PKR ${Math.round(agg.mu).toLocaleString()}).`);
  }

  // Per-type deviation
  const t = tx.transactionType;
  const typeSt = t && agg.typeStats[t];
  if (typeSt && typeSt.count >= 3 && typeSt.sigma) {
    const ratio = tx.amount / (typeSt.mu || 1);
    if (ratio > 2 || ratio < 0.4) {
      facts.push(`Amount is ${ratio.toFixed(1)}× the normal ${t} value (typical ≈ PKR ${Math.round(typeSt.mu).toLocaleString()}).`);
    }
  }

  // Heuristic explanations
  if (allFlags.includes('off_hours_entry')) {
    const hr = new Date(tx.createdAt || tx.transactionDate).getHours();
    facts.push(`Entered at unusual hour (${String(hr).padStart(2, '0')}:00).`);
  }
  if (allFlags.includes('weekend_transaction')) {
    facts.push(`Transaction recorded on a weekend.`);
  }
  if (allFlags.includes('round_large_amount')) {
    facts.push(`Suspiciously round amount — pattern often seen in structuring.`);
  }
  if (allFlags.includes('micro_transaction')) {
    facts.push(`Unusually small amount (< PKR 50) — possible test or splitting pattern.`);
  }
  if (allFlags.includes('novel_vendor_or_description')) {
    facts.push(`Vendor / description appears for the first time in the scan window.`);
  }
  if (allFlags.includes('rare_account_pair')) {
    facts.push(`Debit-credit account combination has not been used before.`);
  }
  if (allFlags.includes('extreme_daily_burst') || allFlags.includes('high_daily_burst')) {
    const day = new Date(tx.transactionDate).toISOString().slice(0, 10);
    const cnt = agg.dailyCount[day];
    facts.push(`${cnt} transactions on the same day (${day}) — well above normal activity.`);
  }
  if (allFlags.includes('extreme_type_deviation') || allFlags.includes('strong_type_deviation')) {
    facts.push(`Amount deviates strongly from this transaction type's historical average.`);
  }

  // Component contribution summary
  const top = Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .filter(([, v]) => v > 0.1)
    .slice(0, 3)
    .map(([k]) => k)
    .join(', ');
  if (top) facts.push(`Triggered components: ${top}.`);

  return facts.length ? facts.join(' ') : 'Anomalous pattern detected by the ensemble model.';
}

function buildShortReason(tx, score, agg, flags) {
  const top = flags.slice(0, 2).map(f => f.replace(/_/g, ' ')).join(', ');
  const z   = (tx.amount - agg.mu) / (agg.sigma || 1);
  if (Math.abs(z) > 2) {
    const dir = tx.amount > agg.mu ? 'above' : 'below';
    return `Amount ${Math.abs(z).toFixed(1)}σ ${dir} average${top ? ` (${top})` : ''}.`;
  }
  return top
    ? `Anomalous pattern: ${top}.`
    : 'Anomalous combination of features detected by ensemble model.';
}

// ── Main service ─────────────────────────────────────────────────────────────
class AnomalyDetectionService {
  /**
   * Run an anomaly scan.
   * - Skips transactions the user already cleared (marked_legit / ignored) unless
   *   the transaction has changed materially (fingerprint mismatch).
   * - Uses seeded RNG → deterministic results for unchanged data.
   * - Upserts alerts → no duplicates across rescans.
   */
  async runScan(businessId, { force = false } = {}) {
    const scanId = `if_${Date.now()}_${String(businessId).slice(-6)}`;
    logger.info(`[AnomalyDetection] Starting scan ${scanId} for business ${businessId} (force=${force})`);

    const txns = await fetchTransactions(businessId);
    if (!txns.length) {
      return {
        scanId, anomaliesFound: 0, alertsCreated: 0, alertsUpdated: 0,
        suppressed: 0, rescanned: 0, anomalies: [], totalScanned: 0,
        message: 'No transactions found for this business. Add transactions first.',
      };
    }
    if (txns.length < 2) {
      return {
        scanId, anomaliesFound: 0, alertsCreated: 0, alertsUpdated: 0,
        suppressed: 0, rescanned: 0, anomalies: [], totalScanned: txns.length,
        message: 'Need at least 2 transactions to run anomaly detection.',
      };
    }

    // ── 1. Aggregates + per-row fingerprints ──
    const agg = buildAggregates(txns);
    const fingerprints = txns.map(fingerprint);

    // ── 2. Filter out user-cleared transactions (Step 5: feedback learning) ──
    const journalIds = txns.map(t => t._id);
    const decisionMap = force
      ? new Map()
      : await anomalyRepository.getDecisionsForJournalEntries(businessId, journalIds);

    let suppressedCount = 0;
    let rescanCandidate = 0;
    const scoringMask = txns.map((tx, i) => {
      const d = decisionMap.get(String(tx._id));
      if (!d) return true;
      // marked_legit / ignored / valid → skip UNLESS txn changed
      if (ANOMALY_SUPPRESS_STATUSES.includes(d.status)) {
        if (d.transactionFingerprint && d.transactionFingerprint !== fingerprints[i]) {
          rescanCandidate++;
          return true; // re-score because txn changed
        }
        suppressedCount++;
        return false;
      }
      // confirmed_fraud → we still want to keep alert visible
      return true;
    });

    const txnsToScore = txns.filter((_, i) => scoringMask[i]);
    if (!txnsToScore.length) {
      return {
        scanId, anomaliesFound: 0, alertsCreated: 0, alertsUpdated: 0,
        suppressed: suppressedCount, rescanned: 0, anomalies: [], totalScanned: txns.length,
        message: `All ${txns.length} transactions previously reviewed — nothing new to score.`,
      };
    }

    // Re-build aggregates on the FULL dataset (better baseline) but score only filtered subset
    const featuresAll  = buildFeatureMatrix(txns, agg);
    const featuresMask = featuresAll.filter((_, i) => scoringMask[i]);
    const heurAll      = txns.map(tx => heuristicScore(tx, agg));
    const behAll       = txns.map(tx => behaviouralScore(tx, agg));
    const freqAll      = txns.map(tx => frequencyScore(tx, agg));
    const velAll       = txns.map(tx => velocityScore(tx, agg));

    // ── 3. Isolation Forest (seeded → deterministic per business) ──
    let ifScoresAll = null;
    if (txnsToScore.length >= 5) {
      const seed = `${businessId}-${txns.length}`; // includes dataset size so growth invalidates seed
      const forest = new IsolationForest({
        numTrees:   txns.length < 30 ? 50 : 100,
        sampleSize: Math.min(256, txns.length),
        seed,
      });
      forest.fit(featuresAll); // train on full data for stable baseline
      ifScoresAll = forest.predict(featuresAll);
    }

    // ── 4. Ensemble blending (weights sum = 1.0) ──
    // Weights: IF .35, Z .15, Heur .20, Behav .15, Freq .10, Velocity .05
    const W = { IF: 0.35, Z: 0.15, H: 0.20, B: 0.15, F: 0.10, V: 0.05 };

    // For very small datasets where IF is unreliable, fall back to heuristic-heavy
    const SMALL = txnsToScore.length < 5;
    const w = SMALL
      ? { IF: 0.00, Z: 0.20, H: 0.45, B: 0.20, F: 0.10, V: 0.05 }
      : (txnsToScore.length < 20
          ? { IF: 0.25, Z: 0.20, H: 0.25, B: 0.15, F: 0.10, V: 0.05 }
          : W);

    const finalScores = txns.map((tx, i) => {
      const ifS   = ifScoresAll ? ifScoresAll[i] : 0.5;
      const z     = Math.abs((tx.amount - agg.mu) / (agg.sigma || 1));
      const zS    = clamp(z / 4, 0, 1);                  // [0,1]: z=4 → 1.0
      const hS    = heurAll[i].score;
      const bS    = behAll[i].score;
      const fS    = freqAll[i].score;
      const vS    = velAll[i].score;
      const score = w.IF * ifS + w.Z * zS + w.H * hS + w.B * bS + w.F * fS + w.V * vS;
      return { score: clamp(score, 0, 1), ifS, zS, hS, bS, fS, vS };
    });

    // ── 5. Threshold calibration ──
    // Lower threshold for small datasets to surface more candidates.
    const THRESHOLD =
      txnsToScore.length < 10 ? 0.40 :
      txnsToScore.length < 20 ? 0.46 :
      txnsToScore.length < 50 ? 0.52 :
                                0.56;

    const flagged = txns.map((tx, i) => ({
      tx, idx: i, ...finalScores[i],
      allFlags: [...heurAll[i].flags, ...behAll[i].flags, ...freqAll[i].flags, ...velAll[i].flags],
      fingerprint: fingerprints[i],
      wasFiltered: !scoringMask[i],
    }))
      .filter(x => !x.wasFiltered && x.score >= THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);

    logger.info(`[AnomalyDetection] Ensemble flagged ${flagged.length} (threshold=${THRESHOLD}, suppressed=${suppressedCount}, rescanned=${rescanCandidate})`);

    // ── 6. Build alert docs + upsert ──
    const alertDocs = flagged.map(({ tx, score, ifS, zS, hS, bS, fS, vS, allFlags, fingerprint }) => {
      const breakdown = {
        isolationForest: Number(ifS.toFixed(4)),
        zScore:          Number(zS.toFixed(4)),
        heuristic:       Number(hS.toFixed(4)),
        behavioral:      Number(bS.toFixed(4)),
        frequency:       Number(fS.toFixed(4)),
        velocity:        Number(vS.toFixed(4)),
      };
      // Confidence: how much the top component dominates → high confidence,
      // and how strongly the score exceeds the threshold
      const topVal       = Math.max(ifS, zS, hS, bS, fS, vS);
      const margin       = clamp((score - THRESHOLD) / (1 - THRESHOLD), 0, 1);
      const confidence   = Math.round(clamp(0.5 * topVal + 0.5 * margin, 0, 1) * 100);

      return {
        businessId: new mongoose.Types.ObjectId(
          String(businessId instanceof mongoose.Types.ObjectId ? businessId.toHexString() : businessId)
        ),
        journalEntryId:         tx._id,
        anomalyScore:           Number(score.toFixed(4)),
        reason:                 buildShortReason(tx, score, agg, allFlags),
        explanation:            buildExplanation(tx, breakdown, allFlags, agg),
        triggeredRules:         allFlags,
        featureVector: {
          amount:         tx.amount,
          amountZScore:   safeNum((tx.amount - agg.mu) / (agg.sigma || 1)),
          dayOfWeek:      new Date(tx.transactionDate).getDay(),
          transactionType: tx.transactionType,
          transactionMode: tx.transactionMode,
          heuristicFlags: allFlags,
        },
        transactionFingerprint: fingerprint,
        scoreBreakdown:         breakdown,
        confidence,
        scanId,
      };
    });

    let upsertResult = { created: 0, updated: 0, suppressed: 0, rescanned: 0, alerts: [] };
    if (alertDocs.length) {
      upsertResult = await anomalyRepository.bulkUpsertAlerts(alertDocs);
      logger.info(`[AnomalyDetection] Upsert: created=${upsertResult.created}, updated=${upsertResult.updated}, suppressed=${upsertResult.suppressed}, rescanned=${upsertResult.rescanned}`);
    }

    // ── 7. Format response — only include alerts that are pending/rescanned
    //       (suppressed ones remain in DB but NOT in the scan response)
    const persistedById = new Map(upsertResult.alerts.map(a => [String(a.journalEntryId), a]));
    const anomalies = flagged
      .map(({ tx, score, allFlags, ifS, zS, hS, bS, fS, vS }) => {
        const persisted = persistedById.get(String(tx._id));
        // Skip if persistence says it's suppressed (user already cleared)
        if (persisted && ANOMALY_SUPPRESS_STATUSES.includes(persisted.status)) return null;
        const confidence = persisted?.confidence ?? Math.round(score * 100);
        return {
          id:               tx._id,
          alertId:          persisted?._id || null,
          title:            tx.description,
          severity:         toSeverity(score),
          reason:           buildShortReason(tx, score, agg, allFlags),
          explanation:      buildExplanation(tx, { isolationForest: ifS, zScore: zS, heuristic: hS, behavioral: bS, frequency: fS, velocity: vS }, allFlags, agg),
          triggeredRules:   allFlags,
          scoreBreakdown:   {
            isolationForest: Number(ifS.toFixed(4)),
            zScore:          Number(zS.toFixed(4)),
            heuristic:       Number(hS.toFixed(4)),
            behavioral:      Number(bS.toFixed(4)),
            frequency:       Number(fS.toFixed(4)),
            velocity:        Number(vS.toFixed(4)),
          },
          confidence,
          date:             tx.transactionDate,
          amount:           tx.amount,
          anomalyScore:     Math.round(score * 100),
          fraudRiskLevel:   toFraudRisk(score),
          anomalyStatus:    toAnomalyStatus(score),
          transactionType:  tx.transactionType,
          transactionMode:  tx.transactionMode,
          status:           persisted?.status || ANOMALY_STATUS.PENDING,
        };
      })
      .filter(Boolean);

    return {
      scanId,
      anomaliesFound: anomalies.length,
      alertsCreated:  upsertResult.created,
      alertsUpdated:  upsertResult.updated,
      suppressed:     suppressedCount + upsertResult.suppressed,
      rescanned:      upsertResult.rescanned,
      anomalies,
      totalScanned:   txns.length,
      message:        anomalies.length
        ? `Found ${anomalies.length} suspicious transaction${anomalies.length > 1 ? 's' : ''} out of ${txns.length} scanned (${suppressedCount} previously cleared).`
        : `All ${txns.length} transactions appear normal${suppressedCount ? ` (${suppressedCount} previously cleared)` : ''}.`,
    };
  }

  /**
   * Retrieve stored alerts for a business (paginated).
   */
  async getAlerts(businessId, status = null, pagination = {}) {
    const result = await anomalyRepository.getByBusiness(businessId, status, pagination);
    return {
      anomalies: result.data.map(alert => {
        const tx    = alert.journalEntryId;
        const score = alert.anomalyScore;
        return {
          id:               alert._id,
          alertId:          alert._id,
          title:            tx?.description || 'Unknown Transaction',
          severity:         toSeverity(score),
          reason:           alert.reason,
          explanation:      alert.explanation || alert.reason,
          triggeredRules:   alert.triggeredRules || [],
          scoreBreakdown:   alert.scoreBreakdown || {},
          confidence:       alert.confidence ?? Math.round(score * 100),
          date:             tx?.transactionDate || alert.detectedAt,
          amount:           tx?.amount ?? null,
          anomalyScore:     Math.round(score * 100),
          fraudRiskLevel:   toFraudRisk(score),
          anomalyStatus:    toAnomalyStatus(score),
          transactionType:  tx?.transactionType || null,
          status:           alert.status,
          detectedAt:       alert.detectedAt,
          reviewedAt:       alert.reviewedAt || null,
          reviewedBy:       alert.reviewedBy || null,
          reviewNotes:      alert.reviewNotes || '',
          scanId:           alert.scanId,
        };
      }),
      total: result.total,
      page:  result.page,
      limit: result.limit,
    };
  }

  /**
   * User reviews an alert.
   * Accepts new action names AND legacy names for backward-compat.
   */
  async reviewAlert(alertId, action, userId, notes = '') {
    // Map both old & new action names → canonical status
    const statusMap = {
      legitimate:       ANOMALY_STATUS.MARKED_LEGIT,
      legit:            ANOMALY_STATUS.MARKED_LEGIT,
      mark_legit:       ANOMALY_STATUS.MARKED_LEGIT,
      marked_legit:     ANOMALY_STATUS.MARKED_LEGIT,
      fraud:            ANOMALY_STATUS.CONFIRMED_FRAUD,
      confirm_fraud:    ANOMALY_STATUS.CONFIRMED_FRAUD,
      confirmed_fraud:  ANOMALY_STATUS.CONFIRMED_FRAUD,
      ignore:           ANOMALY_STATUS.IGNORED,
      ignored:          ANOMALY_STATUS.IGNORED,
      dismiss:          ANOMALY_STATUS.IGNORED,
    };
    const status = statusMap[action];
    if (!status) {
      throw new Error(`Invalid action "${action}". Use: legitimate | fraud | ignore.`);
    }
    return anomalyRepository.updateAlertStatus(alertId, status, userId, notes);
  }

  async getStats(businessId) {
    return anomalyRepository.countByBusinessAndStatus(businessId);
  }
}

module.exports = new AnomalyDetectionService();
