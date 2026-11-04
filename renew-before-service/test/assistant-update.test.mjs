import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeAssistantEvidence} from '../src/assistant-update.mjs';
import {createClaudeGmailClient} from '../src/claude-gmail.mjs';
import {extractWebEvidence} from '../src/web-evidence.mjs';
import {createFxRuntime} from '../src/fx.mjs';
import {digest,projectEvidence} from '../src/evidence.mjs';
import {createWebSync} from '../src/web-sync.mjs';
import {createLedgerContracts} from '../src/ledger-contracts.mjs';
const runtime={createClaudeGmailClient,extractWebEvidence,createFxRuntime,hash:digest};
const asOf='2026-08-15T00:00:00Z';
const identityReply={payload:{threads:[{messages:[{id:'synthetic-sent',sender:'owner@example.invalid'}]}]}};
const messages=[{id:'synthetic-cancel',sender:'billing@suno.com',subject:'Your subscription was canceled',plaintextBody:'Your access will expire on Sep 2, 2026.',date:'2026-08-10T00:00:00Z'}];

test('assistant-mediated reads use the same parser without advancing unrelated discovery coverage',async()=>{
  const state={version:1,events:[],scannedIds:[],mailboxHash:digest('owner@example.invalid'),pending:{windows:[{since:'2026-07-01',until:'2026-08-16'}]},lastCompletedAt:null,prefs:{language:'zh'}};
  const first=await mergeAssistantEvidence({state,identityReply,messages,asOf},runtime);
  assert.equal(first.addedEvidence,1);assert.equal(first.state.events[0].kind,'renewal_disabled');
  assert.equal(first.state.events[0].authenticated,false);assert.equal(first.state.events[0].sourceReadAt,asOf);
  assert.deepEqual(first.state.pending,state.pending);assert.deepEqual(first.state.prefs,state.prefs);assert.equal(first.state.lastCompletedAt,null);
  const second=await mergeAssistantEvidence({state:first.state,identityReply,messages,asOf},runtime);
  assert.equal(second.addedEvidence,0);assert.equal(second.state.events.length,1);
  await assert.rejects(mergeAssistantEvidence({state:{...state,mailboxHash:'different'},identityReply,messages,asOf},runtime),/does not match/);
});

const paidReply={id:'synthetic-paid',sender:'billing@suno.com',subject:'Subscription receipt',
  plaintextBody:'Suno Pro subscription. Paid Aug 2, 2026. Aug 2–Sep 2, 2026. Amount paid EUR 24.00',date:'2026-08-02T00:00:00Z'};
async function baseline() {
  const state={version:1,events:[],scannedIds:[],mailboxHash:digest('owner@example.invalid'),prefs:{language:'zh'},
    pending:{mode:'windows-v2',scopeQuery:'original query',windows:[{since:'2026-07-01',until:'2026-08-16'}],ids:[],pageToken:null,nextPageToken:null,startedAt:asOf},
    lastCompletedAt:null,syncAnchorAt:null,queryCoverage:[]};
  return (await mergeAssistantEvidence({state,identityReply,messages:[paidReply],asOf,parserVersion:'before'},runtime)).state;
}
async function compareEntryPoints(state, reply, extract=extractWebEvidence) {
  const targeted=await mergeAssistantEvidence({state,identityReply,messages:[reply],asOf,parserVersion:'after'}, {...runtime,extractWebEvidence:extract});
  let saved=structuredClone(state);
  const client=createClaudeGmailClient({callTool:async(_server,tool)=>tool==='search_threads'?identityReply:{payload:reply}}, {clock:()=>asOf});
  const full=await createWebSync({
    gmail:{identity:client.identity,message:client.message,search:async()=>({ids:[reply.id],nextPageToken:null})},
    store:{load:async()=>structuredClone(saved),save:async next=>{saved=structuredClone(next);}},extract,hash:digest,clock:()=>asOf,parserVersion:'after'
  }).run();
  const {canonicalJSON}=createLedgerContracts();
  assert.equal(canonicalJSON(targeted.state.events),canonicalJSON(full.state.events),'both entrypoints merge the same source identically');
  assert.equal(canonicalJSON(targeted.state.sourceProcessing),canonicalJSON(full.state.sourceProcessing));
  assert.deepEqual(targeted.state.processingSummary,full.state.processingSummary);
  assert.deepEqual(targeted.state.pending,state.pending,'targeted reads do not advance unrelated mailbox coverage');
  assert.deepEqual(targeted.state.queryCoverage,state.queryCoverage);
  assert.equal(targeted.state.lastCompletedAt,state.lastCompletedAt);
  assert.equal(targeted.state.syncAnchorAt,state.syncAnchorAt);
  return targeted;
}

