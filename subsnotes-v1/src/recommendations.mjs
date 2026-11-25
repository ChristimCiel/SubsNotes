/**
 * Recommendation engine for subscription management
 * Analyzes subscriptions and provides keep/downgrade/cancel recommendations
 */

/**
 * Recommendation types
 */
export const RECOMMENDATION_TYPES = {
  KEEP: 'keep',
  DOWNGRADE: 'downgrade',
  CANCEL: 'cancel'
};

/**
 * Risk levels for subscriptions
 */
export const RISK_LEVELS = {
  PRICE_INCREASE: 'price_increase',
  FREE_TRIAL_EXPIRING: 'free_trial_expiring',
  UNUSED: 'unused',
  DUPLICATE: 'duplicate',
  OVER_BUDGET: 'over_budget'
};

/**
 * Analyze subscription and generate recommendation
 * @param {Object} subscription - Subscription data
 * @param {Object} context - { budget, similarServices, usageData }
 * @returns {Object} Recommendation
 */
export function generateRecommendation(subscription, context = {}) {
  const { budget, similarServices = [], usageData } = context;
  
  const reasons = [];
  let type = RECOMMENDATION_TYPES.KEEP;
  let confidence = 0.7;
  let risks = [];

  // Check for price increase
  if (subscription.priceHistory && subscription.priceHistory.length > 1) {
    const latestPrice = subscription.priceHistory[subscription.priceHistory.length - 1];
    const previousPrice = subscription.priceHistory[subscription.priceHistory.length - 2];
    
    if (latestPrice.amount > previousPrice.amount) {
      const increase = ((latestPrice.amount - previousPrice.amount) / previousPrice.amount * 100).toFixed(1);
      reasons.push(`Price increased by ${increase}% from $${previousPrice.amount} to $${latestPrice.amount}`);
      risks.push(RISK_LEVELS.PRICE_INCREASE);
      
      if (parseFloat(increase) > 20) {
        type = RECOMMENDATION_TYPES.DOWNGRADE;
        confidence = 0.8;
      }
    }
  }

  // Check for free trial expiry
  if (subscription.trial && subscription.trial.endsAt) {
    const daysUntilExpiry = Math.ceil((new Date(subscription.trial.endsAt) - new Date()) / (1000 * 60 * 60 * 24));
    
    if (daysUntilExpiry > 0 && daysUntilExpiry <= 7) {
      reasons.push(`Free trial expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}`);
      reasons.push(`Will charge $${subscription.amount}/${subscription.cadence === 'annual' ? 'year' : 'month'} after trial`);
      risks.push(RISK_LEVELS.FREE_TRIAL_EXPIRING);
      confidence = 0.9;
    }
  }

  // Check for low usage
  if (usageData && usageData.lastAccessDays > 60) {
    reasons.push(`Not used in ${usageData.lastAccessDays} days`);
    risks.push(RISK_LEVELS.UNUSED);
    type = RECOMMENDATION_TYPES.CANCEL;
    confidence = 0.85;
  } else if (usageData && usageData.lastAccessDays > 30) {
    reasons.push(`Last used ${usageData.lastAccessDays} days ago`);
    risks.push(RISK_LEVELS.UNUSED);
    
    if (type === RECOMMENDATION_TYPES.KEEP) {
      type = RECOMMENDATION_TYPES.DOWNGRADE;
      confidence = 0.75;
    }
  }

  // Check for duplicate services
  if (similarServices.length > 0) {
    const duplicates = similarServices.filter(s => s.category === subscription.category);
    if (duplicates.length > 0) {
      reasons.push(`Similar services: ${duplicates.map(s => s.merchant).join(', ')}`);
      risks.push(RISK_LEVELS.DUPLICATE);
      
      if (type === RECOMMENDATION_TYPES.KEEP) {
        type = RECOMMENDATION_TYPES.DOWNGRADE;
        confidence = 0.8;
      }
    }
  }

  // Check budget impact
  if (budget) {
    const monthlyAmount = subscription.cadence === 'annual' 
      ? subscription.amount / 12 
      : subscription.amount;
    
    const percentOfBudget = (monthlyAmount / budget.monthlyLimit) * 100;
    
    if (percentOfBudget > 25) {
      reasons.push(`Uses ${percentOfBudget.toFixed(1)}% of monthly budget ($${monthlyAmount.toFixed(2)})`);
      risks.push(RISK_LEVELS.OVER_BUDGET);
      
      if (type === RECOMMENDATION_TYPES.KEEP && risks.length > 1) {
        type = RECOMMENDATION_TYPES.DOWNGRADE;
        confidence = 0.8;
      }
    }
  }

  // If no concerning factors, recommend keeping with positive reasons
  if (reasons.length === 0) {
    if (subscription.essentialService) {
      reasons.push('Essential service for your workflow');
      confidence = 0.95;
    } else {
      reasons.push('Active subscription within budget');
      confidence = 0.8;
    }
  }

  return {
    type,
    confidence,
    reasons,
    risks,
    priority: calculatePriority(risks, type),
    actions: generateActions(type, subscription)
  };
}

