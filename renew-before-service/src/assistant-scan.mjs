import {createAssistantHandoffRuntime} from './assistant-handoff.mjs';
import {createLedgerContracts} from './ledger-contracts.mjs';

// Only the host assistant retrieves mail. This controller keeps request
// metadata separate from the financial ledger and confirms writes by readback.
export function createAssistantScanRuntime({store,ownerBinding,requestStorage,hash,hostBridge=null,clock=()=>new Date().toISOString(),requestId=()=>crypto.randomUUID()}={}) {
  const handoff=createAssistantHandoffRuntime(),contracts=createLedgerContracts();
  const canonical=contracts.canonicalJSON;
  const fail=code=>{const error=new Error(code);error.code=code;throw error;};
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const instant=value=>typeof value==='string'&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
  const statuses=new Set(['prepared','awaiting_assistant','host_message_unavailable','host_rejected_request','host_request_failed','saving','save_unverified','saved']);
  if(!store||typeof store.load!=='function'||typeof store.save!=='function'||!requestStorage||typeof requestStorage.read!=='function'||typeof requestStorage.write!=='function'||typeof hash!=='function'||!digest(ownerBinding))fail('assistant_configuration_invalid');
  let busy=false;
  const now=()=>{const value=clock();if(!instant(value))fail('assistant_clock_invalid');return value;};
  function validateJournal(input) {
    if(input==null)return null;
    let journal;
    try{journal=JSON.parse(canonical(input));}catch{fail('assistant_journal_invalid');}
    if(!object(journal)||Object.keys(journal).some(key=>!['schemaVersion','ownerBinding','request','status','createdAt','updatedAt','resultHash','stateHash','counts','mailboxBinding','expectedMailboxHash'].includes(key))||journal.schemaVersion!==1||!statuses.has(journal.status)||!instant(journal.createdAt)||!instant(journal.updatedAt))fail('assistant_journal_invalid');
    if(journal.ownerBinding!==ownerBinding)fail('assistant_owner_mismatch');
    try{handoff.prompt(journal.request,{expectedMailboxHash:journal.expectedMailboxHash??null});}catch{fail('assistant_journal_invalid');}
    if(journal.resultHash!=null&&!digest(journal.resultHash)||journal.stateHash!=null&&!digest(journal.stateHash)||journal.expectedMailboxHash!=null&&!digest(journal.expectedMailboxHash))fail('assistant_journal_invalid');
    if(journal.mailboxBinding!=null&&!['bound','unverified'].includes(journal.mailboxBinding))fail('assistant_journal_invalid');
    if(journal.counts!=null&&(!object(journal.counts)||Object.keys(journal.counts).some(key=>!['addedCount','duplicateCount','conflictCount'].includes(key))||['addedCount','duplicateCount','conflictCount'].some(key=>!Number.isSafeInteger(journal.counts[key])||journal.counts[key]<0)))fail('assistant_journal_invalid');
    if(new TextEncoder().encode(canonical(journal)).length>16_000)fail('assistant_journal_invalid');
    return journal;
  }
  async function readJournal() {
    let value;try{value=await requestStorage.read();}catch{fail('assistant_journal_unavailable');}
    return validateJournal(value);
  }
  async function writeJournal(value) {
    const journal=validateJournal(value);
    try{await requestStorage.write(journal);}catch{fail('assistant_journal_not_saved');}
    const confirmed=await readJournal();
    if(canonical(confirmed)!==canonical(journal))fail('assistant_journal_not_saved');
    return confirmed;
  }
  async function load() {
    let state;try{state=await store.load({fresh:true});}catch{fail('assistant_ledger_unavailable');}
    try{return contracts.validateCanonicalState(state||{version:1,events:[],prefs:{}});}catch{fail('assistant_ledger_invalid');}
  }
  const view=(journal,extra={})=>journal?{status:journal.status,request:journal.request,prompt:handoff.prompt(journal.request,{expectedMailboxHash:journal.expectedMailboxHash??null}),scanCompleted:journal.status==='saved',...(journal.counts||{}),...(journal.mailboxBinding?{mailboxBinding:journal.mailboxBinding}:{}),...extra}:{status:'ready',request:null,prompt:null,scanCompleted:false,...extra};
  const markerMatches=(state,journal)=>Boolean(journal.resultHash&&state?.assistantScan?.requestId===journal.request.requestId&&state.assistantScan.resultHash===journal.resultHash);
  const financialState=value=>{const {storageRevision,storageFormat,eventChunks,sourceProcessingChunks,paymentConfirmationChunks,scannedIdsFormat,...rest}=value;
    // The private host appends its audit history during commit. Compare every
    // financial/source field exactly; that generated history is not a proposal.
    return {...rest,events:(rest.events||[]).map(e=>{const {verificationHistory,...facts}=e;return facts;})};};
  async function stateDigest(state){let value;try{value=await hash(canonical(financialState(state)));}catch{fail('assistant_result_invalid');}if(!digest(value))fail('assistant_result_invalid');return value;}
  async function finish(journal,state,extra={}) {
    const completed={...journal,status:'saved',updatedAt:now()};
    try{await writeJournal(completed);return view(completed,{state,...extra});}
    catch{return view(completed,{state,...extra,status:'savedWithJournalWarning',scanCompleted:true});}
  }
  async function current() {
    const journal=await readJournal();
    if(!journal)return view(null);
    if(['saving','save_unverified','saved'].includes(journal.status)&&journal.resultHash){
      const state=await load();
      if(markerMatches(state,journal)){
        if(journal.status==='saved')return view(journal,{state});
        if(journal.stateHash&&await stateDigest(state)===journal.stateHash)return finish(journal,state,{recovered:true});
        return view({...journal,status:'save_unverified'});
      }
      if(journal.status==='saved')return view({...journal,status:'save_unverified'});
    }
    return view(journal);
  }
  async function dispatch(journal) {
    const bridge=hostBridge&&typeof hostBridge.requestScan==='function'?hostBridge:handoff.createBridge(hostBridge||{});
    let outcome;
    try{outcome=await bridge.requestScan(journal.request,{expectedMailboxHash:journal.expectedMailboxHash??null});}catch{outcome={status:'host_request_failed'};}
    const status=['awaiting_assistant','host_message_unavailable','host_rejected_request','host_request_failed'].includes(outcome?.status)?outcome.status:'host_request_failed';
    const next=await writeJournal({...journal,status,updatedAt:now()});
    return view(next);
  }
  async function begin({language='en',scope='new_and_unresolved',dispatch:shouldDispatch=true,restart=false}={}) {
    if(busy)return {status:'request_in_progress',scanCompleted:false};
    busy=true;
    try{
      const prior=await readJournal();
      if(prior&&prior.status!=='saved'&&(!restart||['saving','save_unverified'].includes(prior.status))){
        if(['saving','save_unverified'].includes(prior.status))return await current();
        const state=await load();
        if((state.storageRevision||null)!==prior.request.ledgerRevision)fail('assistant_request_stale');
        if(!shouldDispatch||prior.status==='awaiting_assistant')return view(prior);
        return await dispatch(prior);
      }
      const state=await load(),request=handoff.createRequest({requestId:requestId(),ledgerRevision:state.storageRevision||null,language,scope}),createdAt=now();
      const journal=await writeJournal({schemaVersion:1,ownerBinding,request,status:'prepared',createdAt,updatedAt:createdAt,...(state.mailboxHash?{expectedMailboxHash:state.mailboxHash}:{})});
      return shouldDispatch?await dispatch(journal):view(journal);
    }finally{busy=false;}
  }
  async function markDispatched({requestId:identity,status='awaiting_assistant'}={}) {
    if(busy)return {status:'request_in_progress',scanCompleted:false};
    if(!['awaiting_assistant','host_rejected_request','host_request_failed'].includes(status))fail('assistant_dispatch_invalid');
    const journal=await readJournal();
    if(!journal||journal.request.requestId!==identity)fail('assistant_request_mismatch');
    if(['saving','save_unverified','saved'].includes(journal.status))return view(journal);
    return view(await writeJournal({...journal,status,updatedAt:now()}));
  }
  async function accept(result) {
    if(busy)return {status:'request_in_progress',scanCompleted:false};
    busy=true;
    try{
      const journal=await readJournal();if(!journal)fail('assistant_request_missing');
      if(result?.requestId!==journal.request.requestId||result?.ledgerRevision!==journal.request.ledgerRevision)fail('assistant_request_mismatch');
      let resultHash;try{const encoded=canonical(result);if(new TextEncoder().encode(encoded).length>2_000_000)fail('assistant_result_invalid');resultHash=await hash(encoded);}catch{fail('assistant_result_invalid');}
      if(!digest(resultHash))fail('assistant_result_invalid');
      if(journal.resultHash&&journal.resultHash!==resultHash)fail('assistant_result_conflict');
      const state=await load();
      if(markerMatches(state,{...journal,resultHash})){
        if(journal.status==='saved'||journal.stateHash&&await stateDigest(state)===journal.stateHash)return await finish({...journal,resultHash},state,{replayed:true});
        fail('assistant_saved_state_conflict');
      }
      if(journal.status==='saved')fail('assistant_saved_result_unavailable');
      if((state.storageRevision||null)!==journal.request.ledgerRevision)fail('assistant_request_stale');
      let prepared;
      try{prepared=handoff.prepareMerge({state,result,request:journal.request,expectedMailboxHash:journal.expectedMailboxHash??null,ownerBinding,observedAt:now()});}catch{fail('assistant_result_invalid');}
      const counts={addedCount:prepared.addedCount,duplicateCount:prepared.duplicateCount,conflictCount:prepared.conflicts.length};
      const next={...prepared.state,assistantScan:{...prepared.state.assistantScan,resultHash}};
      const committing=await writeJournal({...journal,status:'saving',updatedAt:now(),resultHash,stateHash:await stateDigest(next),counts,mailboxBinding:prepared.mailboxBinding});
      let saveFailed=false;
      try{await store.save(next);}catch{saveFailed=true;}
      let confirmed;
      try{confirmed=await load();}catch{return view({...committing,status:'save_unverified'});}
      if(!markerMatches(confirmed,committing)||canonical(financialState(confirmed))!==canonical(financialState(next))){
        if(saveFailed)fail('assistant_save_failed');
        return view({...committing,status:'save_unverified'});
      }
      return await finish(committing,confirmed);
    }finally{busy=false;}
  }
  return {current,begin,markDispatched,accept};
}
