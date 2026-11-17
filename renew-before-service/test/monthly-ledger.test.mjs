import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {projectPaymentHistory,projectServiceActivity} from '../src/payment-history.mjs';
import {billingDay} from '../src/billing-calendar.mjs';import {createAgentRuntime} from '../src/agent-runtime.mjs';import {createEvidenceRuntime} from '../src/evidence-runtime.mjs';import {summarizeCashflow} from '../src/cashflow.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex'),clock=()=> '2026-11-08T09:00:00Z';
const event=(id,extra={})=>({id,messageId:id,serviceKey:'example',service:'Example',category:'Software',kind:'payment_succeeded',authenticated:true,payment:{currency:'USD',minor:2000},paymentDay:'2026-11-01',paymentDateBasis:'explicit',receivedAt:'2026-11-02T00:00:00Z',sourceFormat:'connector_plaintext',sourceReadAt:clock(),evidence:'Original receipt',...extra});
function fixture(events,paymentConfirmations={}){const state={version:1,storageRevision:'test-revision',events,paymentConfirmations,prefs:{}};return {state,api:createAgentRuntime({store:{load:async()=>structuredClone(state),save:async()=>{throw Error('read-only test');}},requestStorage:{read:async()=>null,write:async()=>{throw Error('read-only test');}},ownerBinding:'a'.repeat(64),hash,clock})};}

