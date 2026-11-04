import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClaudePersonalStore} from '../src/claude-store.mjs';
import {digest} from '../src/evidence.mjs';

function fixture(){const docs=new Map(),writes=[];let fail=false,n=0;return {docs,writes,set fail(value){fail=value;},options:{hash:digest,revision:()=>String(++n),maxBytes:1200},db:{collection(path){assert.equal(path,'data/users/synthetic-viewer');return {doc(id){return {get:async()=>({exists:docs.has(id),data:()=>structuredClone(docs.get(id))}),set:async value=>{if(fail&&id.startsWith('events-'))throw new Error('write failed');writes.push(id);docs.set(id,structuredClone(value));}};}};}}};}

test('chunked storage reloads a history larger than a single document without shared paths',async()=>{
  const f=fixture(),store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);
  await store.load();const state={version:1,savedAt:'2026-08-15T00:00:00Z',events:Array.from({length:10},(_,i)=>({id:'fiction-'+i,evidence:'a'.repeat(500)}))};
  await store.save(state);const reopened=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);
  assert.deepEqual((await reopened.load()).events,state.events);
  assert.ok(f.docs.get('subsnotes-state-v1').eventChunks.length>1);
  assert.ok(!Object.hasOwn(f.docs.get('subsnotes-state-v1'),'events'));
});

test('a failed chunk write preserves the prior manifest and a stale writer cannot replace it',async()=>{
  const f=fixture(),a=createClaudePersonalStore(f.db,'synthetic-viewer',f.options),b=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);
  await a.load();await a.save({events:[],savedAt:'first'});await b.load();
  const before=structuredClone(f.docs.get('subsnotes-state-v1'));f.fail=true;
  await assert.rejects(a.save({events:[{id:'fiction'}],savedAt:'second'}),/write failed/);
  assert.deepEqual(f.docs.get('subsnotes-state-v1'),before);f.fail=false;
  await a.save({events:[],savedAt:'second'});
  await assert.rejects(b.save({events:[],savedAt:'third'}),/another tab/);
});

test('round trips remain readable after database key sorting and undefined field removal',async()=>{
  const f=fixture(),base=f.db.collection;
  const sorted=value=>JSON.parse(JSON.stringify(value,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x));
  f.db.collection=path=>{const c=base(path);return {doc:id=>{const d=c.doc(id);return {...d,set:value=>d.set(sorted(value))};}};};
  const store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();
  await store.save({events:[{z:2,id:'synthetic',a:{z:3,a:1},reference:undefined}],savedAt:'fixture'});
  const state=await createClaudePersonalStore(f.db,'synthetic-viewer',f.options).load();
  assert.deepEqual(state.events,[{a:{a:1,z:3},id:'synthetic',z:2}]);
});

test('an injected conditional commit rejects an interleaved writer without replacing its manifest',async()=>{
  const f=fixture();let injectConflict=false;
  const conditionalCommit=async({expectedRevision,next})=>{
    if(injectConflict)f.docs.set('subsnotes-state-v1',{storageRevision:'concurrent-writer',events:[]});
    const current=f.docs.get('subsnotes-state-v1');
    if((current?.storageRevision||current?.savedAt||null)!==expectedRevision)return false;
    f.docs.set('subsnotes-state-v1',structuredClone(next));return true;
  };
  const store=createClaudePersonalStore(f.db,'synthetic-viewer',{...f.options,conditionalCommit});await store.load();
  assert.equal(store.concurrency,'conditional_commit');
  assert.equal((await store.save({events:[],savedAt:'first'})).concurrency,'conditional_commit');
  injectConflict=true;await assert.rejects(store.save({events:[{id:'new'}]}),/conditional commit/);
  assert.equal(f.docs.get('subsnotes-state-v1').storageRevision,'concurrent-writer');
  await assert.rejects(store.save({events:[]}),/uncertain/);
  assert.equal((await store.load()).storageRevision,'concurrent-writer');
});

