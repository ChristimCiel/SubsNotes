import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TODAY, CATEGORIES, createInitialState } from '../dist/data.js';
import {
  STORAGE_KEY, money, dateLabel, daysUntil, monthlyCost, forecastAnnual, getMetrics,
  getAttention, getVisibleSubscriptions, updateSubscription, updatePreferences,
  addFeedback, loadState, saveState,
} from '../dist/domain.js';

const store = (initial = null) => ({
  value: initial,
  getItem(key) { assert.equal(key, STORAGE_KEY); return this.value; },
  setItem(key, value) { assert.equal(key, STORAGE_KEY); this.value = value; },
});

test('fixtures have consistent category, monthly, and future-year amounts', () => {
  const state = createInitialState();
  const metrics = getMetrics(state);
  assert.equal(DEMO_TODAY, '2026-10-23');
  assert.equal(metrics.count, 8);
  assert.equal(metrics.monthly, 73.5);
  assert.equal(metrics.annual, 965.99);
  assert.equal(metrics.attentionCount, 3);
  assert.deepEqual(metrics.categories.map((category) => category.name), CATEGORIES);
  assert.equal(metrics.categories.reduce((sum, category) => sum + category.amount, 0), metrics.monthly);
  assert.ok(Math.abs(metrics.categories.reduce((sum, category) => sum + category.percent, 0) - 100) < 0.000001);
  assert.deepEqual(getAttention(state).map((sub) => sub.id), ['github', 'canva', 'notion']);
  assert.notEqual(metrics.annual, metrics.monthly * 12, 'forecast accounts for the expiring promotion');
});

test('upcoming promotion ends before the next charge and uses regular pricing', () => {
  const canva = createInitialState().subscriptions.find((sub) => sub.id === 'canva');
  assert.equal(daysUntil(canva.promo.end), 9);
  assert.equal(monthlyCost(canva), 8);
  assert.equal(forecastAnnual(canva), 180);
});

test('four discounted future charges then eight regular charges', () => {
  const sub = {
    ...createInitialState().subscriptions.find((item) => item.id === 'canva'),
    amount: 10, nextDate: '2026-10-25',
    promo: { end: '2027-02-25', regularPrice: 20, remainingCycles: 4 },
  };
  assert.equal(forecastAnnual(sub), 200);
  assert.equal(forecastAnnual({ ...sub, promo: { ...sub.promo, remainingCycles: 2 } }), 220);
});

test('forecast excludes cancelled and nonrenewing subscriptions and boundary beyond 12 months', () => {
  const sub = createInitialState().subscriptions[0];
  assert.equal(forecastAnnual({ ...sub, autoRenew: false }), 0);
  assert.equal(forecastAnnual({ ...sub, status: 'cancelled' }), 0);
  assert.equal(forecastAnnual({ ...sub, nextDate: '2027-10-23' }), 0);
  assert.equal(forecastAnnual({ ...sub, nextDate: '2026-10-23' }), 96);
  assert.equal(monthlyCost(sub), 8);
});

test('month-end recurring dates do not drift into an extra forecast charge', () => {
  const sub = { ...createInitialState().subscriptions[0], cadence: 'monthly', amount: 10, nextDate: '2026-10-31' };
  assert.equal(forecastAnnual(sub), 120);
});

test('cancel intention preserves costs; simulated confirmation excludes future metrics and is idempotent', () => {
  const state = createInitialState();
  assert.equal(updateSubscription(state, 'notion', 'simulate-cancel'), state);
  const intent = updateSubscription(state, 'notion', 'cancel-intent');
  assert.deepEqual(getMetrics(intent), getMetrics(state));
  assert.equal(intent.subscriptions[0].status, 'active');
  assert.equal(state.subscriptions[0].decision, undefined);
  const cancelled = updateSubscription(intent, 'notion', 'simulate-cancel');
  assert.equal(cancelled.subscriptions[0].status, 'cancelled');
  assert.equal(cancelled.subscriptions[0].autoRenew, false);
  assert.equal(getMetrics(cancelled).annual, 869.99);
  assert.equal(getMetrics(cancelled).monthly, 65.5);
  assert.equal(getMetrics(cancelled).count, 7);
  assert.equal(getMetrics(cancelled).attentionCount, 2);
  assert.equal(getVisibleSubscriptions(cancelled, { filter: 'cancelled' }).length, 1);
  assert.equal(getVisibleSubscriptions(cancelled, { filter: 'all' }).length, 8);
  assert.match(cancelled.activity.at(-1).message, /Simulation complete/);
  assert.equal(updateSubscription(cancelled, 'notion', 'simulate-cancel'), cancelled);
});

