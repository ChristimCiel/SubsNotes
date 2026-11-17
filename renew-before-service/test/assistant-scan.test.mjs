import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAssistantScanRuntime} from '../src/assistant-scan.mjs';
import {createClaudePersonalStore} from '../src/claude-store.mjs';
import {createPaymentConfirmationRuntime} from '../src/payment-confirmations.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const ownerBinding='c'.repeat(64),now='2026-11-03T12:00:00Z';
const clone=value=>structuredClone(value);
function fixture({initial=null,hostBridge=null}={}) {
  let state=initial||{version:1,events:[],prefs:{language:'en',currency:'USD'},storageRevision:'synthetic-revision'},journal=null,revision=1;
  const f={saves:0,journalWrites:0,reads:0,dropSave:false,failSave:false,failFinalJournal:false,failInitialJournal:false,failReadback:false};
  f.store={load:async options=>{assert.equal(options.fresh,true);f.reads++;if(f.failReadback&&f.saves)throw new Error('synthetic-private-read-error');return clone(state);},save:async next=>{f.saves++;if(f.failSave)throw new Error('synthetic-private-save-error');if(!f.dropSave)state={...clone(next),storageRevision:'synthetic-revision-'+(++revision)};}};
  f.journal={read:async()=>clone(journal),write:async next=>{f.journalWrites++;if(f.failInitialJournal||f.failFinalJournal&&next.status==='saved')throw new Error('synthetic-private-journal-error');journal=clone(next);}};
  f.runtime=()=>createAssistantScanRuntime({store:f.store,ownerBinding,requestStorage:f.journal,hash,hostBridge,clock:()=>now,requestId:()=> 'synthetic-request-'+(++revision)});
  f.getState=()=>clone(state);f.setState=value=>{state=clone(value);};f.getJournal=()=>clone(journal);f.setJournal=value=>{journal=clone(value);};
  return f;
}
function result(request,{messageId='synthetic-message',kind='payment_succeeded',minor=2000}={}) {
  const text='Example subscription. Amount paid USD '+(minor/100).toFixed(2)+'. Paid on November 1, 2026.';
  const candidate={schemaVersion:1,messageId,serviceKey:'example',service:'Example',kind,payment:{currency:'USD',minor},paymentDay:'2026-11-01',paymentDateBasis:'explicit',fieldEvidence:{}};
  for(const key of ['serviceKey','service','kind','payment','paymentDay','paymentDateBasis'])candidate.fieldEvidence[key]={quote:text};
  return {schemaVersion:1,kind:'subsnotes.assistant-scan-result',requestId:request.requestId,ledgerRevision:request.ledgerRevision,records:[{candidate,observation:{messageId,receivedAt:'2026-11-01T12:00:00Z',observedAt:'2026-11-02T12:00:00Z',text}}],coverage:{queriesComplete:true,attachmentsComplete:false,mailboxExhaustive:false}};
}

test('preparing a native host request writes only separate metadata and never dispatches or changes ledger revision',async()=>{
  let sends=0;const f=fixture({hostBridge:{requestScan:async()=>{sends++;return {status:'awaiting_assistant'};}}}),runtime=f.runtime(),before=f.getState();
  const prepared=await runtime.begin({dispatch:false,language:'zh-TW'});
  assert.equal(prepared.status,'prepared');assert.equal(prepared.scanCompleted,false);assert.equal(prepared.request.language,'zh-TW');
  assert.equal(sends,0);assert.equal(f.saves,0);assert.deepEqual(f.getState(),before);
  assert.equal(f.getJournal().request.ledgerRevision,before.storageRevision);
  assert.equal(Object.hasOwn(f.getJournal(),'events'),false);assert.equal(Object.hasOwn(f.getJournal(),'prompt'),false);
  assert.match(prepared.prompt,/fieldEvidence/);assert.match(prepared.prompt,/subsnotes.assistant-scan-result/);
});

test('acknowledgement waits for the assistant and repeated begin does not dispatch another scan',async()=>{
  let sends=0;const f=fixture({hostBridge:{requestScan:async()=>{sends++;return {status:'awaiting_assistant'};}}}),runtime=f.runtime();
  const first=await runtime.begin();assert.equal(first.status,'awaiting_assistant');assert.equal(first.scanCompleted,false);
  const second=await runtime.begin();assert.deepEqual(second.request,first.request);assert.equal(sends,1);assert.equal(f.saves,0);
});

