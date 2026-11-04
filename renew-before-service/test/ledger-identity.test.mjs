import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractEvidence,projectEvidence,digest} from '../src/evidence.mjs';
import {summarizeCashflow} from '../src/cashflow.mjs';
const asOf='2026-10-03T00:00:00Z';
const base={messageId:'fixture-mail',serviceKey:'fixture-service',service:'Fixture service',category:'Software',authenticated:true,receivedAt:'2026-10-01T00:00:00Z',reference:'fixture-invoice'};
const payment=(id,extra={})=>({...base,id,kind:'payment_succeeded',payment:{minor:2000,currency:'USD'},paymentDay:'2026-10-01',paymentDateBasis:'explicit',...extra});
const refund=(id,extra={})=>({...base,id,kind:'refund_recorded',refund:{minor:200,currency:'USD'},refundDay:'2026-10-02',refundDateBasis:'explicit',...extra});

test('legacy receipt identities stay stable and duplicate invoice receipts still count once',()=>{
  const message={id:'fixture-mail',sender:'billing@anthropic.com',subject:'Your receipt from Anthropic',receivedAt:'2026-10-01T00:00:00Z',authenticatedSenderDomain:'anthropic.com',text:'Claude Pro subscription Amount paid USD 20.00'};
  assert.equal(extractEvidence(message)[0].id,digest('fixture-mail|payment_succeeded|v1'));
  assert.equal(projectEvidence([payment('one'),payment('copy',{messageId:'fixture-copy'})],{asOf}).recordedPaidMinorByCurrency.USD,2000);
});

test('explicit line items and account scopes add identity without rekeying old records',()=>{
  const events=[payment('line-one',{lineItemRef:'seat-one'}),payment('line-two',{lineItemRef:'seat-two'}),payment('other-account',{accountRef:'opaque-account-two'})];
  const result=projectEvidence(events,{asOf});
  assert.equal(result.recordedPaidMinorByCurrency.USD,6000);assert.equal(result.payments.length,3);assert.equal(result.subscriptions.length,2);
  assert.ok(result.subscriptions.some(s=>s.serviceKey==='fixture-service'));
  assert.ok(result.subscriptions.some(s=>s.serviceKey==='fixture-service|account:opaque-account-two'));
  assert.deepEqual(events.map(e=>e.id),['line-one','line-two','other-account']);
});

test('separate partial refund references count independently while repeated refund evidence deduplicates',()=>{
  const events=[refund('refund-a',{refundRef:'partial-one'}),refund('refund-a-copy',{refundRef:'partial-one',messageId:'copy-mail'}),refund('refund-b',{refundRef:'partial-two',refund:{minor:300,currency:'USD'}})];
  const result=projectEvidence(events,{asOf});assert.equal(result.refunds.length,2);
  assert.equal(summarizeCashflow(result).providerRefundMinorByCurrency.USD,500);
});

test('contradictory amounts for one refund reference are held outside refund totals',()=>{
  const result=projectEvidence([refund('refund-first',{refundRef:'one-refund'}),refund('refund-conflict',{refundRef:'one-refund',refund:{minor:300,currency:'USD'}})],{asOf});
  assert.equal(result.refunds.length,1);assert.equal(result.refunds[0].conflict,true);
  assert.deepEqual(summarizeCashflow(result).providerRefundMinorByCurrency,{});
});

test('refund IDs are extracted from observed receipt text without changing source event identities',()=>{
  const message={id:'fixture-refund',sender:'hi@cursor.com',subject:'Your refund from Cursor',receivedAt:'2026-10-01T00:00:00Z',authenticatedSenderDomain:'cursor.com',text:'Partial refund was processed. Total refunded USD 2.00. Refund ID RF-EXAMPLE-1 Invoice number BILL-EXAMPLE'};
  const result=extractEvidence(message)[0];assert.equal(result.refundRef,'RF-EXAMPLE-1');assert.equal(result.id,digest('fixture-refund|refund_recorded|v1'));
});

test('conflicting duplicate event IDs are quarantined before totals instead of last-write winning',()=>{
  const result=projectEvidence([payment('same'),payment('same',{payment:{minor:3000,currency:'USD'}})],{asOf});
  assert.equal(result.payments.length,0);assert.deepEqual(result.recordedPaidMinorByCurrency,{});assert.equal(result.heldEvidence.length,2);
  assert.ok(result.heldEvidence.every(e=>e.holdReason==='conflicting_event_identity'));
});

test('fresh connector timestamps do not make imported or proposed records trusted',()=>{
  for(const extra of [{candidateStatus:'needs_review'},{importStatus:'needs_source_recheck'},{sourceProcessingConflict:true}]){
    const result=projectEvidence([payment('held',{...extra,sourceFormat:'claude_plaintext',sourceReadAt:asOf})],{asOf,trustConnectorReads:true});
    assert.equal(result.payments.length,0);assert.equal(result.heldEvidence.length,1);
  }
});

