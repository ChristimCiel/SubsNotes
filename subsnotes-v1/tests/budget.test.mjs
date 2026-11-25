import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBudget,
  allocateBudget,
  updateAllocationStatus,
  addCommitment,
  calculateMetrics,
  checkCapacity,
  getBudgetSummary
} from '../src/budget.mjs';

test('createBudget creates valid budget envelope', () => {
  const budget = createBudget(100);
  
  assert.strictEqual(budget.monthlyLimit, 100);
  assert.ok(Array.isArray(budget.allocations));
  assert.strictEqual(budget.allocations.length, 0);
  assert.ok(budget.created);
});

test('createBudget rejects invalid limit', () => {
  assert.throws(() => createBudget(0), /Monthly limit must be a positive number/);
  assert.throws(() => createBudget(-50), /Monthly limit must be a positive number/);
  assert.throws(() => createBudget('100'), /Monthly limit must be a positive number/);
});

test('allocateBudget adds monthly subscription', () => {
  let budget = createBudget(100);
  
  budget = allocateBudget(budget, {
    merchant: 'Netflix',
    amount: 15.99,
    cadence: 'monthly'
  });

  assert.strictEqual(budget.allocations.length, 1);
  assert.strictEqual(budget.allocations[0].merchant, 'Netflix');
  assert.strictEqual(budget.allocations[0].amount, 15.99);
  assert.strictEqual(budget.allocations[0].monthlyAmount, 15.99);
  assert.strictEqual(budget.allocations[0].status, 'active');
});

test('allocateBudget calculates monthly equivalent for annual subscription', () => {
  let budget = createBudget(100);
  
  budget = allocateBudget(budget, {
    merchant: 'GitHub Pro',
    amount: 84.00,
    cadence: 'annual'
  });

  assert.strictEqual(budget.allocations[0].amount, 84.00);
  assert.strictEqual(budget.allocations[0].monthlyAmount, 7.00);
});

test('allocateBudget validates inputs', () => {
  const budget = createBudget(100);
  
  assert.throws(() => allocateBudget(budget, { amount: 10, cadence: 'monthly' }), /Merchant name is required/);
  assert.throws(() => allocateBudget(budget, { merchant: 'Test', cadence: 'monthly' }), /Amount must be a positive number/);
  assert.throws(() => allocateBudget(budget, { merchant: 'Test', amount: 10 }), /Cadence must be monthly or annual/);
});

test('updateAllocationStatus changes allocation status', () => {
  let budget = createBudget(100);
  
  budget = allocateBudget(budget, {
    merchant: 'Spotify',
    amount: 9.99,
    cadence: 'monthly'
  });

  const allocationId = budget.allocations[0].id;
  budget = updateAllocationStatus(budget, allocationId, 'cancelled');

  assert.strictEqual(budget.allocations[0].status, 'cancelled');
});

test('addCommitment adds mandate commitment', () => {
  let budget = createBudget(100);
  
  budget = addCommitment(budget, {
    merchant: 'Canva',
    action: 'cancel',
    maxAmount: 12.99,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  });

  assert.strictEqual(budget.commitments.length, 1);
  assert.strictEqual(budget.commitments[0].merchant, 'Canva');
  assert.strictEqual(budget.commitments[0].action, 'cancel');
  assert.strictEqual(budget.commitments[0].status, 'active');
});

test('addCommitment validates action type', () => {
  const budget = createBudget(100);
  
  assert.throws(
    () => addCommitment(budget, { merchant: 'Test', action: 'delete' }),
    /Action must be keep, downgrade, or cancel/
  );
});

test('calculateMetrics computes budget utilization', () => {
  let budget = createBudget(100);
  
  budget = allocateBudget(budget, { merchant: 'Netflix', amount: 15.99, cadence: 'monthly' });
  budget = allocateBudget(budget, { merchant: 'Spotify', amount: 9.99, cadence: 'monthly' });
  budget = allocateBudget(budget, { merchant: 'GitHub Pro', amount: 84.00, cadence: 'annual' });

  const metrics = calculateMetrics(budget);

  assert.strictEqual(metrics.monthlyLimit, 100);
  assert.strictEqual(metrics.allocated, 32.98);
  assert.strictEqual(metrics.remaining, 67.02);
  assert.strictEqual(metrics.utilization, 32.98);
  assert.strictEqual(metrics.activeSubscriptionCount, 3);
});

