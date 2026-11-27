/**
 * Deterministic analyzer for sample + real user subscriptions.
 * Surfaces one-at-a-time decisions with honest monthly equivalents.
 */

import { generateRecommendation } from './recommendations.mjs';
import { createBudget, allocateBudget } from './budget.mjs';
import {
  createJudgeData,
  generateJudgeRecommendations,
  getDecisionQueue,
  savingFor,
  targetPlanName
} from './judge-mode.mjs';
import { matchMerchant } from './receipt-parser.mjs';

const CATEGORY_OVERLAP = new Set(['Chat', 'Coding', 'Image', 'Notes', 'Video', 'Music', 'Design']);

export function monthlyEquivalent(sub) {
  const amount = Number(sub.amount) || 0;
  return sub.cadence === 'annual' ? amount / 12 : amount;
}

export function formatMoney(amount, currency = 'USD') {
  const n = Math.round(Number(amount) * 100) / 100;
  const pretty = Number.isInteger(n) ? String(n) : n.toFixed(2);
  if (currency === 'TWD') return `NT$${pretty}`;
  if (currency === 'EUR') return `€${pretty}`;
  return `US$${pretty}`;
}

/**
 * Multi-currency monthly totals — never invent exchange rates.
 */
export function spendByCurrency(subscriptions) {
  const map = {};
  for (const sub of subscriptions) {
    if (sub.status === 'cancelled') continue;
    const cur = sub.currency || 'USD';
    map[cur] = (map[cur] || 0) + monthlyEquivalent(sub);
  }
  return map;
}

export function formatSpendBreakdown(byCurrency) {
  const parts = Object.entries(byCurrency)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([cur, amt]) => formatMoney(amt, cur));
  return parts.join(' + ') || formatMoney(0, 'USD');
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

function enrichBilling(sub) {
  if (sub.billingUrl) return sub;
  const hint = matchMerchant(sub.merchant);
  return { ...sub, billingUrl: hint.billingUrl || null, category: sub.category || hint.category };
}

/**
 * Build decision queue for user-owned subscriptions.
 */
