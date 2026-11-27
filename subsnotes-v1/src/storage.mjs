/**
 * localStorage persistence for user subscriptions + decision log.
 * Keys are namespaced; never leave the device.
 */

const KEY = 'subsnotes.v3.user';
const KEY_LOG = 'subsnotes.v3.log';
const KEY_DONE = 'subsnotes.v3.done';

function canStore() {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function loadUserData() {
  if (!canStore()) return { subscriptions: [], mode: 'sample' };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { subscriptions: [], mode: 'sample' };
    const data = JSON.parse(raw);
    const subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : [];
    return {
      subscriptions,
      mode: subscriptions.length ? 'user' : 'sample',
      updatedAt: data.updatedAt || null
    };
  } catch {
    return { subscriptions: [], mode: 'sample' };
  }
}

export function saveUserSubscriptions(subscriptions) {
  if (!canStore()) return false;
  const payload = {
    version: 3,
    updatedAt: new Date().toISOString(),
    subscriptions
  };
  localStorage.setItem(KEY, JSON.stringify(payload));
  return true;
}

export function clearUserData() {
  if (!canStore()) return;
  localStorage.removeItem(KEY);
  localStorage.removeItem(KEY_LOG);
  localStorage.removeItem(KEY_DONE);
}

export function exportUserJson() {
  const { subscriptions, updatedAt } = loadUserData();
  const log = loadDecisionLog();
  return JSON.stringify({
    version: 3,
    exportedAt: new Date().toISOString(),
    updatedAt,
    subscriptions,
    decisionLog: log
  }, null, 2);
}

export function loadDecisionLog() {
  if (!canStore()) return [];
  try {
    return JSON.parse(localStorage.getItem(KEY_LOG) || '[]');
  } catch {
    return [];
  }
}

export function appendDecisionLog(entry) {
  if (!canStore()) return;
  const log = loadDecisionLog();
  log.unshift({
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...entry
  });
  localStorage.setItem(KEY_LOG, JSON.stringify(log.slice(0, 200)));
}

export function loadDoneIds() {
  if (!canStore()) return new Set();
  try {
    const arr = JSON.parse(localStorage.getItem(KEY_DONE) || '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export function markDoneId(id) {
  if (!canStore()) return;
  const set = loadDoneIds();
  set.add(id);
  localStorage.setItem(KEY_DONE, JSON.stringify([...set]));
}