/**
 * Calculate priority score for recommendations
 */
function calculatePriority(risks, type) {
  if (risks.includes(RISK_LEVELS.FREE_TRIAL_EXPIRING)) return 1;
  if (risks.includes(RISK_LEVELS.PRICE_INCREASE)) return 2;
  if (type === RECOMMENDATION_TYPES.CANCEL) return 3;
  if (type === RECOMMENDATION_TYPES.DOWNGRADE) return 4;
  return 5;
}

/**
 * Generate actionable steps based on recommendation
 */
function generateActions(type, subscription) {
  const actions = [];

  if (type === RECOMMENDATION_TYPES.CANCEL) {
    actions.push({
      action: 'cancel',
      label: 'Cancel subscription',
      tier: determineTier(subscription.merchant),
      requiresApproval: true
    });
  } else if (type === RECOMMENDATION_TYPES.DOWNGRADE) {
    if (subscription.plans && subscription.plans.length > 1) {
      const currentPlanIndex = subscription.plans.findIndex(p => p.id === subscription.currentPlanId);
      const lowerPlans = subscription.plans.slice(0, currentPlanIndex);
      
      if (lowerPlans.length > 0) {
        actions.push({
          action: 'downgrade',
          label: `Downgrade to ${lowerPlans[lowerPlans.length - 1].name}`,
          tier: determineTier(subscription.merchant),
          requiresApproval: true,
          estimatedSavings: subscription.amount - lowerPlans[lowerPlans.length - 1].price
        });
      }
    }
    
    actions.push({
      action: 'cancel',
      label: 'Cancel instead',
      tier: determineTier(subscription.merchant),
      requiresApproval: true
    });
  }

  actions.push({
    action: 'review',
    label: 'Review later',
    tier: 'manual',
    requiresApproval: false
  });

  return actions;
}

/**
 * Determine execution tier for merchant
 */
function determineTier(merchant) {
  const t0Merchants = ['Apple', 'Google Play', 'LINE Pay', '全支付', '街口支付'];
  const t2Merchants = ['FictionalMerchant'];
  
  if (t0Merchants.some(m => merchant.includes(m))) return 'T0';
  if (t2Merchants.some(m => merchant.includes(m))) return 'T2';
  return 'T1';
}

/**
 * Detect price increase from subscription history
 * @param {Object} subscription - Subscription with priceHistory
 * @returns {Object|null} Price increase info or null
 */
export function detectPriceIncrease(subscription) {
  if (!subscription.priceHistory || subscription.priceHistory.length < 2) {
    return null;
  }

  const sorted = [...subscription.priceHistory].sort((a, b) => 
    new Date(a.effectiveDate) - new Date(b.effectiveDate)
  );

  const latest = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2];

  if (latest.amount > previous.amount) {
    const increase = latest.amount - previous.amount;
    const percentIncrease = (increase / previous.amount) * 100;

    return {
      detected: true,
      previousAmount: previous.amount,
      newAmount: latest.amount,
      increase,
      percentIncrease: Math.round(percentIncrease * 10) / 10,
      effectiveDate: latest.effectiveDate,
      severity: percentIncrease > 20 ? 'high' : percentIncrease > 10 ? 'medium' : 'low'
    };
  }

  return null;
}

/**
 * Check if free trial is expiring soon
 * @param {Object} subscription - Subscription with trial info
 * @param {number} warningDays - Days before expiry to warn (default 7)
 * @returns {Object|null} Trial expiry info or null
 */
export function checkTrialExpiry(subscription, warningDays = 7) {
  if (!subscription.trial || !subscription.trial.endsAt) {
    return null;
  }

  const now = new Date();
  const expiryDate = new Date(subscription.trial.endsAt);
  const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

  if (daysUntilExpiry > 0 && daysUntilExpiry <= warningDays) {
    return {
      expiring: true,
      daysRemaining: daysUntilExpiry,
      expiryDate: subscription.trial.endsAt,
      willCharge: subscription.amount,
      cadence: subscription.cadence,
      severity: daysUntilExpiry <= 2 ? 'urgent' : daysUntilExpiry <= 5 ? 'high' : 'medium'
    };
  }

  return null;
}

/**
 * Batch analyze multiple subscriptions
 * @param {Array} subscriptions - List of subscriptions
 * @param {Object} context - Shared context for analysis
 * @returns {Array} Recommendations sorted by priority
 */
export function batchAnalyze(subscriptions, context = {}) {
  const recommendations = subscriptions.map(sub => ({
    subscriptionId: sub.id,
    merchant: sub.merchant,
    recommendation: generateRecommendation(sub, {
      ...context,
      similarServices: subscriptions.filter(s => 
        s.id !== sub.id && s.category === sub.category
      )
    })
  }));

  return recommendations.sort((a, b) => 
    a.recommendation.priority - b.recommendation.priority
  );
}
