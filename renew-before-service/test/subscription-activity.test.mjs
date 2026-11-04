import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSubscriptionActivityRuntime} from '../src/subscription-activity.mjs';
import {projectEvidence} from '../src/evidence.mjs';
import {summarizeCashflow} from '../src/cashflow.mjs';

// Fictional sources only. Activity evidence does not establish live access.
const activity=createSubscriptionActivityRuntime();
const asOf='2026-11-04T12:00:00Z';
const receipt=(id,extra={})=>({id,messageId:'message-'+id,serviceKey:'fictional',service:'Fictional Service',category:'Software',kind:'payment_succeeded',authenticated:true,
  receivedAt:'2026-07-01T12:00:00Z',payment:{currency:'USD',minor:12000},paymentDay:'2026-07-01',paymentDateBasis:'explicit',reference:'invoice-'+id,
  period:{start:'2026-07-01',end:'2027-07-01'},cadence:'annual',...extra});
const build=(events,month='2026-10',extra={})=>activity.build({events,month,asOf,...extra});

test('an annual period covers later months while the entire expense remains in its actual paid month',()=>{
  const events=[receipt('annual')],snapshot=projectEvidence(events,{asOf});
  const result=build(events);
  assert.equal(result.documentedCount,1);assert.equal(result.matches[0].classification,'documented_period');
  assert.equal(result.matches[0].liveAccessVerified,false);assert.ok(result.months.includes('2026-09'));assert.ok(result.months.includes('2026-10'));
  assert.deepEqual(summarizeCashflow(snapshot,{month:'2026-10'}).paidMinorByCurrency,{});
  assert.deepEqual(summarizeCashflow(snapshot,{month:'2026-07'}).paidMinorByCurrency,{USD:12000});
});

test('today renewal-off and likely-inactive states cannot hide an evidenced historical period',()=>{
  const paid=receipt('paid'),off=receipt('off',{kind:'renewal_disabled',payment:undefined,period:undefined,receivedAt:'2026-11-01T12:00:00Z',accessEnds:'2027-07-01'});
  for(const status of ['renewal_off','likely_canceled','not_subscribed']){
    const snapshot={subscriptions:status==='not_subscribed'?[]:[{serviceKey:'fictional',status,evidenceIds:[paid.id,off.id]}],excludedServices:status==='not_subscribed'?[{serviceKey:'fictional',status,evidenceIds:[paid.id,off.id]}]:[]};
    const row=build([paid,off],'2026-10',{snapshot}).matches[0];
    assert.equal(row.classification,'documented_period');assert.equal(row.currentStatus,status);assert.equal(row.intervals[0].end,'2027-07-01');
  }
});

test('explicit later expiry limits the recorded period without applying the notification date as the expiry',()=>{
  const paid=receipt('paid'),expired=receipt('expired',{kind:'access_expired',period:undefined,payment:undefined,receivedAt:'2026-11-03T12:00:00Z',accessEnds:'2026-10-15'});
  const october=build([paid,expired]);assert.equal(october.matches[0].classification,'documented_period');
  assert.equal(october.matches[0].intervals[0].end,'2026-10-15');assert.equal(october.matches[0].intervals[0].originalEnd,'2027-07-01');
  assert.deepEqual(october.matches[0].intervals[0].evidenceIds,['paid','expired']);
  const december=build([paid,expired],'2026-12');assert.equal(december.matches.length,0);assert.equal(december.unmatched[0].classification,'outside_period');
});

test('an undated expiry cannot manufacture an effective end, and a contradictory paid-through notice remains uncertain',()=>{
  const paid=receipt('paid'),expired=receipt('unknown-expiry',{kind:'access_expired',period:undefined,payment:undefined,receivedAt:'2026-11-03T12:00:00Z',accessEnds:null});
  assert.equal(build([paid,expired]).matches[0].intervals[0].end,'2027-07-01');
  const off={...expired,id:'off',kind:'renewal_disabled',accessEnds:'2026-10-15'};
  const row=build([paid,off]).matches[0];assert.equal(row.classification,'month_evidence');assert.ok(row.warnings.includes('conflicting_access_end'));
  assert.equal(row.intervals[0].end,'2027-07-01');
});

