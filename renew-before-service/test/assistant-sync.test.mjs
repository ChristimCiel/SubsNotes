import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareAssistantSync} from '../src/assistant-sync.mjs';
import {createClaudePersonalStore} from '../src/claude-store.mjs';
import {createClaudeGmailClient} from '../src/claude-gmail.mjs';
import {createWebSync} from '../src/web-sync.mjs';
import {createFxRuntime} from '../src/fx.mjs';
import {extractWebEvidence} from '../src/web-evidence.mjs';
import {digest} from '../src/evidence.mjs';
const runtime={createClaudePersonalStore,createClaudeGmailClient,createWebSync,createFxRuntime,extractWebEvidence,hash:digest};
const runId='synthetic-run';
const asOf='2026-08-15T00:00:00Z';

test('headless planning requests real tools and prepares the same store without performing any external write',async()=>{
  const observations=[],documents=[];
  const first=await prepareAssistantSync({documents,observations,runId,asOf},runtime);
  assert.equal(first.status,'needs_tool');assert.equal(first.requiredTool.args.query,'in:sent from:me');
  observations.push({runId,...first.requiredTool,result:{threads:[{messages:[{id:'synthetic-sent',sender:'owner@example.invalid'}]}]}});
  const second=await prepareAssistantSync({documents,observations,runId,asOf},runtime);
  assert.equal(second.requiredTool.tool,'search_threads');
  observations.push({runId,...second.requiredTool,result:{threads:[{messages:[{id:'synthetic-receipt'}]}],resultCountEstimate:'1'}});
  const third=await prepareAssistantSync({documents,observations,runId,asOf},runtime);
  assert.equal(third.requiredTool.tool,'get_message');
  observations.push({runId,...third.requiredTool,result:{id:'synthetic-receipt',sender:'billing@suno.com',subject:'Subscription receipt',plaintextBody:'Suno Pro. Paid Aug 2, 2026. Amount paid EUR 24.00',date:'2026-08-02T00:00:00Z'}});
  const ready=await prepareAssistantSync({documents,observations,runId,asOf,nativeIndexVersion:'synthetic-version'},runtime);
  assert.equal(ready.status,'ready_to_commit');assert.equal(ready.stored,false);assert.equal(ready.summary.addedEvidence,1);
  assert.equal(ready.writes.at(-1).id,'subsnotes-state-v1');assert.equal(ready.nativeIndexVersion,'synthetic-version');
  assert.deepEqual(documents,[]);
  const nextQuery=await prepareAssistantSync({documents:ready.writes,observations,runId,asOf},runtime);
  assert.equal(nextQuery.status,'needs_tool');
  observations.push({runId,...nextQuery.requiredTool,result:{threads:[{messages:[{id:'synthetic-receipt'}]}],resultCountEstimate:'1'}});
  const again=await prepareAssistantSync({documents:ready.writes,observations,runId,asOf},runtime);
  const fresh=await prepareAssistantSync({documents:ready.writes,observations,runId:'different-run',asOf},runtime);
  assert.equal(fresh.status,'needs_tool');assert.equal(fresh.requiredTool.args.query,'in:sent from:me');
  assert.equal(again.summary.addedEvidence,0);assert.equal(again.summary.eventCount,1);
});


test('headless month review accepts verified checkpoint chunks and forwards only bounded discovery options',async()=>{
  const docs=new Map(),db={collection:()=>({doc:id=>({get:async()=>({exists:docs.has(id),data:()=>structuredClone(docs.get(id))}),set:async value=>{docs.set(id,structuredClone(value));}})})};
  const store=createClaudePersonalStore(db,'current-viewer',{hash:digest});await store.load();
  const sourceProcessing=Object.fromEntries(Array.from({length:1200},(_,i)=>['fictional-source-'+i,['5','needs_review',1,1,null,'unrecognized_format']]));
  await store.save({version:1,events:[],scannedIds:Object.keys(sourceProcessing),sourceProcessing,prefs:{view:'subs'}});
  assert.ok(docs.get('subsnotes-state-v1').sourceProcessingChunks.length);
  const documents=[...docs].map(([id,data])=>({id,data})),snapshot=structuredClone(documents),observations=[];
  const input={documents,observations,runId,asOf,scan:{since:'2026-08-01T00:00:00+09:00',until:'2026-08-02T00:00:00+09:00'}};
  const first=await prepareAssistantSync(input,runtime);assert.equal(first.status,'needs_tool');
  observations.push({runId,...first.requiredTool,result:{threads:[{messages:[{id:'fictional-sent',sender:'viewer@example.invalid'}]}]}});
  const second=await prepareAssistantSync(input,runtime);assert.equal(second.status,'needs_tool');assert.match(second.requiredTool.args.query,/after:1785509999 before:1785596400/);
  assert.deepEqual(documents,snapshot);
  const broken=structuredClone(input);broken.documents=broken.documents.filter(d=>!d.id.startsWith('checkpoints-'));
  await assert.rejects(prepareAssistantSync(broken,runtime),/checkpoint chunk/);
  await assert.rejects(prepareAssistantSync({...input,scan:{unapproved:true}},runtime),/Unsupported discovery options/);
});