test('truthy strings and malformed read timestamps do not establish source authority in projection',()=>{
  for(const extra of [{authenticated:'false'},{authenticated:false,userVerified:'true'},{authenticated:false,sourceFormat:'claude_plaintext',sourceReadAt:'not-a-date'}]){
    const result=projectEvidence([payment('untrusted',extra)],{asOf,trustConnectorReads:true});
    assert.equal(result.payments.length,0);assert.equal(result.subscriptions.length,0);assert.equal(result.heldEvidence.length,1);
  }
});

test('duplicate invoice copies enrich an unknown date and retain every source without mutating the ledger',()=>{
  const original=payment('undated',{paymentDay:null,paymentDateBasis:'unknown'});
  const dated=payment('dated-copy',{messageId:'dated-copy-mail',receivedAt:'2026-10-02T00:00:00Z'});
  const result=projectEvidence([original,dated],{asOf});
  assert.equal(result.payments.length,1);assert.equal(result.payments[0].paymentDay,'2026-10-01');
  assert.equal(result.payments[0].id,'dated-copy');assert.deepEqual(result.payments[0].duplicateEvidenceIds,['undated']);
  assert.equal(summarizeCashflow(result,{month:'2026-10'}).paidMinorByCurrency.USD,2000);
  assert.equal(original.paymentDay,null);assert.equal(original.duplicateEvidenceIds,undefined);
});

test('same-invoice currency evidence can fill an unknown code but conflicting codes remain held',()=>{
  const unknown=payment('unknown-currency',{payment:{minor:2000,currency:null}});
  const confirmed=payment('currency-copy',{messageId:'currency-copy-mail',receivedAt:'2026-10-02T00:00:00Z'});
  const enriched=projectEvidence([unknown,confirmed],{asOf});
  assert.equal(enriched.payments.length,1);assert.equal(enriched.payments[0].payment.currency,'USD');
  assert.equal(summarizeCashflow(enriched).paidMinorByCurrency.USD,2000);
  assert.deepEqual(enriched.payments[0].duplicateEvidenceIds,['unknown-currency']);
  const conflict=projectEvidence([unknown,confirmed,payment('other-currency',{payment:{minor:2000,currency:'CAD'}})],{asOf});
  assert.equal(conflict.payments[0].conflict,true);assert.deepEqual(summarizeCashflow(conflict).paidMinorByCurrency,{});
});

test('contradictory explicit payment dates for the same invoice stay excluded after matching copies arrive',()=>{
  const result=projectEvidence([payment('october'),payment('september',{messageId:'september-copy-mail',paymentDay:'2026-09-30'}),payment('matching-copy')],{asOf});
  assert.equal(result.payments.length,1);assert.equal(result.payments[0].conflict,true);
  assert.deepEqual(new Set([result.payments[0].id,...result.payments[0].duplicateEvidenceIds]),new Set(['october','september','matching-copy']));
  assert.deepEqual(summarizeCashflow(result,{month:'2026-10'}).paidMinorByCurrency,{});
  assert.deepEqual(summarizeCashflow(result,{month:'2026-09'}).paidMinorByCurrency,{});
});

test('conflicting receipt copies cannot clear an unresolved payment failure',()=>{
  const failure={...base,id:'failed',messageId:'failed-mail',kind:'payment_failed',receivedAt:'2026-09-29T00:00:00Z'};
  const result=projectEvidence([failure,payment('paid-one'),payment('paid-other',{messageId:'other-copy',paymentDay:'2026-10-02',receivedAt:'2026-10-02T10:00:00Z'})],{asOf});
  assert.equal(result.subscriptions[0].status,'payment_problem');
  assert.equal(result.subscriptions[0].lastPayment,null);
  assert.ok(result.subscriptions[0].statusAssessment.signals.some(s=>s.code==='source_conflict'));
  assert.ok(!result.subscriptions[0].statusAssessment.signals.some(s=>s.code==='recovered_by_payment'));
});

test('a late-delivered older receipt cannot replace the last actual payment',()=>{
  const latest=payment('latest',{reference:'latest-invoice',payment:{minor:2400,currency:'USD'}});
  const delayed=payment('delayed',{reference:'older-invoice',messageId:'delayed-mail',receivedAt:'2026-10-02T00:00:00Z',paymentDay:'2026-09-01',payment:{minor:1900,currency:'USD'}});
  const result=projectEvidence([latest,delayed],{asOf});
  assert.equal(result.subscriptions[0].lastPayment.minor,2400);assert.equal(result.subscriptions[0].lastPayment.day,'2026-10-01');
  assert.equal(summarizeCashflow(result,{month:'2026-09'}).paidMinorByCurrency.USD,1900);
  assert.equal(summarizeCashflow(result,{month:'2026-10'}).paidMinorByCurrency.USD,2400);
});

