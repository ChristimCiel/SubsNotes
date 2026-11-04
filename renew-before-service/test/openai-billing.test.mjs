import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {extractEvidence,projectEvidence} from '../src/evidence.mjs';
import {extractWebEvidence} from '../src/web-evidence.mjs';
import {createCashflowRuntime} from '../src/cashflow.mjs';
import {createSourceEvidenceMerger} from '../src/web-sync.mjs';
import {preserveReceiptVerification} from '../src/receipt-verification.mjs';
import {createLedgerContracts} from '../src/ledger-contracts.mjs';

// Entirely fictional identities, references, dates and amounts.
const asOf='2026-12-01T00:00:00Z';
const hash=x=>createHash('sha256').update(x).digest('hex');
const cash=createCashflowRuntime();
const source=n=>({id:'synthetic-openai-tax-'+n,sender:'noreply@tax.openai.com',subject:'Your eGUI FICTIONAL'+n+' from OpenAI',text:'An invoice has been prepared for your purchase. Review the original invoice document.',receivedAt:`2026-${String(n+1).padStart(2,'0')}-12T01:00:00Z`,sourceFormat:'claude_plaintext',sourceReadAt:asOf});
const reviewed=n=>({...extractEvidence(source(n))[0],kind:'invoice_recorded',serviceKey:'chatgpt',service:'ChatGPT',category:'AI tools',invoiceAmount:{currency:'EUR',minor:1700+n},invoiceDay:source(n).receivedAt.slice(0,10),reference:'FICTIONAL-INVOICE-'+n,payment:null,paymentDay:null,paymentDateBasis:'unknown',receiptVerification:{checkedAt:asOf,fields:['kind','serviceKey','service','category','invoiceAmount','invoiceDay','reference','payment','paymentDay','paymentDateBasis']}});
const payment=(extra={})=>({id:'synthetic-explicit-receipt',messageId:'synthetic-paid-mail',kind:'payment_succeeded',serviceKey:'chatgpt',service:'ChatGPT',category:'AI tools',authenticated:true,receivedAt:'2026-09-03T00:00:00Z',payment:{currency:'EUR',minor:1700},paymentDay:'2026-08-31',paymentDateBasis:'explicit',reference:'FICTIONAL-INVOICE-0',...extra});
const summarize=(events,month=null)=>cash.summarize(projectEvidence(events,{asOf,trustConnectorReads:true}),{trustConnectorReads:true,month});

test('ten document-reviewed ChatGPT invoices remain visible without manufacturing payments',()=>{
 const events=Array.from({length:10},(_,i)=>reviewed(i));
 const snapshot=projectEvidence(events,{asOf,trustConnectorReads:true}),result=cash.summarize(snapshot,{trustConnectorReads:true});
 assert.equal(snapshot.subscriptions.length,1);assert.equal(snapshot.invoices.length,10);assert.equal(result.pendingInvoices.length,10);
 assert.equal(result.included.length,0);assert.deepEqual(result.paidMinorByCurrency,{});
 assert.ok(result.pendingInvoices.every(e=>e.reviewReason==='payment_unverified'&&e.cashflowType==='unverified_invoice'));
});

test('two actual parser rereads preserve every reviewed invoice and its payment-unknown state',async()=>{
 const originals=Array.from({length:10},(_,i)=>reviewed(i)),events=new Map(originals.map(e=>[e.id,structuredClone(e)]));
 const merge=createSourceEvidenceMerger({preserveReceiptVerification,billingExcerpt:createLedgerContracts().billingExcerpt,hash});
 for(let round=0;round<2;round++)for(let i=0;i<10;i++){
  const message=source(i),parsed=await extractWebEvidence(message);
  merge.merge({events,message,parsed,parserVersion:'5'});
 }
 assert.equal(events.size,10);
 for(const old of originals)for(const field of old.receiptVerification.fields)assert.deepEqual(events.get(old.id)[field],old[field]);
 const result=summarize([...events.values()]);assert.equal(result.pendingInvoices.length,10);assert.equal(result.included.length,0);
});

