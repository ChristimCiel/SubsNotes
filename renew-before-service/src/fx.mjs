// Self-contained so the same arithmetic and client can run in Node and a static browser report.
export function createFxRuntime() {
  const cacheKey = 'renew-before.fx.rates.v1';
  const dayMs = 86_400_000;
  const supported = new Set(Intl.supportedValuesOf('currency'));
  const sources = {
    frankfurter: { name: 'Frankfurter', url: 'https://frankfurter.dev/' },
    'currency-api': { name: 'Currency API', url: 'https://github.com/fawazahmed0/exchange-api' }
  };
  const endpoints = [
    { url: 'https://api.frankfurter.dev/v2/rates?base=USD', provider: 'frankfurter' },
    { url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json', provider: 'currency-api' },
    { url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.min.json', provider: 'currency-api' }
  ];
  const currencyDecimals = code => {
    if (!supported.has(code)) throw new Error('Unsupported display currency');
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
  };
  const power = n => 10n ** BigInt(n);
  function fraction(value) {
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Invalid reference rate');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid reference rate');
    const match = String(value).match(/^(\d{1,24})(?:\.(\d{1,24}))?(?:e([+-]?\d{1,2}))?$/i);
    if (!match) throw new Error('Invalid reference rate');
    const exponent = Number(match[3] || 0);
    if (Math.abs(exponent) > 24) throw new Error('Reference rate is out of range');
    const scale = (match[2] || '').length - exponent;
    const n = BigInt(match[1] + (match[2] || '')) * (scale < 0 ? power(-scale) : 1n);
    const d = scale > 0 ? power(scale) : 1n;
    if (n <= 0n || n > d * power(18)) throw new Error('Reference rate must be positive');
    return { n, d };
  }
  const validDay = (day, now) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
    && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day
    && day <= new Date(now).toISOString().slice(0, 10);
  function validateSnapshot(input, now = new Date()) {
    if (!input || input.version !== 1 || input.referenceCurrency !== 'USD' || !Object.hasOwn(sources, input.provider)
      || !Number.isFinite(Date.parse(input.fetchedAt)) || Date.parse(input.fetchedAt) > Number(new Date(now)) + 60_000
      || !input.rates || typeof input.rates !== 'object' || Array.isArray(input.rates)
      || Object.keys(input.rates).length > 400) throw new Error('Invalid exchange-rate snapshot');
    const rates = {};
    for (const [code, quote] of Object.entries(input.rates)) {
      if (!supported.has(code) || !quote || !validDay(quote.date, now)) throw new Error('Invalid currency or reference date');
      fraction(quote.value);
      rates[code] = { value: String(quote.value), date: quote.date };
    }
    const usd = rates.USD && fraction(rates.USD.value);
    if (!usd || usd.n !== usd.d || Object.keys(rates).length < 2) throw new Error('Invalid USD reference');
    return { version: 1, referenceCurrency: 'USD', provider: input.provider, fetchedAt: input.fetchedAt, rates };
  }
  function normalizeRates(data, provider, now = new Date()) {
    const rates = {};
    if (provider === 'frankfurter') {
      if (!Array.isArray(data) || !data.length || data.length > 400) throw new Error('Invalid rate response');
      for (const row of data) {
        if (String(row.base).toUpperCase() !== 'USD') throw new Error('Unexpected reference currency');
        const code = String(row.quote).toUpperCase();
        if (!supported.has(code)) continue;
        if (rates[code]) throw new Error('Duplicate exchange-rate quote');
        rates[code] = { value: String(row.rate), date: row.date };
      }
    } else if (provider === 'currency-api') {
      if (!data?.usd || typeof data.usd !== 'object' || Object.keys(data.usd).length > 500) throw new Error('Invalid rate response');
      for (const [key, value] of Object.entries(data.usd)) {
        const code = key.toUpperCase();
        if (supported.has(code)) rates[code] = { value: String(value), date: data.date };
      }
    } else throw new Error('Unknown exchange-rate provider');
    const dates = Object.values(rates).map(r => r.date).filter(d => validDay(d, now)).sort();
    if (!dates.length) throw new Error('No usable reference dates');
    if (rates.USD && fraction(rates.USD.value).n !== fraction(rates.USD.value).d) throw new Error('Invalid USD reference');
    rates.USD = { value: '1', date: dates.at(-1) };
    return validateSnapshot({ version: 1, referenceCurrency: 'USD', provider, fetchedAt: new Date(now).toISOString(), rates }, now);
  }
  const gcd = (a, b) => { while (b) { const rest = a % b; a = b; b = rest; } return a; };
  function roundMinor(n, d) {
    const rounded = (n * 2n + d) / (2n * d);
    if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Converted total exceeds the safe amount range');
    return Number(rounded);
  }
  function convertTotals(totals, currency, snapshot = null, { unconfirmedPayments = 0, now = new Date() } = {}) {
    const targetDecimals = currencyDecimals(currency);
    if (!totals || Array.isArray(totals) || typeof totals !== 'object' || Object.keys(totals).length > 400) throw new Error('Invalid original totals');
    if (!Number.isSafeInteger(unconfirmedPayments) || unconfirmedPayments < 0) throw new Error('Invalid excluded payment count');
    const valid = snapshot ? validateSnapshot(snapshot, now) : null;
    let n = 0n, d = 1n, included = 0;
    const missingCurrencies = new Set(), dates = new Set();
    for (const [code, minor] of Object.entries(totals)) {
      const sourceDecimals = currencyDecimals(code);
      if (!Number.isSafeInteger(minor) || minor < 0) throw new Error('Original amounts must be nonnegative safe minor units');
      if (code === currency || minor === 0) { n += BigInt(minor) * power(targetDecimals) * d / power(sourceDecimals); included++; continue; }
      const from = valid?.rates[code], to = valid?.rates[currency];
      if (!from || !to) {
        if (!from) missingCurrencies.add(code);
        if (!to) missingCurrencies.add(currency);
        continue;
      }
      const a = fraction(from.value), b = fraction(to.value);
      const rowN = BigInt(minor) * b.n * a.d * power(targetDecimals);
      const rowD = b.d * a.n * power(sourceDecimals);
      n = n * rowD + rowN * d; d *= rowD;
      const divisor = gcd(n, d); n /= divisor; d /= divisor;
      if (code !== 'USD') dates.add(from.date);
      if (currency !== 'USD') dates.add(to.date);
      included++;
    }
    const rateDates = [...dates].sort();
    return { currency, minor: included ? roundMinor(n, d) : null,
      complete: missingCurrencies.size === 0 && unconfirmedPayments === 0,
      missingCurrencies: [...missingCurrencies].sort(), unconfirmedPayments, rateDates,
      stale: rateDates.some(day => Number(new Date(now)) - Date.parse(day) > 7 * dayMs),
      provider: rateDates.length ? valid.provider : null,
      method: 'latest_daily_reference', originalMinorByCurrency: { ...totals } };
  }
  function createRatesClient({ storage = null, fetchImpl = globalThis.fetch, clock = () => new Date(), timeoutMs = 5000 } = {}) {
    let memory = null, inFlight = null;
    const readCache = () => {
      try { const raw = storage?.getItem(cacheKey); return raw ? validateSnapshot(JSON.parse(raw), clock()) : null; }
      catch { return null; }
    };
    async function request(endpoint) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint.url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' });
        if (!response.ok) throw new Error('Rate source is unavailable');
        const text = await response.text();
        if (text.length > 262_144) throw new Error('Rate response is too large');
        return normalizeRates(JSON.parse(text), endpoint.provider, clock());
      } finally { clearTimeout(timeout); }
    }
    function load({ force = false } = {}) {
      if (inFlight) return inFlight;
      const cached = memory || readCache();
      const age = cached ? Number(new Date(clock())) - Date.parse(cached.fetchedAt) : Infinity;
      if (!force && cached && age >= 0 && age < dayMs) return Promise.resolve({ snapshot: cached, cached: true, offline: false });
      inFlight = (async () => {
        for (const endpoint of endpoints) {
          try {
            memory = await request(endpoint);
            try { storage?.setItem(cacheKey, JSON.stringify(memory)); } catch { /* Calculations still work without persistent cache. */ }
            return { snapshot: memory, cached: false, offline: false };
          } catch { /* Try another free source without disclosing provider response bodies. */ }
        }
        return { snapshot: cached, cached: !!cached, offline: true };
      })().finally(() => { inFlight = null; });
      return inFlight;
    }
    return { load };
  }
  return { currencyDecimals, convertTotals, validateSnapshot, normalizeRates, createRatesClient, cacheKey, sources,
    currencies: [...supported], connectOrigins: [...new Set(endpoints.map(e => new URL(e.url).origin))] };
}

export const fx = createFxRuntime();
export const FX_CONNECT_ORIGINS = fx.connectOrigins;
