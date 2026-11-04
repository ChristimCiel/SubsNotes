import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPaymentConfirmationRuntime} from '../src/payment-confirmations.mjs';
import {createCashflowRuntime} from '../src/cashflow.mjs';
import {createClaudePersonalStore} from '../src/claude-store.mjs';
import {createLedgerContracts} from '../src/ledger-contracts.mjs';
import {mergeAssistantEvidence} from '../src/assistant-update.mjs';
import {createClaudeGmailClient} from '../src/claude-gmail.mjs';
import {extractWebEvidence} from '../src/web-evidence.mjs';
import {createFxRuntime} from '../src/fx.mjs';
import {createWebSync} from '../src/web-sync.mjs';
import {prepareAssistantSync} from '../src/assistant-sync.mjs';
import {projectEvidence} from '../src/evidence.mjs';
import {createSubscriptionViewRuntime} from '../src/subscription-view.mjs';

const user=createPaymentConfirmationRuntime(),cash=createCashflowRuntime();
const hash=x=>createHash('sha256').update(x).digest('hex');
const now='2027-04-10T09:00:00Z';
const invoice=(i=0,extra={})=>({id:'synthetic-confirm-invoice-'+i,messageId:'synthetic-confirm-mail-'+i,serviceKey:'fictional-tool',service:'Fictional Tool',category:'Software',kind:'invoice_recorded',authenticated:true,receivedAt:'2027-02-15T00:00:00Z',invoiceAmount:{currency:'EUR',minor:1800+i},invoiceDay:'2027-02-14',reference:'SYNTHETIC-INV-'+i,...extra});
const state=events=>({version:1,events:events||[invoice()],prefs:{language:'en',month:'2027-03'},scannedIds:[]});
const confirm=(s,eventId=s.events[0].id,options={})=>user.set(s,{eventId,precision:'month',month:'2027-03',amount:s.events.find(e=>e.id===eventId)?.invoiceAmount||{currency:'EUR',minor:1800},expectedRevision:user.revision(s,eventId),...options},{now});
const summary=(s,month=null)=>cash.summarize(projectEvidence(s.events,{trustConnectorReads:true,asOf:now}),{paymentConfirmations:s.paymentConfirmations,trustConnectorReads:true,month});

test('ten synthetic invoices can be confirmed by day or month without changing any source evidence',()=>{
 let s=state(Array.from({length:10},(_,i)=>invoice(i))),original=structuredClone(s.events);
 for(let i=0;i<10;i++)s=confirm(s,s.events[i].id,i%2?{precision:'day',date:'2027-03-28',month:undefined}:{});
 assert.deepEqual(s.events,original);assert.equal(Object.keys(s.paymentConfirmations).length,10);
 const fiscal=summary(s,'2027-03');assert.equal(fiscal.included.length,10);assert.equal(fiscal.pendingInvoices.length,0);
 assert.deepEqual(fiscal.paidMinorByCurrency,{EUR:18045});assert.deepEqual(fiscal.userConfirmedPaidMinorByCurrency,fiscal.paidMinorByCurrency);assert.deepEqual(fiscal.sourcePaidMinorByCurrency,{});
 assert.equal(fiscal.monthPrecisionPaymentCount,5);assert.equal(fiscal.userConfirmedCount,10);assert.equal(fiscal.bankReconciled,false);
 for(const row of fiscal.included){assert.equal(row.cashflowType,'user_confirmed_payment');assert.equal(row.paymentDateBasis,'user');assert.equal(row.paymentConfirmation.provenance,'user');if(row.paymentDatePrecision==='month')assert.equal(row.paymentDay,null);}
 assert.deepEqual(summary(s,'2027-02').paidMinorByCurrency,{});
});

