import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFileAgentAccess,importObservedSources} from '../src/agent-file-store.mjs';
import {extractEvidence} from '../src/evidence.mjs';
import {sourceVerification,projectBillingRecords} from '../src/billing-ledger.mjs';
import {preserveReceiptVerification} from '../src/receipt-verification.mjs';

const mailboxHash='a'.repeat(64),time='2026-11-08T00:00:00Z';
const message=(id='source-receipt')=>({id,mailboxHash,sender:'billing@suno.com',subject:'Your receipt from Suno',receivedAt:'2026-11-01T12:00:00Z',text:'Suno Pro subscription\nAmount paid USD 20.00\nPaid November 1, 2026',sourceFormat:'connector_plaintext',sourceReadAt:time,authenticatedSenderDomain:'suno.com'});
async function setup(){
 const directory=await mkdtemp(join(tmpdir(),'subsnotes-source-import-')),api=createFileAgentAccess({directory,allowProposals:true});
 const {request}=await api.invoke('prepareScan');
 const text='Suno subscription. Amount paid USD 20.00. Paid November 1, 2026.';
 const candidate={schemaVersion:1,messageId:'source-receipt',serviceKey:'suno',service:'Suno',category:'Software',kind:'payment_succeeded',payment:{currency:'USD',minor:2000},paymentDay:'2026-11-01',paymentDateBasis:'explicit',fieldEvidence:{}};
 for(const key of Object.keys(candidate))if(!['schemaVersion','messageId','fieldEvidence'].includes(key))candidate.fieldEvidence[key]={quote:text};
 await api.invoke('submitScanResult',{schemaVersion:1,kind:'subsnotes.assistant-scan-result',requestId:request.requestId,ledgerRevision:request.ledgerRevision,records:[{candidate,observation:{messageId:'source-receipt',receivedAt:'2026-11-01T12:00:00Z',observedAt:time,text}}],coverage:{queriesComplete:false,attachmentsComplete:false,mailboxExhaustive:false}});
 return {directory,api};
}
test('observed receipts enter source totals automatically, retain proposals, and replay without another payment',async()=>{
 const {directory,api}=await setup(),before=await api.invoke('dashboard');
 assert.deepEqual(before.spending.recordedPaidMinorByCurrency,{});
 const imported=await importObservedSources({directory,expectedRevision:before.ledgerRevision,mailboxHash,messages:[message()],extract:extractEvidence});
 assert.equal(imported.added,1);assert.equal(imported.originalRecordsPreserved,1);
 const after=await api.invoke('dashboard');assert.equal(after.counts.events,2);assert.deepEqual(after.spending.sourcePaidMinorByCurrency,{USD:2000});assert.equal(after.spending.userConfirmedCount,0);
 assert.equal(after.billingRecords.items.filter(r=>r.verification==='source_verified').length,1);
 assert.equal(after.billingRecords.items.length,1);
 const replay=await importObservedSources({directory,expectedRevision:after.ledgerRevision,mailboxHash,messages:[message()],extract:extractEvidence});assert.equal(replay.saved,false);assert.equal(replay.added,0);
 const reread=await importObservedSources({directory,expectedRevision:after.ledgerRevision,mailboxHash,messages:[{...message(),sourceReadAt:'2026-11-08T01:00:00Z'}],extract:extractEvidence});assert.equal(reread.saved,false);assert.equal(reread.duplicates,1);
 await assert.rejects(()=>api.invoke('importObservedSources',{}),/agent_method_invalid/);
});
test('source import preserves a corrected confirmation byte for byte and does not double count its source receipt',async()=>{
 const {directory,api}=await setup(),evidence=await api.invoke('evidence',{serviceKey:'suno'}),old=evidence.items[0];
 await api.userAction('confirm',{eventId:old.id,precision:'day',date:'2026-11-01',amount:{currency:'EUR',minor:1800},expectedRevision:0});
 const before=await api.invoke('evidence',{serviceKey:'suno'}),dash=await api.invoke('dashboard');
 await importObservedSources({directory,expectedRevision:dash.ledgerRevision,mailboxHash,messages:[message()],extract:extractEvidence});
 const after=await api.invoke('evidence',{serviceKey:'suno'}),next=await api.invoke('dashboard');
 assert.deepEqual(after.paymentConfirmations,before.paymentConfirmations);assert.deepEqual(after.items.find(e=>e.id===old.id),before.items[0]);
 assert.deepEqual(next.spending.recordedPaidMinorByCurrency,{EUR:1800});assert.deepEqual(next.spending.sourcePaidMinorByCurrency,{});
});
test('stale revisions, changed accounts and source identity collisions fail without replacing records',async()=>{
 const {directory,api}=await setup(),before=await api.invoke('dashboard');
 const args={directory,expectedRevision:before.ledgerRevision,mailboxHash,messages:[message()],extract:extractEvidence};
 await assert.rejects(()=>importObservedSources({...args,expectedRevision:'stale'}),/source_revision_changed/);
 assert.equal((await api.invoke('dashboard')).ledgerRevision,before.ledgerRevision);
 await importObservedSources(args);const after=await api.invoke('dashboard');
 await assert.rejects(()=>importObservedSources({...args,expectedRevision:after.ledgerRevision,mailboxHash:'b'.repeat(64)}),/source_mailbox_changed/);
 await assert.rejects(()=>importObservedSources({...args,expectedRevision:after.ledgerRevision,extract:m=>extractEvidence(m).map(e=>({...e,payment:{currency:'USD',minor:9000}}))}),/source_event_identity_conflict/);
 assert.equal((await api.invoke('dashboard')).ledgerRevision,after.ledgerRevision);
});
test('known invoice fields never establish paid cashflow and held proposals cannot grant themselves verification',()=>{
 const e={id:'invoice',messageId:'invoice',serviceKey:'suno',service:'Suno',kind:'invoice_recorded',receivedAt:time,sourceReadAt:time,sourceFormat:'connector_plaintext',invoiceAmount:{currency:'USD',minor:2000},invoiceDay:'2026-11-01'};
 assert.equal(sourceVerification(e),'source_verified_invoice');assert.equal(projectBillingRecords({events:[e]}).length,0);
 assert.equal(sourceVerification({...e,candidateStatus:'needs_review',authenticated:true}),'needs_review');
 assert.equal(sourceVerification({...e,invoiceDay:null}),'source_partial');
 assert.equal(sourceVerification({...e,invoiceAmount:{minor:2000,currency:null}}),'needs_review');
});
test('Cloudflare help URLs cannot become a registered domain or turn a deletion date into an expiry date',()=>{
 const e=extractEvidence({id:'domain-expired',sender:'noreply@notify.cloudflare.com',subject:'Domain Expiration Notification from Cloudflare',receivedAt:time,text:'Your Domains Have Expired\nVisit https://dash.cloudflare.com\n- example.com is scheduled for deletion on December 16, 2026.'});
 assert.equal(e[0].serviceKey,'cloudflare:example.com');assert.equal(e[0].kind,'access_expired');assert.equal(e[0].accessEnds,null);
 assert.deepEqual(extractEvidence({id:'no-domain',sender:'noreply@notify.cloudflare.com',subject:'Domain Expiration Notification from Cloudflare',receivedAt:time,text:'Your Domains Have Expired. Visit https://cloudflare.com.'}),[]);
});
test('named Mint plan-end dates are extracted while ambiguous numeric dates and relative reminders stay unknown',()=>{
 const source={id:'mint',sender:'care@email.mintmobile.com',subject:'Your plan is ending',receivedAt:time};
 assert.equal(extractEvidence({...source,text:'EXPIRATION DATE: Aug 15, 2026\nAUTO RENEWAL: Not Active'})[0].accessEnds,'2026-08-15');
 assert.equal(extractEvidence({...source,text:'RENEWAL DATE: 08/05/26\nAUTO RENEWAL: Not Active'})[0].accessEnds,null);
});
test('incomplete source receipts replace duplicate proposals in the view while separate originals remain visible',()=>{
 const a={id:'proposal',messageId:'one-mail',serviceKey:'suno',service:'Suno',kind:'payment_succeeded',payment:{minor:2000,currency:null},receivedAt:time,candidateStatus:'needs_review'};
 const b={...a,id:'source',candidateStatus:undefined,sourceFormat:'connector_plaintext',sourceReadAt:time,fieldEvidence:{payment:{excerpt:'Amount paid $20.00'}}};
 assert.deepEqual(projectBillingRecords({events:[a,b]}).map(x=>x.eventId),['source']);
 const c={...b,id:'second-source',lineItemRef:'another-item'};
 assert.equal(projectBillingRecords({events:[b,c]}).length,2);
 const marked={...b,fieldEvidence:{payment:{excerpt:'**Total:$**20.00'}}};
 assert.equal(projectBillingRecords({events:[marked]})[0].sourceAmountText,'$20.00');
});
test('rereading an immutable email retains its reviewed PDF source and field quotations',()=>{
 const source={id:'receipt',messageId:'email',kind:'payment_succeeded',payment:{minor:2000,currency:'USD'},sourceDocument:{attachmentId:'synthetic-attachment',sha256:'c'.repeat(64),page:1,parserVersion:'synthetic-1'},fieldEvidence:{payment:{excerpt:'Amount paid USD 20.00'}},receiptVerification:{checkedAt:time,fields:['payment','sourceDocument','fieldEvidence']}};
 const reread=preserveReceiptVerification(source,{id:source.id,messageId:source.messageId,kind:source.kind,payment:{minor:2000,currency:null}});
 assert.deepEqual(reread.sourceDocument,source.sourceDocument);assert.deepEqual(reread.fieldEvidence,source.fieldEvidence);assert.equal(reread.payment.currency,'USD');
 assert.equal(preserveReceiptVerification(source,{id:'different-record',messageId:source.messageId}).sourceDocument,undefined);
});
test('an explicit transaction links invoice and receipt without replacing a differing invoice total',()=>{
 const receipt={id:'paid',messageId:'receipt-mail',serviceKey:'suno',service:'Suno',kind:'payment_succeeded',payment:{currency:'TWD',minor:123450},paymentDay:'2026-11-01',paymentDateBasis:'explicit',sourceFormat:'connector_plaintext',sourceReadAt:time,receivedAt:time,transactionRef:'synthetic-txn'};
 const invoice={id:'invoice',messageId:'invoice-mail',serviceKey:'suno',service:'Suno',kind:'invoice_recorded',invoiceAmount:{currency:'TWD',minor:123500},invoiceDay:'2026-11-01',sourceFormat:'connector_plaintext',sourceReadAt:time,receivedAt:time,transactionRef:'synthetic-txn'};
 receipt.reference='synthetic-merchant-invoice';invoice.reference='synthetic-government-invoice';
 const state={events:[receipt,invoice]},before=JSON.stringify(state),row=projectBillingRecords(state,{view:'invoices'})[0];
 assert.equal(row.matchedReceipt.amountDifferenceMinor,50);assert.equal(row.amount.minor,123500);assert.equal(projectBillingRecords(state)[0].amount.minor,123450);assert.equal(JSON.stringify(state),before);
 const unrelated={...invoice,transactionRef:undefined};assert.equal(projectBillingRecords({events:[receipt,unrelated]},{view:'invoices'})[0].matchedReceipt,null);
});