test('calculateMetrics handles cancelled subscriptions', () => {
  let budget = createBudget(100);
  
  budget = allocateBudget(budget, { merchant: 'Netflix', amount: 15.99, cadence: 'monthly' });
  budget = allocateBudget(budget, { merchant: 'Spotify', amount: 9.99, cadence: 'monthly' });
  
  const spotifyId = budget.allocations[1].id;
  budget = updateAllocationStatus(budget, spotifyId, 'cancelled');

  const metrics = calculateMetrics(budget);

  assert.strictEqual(metrics.activeSubscriptionCount, 1);
  assert.strictEqual(metrics.allocated, 15.99);
});

test('calculateMetrics breaks down by cadence', () => {
  let budget = createBudget(100);
  
  budget = allocateBudget(budget, { merchant: 'Netflix', amount: 15.99, cadence: 'monthly' });
  budget = allocateBudget(budget, { merchant: 'GitHub Pro', amount: 84.00, cadence: 'annual' });

  const metrics = calculateMetrics(budget);

  assert.strictEqual(metrics.breakdown.monthly, 15.99);
  assert.strictEqual(metrics.breakdown.annual, 7.00);
});

test('calculateMetrics counts active commitments', () => {
  let budget = createBudget(100);
  
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  
  budget = addCommitment(budget, { merchant: 'Service1', action: 'cancel', expiresAt: future });
  budget = addCommitment(budget, { merchant: 'Service2', action: 'downgrade', expiresAt: future });
  budget = addCommitment(budget, { merchant: 'Service3', action: 'cancel', expiresAt: past });

  const metrics = calculateMetrics(budget);

  assert.strictEqual(metrics.commitments.total, 3);
  assert.strictEqual(metrics.commitments.active, 2);
  assert.strictEqual(metrics.commitments.pending, 2);
});

test('checkCapacity allows subscription within budget', () => {
  let budget = createBudget(100);
  budget = allocateBudget(budget, { merchant: 'Netflix', amount: 15.99, cadence: 'monthly' });

  const result = checkCapacity(budget, 20.00);

  assert.strictEqual(result.canAccommodate, true);
  assert.strictEqual(result.remaining, 84.01);
  assert.strictEqual(result.shortfall, 0);
});

test('checkCapacity rejects subscription over budget', () => {
  let budget = createBudget(100);
  budget = allocateBudget(budget, { merchant: 'Netflix', amount: 15.99, cadence: 'monthly' });
  budget = allocateBudget(budget, { merchant: 'Spotify', amount: 9.99, cadence: 'monthly' });

  const result = checkCapacity(budget, 80.00);

  assert.strictEqual(result.canAccommodate, false);
  assert.strictEqual(result.shortfall, 5.98);
  assert.match(result.reason, /Budget shortfall/);
});

test('getBudgetSummary formats for UI display', () => {
  let budget = createBudget(100);
  budget = allocateBudget(budget, { merchant: 'Netflix', amount: 15.99, cadence: 'monthly' });
  budget = allocateBudget(budget, { merchant: 'GitHub Pro', amount: 84.00, cadence: 'annual' });

  const summary = getBudgetSummary(budget);

  assert.strictEqual(summary.limit, '$100.00');
  assert.strictEqual(summary.allocated, '$22.99');
  assert.strictEqual(summary.remaining, '$77.01');
  assert.strictEqual(summary.utilizationPercent, '23.0%');
  assert.strictEqual(summary.status, 'healthy');
  assert.strictEqual(summary.subscriptionCount, 2);
});

test('getBudgetSummary indicates over budget status', () => {
  let budget = createBudget(50);
  budget = allocateBudget(budget, { merchant: 'Service1', amount: 30, cadence: 'monthly' });
  budget = allocateBudget(budget, { merchant: 'Service2', amount: 25, cadence: 'monthly' });

  const summary = getBudgetSummary(budget);

  assert.strictEqual(summary.status, 'over_budget');
  assert.match(summary.utilizationPercent, /110/);
});

test('getBudgetSummary indicates near limit status', () => {
  let budget = createBudget(100);
  budget = allocateBudget(budget, { merchant: 'Service1', amount: 92, cadence: 'monthly' });

  const summary = getBudgetSummary(budget);

  assert.strictEqual(summary.status, 'near_limit');
  assert.match(summary.utilizationPercent, /92/);
});
