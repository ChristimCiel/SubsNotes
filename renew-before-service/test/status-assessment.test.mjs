import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectEvidence,extractEvidence} from '../src/evidence.mjs';

// Fictional, source-shaped billing timelines. No personal mailbox fixtures.
const row=(kind,id,date,fields={})=>({kind,id,messageId:'mail-'+id,serviceKey:'fictional',service:'Fictional Studio',category:'Software',authenticated:true,receivedAt:date+'T10:00:00Z',...fields});
const view=(events,asOf='2026-11-04T00:00:00Z')=>projectEvidence(events,{asOf});
const sub=events=>view(events).subscriptions[0];
const reminder=row('access_expiring','reminder','2026-06-10',{accessEnds:'2026-06-17'});
const failure=row('payment_failed','failure','2026-06-15');
const paid=(id,date,fields={})=>row('payment_succeeded',id,date,{payment:{minor:2000,currency:'USD'},paymentDay:date,paymentDateBasis:'explicit',...fields});

test('past expiry reminders and failed payments jointly establish a moderate, reversible inactive estimate',()=>{
  const result=sub([reminder,failure]);
  assert.equal(result.status,'likely_canceled');assert.equal(result.statusAssessment.basis,'inferred');
  assert.equal(result.statusAssessment.confidence,'moderate');assert.equal(result.inactivityInference.reason,'combined_billing_signals');
  assert.equal(result.inactivityInference.confirmed,false);assert.equal(result.nextBilling,null);
  assert.deepEqual(result.statusAssessment.signals.map(s=>s.code),['expiry_reminders','unresolved_failure']);
  assert.deepEqual(new Set(result.statusAssessment.signals.flatMap(s=>s.evidenceIds)),new Set(['reminder','failure']));
});

test('one overdue date is limited evidence while explicit cancellation is recorded evidence',()=>{
  const old=row('renewal_notice','renewal','2026-06-01',{renewal:'on',nextBilling:'2026-07-01'});
  const inferred=sub([old]);assert.equal(inferred.statusAssessment.confidence,'limited');assert.equal(inferred.statusAssessment.basis,'inferred');
  const confirmed=sub([old,row('renewal_disabled','off','2026-06-30',{accessEnds:'2026-07-01'})]);
  assert.equal(confirmed.status,'renewal_off');assert.equal(confirmed.statusAssessment.confidence,'strong');assert.equal(confirmed.statusAssessment.basis,'recorded');
});

test('a later successful payment supersedes failures and expiry warnings in either input order',()=>{
  const success=paid('paid','2026-06-18',{period:{start:'2026-06-18',end:'2027-06-18'},cadence:'annual'});
  for(const events of [[reminder,failure,success],[success,failure,reminder]]) {
    const result=sub(events);assert.equal(result.status,'paid_access');assert.equal(result.unresolvedPaymentProblem,null);
    assert.ok(!result.statusAssessment.signals.some(s=>s.code==='unresolved_failure'||s.code==='expiry_reminders'));
    assert.ok(result.statusAssessment.signals.some(s=>s.code==='recovered_by_payment'));
  }
});

test('late delivery of a historical paid receipt cannot clear a newer failure',()=>{
  const late=paid('late','2026-07-01',{paymentDay:'2026-05-01',period:{start:'2026-05-01',end:'2026-06-01'}});
  const result=sub([reminder,failure,late]);assert.equal(result.unresolvedPaymentProblem,'failure');assert.equal(result.status,'likely_canceled');
  assert.ok(!result.statusAssessment.signals.some(s=>s.code==='recovered_by_payment'));
});

test('a later payment with an unknown payment day prevents a firm expiry or inactivity verdict',()=>{
  for(const warning of [reminder,row('access_expired','expired','2026-06-18',{accessEnds:'2026-06-17'})]) {
    const result=sub([warning,failure,paid('uncertain','2026-07-01',{paymentDay:null,paymentDateBasis:'unknown'})]);
    assert.notEqual(result.status,'likely_canceled');assert.notEqual(result.status,'expired');assert.equal(result.statusAssessment.confidence,'limited');
  }
});

test('different invoice references do not resolve one another just because a newer payment exists',()=>{
  const result=sub([{...failure,reference:'FICTIONAL-UNPAID'},paid('other-invoice','2026-06-20',{reference:'FICTIONAL-OTHER'})]);
  assert.equal(result.status,'payment_problem');assert.equal(result.unresolvedPaymentProblem,'failure');
});

test('repeated failures alone remain a payment issue, not proof the provider stopped a plan',()=>{
  const result=sub([failure,row('payment_failed','retry','2026-06-20')]);
  assert.equal(result.status,'payment_problem');assert.equal(result.statusAssessment.confidence,'moderate');assert.equal(result.inactivityInference,null);
});