test('a missing host API yields an executable explicit handoff instead of Gmail fallback',async()=>{
  const f=fixture(),outcome=await f.runtime().begin();
  assert.equal(outcome.status,'host_message_unavailable');assert.equal(outcome.scanCompleted,false);
  assert.match(outcome.prompt,/Return one JSON object/);assert.match(outcome.prompt,/fieldEvidence/);assert.equal(f.saves,0);
});

test('reopening resumes the persisted request without generating another identity or dispatching',async()=>{
  const f=fixture(),prepared=await f.runtime().begin({dispatch:false});
  const reopened=await f.runtime().current();assert.deepEqual(reopened.request,prepared.request);assert.equal(reopened.status,'prepared');
  assert.equal(f.saves,0);assert.equal(f.journalWrites,1);
});

test('a synchronous native host dispatch can be recorded afterwards without marking a scan complete',async()=>{
  const f=fixture(),runtime=f.runtime(),prepared=await runtime.begin({dispatch:false});
  const dispatched=await runtime.markDispatched({requestId:prepared.request.requestId});
  assert.equal(dispatched.status,'awaiting_assistant');assert.equal(dispatched.scanCompleted,false);assert.equal(f.saves,0);
  await assert.rejects(runtime.markDispatched({requestId:'another-request'}),error=>error.code==='assistant_request_mismatch');
});

test('accepting structured facts saves through the protected store and verifies the entire state by fresh readback',async()=>{
  const f=fixture(),runtime=f.runtime(),prepared=await runtime.begin({dispatch:false}),before=f.getState();
  const saved=await runtime.accept(result(prepared.request));
  assert.equal(saved.status,'saved');assert.equal(saved.scanCompleted,true);assert.equal(saved.addedCount,1);
  assert.equal(saved.mailboxBinding,'unverified');assert.equal(f.saves,1);
  assert.equal(saved.state.events[0].candidateStatus,'needs_review');assert.equal(saved.state.events[0].authenticated,false);
  assert.deepEqual(saved.state.prefs,before.prefs);assert.equal(saved.state.assistantOwnerBinding,ownerBinding);
  assert.equal(f.getJournal().status,'saved');assert.match(f.getJournal().resultHash,/^[a-f0-9]{64}$/);
  const journalText=JSON.stringify(f.getJournal());assert.ok(!journalText.includes('Example'));assert.ok(!journalText.includes('2000'));assert.ok(!journalText.includes('synthetic-message'));
});

test('exact completed result replay is idempotent after reopening, while changed reply data is rejected',async()=>{
  const f=fixture(),runtime=f.runtime(),prepared=await runtime.begin({dispatch:false}),data=result(prepared.request);
  await runtime.accept(data);const reopened=f.runtime(),before=f.getState();
  const replay=await reopened.accept(data);assert.equal(replay.status,'saved');assert.equal(replay.replayed,true);
  assert.equal(f.saves,1);assert.deepEqual(f.getState(),before);
  await assert.rejects(reopened.accept(result(prepared.request,{minor:2500})),error=>error.code==='assistant_result_conflict');
  assert.deepEqual(f.getState(),before);
});

test('mismatched requests, changed ledger revisions and forged authority cannot trigger a ledger write',async()=>{
  const f=fixture(),runtime=f.runtime(),prepared=await runtime.begin({dispatch:false});
  const wrong=result({...prepared.request,requestId:'another'});
  await assert.rejects(runtime.accept(wrong),error=>error.code==='assistant_request_mismatch');
  const forged=result(prepared.request);forged.records[0].candidate.userVerified=true;
  await assert.rejects(runtime.accept(forged),error=>error.code==='assistant_result_invalid');
  f.setState({...f.getState(),storageRevision:'newer-confirmation-revision'});
  await assert.rejects(runtime.accept(result(prepared.request)),error=>error.code==='assistant_request_stale');assert.equal(f.saves,0);
});