test('both entrypoints quarantine payment-to-unclassified reclassification while preserving original evidence and IDs',async()=>{
  const state=await baseline(), original=state.events[0];
  const reply={...paidReply,plaintextBody:'Suno subscription. Your invoice is available online.'};
  const result=await compareEntryPoints(state,reply);
  assert.equal(result.state.events.length,2);
  assert.equal(result.state.events.find(event=>event.id===original.id).payment.minor,2400);
  assert.ok(result.state.events.every(event=>event.sourceProcessingConflict));
  assert.equal(result.reviewCount,1);
  assert.equal(result.state.sourceProcessing[paidReply.id][5],'source_reclassified');
  const view=projectEvidence(result.state.events,{asOf,trustConnectorReads:true});
  assert.equal(view.payments.length,0);
  assert.equal(view.subscriptions.length,0);
  assert.equal(view.heldEvidence.length,2);
  const repeat=await mergeAssistantEvidence({state:result.state,identityReply,messages:[reply],asOf,parserVersion:'after'},runtime);
  assert.equal(repeat.addedEvidence,0);
  assert.equal(repeat.state.events.length,2);
});

test('shared merge preserves verified financial fields for both entrypoints',async()=>{
  const state=await baseline();
  state.events[0].receiptVerification={checkedAt:asOf,fields:['kind','payment','paymentDay','paymentDateBasis']};
  const extract=async message=>(await extractWebEvidence(message)).map(event=>({...event,payment:{minor:9900,currency:'USD'}}));
  const result=await compareEntryPoints(state,paidReply,extract);
  assert.equal(result.state.events.length,1);
  assert.equal(result.state.events[0].payment.minor,2400);
  assert.equal(result.state.events[0].payment.currency,'EUR');
  assert.equal(result.state.sourceProcessing[paidReply.id][5],'reviewed_source_conflict');
  assert.equal(projectEvidence(result.state.events,{asOf,trustConnectorReads:true}).payments.length,1);
});

test('shared merge cannot erase known financial facts through zero events or newly missing same-kind fields',async()=>{
  for(const empty of [false,true]){
    const state=await baseline();
    const extract=async message=>empty?[]:(await extractWebEvidence(message)).map(event=>({...event,payment:null,paymentDay:null,paymentDateBasis:'unknown'}));
    const result=await compareEntryPoints(state,paidReply,extract);
    assert.equal(result.state.events.length,1);
    assert.equal(result.state.events[0].payment.minor,2400);
    assert.equal(result.state.events[0].paymentDay,'2026-08-02');
    assert.equal(result.state.events[0].sourceProcessingConflict,undefined);
    assert.equal(result.state.sourceProcessing[paidReply.id][5],empty?'unrecognized_format':'incomplete_reread');
    assert.equal(result.reviewCount,1);
  }
});

test('targeted updates preserve unrelated source processing and store only allowlisted billing excerpts',async()=>{
  const state=await baseline(), untouched=[...state.sourceProcessing[paidReply.id]];
  const reply={...messages[0],subject:'Your subscription was canceled for Private Example',
    plaintextBody:'Hello Private Example\nYour subscription was canceled.\nCustomer name: Private Example\nBilling address: 123 Sample Road\nYour access will expire on Sep 2, 2026.'};
  const result=await mergeAssistantEvidence({state,identityReply,messages:[reply],asOf,parserVersion:'before'},runtime);
  assert.deepEqual(result.state.sourceProcessing[paidReply.id],untouched);
  assert.equal(result.state.processingSummary.read,2);
  for(const event of result.state.events)assert.ok(!/Private Example|123 Sample Road/.test(event.subject+' '+event.evidence));
  await assert.rejects(mergeAssistantEvidence({state,identityReply,messages:[reply,reply],asOf},runtime),/identities must be unique/);
});

