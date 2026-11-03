import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCashflow } from '../src/cashflow.mjs';
import { extractEvidence, projectEvidence } from '../src/evidence.mjs';

// All merchants, dates and amounts in these fixtures are synthetic.
const receipt = (id, text, receivedAt = '2026-08-02T01:00:00Z') => ({ id, sender: 'billing@suno.com',
  subject: 'Your subscription receipt', text, receivedAt, authenticatedSenderDomain: 'suno.com' });

test('the paid date wins over delivery month and an annual charge is never divided by twelve', () => {
  const events = extractEvidence(receipt('annual-synthetic', 'Paid Jul 31, 2026. Billed annually. Amount paid USD 144.00'));
  const snapshot = projectEvidence([...events, ...events]);
  assert.deepEqual(summarizeCashflow(snapshot, { month: '2026-07' }).paidMinorByCurrency, { USD: 14400 });
  assert.deepEqual(summarizeCashflow(snapshot, { month: '2026-08' }).paidMinorByCurrency, {});
  assert.equal(snapshot.payments.length, 1);
});

test('mail receipt date is not invented as a payment or refund date', () => {
  const [e] = extractEvidence(receipt('date-unknown', 'Suno Pro. Amount paid EUR 24.00'));
  assert.equal(e.paymentDay, null); assert.equal(e.paymentDateBasis, 'unknown');
  const result = summarizeCashflow(projectEvidence([e]));
  assert.deepEqual(result.paidMinorByCurrency, {}); assert.equal(result.unallocatedCount, 1);
  const [r] = extractEvidence({ ...receipt('refund-unknown', 'Total refunded USD 12.00'), subject: 'Refund processed' });
  assert.equal(r.refundDay, null);
});

test('currencies, refunds, pending refunds and unknown sources stay separate', () => {
  const payment = (id, currency, minor) => ({ id, serviceKey: 'fictional', kind: 'payment_succeeded',
    authenticated: true, paymentDay: '2026-07-31', paymentDateBasis: 'explicit', payment: { currency, minor } });
  const refund = { id: 'r', serviceKey: 'fictional', kind: 'refund_recorded', authenticated: true,
    refundDay: '2026-08-03', refundDateBasis: 'explicit', refund: { currency: 'USD', minor: 600 } };
  const result = summarizeCashflow({ payments: [payment('a', 'USD', 1200), payment('b', 'JPY', 800),
    payment('c', null, 10), { ...payment('d', 'USD', 200), authenticated: false },
    { ...payment('e', 'USD', 500), conflict: true }], refunds: [refund, { ...refund, id: 'pending', kind: 'refund_pending' }] });
  assert.deepEqual(result.paidMinorByCurrency, { USD: 1200, JPY: 800 });
  assert.deepEqual(result.providerRefundMinorByCurrency, { USD: 600 });
  assert.deepEqual(result.excluded.map(x => x.reason), ['currency_unknown', 'unverified_source', 'conflicting_amount', 'refund_not_recorded']);
  assert.equal(result.bankReconciled, false); assert.equal(result.exhaustive, false);
});

test('legacy date fallbacks and invalid or overflowing amounts cannot inflate a monthly total', () => {
  const e = { id: 'legacy', authenticated: true, payment: { currency: 'USD', minor: 40 }, paymentDay: '2026-07-01' };
  assert.equal(summarizeCashflow({ payments: [e] }).unallocatedCount, 1);
  assert.throws(() => summarizeCashflow({}, { month: '2026-13' }), /calendar month/);
  assert.throws(() => summarizeCashflow({ payments: [
    { ...e, id: 'a', paymentDateBasis: 'explicit', payment: { currency: 'USD', minor: Number.MAX_SAFE_INTEGER } },
    { ...e, id: 'b', paymentDateBasis: 'explicit' }
  ] }), /safe amount/);
});

test('uncertain receipts from another known month do not make the selected month incomplete',()=>{
  const event=(id,date,currency)=>({id,authenticated:true,paymentDay:date,paymentDateBasis:'explicit',payment:{currency,minor:1200}});
  const snapshot={payments:[event('synthetic-july','2026-07-31','USD'),event('synthetic-august','2026-08-02',null)]};
  const july=summarizeCashflow(snapshot,{month:'2026-07'});
  assert.deepEqual(july.paidMinorByCurrency,{USD:1200});assert.equal(july.excluded.length,0);
  assert.deepEqual(july.months,['2026-08','2026-07']);
  assert.equal(summarizeCashflow(snapshot,{month:'2026-08'}).excluded.length,1);
});