test('new tax-only mail enters source review and cannot be mistaken for an API or ChatGPT payment',()=>{
 const events=extractEvidence(source(0)),snapshot=projectEvidence(events,{trustConnectorReads:true,asOf});
 assert.equal(events[0].sourceRequiresDocumentReview,true);assert.equal(snapshot.unclassifiedPurchases.length,1);
 assert.equal(snapshot.payments.length,0);assert.equal(events[0].providerKey,'openai');
 assert.equal(cash.summarize(snapshot,{trustConnectorReads:true}).pendingInvoices.length,1);
});

test('an explicit OpenAI receipt is counted on its paid day and matched once to its invoice',()=>{
 const inv={...reviewed(0),authenticated:true,invoiceDay:'2026-07-30'};
 const raw={id:'synthetic-openai-receipt',sender:'billing@openai.com',authenticatedSenderDomain:'openai.com',subject:'Your ChatGPT subscription receipt',receivedAt:'2026-09-03T00:00:00Z',text:'ChatGPT Pro Subscription. Amount paid EUR 17.00. Paid August 31, 2026. Invoice number FICTIONAL-INVOICE-0.'};
 const events=extractEvidence(raw);assert.equal(events[0].kind,'payment_succeeded');assert.equal(events[0].paymentDay,'2026-08-31');
 const august=summarize([inv,...events,...events],'2026-08');
 assert.deepEqual(august.paidMinorByCurrency,{EUR:1700});assert.equal(august.included.length,1);assert.equal(august.pendingInvoices.length,0);
 assert.deepEqual(summarize([inv,...events],'2026-09').paidMinorByCurrency,{});
 assert.equal(summarize([inv,...events],'2026-07').pendingInvoices.length,0);
});

test('invoice delivery, invoice date and a successful subscription order do not invent a payment date',()=>{
 const order=extractEvidence({id:'synthetic-plan-order',sender:'noreply@tm.openai.com',authenticatedSenderDomain:'tm.openai.com',subject:'ChatGPT - 你的新方案',receivedAt:'2026-05-01T00:00:00Z',text:'你已成功訂閱 ChatGPT Plus。總計：NT$799.00。訂購日期：Apr 30, 2026。你的訂閱方案將自動續訂：monthly.'});
 const result=summarize([reviewed(0),...order]);assert.equal(result.pendingInvoices.length,1);assert.equal(result.included.length,0);
});

test('matching requires source or invoice identity and compatible account, line, amount and currency',()=>{
 const inv={...reviewed(0),authenticated:true};
 for(const patch of [{reference:'OTHER'},{accountRef:'other-account'},{lineItemRef:'other-line'},{payment:{currency:'USD',minor:1700}},{payment:{currency:'EUR',minor:2300}},{transactionRef:'other-txn'}]){
  const scopedInvoice=patch.transactionRef?{...inv,transactionRef:'invoice-txn'}:inv;
  assert.equal(summarize([scopedInvoice,payment(patch)]).pendingInvoices.length,1);
 }
 assert.equal(summarize([inv,payment({reference:'OTHER',messageId:inv.messageId})]).pendingInvoices.length,1);
});

test('paid wording without a payment date does not clear an invoice from review',()=>{
 const result=summarize([reviewed(0),payment({paymentDay:null,paymentDateBasis:'unknown'})]);
 assert.equal(result.included.length,0);assert.equal(result.pendingInvoices.length,1);
});

test('duplicate invoice copies collapse but conflicting totals remain held for review',()=>{
 const invoice={...reviewed(0),authenticated:true};
 const copy={...invoice,id:'synthetic-copy',messageId:'synthetic-copy-mail'};
 assert.equal(summarize([invoice,copy]).pendingInvoices.length,1);
 const result=summarize([invoice,{...copy,invoiceAmount:{currency:'EUR',minor:9000}},payment()]);
 assert.equal(result.pendingInvoices.length,1);assert.equal(result.pendingInvoices[0].reviewReason,'conflicting_amount');
});
