/**
 * Judge Mode - One-click demo with preloaded fictional data
 * Works completely offline for competition judges
 */

import { createBudget, allocateBudget, updateAllocationStatus } from './budget.mjs';
import { generateRecommendation } from './recommendations.mjs';
import { MandateManager } from './mandates.mjs';
import { MockExecutor } from './executor.mjs';

/**
 * Create judge mode demo data
 */
export function createJudgeData() {
  // Create budget with fictional allocation
  let budget = createBudget(100);

  const subscriptions = [
    {
      merchant: 'Netflix',
      amount: 15.99,
      cadence: 'monthly',
      status: 'active',
      nextDate: '2026-12-01',
      priceHistory: [
        { amount: 13.99, effectiveDate: '2025-01-01' },
        { amount: 15.99, effectiveDate: '2026-11-01' }
      ]
    },
    {
      merchant: 'Spotify',
      amount: 9.99,
      cadence: 'monthly',
      status: 'active',
      nextDate: '2026-12-05',
      category: 'Music'
    },
    {
      merchant: 'GitHub Pro',
      amount: 84.00,
      cadence: 'annual',
      status: 'active',
      nextDate: '2027-01-15',
      essentialService: true,
      category: 'Development'
    },
    {
      merchant: 'Canva Pro',
      amount: 12.99,
      cadence: 'monthly',
      status: 'active',
      nextDate: '2026-11-30',
      trial: {
        endsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
      },
      category: 'Design'
    },
    {
      merchant: 'Old Unused Service',
      amount: 19.99,
      cadence: 'monthly',
      status: 'active',
      nextDate: '2026-12-10',
      category: 'Other'
    }
  ];

  // Allocate all subscriptions to budget
  subscriptions.forEach(sub => {
    budget = allocateBudget(budget, sub);
  });

  return {
    budget,
    subscriptions,
    mandateManager: new MandateManager()
  };
}

/**
 * Generate recommendations for judge demo
 */
export function generateJudgeRecommendations(subscriptions, budget) {
  return subscriptions.map((sub, index) => {
    const usageData = sub.merchant === 'Old Unused Service' 
      ? { lastAccessDays: 75 } 
      : undefined;

    const recommendation = generateRecommendation(sub, {
      budget,
      usageData,
      similarServices: []
    });

    return {
      subscription: sub,
      recommendation
    };
  }).sort((a, b) => a.recommendation.priority - b.recommendation.priority);
}

/**
 * Run the complete judge mode demo
 */
export async function runJudgeDemo() {
  console.log('🎭 SubsNotes v1 MVP - Judge Mode Demo\n');
  console.log('=' .repeat(60));
  console.log('\n📊 Step 1: Initialize Budget\n');

  const data = createJudgeData();
  console.log(`Monthly Budget: $${data.budget.monthlyLimit.toFixed(2)}`);
  console.log(`Active Subscriptions: ${data.subscriptions.length}`);

  console.log('\n' + '=' .repeat(60));
  console.log('\n🤖 Step 2: AI Recommendations\n');

  const recommendations = generateJudgeRecommendations(data.subscriptions, data.budget);
  
  recommendations.forEach((rec, i) => {
    console.log(`${i + 1}. ${rec.subscription.merchant}`);
    console.log(`   Recommendation: ${rec.recommendation.type.toUpperCase()}`);
    console.log(`   Confidence: ${(rec.recommendation.confidence * 100).toFixed(0)}%`);
    console.log(`   Reasons:`);
    rec.recommendation.reasons.forEach(reason => {
      console.log(`   - ${reason}`);
    });
    console.log('');
  });

  console.log('=' .repeat(60));
  console.log('\n✅ Step 3: User Approves Action\n');

  // Create a mandate for the top recommendation (should be trial expiring)
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

  console.log(`Mandate Created: ${mandate.id}`);
  console.log(`Merchant: ${mandate.merchant}`);
  console.log(`Action: ${mandate.action}`);
  console.log(`Expires: ${new Date(mandate.expiresAt).toLocaleString()}`);

  // User approves the mandate
  const approved = data.mandateManager.approveMandate(mandate.id, 'user_signature_demo');
  console.log(`\nMandate Approved: ${approved.approvedAt}`);

  console.log('\n' + '=' .repeat(60));
  console.log('\n🚀 Step 4: AI Agent Executes\n');

  // Execute the mandate (using mock executor for offline demo)
  const executor = new MockExecutor();
  const result = await executor.execute(approved, {
    subscriptionDetails: topRec.subscription
  });

  if (result.success) {
    data.mandateManager.executeMandate(mandate.id, result);
    console.log(`✅ Execution Successful`);
    console.log(`Message: ${result.message}`);
    console.log(`Confirmation: ${result.evidence.confirmationId}`);
    console.log(`Steps: ${result.evidence.steps.length}`);
    console.log(`Duration: ${result.evidence.duration}ms`);
  } else {
    console.log(`❌ Execution Failed: ${result.message}`);
  }

  console.log('\n' + '=' .repeat(60));
  console.log('\n📋 Step 5: Audit Log\n');

  const auditLog = data.mandateManager.getAuditLog();
  const entries = auditLog.getAllEntries();

  entries.forEach((entry, i) => {
    console.log(`${i + 1}. ${entry.action} - ${entry.result}`);
    console.log(`   Actor: ${entry.actor}`);
    console.log(`   Time: ${new Date(entry.timestamp).toLocaleString()}`);
    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      console.log(`   Metadata: ${JSON.stringify(entry.metadata)}`);
    }
    console.log('');
  });

  console.log('=' .repeat(60));
  console.log('\n🎉 Demo Complete!\n');
  console.log('The closed loop:');
  console.log('  Detect → Judge → Approve → Execute → Verify → Record\n');
  console.log('All operations completed successfully in offline mode.');
  console.log('No ANTHROPIC_API_KEY required for judge mode.\n');

  return {
    data,
    recommendations,
    mandate: approved,
    executionResult: result,
    auditLog: entries
  };
}
