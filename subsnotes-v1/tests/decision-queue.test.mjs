/**
 * Decision-queue honesty: waste is sum of real savings, not full subscription prices.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJudgeData,
  generateJudgeRecommendations,
  getDecisionQueue,
  savingFor
} from '../src/judge-mode.mjs';
import { generateRecommendation } from '../src/recommendations.mjs';

describe('getDecisionQueue', () => {
  it('surfaces Lumen → Draftwise → Quillmate with savings 12 / 12 / 8 and waste 32', () => {
    const data = createJudgeData();
    const recommendations = generateJudgeRecommendations(data.subscriptions, data.budget);
    const queue = getDecisionQueue(data.budget, recommendations);

    assert.equal(queue.total, 128);
    assert.equal(queue.tools, 7);
    assert.equal(queue.waste, 32);
    assert.deepEqual(
      queue.findings.map((f) => f.rec.subscription.merchant),
      ['Lumen Chat Plus', 'Draftwise', 'Quillmate Pro']
    );
    assert.deepEqual(
      queue.findings.map((f) => f.saving),
      [12, 12, 8]
    );
  });

  it('savingFor returns null for a downgrade without plans', () => {
    const sub = {
      merchant: 'NoPlan Tool',
      amount: 15,
      cadence: 'monthly',
      category: 'Notes'
    };
    const recommendation = generateRecommendation(sub, {
      similarServices: [{ merchant: 'Other Notes', category: 'Notes' }]
    });
    assert.equal(recommendation.type, 'downgrade');
    const saving = savingFor({ subscription: sub, recommendation });
    assert.equal(saving, null);
  });
});
