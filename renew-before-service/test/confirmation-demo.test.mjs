import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash, webcrypto} from 'node:crypto';
import {syntheticConfirmationFixture,createSyntheticDemoBridge,buildConfirmationDemo} from '../scripts/package-confirmation-demo.mjs';
import {createClaudePersonalStore} from '../src/claude-store.mjs';
import {createClaudeGmailClient} from '../src/claude-gmail.mjs';
import {createWebSync} from '../src/web-sync.mjs';
import {extractWebEvidence} from '../src/web-evidence.mjs';
import {createEvidenceRuntime} from '../src/evidence-runtime.mjs';
import {createCashflowRuntime} from '../src/cashflow.mjs';
import {createPaymentConfirmationRuntime} from '../src/payment-confirmations.mjs';
import {createI18nRuntime} from '../src/i18n.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const clock=()=> '2026-11-04T10:00:00Z';
const summary=state=>createCashflowRuntime().summarize(createEvidenceRuntime(hash).projectEvidence(state.events,{trustConnectorReads:true}),{trustConnectorReads:true,paymentConfirmations:state.paymentConfirmations});
function browserStorage(){const values=new Map();return{values,getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}
function browserBridge(fixture,{storage=browserStorage(),search='',nativeHost=null}={}){
 class Element{constructor(){this.children=[];this.listeners={};this.attributes={};this.textContent='';}append(...children){this.children.push(...children);}prepend(child){this.children.unshift(child);}setAttribute(key,value){this.attributes[key]=value;}addEventListener(key,fn){this.listeners[key]=fn;}querySelector(selector){return selector==='span'?this.children[0]:this.children[1];}}
 const body=new Element(),document={documentElement:{lang:''},body,createElement:()=>new Element(),addEventListener(){}};
 const window={localStorage:storage,confirm:()=>false,alert(){}},location={search,reload(){}};
 const factory=vm.runInNewContext('('+createSyntheticDemoBridge.toString()+')',{window,location,document,MutationObserver:class{observe(){}},URLSearchParams,crypto:webcrypto,TextEncoder,structuredClone});
 const bridge=factory({fixture,nativeHost,createStore:createClaudePersonalStore,i18n:createI18nRuntime()});
 return{bridge,storage,document,banner:body.children[0]};
}
async function storeFor(context){const [db,user]=await Promise.all([context.bridge.use('db'),context.bridge.use('user')]);const store=createClaudePersonalStore(db,await user.id(),{hash});await store.load();return store;}
function nativeDatabase(initial){const docs=new Map(initial?[['subsnotes-state-v1',structuredClone(initial)]]:[]),writes=[];return{docs,writes,host:{use:async name=>{if(name==='user')return{id:async()=>'synthetic-native-viewer'};if(name!=='db')throw new Error('The demo must not request real Gmail');return{collection(path){assert.equal(path,'data/users/synthetic-native-viewer');return{doc:id=>({get:async()=>({exists:docs.has(id),data:()=>structuredClone(docs.get(id))}),set:async value=>{writes.push(id);docs.set(id,structuredClone(value));}})};}};}}};}

// All source messages, IDs and billing values in this file are fictional.
test('fictional receipts replay their deterministic source identities and known billing cycles',async()=>{
 const fixture=await syntheticConfirmationFixture({confirmed:false});assert.equal(fixture.state.syntheticDemo,true);assert.equal(fixture.state.events.length,13);
 for(const message of fixture.messages){
  const parsed=await extractWebEvidence({id:message.id,sender:message.sender,subject:message.subject,text:message.plaintextBody,receivedAt:message.date,sourceFormat:'claude_plaintext',sourceReadAt:clock()});
  const source=fixture.state.events.find(event=>event.messageId===message.id);assert.equal(parsed.length,1);assert.equal(parsed[0].id,source.id);
  if(source.kind==='payment_succeeded'){assert.equal(parsed[0].serviceKey,source.serviceKey);assert.equal(parsed[0].cadence,source.cadence);assert.equal(parsed[0].payment.minor,source.payment.minor);}
 }
 assert.equal(fixture.messages.find(m=>m.id==='demo-figma-receipt').sender,'billing@figma.com');
});

test('all ten fictional invoices remain pending until a user confirmation, never silently becoming spending',async()=>{
 const pending=await syntheticConfirmationFixture({confirmed:false}),data=summary(pending.state);assert.equal(data.pendingInvoices.length,10);assert.deepEqual(data.paidMinorByCurrency,{USD:12300});assert.equal(data.userConfirmedCount,0);
 const confirmed=await syntheticConfirmationFixture(),paid=summary(confirmed.state);assert.equal(paid.pendingInvoices.length,8);assert.deepEqual(paid.paidMinorByCurrency,{USD:15800});assert.equal(paid.userConfirmedCount,2);assert.equal(paid.monthPrecisionPaymentCount,1);
 assert.deepEqual(confirmed.state.events,pending.state.events);assert.equal(confirmed.state.paymentConfirmations[pending.state.events[1].id].date,undefined);
});

test('simulated Gmail replay uses the real discovery, merge, private-store and cashflow pipeline without duplicates',async()=>{
 const fixture=await syntheticConfirmationFixture({confirmed:false}),context=browserBridge(fixture),store=await storeFor(context),mcp=await context.bridge.use('mcp'),gmail=createClaudeGmailClient(mcp,{clock});
 const sync=createWebSync({gmail,store,extract:extractWebEvidence,hash,clock});
 for(let pass=0;pass<2;pass++){
  let result;for(let batch=0;batch<20;batch++){result=await sync.run({since:'2026-01-01',until:'2026-11-02'});if(result.complete)break;}
  assert.equal(result.complete,true);assert.equal(result.state.events.length,13);assert.equal(new Set(result.state.events.map(e=>e.id)).size,13);
  assert.equal(summary(result.state).pendingInvoices.length,10);assert.deepEqual(summary(result.state).paidMinorByCurrency,{USD:12300});
  assert.equal(result.state.events.filter(e=>e.kind==='payment_succeeded').length,3);assert.equal(result.state.events.filter(e=>e.serviceKey==='chatgpt'&&e.kind==='invoice_recorded').length,10);
 }
 const current=await store.load(),eventId=fixture.state.events[0].id,next=createPaymentConfirmationRuntime().set(current,{eventId,precision:'month',month:'2026-01',amount:{minor:1700,currency:'USD'},expectedRevision:0},{now:clock()});
 await store.saveUserConfirmations(next);
 let result;for(let batch=0;batch<20;batch++){result=await sync.run({since:'2026-01-01',until:'2026-11-02'});if(result.complete)break;}
 assert.equal(result.complete,true);assert.equal(result.state.paymentConfirmations[eventId].month,'2026-01');assert.equal(result.state.events.length,13);assert.equal(summary(result.state).pendingInvoices.length,9);assert.deepEqual(summary(result.state).paidMinorByCurrency,{USD:14000});
 const reopened=await storeFor(browserBridge(fixture,{storage:context.storage}));assert.equal((await reopened.load()).paymentConfirmations[eventId].month,'2026-01');
});

test('browser demo reopens its saved language and confirmations without replacing them with query defaults',async()=>{
 const fixture=await syntheticConfirmationFixture({confirmed:false}),context=browserBridge(fixture,{search:'?lang=zh'}),store=await storeFor(context);let state=await store.load();assert.equal(state.prefs.language,'zh-TW');
 state={...state,prefs:{...state.prefs,language:'en'}};await store.save(state);
 const reopened=await storeFor(browserBridge(fixture,{storage:context.storage,search:'?lang=zh-TW'}));assert.equal((await reopened.load()).prefs.language,'en');
 assert.match(context.banner.children[0].textContent,/合成資料示範/);assert.equal(context.banner.children[1].hidden,false);
});

test('native-storage demo refuses an existing non-demo ledger before any write and never asks for real Gmail',async()=>{
 const fixture=await syntheticConfirmationFixture({confirmed:false}),privateState={version:1,events:[{id:'synthetic-private-record'}],prefs:{}},native=nativeDatabase(privateState),before=structuredClone([...native.docs]);
 const context=browserBridge(fixture,{nativeHost:native.host});await assert.rejects(context.bridge.use('db'),/No data was changed/);assert.deepEqual([...native.docs],before);assert.equal(native.writes.length,0);
 assert.equal(typeof(await context.bridge.use('mcp')).callTool,'function');assert.equal(context.banner.children[1].hidden,true);
 assert.match(context.banner.children[0].textContent,/personal Claude storage/);assert.match(context.banner.children[0].textContent,/Gmail is simulated/);
});

test('native demo initializes only an empty viewer-scoped store and reopens without resetting edits',async()=>{
 const fixture=await syntheticConfirmationFixture({confirmed:false}),native=nativeDatabase(),context=browserBridge(fixture,{nativeHost:native.host,search:'?lang=zh-TW'}),store=await storeFor(context);let state=await store.load();assert.equal(state.syntheticDemo,true);assert.equal(state.prefs.language,'zh-TW');assert.equal(state.events.length,13);
 await store.save({...state,prefs:{...state.prefs,language:'en'}});const reopened=await storeFor(browserBridge(fixture,{nativeHost:native.host,search:'?lang=zh-TW'}));assert.equal((await reopened.load()).prefs.language,'en');assert.equal((await reopened.load()).events.length,13);
});

test('blocked browser writes disclose temporary storage instead of promising durable browser saves',async()=>{
 const fixture=await syntheticConfirmationFixture({confirmed:false}),storage={getItem:()=>null,setItem(){throw new Error('Synthetic quota failure');},removeItem(){}},context=browserBridge(fixture,{storage}),store=await storeFor(context);await store.save(await store.load());assert.match(context.banner.children[0].textContent,/Temporary session/);
});

test('demo packaging keeps browser and native hosts separate and includes no real mailbox connection',async()=>{
 const html='<html><head></head><body><script>const marker=window.claude;\nmountClaudeDashboard({});</script></body></html>';
 const browser=await buildConfirmationDemo(html,{confirmed:false}),native=await buildConfirmationDemo(html,{nativeStorage:true,confirmed:false});
 assert.match(browser.html,/src="\.\/confirmations.js"/);assert.match(browser.script,/nativeHost:null/);assert.match(native.html,/nativeHost:window.claude/);assert.doesNotMatch(native.html,/src="\.\/confirmations.js"/);assert.match(browser.script,/name==='mcp'\?mcp/);
 await assert.rejects(buildConfirmationDemo('<html></html>'),/entrypoint/);
});

test('native HTML preserves currency markers and replacement tokens as executable source',async()=>{
 const original=`const markers=["$'","$&","$\`","US$","NT$"];\nmountClaudeDashboard({});`;
 const html='<html><head></head><body><script>'+original+'</script></body></html>';
 for(const nativeStorage of [false,true]){
  const built=await buildConfirmationDemo(html,{nativeStorage,confirmed:false});
  assert.doesNotThrow(()=>new vm.Script(built.script));
  assert.ok(built.script.includes('const markers=["$\'","$&","$`","US$","NT$"]'));
  if(nativeStorage){
   const scripts=[...built.html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
   assert.equal(scripts.length,1);assert.equal(scripts[0][1],built.script);
   assert.doesNotThrow(()=>new vm.Script(scripts[0][1]));
  }
 }
});