test('missing financial fields on duplicate records remain reviewable without crashing',()=>{
  const result=projectEvidence([payment('unknown-one',{payment:null,paymentDay:null,paymentDateBasis:'unknown'}),payment('unknown-two',{payment:undefined,paymentDay:null,paymentDateBasis:'unknown'})],{asOf});
  assert.equal(result.payments.length,1);assert.deepEqual(summarizeCashflow(result).paidMinorByCurrency,{});
  assert.equal(result.unconfirmedCurrencyPayments,1);
});

test('refund date contradictions are held and account or line-item identities never supply one another a date',()=>{
  const refunds=projectEvidence([refund('first-refund',{refundRef:'one-refund'}),refund('other-refund',{refundRef:'one-refund',refundDay:'2026-09-30'})],{asOf});
  assert.equal(refunds.refunds[0].conflict,true);assert.deepEqual(summarizeCashflow(refunds).providerRefundMinorByCurrency,{});
  const result=projectEvidence([payment('first-account',{paymentDay:null,paymentDateBasis:'unknown',accountRef:'one'}),payment('second-account',{accountRef:'two'}),payment('other-line',{lineItemRef:'other'})],{asOf});
  assert.equal(result.payments.length,3);assert.equal(result.payments.find(e=>e.id==='first-account').paymentDay,null);
});

test('reviewed recurring donations retain their actual payment dates outside digital subscriptions and expenses',()=>{
  const donation=payment('synthetic-donation',{category:'Donations',cadence:'monthly',paymentDay:'2026-09-30',receivedAt:'2026-10-01T00:01:00Z'});
  const copy={...donation,id:'synthetic-donation-copy',messageId:'synthetic-donation-copy-mail'};
  const app=payment('synthetic-app',{serviceKey:'synthetic-app',reference:'synthetic-app-invoice',payment:{minor:1200,currency:'EUR'}});
  const result=projectEvidence([donation,copy,app],{asOf});
  assert.equal(result.otherRecurringPayments.length,1);assert.equal(result.otherRecurringPayments[0].kind,'payment_succeeded');
  assert.equal(result.otherRecurringPayments[0].cadence,'monthly');assert.equal(result.otherRecurringPayments[0].paymentDay,'2026-09-30');
  assert.equal(result.subscriptions.length,1);assert.equal(result.subscriptions[0].serviceKey,'synthetic-app');
  assert.equal(result.payments.length,1);assert.deepEqual(result.recordedPaidMinorByCurrency,{EUR:1200});
  assert.deepEqual(summarizeCashflow(result,{month:'2026-09'}).paidMinorByCurrency,{});
  assert.deepEqual(summarizeCashflow(result,{month:'2026-10'}).paidMinorByCurrency,{EUR:1200});
});

test('a donation with unknown or irregular cadence never becomes a digital subscription',()=>{
  for(const cadence of [null,'irregular']){
    const donation=payment('synthetic-unknown-cadence-donation',{category:'Donations',cadence});
    const result=projectEvidence([donation],{asOf});
    assert.equal(result.otherRecurringPayments.length,1);assert.equal(result.otherRecurringPayments[0].cadence,cadence);
    assert.equal(result.subscriptions.length,0);assert.equal(result.payments.length,0);
    assert.deepEqual(summarizeCashflow(result).paidMinorByCurrency,{});
  }
});

test('known one-time invoices stay invoice evidence and cannot create a recurring subscription or paid expense',()=>{
  const invoice={...base,id:'synthetic-oneoff-invoice',messageId:'synthetic-oneoff-mail',kind:'invoice_recorded',category:'One-time purchases',invoiceAmount:{minor:8400,currency:'JPY'},invoiceDay:'2026-09-30'};
  const result=projectEvidence([invoice,{...invoice,id:'synthetic-invoice-copy',messageId:'synthetic-invoice-copy-mail'}],{asOf});
  assert.equal(result.oneTimePurchases.length,1);assert.equal(result.oneTimePurchases[0].kind,'invoice_recorded');
  assert.equal(result.oneTimePurchases[0].invoiceAmount.minor,8400);assert.equal(result.oneTimePurchases[0].invoiceDay,'2026-09-30');
  assert.equal(result.subscriptions.length,0);assert.equal(result.payments.length,0);assert.deepEqual(summarizeCashflow(result).paidMinorByCurrency,{});
});