test('unconditional SDK writes are explicitly single-writer and must pass manifest readback',async()=>{
  const f=fixture(),base=f.db.collection;let drop=false;
  f.db.collection=path=>{const c=base(path);return {doc:id=>{const d=c.doc(id);return {...d,set:value=>id==='subsnotes-state-v1'&&drop?Promise.resolve():d.set(value)};}};};
  const store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();
  assert.equal(store.concurrency,'single_writer');await store.save({events:[],savedAt:'before'});
  const before=structuredClone(f.docs.get('subsnotes-state-v1'));drop=true;
  await assert.rejects(store.save({events:[{id:'uncommitted'}],savedAt:'after'}),/did not confirm/);
  assert.deepEqual(f.docs.get('subsnotes-state-v1'),before);
  await assert.rejects(store.save({events:[]}),/uncertain/);
  assert.deepEqual((await store.load()).events,[]);
  // Failed commits can leave immutable chunks. They are retained, never deleted.
  assert.ok([...f.docs.keys()].some(id=>id.startsWith('events-')));
});

test('a failed chunk integrity check does not advance the loaded revision',async()=>{
  const f=fixture(),store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();
  await store.save({events:[{id:'saved'}],savedAt:'first'});
  const before=structuredClone(f.docs.get('subsnotes-state-v1'));
  const broken={...before,storageRevision:'corrupt-revision',eventChunks:['a'.repeat(64)]};f.docs.set('subsnotes-state-v1',broken);
  await assert.rejects(store.load(),/unavailable/);
  await assert.rejects(store.save({events:[]}),/uncertain/);
  f.docs.set('subsnotes-state-v1',before);assert.deepEqual((await store.load()).events,[{id:'saved'}]);
});

test('reopening uses bounded parallel reads; verified chunk reuse stays viewer-scoped and refresh can bypass it',async()=>{
  const f=fixture(),writer=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await writer.load();
  await writer.save({events:Array.from({length:8},(_,i)=>({id:'fiction-'+i,evidence:'a'.repeat(700)})),savedAt:'first'});
  const base=f.db.collection;let active=0,maxActive=0,chunkReads=0;
  f.db.collection=path=>{const c=base(path);return {doc:id=>{const ref=c.doc(id);return {...ref,get:async()=>{if(!id.startsWith('events-'))return ref.get();chunkReads++;active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setImmediate(resolve));const value=await ref.get();active--;return value;}};}};};
  const reader=createClaudePersonalStore(f.db,'synthetic-viewer',f.options),first=await reader.load();
  assert.equal(first.events.length,8);assert.equal(chunkReads,8);assert.equal(maxActive,4);
  first.events[0].evidence='edited-by-caller';const cached=await reader.load();
  assert.equal(chunkReads,8);assert.equal(cached.events[0].evidence,'a'.repeat(700));
  await reader.load({fresh:true});assert.equal(chunkReads,16);
  const otherSession=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await otherSession.load();assert.equal(chunkReads,24);
});

test('a forced refresh detects corruption instead of trusting an old memory cache',async()=>{
  const f=fixture(),store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();
  await store.save({events:[{id:'fiction'}],savedAt:'first'});await store.load();
  const manifest=f.docs.get('subsnotes-state-v1'),key='events-'+manifest.eventChunks[0];
  f.docs.set(key,{events:[{id:'corrupted'}]});await assert.rejects(store.load({fresh:true}),/did not match/);
  assert.equal((await store.load()).events[0].id,'fiction');
});

test('checkpoint compaction preserves every message identity and processing record without dropping history',async()=>{
  const f=fixture(),store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();
  const ids=Array.from({length:10},(_,i)=>'fictional-message-'+String(i).padStart(30,'0'));
  const processing=Object.fromEntries(ids.map(id=>[id,['3','extracted',1,1,null,null]]));
  const state={events:[],scannedIds:ids,sourceProcessing:processing,sourceProcessingFormat:'tuple-v1',savedAt:'first'};
  assert.ok(new TextEncoder().encode(JSON.stringify({...state,storageFormat:'chunks-v1',eventChunks:[],storageRevision:'1'})).length>1200);
  await store.save(state);const native=f.docs.get('subsnotes-state-v1');
  assert.equal(native.scannedIds,undefined);assert.equal(native.scannedIdsFormat,'processing-keys-v1');
  const loaded=await createClaudePersonalStore(f.db,'synthetic-viewer',f.options).load();
  assert.deepEqual(new Set(loaded.scannedIds),new Set(ids));assert.deepEqual(loaded.sourceProcessing,processing);
  assert.deepEqual(loaded.events,[]);
});

test('incomplete old checkpoints retain unmatched IDs instead of silently compacting them away',async()=>{
  const f=fixture(),store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();
  await store.save({events:[],scannedIds:['known','not-yet-reprocessed'],sourceProcessing:{known:['2','extracted',1,1,null,null]}});
  const native=f.docs.get('subsnotes-state-v1');assert.deepEqual(native.scannedIds,['known','not-yet-reprocessed']);assert.equal(native.scannedIdsFormat,undefined);
});

