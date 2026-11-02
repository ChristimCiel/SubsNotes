import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fx } from '../src/fx.mjs';

const now = new Date('2026-11-02T08:00:00Z');
const fixture = (overrides = {}) => ({ version: 1, provider: 'frankfurter', referenceCurrency: 'USD', fetchedAt: now.toISOString(), rates: {
  USD: { value: '1', date: '2026-11-02' }, TWD: { value: '32', date: '2026-11-02' },
  EUR: { value: '0.8', date: '2026-11-02' }, JPY: { value: '160', date: '2026-11-02' },
  KWD: { value: '0.32', date: '2026-11-02' }, ...overrides
} });

test('USD, EUR, TWD and JPY totals convert through one USD reference without changing originals', () => {
  const originals = { USD: 2000, EUR: 800, TWD: 32000, JPY: 1600 };
  const converted = fx.convertTotals(originals, 'TWD', fixture(), { now });
  assert.equal(converted.minor, 160000); // USD 50 -> TWD 1600.
  assert.equal(converted.complete, true);
  assert.deepEqual(originals, { USD: 2000, EUR: 800, TWD: 32000, JPY: 1600 });
});

test('cross rates and ISO zero/three-decimal units remain exact', () => {
  assert.equal(fx.convertTotals({ JPY: 160 }, 'USD', fixture(), { now }).minor, 100);
  assert.equal(fx.convertTotals({ USD: 100 }, 'JPY', fixture(), { now }).minor, 160);
  assert.equal(fx.convertTotals({ USD: 100 }, 'KWD', fixture(), { now }).minor, 320);
  assert.equal(fx.convertTotals({ EUR: 800 }, 'USD', fixture(), { now }).minor, 1000);
});

test('the final total rounds once, avoiding accumulated per-currency rounding loss', () => {
  const rates = fixture({ EUR: { value: '2', date: '2026-11-02' }, TWD: { value: '2', date: '2026-11-02' } });
  assert.equal(fx.convertTotals({ EUR: 1, TWD: 1 }, 'USD', rates, { now }).minor, 1);
  assert.equal(fx.convertTotals({ EUR: 1 }, 'USD', rates, { now }).minor, 1);
});

test('unknown currencies and unavailable pairs produce a clearly incomplete subtotal', () => {
  const result = fx.convertTotals({ USD: 2000, CHF: 1000 }, 'USD', fixture(), { unconfirmedPayments: 2, now });
  assert.equal(result.minor, 2000); assert.equal(result.complete, false);
  assert.deepEqual(result.missingCurrencies, ['CHF']); assert.equal(result.unconfirmedPayments, 2);
  assert.equal(fx.convertTotals({ CHF: 1000 }, 'TWD', null, { now }).minor, null);
});

test('same-currency amounts need no network rates, and an empty ledger does not claim zero spending', () => {
  assert.equal(fx.convertTotals({ TWD: 628950 }, 'TWD', null, { now }).minor, 628950);
  assert.equal(fx.convertTotals({}, 'USD', null, { now }).minor, null);
});

test('a missing display-currency rate names that target rather than the known source', () => {
  const result = fx.convertTotals({ USD: 2000, EUR: 800 }, 'CHF', fixture(), { now });
  assert.deepEqual(result.missingCurrencies, ['CHF']); assert.equal(result.minor, null);
});

test('invalid rates, future observations, wrong references and unsafe totals are rejected', () => {
  for (const value of ['0', '-1', 'NaN', Infinity, '1e99']) assert.throws(() => fx.validateSnapshot(fixture({ TWD: { value, date: '2026-11-02' } }), now));
  assert.throws(() => fx.validateSnapshot(fixture({ TWD: { value: '32', date: '2026-11-03' } }), now));
  assert.throws(() => fx.validateSnapshot(fixture({ USD: { value: '2', date: '2026-11-02' } }), now));
  assert.throws(() => fx.convertTotals({ USD: Number.MAX_SAFE_INTEGER + 1 }, 'TWD', fixture(), { now }));
  assert.throws(() => fx.convertTotals({ USD: Number.MAX_SAFE_INTEGER }, 'TWD', fixture(), { now }));
});

