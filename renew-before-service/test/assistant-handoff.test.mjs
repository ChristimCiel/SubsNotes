import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantHandoffRuntime} from '../src/assistant-handoff.mjs';
import {createEvidenceRuntime} from '../src/evidence-runtime.mjs';
import {createPaymentConfirmationRuntime} from '../src/payment-confirmations.mjs';
import {createCashflowRuntime} from '../src/cashflow.mjs';

const runtime=createAssistantHandoffRuntime();
const mailbox='a'.repeat(64);
const request=()=>runtime.createRequest({requestId:'synthetic-review',ledgerRevision:'synthetic-revision'});
function result() {
  const text='Example subscription. Amount paid USD 20.00. Paid on November 1, 2026.';
  const candidate={schemaVersion:1,messageId:'synthetic-message',serviceKey:'example',service:'Example',kind:'payment_succeeded',payment:{currency:'USD',minor:2000},paymentDay:'2026-11-01',fieldEvidence:{}};
  for(const key of ['serviceKey','service','kind','payment','paymentDay'])candidate.fieldEvidence[key]={quote:text};
  return {schemaVersion:1,kind:'subsnotes.assistant-scan-result',requestId:'synthetic-review',ledgerRevision:'synthetic-revision',records:[{candidate,observation:{messageId:'synthetic-message',receivedAt:'2026-11-01T12:00:00Z',observedAt:'2026-11-02T12:00:00Z',mailboxHash:mailbox,text}}],coverage:{queriesComplete:true,attachmentsComplete:false,mailboxExhaustive:false}};
}

test('a scan requests the host assistant without calling Gmail or declaring completion',async()=>{
  const calls=[];
  const bridge=runtime.createBridge({capabilities:{message:{}},sendMessage:async value=>{calls.push(value);return {};}});
  assert.deepEqual(await bridge.requestScan(request()),{status:'awaiting_assistant',requestId:'synthetic-review',scanCompleted:false});
  assert.equal(calls.length,1);assert.equal(calls[0].role,'user');
  assert.match(calls[0].content[0].text,/your authorized Gmail connection/);
  assert.match(calls[0].content[0].text,/SubsNotes must not obtain Gmail authorization/);
});

test('both request locales retain the scope and confirmation-preservation instructions',()=>{
  for(const language of ['en','zh-TW']) {
    const r=runtime.createRequest({requestId:'synthetic',language,scope:'all_available_billing_history'});
    const text=runtime.prompt(r);assert.ok(text.includes('all_available_billing_history'));
    assert.match(text,language==='en'?/confirmed edits/:/我已確認的資料/);
  }
});

test('handoff instructions supply the return schema and only expose an existing opaque mailbox binding',()=>{
  const text=runtime.prompt(request(),{expectedMailboxHash:mailbox});
  assert.match(text,/subsnotes.assistant-scan-result/);assert.match(text,/fieldEvidence/);assert.match(text,/minor/);
  assert.match(text,/email or invoice dates are not payment dates/);assert.ok(text.includes(mailbox));
  assert.throws(()=>runtime.prompt(request(),{expectedMailboxHash:'not-a-mailbox-binding'}),/Invalid expected mailbox binding/);
});

test('missing host message capability produces an explicit handoff, with no direct-mail fallback',async()=>{
  let called=false;
  const bridge=runtime.createBridge({sendMessage:async()=>{called=true;}});
  const outcome=await bridge.requestScan(request());
  assert.equal(outcome.status,'host_message_unavailable');assert.equal(outcome.scanCompleted,false);assert.equal(called,false);
  assert.match(outcome.prompt,/Gmail/);
});

test('host rejection and private provider errors never turn into a successful scan',async()=>{
  const rejected=runtime.createBridge({capabilities:{message:true},sendMessage:async()=>({isError:true})});
  assert.equal((await rejected.requestScan(request())).status,'host_rejected_request');
  const failing=runtime.createBridge({capabilities:{message:true},sendMessage:async()=>{throw new Error('synthetic-private-token');}});
  const outcome=await failing.requestScan(request());assert.equal(outcome.status,'host_request_failed');
  assert.ok(!JSON.stringify(outcome).includes('synthetic-private-token'));
});