test('an explicit restart prepares a fresh revision after a stale request without discarding financial data',async()=>{
  const f=fixture(),runtime=f.runtime(),first=await runtime.begin({dispatch:false});
  f.setState({...f.getState(),storageRevision:'newer-revision',prefs:{language:'zh-TW'}});
  const second=await runtime.begin({dispatch:false,restart:true,language:'zh-TW'});
  assert.notEqual(second.request.requestId,first.request.requestId);assert.equal(second.request.ledgerRevision,'newer-revision');
  assert.equal(f.getState().prefs.language,'zh-TW');assert.equal(f.saves,0);
});

test('a successful-looking save acknowledgement without persisted data is not reported as saved',async()=>{
  const f=fixture(),runtime=f.runtime(),prepared=await runtime.begin({dispatch:false});f.dropSave=true;
  const outcome=await runtime.accept(result(prepared.request));
  assert.equal(outcome.status,'save_unverified');assert.equal(outcome.scanCompleted,false);
  assert.equal(f.getJournal().status,'saving');assert.equal(f.getState().events.length,0);
});

test('provider save failures are sanitized and preserve the original financial state',async()=>{
  const f=fixture(),runtime=f.runtime(),prepared=await runtime.begin({dispatch:false}),before=f.getState();f.failSave=true;
  await assert.rejects(runtime.accept(result(prepared.request)),error=>error.code==='assistant_save_failed'&&!error.message.includes('private'));
  assert.deepEqual(f.getState(),before);
});

test('completion-journal failure is distinct from a verified ledger save and can recover after reopening',async()=>{
  const f=fixture(),runtime=f.runtime(),prepared=await runtime.begin({dispatch:false});f.failFinalJournal=true;
  const outcome=await runtime.accept(result(prepared.request));
  assert.equal(outcome.status,'savedWithJournalWarning');assert.equal(outcome.scanCompleted,true);assert.equal(f.saves,1);
  assert.equal(f.getJournal().status,'saving');f.failFinalJournal=false;
  const reopened=await f.runtime().current();assert.equal(reopened.status,'saved');assert.equal(reopened.recovered,true);
  assert.equal(f.saves,1);assert.equal(f.getJournal().status,'saved');
});

test('uncertain readback can recover from the persisted request/result marker without writing again',async()=>{
  const f=fixture(),runtime=f.runtime(),prepared=await runtime.begin({dispatch:false});f.failReadback=true;
  const outcome=await runtime.accept(result(prepared.request));assert.equal(outcome.status,'save_unverified');
  f.failReadback=false;const reopened=await f.runtime().current();assert.equal(reopened.status,'saved');assert.equal(reopened.recovered,true);assert.equal(f.saves,1);
});

test('request journal durability is required before host dispatch or a ledger write',async()=>{
  let sends=0;const f=fixture({hostBridge:{requestScan:async()=>{sends++;return {status:'awaiting_assistant'};}}});f.failInitialJournal=true;
  await assert.rejects(f.runtime().begin(),error=>error.code==='assistant_journal_not_saved');assert.equal(sends,0);assert.equal(f.saves,0);
});

test('a journal write acknowledgement without readback cannot authorize a host request',async()=>{
  let sends=0;
  const runtime=createAssistantScanRuntime({store:{load:async()=>({version:1,events:[]}),save:async()=>assert.fail('No financial write expected')},ownerBinding,requestStorage:{read:async()=>null,write:async()=>{}},hash,clock:()=>now,requestId:()=> 'synthetic-undurable',hostBridge:{requestScan:async()=>{sends++;return {status:'awaiting_assistant'};}}});
  await assert.rejects(runtime.begin(),error=>error.code==='assistant_journal_not_saved');assert.equal(sends,0);
});

test('overlapping result callbacks cannot commit a request twice',async()=>{
  const f=fixture(),runtime=f.runtime(),prepared=await runtime.begin({dispatch:false}),save=f.store.save;
  let release;f.store.save=async next=>{await new Promise(resolve=>{release=resolve;});return save(next);};
  const first=runtime.accept(result(prepared.request));
  for(let i=0;i<10&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof release,'function');
  assert.equal((await runtime.accept(result(prepared.request))).status,'request_in_progress');
  release();assert.equal((await first).status,'saved');assert.equal(f.saves,1);
});

