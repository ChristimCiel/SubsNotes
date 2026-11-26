/**
 * Judge Mode + sample fixture data for the product demo.
 * All merchants are fictional AI/SaaS tools (except Premium Streaming used by T1/T2 demos).
 */

import { createBudget, allocateBudget } from './budget.mjs';
import { generateRecommendation } from './recommendations.mjs';
import { MandateManager } from './mandates.mjs';
import { MockExecutor } from './mock-executor.mjs';

/**
 * Create judge / overview demo data (fictional AI tool stack).
 */
export function createJudgeData() {
  let budget = createBudget(100);

  const subscriptions = [
    {
      merchant: 'Lumen Chat Plus',
      amount: 20.00,
      cadence: 'monthly',
      status: 'active',
      nextDate: '2026-12-01',
      category: 'Chat',
      priceHistory: [
        { amount: 16.00, effectiveDate: '2025-01-01' },
        { amount: 20.00, effectiveDate: '2026-11-01' }
      ]
    },
    {
      merchant: 'Quillmate Pro',
      amount: 18.00,
      cadence: 'monthly',
      status: 'active',
      nextDate: '2026-12-03',
      category: 'Chat'
    },
    {
      merchant: 'PromptForge Team',
      amount: 29.00,
      cadence: 'monthly',
      status: 'active',
      nextDate: '2026-12-08',
      category: 'Coding',
      essentialService: true
    },
    {
      merchant: 'Pixelloom Studio',
      amount: 15.00,
      cadence: 'monthly',
      status: 'active',
      nextDate: '2026-11-30',
      category: 'Image',
      trial: {
        endsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
      }
    },
    {
      merchant: 'Vectorly Notes',
      amount: 10.00,
      cadence: 'monthly',
      status: 'active',
      nextDate: '2026-12-12',
      category: 'Notes'
    },
    {
      merchant: 'Draftwise',
      amount: 12.00,
      cadence: 'monthly',
      status: 'active',
      nextDate: '2026-12-10',
      category: 'Notes'
    },
    {
      merchant: 'CodePilot X',
      amount: 24.00,
      cadence: 'monthly',
      status: 'active',
      nextDate: '2026-12-15',
      category: 'Coding',
      essentialService: true
    }
  ];

  subscriptions.forEach((sub) => {
    budget = allocateBudget(budget, sub);
  });

  return {
    budget,
    subscriptions,
    mandateManager: new MandateManager()
  };
}

/**
 * Generate recommendations for demo / overview.
 */
export function generateJudgeRecommendations(subscriptions, budget) {
  return subscriptions.map((sub) => {
    const usageData = sub.merchant === 'Draftwise'
      ? { lastAccessDays: 75 }
      : undefined;

    const similarServices = subscriptions.filter(
      (s) => s.merchant !== sub.merchant && s.category === sub.category
    );

    const recommendation = generateRecommendation(sub, {
      budget,
      usageData,
      similarServices
    });

    return {
      subscription: sub,
      recommendation
    };
  }).sort((a, b) => a.recommendation.priority - b.recommendation.priority);
}

/**
 * Summarize stack metrics for the hero snapshot (deterministic).
 */
export function getStackSnapshot(budget, recommendations) {
  const allocated = budget.allocations
    .filter((a) => a.status === 'active')
    .reduce((sum, a) => sum + (a.cadence === 'annual' ? a.amount / 12 : a.amount), 0);

  const actionable = recommendations.filter((r) => r.recommendation.type !== 'keep');
  const overlaps = recommendations.filter((r) =>
    (r.recommendation.risks || []).includes('duplicate')
  ).length;
  const unused = recommendations.filter((r) =>
    (r.recommendation.risks || []).includes('unused')
  ).length;

  const potentialSaving = actionable.reduce((sum, r) => {
    if (r.recommendation.type === 'cancel' || r.recommendation.type === 'downgrade') {
      const amt = r.subscription.cadence === 'annual'
        ? r.subscription.amount / 12
        : r.subscription.amount;
      return sum + amt;
    }
    return sum;
  }, 0);

  return {
    spent: allocated,
    envelope: budget.monthlyLimit,
    reviewCount: Math.min(3, actionable.length),
    potentialSaving,
    tools: budget.allocations.length,
    overlaps,
    unused,
    findings: actionable.slice(0, 3)
  };
}

/**
 * CLI / offline judge demo (auto-approves for scripted console use only).
 */
export async function runJudgeDemo() {
  console.log('SubsNotes v1 MVP - Judge Mode Demo\n');

  const data = createJudgeData();
  const recommendations = generateJudgeRecommendations(data.subscriptions, data.budget);
  const topRec = recommendations[0];
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  const mandate = data.mandateManager.createMandate({
    merchant: topRec.subscription.merchant,
    action: 'cancel',
    scope: 'single',
    maxAmount: topRec.subscription.amount,
    expiresAt: futureDate.toISOString()
  });

  const approved = data.mandateManager.approveMandate(mandate.id, 'user_signature_demo');
  const executor = new MockExecutor();
  const result = await executor.execute(approved, {
    subscriptionDetails: topRec.subscription
  });

  if (result.success) {
    data.mandateManager.executeMandate(mandate.id, result);
  }

  const auditLog = data.mandateManager.getAuditLog();
  const entries = auditLog.getAllEntries();

  return {
    data,
    recommendations,
    mandate: approved,
    executionResult: result,
    auditLog: entries
  };
}
