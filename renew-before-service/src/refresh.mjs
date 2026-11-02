import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, buildAudit, loadPrivateMessages } from './audit.mjs';
import { billingQuery } from './gmail.mjs';
import { acquireFileLock } from './file-lock.mjs';

const readJson = path => readFile(path, 'utf8').then(JSON.parse);
const optionalJson = path => readJson(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function planRefresh(directory, { now = new Date().toISOString() } = {}) {
  const state = await optionalJson(join(directory, 'scan-state.json'));
  const messages = await loadPrivateMessages(directory);
  const accounts = [...new Set(messages.map(m => m.mailboxEmail).filter(Boolean))];
  const expectedMailboxEmail = state?.mailboxEmail || (accounts.length === 1 ? accounts[0] : null);
  if (!expectedMailboxEmail || accounts.some(email => email.toLowerCase() !== expectedMailboxEmail.toLowerCase())) throw new Error('The private directory must identify exactly one mailbox');
  const start = state?.lastCompletedAt ? new Date(Date.parse(state.lastCompletedAt) - 2 * 86400000) : new Date(Date.parse(now));
  if (!state?.lastCompletedAt) start.setUTCFullYear(start.getUTCFullYear() - 2);
  return { expectedMailboxEmail, baselineCompletedAt: state?.lastCompletedAt || null, startedAt: now,
    query: billingQuery(start.toISOString().slice(0, 10)), knownMessageIds: messages.map(m => m.id),
    instructions: 'Verify the connected Gmail profile first. Follow every query page. Read and import newly found billing messages. Finish only after all chosen query pages and message reads succeeded.' };
}

function serviceDecisionFacts(s) {
  return { serviceKey: s.serviceKey, status: s.status, renewal: s.renewal, access: s.access,
    accessEnds: s.accessEnds, nextBilling: s.nextBilling, nextCharge: s.nextCharge,
    cancelBy: s.cancelBy || null, refundStatus: s.refundStatus || null,
    lastPayment: s.lastPayment ? { minor: s.lastPayment.minor, currency: s.lastPayment.currency, day: s.lastPayment.day } : null,
    relatedEvidenceIds: s.relatedEvidenceIds || [] };
}

export function compareSnapshots(previous, next) {
  const before = new Map((previous?.subscriptions || []).map(s => [s.serviceKey, hash(serviceDecisionFacts(s))]));
  const changedServiceKeys = next.subscriptions.filter(s => before.get(s.serviceKey) !== hash(serviceDecisionFacts(s))).map(s => s.serviceKey);
  const financial = s => (s?.payments || []).map(e => ({ serviceKey: e.serviceKey, reference: e.reference || e.messageId, payment: e.payment, paymentDay: e.paymentDay, conflict: e.conflict || false })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const paymentLedgerChanged = hash(financial(previous)) !== hash(financial(next));
  const known = new Set((previous?.unclassifiedPurchases || []).map(e => e.id));
  const newUnclassifiedEvidenceIds = next.unclassifiedPurchases.filter(e => !known.has(e.id)).map(e => e.id);
  return { changed: changedServiceKeys.length > 0 || paymentLedgerChanged || newUnclassifiedEvidenceIds.length > 0,
    changedServiceKeys, paymentLedgerChanged, newUnclassifiedEvidenceIds };
}

export async function finishRefresh(directory, result, { now = new Date().toISOString() } = {}) {
  const release = await acquireFileLock(directory);
  try {
    const state = await optionalJson(join(directory, 'scan-state.json'));
    if ((state?.lastCompletedAt || null) !== result.baselineCompletedAt) throw new Error('A newer scan already completed; re-plan before advancing the checkpoint');
    if (!Array.isArray(result.queries) || !result.queries.length || result.queries.some(q => q.complete !== true || q.nextPageToken)) throw new Error('Incomplete query coverage cannot advance the scan checkpoint');
    if (result.allMessageReadsSucceeded !== true || result.profileVerified !== true) throw new Error('Successful source reads and a verified profile are required');
    if (!Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.completedAt)) || Date.parse(result.startedAt) > Date.parse(result.completedAt) || Date.parse(result.completedAt) > Date.parse(now) + 60000 || (state?.lastCompletedAt && Date.parse(result.completedAt) < Date.parse(state.lastCompletedAt))) throw new Error('Invalid scan time');
    const plan = await planRefresh(directory, { now: result.startedAt });
    if (plan.expectedMailboxEmail.toLowerCase() !== String(result.mailboxEmail).toLowerCase()) throw new Error('The connected mailbox does not match this private directory');
    const previous = await optionalJson(join(directory, 'snapshot.json'));
    const scanState = { ...state, mailboxEmail: plan.expectedMailboxEmail, lastStartedAt: result.startedAt,
      lastCompletedAt: result.completedAt, lastSuccess: 'verified_connector_refresh',
      backgroundUpdatesConfigured: result.backgroundUpdatesConfigured === true,
      queryCoverage: result.queries.map(q => ({ query: q.query, complete: true })) };
    const { snapshot } = await buildAudit(directory, { asOf: result.completedAt, scanState });
    // Advance only after derived data is durable; failed scans keep their old cursor.
    await atomicWrite(join(directory, 'scan-state.json'), JSON.stringify(scanState, null, 2));
    return { ...compareSnapshots(previous, snapshot), services: snapshot.subscriptions.length, checkedAt: scanState.lastCompletedAt };
  } finally { await release(); }
}