test('matching result markers do not conceal dropped preferences during the initial save readback',async()=>{
  const f=fixture(),runtime=f.runtime(),prepared=await runtime.begin({dispatch:false}),save=f.store.save;
  f.store.save=async next=>{await save(next);f.setState({...f.getState(),prefs:{}});};
  const outcome=await runtime.accept(result(prepared.request));
  assert.equal(outcome.status,'save_unverified');assert.equal(outcome.scanCompleted,false);assert.equal(f.getJournal().status,'saving');
  const reopened=await f.runtime().current();assert.equal(reopened.status,'save_unverified');assert.equal(reopened.scanCompleted,false);
  await assert.rejects(f.runtime().accept(result(prepared.request)),error=>error.code==='assistant_saved_state_conflict');
});

test('private journal owner mismatch and extra billing fields are rejected without touching the ledger',async()=>{
  const f=fixture(),runtime=f.runtime();await runtime.begin({dispatch:false});const journal=f.getJournal();
  f.setJournal({...journal,ownerBinding:'d'.repeat(64)});await assert.rejects(runtime.current(),error=>error.code==='assistant_owner_mismatch');
  f.setJournal({...journal,events:[]});await assert.rejects(runtime.current(),error=>error.code==='assistant_journal_invalid');assert.equal(f.saves,0);
});

test('real personal-store save, reopen and subsequent sync preserve exact-day and month confirmations',async()=>{
  for(const precision of ['day','month']) {
    const docs=new Map();let revision=0,journal=null,identity=0;
    const db={collection(path){assert.equal(path,'data/users/synthetic-owner');return {doc(id){return {get:async()=>({exists:docs.has(id),data:()=>clone(docs.get(id))}),set:async value=>{docs.set(id,clone(value));}};}};}};
    const options={hash,revision:()=>String(++revision)},store=createClaudePersonalStore(db,'synthetic-owner',options);await store.load();
    const original={version:1,events:[{id:'synthetic-invoice',messageId:'synthetic-message',serviceKey:'example',service:'Example',category:'Software',kind:'invoice_recorded',authenticated:true,receivedAt:'2026-11-01T12:00:00Z',invoiceAmount:{currency:'USD',minor:2000}}],prefs:{language:'zh-TW',currency:'TWD'}};
    const confirmed=createPaymentConfirmationRuntime().set(original,{eventId:'synthetic-invoice',expectedRevision:0,amount:{currency:'USD',minor:2500},precision,...(precision==='day'?{date:'2026-11-01'}:{month:'2026-11'})},{now});
    await store.saveUserConfirmations(confirmed);
    const config={ownerBinding,hash,clock:()=>now,requestId:()=> 'native-synthetic-request-'+(++identity),requestStorage:{read:async()=>clone(journal),write:async value=>{journal=clone(value);}}};
    const runtime=createAssistantScanRuntime({...config,store}),scan=await runtime.begin({dispatch:false});
    const saved=await runtime.accept(result(scan.request));assert.equal(saved.status,'saved');assert.equal(saved.conflictCount,1);
    assert.deepEqual(saved.state.events,original.events);assert.deepEqual(saved.state.paymentConfirmations,confirmed.paymentConfirmations);
    const reopened=createAssistantScanRuntime({...config,store:createClaudePersonalStore(db,'synthetic-owner',options)}),view=await reopened.current();
    assert.equal(view.status,'saved');assert.deepEqual(view.state.paymentConfirmations,confirmed.paymentConfirmations);
    assert.equal(view.state.assistantReview.length,1);
    const next=await reopened.begin({dispatch:false}),updated=await reopened.accept(result(next.request,{messageId:'synthetic-new-message'}));
    assert.equal(updated.status,'saved');assert.equal(updated.addedCount,1);
    assert.deepEqual(updated.state.paymentConfirmations,confirmed.paymentConfirmations);assert.deepEqual(updated.state.prefs,original.prefs);
    const final=createClaudePersonalStore(db,'synthetic-owner',options);assert.equal((await final.load()).events.length,2);
  }
});
