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
  const e = { id: 'legacy', kind:'payment_succeeded', authenticated: true, payment: { currency: 'USD', minor: 40 }, paymentDay: '2026-07-01' };
  assert.equal(summarizeCashflow({ payments: [e] }).unallocatedCount, 1);
  assert.throws(() => summarizeCashflow({}, { month: '2026-13' }), /calendar month/);
  assert.throws(() => summarizeCashflow({ payments: [
    { ...e, id: 'a', paymentDateBasis: 'explicit', payment: { currency: 'USD', minor: Number.MAX_SAFE_INTEGER } },
    { ...e, id: 'b', paymentDateBasis: 'explicit' }
  ] }), /safe amount/);
});

test('uncertain receipts from another known month do not make the selected month incomplete',()=>{
  const event=(id,date,currency)=>({id,kind:'payment_succeeded',authenticated:true,paymentDay:date,paymentDateBasis:'explicit',payment:{currency,minor:1200}});
  const snapshot={payments:[event('synthetic-july','2026-07-31','USD'),event('synthetic-august','2026-08-02',null)]};
  const july=summarizeCashflow(snapshot,{month:'2026-07'});
  assert.deepEqual(july.paidMinorByCurrency,{USD:1200});assert.equal(july.excluded.length,0);
  assert.deepEqual(july.months,['2026-08','2026-07']);
  assert.equal(summarizeCashflow(snapshot,{month:'2026-08'}).excluded.length,1);
});

test('invoices, expected renewals and held receipts cannot become expenses through a misplaced payment array',()=>{
  const paid={id:'synthetic-paid',kind:'payment_succeeded',authenticated:true,paymentDay:'2026-07-31',paymentDateBasis:'explicit',payment:{currency:'USD',minor:2400}};
  const result=summarizeCashflow({payments:[paid,
    {...paid,id:'synthetic-invoice',kind:'invoice_recorded',paymentDay:'2026-08-01'},
    {...paid,id:'synthetic-renewal',kind:'renewal_notice',paymentDay:'2026-09-01'},
    {...paid,id:'synthetic-candidate',candidateStatus:'needs_review'},
    {...paid,id:'synthetic-import',importStatus:'needs_source_recheck'},
    {...paid,id:'synthetic-source-conflict',sourceProcessingConflict:true}
  ]});
  assert.deepEqual(result.paidMinorByCurrency,{USD:2400});
  assert.deepEqual(result.months,['2026-07']);
  assert.equal(result.included.length,1);
  assert.deepEqual(result.excluded.map(row=>row.reason),['payment_not_recorded','payment_not_recorded','held_for_review','held_for_review','held_for_review']);
});

test('source authority requires real booleans or an actual dated connector read',()=>{
  const paid={id:'synthetic-source',kind:'payment_succeeded',authenticated:true,paymentDay:'2026-07-31',paymentDateBasis:'explicit',payment:{currency:'USD',minor:1200}};
  const result=summarizeCashflow({payments:[
    {...paid,authenticated:'false'},
    {...paid,id:'synthetic-flag',authenticated:false,userVerified:'true'},
    {...paid,id:'synthetic-invalid-read',authenticated:false,sourceFormat:'claude_plaintext',sourceReadAt:'not-a-date'},
    {...paid,id:'synthetic-connector',authenticated:false,sourceFormat:'claude_plaintext',sourceReadAt:'2026-08-01T10:00:00Z'}
  ]},{trustConnectorReads:true});
  assert.deepEqual(result.paidMinorByCurrency,{USD:1200});
  assert.equal(result.excluded.length,3);
});

test('billing dates remain receipt calendar days across year boundaries and leap days',()=>{
  const paid=(id,date,minor)=>({id,kind:'payment_succeeded',authenticated:true,paymentDay:date,paymentDateBasis:'explicit',payment:{currency:'USD',minor},receivedAt:'2026-01-01T00:30:00+14:00'});
  const snapshot={payments:[paid('synthetic-year-end','2025-12-31',9900),paid('synthetic-new-year','2026-01-01',100),paid('synthetic-leap','2024-02-29',200),paid('synthetic-invalid-leap','2025-02-29',300)]};
  assert.deepEqual(summarizeCashflow(snapshot,{month:'2025-12'}).paidMinorByCurrency,{USD:9900});
  assert.deepEqual(summarizeCashflow(snapshot,{month:'2026-01'}).paidMinorByCurrency,{USD:100});
  assert.deepEqual(summarizeCashflow(snapshot,{month:'2024-02'}).paidMinorByCurrency,{USD:200});
  assert.equal(summarizeCashflow(snapshot).unallocatedCount,1);
});