test('monthly services, payments, evidence and paginated results share actual payment month, not receipt arrival',async()=>{
 const f=fixture([event('a',{serviceKey:'annual',service:'Annual',paymentDay:'2026-10-31',cadence:'annual',payment:{currency:'USD',minor:12000}}),event('b'),event('c',{serviceKey:'other',service:'Other',paymentDay:'2025-11-01'})]);
 const d=await f.api.dashboard({month:'2026-11'});assert.deepEqual(d.spending.recordedPaidMinorByCurrency,{USD:2000});assert.deepEqual(d.services.items.map(x=>x.serviceKey),['example']);assert.deepEqual(d.paymentHistory.items.map(x=>x.eventId),['b']);
 assert.equal((await f.api.listSubscriptions({month:'2026-11',limit:1})).total,1);assert.equal((await f.api.evidence({serviceKey:'annual',month:'2026-11'})).total,0);
 assert.deepEqual((await f.api.dashboard({month:'2026-10'})).spending.recordedPaidMinorByCurrency,{USD:12000});assert.equal((await f.api.dashboard()).services.total,3);
});
test('one payment with an earlier invoice stays one payment in payment month with both source documents',()=>{
 const state={events:[event('receipt',{reference:'ONE',paymentDay:'2026-11-02'}),event('invoice',{kind:'invoice_recorded',invoiceAmount:{currency:'USD',minor:2000},invoiceDay:'2026-10-31',reference:'ONE'})]};const before=JSON.stringify(state);
 const rows=projectPaymentHistory(state,{month:'2026-11'});assert.equal(rows.length,1);assert.equal(rows[0].documents.length,2);assert.equal(rows[0].dateRole,'payment_date');assert.equal(projectPaymentHistory(state,{month:'2026-10'}).length,0);assert.equal(JSON.stringify(state),before);
});
test('shared transaction ID links rounded tax invoice without replacing the actual paid amount',()=>{
 const state={events:[event('paid',{transactionRef:'tx-a',reference:'MERCHANT',payment:{currency:'TWD',minor:123450}}),event('invoice',{kind:'invoice_recorded',transactionRef:'tx-a',reference:'TAX',invoiceAmount:{currency:'TWD',minor:123500},invoiceDay:'2026-11-01'})]};const r=projectPaymentHistory(state)[0];assert.equal(r.documents.length,2);assert.equal(r.amount.minor,123450);assert.equal(r.documents[1].amountDifferenceMinor,50);
 const snapshot=createEvidenceRuntime(hash).projectEvidence(state.events,{asOf:clock(),trustConnectorReads:true});assert.equal(summarizeCashflow(snapshot).pendingInvoices.length,1,'a differing invoice total remains unverified even when its supporting payment is linked');
});
test('unpaid invoices, unknown dates and failed payments cannot become confirmed monthly services or totals',async()=>{
 const f=fixture([event('invoice',{kind:'invoice_recorded',serviceKey:'invoice-only',invoiceAmount:{currency:'TWD',minor:10000},invoiceDay:'2026-11-01'}),event('unknown',{serviceKey:'unknown-date',paymentDay:null}),event('failure',{serviceKey:'failed',kind:'payment_failed',nextCharge:{currency:'USD',minor:2000}})]);
 const d=await f.api.dashboard({month:'2026-11'});assert.deepEqual(d.spending.recordedPaidMinorByCurrency,{});assert.equal(d.services.total,0);assert.equal(d.paymentHistory.total,1);assert.equal(d.paymentHistory.items[0].status,'payment_unverified');assert.equal(d.unassignedRecordCount,1);
 assert.equal(d.paymentHistory.items[0].paymentMonth,null);assert.equal(d.paymentHistory.items[0].documentMonth,'2026-11');assert.equal(d.paymentHistory.items[0].verificationAssessment.document.status,'verified');assert.equal(d.paymentHistory.items[0].verificationAssessment.payment.status,'unverified');
 assert.ok((await f.api.listSubscriptions()).items.some(s=>s.serviceKey==='invoice-only'),'the retained all-history catalog does not disappear with the monthly paid-service filter');
});
test('cancellation does not remove historical payments and missing renewals do not establish cancellation',()=>{
 const p=event('paid',{period:{start:'2026-11-01',end:'2026-12-01'}}),cancel=event('cancel',{kind:'renewal_disabled',receivedAt:'2026-11-03T00:00:00Z',accessEnds:'2026-12-01'}),reminder=event('remind',{kind:'renewal_notice',serviceKey:'missing',nextBilling:'2026-10-01'});
 const state={events:[p,cancel,reminder]},a=projectServiceActivity(state,{asOf:clock()});assert.equal(a.statuses.get('example').statusCode,'confirmed_canceled');assert.equal(a.statuses.get('missing').statusCode,'unverified');assert.equal(a.notices[0].resolution,'past_due_unverified');assert.equal(a.notices[0].outstanding,false);assert.equal(projectPaymentHistory(state,{month:'2026-11'}).filter(r=>r.countsAsPayment).length,1);
});
test('renewal reminders resolve by payment identity/date and never by equal amount across different plans/accounts',()=>{
 const reminder=event('r',{kind:'renewal_notice',plan:'Pro',nextBilling:'2026-11-01',accountRef:'A'}),p=event('p',{plan:'Pro',accountRef:'A'}),state={events:[reminder,p]};assert.equal(projectServiceActivity(state,{asOf:clock()}).notices[0].resolution,'resolved_payment');
 for(const extra of [{accountRef:'B'},{plan:'Other'},{paymentDay:'2026-10-01'}]){const s={events:[reminder,{...p,...extra}]};assert.equal(projectServiceActivity(s,{asOf:clock()}).notices[0].resolution,'past_due_unverified');}
});
test('different accounts, products and explicit line items cannot be merged despite same amounts',async()=>{
 const f=fixture([event('a',{accountRef:'A',reference:'SAME'}),event('b',{accountRef:'B',reference:'SAME'}),event('c',{serviceKey:'other-product',reference:'SAME'}),event('i',{kind:'invoice_recorded',accountRef:'C',reference:'SAME',invoiceAmount:{currency:'USD',minor:2000},invoiceDay:'2026-11-01'})]);const rows=projectPaymentHistory(f.state);assert.equal(rows.length,4);assert.ok(rows.every(r=>r.documents.length===1));const d=await f.api.dashboard({month:'2026-11'});assert.equal(d.services.total,3);assert.deepEqual(d.spending.recordedPaidMinorByCurrency,{USD:6000});
});
test('billing dates preserve civil source dates and explicit instants use Asia/Taipei near month boundaries',()=>{
 assert.equal(billingDay('2026-10-31'),'2026-10-31');assert.equal(billingDay('2026-10-31T16:00:00Z'),'2026-11-01');assert.equal(billingDay('2026-11-01T00:00:00+08:00'),'2026-11-01');assert.equal(billingDay('2026-10-31T15:59:59Z'),'2026-10-31');assert.equal(billingDay('2026-11-01T00:00:00'),null);assert.equal(billingDay('2026-02-30'),null);
});
test('ambiguous November-looking invoice stays unassigned; no payment is invented from the email month',async()=>{
 const f=fixture([event('invoice',{kind:'invoice_recorded',serviceKey:'example-ai',service:'Example AI',invoiceAmount:{currency:'TWD',minor:99900},invoiceDay:null,fieldEvidence:{invoiceDay:{excerpt:'Invoice date: 01/11/26'},invoiceAmount:{excerpt:'TWD 999'}}})]);const d=await f.api.dashboard({month:'2026-11'});assert.equal(d.paymentHistory.total,0);assert.equal(d.services.total,0);assert.deepEqual(d.spending.recordedPaidMinorByCurrency,{});assert.equal(d.unassignedRecordCount,1);assert.equal((await f.api.billingRecords({view:'history'})).items[0].rawDateText,'01/11/26');
});
test('protected month-only confirmation keeps its amount, currency and chosen month',async()=>{
 const p=event('invoice',{kind:'invoice_recorded',invoiceAmount:{currency:'USD',minor:9900},invoiceDay:'2026-10-01'});const {createPaymentConfirmationRuntime}=await import('../src/payment-confirmations.mjs');const initial={version:1,events:[p]},confirmed=createPaymentConfirmationRuntime().set(initial,{eventId:p.id,precision:'month',month:'2026-11',amount:{currency:'EUR',minor:1800},expectedRevision:0},{now:clock()});const f=fixture(confirmed.events,confirmed.paymentConfirmations),before=JSON.stringify(f.state);const d=await f.api.dashboard({month:'2026-11'});assert.deepEqual(d.spending.recordedPaidMinorByCurrency,{EUR:1800});assert.equal(d.services.total,1);assert.equal(d.paymentHistory.items[0].date,null);assert.equal(d.paymentHistory.items[0].paymentMonth,'2026-11');assert.equal(JSON.stringify(f.state),before);
});
test('transaction detail includes linked original invoice but excludes unrelated months and products',async()=>{
 const f=fixture([event('paid',{reference:'ONE'}),event('invoice',{reference:'ONE',kind:'invoice_recorded',invoiceAmount:{currency:'USD',minor:2000},invoiceDay:'2026-10-01'}),event('old',{paymentDay:'2026-08-01'}),event('other',{serviceKey:'other'})]);const d=await f.api.evidence({serviceKey:'example',eventId:'paid',month:'2026-11'});assert.deepEqual(new Set(d.items.map(x=>x.id)),new Set(['paid','invoice']));assert.equal((await f.api.evidence({serviceKey:'example',eventId:'old',month:'2026-11'})).total,0);
});
test('cashflow excludes undated records from month-specific exclusions and pending invoices',()=>{
 const snapshot={payments:[event('undated',{paymentDay:null})],invoices:[event('old',{kind:'invoice_recorded',invoiceDay:'2026-10-01'}),event('unknown',{kind:'invoice_recorded',invoiceDay:null})]};const d=summarizeCashflow(snapshot,{month:'2026-11'});assert.equal(d.excluded.length,0);assert.equal(d.pendingInvoices.length,0);assert.equal(d.unallocatedCount,1);
});
test('duplicate receipt emails share one financial entry while their original documents stay accessible',async()=>{
 const f=fixture([event('first',{reference:'EXACT-INVOICE'}),event('copy',{reference:'EXACT-INVOICE',receivedAt:'2026-11-03T00:00:00Z'})]);const d=await f.api.dashboard({month:'2026-11'});assert.equal(d.paymentHistory.total,1);assert.equal(d.paymentHistory.items[0].documents.length,2);assert.deepEqual(d.spending.recordedPaidMinorByCurrency,{USD:2000});assert.equal(f.state.events.length,2);
});
test('explicit expiry and a failed payment remain distinct from missing evidence',()=>{
 const state={events:[event('expired',{serviceKey:'expired',kind:'access_expired',accessEnds:'2026-10-01'}),event('failed',{serviceKey:'failed',kind:'payment_failed'}),event('reminder',{serviceKey:'unknown',kind:'renewal_notice',nextBilling:'2026-09-01'})]};const a=projectServiceActivity(state,{asOf:clock()});assert.equal(a.statuses.get('expired').statusCode,'expired');assert.equal(a.statuses.get('failed').statusCode,'payment_issue');assert.equal(a.statuses.get('unknown').statusCode,'unverified');
});
test('serialized cashflow factory retains monthly invoice filtering without module-only helpers',async()=>{
 const {createCashflowRuntime}=await import('../src/cashflow.mjs'),{createPaymentConfirmationRuntime}=await import('../src/payment-confirmations.mjs');
 const embedded=new Function('createPaymentConfirmationRuntime','return ('+createCashflowRuntime.toString()+')()')(createPaymentConfirmationRuntime);
 const r=embedded.summarize({invoices:[event('invoice',{kind:'invoice_recorded',invoiceDay:'2026-10-01'})]},{month:'2026-11'});assert.equal(r.pendingInvoices.length,0);
});
test('the actual dashboard date formatter preserves month-only confirmation precision',async()=>{
 const {readFile}=await import('node:fs/promises');const html=await readFile(new URL('../src/agent-dashboard.html',import.meta.url),'utf8');const source=html.slice(html.indexOf('function day(value)'),html.indexOf('  function money('));const format=new Function('locale','text',source+';return day;')(()=> 'en-US',()=> 'unknown');assert.equal(format('2026-11'),'Nov 2026');assert.equal(format('2026-11-01'),'Nov 1, 2026');assert.equal(format('2026-10-31T16:00:00Z'),'Nov 1, 2026');
});
test('a later cancellation cannot resolve a renewal scheduled before that cancellation',()=>{
 const state={events:[event('reminder',{kind:'renewal_notice',nextBilling:'2026-09-01',receivedAt:'2026-08-25T00:00:00Z'}),event('cancel',{kind:'renewal_disabled',receivedAt:'2026-10-01T00:00:00Z'})]};const a=projectServiceActivity(state,{asOf:clock()});assert.equal(a.notices[0].resolution,'past_due_unverified');assert.equal(a.notices[0].resolvedBy,null);
});
test('a partial payment never certifies settlement of the whole invoice or inflates spending',()=>{
 const state={events:[event('payment',{transactionRef:'ONE',payment:{currency:'USD',minor:2000}}),event('invoice',{kind:'invoice_recorded',transactionRef:'ONE',invoiceAmount:{currency:'USD',minor:10000},invoiceDay:'2026-11-01'})]};const history=projectPaymentHistory(state);assert.equal(history.length,1);assert.equal(history[0].amount.minor,2000);assert.equal(history[0].documents[1].amountDifferenceMinor,8000);const snapshot=createEvidenceRuntime(hash).projectEvidence(state.events,{asOf:clock(),trustConnectorReads:true}),cash=summarizeCashflow(snapshot,{month:'2026-11'});assert.deepEqual(cash.paidMinorByCurrency,{USD:2000});assert.equal(cash.pendingInvoices.length,1);
});