test('keep and resolved payment clear appropriate risks without changing forecast', () => {
  const state = createInitialState();
  const kept = updateSubscription(state, 'notion', 'keep');
  assert.equal(getMetrics(kept).annual, getMetrics(state).annual);
  assert.equal(getMetrics(kept).attentionCount, 2);
  assert.equal(state.subscriptions[0].risk, 'renewal');
  assert.equal(updateSubscription(kept, 'notion', 'keep'), kept);
  assert.equal(updateSubscription(state, 'github', 'keep'), state, 'a preference cannot resolve a payment failure');
  const resolved = updateSubscription(kept, 'github', 'resolve-payment');
  assert.equal(getMetrics(resolved).attentionCount, 1);
  assert.equal(getMetrics(resolved).annual, 965.99);
  assert.match(resolved.activity.at(-1).message, /No bank was connected/);
});

test('search, category, attention, and sorting compose without mutating source', () => {
  const state = createInitialState();
  const original = state.subscriptions.map((sub) => sub.id);
  assert.deepEqual(getVisibleSubscriptions(state, { filter: 'Design', query: 'CAN', sort: 'name' }).map((sub) => sub.id), ['canva']);
  assert.equal(getVisibleSubscriptions(state, { filter: 'attention' }).length, 3);
  assert.equal(getVisibleSubscriptions(state, { query: '不存在' }).length, 0);
  assert.equal(getVisibleSubscriptions(state, { sort: 'amount' })[0].id, 'claude');
  assert.equal(getVisibleSubscriptions(state, { sort: 'date' })[0].id, 'github');
  assert.deepEqual(state.subscriptions.map((sub) => sub.id), original);
});

test('preferences accept supported values; feedback requires meaningful rated text', () => {
  const state = createInitialState();
  const changed = updatePreferences(state, { days: '14', email: false, weekly: false });
  assert.deepEqual(changed.preferences, { days: 14, email: false, weekly: false, quiet: true });
  assert.equal(state.preferences.email, true);
  assert.deepEqual(updatePreferences(state, { days: 2, quiet: 'false' }).preferences, state.preferences);
  assert.equal(addFeedback(state, { message: '  ', rating: 4 }), state);
  assert.equal(addFeedback(state, { message: '有幫助', rating: 0 }), state);
  const submitted = addFeedback(state, { message: '  優惠提醒很清楚  ', rating: 5 });
  assert.equal(submitted.feedback.length, 1);
  assert.equal(submitted.feedback[0].message, '優惠提醒很清楚');
  assert.equal(state.feedback.length, 0);
});

test('local storage round trip preserves user decisions, preferences, and feedback', () => {
  const storage = store();
  let state = updateSubscription(createInitialState(), 'canva', 'cancel-intent');
  state = updatePreferences(state, { days: 3 });
  state = addFeedback(state, { rating: 4, message: '想看到年費提醒' });
  assert.equal(saveState(storage, state), true);
  assert.deepEqual(loadState(storage), state);
});

test('malformed, outdated, inconsistent, or inaccessible local storage resets safely', () => {
  for (const malformed of ['{', 'null', '[]', '{}', '{"version":2}']) {
    assert.deepEqual(loadState(store(malformed)), createInitialState());
  }
  const invalidValues = [
    (state) => { state.subscriptions[0].amount = '96'; },
    (state) => { state.subscriptions[0].nextDate = '2026-02-30'; },
    (state) => { state.subscriptions[0].status = 'cancelled'; },
    (state) => { state.subscriptions[0].brand = 'url(javascript:alert(1))'; },
    (state) => { state.subscriptions[1].promo.remainingCycles = -1; },
    (state) => { state.subscriptions[1].id = state.subscriptions[0].id; },
    (state) => { state.preferences.email = 'true'; },
    (state) => { state.feedback = [{ message: 'Incomplete' }]; },
  ];
  for (const mutate of invalidValues) {
    const bad = createInitialState(); mutate(bad);
    assert.deepEqual(loadState(store(JSON.stringify(bad))), createInitialState());
    assert.equal(saveState(store(), bad), false);
  }
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(loadState(blocked), createInitialState());
  assert.equal(saveState(blocked, createInitialState()), false);
  assert.equal(saveState(undefined, createInitialState()), false);
});

