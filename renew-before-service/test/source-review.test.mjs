import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSourceEvidenceMerger,createWebSync} from '../src/web-sync.mjs';
import {createLedgerContracts} from '../src/ledger-contracts.mjs';
import {preserveReceiptVerification} from '../src/receipt-verification.mjs';
import {mergeAssistantEvidence} from '../src/assistant-update.mjs';
import {createClaudeGmailClient} from '../src/claude-gmail.mjs';
import {createFxRuntime} from '../src/fx.mjs';
import {digest,projectEvidence} from '../src/evidence.mjs';
import {extractWebEvidence} from '../src/web-evidence.mjs';

const now=Date.parse('2026-08-15T00:00:00Z'),asOf=new Date(now).toISOString();
const merger=()=>createSourceEvidenceMerger({preserveReceiptVerification,billingExcerpt:createLedgerContracts().billingExcerpt,hash:digest});
const message={id:'synthetic-newsletter',sender:'news@merchant.example.invalid',subject:'Monthly product newsletter',receivedAt:'2026-08-01T00:00:00Z',sourceReadAt:asOf,text:'New feature announcements. No account billing activity.',truncated:false};
const review=async(events=new Map(),source=message)=>merger().reviewSource({events,message:source,parserVersion:'3',now,decision:'non_billing'});

test('legacy unresolved records remain visible when a new parser is selected',()=>{
  const summary=merger().summarizeProcessing(new Set(['old-review','new-review','old-extracted']),{
    'old-review':['3','needs_review',3,now,null,'unrecognized_format'],
    'new-review':['4','needs_review',1,now,now+86400000,'amount_unknown'],
    'old-extracted':['3','extracted',1,now,null,null]
  },{parserVersion:'4',now});
  assert.equal(summary.needsReview,2);assert.equal(summary.reprocessPending,2);assert.equal(summary.retryPending,1);
});

test('an explicit nonbilling review stores only a controlled decision and source digest, surviving parser upgrades',async()=>{
  const record=await review(),m=merger();
  assert.equal(record.length,7);assert.equal(record[3],now);assert.deepEqual(record[6],['non_billing',await m.sourceFingerprint(message)]);
  assert.equal(JSON.stringify(record).includes(message.text),false);assert.equal(JSON.stringify(record).includes(message.sender),false);
  assert.equal(m.processingDue(record,'4',now+10*86400000),false);
  const summary=m.summarizeProcessing(new Set([message.id]),{[message.id]:record},{parserVersion:'4',now});
  assert.equal(summary.reviewedNonBilling,1);assert.equal(summary.extracted,1);assert.equal(summary.needsReview,0);assert.equal(summary.reprocessPending,0);
  assert.equal(await m.sourceFingerprint({...message,text:'  '+message.text.replaceAll('. ','.\r\n')+'  '}),await m.sourceFingerprint({...message,text:message.text.replaceAll('. ','.\n')}));
});

test('nonbilling review rejects incomplete observations, unknown decisions and existing financial or status evidence',async()=>{
  const m=merger();
  for(const source of [{...message,truncated:true},{...message,text:''},{...message,sourceReadAt:null}])await assert.rejects(review(new Map(),source),/complete original source/);
  await assert.rejects(m.reviewSource({events:new Map(),message,parserVersion:'4',now,decision:'probably_canceled'}),/supported source review/);
  for(const event of [{kind:'payment_succeeded'},{kind:'renewal_disabled'},{kind:'invoice_recorded'},{kind:'unclassified_purchase',sourceRequiresDocumentReview:true},{kind:'unclassified_purchase',payment:{minor:1000,currency:'USD'}}]){
    await assert.rejects(review(new Map([['record',{...event,messageId:message.id}]])),/cannot be dismissed/);
  }
  for(const suffix of [[['non_billing','bad-hash']],[['anything',digest('source')]],['raw content']])assert.equal(m.validProcessingRecord(['4','extracted',1,now,null,null,...suffix]),false);
});

test('matching explicit rereads retain the review timestamp; changed sources reopen review and hold new interpretations',async()=>{
  const m=merger(),record=await review(),events=new Map();
  const same=m.merge({events,message,parsed:[],parserVersion:'4',processingRecord:record,sourceDigest:await m.sourceFingerprint(message)});
  const retained=m.nextProcessingRecord(record,{parserVersion:'4',now:now+86400000,reason:same.reason,sourceReview:same.sourceReview});
  assert.equal(retained.length,7);assert.equal(retained[3],now);
  const changed={...message,text:'Subscription receipt. Paid Aug 2, 2026. Amount paid USD 12.00'};
  const incoming={id:'synthetic-new-paid',messageId:message.id,serviceKey:'synthetic',service:'Synthetic',kind:'payment_succeeded',sourceFormat:'claude_plaintext',sourceReadAt:asOf,receivedAt:message.receivedAt,payment:{minor:1200,currency:'USD'},paymentDay:'2026-08-02',paymentDateBasis:'explicit'};
  const result=m.merge({events,message:changed,parsed:[incoming],parserVersion:'4',processingRecord:record,sourceDigest:await m.sourceFingerprint(changed)});
  assert.equal(result.reason,'reviewed_source_changed');assert.equal(result.newEvents[0].sourceProcessingConflict,true);
  const reopened=m.nextProcessingRecord(record,{parserVersion:'4',now:now+86400000,reason:result.reason,sourceReview:result.sourceReview});
  assert.equal(reopened.length,6);assert.equal(reopened[1],'needs_review');
  assert.equal(projectEvidence([...events.values()],{asOf,trustConnectorReads:true}).payments.length,0);
});