test('concurrent clicks cannot dispatch a second request while the first message is in flight',async()=>{
  let resolve,calls=0;
  const bridge=runtime.createBridge({capabilities:{message:true},sendMessage:()=>{calls++;return new Promise(r=>{resolve=r;});}});
  const first=bridge.requestScan(request());
  assert.equal((await bridge.requestScan(request())).status,'request_in_progress');
  resolve({});await first;assert.equal(calls,1);
});

test('repeated acknowledged requests are not sent again and an identity cannot target a changed revision',async()=>{
  let calls=0;
  const bridge=runtime.createBridge({capabilities:{message:true},sendMessage:async()=>{calls++;return {};}});
  await bridge.requestScan(request());
  assert.equal((await bridge.requestScan(request())).status,'awaiting_assistant');
  assert.equal((await bridge.requestScan({...request(),ledgerRevision:'changed-revision'})).status,'request_identity_conflict');
  assert.equal(calls,1);
});

test('failed delivery can be retried without claiming that a scan already exists',async()=>{
  let calls=0;
  const bridge=runtime.createBridge({capabilities:{message:true},sendMessage:async()=>({isError:++calls===1})});
  assert.equal((await bridge.requestScan(request())).status,'host_rejected_request');
  assert.equal((await bridge.requestScan(request())).status,'awaiting_assistant');
  assert.equal(calls,2);
});

test('structured assistant facts use the shared contracts and remain proposals, not trusted source payments',()=>{
  const input=result(),before=JSON.stringify(input);
  const proposal=runtime.validateResult(input,{request:request(),expectedMailboxHash:mailbox});
  assert.equal(JSON.stringify(input),before);assert.equal(proposal.stored,false);assert.equal(proposal.requiresReview,true);
  assert.equal(proposal.sourceAuthenticityVerified,false);assert.equal(proposal.candidates[0].userVerified,false);
  const projection=createEvidenceRuntime(value=>value).projectEvidence(proposal.candidates,{trustConnectorReads:true});
  assert.equal(projection.payments.length,0);assert.equal(projection.heldEvidence.length,1);
});

test('another request, stale revision and mismatched source account are rejected',()=>{
  for(const field of ['requestId','ledgerRevision']) {
    const data=result();data[field]='another';assert.throws(()=>runtime.validateResult(data,{request:request()}),/another/);
  }
  assert.throws(()=>runtime.validateResult(result(),{request:request(),expectedMailboxHash:'b'.repeat(64)}),/another mailbox/);
});

test('credentials, full-message fields and user-confirmation authority cannot enter this result channel',()=>{
  for(const field of ['gmailAccessToken','paymentConfirmations','rawEmails']) {
    const data=result();data[field]='synthetic';assert.throws(()=>runtime.validateResult(data,{request:request()}),/Unsupported/);
  }
  const data=result();data.records[0].observation.fullBody='not accepted';
  assert.throws(()=>runtime.validateResult(data,{request:request()}),/Unsupported/);
  const elevated=result();elevated.records[0].candidate.userVerified=true;
  assert.throws(()=>runtime.validateResult(elevated,{request:request()}),/authority/);
});

test('duplicate candidates and invented evidence cannot silently replace or duplicate records',()=>{
  const duplicate=result();duplicate.records.push(structuredClone(duplicate.records[0]));
  assert.throws(()=>runtime.validateResult(duplicate,{request:request()}),/Duplicate/);
  const invented=result();invented.records[0].candidate.fieldEvidence.payment.quote='Amount paid USD 200.00';
  assert.throws(()=>runtime.validateResult(invented,{request:request()}),/observed source text/);
});

test('query completion never permits an exhaustive-mailbox or completed-attachment claim by omission',()=>{
  const exhaustive=result();exhaustive.coverage.mailboxExhaustive=true;
  assert.throws(()=>runtime.validateResult(exhaustive,{request:request()}),/non-exhaustive/);
  const omitted=result();delete omitted.coverage.attachmentsComplete;
  assert.throws(()=>runtime.validateResult(omitted,{request:request()}),/coverage/);
});