test('two events or retries from one message cannot masquerade as two independent warning emails',()=>{
  const same={...failure,messageId:reminder.messageId};
  const result=sub([reminder,same,{...same,id:'reprocessed-copy'}]);assert.equal(result.status,'payment_problem');
  assert.equal(result.inactivityInference,null);
});

test('undated expiry reminders cannot manufacture a past deadline',()=>{
  const result=sub([{...reminder,accessEnds:null},failure]);assert.equal(result.status,'payment_problem');assert.equal(result.accessEnds,null);
});

test('an explicit expiry message is distinguished from cancellation, and a restart supersedes it',()=>{
  const expired=row('access_expired','expiry','2026-06-18',{accessEnds:'2026-06-17'});
  const result=sub([expired,failure]);assert.equal(result.status,'expired');assert.equal(result.renewal,'unknown');assert.equal(result.statusAssessment.basis,'recorded');
  const restart=row('subscription_confirmed','restart','2026-07-01',{nextBilling:'2026-12-01'});
  const restarted=sub([expired,restart]);assert.equal(restarted.status,'active');assert.ok(!restarted.statusAssessment.signals.some(s=>s.code==='expiry_recorded'));
  assert.equal(sub([{...expired,accessEnds:null}]).status,'expired');
});

test('a future annual paid-through or trial period blocks a likely-inactive estimate',()=>{
  const events=[reminder,failure,paid('annual','2026-06-16',{period:{start:'2026-06-16',end:'2027-06-16'}})];
  assert.equal(sub(events).status,'paid_access');
  const trial=row('trial_confirmed','trial','2026-06-20',{trialEnds:'2027-01-01'});
  assert.notEqual(sub([reminder,failure,trial]).status,'likely_canceled');
});

test('new invoices and unverified contradictory sources retain a need to check current status',()=>{
  const invoice=row('invoice_recorded','invoice','2026-07-01',{invoiceAmount:{minor:2000,currency:'USD'}});
  assert.equal(sub([reminder,failure,invoice]).status,'payment_problem');
  const held={...paid('held','2026-07-01'),authenticated:false};
  assert.notEqual(sub([reminder,failure,held]).status,'likely_canceled');
});

test('account scopes, refunds and one-time purchases do not manufacture a recovery payment',()=>{
  const a={...reminder,accountRef:'fictional-a'},b={...failure,accountRef:'fictional-b'};
  assert.ok(view([a,b]).subscriptions.every(s=>s.status!=='likely_canceled'));
  const refund=row('refund_recorded','refund','2026-07-01',{refund:{minor:2000,currency:'USD'},refundDay:'2026-07-01'});
  const one=row('one_time_purchase','one-off','2026-07-01',{payment:{minor:2000,currency:'USD'}});
  const result=sub([reminder,failure,refund,one]);assert.equal(result.status,'likely_canceled');assert.equal(result.unresolvedPaymentProblem,'failure');
});

test('chronology is not a statistical probability and financial totals are unchanged by the assessment',()=>{
  const receipt=paid('old-paid','2026-05-01');const result=view([receipt,reminder,failure]);
  assert.deepEqual(result.recordedPaidMinorByCurrency,{USD:2000});assert.equal(result.payments.length,1);
  const a=result.subscriptions[0].statusAssessment;assert.equal(a.confidenceMeaning,'evidence_strength_not_probability');assert.equal(a.coverageLimited,true);assert.ok(!('probability' in a));
});

test('the extractor understands relative reminders, actual expiry and paid receipts without conflating them',()=>{
  const mail=(id,subject,text)=>({id,subject,text,sender:'billing@anthropic.com',authenticatedSenderDomain:'anthropic.com',receivedAt:'2026-06-10T10:00:00Z'});
  assert.equal(extractEvidence(mail('relative','Your subscription ends in 3 days','Your subscription ends in 3 days.'))[0].accessEnds,'2026-06-13');
  const expired=extractEvidence(mail('expired','Your subscription has expired','Your subscription expired on June 9, 2026.'))[0];assert.equal(expired.kind,'access_expired');assert.equal(expired.accessEnds,'2026-06-09');
  const receipt=extractEvidence(mail('paid','Your subscription receipt','Claude Pro. Your subscription ends in 3 days. Paid June 10, 2026. Amount paid USD 20.'));
  assert.ok(receipt.some(e=>e.kind==='payment_succeeded'));
});


test('an overdue renewal and a separate expiry email corroborate one another without requiring two expiry notices',()=>{
  const expected=row('renewal_notice','expected','2026-06-01',{nextBilling:'2026-06-17',renewal:'on'});
  const result=sub([expected,reminder]);assert.equal(result.status,'likely_canceled');assert.equal(result.statusAssessment.confidence,'moderate');
  assert.ok(result.statusAssessment.signals.some(s=>s.code==='renewal_overdue'));
  assert.ok(result.statusAssessment.signals.some(s=>s.code==='expiry_reminders'));
});