test('full and partial refund records neither erase past coverage nor invent a termination date',()=>{
  for(const minor of [12000,1000]){
    const refund=receipt('refund',{kind:'refund_recorded',payment:undefined,period:undefined,refund:{currency:'USD',minor},receivedAt:'2026-08-02T00:00:00Z'});
    const row=build([receipt('annual'),refund]).matches[0];
    assert.equal(row.intervals[0].end,'2027-07-01');assert.equal(row.classification,'documented_period');assert.ok(row.warnings.includes('refund_does_not_establish_access_end'));
  }
});

test('a late-delivered receipt supports an earlier service period independently of source-month evidence',()=>{
  const event=receipt('late',{receivedAt:'2026-11-03T00:00:00Z',paymentDay:null,paymentDateBasis:'unknown',payment:{minor:2000,currency:null},period:{start:'2026-10-08',end:'2026-11-08'}});
  const row=build([event]).matches[0];assert.equal(row.classification,'documented_period');assert.deepEqual(row.messageIds,['message-late']);
  assert.deepEqual(summarizeCashflow(projectEvidence([event],{asOf}),{month:'2026-10'}).paidMinorByCurrency,{});
});

test('late delivery cannot create activity in a month outside its recorded service period',()=>{
  const event=receipt('late-past',{receivedAt:'2026-11-03T00:00:00Z',period:{start:'2026-09-01',end:'2026-10-01'}});
  const result=build([event],'2026-11');assert.equal(result.matches.length,0);assert.equal(result.unmatched[0].classification,'outside_period');
});

test('a stale expiry before a newer period cannot remove that period; a lone exact past expiry does not create permanent unknown activity',()=>{
  const expired=receipt('past-expiry',{kind:'access_expired',period:undefined,payment:undefined,receivedAt:'2026-11-03T00:00:00Z',accessEnds:'2026-09-30'});
  const renewed=receipt('renewed',{receivedAt:'2026-10-01T00:00:00Z',paymentDay:'2026-10-01',period:{start:'2026-10-01',end:'2026-11-01'}});
  assert.equal(build([renewed,expired]).matches[0].classification,'documented_period');
  assert.equal(build([expired]).matches.length,0);assert.equal(build([expired],'2026-09').matches[0].classification,'period_unknown');
});

test('invoice-only periods are candidates and never confirm paid access',()=>{
  const event=receipt('invoice',{kind:'invoice_recorded',payment:undefined,invoiceAmount:{currency:'USD',minor:12000},sourceRequiresDocumentReview:true});
  const result=build([event]);assert.equal(result.documentedCount,0);assert.equal(result.candidateCount,1);
  assert.equal(result.matches[0].intervals[0].classification,'possible_period');assert.ok(result.matches[0].warnings.includes('invoice_does_not_confirm_access'));
  assert.ok(result.matches[0].warnings.includes('document_review'));
});

test('annual unknown starts do not become end-minus-one-year periods, and empty months remain unknown',()=>{
  const event=receipt('unknown',{period:undefined,accessEnds:'2027-07-01'});
  const row=build([event]).matches[0];assert.equal(row.classification,'period_unknown');assert.deepEqual(row.intervals,[]);
  assert.equal(build([event],'2026-07').matches[0].classification,'month_evidence');
});

test('known non-overlapping periods stay outside, gaps are not filled, and missing episodes remain candidates',()=>{
  const early=receipt('early',{period:{start:'2026-07-01',end:'2026-08-01'}});
  const late=receipt('late',{receivedAt:'2026-11-04T00:00:00Z',period:{start:'2026-11-04',end:'2026-12-04'}});
  const gap=build([early,late]);assert.equal(gap.matches.length,0);assert.equal(gap.unmatched.length,1);
  const unknown=receipt('unknown',{period:undefined,receivedAt:'2026-09-15T00:00:00Z'});
  assert.equal(build([early,unknown]).matches[0].classification,'period_unknown');
});

test('an ambiguous service-end boundary is a candidate rather than an assumed inclusive day',()=>{
  const event=receipt('boundary',{period:{start:'2026-09-01',end:'2026-10-01'}});
  const row=build([event]).matches[0];assert.equal(row.classification,'month_evidence');assert.ok(row.warnings.includes('end_day_boundary_uncertain'));
  assert.equal(build([event],'2026-08').matches.length,0);
});