test('normal sync skips reviewed nonbilling sources across parser upgrades without dropping unresolved legacy mail',async()=>{
  const reviewed=await review();let saved={version:1,events:[],scannedIds:[message.id,'legacy-unresolved'],mailboxHash:digest('owner@example.invalid'),sourceProcessing:{[message.id]:reviewed,'legacy-unresolved':['3','needs_review',3,now,null,'unrecognized_format']}};
  const reads=[];
  const result=await createWebSync({gmail:{identity:async()=>'owner@example.invalid',search:async()=>({ids:[message.id,'legacy-unresolved'],nextPageToken:null}),message:async id=>{reads.push(id);return {...message,id};}},store:{load:async()=>structuredClone(saved),save:async state=>{saved=structuredClone(state);}},extract:async()=>[],hash:digest,clock:()=>asOf,parserVersion:'4'}).run();
  assert.deepEqual(reads,['legacy-unresolved']);assert.equal(result.reviewCount,1);assert.equal(result.state.processingSummary.reviewedNonBilling,1);
  assert.deepEqual(result.state.sourceProcessing[message.id],reviewed);
});

test('targeted assistant reads apply the same matching-fingerprint source-review protection',async()=>{
  const reviewed=await review();
  const state={version:1,events:[],scannedIds:[message.id],mailboxHash:digest('owner@example.invalid'),sourceProcessing:{[message.id]:reviewed}};
  const runtime={createClaudeGmailClient,extractWebEvidence,createFxRuntime,hash:digest};
  const identityReply={payload:{threads:[{messages:[{id:'synthetic-sent',sender:'owner@example.invalid'}]}]}};
  const reply={id:message.id,sender:message.sender,subject:message.subject,date:message.receivedAt,plaintextBody:message.text};
  const result=await mergeAssistantEvidence({state,identityReply,messages:[reply],asOf,parserVersion:'4'},runtime);
  assert.equal(result.state.sourceProcessing[message.id].length,7);assert.equal(result.state.processingSummary.reviewedNonBilling,1);assert.equal(result.reviewCount,0);
});

test('complete source rereads preserve fully reviewed invoice and donation extraction despite an unsupported parser format',()=>{
  const m=merger(),proof={checkedAt:asOf,fields:['kind','payment','paymentDay','paymentDateBasis','invoiceAmount','invoiceDay','category']};
  for(const record of [
    {id:'synthetic-reviewed-invoice',kind:'invoice_recorded',invoiceAmount:{minor:1200,currency:'EUR'},invoiceDay:'2026-08-01',receiptVerification:proof},
    {id:'synthetic-reviewed-donation',kind:'payment_succeeded',category:'Donations',cadence:'monthly',payment:{minor:1200,currency:'EUR'},paymentDay:'2026-08-01',paymentDateBasis:'explicit',receiptVerification:proof}
  ]){
    const event={...record,messageId:message.id},events=new Map([[event.id,event]]);
    const result=m.merge({events,message,parsed:[],parserVersion:'4'});
    assert.equal(result.reason,null);assert.deepEqual(events.get(event.id),event);assert.equal(result.newEvents.length,0);
  }
});

test('reviewed zero-parse sources retain unknown financial fields and never clear incomplete or unreviewed reads',()=>{
  const m=merger(),proof={checkedAt:asOf,fields:['kind','payment','paymentDay','paymentDateBasis']};
  const payment={id:'synthetic-reviewed-gap',messageId:message.id,kind:'payment_succeeded',payment:{minor:1200,currency:'EUR'},paymentDay:'2026-08-01',paymentDateBasis:'explicit',receiptVerification:proof};
  for(const [patch,reason] of [[{payment:{minor:1200,currency:null}},'currency_unknown'],[{paymentDay:null},'payment_date_unknown'],[{paymentDateBasis:'unknown'},'payment_date_unknown'],[{kind:'unclassified_purchase'},'document_review']]){
    const event={...payment,...patch};assert.equal(m.merge({events:new Map([[event.id,event]]),message,parsed:[]}).reason,reason);
  }
  const invoice={id:'synthetic-invoice-gap',messageId:message.id,kind:'invoice_recorded',invoiceAmount:{minor:1200,currency:'EUR'},invoiceDay:null,receiptVerification:proof};
  assert.equal(m.merge({events:new Map([[invoice.id,invoice]]),message,parsed:[]}).reason,'invoice_date_unknown');
  for(const source of [{...message,text:''},{...message,truncated:true}])assert.ok(m.merge({events:new Map([[payment.id,payment]]),message:source,parsed:[]}).reason);
  const unreviewed={...payment};delete unreviewed.receiptVerification;
  assert.equal(m.merge({events:new Map([[payment.id,unreviewed]]),message,parsed:[]}).reason,'unrecognized_format');
});