test('edit, remove and undo append history and restore the previous date without duplicate payments',()=>{
 const first=confirm(state()),second=confirm(first,first.events[0].id,{precision:'day',date:'2027-02-28',month:undefined});
 assert.equal(user.get(second,second.events[0].id).revision,2);assert.equal(user.history(second,second.events[0].id).length,2);
 assert.deepEqual(summary(second,'2027-03').paidMinorByCurrency,{});assert.equal(summary(second,'2027-02').included.length,1);
 const removed=user.remove(second,second.events[0].id,{now,expectedRevision:2});assert.equal(user.get(removed,second.events[0].id),null);assert.equal(user.revision(removed,second.events[0].id),3);
 assert.equal(summary(removed).pendingInvoices.length,1);assert.equal(summary(removed).included.length,0);
 const undoRemove=user.undo(removed,second.events[0].id,{now,expectedRevision:3});assert.equal(user.get(undoRemove,second.events[0].id).date,'2027-02-28');
 assert.equal(summary(undoRemove).included.length,1);assert.equal(user.history(undoRemove,second.events[0].id).length,4);
 assert.deepEqual(undoRemove.events,first.events);
});

test('confirmation validation rejects impossible dates, future dates, ambiguous precision and unsafe amounts',()=>{
 for(const date of ['2027-02-29','2027-04-31','2027-03','not-a-date'])assert.throws(()=>confirm(state(),undefined,{precision:'day',date,month:undefined}),e=>e.code==='confirmation_date_invalid');
 for(const month of ['2027-00','2027-13','2027-3'])assert.throws(()=>confirm(state(),undefined,{month}),e=>e.code==='confirmation_month_invalid');
 assert.throws(()=>confirm(state(),undefined,{month:'2028-01'}),e=>e.code==='confirmation_future');
 assert.throws(()=>confirm(state(),undefined,{precision:'day',date:'2028-01-01',month:undefined}),e=>e.code==='confirmation_future');
 assert.throws(()=>confirm(state(),undefined,{precision:'day',date:'2027-02-28'}),e=>e.code==='confirmation_date_invalid');
 for(const amount of [{currency:null,minor:100},{currency:'ZZZ',minor:100},{currency:'USD',minor:1.1},{currency:'USD',minor:-1},{currency:'USD',minor:Number.MAX_SAFE_INTEGER+1}])assert.throws(()=>confirm(state(),undefined,{amount}),e=>e.code==='confirmation_amount_invalid');
 assert.deepEqual(user.parseAmount('1,234.56','USD'),{currency:'USD',minor:123456});
 assert.deepEqual(user.parseAmount('1234','JPY'),{currency:'JPY',minor:1234});
 assert.deepEqual(user.parseAmount('1.234','KWD'),{currency:'KWD',minor:1234});
 for(const [text,code]of [['1.1','JPY'],['1,23','USD'],['1.234','USD'],['1e3','USD'],['-5','USD'],['9007199254740992','USD']])assert.throws(()=>user.parseAmount(text,code),e=>e.code==='confirmation_amount_invalid');
});

test('stale edits, same-revision mutations, history truncation and dropped confirmation keys fail closed',()=>{
 const first=confirm(state()),id=first.events[0].id;
 assert.throws(()=>confirm(first,id,{expectedRevision:0}),e=>e.code==='confirmation_stale');
 assert.throws(()=>user.remove(first,id,{now,expectedRevision:0}),e=>e.code==='confirmation_stale');
 const second=confirm(first,id,{month:'2027-02'});
 for(const bad of [{},{...first.paymentConfirmations,[id]:{...first.paymentConfirmations[id],month:'2027-01'}},{...second.paymentConfirmations,[id]:{...second.paymentConfirmations[id],history:[]}}])assert.throws(()=>user.validateTransition(first.paymentConfirmations,bad));
 assert.deepEqual(user.validateTransition(first.paymentConfirmations,second.paymentConfirmations),second.paymentConfirmations);
});

test('a matched receipt superseded by user amount or month is counted once with source conflict exposed',()=>{
 const inv=invoice(),receipt={...inv,id:'synthetic-linked-receipt',messageId:'synthetic-linked-mail',kind:'payment_succeeded',payment:{currency:'EUR',minor:1900},paymentDay:'2027-02-28',paymentDateBasis:'explicit'};
 const s=confirm(state([inv,receipt]));const fiscal=summary(s);
 assert.equal(fiscal.included.length,1);assert.deepEqual(fiscal.paidMinorByCurrency,{EUR:1800});assert.equal(fiscal.pendingInvoices.length,0);
 assert.ok(fiscal.confirmationConflicts[0].reasons.includes('source_amount_changed'));assert.ok(fiscal.confirmationConflicts[0].reasons.includes('source_date_changed'));
 assert.equal(fiscal.included[0].id,inv.id);assert.equal(fiscal.included[0].paymentDay,null);
});

