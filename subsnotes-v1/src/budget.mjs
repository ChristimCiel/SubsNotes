/**
 * Budget envelope system
 * Manages monthly subscription budget with allocation tracking
 */

/**
 * Create a new budget envelope
 * @param {number} monthlyLimit - Monthly budget in USD
 * @returns {Object} Budget envelope
 */
export function createBudget(monthlyLimit) {
  if (!Number.isFinite(monthlyLimit) || monthlyLimit <= 0) {
    throw new Error('Monthly limit must be a positive number');
  }

  return {
    monthlyLimit,
    allocations: [],
    commitments: [],
    created: new Date().toISOString(),
    updated: new Date().toISOString()
  };
}

/**
 * Allocate budget to a subscription
 * @param {Object} budget - Budget envelope
 * @param {Object} allocation - { merchant, amount, cadence, status }
 * @returns {Object} Updated budget
 */
export function allocateBudget(budget, allocation) {
  const { merchant, amount, cadence, status = 'active' } = allocation;

  if (!merchant || typeof merchant !== 'string') {
    throw new Error('Merchant name is required');
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be a positive number');
  }

  if (!['monthly', 'annual'].includes(cadence)) {
    throw new Error('Cadence must be monthly or annual');
  }

  // Calculate monthly equivalent
  const monthlyAmount = cadence === 'annual' ? amount / 12 : amount;

  const newAllocation = {
    id: `alloc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    merchant,
    amount,
    cadence,
    monthlyAmount: Math.round(monthlyAmount * 100) / 100,
    status,
    created: new Date().toISOString()
  };

  return {
    ...budget,
    allocations: [...budget.allocations, newAllocation],
    updated: new Date().toISOString()
  };
}

/**
 * Update allocation status
 * @param {Object} budget - Budget envelope
 * @param {string} allocationId - Allocation ID
 * @param {string} status - New status (active, cancelled, pending)
 * @returns {Object} Updated budget
 */
export function updateAllocationStatus(budget, allocationId, status) {
  const validStatuses = ['active', 'cancelled', 'pending'];
  
  if (!validStatuses.includes(status)) {
    throw new Error(`Status must be one of: ${validStatuses.join(', ')}`);
  }

  return {
    ...budget,
    allocations: budget.allocations.map(alloc => 
      alloc.id === allocationId 
        ? { ...alloc, status, updated: new Date().toISOString() }
        : alloc
    ),
    updated: new Date().toISOString()
  };
}

/**
 * Add a commitment (approved mandate)
 * @param {Object} budget - Budget envelope
 * @param {Object} commitment - { merchant, action, maxAmount, expiresAt }
 * @returns {Object} Updated budget
 */
export function addCommitment(budget, commitment) {
  const { merchant, action, maxAmount, expiresAt } = commitment;

  if (!merchant || typeof merchant !== 'string') {
    throw new Error('Merchant name is required');
  }

  if (!['keep', 'downgrade', 'cancel'].includes(action)) {
    throw new Error('Action must be keep, downgrade, or cancel');
  }

  if (maxAmount !== undefined && (!Number.isFinite(maxAmount) || maxAmount < 0)) {
    throw new Error('Max amount must be a non-negative number');
  }

  const newCommitment = {
    id: `commit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    merchant,
    action,
    maxAmount,
    expiresAt,
    status: 'active',
    created: new Date().toISOString()
  };

  return {
    ...budget,
    commitments: [...budget.commitments, newCommitment],
    updated: new Date().toISOString()
  };
}

/**
 * Calculate budget metrics
 * @param {Object} budget - Budget envelope
 * @returns {Object} Metrics
 */
export function calculateMetrics(budget) {
  const activeAllocations = budget.allocations.filter(a => a.status === 'active');
  
  const allocated = activeAllocations.reduce((sum, a) => sum + a.monthlyAmount, 0);
  const remaining = budget.monthlyLimit - allocated;
  const utilization = budget.monthlyLimit > 0 ? (allocated / budget.monthlyLimit) * 100 : 0;

  // Calculate spend by cadence
  const monthlySubscriptions = activeAllocations.filter(a => a.cadence === 'monthly');
  const annualSubscriptions = activeAllocations.filter(a => a.cadence === 'annual');

  const monthlySpend = monthlySubscriptions.reduce((sum, a) => sum + a.monthlyAmount, 0);
  const annualSpend = annualSubscriptions.reduce((sum, a) => sum + a.monthlyAmount, 0);

  // Active commitments (not expired)
  const now = Date.now();
  const activeCommitments = budget.commitments.filter(c => 
    c.status === 'active' && 
    (!c.expiresAt || new Date(c.expiresAt).getTime() > now)
  );

  return {
    monthlyLimit: budget.monthlyLimit,
    allocated: Math.round(allocated * 100) / 100,
    remaining: Math.round(remaining * 100) / 100,
    utilization: Math.round(utilization * 100) / 100,
    activeSubscriptionCount: activeAllocations.length,
    breakdown: {
      monthly: Math.round(monthlySpend * 100) / 100,
      annual: Math.round(annualSpend * 100) / 100
    },
    commitments: {
      total: budget.commitments.length,
      active: activeCommitments.length,
      pending: activeCommitments.filter(c => c.action !== 'keep').length
    }
  };
}

/**
 * Check if budget can accommodate a new subscription
 * @param {Object} budget - Budget envelope
 * @param {number} monthlyAmount - Monthly cost of new subscription
 * @returns {Object} { canAccommodate, remaining, reason }
 */
export function checkCapacity(budget, monthlyAmount) {
  const metrics = calculateMetrics(budget);
  const canAccommodate = metrics.remaining >= monthlyAmount;

  return {
    canAccommodate,
    remaining: metrics.remaining,
    shortfall: canAccommodate ? 0 : Math.round((monthlyAmount - metrics.remaining) * 100) / 100,
    reason: canAccommodate 
      ? 'Budget has sufficient capacity'
      : `Budget shortfall: need ${Math.round((monthlyAmount - metrics.remaining) * 100) / 100} more`
  };
}

/**
 * Get budget summary for display
 * @param {Object} budget - Budget envelope
 * @returns {Object} Summary for UI
 */
export function getBudgetSummary(budget) {
  const metrics = calculateMetrics(budget);
  
  return {
    limit: `$${metrics.monthlyLimit.toFixed(2)}`,
    allocated: `$${metrics.allocated.toFixed(2)}`,
    remaining: `$${metrics.remaining.toFixed(2)}`,
    utilizationPercent: `${metrics.utilization.toFixed(1)}%`,
    status: metrics.utilization > 100 ? 'over_budget' : 
            metrics.utilization > 90 ? 'near_limit' : 'healthy',
    subscriptionCount: metrics.activeSubscriptionCount,
    breakdown: {
      monthly: `$${metrics.breakdown.monthly.toFixed(2)}/mo`,
      annual: `$${metrics.breakdown.annual.toFixed(2)}/mo equivalent`
    },
    commitments: metrics.commitments
  };
}