const mergeTime='2026-11-03T12:00:00Z';
const saved=()=>({version:1,storageRevision:'synthetic-revision',mailboxHash:mailbox,events:[],prefs:{language:'zh-TW',currency:'TWD',reviews:{example:'2026-11-05'}},scannedIds:['existing-source'],savedAt:'2026-11-02T12:00:00Z'});
const merge=(state,data=result(),scan=request())=>runtime.prepareMerge({state,result:data,request:scan,observedAt:mergeTime});

test('assistant ingestion prepares a private pending proposal and preserves unrelated state without mutating inputs',()=>{
  const state=saved(),data=result(),before=JSON.stringify({state,data});
  const prepared=merge(state,data);
  assert.equal(JSON.stringify({state,data}),before);
  assert.equal(prepared.stored,false);assert.equal(prepared.sourceAuthenticityVerified,false);
  assert.equal(prepared.addedCount,1);assert.equal(prepared.conflicts.length,0);
  assert.deepEqual(prepared.state.prefs,state.prefs);assert.deepEqual(prepared.state.scannedIds,state.scannedIds);
  assert.equal(prepared.state.savedAt,state.savedAt);assert.equal(prepared.state.storageRevision,state.storageRevision);
  assert.equal(prepared.state.events[0].candidateStatus,'needs_review');
  assert.equal(prepared.state.assistantScan.coverage.attachmentsComplete,false);
  const projection=createEvidenceRuntime(value=>value).projectEvidence(prepared.state.events,{trustConnectorReads:true});
  assert.equal(projection.payments.length,0);assert.equal(projection.heldEvidence.length,1);
});

test('rescans and reopened copies do not duplicate the same facts when observation time changes',()=>{
  const first=merge(saved());
  const reopened=JSON.parse(JSON.stringify(first.state));
  const data=result();data.records[0].observation.observedAt='2026-11-03T12:00:00Z';
  const second=merge(reopened,data);
  assert.equal(second.addedCount,0);assert.equal(second.duplicateCount,1);
  assert.deepEqual(second.state.events,first.state.events);
  const nextRequest={...request(),requestId:'another-scan'},nextResult={...data,requestId:'another-scan'};
  assert.equal(merge(second.state,nextResult,nextRequest).state.events.length,1);
});

test('changed amounts for the same source remain an explicit review conflict, never a replacement',()=>{
  const first=merge(saved());
  const data=result();data.records[0].candidate.payment.minor=2500;
  data.records[0].observation.text+=' Amount paid USD 25.00.';
  data.records[0].candidate.fieldEvidence.payment.quote='Amount paid USD 25.00.';
  const second=merge(first.state,data);
  assert.equal(second.addedCount,0);assert.equal(second.conflicts[0].reason,'source_facts_conflict');
  assert.deepEqual(second.state.events,first.state.events);
  assert.equal(second.state.assistantReview.length,1);
  assert.equal(second.state.assistantReview[0].candidate.payment.minor,2500);
  const replay=merge(second.state,data);
  assert.equal(replay.state.assistantReview.length,1);assert.equal(replay.duplicateCount,1);
});

test('fresh revision and trusted mailbox binding are mandatory before a merge can be prepared',()=>{
  const stale=saved();stale.storageRevision='new-revision';
  assert.throws(()=>merge(stale),/revision changed/);
  const wrong=saved();wrong.mailboxHash='b'.repeat(64);
  assert.throws(()=>runtime.prepareMerge({state:wrong,result:result(),request:request(),expectedMailboxHash:mailbox,observedAt:mergeTime}),/different mailbox/);
  const unbound=saved();delete unbound.mailboxHash;
  assert.throws(()=>merge(unbound),/trusted mailbox binding/);
  const bound=runtime.prepareMerge({state:unbound,result:result(),request:request(),expectedMailboxHash:mailbox,observedAt:mergeTime});
  assert.equal(bound.state.mailboxHash,mailbox);
});