test('a newer successful charge for another invoice blocks inactivity even if an older invoice issue is unresolved',()=>{
  const result=sub([reminder,{...failure,reference:'FICTIONAL-OLDER'},paid('newer-other','2026-10-01',{reference:'FICTIONAL-NEW'})]);
  assert.equal(result.status,'payment_problem');assert.equal(result.unresolvedPaymentProblem,'failure');assert.equal(result.inactivityInference,null);
});


test('successful billing after a recorded cancellation makes current status uncertain without silently restarting renewal',()=>{
  const off=row('renewal_disabled','off','2026-06-01',{accessEnds:'2026-06-15'});
  const result=sub([off,paid('after-off','2026-07-01')]);assert.equal(result.renewal,'off');assert.equal(result.status,'needs_verification');
  assert.equal(result.statusAssessment.confidence,'limited');assert.ok(result.statusAssessment.signals.some(s=>s.code==='charge_after_cancellation'));
  const delayed=paid('old-delayed','2026-07-01',{paymentDay:'2026-05-01'});assert.equal(sub([off,delayed]).status,'renewal_off');
});

test('an invoice issued after cancellation requires a current check without inventing payment or renewed access',()=>{
  const off=row('renewal_disabled','off-invoice-case','2026-06-01',{accessEnds:'2026-06-15'});
  const invoice=row('invoice_recorded','after-off-invoice','2026-07-01',{invoiceAmount:{minor:1700,currency:'EUR'},invoiceDay:'2026-07-01'});
  const result=sub([off,invoice]);assert.equal(result.renewal,'off');assert.equal(result.status,'needs_verification');
  assert.equal(view([off,invoice]).payments.length,0);assert.deepEqual(view([off,invoice]).recordedPaidMinorByCurrency,{});
  assert.equal(result.statusAssessment.confidence,'limited');assert.ok(result.statusAssessment.signals.some(s=>s.code==='invoice_after_cancellation'));
  const oldInvoice={...invoice,id:'old-delayed-invoice',invoiceDay:'2026-05-01'};
  assert.equal(sub([off,oldInvoice]).status,'renewal_off');
  const undated=sub([off,{...invoice,id:'unknown-issue-day',invoiceDay:null}]);
  assert.equal(undated.status,'needs_verification');assert.ok(undated.warnings.some(warning=>warning.includes('Later invoice evidence')));
});

test('explicit invoice plan and cadence remain visible without establishing a payment or renewal schedule',()=>{
  const invoice=row('invoice_recorded','fictional-plan-invoice','2026-07-01',{invoiceAmount:{minor:1700,currency:'EUR'},invoiceDay:'2026-07-01',cadence:'monthly',plan:'Fictional Pro'});
  const result=sub([invoice]);assert.equal(result.plan,'Fictional Pro');assert.equal(result.cadence,'monthly');
  assert.equal(result.renewal,'unknown');assert.equal(result.nextBilling,null);assert.equal(view([invoice]).payments.length,0);
});

test('an unpriced trial with an ambiguous access date never invents automatic paid renewal',()=>{
  const trial=row('trial_confirmed','fictional-unpriced-trial','2026-07-01',{evidence:'Full access until August 28.',trialEnds:null,nextBilling:null});
  const result=sub([trial]);assert.equal(result.renewal,'unknown');assert.equal(result.nextBilling,null);assert.equal(result.accessEnds,null);
  assert.equal(result.status,'needs_verification');assert.equal(view([trial]).payments.length,0);
});

test('a later free trial preserves renewal-off history and cannot shorten previously paid access',()=>{
  const off=row('renewal_disabled','fictional-off-before-trial','2026-06-01',{accessEnds:'2026-12-01'});
  const trial=row('trial_confirmed','fictional-free-trial','2026-07-01',{trialEnds:'2026-08-01',accessEnds:'2026-08-01'});
  const result=sub([off,trial]);assert.equal(result.renewal,'off');assert.equal(result.renewalSourceAt,off.receivedAt);
  assert.equal(result.status,'renewal_off');assert.equal(result.accessEnds,'2026-12-01');assert.equal(result.nextBilling,null);
  const receipt=paid('fictional-paid-before-trial','2026-06-01',{period:{start:'2026-06-01',end:'2026-12-01'}});
  assert.equal(sub([receipt,trial]).accessEnds,'2026-12-01');assert.equal(sub([receipt,trial]).renewal,'unknown');
});

test('a trial with an explicit priced renewal schedule retains its scheduled renewal behavior',()=>{
  const trial=row('trial_confirmed','fictional-priced-trial','2026-07-01',{trialEnds:'2026-12-01',nextBilling:'2026-12-01',nextCharge:{minor:1700,currency:'EUR'},cadence:'monthly'});
  const result=sub([trial]);assert.equal(result.renewal,'on');assert.equal(result.nextBilling,'2026-12-01');assert.equal(result.status,'active');
  assert.equal(view([trial]).payments.length,0);
});
