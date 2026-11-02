import { CATEGORIES, DEMO_TODAY, createInitialState } from './data.js';

export const STORAGE_KEY = 'renew-before-demo-v1';
const DAY = 86400000;
const today = Date.parse(`${DEMO_TODAY}T00:00:00Z`);
const horizon = Date.parse('2027-10-23T00:00:00Z');
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, limit = 5000) => typeof value === 'string' && value.length <= limit;
const isAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000;
const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const LEGACY_CATEGORIES = Object.freeze({
  'AI 工具': 'AI tools', '開發工具': 'Development', '設計創作': 'Design', '工作效率': 'Productivity',
});

export function money(value, decimals = 0) {
  const number = Number.isFinite(value) ? value : 0;
  const places = Math.max(0, Math.min(2, Number.isInteger(decimals) ? decimals : 0));
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: places, maximumFractionDigits: places,
  }).format(number);
}

export function dateLabel(iso) {
  if (!isDate(iso)) return 'Date unconfirmed';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));
}

export function daysUntil(iso) {
  return isDate(iso) ? Math.round((Date.parse(`${iso}T00:00:00Z`) - today) / DAY) : null;
}

/** Current price equivalent, not actual cash paid or a future price promise. */
export function monthlyCost(sub) {
  if (!isAmount(sub?.amount)) return 0;
  return sub.cadence === 'annual' ? sub.amount / 12 : sub.amount;
}

// Anchoring each recurrence to the original day avoids 31 Jan -> 28 Feb -> 28 Mar drift.
function billingDate(iso, cadence, index) {
  const [year, month, day] = iso.split('-').map(Number);
  const offset = cadence === 'annual' ? index * 12 : index;
  const first = new Date(Date.UTC(year, month - 1 + offset, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay));
}

/** Charges in [demo date, demo date + 12 months), based on known renewal settings. */
export function forecastAnnual(sub) {
  if (!sub || sub.status !== 'active' || !sub.autoRenew || !isDate(sub.nextDate) || !isAmount(sub.amount)) return 0;
  let total = 0;
  let futureCycle = 0;
  for (let index = 0; index < 1200; index += 1) {
    const chargeDate = billingDate(sub.nextDate, sub.cadence, index);
    if (chargeDate >= horizon) break;
    if (chargeDate < today) continue;
    const promo = sub.promo;
    const discountApplies = promo && chargeDate < Date.parse(`${promo.end}T00:00:00Z`)
      && futureCycle < promo.remainingCycles;
    total += promo && !discountApplies ? promo.regularPrice : sub.amount;
    futureCycle += 1;
  }
  return round(total);
}

export function getAttention(state) {
  const priority = { payment: 0, promo: 1, renewal: 2 };
  return state.subscriptions
    .filter((sub) => sub.status === 'active' && sub.risk !== null)
    .sort((a, b) => priority[a.risk] - priority[b.risk] || a.nextDate.localeCompare(b.nextDate));
}

export function getMetrics(state) {
  const active = state.subscriptions.filter((sub) => sub.status === 'active');
  const monthly = active.reduce((sum, sub) => sum + monthlyCost(sub), 0);
  return {
    monthly: round(monthly),
    annual: round(active.reduce((sum, sub) => sum + forecastAnnual(sub), 0)),
    count: active.length,
    attentionCount: getAttention(state).length,
    categories: CATEGORIES.map((name) => {
      const amount = active.filter((sub) => sub.category === name).reduce((sum, sub) => sum + monthlyCost(sub), 0);
      return { name, amount: round(amount), percent: monthly > 0 ? amount / monthly * 100 : 0 };
    }),
  };
}