export function analyzeUserSubscriptions(subscriptions, { doneIds = new Set() } = {}) {
  const active = subscriptions
    .map(enrichBilling)
    .filter((s) => s.status !== 'cancelled' && !doneIds.has(s.id));

  const decisions = [];

  // 1. Payment failed
  for (const sub of active) {
    if (sub.status === 'payment_failed') {
      decisions.push({
        id: `fail_${sub.id}`,
        kind: 'payment_failed',
        priority: 1,
        subscription: sub,
        saving: monthlyEquivalent(sub),
        titleKey: 'v3.decision.failTitle',
        reasonKey: 'v3.decision.failReason',
        primaryAction: sub.billingUrl ? 'open_billing' : 'copy_email',
        emailKind: 'payment'
      });
    }
  }

  // 2. Trial / promo ending soon (≤ 7 days)
  for (const sub of active) {
    if (sub.status === 'trial') {
      const days = daysUntil(sub.nextDate);
      if (days != null && days <= 7) {
        decisions.push({
          id: `trial_${sub.id}`,
          kind: 'trial_ending',
          priority: 2,
          subscription: sub,
          saving: monthlyEquivalent(sub),
          days,
          titleKey: 'v3.decision.trialTitle',
          reasonKey: 'v3.decision.trialReason',
          primaryAction: sub.billingUrl ? 'open_billing' : 'copy_email',
          emailKind: 'cancel',
          icsDate: sub.nextDate
        });
      }
    }
  }

  // 3. Overlaps in same category (one review per extra tool beyond the keep candidate)
  const byCat = {};
  for (const sub of active) {
    const cat = sub.category || 'Other';
    if (!CATEGORY_OVERLAP.has(cat)) continue;
    (byCat[cat] ||= []).push(sub);
  }
  const urgentIds = new Set(
    decisions.filter((d) => d.priority <= 2).map((d) => d.subscription.id)
  );
  for (const [cat, list] of Object.entries(byCat)) {
    if (list.length < 2) continue;
    // Keep the highest spend as the "keep" candidate; surface the rest as overlaps
    const sorted = [...list].sort((a, b) => monthlyEquivalent(b) - monthlyEquivalent(a));
    const keep = sorted[0];
    for (const target of sorted.slice(1)) {
      if (urgentIds.has(target.id)) continue;
      decisions.push({
        id: `overlap_${target.id}`,
        kind: 'overlap',
        priority: 3,
        subscription: target,
        other: keep,
        category: cat,
        saving: monthlyEquivalent(target),
        titleKey: 'v3.decision.overlapTitle',
        reasonKey: 'v3.decision.overlapReason',
        primaryAction: target.billingUrl ? 'open_billing' : 'copy_email',
        emailKind: 'cancel',
        icsDate: target.nextDate
      });
    }
  }

  // 4. Upcoming annual / high-cost renewals (≤ 14 days, monthly equiv ≥ 15 or annual)
  for (const sub of active) {
    const days = daysUntil(sub.nextDate);
    if (days == null || days < 0 || days > 14) continue;
    const monthly = monthlyEquivalent(sub);
    if (sub.cadence === 'annual' || monthly >= 15) {
      decisions.push({
        id: `renew_${sub.id}`,
        kind: 'renewal',
        priority: 4,
        subscription: sub,
        saving: monthly,
        days,
        titleKey: 'v3.decision.renewTitle',
        reasonKey: 'v3.decision.renewReason',
        primaryAction: 'ics',
        emailKind: 'cancel',
        icsDate: sub.nextDate
      });
    }
  }

  // Dedupe by subscription id keeping highest priority (lowest number)
  const best = new Map();
  for (const d of decisions) {
    const key = d.subscription.id;
    const prev = best.get(key);
    if (!prev || d.priority < prev.priority) best.set(key, d);
  }

  const findings = [...best.values()].sort((a, b) => a.priority - b.priority || b.saving - a.saving);
  const byCurrency = spendByCurrency(subscriptions.filter((s) => s.status !== 'cancelled'));
  const wasteByCurrency = {};
  for (const d of findings) {
    const cur = d.subscription.currency || 'USD';
    wasteByCurrency[cur] = (wasteByCurrency[cur] || 0) + d.saving;
  }

  return {
    mode: 'user',
    tools: subscriptions.filter((s) => s.status !== 'cancelled').length,
    byCurrency,
    totalLabel: formatSpendBreakdown(byCurrency),
    wasteByCurrency,
    wasteLabel: formatSpendBreakdown(wasteByCurrency),
    findings,
    subscriptions
  };
}

/**
 * Sample-mode queue (existing engine) adapted to a common shape.
 */
export function analyzeSampleStack() {
  const data = createJudgeData();
  const recommendations = generateJudgeRecommendations(data.subscriptions, data.budget);
  const queue = getDecisionQueue(data.budget, recommendations);

  const findings = queue.findings.map((item) => {
    let saving = item.saving;
    let kind = item.rec.recommendation.type;
    let plan = targetPlanName(item.rec);
    if (kind === 'downgrade' && saving == null) {
      kind = 'cancel';
      plan = null;
      saving = monthlyEquivalent(item.rec.subscription);
    }
    return {
      id: `sample_${item.rec.subscription.merchant}`,
      kind: kind === 'downgrade' ? 'downgrade' : 'cancel',
      priority: item.rec.recommendation.priority,
      subscription: {
        ...item.rec.subscription,
        currency: 'USD',
        id: `sample_${item.rec.subscription.merchant}`
      },
      saving: saving || 0,
      plan,
      reasons: item.rec.recommendation.reasons || [],
      risks: item.rec.recommendation.risks || [],
      sampleRec: item.rec,
      primaryAction: 'sample_approve'
    };
  });

  return {
    mode: 'sample',
    tools: queue.tools,
    byCurrency: { USD: queue.total },
    totalLabel: formatMoney(queue.total, 'USD'),
    wasteByCurrency: { USD: queue.waste },
    wasteLabel: formatMoney(queue.waste, 'USD'),
    findings,
    subscriptions: data.subscriptions.map((s) => ({
      ...s,
      currency: 'USD',
      id: `sample_${s.merchant}`,
      status: 'active'
    })),
    demo: data
  };
}

export { createJudgeData, generateJudgeRecommendations, getDecisionQueue, savingFor, targetPlanName };
