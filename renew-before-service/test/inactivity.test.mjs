import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectEvidence, extractEvidence } from '../src/evidence.mjs';

// Fictional source events only. No real email or account identifiers belong here.
const base = { id:'fictional-start',messageId:'fictional-start-mail',serviceKey:'fictional-music',service:'Fictional Music',category:'Software',authenticated:true,
  kind:'subscription_confirmed',receivedAt:'2026-05-15T00:00:00Z',nextBilling:'2026-06-15',cadence:'monthly' };
const source = (kind,extra={}) => ({...base,id:'fictional-'+kind,messageId:'fictional-'+kind+'-mail',kind,receivedAt:'2026-06-20T00:00:00Z',nextBilling:undefined,...extra});
const at = (events=[base],asOf='2026-08-16T00:00:00Z',extra={}) => projectEvidence(events,{asOf,...extra});
const sub = (...args) => at(...args).subscriptions[0];

test('an expected payment more than 60 days ago becomes a reversible, unconfirmed estimate',()=>{
  const events=[base],before=JSON.stringify(events),result=sub(events);
  assert.equal(result.status,'likely_canceled');assert.equal(result.renewal,'on');
  assert.deepEqual(result.inactivityInference,{reason:'overdue_without_new_charge',expectedPaymentDay:'2026-06-15',thresholdDays:60,thresholdDay:'2026-08-14',evaluatedAt:'2026-08-16T00:00:00Z',sourceEvidenceId:base.id,confirmed:false});
  assert.match(result.warnings.join(' '),/Missing email evidence/);
  assert.equal(JSON.stringify(events),before);
  assert.equal(sub(events,'2026-08-14T23:59:59Z').status,'needs_verification');
  assert.equal(sub(events,'2026-08-13T00:00:00Z').status,'needs_verification');
});

test('the 60-day boundary remains exact across month ends, years and leap years',()=>{
  for(const [expected,threshold,dayAfter] of [
    ['2026-01-31','2026-04-01','2026-04-02'],['2026-12-31','2027-03-01','2027-03-02'],
    ['2027-12-31','2028-02-29','2028-03-01'],['2026-07-01','2026-08-30','2026-08-31']]) {
    const events=[{...base,receivedAt:expected+'T00:00:00Z',nextBilling:expected}];
    assert.equal(sub(events,threshold+'T23:59:59Z').status,'needs_verification');
    const later=sub(events,dayAfter+'T00:00:00Z');assert.equal(later.status,'likely_canceled');assert.equal(later.inactivityInference.thresholdDay,threshold);
  }
});

test('future renewal, paid access and trial/cancel deadlines prevent premature inference for annual or prepaid plans',()=>{
  for(const extra of [{nextBilling:'2027-06-15',cadence:'annual'},{accessEnds:'2027-06-15'},{trialEnds:'2026-08-16'},{cancelBy:'2026-09-01'}]) {
    const events=extra.accessEnds?[base,source('payment_succeeded',{payment:{minor:12000,currency:'USD'},paymentDay:'2026-05-15',period:{end:extra.accessEnds},cadence:'annual'})]:[{...base,...extra}];
    assert.notEqual(sub(events).status,'likely_canceled');
  }
});

test('newer charges block the estimate even when currency or exact charge date is unknown',()=>{
  for(const extra of [
    {paymentDay:'2026-06-15',payment:{minor:1000,currency:'USD'}},
    {paymentDay:'2026-07-01',payment:{minor:1000,currency:null}},
    {paymentDay:null,payment:{minor:1000,currency:'USD'}},
    {paymentDay:'2026-06-10',period:{start:'2026-06-15',end:'2026-07-15'},payment:{minor:1000,currency:'USD'}}
  ]) assert.notEqual(sub([base,source('payment_succeeded',extra)]).status,'likely_canceled');
});

test('recent subscription, invoice and renewal evidence is retained for checking, not treated as proof of cancellation',()=>{
  for(const event of [
    source('subscription_confirmed'),source('trial_confirmed'),source('renewal_notice'),source('invoice_recorded',{invoiceAmount:{minor:1000,currency:'USD'}}),
    source('payment_failed'),source('access_paused')
  ]) assert.notEqual(sub([base,event]).status,'likely_canceled',event.kind);
});

test('a new renewal date or explicit restart reverses inference without editing the previous evidence',()=>{
  assert.equal(sub().status,'likely_canceled');
  for(const kind of ['subscription_confirmed','renewal_notice']) {
    const result=sub([base,source(kind,{receivedAt:'2026-08-17T00:00:00Z',nextBilling:'2026-09-17',renewal:'on'})],'2026-08-18T00:00:00Z');
    assert.equal(result.status,'active');assert.equal(result.inactivityInference,null);
  }
});