export function getVisibleSubscriptions(state, { filter = 'all', query = '', sort = 'date' } = {}) {
  const normalizedQuery = String(query).trim().toLocaleLowerCase();
  const subscriptions = state.subscriptions.filter((sub) => {
    const matchesFilter = filter === 'all'
      || (filter === 'attention' && sub.status === 'active' && sub.risk !== null)
      || (filter === 'cancelled' && sub.status === 'cancelled')
      || sub.category === filter;
    const searchable = `${sub.name} ${sub.plan} ${sub.category}`.toLocaleLowerCase();
    return matchesFilter && (!normalizedQuery || searchable.includes(normalizedQuery));
  });
  return subscriptions.sort((a, b) => {
    if (sort === 'amount') return monthlyCost(b) - monthlyCost(a) || a.name.localeCompare(b.name);
    if (sort === 'name') return a.name.localeCompare(b.name, 'en');
    return a.nextDate.localeCompare(b.nextDate) || a.name.localeCompare(b.name);
  });
}

function activity(state, type, subscriptionId, message) {
  return [...state.activity, {
    id: `activity-${state.activity.length + 1}`, at: DEMO_TODAY, type, subscriptionId, message,
  }].slice(-100);
}

function activityMessage(action, sub) {
  if (action === 'keep') return `Recorded your decision to keep ${sub.name}. No account changes were made.`;
  if (action === 'cancel-intent') return `Recorded your intention not to renew ${sub.name}. Cancellation is not yet confirmed.`;
  if (action === 'simulate-cancel') return `Simulation complete: auto-renewal for ${sub.name} is off, with access retained until ${dateLabel(sub.nextDate)}. Your real account is unchanged.`;
  if (action === 'resolve-payment') return `Simulation complete: the payment risk for ${sub.name} is resolved. No bank was connected and no real payment method was changed.`;
  return null;
}

export function updateSubscription(state, id, action) {
  const sub = state.subscriptions.find((item) => item.id === id);
  if (!sub || sub.status !== 'active') return state;
  let patch;
  if (action === 'keep' && sub.risk === 'renewal') {
    patch = { decision: 'keep', risk: null };
  } else if (action === 'cancel-intent' && sub.decision !== 'cancel-intent') {
    patch = { decision: 'cancel-intent' };
  } else if (action === 'simulate-cancel' && sub.decision === 'cancel-intent') {
    patch = { decision: 'cancelled', autoRenew: false, status: 'cancelled', risk: null };
  } else if (action === 'resolve-payment' && sub.risk === 'payment') {
    patch = { risk: null };
  } else {
    return state;
  }
  return {
    ...state,
    subscriptions: state.subscriptions.map((item) => item.id === id ? { ...item, ...patch } : item),
    activity: activity(state, action, id, activityMessage(action, sub)),
  };
}

export function updatePreferences(state, changes) {
  if (!isObject(changes)) return state;
  const preferences = { ...state.preferences };
  const parsedDays = Number(changes.days);
  if ([1, 3, 7, 14].includes(parsedDays)) preferences.days = parsedDays;
  for (const key of ['email', 'weekly', 'quiet']) {
    if (typeof changes[key] === 'boolean') preferences[key] = changes[key];
  }
  return { ...state, preferences };
}

export function addFeedback(state, item) {
  if (!isObject(item) || !Number.isInteger(item.rating) || item.rating < 1 || item.rating > 5
    || !isText(item.message, 2000) || !item.message.trim()) return state;
  const entry = {
    id: `feedback-${state.feedback.length + 1}`, at: DEMO_TODAY,
    rating: item.rating, message: item.message.trim(),
  };
  return { ...state, feedback: [...state.feedback, entry].slice(-100) };
}

function validSubscription(sub, allowLegacyCategories = false) {
  return isObject(sub) && isText(sub.id, 80) && sub.id.length > 0
    && isText(sub.name, 100) && sub.name.length > 0 && isText(sub.plan, 200)
    && (CATEGORIES.includes(sub.category) || (allowLegacyCategories && Object.hasOwn(LEGACY_CATEGORIES, sub.category)))
    && isText(sub.logo, 10)
    && typeof sub.brand === 'string' && /^#[0-9a-f]{6}$/i.test(sub.brand)
    && isAmount(sub.amount) && ['monthly', 'annual'].includes(sub.cadence) && isDate(sub.nextDate)
    && ['active', 'cancelled'].includes(sub.status) && typeof sub.autoRenew === 'boolean'
    && (sub.status !== 'cancelled' || sub.autoRenew === false)
    && typeof sub.essential === 'boolean' && [null, 'renewal', 'promo', 'payment'].includes(sub.risk)
    && isText(sub.description) && isText(sub.source) && isDate(sub.evidenceDate)
    && (sub.decision === undefined || ['keep', 'cancel-intent', 'cancelled'].includes(sub.decision))
    && (sub.promo === null || (isObject(sub.promo) && isDate(sub.promo.end)
      && isAmount(sub.promo.regularPrice) && Number.isInteger(sub.promo.remainingCycles)
      && sub.promo.remainingCycles >= 0 && sub.promo.remainingCycles <= 1200
      && isText(sub.promo.cancelPolicy) && isText(sub.promo.terms)));
}