test('trusted held or contradictory evidence cannot establish a documented period',()=>{
  const paid=receipt('held',{candidateStatus:'needs_review'});assert.equal(build([paid]).documentedCount,0);
  const original=receipt('a'),conflicting=receipt('b',{reference:original.reference,period:{start:'2026-08-01',end:'2027-08-01'}});
  const result=build([original,conflicting]);assert.equal(result.documentedCount,0);assert.ok(result.matches[0].warnings.includes('conflicting_service_periods'));
  assert.equal(build([receipt('untrusted',{authenticated:false})]).matches.length,0);
  assert.equal(build([receipt('boolean',{authenticated:'true'})]).matches.length,0);
  const duplicate=receipt('duplicate');assert.equal(build([duplicate,{...duplicate,period:{start:'2026-08-01',end:'2027-08-01'}}]).documentedCount,0);
  const snapshot={payments:[{...original,conflict:true,duplicateEvidenceIds:['b']}]};assert.equal(build([original,conflicting],'2026-10',{snapshot}).documentedCount,0);
});

test('canonical snapshot identities and explicit account scopes remain stable without splitting invoices into plans',()=>{
  const a=receipt('a',{accountRef:'fictional account A'}),b=receipt('b',{accountRef:'fictional account B'});
  const rows=build([a,b]).matches;assert.equal(rows.length,2);assert.equal(rows[0].serviceKey,'fictional|account:fictional%20account%20A');
  assert.equal(build([receipt('one'),receipt('two')]).matches.length,1);
  const reviewed=build([a],null,{snapshot:{subscriptions:[{serviceKey:'existing-reviewed-key',status:'renewal_off',evidenceIds:['a']} ]}}).matches[0];
  assert.equal(reviewed.serviceKey,'existing-reviewed-key');assert.equal(reviewed.currentStatus,'renewal_off');
});

test('donations, one-time purchases, and standalone future credit do not become subscriptions',()=>{
  for(const event of [receipt('donation',{category:'Donations'}),receipt('one-off',{kind:'one_time_purchase'}),receipt('credit',{kind:'renewal_notice',sourceFact:'future_credit',period:undefined})])assert.equal(build([event]).matches.length,0);
  const education=receipt('education',{kind:'access_expiring',period:undefined,payment:undefined,accessType:'education'});
  const row=build([education]).matches[0];assert.equal(row.accessType,'education');assert.ok(row.warnings.includes('education_access'));
  const trial=receipt('trial',{kind:'trial_confirmed',payment:undefined});assert.ok(build([trial]).matches[0].warnings.includes('trial_not_confirmed_paid'));
});

test('source-month grouping respects the requested IANA zone while provider date-only periods stay literal',()=>{
  const event=receipt('boundary-mail',{period:undefined,receivedAt:'2026-09-30T19:00:00Z'});
  assert.equal(build([event],'2026-10',{timeZone:'Asia/Taipei'}).matches[0].classification,'month_evidence');
  assert.equal(build([event],'2026-10',{timeZone:'UTC'}).matches[0].classification,'period_unknown');
  const period=receipt('literal',{period:{start:'2026-10-01',end:'2026-11-01'}});
  for(const timeZone of ['UTC','America/Los_Angeles','Asia/Taipei'])assert.equal(build([period],'2026-10',{timeZone}).matches[0].intervals[0].start,'2026-10-01');
});

test('long intervals are evaluated directly while calendar options are bounded and inputs remain unchanged',()=>{
  const event=receipt('long',{period:{start:'2000-01-01',end:'2099-12-31'}}),before=JSON.stringify(event);
  const result=build([event]);assert.equal(result.matches[0].classification,'documented_period');assert.equal(result.months.length,120);assert.equal(result.monthsLimited,true);
  assert.equal(JSON.stringify(event),before);assert.throws(()=>build([event],'2026-13'),/calendar month/);assert.throws(()=>build([event],'2026-10',{timeZone:'Invalid\/Zone'}),RangeError);
});