const checkpointState=count=>{
  const ids=Array.from({length:count},(_,i)=>'synthetic-mail-'+i.toString(16).padStart(16,'0'));
  return {version:1,events:[{id:'synthetic-source',evidence:'Synthetic billing fact'}],scannedIds:ids,
    sourceProcessing:Object.fromEntries(ids.map((id,i)=>[id,i%13===0
      ?['5','extracted',1,1800000000000,null,null,['non_billing','a'.repeat(64)]]
      :['5','needs_review',1,1800000000000,1800086400000,'unrecognized_format']])),
    sourceProcessingFormat:'tuple-v1',prefs:{language:'en',month:'2027-06',currency:'EUR',autoRefresh:false}};
};

test('large checkpoint histories spill into verified immutable chunks and reopen with every source and preference',async()=>{
  for(const count of [1200,6000]){
    const f=fixture(),options={...f.options,maxBytes:60000},writer=createClaudePersonalStore(f.db,'synthetic-viewer',options);
    await writer.load();const state=checkpointState(count),before=structuredClone(state);await writer.save(state);
    assert.deepEqual(state,before,'saving must not mutate caller state');
    const native=f.docs.get('subsnotes-state-v1');assert.ok(new TextEncoder().encode(JSON.stringify(native)).length<=60000);
    assert.ok(native.sourceProcessingChunks.length>1);assert.equal(native.sourceProcessing,undefined);
    const reader=createClaudePersonalStore(f.db,'synthetic-viewer',options),loaded=await reader.load();
    assert.equal(loaded.sourceProcessingChunks,undefined);assert.equal(loaded.eventChunks,undefined);
    assert.deepEqual(loaded.sourceProcessing,state.sourceProcessing);assert.deepEqual(new Set(loaded.scannedIds),new Set(state.scannedIds));
    assert.deepEqual(loaded.prefs,state.prefs);assert.deepEqual(loaded.events,state.events);
    for(const [key,value]of f.docs)assert.ok(new TextEncoder().encode(JSON.stringify(value)).length<=60000,key+' exceeds document bound');
    await reader.save({...loaded,prefs:{...loaded.prefs,language:'zh'}});
    assert.equal((await reader.load()).prefs.language,'zh');
  }
});

test('legacy inline event and checkpoint histories stay readable without chunk migration on load',async()=>{
  const f=fixture(),state=checkpointState(3);f.docs.set('subsnotes-state-v1',{...state,savedAt:'legacy-inline'});
  const store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options),loaded=await store.load();
  assert.deepEqual(loaded,state.savedAt?state:{...state,savedAt:'legacy-inline'});assert.equal(f.writes.length,0);
  const compact={...state,scannedIds:undefined,scannedIdsFormat:'processing-keys-v1',savedAt:'legacy-compact'};
  f.docs.set('subsnotes-state-v1',JSON.parse(JSON.stringify(compact)));
  assert.deepEqual(new Set((await store.load()).scannedIds),new Set(state.scannedIds));assert.equal(f.writes.length,0);
});

test('a failed checkpoint chunk write preserves the previous manifest and complete readable history',async()=>{
  const f=fixture(),base=f.db.collection;let fail=false;
  f.db.collection=path=>{const c=base(path);return {doc:id=>{const d=c.doc(id);return {...d,set:value=>{
    if(fail&&id.startsWith('checkpoints-'))throw new Error('checkpoint write failed');return d.set(value);
  }};}};};
  const store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();await store.save(checkpointState(2));
  const before=structuredClone(f.docs.get('subsnotes-state-v1'));fail=true;
  await assert.rejects(store.save(checkpointState(40)),/checkpoint write failed/);assert.deepEqual(f.docs.get('subsnotes-state-v1'),before);
  const loaded=await store.load();assert.deepEqual(loaded.sourceProcessing,checkpointState(2).sourceProcessing);
});