test('reference dates reflect the actual pair, and stale rates are explicitly detectable', () => {
  const old = fixture({ TWD: { value: '32', date: '2026-10-20' } });
  const converted = fx.convertTotals({ TWD: 3200 }, 'USD', old, { now });
  assert.deepEqual(converted.rateDates, ['2026-10-20']); assert.equal(converted.stale, true);
});

test('primary and fallback payloads normalize independently without mixing providers or assuming dollars', () => {
  const primary = fx.normalizeRates([{ base: 'USD', quote: 'TWD', rate: 32, date: '2026-11-02' }], 'frankfurter', now);
  assert.equal(primary.rates.TWD.value, '32'); assert.equal(primary.rates.USD.value, '1');
  const fallback = fx.normalizeRates({ date: '2026-11-01', usd: { usd: 1, twd: 32, btc: 0.00001 } }, 'currency-api', now);
  assert.equal(fallback.provider, 'currency-api'); assert.equal(fallback.rates.BTC, undefined);
  assert.throws(() => fx.normalizeRates([{ base: 'EUR', quote: 'TWD', rate: 32, date: '2026-11-02' }], 'frankfurter', now));
});

test('daily cache avoids requests; forced updates fetch anonymous fixed currency data only', async () => {
  const data = new Map([[fx.cacheKey, JSON.stringify(fixture())]]), requests = [];
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const client = fx.createRatesClient({ storage, clock: () => now, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json([{ base: 'USD', quote: 'TWD', rate: 33, date: '2026-11-02' }]);
  } });
  assert.equal((await client.load()).cached, true); assert.equal(requests.length, 0);
  const refreshed = await client.load({ force: true });
  assert.equal(refreshed.snapshot.rates.TWD.value, '33'); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.frankfurter.dev/v2/rates?base=USD');
  assert.equal(requests[0].options.credentials, 'omit'); assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
});

test('failed primary source falls back, while offline failure preserves and labels the last good cache', async () => {
  const old = { ...fixture(), fetchedAt: '2026-10-31T00:00:00Z' };
  const storage = { getItem: () => JSON.stringify(old), setItem() {} };
  const requested = [];
  const client = fx.createRatesClient({ storage, clock: () => now, fetchImpl: async url => {
    requested.push(url); if (url.includes('frankfurter')) throw new Error('Offline');
    return Response.json({ date: '2026-11-01', usd: { usd: 1, twd: 32 } });
  } });
  const fallback = await client.load();
  assert.equal(fallback.snapshot.provider, 'currency-api'); assert.equal(requested.length, 2);
  const offline = fx.createRatesClient({ storage, clock: () => now, fetchImpl: async () => { throw new Error('Offline'); } });
  const saved = await offline.load();
  assert.equal(saved.offline, true); assert.deepEqual(saved.snapshot, old);
});

test('bad or unavailable storage cannot break fetching; simultaneous requests share one refresh', async () => {
  let calls = 0;
  const client = fx.createRatesClient({ clock: () => now, storage: { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } }, fetchImpl: async () => {
    calls++; return Response.json([{ base: 'USD', quote: 'TWD', rate: 32, date: '2026-11-02' }]);
  } });
  const [a, b] = await Promise.all([client.load(), client.load()]);
  assert.equal(calls, 1); assert.equal(a.snapshot, b.snapshot);
});

test('a fresh install stays usable when all free sources are unavailable', async () => {
  const client = fx.createRatesClient({ clock: () => now, fetchImpl: async () => { throw new Error('Unavailable'); } });
  const result = await client.load(); assert.equal(result.offline, true); assert.equal(result.snapshot, null);
  assert.equal(fx.convertTotals({ TWD: 100 }, 'TWD', result.snapshot, { now }).minor, 100);
});

test('a stalled source times out and lets a fallback complete', async () => {
  const client = fx.createRatesClient({ clock: () => now, timeoutMs: 10, fetchImpl: async (url, options) => {
    if (url.includes('frankfurter')) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
    return Response.json({ date: '2026-11-01', usd: { usd: 1, twd: 32 } });
  } });
  assert.equal((await client.load()).snapshot.provider, 'currency-api');
});