test('duplicate invoice aliases edit one confirmation while distinct accounts, lines and invoice IDs remain independent',()=>{
 const inv=invoice(),copy={...inv,id:'synthetic-invoice-copy',messageId:'synthetic-invoice-copy-mail'};
 let s=confirm(state([inv,copy]));assert.equal(user.get(s,copy.id).eventId,inv.id);
 s=confirm(s,copy.id,{month:'2027-02'});assert.equal(Object.keys(s.paymentConfirmations).length,1);assert.equal(user.get(s,copy.id).revision,2);assert.equal(summary(s).included.length,1);
 for(const extra of [{accountRef:'synthetic-other-account'},{lineItemRef:'synthetic-other-line'},{reference:'SYNTHETIC-DIFFERENT-INVOICE'}]){
  const other={...inv,...extra,id:'synthetic-distinct',messageId:'synthetic-distinct-mail'};
  let distinct=confirm(state([inv,other]));distinct=confirm(distinct,other.id);assert.equal(summary(distinct).included.length,2);
 }
});

test('missing or changed source evidence cannot silently delete or reassign a user-confirmed payment',()=>{
 const first=confirm(state()),id=first.events[0].id;
 const missing={...first,events:[]};const m=summary(missing);assert.equal(m.included.length,1);assert.ok(m.confirmationConflicts[0].reasons.includes('source_missing'));
 const changed={...first,events:[{...first.events[0],serviceKey:'another-tool',accountRef:'another-account'}]};
 assert.throws(()=>confirm(changed,id),e=>e.code==='confirmation_identity_changed');
 const fiscal=summary(changed);assert.equal(fiscal.included[0].serviceKey,'fictional-tool');assert.equal(fiscal.included[0].payment.minor,1800);assert.ok(fiscal.confirmationConflicts[0].reasons.includes('source_identity_changed'));
});

test('confirming payment never turns a one-time purchase, donation or unclassified invoice into subscription spending',()=>{
 for(const category of ['One-time purchases','Donations','Unclassified']){
  const s=confirm(state([invoice(0,{category})])),fiscal=summary(s);
  assert.equal(user.get(s,s.events[0].id).active,true);
  assert.deepEqual(fiscal.paidMinorByCurrency,{});assert.equal(fiscal.included.length,0);assert.equal(fiscal.pendingInvoices.length,0);
  assert.equal(fiscal.excluded[0].reason,category==='Unclassified'?'subscription_classification_unverified':'not_subscription');
 }
 const s=confirm(state()),changed={...s,events:[{...s.events[0],category:'One-time purchases'}]},fiscal=summary(changed);
 assert.deepEqual(fiscal.paidMinorByCurrency,{});assert.ok(fiscal.confirmationConflicts[0].reasons.includes('source_classification_changed'));
 for(const kind of ['one_time_purchase','wallet_top_up']){
  const changed={...s,events:[{...s.events[0],kind,payment:{currency:'EUR',minor:1800}}]},fiscal=summary(changed);
  assert.deepEqual(fiscal.paidMinorByCurrency,{});assert.equal(fiscal.excluded[0].reason,'not_subscription');assert.ok(fiscal.confirmationConflicts[0].reasons.includes('source_classification_changed'));
  const edited=confirm(changed,changed.events[0].id,{month:'2027-02'});assert.equal(user.get(edited,changed.events[0].id).revision,2);assert.deepEqual(summary(edited).paidMinorByCurrency,{});
  assert.throws(()=>confirm(state(changed.events)),e=>e.code==='confirmation_missing_source');
 }
});