test('a first assistant-owned ledger can be host-owner bound without granting mailbox authority',()=>{
  const state={version:1,events:[],prefs:{language:'en'}},ownerBinding='c'.repeat(64);
  const scan=runtime.createRequest({requestId:'synthetic-review'}),data=result();data.ledgerRevision=null;
  const prepared=runtime.prepareMerge({state,result:data,request:scan,ownerBinding,observedAt:mergeTime});
  assert.equal(prepared.mailboxBinding,'unverified');
  assert.equal(prepared.sourceAuthenticityVerified,false);assert.equal(prepared.stored,false);
  assert.equal(prepared.state.assistantOwnerBinding,ownerBinding);
  assert.equal(prepared.state.assistantMailboxBinding,'unverified');
  assert.equal(Object.hasOwn(prepared.state,'mailboxHash'),false);
  assert.equal(prepared.state.events[0].authenticated,false);assert.equal(prepared.state.events[0].candidateStatus,'needs_review');
  const reopened=JSON.parse(JSON.stringify(prepared.state));
  assert.equal(runtime.prepareMerge({state:reopened,result:data,request:scan,ownerBinding,observedAt:mergeTime}).duplicateCount,1);
  assert.throws(()=>runtime.prepareMerge({state:reopened,result:data,request:scan,ownerBinding:'d'.repeat(64),observedAt:mergeTime}),/another host owner/);
  assert.throws(()=>runtime.prepareMerge({state:reopened,result:data,request:scan,observedAt:mergeTime}),/another host owner/);
});

test('host-owner binding never bypasses an existing mailbox identity guard',()=>{
  const state=saved(),data=result();data.records[0].observation.mailboxHash='b'.repeat(64);
  assert.throws(()=>runtime.prepareMerge({state,result:data,request:request(),ownerBinding:'c'.repeat(64),observedAt:mergeTime}),/another mailbox/);
});

test('source updates cannot overwrite exact-day or month confirmations or reclassify their spending',()=>{
  for(const precision of ['day','month']) {
    const state=saved();
    state.events=[{id:'invoice-source',messageId:'synthetic-message',serviceKey:'example',service:'Example',category:'Software',kind:'invoice_recorded',receivedAt:'2026-11-01T12:00:00Z',invoiceAmount:{currency:'USD',minor:2000},invoiceDay:'2026-11-01',authenticated:true}];
    const confirmed=createPaymentConfirmationRuntime().set(state,{eventId:'invoice-source',expectedRevision:0,amount:{currency:'USD',minor:2500},precision,...(precision==='day'?{date:'2026-11-01'}:{month:'2026-11'})},{now:'2026-11-02T12:00:00Z'});
    const data=result();data.records[0].candidate.kind='one_time_purchase';
    const prepared=merge(confirmed,data);
    assert.equal(prepared.conflicts[0].reason,'confirmed_record_protected');
    assert.deepEqual(prepared.state.events,confirmed.events);
    assert.deepEqual(prepared.state.paymentConfirmations,confirmed.paymentConfirmations);
    assert.equal(prepared.state.assistantReview[0].candidate.kind,'one_time_purchase');
    const project=createEvidenceRuntime(value=>value),cashflow=createCashflowRuntime();
    const summarize=value=>cashflow.summarize(project.projectEvidence(value.events),{paymentConfirmations:value.paymentConfirmations,month:'2026-11'});
    assert.deepEqual(summarize(prepared.state).paidMinorByCurrency,summarize(confirmed).paidMinorByCurrency);
    assert.equal(summarize(prepared.state).paidMinorByCurrency.USD,2500);
  }
});

test('new records append while previously saved sources and confirmation histories remain intact',()=>{
  const first=merge(saved());
  const data=result();data.records[0].candidate.messageId='another-message';data.records[0].observation.messageId='another-message';
  const next=merge(first.state,data);
  assert.equal(next.state.events.length,2);assert.equal(next.addedCount,1);
  assert.deepEqual(next.state.events[0],first.state.events[0]);
});
