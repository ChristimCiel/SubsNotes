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