test('explicit cancellation and no-subscription corrections stay distinct from the estimate',()=>{
  const canceled=sub([base,source('renewal_disabled',{accessEnds:'2026-06-30'})]);
  assert.equal(canceled.status,'renewal_off');assert.equal(canceled.inactivityInference,null);
  const corrected=at([base,source('account_not_subscribed')]);
  assert.equal(corrected.subscriptions.length,0);assert.equal(corrected.excludedServices[0].status,'not_subscribed');
});

test('undated payments, expired access and missing or invalid expected-payment dates never invent a next charge',()=>{
  for(const nextBilling of [undefined,null,'2026-02-30','yesterday']) {
    const result=sub([{...base,nextBilling}]);assert.notEqual(result.status,'likely_canceled');
  }
  const receipt=source('payment_succeeded',{paymentDay:'2026-01-15',payment:{currency:'USD',minor:1000},period:{end:'2026-02-15'},cadence:'monthly'});
  assert.equal(sub([receipt]).status,'needs_verification');
});

test('untrusted or conflicting sources cannot be used as absence-of-charge evidence',()=>{
  assert.equal(at([{...base,authenticated:false}]).subscriptions.length,0);
  const held=source('payment_succeeded',{authenticated:false,payment:{currency:'USD',minor:1000},paymentDay:'2026-06-20'});
  assert.notEqual(sub([base,held]).status,'likely_canceled');
  const conflict=[{...held,authenticated:true,id:'duplicate'},{...held,authenticated:true,id:'duplicate',payment:{minor:2000,currency:'USD'}}];
  assert.notEqual(sub([base,...conflict]).status,'likely_canceled');
});

test('separate accounts do not suppress each other, while unscoped unresolved sources protect both accounts',()=>{
  const a={...base,accountRef:'fictional-a'},b={...base,id:'fictional-b',accountRef:'fictional-b',nextBilling:'2026-09-01'};
  const result=at([a,b]).subscriptions;assert.equal(result.find(s=>s.serviceKey.includes('fictional-a')).status,'likely_canceled');assert.equal(result.find(s=>s.serviceKey.includes('fictional-b')).status,'active');
  const held=source('payment_succeeded',{authenticated:false,payment:{currency:'USD',minor:1000}});
  assert.ok(at([a,b,held]).subscriptions.every(s=>s.status!=='likely_canceled'));
});

test('incomplete discovery never upgrades the estimate to confirmed cancellation',()=>{
  const result=sub([base],'2026-08-16T00:00:00Z',{coverage:{pending:true,messageCount:2}});
  assert.equal(result.status,'likely_canceled');assert.equal(result.inactivityInference.confirmed,false);assert.match(result.warnings.join(' '),/estimate|Missing email evidence/);
});

test('inferred status never deletes or reclassifies actual payments, refunds or one-time purchases',()=>{
  const paid=source('payment_succeeded',{receivedAt:'2026-05-15T00:00:00Z',paymentDay:'2026-05-15',payment:{currency:'USD',minor:1000}});
  const refund=source('refund_recorded',{refund:{currency:'USD',minor:200},refundDay:'2026-07-01'});
  const oneTime=source('one_time_purchase',{serviceKey:'fictional-once',payment:{currency:'USD',minor:2000}});
  const events=[base,paid,refund,oneTime],before=at(events,'2026-08-13T00:00:00Z'),after=at(events);
  assert.equal(after.subscriptions[0].status,'likely_canceled');
  for(const key of ['payments','refunds','oneTimePurchases','recordedPaidMinorByCurrency'])assert.deepEqual(after[key],before[key]);
});

test('newer unclassified OpenAI evidence never becomes a likely-canceled ChatGPT plan',()=>{
  const plan={...base,serviceKey:'chatgpt',service:'ChatGPT'};
  const unknown=extractEvidence({id:'fictional-unknown',sender:'billing@openai.com',authenticatedSenderDomain:'openai.com',subject:'OpenAI invoice',text:'Invoice',receivedAt:'2026-06-20T00:00:00Z'});
  const invoice=unknown[0]||{...source('unclassified_purchase'),providerKey:'openai',serviceKey:'openai-unknown-product'};
  const result=sub([plan,{...invoice,providerKey:'openai',kind:'unclassified_purchase'}]);
  assert.equal(result.status,'needs_verification');assert.equal(result.inactivityInference,null);
});