test('checkpoint readback failure does not publish an index pointing to unconfirmed content',async()=>{
  const f=fixture(),base=f.db.collection;let drop=false;
  f.db.collection=path=>{const c=base(path);return {doc:id=>{const d=c.doc(id);return {...d,set:value=>id.startsWith('checkpoints-')&&drop?Promise.resolve():d.set(value)};}};};
  const store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();await store.save(checkpointState(2));
  const before=structuredClone(f.docs.get('subsnotes-state-v1'));drop=true;
  await assert.rejects(store.save(checkpointState(40)),/confirm the new checkpoints/);assert.deepEqual(f.docs.get('subsnotes-state-v1'),before);
});

test('missing, corrupt and overlapping checkpoint chunks cannot replace the loaded revision',async()=>{
  for(const fault of ['missing','corrupt','overlap']){
    const f=fixture(),store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();await store.save(checkpointState(40));
    const before=structuredClone(f.docs.get('subsnotes-state-v1')),refs=before.sourceProcessingChunks;
    assert.ok(refs.length>1);
    if(fault==='missing')f.docs.delete('checkpoints-'+refs[0]);
    if(fault==='corrupt'){const part=f.docs.get('checkpoints-'+refs[0]);part.sourceProcessing[Object.keys(part.sourceProcessing)[0]][5]='altered';}
    if(fault==='overlap'){
      const first=f.docs.get('checkpoints-'+refs[0]).sourceProcessing;
      const second=structuredClone(f.docs.get('checkpoints-'+refs[1]).sourceProcessing);
      const id=Object.keys(first)[0];second[id]=structuredClone(first[id]);const next=digest(JSON.stringify(Object.fromEntries(Object.entries(second).sort(([a],[b])=>a.localeCompare(b)))));
      f.docs.set('checkpoints-'+next,{sourceProcessing:second});refs[1]=next;f.docs.set('subsnotes-state-v1',{...before,storageRevision:'broken-overlap',sourceProcessingChunks:refs});
    }
    await assert.rejects(store.load({fresh:true}),/checkpoint chunk|duplicate message/);
  }
});

test('checkpoint references reject duplicate hashes, mixed inline state and invalid message identities',async()=>{
  const f=fixture(),store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();await store.save(checkpointState(40));
  const before=structuredClone(f.docs.get('subsnotes-state-v1'));
  f.docs.set('subsnotes-state-v1',{...before,sourceProcessingChunks:[before.sourceProcessingChunks[0],before.sourceProcessingChunks[0]]});
  await assert.rejects(store.load(),/checkpoint reference/);
  f.docs.set('subsnotes-state-v1',{...before,sourceProcessing:{}});await assert.rejects(store.load(),/checkpoint reference/);
  const invalid={'constructor':['5','extracted',1,1,null,null]},id=digest(JSON.stringify(invalid));
  f.docs.set('checkpoints-'+id,{sourceProcessing:invalid});f.docs.set('subsnotes-state-v1',{...before,sourceProcessingChunks:[id]});
  await assert.rejects(store.load(),/checkpoint chunk/);
});

test('checkpoint cache is viewer-scoped, mutation-safe and bypassed on manual refresh',async()=>{
  const f=fixture(),writer=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await writer.load();await writer.save(checkpointState(40));
  const base=f.db.collection;let reads=0;
  f.db.collection=path=>{const c=base(path);return {doc:id=>{const d=c.doc(id);return {...d,get:async()=>{if(id.startsWith('checkpoints-'))reads++;return d.get();}};}};};
  const reader=createClaudePersonalStore(f.db,'synthetic-viewer',f.options),first=await reader.load();const count=reads;
  assert.ok(count>1);first.sourceProcessing[first.scannedIds[0]][0]='changed-by-caller';
  const again=await reader.load();assert.equal(reads,count);assert.equal(again.sourceProcessing[again.scannedIds[0]][0],'5');
  const ref=f.docs.get('subsnotes-state-v1').sourceProcessingChunks[0];f.docs.delete('checkpoints-'+ref);
  assert.ok((await reader.load()).scannedIds.length===40);
  await assert.rejects(reader.load({fresh:true}),/checkpoint chunk/);
  await assert.rejects(createClaudePersonalStore(f.db,'synthetic-viewer',f.options).load(),/checkpoint chunk/);
});

test('stale checkpoint writers preserve the latest user settings and cannot save raw chunk references',async()=>{
  const f=fixture(),a=createClaudePersonalStore(f.db,'synthetic-viewer',f.options),b=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);
  await a.load();await a.save(checkpointState(40));const state=await b.load();
  const fresh=await a.load();await a.save({...fresh,prefs:{...fresh.prefs,currency:'CAD'}});
  await assert.rejects(b.save({...state,prefs:{...state.prefs,currency:'JPY'}}),/another tab/);
  assert.equal((await a.load()).prefs.currency,'CAD');
  const raw=f.docs.get('subsnotes-state-v1');await assert.rejects(a.save({...raw,events:[]}),/complete saved checkpoints/);
});