function validState(state, allowLegacyCategories = false) {
  return isObject(state) && state.version === 1 && Array.isArray(state.subscriptions)
    && state.subscriptions.length <= 100 && state.subscriptions.every((sub) => validSubscription(sub, allowLegacyCategories))
    && new Set(state.subscriptions.map((sub) => sub.id)).size === state.subscriptions.length
    && isObject(state.preferences) && [1, 3, 7, 14].includes(state.preferences.days)
    && ['email', 'weekly', 'quiet'].every((key) => typeof state.preferences[key] === 'boolean')
    && Array.isArray(state.activity) && state.activity.length <= 100
    && state.activity.every((item) => isObject(item) && isText(item.id, 100) && isDate(item.at)
      && isText(item.type, 100) && isText(item.subscriptionId, 80) && isText(item.message))
    && Array.isArray(state.feedback) && state.feedback.length <= 100
    && state.feedback.every((item) => isObject(item) && isText(item.id, 100) && isDate(item.at)
      && Number.isInteger(item.rating) && item.rating >= 1 && item.rating <= 5
      && isText(item.message, 2000) && item.message.trim().length > 0);
}

/** Translate fixture-owned v1 text only. Preserve billing data, decisions, and user feedback. */
function migrateLegacyText(state) {
  const fixtures = new Map(createInitialState().subscriptions.map((sub) => [sub.id, sub]));
  const hasLegacyText = (text) => /[\u3400-\u9fff]/.test(text);
  let changed = false;
  const subscriptions = state.subscriptions.map((sub) => {
    const mappedCategory = LEGACY_CATEGORIES[sub.category];
    const fixture = fixtures.get(sub.id);
    const legacyFixture = fixture && [sub.plan, sub.description, sub.source, sub.promo?.cancelPolicy, sub.promo?.terms]
      .some((text) => typeof text === 'string' && hasLegacyText(text));
    if (!mappedCategory && !legacyFixture) return sub;
    changed = true;
    return {
      ...sub,
      category: mappedCategory || sub.category,
      ...(legacyFixture ? { plan: fixture.plan, description: fixture.description, source: fixture.source } : {}),
      promo: legacyFixture && sub.promo && fixture.promo
        ? { ...sub.promo, cancelPolicy: fixture.promo.cancelPolicy, terms: fixture.promo.terms }
        : sub.promo,
    };
  });
  const byId = new Map(subscriptions.map((sub) => [sub.id, sub]));
  const translatedActivity = state.activity.map((entry) => {
    if (!/^(已記錄|模擬完成：)/.test(entry.message)) return entry;
    const sub = byId.get(entry.subscriptionId);
    const message = sub ? activityMessage(entry.type, sub) : null;
    if (!message) return entry;
    changed = true;
    return { ...entry, message };
  });
  return changed ? { ...state, subscriptions, activity: translatedActivity } : state;
}

export function loadState(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw);
    // Validate the old schema before replacing text; migration must not repair corrupt financial data.
    if (!validState(parsed, true)) return createInitialState();
    const migrated = migrateLegacyText(parsed);
    if (!validState(migrated)) return createInitialState();
    if (migrated !== parsed) saveState(storage, migrated);
    return migrated;
  } catch {
    return createInitialState();
  }
}

/** False indicates storage denial/quota failure; UI should not claim persistence. */
export function saveState(storage, state) {
  if (!validState(state)) return false;
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