test('fixtures are fresh and display helpers are deterministic across time zones', () => {
  const a = createInitialState();
  a.subscriptions[1].promo.regularPrice = 999;
  assert.equal(createInitialState().subscriptions[1].promo.regularPrice, 15);
  assert.equal(daysUntil('2026-10-25'), 2);
  assert.equal(daysUntil('2026-10-28'), 5);
  assert.equal(daysUntil('invalid'), null);
  assert.equal(dateLabel('2026-10-28'), 'Oct 28');
  assert.equal(dateLabel('2026-02-30'), 'Date unconfirmed');
  assert.equal(money(73.5, 2), '$73.50');
});

function legacyCopy(state) {
  const categories = { 'AI tools': 'AI 工具', Development: '開發工具', Design: '設計創作', Productivity: '工作效率' };
  return {
    ...state,
    subscriptions: state.subscriptions.map((sub) => ({
      ...sub, category: categories[sub.category],
      plan: `${sub.name} · 舊版示範方案`, description: '舊版示範說明。',
      source: sub.source.replace('Sample email | ', '示範郵件｜'),
      promo: sub.promo ? { ...sub.promo, cancelPolicy: '示範條款：關閉續約後保留使用權。', terms: '虛構優惠情境，非服務商現行條款。' } : null,
    })),
    activity: state.activity.map((entry) => ({
      ...entry, message: entry.type.startsWith('simulate') || entry.type === 'resolve-payment'
        ? '模擬完成：舊版操作紀錄。' : '已記錄舊版決定。',
    })),
  };
}

test('legacy v1 labels and generated activity migrate without losing decisions, preferences, or feedback', () => {
  let expected = createInitialState();
  expected.subscriptions[3].amount = 21;
  expected = updateSubscription(expected, 'notion', 'keep');
  expected = updateSubscription(expected, 'canva', 'cancel-intent');
  expected = updateSubscription(expected, 'canva', 'simulate-cancel');
  expected = updateSubscription(expected, 'github', 'resolve-payment');
  expected = updatePreferences(expected, { days: 14, email: false, weekly: false });
  expected = addFeedback(expected, { rating: 5, message: '請保留我的中文回饋，不要翻譯。' });
  const storage = store(JSON.stringify(legacyCopy(expected)));
  const migrated = loadState(storage);
  assert.deepEqual(migrated, expected);
  assert.deepEqual(JSON.parse(storage.value), expected, 'successful migration is saved under the existing key');
  assert.deepEqual(loadState(storage), expected, 'migration is idempotent');
  assert.equal(migrated.feedback[0].message, '請保留我的中文回饋，不要翻譯。');
  assert.equal(migrated.subscriptions[3].amount, 21);
  assert.doesNotMatch(JSON.stringify(migrated.subscriptions), /[\u3400-\u9fff]/);
  assert.doesNotMatch(JSON.stringify(migrated.activity), /[\u3400-\u9fff]/);
});

test('legacy migration rejects corrupt data before translating fixture labels', () => {
  for (const change of [
    (state) => { state.subscriptions[0].amount = '96'; },
    (state) => { state.subscriptions[0].category = 'Unknown category'; },
    (state) => { state.subscriptions[1].promo.regularPrice = -5; },
    (state) => { state.subscriptions[0].source = { unsafe: true }; },
  ]) {
    const legacy = legacyCopy(createInitialState());
    change(legacy);
    assert.deepEqual(loadState(store(JSON.stringify(legacy))), createInitialState());
  }
});

test('migration survives blocked writes and does not translate user-authored feedback', () => {
  const expected = addFeedback(updatePreferences(createInitialState(), { days: 3 }), { rating: 4, message: '中文 and English feedback' });
  const storage = {
    getItem() { return JSON.stringify(legacyCopy(expected)); },
    setItem() { throw new Error('read-only storage'); },
  };
  assert.deepEqual(loadState(storage), expected);
});

test('English fixtures and new activity use English while user text remains untouched', () => {
  const initial = createInitialState();
  assert.deepEqual(CATEGORIES, ['AI tools', 'Development', 'Design', 'Productivity']);
  assert.doesNotMatch(JSON.stringify(initial), /[\u3400-\u9fff]/);
  const updated = updateSubscription(initial, 'notion', 'keep');
  assert.doesNotMatch(JSON.stringify(updated.activity), /[\u3400-\u9fff]/);
});