test('both entrypoints preserve the original identity when a reread changes or omits explicit account scope',async()=>{
  for(const proof of [false,true])for(const nextAccount of [undefined,'second-account']){
    const state=await baseline(), original=state.events[0];
    original.accountRef='first-account';
    if(proof)original.receiptVerification={checkedAt:asOf,fields:['kind','payment','paymentDay','paymentDateBasis']};
    const extract=async message=>(await extractWebEvidence(message)).map(event=>({...event,...(nextAccount?{accountRef:nextAccount}:{})}));
    const result=await compareEntryPoints(state,paidReply,extract);
    const preserved=result.state.events.find(event=>event.id===original.id),candidate=result.state.events.find(event=>event.id!==original.id);
    assert.equal(result.state.events.length,2);
    assert.equal(preserved.accountRef,'first-account');
    assert.equal(preserved.payment.minor,2400);
    assert.equal(candidate.accountRef,nextAccount);
    assert.equal(candidate.sourceProcessingConflict,true);
    assert.equal(candidate.receiptVerification,undefined,'source proof must never move across account identities');
    if(proof)assert.deepEqual(preserved.receiptVerification,original.receiptVerification);
    assert.equal(result.state.sourceProcessing[paidReply.id][5],'source_identity_conflict');
    const view=projectEvidence(result.state.events,{asOf,trustConnectorReads:true});
    assert.equal(view.payments.length,proof?1:0);
    const repeat=await mergeAssistantEvidence({state:result.state,identityReply,messages:[paidReply],asOf,parserVersion:'after'}, {...runtime,extractWebEvidence:extract});
    assert.equal(repeat.state.events.length,2,'identity-collision retries remain bounded');
  }
});

test('both entrypoints preserve a source-reviewed invoice product correction when the native parser still lacks the document',async()=>{
  const reply={id:'synthetic-document-invoice',sender:'billing@tax.openai.com',subject:'Your tax invoice is ready',plaintextBody:'A tax invoice is available in your account.',date:'2026-08-02T00:00:00Z'};
  const state=(await mergeAssistantEvidence({state:{version:1,events:[],scannedIds:[],mailboxHash:digest('owner@example.invalid')},identityReply,messages:[reply],asOf,parserVersion:'before'},runtime)).state;
  const source=state.events[0];
  Object.assign(source,{kind:'invoice_recorded',serviceKey:'fictional-reviewed-product',service:'Fictional reviewed product',category:'Software',invoiceAmount:{minor:1700,currency:'EUR'},invoiceDay:'2026-08-02',receiptVerification:{checkedAt:asOf,fields:['kind','serviceKey','service','category','invoiceAmount','invoiceDay']}});
  const result=await compareEntryPoints(state,reply);
  assert.equal(result.state.events.length,1);assert.equal(result.state.events[0].id,source.id);
  assert.equal(result.state.events[0].serviceKey,'fictional-reviewed-product');assert.equal(result.state.events[0].kind,'invoice_recorded');
  assert.equal(result.state.events[0].sourceProcessingConflict,undefined);assert.equal(result.state.sourceProcessing[reply.id][1],'extracted');
  const replay=await mergeAssistantEvidence({state:result.state,identityReply,messages:[reply],asOf,parserVersion:'after'},runtime);
  assert.equal(replay.state.events.length,1);assert.equal(replay.state.events[0].serviceKey,'fictional-reviewed-product');
});

test('unreviewed product moves stay held while an explicitly reviewed financial category survives replay',async()=>{
  const moved=await baseline();moved.events[0].serviceKey='fictional-unreviewed-product';
  const held=await compareEntryPoints(moved,paidReply);
  assert.equal(held.state.sourceProcessing[paidReply.id][5],'source_identity_conflict');
  assert.ok(held.state.events.some(event=>event.sourceProcessingConflict));
  const classified=await baseline();Object.assign(classified.events[0],{category:'Donations',receiptVerification:{checkedAt:asOf,fields:['category','kind','payment','paymentDay','paymentDateBasis']}});
  const result=await compareEntryPoints(classified,paidReply);
  assert.equal(result.state.events.length,1);assert.equal(result.state.events[0].category,'Donations');assert.equal(result.state.events[0].sourceProcessingConflict,undefined);
  assert.equal(projectEvidence(result.state.events,{asOf,trustConnectorReads:true}).payments.length,0);
});
