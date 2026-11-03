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
  await assert.rejects(store.save({events:[]}),/another tab/);
  f.docs.set('subsnotes-state-v1',before);assert.deepEqual((await store.load()).events,[{id:'saved'}]);
});