function storeFixture(maxBytes=60_000){const docs=new Map();let n=0,failConfirm=false;return {docs,set failConfirm(value){failConfirm=value;},db:{collection:()=>({doc:id=>({get:async()=>({exists:docs.has(id),data:()=>structuredClone(docs.get(id))}),set:async data=>{if(failConfirm&&id.startsWith('confirmations-'))throw Error('synthetic confirmation write failure');docs.set(id,structuredClone(data));}})})},options:{hash,revision:()=>String(++n),maxBytes}};}

test('explicit user saves survive reopen and ordinary AI saves cannot remove or replace confirmations',async()=>{
 const f=storeFixture(),store=createClaudePersonalStore(f.db,'synthetic',f.options);await store.load();await store.save(state());
 let s=await store.load();s=confirm(s);await store.saveUserConfirmations(s);
 const persisted=await createClaudePersonalStore(f.db,'synthetic',f.options).load();assert.deepEqual(persisted.paymentConfirmations,s.paymentConfirmations);
 const loaded=await store.load(),without={...loaded};delete without.paymentConfirmations;await store.save(without);
 assert.deepEqual((await store.load()).paymentConfirmations,s.paymentConfirmations);
 const malicious=structuredClone(await store.load());malicious.paymentConfirmations[loaded.events[0].id].amount.minor=99999;await store.save(malicious);
 assert.deepEqual((await store.load()).paymentConfirmations,s.paymentConfirmations);
 const empty=storeFixture(),fresh=createClaudePersonalStore(empty.db,'synthetic',empty.options);await fresh.load();await fresh.save(s);assert.equal((await fresh.load()).paymentConfirmations,undefined,'ordinary save cannot mint user authority');
});

test('stale UI writers and attempts to bypass user edit history preserve the latest saved confirmation',async()=>{
 const f=storeFixture(),a=createClaudePersonalStore(f.db,'synthetic',f.options),b=createClaudePersonalStore(f.db,'synthetic',f.options);await a.load();await a.save(state());
 const stale=await b.load(),current=confirm(await a.load());await a.saveUserConfirmations(current);
 await assert.rejects(b.saveUserConfirmations(confirm(stale)),/another tab/);
 const valid=await a.load(),bad=structuredClone(valid);bad.paymentConfirmations[valid.events[0].id].month='2027-01';
 const before=structuredClone(f.docs.get('subsnotes-state-v1'));await assert.rejects(a.saveUserConfirmations(bad),e=>e.code==='confirmation_stale');assert.deepEqual(f.docs.get('subsnotes-state-v1'),before);
});

test('confirmation chunks are hash-checked, reopen completely and retain the prior index on write failure',async()=>{
 const f=storeFixture(2700),store=createClaudePersonalStore(f.db,'synthetic',f.options);await store.load();await store.save(state(Array.from({length:10},(_,i)=>invoice(i))));
 let s=await store.load();for(const e of s.events)s=confirm(s,e.id);await store.saveUserConfirmations(s);
 const manifest=f.docs.get('subsnotes-state-v1');assert.ok(manifest.paymentConfirmationChunks.length>1);assert.equal(manifest.paymentConfirmations,undefined);
 const reopened=await createClaudePersonalStore(f.db,'synthetic',f.options).load({fresh:true});assert.deepEqual(reopened.paymentConfirmations,s.paymentConfirmations);assert.equal(summary(reopened).included.length,10);
 let edit=confirm(await store.load(),s.events[0].id,{month:'2027-02'});f.failConfirm=true;const before=structuredClone(manifest);await assert.rejects(store.saveUserConfirmations(edit),/synthetic confirmation write failure/);assert.deepEqual(f.docs.get('subsnotes-state-v1'),before);f.failConfirm=false;
 const id=before.paymentConfirmationChunks[0],doc=f.docs.get('confirmations-'+id),key=Object.keys(doc.paymentConfirmations)[0];doc.paymentConfirmations[key].amount.minor++;
 await assert.rejects(createClaudePersonalStore(f.db,'synthetic',f.options).load({fresh:true}),/did not match/);
});

