// Headless hosts call their own approved tools. This function only plans calls
// and prepares data writes; it never claims a proposed write reached storage.
export async function prepareAssistantSync({documents,observations=[],runId,asOf,fxSnapshot=null,nativeIndexVersion=null,scan={}},runtime) {
  const {createClaudePersonalStore,createClaudeGmailClient,createWebSync,createFxRuntime,extractWebEvidence,hash}=runtime;
  if(!Array.isArray(documents)||!Array.isArray(observations)||!runId||!Number.isFinite(Date.parse(asOf)))throw new Error('Observed documents, a fresh run identity and a processing time are required');
  if(!scan||typeof scan!=='object'||Array.isArray(scan)||Object.keys(scan).some(key=>!['since','until','includeSpamTrash','recentOnly','maxReads'].includes(key)))throw new Error('Unsupported discovery options');
  const canonical=value=>JSON.stringify(value,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
  const records=new Map(documents.filter(d=>d.id==='subsnotes-state-v1'||/^(?:events|checkpoints|confirmations)-[a-f0-9]{64}$/.test(d.id)).map(d=>[d.id,structuredClone(d.data)]));
  const writes=[],allowed=id=>id==='subsnotes-state-v1'||/^(?:events|checkpoints|confirmations)-[a-f0-9]{64}$/.test(id);
  const db={collection(path){if(path!=='data/users/current-viewer')throw new Error('Unexpected storage namespace');return {doc(id){if(!allowed(id))throw new Error('Unexpected record path');return {
    get:async()=>({exists:records.has(id),data:()=>structuredClone(records.get(id)),metadata:{hasPendingWrites:false}}),
    set:async data=>{records.set(id,structuredClone(data));writes.push({id,data:structuredClone(data)});}
  };}};}};
  const store=createClaudePersonalStore(db,'current-viewer',{hash});
  const previous=await store.load();
  let lastReadAt=asOf;
  const mcp={callTool:async(server,tool,args)=>{
    if(server!=='Gmail'||!['search_threads','get_message'].includes(tool))throw new Error('Only Gmail read tools are permitted');
    const found=observations.find(o=>o.runId===runId&&o.server===server&&o.tool===tool&&canonical(o.args)===canonical(args));
    if(!found){const e=new Error('A real connector reply is required');e.requiredTool={server,tool,args};throw e;}
    lastReadAt=found.observedAt||asOf;
    const result=found.result;
    return result&&(Array.isArray(result.threads)||result.id)?{payload:result}:result;
  }};
  const save=store.save;
  store.save=state=>save({...state,lastAssistantUpdateAt:asOf,...(fxSnapshot?{fxSnapshot:createFxRuntime().validateSnapshot(fxSnapshot,new Date(asOf))}:{})});
  try {
    const result=await createWebSync({gmail:createClaudeGmailClient(mcp,{clock:()=>lastReadAt}),store,extract:extractWebEvidence,hash,clock:()=>asOf}).run(scan);
    const before=new Set((previous?.events||[]).map(e=>e.id));
    return {status:'ready_to_commit',stored:false,writes,nativeIndexVersion,
      summary:{complete:result.complete,readCount:result.readCount,addedEvidence:result.state.events.filter(e=>!before.has(e.id)).length,eventCount:result.state.events.length}};
  } catch(error) {
    if(error.requiredTool)return {status:'needs_tool',stored:false,requiredTool:error.requiredTool};
    throw error;
  }
}
