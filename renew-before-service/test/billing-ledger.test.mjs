import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectBillingRecords} from '../src/billing-ledger.mjs';
import {createLedgerContracts} from '../src/ledger-contracts.mjs';
import {parseDay} from '../src/evidence.mjs';
const event=(id,extra={})=>({id,messageId:id,serviceKey:'example',service:'Example',kind:'payment_succeeded',payment:{currency:'USD',minor:2000},paymentDay:'2026-10-01',paymentDateBasis:'explicit',receivedAt:'2026-11-08T00:00:00Z',evidence:'Amount paid USD 20.00',fieldEvidence:{payment:{excerpt:'Amount paid USD 20.00'},paymentDay:{excerpt:'October 1, 2026'}},...extra});
test('receipt rows retain separate renewals and refunds, while invoices and service notices stay separate',()=>{
 const state={events:[event('renewal-b',{paymentDay:'2026-11-01'}),event('notice',{kind:'renewal_disabled'}),event('invoice',{kind:'invoice_recorded',invoiceAmount:{currency:'USD',minor:2000},invoiceDay:'2026-09-30'}),event('renewal-a'),event('refund',{kind:'refund_recorded',refund:{currency:'USD',minor:500},refundDay:'2026-11-02',refundDateBasis:'explicit'})]};
 assert.deepEqual(projectBillingRecords(state).map(r=>r.eventId),['renewal-a','renewal-b','refund']);
 assert.deepEqual(projectBillingRecords(state,{view:'invoices'}).map(r=>r.eventId),['invoice']);
});
test('a missing paid date never becomes email arrival, invoice date or next renewal',()=>{
 const r=projectBillingRecords({events:[event('missing',{paymentDay:undefined,invoiceDay:'2026-10-02',nextBilling:'2026-12-01'})]})[0];assert.equal(r.date,null);assert.equal(r.paymentMonth,null);
 assert.equal(projectBillingRecords({events:[event('unsubstantiated',{paymentDateBasis:'unknown'})]})[0].date,null);
});
test('unknown currencies use the exact retained amount token and never guess an ISO code or exponent',()=>{
 const r=projectBillingRecords({events:[event('unknown',{payment:{currency:null,minor:123456},fieldEvidence:{payment:{excerpt:'Amount paid · $1,234.56'}}})]})[0];assert.equal(r.sourceAmountText,'$1,234.56');assert.equal(r.amount.currency,null);
 const multiple=projectBillingRecords({events:[event('ambiguous',{payment:{currency:null,minor:1000},fieldEvidence:{payment:{excerpt:'$10.00 or $20.00'}}})]})[0];assert.equal(multiple.sourceAmountText,null);
});
test('active user-confirmed invoices appear as payments using the protected amount and date',()=>{
 const source=event('invoice',{kind:'invoice_recorded',invoiceAmount:{currency:'USD',minor:9900},invoiceDay:'2026-10-01'}),state={events:[source],paymentConfirmations:{invoice:{active:true,precision:'day',date:'2026-10-04',amount:{currency:'EUR',minor:1800}}}};
 const before=JSON.stringify(state),r=projectBillingRecords(state)[0];assert.equal(r.confirmed,true);assert.equal(r.sourceKind,'invoice_recorded');assert.equal(r.kind,'payment_succeeded');assert.equal(r.date,'2026-10-04');assert.deepEqual(r.amount,{currency:'EUR',minor:1800});assert.equal(projectBillingRecords(state,{view:'invoices'}).length,0);assert.equal(JSON.stringify(state),before);
});
test('month-only confirmations remain month-only, and revoked confirmations do not establish paid invoices',()=>{
 const state={events:[event('invoice',{kind:'invoice_recorded'})],paymentConfirmations:{invoice:{active:true,precision:'month',month:'2026-09',amount:{currency:'USD',minor:1200}}}};
 const r=projectBillingRecords(state,{month:'2026-09'})[0];assert.equal(r.date,null);assert.equal(r.paymentMonth,'2026-09');state.paymentConfirmations.invoice.active=false;assert.equal(projectBillingRecords(state).length,0);assert.equal(projectBillingRecords(state,{view:'invoices'}).length,1);
});
test('payment dates drive monthly filtering and matching amounts do not merge different accounts',()=>{
 const state={events:[event('account-a',{accountRef:'A'}),event('account-b',{accountRef:'B'}),event('later',{paymentDay:'2026-11-01'})]};const rows=projectBillingRecords(state,{month:'2026-10'});assert.equal(rows.length,2);assert.notEqual(rows[0].serviceKey,rows[1].serviceKey);assert.notEqual(rows[0].eventId,rows[1].eventId);
});
test('missing evidence stays explicitly incomplete, without changing saved records or confirmation authority',()=>{
 const state={events:[event('empty',{payment:null,evidence:'',fieldEvidence:{}})]},before=JSON.stringify(state),r=projectBillingRecords(state)[0];assert.equal(r.amount,null);assert.equal(r.sourceDetailsIncomplete,true);assert.equal(r.verification,'needs_review');assert.equal(r.confirmed,false);assert.equal(JSON.stringify(state),before);
});
test('new invoice evidence can be reviewed without replacing a blank original or establishing payment',()=>{
 const old=event('invoice',{kind:'invoice_recorded',invoiceAmount:null}),candidate={...old,invoiceAmount:{currency:'TWD',minor:699000},reference:'SYNTHETIC-REF',plan:'Synthetic Pro',evidence:'TWD 6,990',fieldEvidence:{invoiceAmount:{excerpt:'TWD 6,990'}}};
 const state={events:[old],assistantReview:[{candidate,existingEventIds:[old.id],reason:'source_facts_conflict'}]},before=JSON.stringify(state),r=projectBillingRecords(state,{view:'invoices'})[0];
 assert.deepEqual(r.amount,candidate.invoiceAmount);assert.equal(r.alternativeEvidence,true);assert.equal(r.confirmed,false);assert.equal(projectBillingRecords(state).length,0);assert.equal(JSON.stringify(state),before);
 state.assistantReview.push({candidate:{...candidate,invoiceAmount:{currency:'TWD',minor:100}},existingEventIds:[old.id]});const ambiguous=projectBillingRecords(state,{view:'invoices'})[0];assert.equal(ambiguous.amount,null);assert.equal(ambiguous.conflictingAlternatives,true);
});
test('ambiguous source dates remain visible as raw evidence while the canonical invoice date stays unknown',()=>{
 const quote=createLedgerContracts().billingExcerpt('Invoice date: 01/11/26');assert.ok(quote.includes('01/11/26'));assert.equal(parseDay('01/11/26'),null);
 const original=event('invoice',{kind:'invoice_recorded',invoiceAmount:null,invoiceDay:null}),candidate={...original,invoiceAmount:{currency:'TWD',minor:100},fieldEvidence:{invoiceAmount:{excerpt:'TWD 1'},invoiceDay:{excerpt:quote}}};
 const r=projectBillingRecords({events:[original],assistantReview:[{candidate,existingEventIds:['invoice']}]},{view:'invoices'})[0];assert.equal(r.date,null);assert.equal(r.rawDateText,'01/11/26');assert.equal(r.paymentMonth,null);
});
test('alternative invoice proposals never alter an active user-confirmed amount, date or verification',()=>{
 const original=event('invoice',{kind:'invoice_recorded',invoiceAmount:null}),state={events:[original],paymentConfirmations:{invoice:{active:true,precision:'day',date:'2026-10-09',amount:{currency:'USD',minor:1000}}},assistantReview:[{existingEventIds:['invoice'],candidate:{...original,invoiceAmount:{currency:'TWD',minor:99999}}}]};
 const r=projectBillingRecords(state)[0];assert.deepEqual(r.amount,{currency:'USD',minor:1000});assert.equal(r.date,'2026-10-09');assert.equal(r.confirmed,true);assert.equal(r.alternativeEvidence,false);
});
test('unknown date values retain exact source excerpts without accepting fabricated quotes or interpreting ambiguous dates',()=>{
 const observation={messageId:'null-date',receivedAt:'2026-11-01T00:00:00Z',observedAt:'2026-11-08T00:00:00Z',text:'Example invoice\nInvoice date: 01/11/26'};
 const candidate={schemaVersion:1,messageId:'null-date',serviceKey:'example',service:'Example',kind:'invoice_recorded',invoiceDay:null,fieldEvidence:{serviceKey:{quote:'Example invoice'},service:{quote:'Example invoice'},kind:{quote:'Example invoice'},invoiceDay:{quote:'Invoice date: 01/11/26'}}};
 const contracts=createLedgerContracts(),row=contracts.validateCandidate(candidate,{observation});assert.equal(row.invoiceDay,null);assert.ok(row.fieldEvidence.invoiceDay.excerpt.includes('01/11/26'));assert.equal(row.userVerified,false);
 candidate.fieldEvidence.invoiceDay.quote='Invoice date: 2026-01-11';assert.throws(()=>contracts.validateCandidate(candidate,{observation}));
});