const identityReply={payload:{threads:[{messages:[{id:'synthetic-owner-sent',sender:'owner@example.invalid'}]}]}};
const originalMessage={id:'synthetic-native-invoice',sender:'billing@tax.openai.com',subject:'Your tax invoice is ready',plaintextBody:'An invoice has been prepared for your purchase.',date:'2027-02-15T00:00:00Z'};
const runtime={createClaudePersonalStore,createClaudeGmailClient,createWebSync,createFxRuntime,extractWebEvidence,hash};
test('two actual extraction/merge passes and both assistant sync paths retain the user overlay',async()=>{
 let s=(await mergeAssistantEvidence({state:{...state([]),mailboxHash:hash('owner@example.invalid')},identityReply,messages:[originalMessage],asOf:now,parserVersion:'before'},runtime)).state;
 const event=s.events[0];Object.assign(event,{kind:'invoice_recorded',serviceKey:'fictional-tool',service:'Fictional Tool',category:'Software',invoiceAmount:{currency:'EUR',minor:1800},invoiceDay:'2027-02-14',reference:'SYNTHETIC-DOC',receiptVerification:{checkedAt:now,fields:['kind','serviceKey','service','category','invoiceAmount','invoiceDay','reference']}});
 s=confirm(s);const userLayer=structuredClone(s.paymentConfirmations);
 for(let i=0;i<2;i++)s=(await mergeAssistantEvidence({state:s,identityReply,messages:[originalMessage],asOf:now,parserVersion:'after'},runtime)).state;
 assert.deepEqual(s.paymentConfirmations,userLayer);assert.equal(summary(s).included.length,1);
 const f=storeFixture(),store=createClaudePersonalStore(f.db,'synthetic',f.options);await store.load();const base={...s};delete base.paymentConfirmations;await store.save(base);await store.saveUserConfirmations(s);
 const observations=[],runId='synthetic-observed-sync';let result;
 for(let i=0;i<12;i++){
  result=await prepareAssistantSync({documents:[...f.docs].map(([id,data])=>({id,data})),observations,runId,asOf:now,scan:{recentOnly:true}},runtime);
  if(result.status==='ready_to_commit')break;
  const r=result.requiredTool;observations.push({runId,...r,observedAt:now,result:r.tool==='get_message'?originalMessage:r.args.query==='in:sent from:me'?identityReply:{threads:[{messages:[{id:originalMessage.id}]}],resultCountEstimate:'1'}});
 }
 assert.equal(result.status,'ready_to_commit');for(const write of result.writes)f.docs.set(write.id,write.data);
 const after=await createClaudePersonalStore(f.db,'synthetic',f.options).load();assert.deepEqual(after.paymentConfirmations,userLayer);assert.equal(summary(after).included.length,1);
});

test('portable data and AI candidates cannot confer user-confirmation authority',async()=>{
 const contracts=createLedgerContracts(),s=confirm(state()),bundle=await contracts.createPortableExport(s,{hash});
 const imported=await contracts.importPortableExport(bundle,{hash});assert.equal(imported.state.paymentConfirmations,undefined);assert.deepEqual(imported.state.importedPaymentConfirmations,s.paymentConfirmations);assert.equal(summary(imported.state).included.length,0);
 assert.throws(()=>contracts.validateCandidate({schemaVersion:1,paymentConfirmations:s.paymentConfirmations},{observation:{}}),/authority/);
});

test('read-only service view includes manually confirmed totals without cross-service leakage or invented days',()=>{
 const a=invoice(),b=invoice(1,{serviceKey:'other-tool',service:'Other Tool'});let s=confirm(state([a,b]));s=confirm(s,b.id);
 const view=createSubscriptionViewRuntime(),snapshot=view.build({state:s,core:{projectEvidence},cashflow:cash,fx:createFxRuntime(),asOf:now,month:'2027-03'});
 assert.equal(snapshot.totals.userConfirmedCount,2);assert.equal(snapshot.totals.monthPrecisionPaymentCount,2);assert.deepEqual(snapshot.rows.map(row=>row.userConfirmedCount),[1,1]);
 const html=view.renderHTML(snapshot,{language:'zh-TW'});assert.match(html,/包含由你本人確認的付款/);assert.match(html,/未指定確切扣款日/);assert.doesNotMatch(html,/paymentDay.{0,20}2027-03-01/);
});
