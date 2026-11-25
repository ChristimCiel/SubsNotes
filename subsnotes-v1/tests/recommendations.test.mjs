import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOMMENDATION_TYPES,
  RISK_LEVELS,
  generateRecommendation,
  detectPriceIncrease,
  checkTrialExpiry,
  batchAnalyze
} from '../src/recommendations.mjs';

test('generateRecommendation recommends keeping active subscription', () => {
  const subscription = {
    id: 'sub_1',
    merchant: 'GitHub Pro',
    amount: 7.00,
    cadence: 'monthly',
    essentialService: true
  };

  const rec = generateRecommendation(subscription);

  assert.strictEqual(rec.type, RECOMMENDATION_TYPES.KEEP);
  assert.ok(rec.confidence > 0.9);
  assert.ok(rec.reasons.length > 0);
});

test('generateRecommendation detects price increase', () => {
  const subscription = {
    id: 'sub_1',
    merchant: 'Netflix',
    amount: 17.99,
    cadence: 'monthly',
    priceHistory: [
      { amount: 15.99, effectiveDate: '2026-01-01' },
      { amount: 17.99, effectiveDate: '2026-11-01' }
    ]
  };

  const rec = generateRecommendation(subscription);

  assert.ok(rec.reasons.some(r => r.includes('Price increased')));
  assert.ok(rec.risks.includes(RISK_LEVELS.PRICE_INCREASE));
});

test('generateRecommendation warns about expiring free trial', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 3);

  const subscription = {
    id: 'sub_1',
    merchant: 'Canva',
    amount: 12.99,
    cadence: 'monthly',
    trial: {
      endsAt: futureDate.toISOString()
    }
  };

  const rec = generateRecommendation(subscription);

  assert.ok(rec.reasons.some(r => r.includes('Free trial expires')));
  assert.ok(rec.risks.includes(RISK_LEVELS.FREE_TRIAL_EXPIRING));
  assert.strictEqual(rec.priority, 1);
});

test('generateRecommendation recommends cancel for unused service', () => {
  const subscription = {
    id: 'sub_1',
    merchant: 'Unused Service',
    amount: 9.99,
    cadence: 'monthly'
  };

  const usageData = {
    lastAccessDays: 65
  };

  const rec = generateRecommendation(subscription, { usageData });

  assert.strictEqual(rec.type, RECOMMENDATION_TYPES.CANCEL);
  assert.ok(rec.reasons.some(r => r.includes('Not used in')));
  assert.ok(rec.risks.includes(RISK_LEVELS.UNUSED));
});

test('generateRecommendation detects duplicate services', () => {
  const subscription = {
    id: 'sub_1',
    merchant: 'Spotify',
    amount: 9.99,
    cadence: 'monthly',
    category: 'Music'
  };

  const similarServices = [
    { merchant: 'Apple Music', category: 'Music' }
  ];

  const rec = generateRecommendation(subscription, { similarServices });

  assert.ok(rec.reasons.some(r => r.includes('Similar services')));
  assert.ok(rec.risks.includes(RISK_LEVELS.DUPLICATE));
});

test('generateRecommendation flags high budget impact', () => {
  const subscription = {
    id: 'sub_1',
    merchant: 'Expensive Service',
    amount: 30.00,
    cadence: 'monthly'
  };

  const budget = {
    monthlyLimit: 100
  };

  const rec = generateRecommendation(subscription, { budget });

  assert.ok(rec.reasons.some(r => r.includes('% of monthly budget')));
  assert.ok(rec.risks.includes(RISK_LEVELS.OVER_BUDGET));
});

test('generateRecommendation provides actionable steps', () => {
  const subscription = {
    id: 'sub_1',
    merchant: 'Service',
    amount: 20.00,
    cadence: 'monthly'
  };

  const usageData = { lastAccessDays: 70 };
  const rec = generateRecommendation(subscription, { usageData });

  assert.strictEqual(rec.type, RECOMMENDATION_TYPES.CANCEL);
  assert.ok(Array.isArray(rec.actions));
  assert.ok(rec.actions.some(a => a.action === 'cancel'));
});

