import {mkdir,lstat,readFile,open,rename,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {assertPrivateDirectory} from './private-directory.mjs';
import {acquireFileLock} from './file-lock.mjs';
import {createLedgerStore} from './ledger-store.mjs';
import {createAgentRuntime} from './agent-runtime.mjs';
import {createPaymentConfirmationRuntime} from './payment-confirmations.mjs';
import {createLedgerContracts} from './ledger-contracts.mjs';
import {createVerificationAudit} from './verification-audit.mjs';
import {preserveReceiptVerification} from './receipt-verification.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const allowed=id=>['subsnotes-state-v1','subsnotes-assistant-request-v1'].includes(id)||/^(?:events|checkpoints|confirmations)-[a-f0-9]{64}$/.test(id);
async function metadata(path,{directory=false}={}) {
  const s=await lstat(path);
  if(s.isSymbolicLink()||!(directory?s.isDirectory():s.isFile()))fail('agent_private_file_invalid');
  if(process.platform!=='win32'&&(s.mode&0o077)!==0)fail('agent_private_permissions_required');
  if(!directory&&s.size>2_000_000)fail('agent_private_file_invalid');
  return s;
}
async function readJson(path) {
  try{await metadata(path);return JSON.parse(await readFile(path,'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function writeJson(path,value) {
  const text=JSON.stringify(value);if(Buffer.byteLength(text)>2_000_000)fail('agent_private_file_invalid');
  try{await metadata(path);}catch(e){if(e.code!=='ENOENT')throw e;}
  const temporary=path+'.'+randomUUID()+'.tmp';
  const f=await open(temporary,'wx',0o600);
  try{await f.writeFile(text);await f.sync();}finally{await f.close();}
  await rename(temporary,path);
}
async function openLedger(root,{initialize=false}={}) {
  try{await metadata(root,{directory:true});}catch(error){if(error.code==='ENOENT'&&!initialize)fail('agent_store_uninitialized');throw error;}
  const identityPath=join(root,'agent-identity.json');let identity=await readJson(identityPath);
  if(!identity){
    if(!initialize)fail('agent_store_uninitialized');
    const entries=await readdir(root);
    if(entries.some(name=>['snapshot.json','evidence.json','subsnotes-state-v1.json','ledger-documents'].includes(name)))fail('agent_legacy_store_requires_migration');
    identity={format:'subsnotes-agent-store',version:1,ownerId:randomUUID()};await writeJson(identityPath,identity);
    await mkdir(join(root,'ledger-documents'),{mode:0o700});
  }
  if(identity.format!=='subsnotes-agent-store'||identity.version!==1||typeof identity.ownerId!=='string'||!/^[a-f0-9-]{36}$/.test(identity.ownerId))fail('agent_private_identity_invalid');
  const docs=join(root,'ledger-documents');await metadata(docs,{directory:true});
  const names=await readdir(docs);
  if(!names.includes('subsnotes-state-v1.json')&&names.some(n=>/^(?:events|confirmations|checkpoints)-/.test(n)))fail('agent_store_incomplete');
  const doc=id=>{
    if(!allowed(id))fail('agent_private_file_invalid');
    const path=join(docs,id+'.json');
    return {get:async()=>{const value=await readJson(path);return {exists:value!==null,data:()=>structuredClone(value),metadata:{hasPendingWrites:false}};},set:async value=>{if(!initialize)fail('agent_proposals_disabled');await writeJson(path,value);}};
  };
  const db={collection(path){if(path!=='data/users/'+identity.ownerId)fail('agent_private_namespace_invalid');return {doc};}};
  const baseStore=createLedgerStore(db,identity.ownerId,{hash,revision:randomUUID}),audit=createVerificationAudit({hash});let observed=null;
  const save=async(state,userConfirmationWrite=false)=>{
    const previous=new Map((observed?.events||[]).map(e=>[e.id,e]));
    const next={...state,events:state.events.map(e=>preserveReceiptVerification(previous.get(e.id),e))};
    const audited=await audit.reconcile(observed,next,{confirmationWrite:userConfirmationWrite,observations:state.events});
    const result=await baseStore[userConfirmationWrite?'saveUserConfirmations':'save'](audited);
    observed=await baseStore.load({fresh:true});return result;
  };
  const store={...baseStore,load:async options=>{observed=await baseStore.load(options);return structuredClone(observed);},save:state=>save(state),saveUserConfirmations:state=>save(state,true)};
  const journal=doc('subsnotes-assistant-request-v1');
  return {store,ownerBinding:hash(identity.ownerId),requestStorage:{read:async()=>{const d=await journal.get();return d.exists?d.data():null;},write:async value=>journal.set(value)}};
}

// Every writer holds the same process-independent lock and creates a fresh
// revision-aware store. No assistant can select another path through tool args.
export function createFileAgentAccess({directory,allowProposals=false}={}) {
  if(typeof directory!=='string'||!directory.trim())fail('agent_directory_required');
  if(typeof allowProposals!=='boolean')fail('agent_permission_invalid');
  let rootPromise;
  const writeMethods=new Set(['prepareScan','submitScanResult']);
  async function invoke(method,args={}) {
    const write=writeMethods.has(method),root=await (rootPromise??=assertPrivateDirectory(resolve(directory)));
    if(write&&!allowProposals)fail('agent_proposals_disabled');
    let release=null;
    try{
      if(write){
        await mkdir(root,{recursive:true,mode:0o700});await metadata(root,{directory:true});
        try{release=await acquireFileLock(root);}catch{fail('agent_store_busy');}
      }
      const storage=await openLedger(root,{initialize:write});
      const runtime=createAgentRuntime({...storage,hash,requestId:randomUUID,allowProposals});
      if(!['dashboard','listSubscriptions','billingRecords','evidence','syncStatus',...writeMethods].includes(method))fail('agent_method_invalid');
      return await runtime[method](args);
    }finally{if(release)await release();}
  }
  // Authenticated local UI actions are separate from the assistant tool API.
  // The host OS/session is the trust boundary, not proof that a caller is human.
  async function userAction(action,args={}) {
    if(!allowProposals)fail('agent_user_edits_disabled');
    if(!['confirm','preferences'].includes(action))fail('agent_method_invalid');
    const root=await (rootPromise??=assertPrivateDirectory(resolve(directory)));
    await mkdir(root,{recursive:true,mode:0o700});await metadata(root,{directory:true});
    let release;try{release=await acquireFileLock(root);}catch{fail('agent_store_busy');}
    try{
      const {store}=await openLedger(root,{initialize:true});
      const current=await store.load({fresh:true})||{version:1,events:[],prefs:{}};
      if(action==='confirm'){
        const next=createPaymentConfirmationRuntime().set(current,args);
        await store.saveUserConfirmations(next);
        const saved=await store.load({fresh:true});
        const canonical=createLedgerContracts().canonicalJSON;
        if(!saved||canonical(saved.paymentConfirmations)!==canonical(next.paymentConfirmations))fail('agent_save_unconfirmed');
        return {saved:true,ledgerRevision:saved.storageRevision,confirmation:saved.paymentConfirmations[args.eventId]};
      }
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='language')||!['en','zh-TW'].includes(args.language))fail('agent_preferences_invalid');
      await store.save({...current,prefs:{...(current.prefs||{}),language:args.language}});
      const saved=await store.load({fresh:true});
      if(saved?.prefs?.language!==args.language)fail('agent_save_unconfirmed');
      return {saved:true,ledgerRevision:saved.storageRevision,prefs:{language:saved.prefs.language}};
    }finally{await release();}
  }
  return {invoke,userAction};
}

// Local source adapters share the normal file lock and revision checks. This
// entry point is not exposed through the assistant/MCP proposal API. The host
// adapter reads and verifies original sources before producing source events.
export async function importObservedSources({directory,expectedRevision,mailboxHash,messages,extract,coverage=null}={}) {
  if(typeof extract!=='function'||!Array.isArray(messages)||messages.length>5000||!messages.length)fail('source_adapter_required');
  if(typeof expectedRevision!=='string'||!expectedRevision||!/^([a-f0-9]{64})$/.test(mailboxHash||''))fail('source_identity_required');
  const root=await assertPrivateDirectory(resolve(directory));await metadata(root,{directory:true});
  const release=await acquireFileLock(root);
  try{
    const {store}=await openLedger(root,{initialize:true}),contracts=createLedgerContracts();
    const state=contracts.validateCanonicalState(await store.load({fresh:true}),{requireRevision:true});
    if(state.mailboxHash!=null&&state.mailboxHash!==mailboxHash)fail('source_mailbox_changed');
    if(state.storageRevision!==expectedRevision)fail('source_revision_changed');
    const comparable=e=>{const value={...e};delete value.verificationHistory;return contracts.canonicalJSON(value);};
    const original=new Map(state.events.map(e=>[e.id,comparable(e)]));
    const confirmations=contracts.canonicalJSON(state.paymentConfirmations??{});
    const events=new Map(state.events.map(e=>[e.id,e])),seen=new Set(),accepted=[],duplicates=[];
    const sourceFacts=event=>{
      const value=structuredClone(event);delete value.sourceReadAt;delete value.verificationHistory;
      if(value.receiptVerification)delete value.receiptVerification.checkedAt;
      return contracts.canonicalJSON(value);
    };
    for(const message of messages){
      if(!message?.id||seen.has(message.id)||message.mailboxHash!==mailboxHash||message.sourceFormat!=='connector_plaintext'
        ||typeof message.text!=='string'||!message.text.trim()||!Number.isFinite(Date.parse(message.sourceReadAt)))fail('source_observation_invalid');
      seen.add(message.id);
      const parsed=await extract(structuredClone(message));
      if(!Array.isArray(parsed))fail('source_extraction_invalid');
      for(const event of parsed){
        if(event.messageId!==message.id||event.receivedAt!==message.receivedAt||event.sourceFormat!=='connector_plaintext'||event.sourceReadAt!==message.sourceReadAt
          ||event.userVerified||event.candidateStatus==='accepted'||Object.hasOwn(event,'paymentConfirmations'))fail('source_extraction_invalid');
        contracts.validateCanonicalState({version:1,events:[event]});
        const old=events.get(event.id);
        if(old){
          if(sourceFacts(old)!==sourceFacts(event))fail('source_event_identity_conflict');
          duplicates.push(event.id);continue;
        }
        events.set(event.id,event);accepted.push(event.id);
      }
    }
    if(!accepted.length)return {saved:false,added:0,duplicates:duplicates.length,ledgerRevision:state.storageRevision};
    const next={...state,mailboxHash,events:[...events.values()],lastSourceImportAt:new Date().toISOString(),
      sourceImport:{format:'local-observed-v1',messageCount:messages.length,eventCount:accepted.length,coverage}};
    await store.save(next);
    const saved=contracts.validateCanonicalState(await store.load({fresh:true}),{expectedMailboxHash:mailboxHash,requireRevision:true});
    if(contracts.canonicalJSON(saved.paymentConfirmations??{})!==confirmations||saved.events.length!==next.events.length
      ||saved.events.some(e=>original.has(e.id)&&comparable(e)!==original.get(e.id))
      ||accepted.some(id=>comparable(saved.events.find(e=>e.id===id))!==comparable(events.get(id))))fail('source_save_unconfirmed');
    return {saved:true,added:accepted.length,duplicates:duplicates.length,ledgerRevision:saved.storageRevision,confirmedRecordsPreserved:true,originalRecordsPreserved:original.size};
  }finally{await release();}
}

// Explicit local migration; reads never create or alter audit history. Not an
// assistant/MCP method. Uses the same owner scope, lock and revision checks.
export async function initializeVerificationAudit({directory,expectedRevision}={}){
  const root=await assertPrivateDirectory(resolve(directory)),release=await acquireFileLock(root);
  try{
    const {store}=await openLedger(root,{initialize:true}),state=await store.load({fresh:true});
    if(!state||state.storageRevision!==expectedRevision)fail('source_revision_changed');
    if(state.events.filter(e=>['payment_succeeded','refund_recorded','invoice_recorded'].includes(e.kind)).every(e=>e.verificationHistory?.schemaVersion===1))return {saved:false,ledgerRevision:state.storageRevision};
    await store.save(state);const saved=await store.load({fresh:true});
    return {saved:true,ledgerRevision:saved.storageRevision,auditedRecords:saved.events.filter(e=>e.verificationHistory).length};
  }finally{await release();}
}
