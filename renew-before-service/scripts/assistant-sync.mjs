import {readFile,mkdir,open,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertPrivateDirectory} from '../src/private-directory.mjs';
import {createLedgerContracts} from '../src/ledger-contracts.mjs';
import {prepareAssistantSync} from '../src/assistant-sync.mjs';
import {createClaudePersonalStore} from '../src/claude-store.mjs';
import {createClaudeGmailClient} from '../src/claude-gmail.mjs';
import {createWebSync} from '../src/web-sync.mjs';
import {createFxRuntime} from '../src/fx.mjs';
import {extractWebEvidence} from '../src/web-evidence.mjs';

// An approved host supplies real tool observations and executes any resulting
// calls/writes itself. This local command only prepares a private JSON plan.
export async function runAssistantSync(args,api) {
  const options={};
  for(let i=0;i<args.length;i++){
    const flag=args[i];
    if(flag==='--help')return {help:true};
    if(!['--input','--output'].includes(flag)||!args[i+1]||args[i+1].startsWith('--')||Object.hasOwn(options,flag.slice(2)))throw new Error('Use --input PRIVATE_JSON --output PRIVATE_JSON');
    options[flag.slice(2)]=args[++i];
  }
  if(!options.input||!options.output)throw new Error('--input and --output are required');
  const {fs,paths,privateDirectory,contracts,runtime,prepare}=api;
  const requested=paths.resolve(options.input),inputParent=await privateDirectory(paths.dirname(requested));
  const input=paths.resolve(inputParent,paths.basename(requested)),stat=await fs.lstat(input);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>25_000_000)throw new Error('Use a private regular input file smaller than 25 MB');
  const encoded=await fs.readFile(input,'utf8');
  if(new TextEncoder().encode(encoded).length>25_000_000)throw new Error('Use a private regular input file smaller than 25 MB');
  let payload;
  try{payload=JSON.parse(encoded);}catch{throw new Error('Invalid sync JSON');}
  // JSON/schema validation is not connector authentication. Observations must
  // originate from the host; this command cannot attest a caller-supplied file.
  contracts.canonicalJSON(payload);
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||!Array.isArray(payload.documents)||!Array.isArray(payload.observations)
    ||typeof payload.runId!=='string'||!payload.runId.trim()||payload.runId.length>200||typeof payload.asOf!=='string'||!payload.asOf.includes('T')||!Number.isFinite(Date.parse(payload.asOf)))throw new Error('A run identity, processing time, documents and observations are required');
  const documents=new Map();
  for(const doc of payload.documents){
    if(!doc||typeof doc!=='object'||!(doc.id==='subsnotes-state-v1'||/^(?:events|checkpoints|confirmations)-[a-f0-9]{64}$/.test(doc.id))||!doc.data||typeof doc.data!=='object'||Array.isArray(doc.data)||documents.has(doc.id))throw new Error('Invalid or duplicate private document');
    documents.set(doc.id,doc.data);
  }
  const observations=new Map();
  for(const observation of payload.observations){
    if(!observation||observation.runId!==payload.runId||observation.server!=='Gmail'||!['search_threads','get_message'].includes(observation.tool)
      ||!observation.args||typeof observation.args!=='object'||Array.isArray(observation.args)||!Object.hasOwn(observation,'result')||typeof observation.observedAt!=='string'||!observation.observedAt.includes('T')||!Number.isFinite(Date.parse(observation.observedAt)))throw new Error('Use actual dated Gmail read observations from this run');
    const key=observation.tool+'|'+contracts.canonicalJSON(observation.args),value=contracts.canonicalJSON(observation.result);
    if(observations.has(key)&&observations.get(key)!==value)throw new Error('Conflicting connector observations');
    observations.set(key,value);
  }
  // Reuse the canonical loader, including immutable chunk hash verification.
  const readOnlyDb={collection(path){if(path!=='data/users/current-viewer')throw new Error('Unexpected private namespace');return {doc(id){return {
    get:async()=>({exists:documents.has(id),data:()=>structuredClone(documents.get(id)),metadata:{hasPendingWrites:false}}),
    set:async()=>{throw new Error('Input validation cannot write records');}
  };}};}};
  const existing=await runtime.createClaudePersonalStore(readOnlyDb,'current-viewer',{hash:runtime.hash}).load();
  if(existing)contracts.validateCanonicalState(existing);
  const plan=await prepare(payload,runtime);
  if(!plan||plan.stored!==false||!['needs_tool','ready_to_commit'].includes(plan.status))throw new Error('Unsupported sync plan');
  if(plan.status==='ready_to_commit'){
    const value=payload.nativeIndexVersion;
    if(!(typeof value==='string'&&value.trim()&&value.length<=256)&&!(Number.isSafeInteger(value)&&value>=0))throw new Error('A native conditional storage version is required before preparing a commit');
  }
  const result={...plan,stored:false,executionMode:'plan-only',sourceAuthenticityVerified:false};
  const content=JSON.stringify(result,null,2)+'\n';
  if(new TextEncoder().encode(content).length>25_000_000)throw new Error('The private sync plan exceeds 25 MB');
  const parent=await privateDirectory(paths.dirname(paths.resolve(options.output))),output=paths.resolve(parent,paths.basename(options.output));
  if(output===input)throw new Error('Input and output files must be different');
  try{await fs.lstat(output);throw new Error('Output already exists. Choose a new private filename');}catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.mkdir(parent,{recursive:true,mode:0o700});
  const file=await fs.open(output,'wx',0o600);
  try{await file.writeFile(content,'utf8');}finally{await file.close();}
  return {status:result.status,stored:false,executionMode:'plan-only'};
}

export async function main(args=process.argv.slice(2)){
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const result=await runAssistantSync(args,{fs:{readFile,mkdir,open,lstat},paths:{basename,dirname,resolve},privateDirectory:assertPrivateDirectory,
    contracts:createLedgerContracts(),prepare:prepareAssistantSync,
    runtime:{createClaudePersonalStore,createClaudeGmailClient,createWebSync,createFxRuntime,extractWebEvidence,hash}});
  if(result.help)console.log('Prepare a private sync plan: --input PRIVATE_JSON --output PRIVATE_JSON. Supply actual dated host observations and the observed native conditional storage version. No network calls or external storage writes are performed. Source observations are not authenticated by this command. Existing files are never overwritten.');
  else console.log('Created a private '+result.status+' plan. Nothing was stored externally.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(process.argv[1])).href){
  main().catch(error=>{console.error(error.code?'Private file access failed ('+String(error.code).replace(/[^A-Z0-9_]/g,'')+')':error.message);process.exitCode=1;});
}