test('a failed checkpoint load never advances the expected revision for the next save',async()=>{
  const f=fixture(),store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();await store.save(checkpointState(40));
  const loaded=await store.load(),before=structuredClone(f.docs.get('subsnotes-state-v1'));
  f.docs.set('subsnotes-state-v1',{...before,storageRevision:'unreadable-revision',sourceProcessingChunks:['b'.repeat(64)]});
  await assert.rejects(store.load({fresh:true}),/checkpoint chunk/);
  await assert.rejects(store.save(loaded),/uncertain/);
  assert.equal(f.docs.get('subsnotes-state-v1').storageRevision,'unreadable-revision');
});

test('failed index confirmation keeps old chunked checkpoints and blocks further writes until reopen',async()=>{
  const f=fixture(),base=f.db.collection;let drop=false;
  f.db.collection=path=>{const c=base(path);return {doc:id=>{const d=c.doc(id);return {...d,set:value=>id==='subsnotes-state-v1'&&drop?Promise.resolve():d.set(value)};}};};
  const store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();await store.save(checkpointState(40));
  const before=structuredClone(f.docs.get('subsnotes-state-v1'));drop=true;
  await assert.rejects(store.save(checkpointState(50)),/confirm the saved index/);
  assert.deepEqual(f.docs.get('subsnotes-state-v1'),before);await assert.rejects(store.save(checkpointState(50)),/uncertain/);
  assert.equal((await store.load()).scannedIds.length,40);
});

test('unrelated oversized metadata and oversized individual checkpoints still preserve the old index',async()=>{
  const f=fixture(),store=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await store.load();await store.save(checkpointState(2));
  const before=structuredClone(f.docs.get('subsnotes-state-v1'));
  await assert.rejects(store.save({...checkpointState(40),unrelated:'x'.repeat(1300)}),/index is too large/);
  const state=checkpointState(40);state.sourceProcessing[state.scannedIds[0]][5]='x'.repeat(1300);
  await assert.rejects(store.save(state),/checkpoint record exceeds/);assert.deepEqual(f.docs.get('subsnotes-state-v1'),before);
});

test('save rejects checkpoint and event chunk counts beyond the reader limit before any writes',async()=>{
  const f=fixture(),options={...f.options,maxBytes:40000},store=createClaudePersonalStore(f.db,'synthetic-viewer',options);
  await store.load();await store.save(checkpointState(2));const before=structuredClone(f.docs.get('subsnotes-state-v1'));const priorWrites=f.writes.length;
  const checkpoints=checkpointState(513);for(const record of Object.values(checkpoints.sourceProcessing))record[5]='x'.repeat(35500);
  await assert.rejects(store.save(checkpoints),/checkpoint history requires too many/);
  const events={events:Array.from({length:513},(_,i)=>({id:'synthetic-large-'+i,evidence:'x'.repeat(35500)}))};
  await assert.rejects(store.save(events),/event history requires too many/);
  assert.equal(f.writes.length,priorWrites);assert.deepEqual(f.docs.get('subsnotes-state-v1'),before);
});

test('a cold or fresh checkpoint integrity failure blocks writes until a complete load succeeds',async()=>{
  for(const cold of [false,true]){
    const f=fixture(),writer=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);await writer.load();await writer.save(checkpointState(40));
    const reader=createClaudePersonalStore(f.db,'synthetic-viewer',f.options);if(!cold)await reader.load();
    const manifest=f.docs.get('subsnotes-state-v1'),ref='checkpoints-'+manifest.sourceProcessingChunks[0],part=structuredClone(f.docs.get(ref));f.docs.delete(ref);
    await assert.rejects(reader.load({fresh:true}),/checkpoint chunk/);
    const before=f.writes.length;await assert.rejects(reader.save(checkpointState(41)),/uncertain/);assert.equal(f.writes.length,before);
    f.docs.set(ref,part);const complete=await reader.load({fresh:true});assert.equal(complete.scannedIds.length,40);
    await reader.save({...complete,prefs:{...complete.prefs,currency:'CAD'}});assert.equal((await reader.load()).prefs.currency,'CAD');
  }
});