test('detectPriceIncrease identifies price changes', () => {
  const subscription = {
    priceHistory: [
      { amount: 10.00, effectiveDate: '2026-01-01' },
      { amount: 12.50, effectiveDate: '2026-11-01' }
    ]
  };

  const result = detectPriceIncrease(subscription);

  assert.strictEqual(result.detected, true);
  assert.strictEqual(result.previousAmount, 10.00);
  assert.strictEqual(result.newAmount, 12.50);
  assert.strictEqual(result.increase, 2.50);
  assert.strictEqual(result.percentIncrease, 25.0);
  assert.strictEqual(result.severity, 'high');
});

test('detectPriceIncrease returns null for no increase', () => {
  const subscription = {
    priceHistory: [
      { amount: 10.00, effectiveDate: '2026-01-01' },
      { amount: 10.00, effectiveDate: '2026-11-01' }
    ]
  };

  const result = detectPriceIncrease(subscription);

  assert.strictEqual(result, null);
});

test('detectPriceIncrease returns null for insufficient history', () => {
  const subscription = {
    priceHistory: [
      { amount: 10.00, effectiveDate: '2026-01-01' }
    ]
  };

  const result = detectPriceIncrease(subscription);

  assert.strictEqual(result, null);
});

test('checkTrialExpiry detects expiring trial', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 5);

  const subscription = {
    amount: 15.99,
    cadence: 'monthly',
    trial: {
      endsAt: futureDate.toISOString()
    }
  };

  const result = checkTrialExpiry(subscription);

  assert.strictEqual(result.expiring, true);
  assert.strictEqual(result.daysRemaining, 5);
  assert.strictEqual(result.willCharge, 15.99);
  assert.strictEqual(result.severity, 'high');
});

test('checkTrialExpiry returns null for far-future expiry', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 30);

  const subscription = {
    amount: 15.99,
    cadence: 'monthly',
    trial: {
      endsAt: futureDate.toISOString()
    }
  };

  const result = checkTrialExpiry(subscription);

  assert.strictEqual(result, null);
});

test('checkTrialExpiry marks urgent for 1-2 days remaining', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 1);

  const subscription = {
    amount: 15.99,
    cadence: 'monthly',
    trial: {
      endsAt: futureDate.toISOString()
    }
  };

  const result = checkTrialExpiry(subscription);

  assert.strictEqual(result.severity, 'urgent');
});

test('batchAnalyze processes multiple subscriptions', () => {
  const subscriptions = [
    {
      id: 'sub_1',
      merchant: 'Netflix',
      amount: 15.99,
      cadence: 'monthly',
      category: 'Entertainment'
    },
    {
      id: 'sub_2',
      merchant: 'Spotify',
      amount: 9.99,
      cadence: 'monthly',
      category: 'Music'
    },
    {
      id: 'sub_3',
      merchant: 'GitHub Pro',
      amount: 7.00,
      cadence: 'monthly',
      category: 'Development',
      essentialService: true
    }
  ];

  const results = batchAnalyze(subscriptions);

  assert.strictEqual(results.length, 3);
  assert.ok(results.every(r => r.subscriptionId));
  assert.ok(results.every(r => r.recommendation));
});

test('batchAnalyze detects duplicates within batch', () => {
  const subscriptions = [
    {
      id: 'sub_1',
      merchant: 'Spotify',
      amount: 9.99,
      cadence: 'monthly',
      category: 'Music'
    },
    {
      id: 'sub_2',
      merchant: 'Apple Music',
      amount: 10.99,
      cadence: 'monthly',
      category: 'Music'
    }
  ];

  const results = batchAnalyze(subscriptions);

  const spotifyRec = results.find(r => r.subscriptionId === 'sub_1');
  const appleMusicRec = results.find(r => r.subscriptionId === 'sub_2');

  assert.ok(spotifyRec.recommendation.risks.includes(RISK_LEVELS.DUPLICATE));
  assert.ok(appleMusicRec.recommendation.risks.includes(RISK_LEVELS.DUPLICATE));
});

test('batchAnalyze sorts by priority', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 2);

  const subscriptions = [
    {
      id: 'sub_1',
      merchant: 'Normal Service',
      amount: 10.00,
      cadence: 'monthly',
      category: 'Other'
    },
    {
      id: 'sub_2',
      merchant: 'Trial Service',
      amount: 15.00,
      cadence: 'monthly',
      category: 'Other',
      trial: { endsAt: futureDate.toISOString() }
    }
  ];

  const results = batchAnalyze(subscriptions);

  assert.strictEqual(results[0].subscriptionId, 'sub_2');
  assert.strictEqual(results[0].recommendation.priority, 1);
});
