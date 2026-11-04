import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { mountClaudeDashboard } from '../src/claude-dashboard.mjs';
import { createEvidenceRuntime } from '../src/evidence-runtime.mjs';
import { createCashflowRuntime } from '../src/cashflow.mjs';
import { createFxRuntime } from '../src/fx.mjs';
import { createSubscriptionViewRuntime } from '../src/subscription-view.mjs';
import { createServiceBrandsRuntime } from '../src/service-brands.mjs';
import { createSourceEvidenceMerger } from '../src/web-sync.mjs';
import { preserveReceiptVerification } from '../src/receipt-verification.mjs';
import { createLedgerContracts } from '../src/ledger-contracts.mjs';

const flush = () => new Promise(resolve=>setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const template = await readFile(new URL('../src/claude-dashboard.html',import.meta.url),'utf8');

// A minimal DOM harness exercises the mounted handlers against delayed storage.
// Native dialog focus and browser layout are separately verified in browser QA.
async function harness({events=null,prefs={},freezePreferences=false,now=null,mcpReady=null,syncRun=null,initialState={}}={}) {
  const elements = new Map();
  class Element {
    constructor(id) {this.id=id;this.value='';this.textContent='';this.dataset={};this.listeners={};this.disabled=false;this.open=false;this._html='';}
    addEventListener(type,fn) {(this.listeners[type] ||= []).push(fn);}
    async dispatch(type,event={}) {await Promise.all((this.listeners[type]||[]).map(fn=>fn({target:this,...event})));}
    set innerHTML(value) {
      this._html=value;
      if(this.id==='detail-body') {
        elements.delete('review');elements.delete('review-result');
        if(value.includes('id="review"')) {elements.set('review',new Element('review'));elements.set('review-result',new Element('review-result'));}
      }
    }
    get innerHTML() {return this._html;}
    showModal() {this.open=true;}
    close() {this.open=false;void this.dispatch('close');}
    focus() {this.focused=true;}
  }
  for(const [,id] of template.matchAll(/id="([^"]+)"/g)) elements.set(id,new Element(id));
  const document = {getElementById:id=>elements.get(id)||null,documentElement:{},visibilityState:'visible',querySelector:()=>new Element('summary'),querySelectorAll:()=>[],addEventListener(){}};
  let persisted={version:1,events:events||['alpha','beta'].map(key=>({id:key,messageId:'synthetic-'+key,serviceKey:key,service:'Fictional '+key,category:'Software',kind:'payment_succeeded',authenticated:true,receivedAt:'2026-07-01T01:00:00Z',payment:{currency:'USD',minor:1200},paymentDay:'2026-07-01',paymentDateBasis:'explicit'})),prefs,...initialState};
  const pendingSaves=[];
  const store={load:async()=>{const state=clone(persisted);if(freezePreferences)Object.freeze(state.prefs);return state;},getRevision:async()=>persisted.storageRevision||null,save:next=>new Promise((resolve,reject)=>pendingSaves.push({next:clone(next),resolve:()=>{persisted=clone(next);resolve();},reject}))};
  const capabilities={mcp:{},db:{},user:{id:async()=>'fictional-user'},permissions:{manage(){}}};
  const window={claude:{use:async key=>key==='mcp'&&mcpReady?await mcpReady:capabilities[key]},addEventListener(){}};
  const ClockDate = now ? class extends Date { constructor(...args){super(...(args.length?args:[now]));}static now(){return new Date(now).getTime();} } : Date;
  const mount=vm.runInNewContext('('+mountClaudeDashboard.toString()+')',{document,window,crypto:webcrypto,TextEncoder,Date:ClockDate,setInterval(){}});
  mount({createEvidenceRuntime,createCashflowRuntime,createFxRuntime,createSubscriptionViewRuntime,createServiceBrandsRuntime,createSourceEvidenceMerger,preserveReceiptVerification,createLedgerContracts,extractWebEvidence(){},createClaudePersonalStore:()=>store,createClaudeRatesClient:()=>({load:async()=>{throw new Error('Rates unavailable in this test');}}),createClaudeGmailClient:()=>({}),createWebSync:()=>({run:syncRun||(()=>{throw new Error('No scan is requested by these tests');})})});
  for(let i=0;i<4;i++)await flush();
  const open=async key=>{const button=new Element('row');button.dataset.record=key;button.closest=()=>button;await elements.get('list').dispatch('click',{target:button});};
  const change=days=>{const select=elements.get('review');select.value=String(days);return select.dispatch('change');};
  return {elements,pendingSaves,open,change,replace:next=>{persisted=clone(next);},get persisted(){return clone(persisted);}};
}

test('closing and reopening during a review save shows pending state, then the persisted date in the current selector',async()=>{
  const app=await harness();await app.open('alpha');
  const save=app.change(7);await flush();
  assert.equal(app.pendingSaves.length,1);
  app.elements.get('detail').close();await app.open('alpha');
  const current=app.elements.get('review');
  assert.equal(current.value,'pending');assert.equal(current.disabled,true);
  assert.match(app.elements.get('review-result').textContent,/Saving/);
  app.pendingSaves[0].resolve();await save;await flush();
  assert.equal(current,app.elements.get('review'));
  assert.equal(current.value,'saved');assert.equal(current.disabled,false);
  assert.match(current.innerHTML,/selected disabled>Review on/);
  assert.match(app.elements.get('review-result').textContent,/Review on/);
  assert.match(app.persisted.prefs.reviews.alpha,/^\d{4}-\d{2}-\d{2}$/);
});

test('queued service review changes merge against latest storage and never update a different open detail',async()=>{
  const app=await harness();await app.open('alpha');
  const first=app.change(3);await flush();
  app.elements.get('detail').close();await app.open('beta');
  const second=app.change(7);await flush();
  assert.equal(app.pendingSaves.length,1);
  app.pendingSaves[0].resolve();await first;await flush();
  assert.equal(app.pendingSaves.length,2);
  const secondState=app.pendingSaves[1].next;
  assert.ok(secondState.prefs.reviews.alpha);assert.ok(secondState.prefs.reviews.beta);
  assert.notEqual(secondState.prefs.reviews.alpha,secondState.prefs.reviews.beta);
  assert.equal(app.elements.get('review').value,'pending');
  assert.match(app.elements.get('review-result').textContent,/Saving/);
  app.pendingSaves[1].resolve();await second;
  assert.equal(app.elements.get('review').value,'saved');
  assert.equal(Object.keys(app.persisted.prefs.reviews).length,2);
});

test('a failed review write restores the persisted choice with visible failure feedback',async()=>{
  const app=await harness();await app.open('alpha');
  const save=app.change(7);await flush();
  app.pendingSaves[0].reject(new Error('Synthetic storage failure'));await save;
  assert.equal(app.elements.get('review').value,'0');assert.equal(app.elements.get('review').disabled,false);
  assert.match(app.elements.get('review-result').textContent,/Could not save/);
  assert.equal(app.persisted.prefs.reviews,undefined);
  app.elements.get('detail').close();await app.open('alpha');
  assert.equal(app.elements.get('review').value,'0');
});

const periodEvents = [
  ['july-usd','2026-07-01','USD',1200], ['august-usd','2026-08-01','USD',3000], ['august-jpy','2026-08-02','JPY',800]
].map(([id,paymentDay,currency,minor])=>({id,messageId:'synthetic-'+id,serviceKey:id,service:'Fictional '+id,category:'Software',kind:'payment_succeeded',authenticated:true,receivedAt:paymentDay+'T01:00:00Z',payment:{currency,minor},paymentDay,paymentDateBasis:'explicit'}));

test('frozen SDK preferences cannot delay the selected month or its financial total',async()=>{
  const app=await harness({events:periodEvents,freezePreferences:true});
  const month=app.elements.get('month');month.value='2026-07';
  await month.dispatch('change');
  assert.equal(month.value,'2026-07');
  assert.equal(app.elements.get('originals').textContent,'USD 12.00');
  assert.equal(app.elements.get('total').textContent,'USD 12.00');
  await flush();assert.equal(app.pendingSaves.length,1);
  assert.equal(app.persisted.prefs.month,undefined);
  app.pendingSaves[0].resolve();await flush();await flush();
  assert.equal(app.persisted.prefs.month,'2026-07');
  assert.equal(app.elements.get('total').textContent,'USD 12.00');
});

test('rapid queued period and currency choices keep the latest controls and amounts in sync between older saves',async()=>{
  const app=await harness({events:periodEvents,freezePreferences:true});
  const month=app.elements.get('month'),currency=app.elements.get('currency');
  month.value='2026-07';await month.dispatch('change');await flush();
  month.value='2026-08';await month.dispatch('change');
  currency.value='JPY';await currency.dispatch('change');
  assert.equal(month.value,'2026-08');assert.equal(currency.value,'JPY');
  assert.equal(app.elements.get('originals').textContent,'USD 30.00 · JPY 800');
  assert.equal(app.elements.get('total').textContent,'Partial total · JPY 800');
  app.pendingSaves[0].resolve();await flush();await flush();
  assert.equal(app.persisted.prefs.month,'2026-07');
  assert.equal(month.value,'2026-08');assert.equal(currency.value,'JPY');
  assert.equal(app.elements.get('total').textContent,'Partial total · JPY 800');
  app.pendingSaves[1].resolve();await flush();await flush();
  assert.equal(month.value,'2026-08');assert.equal(currency.value,'JPY');
  assert.equal(app.elements.get('total').textContent,'Partial total · JPY 800');
  currency.value='USD';await currency.dispatch('change');
  assert.equal(app.elements.get('total').textContent,'Partial total · USD 30.00');
  app.pendingSaves[2].resolve();await flush();await flush();
  assert.equal(app.persisted.prefs.currency,'JPY');
  assert.equal(currency.value,'USD');assert.equal(app.elements.get('total').textContent,'Partial total · USD 30.00');
  app.pendingSaves[3].resolve();await flush();await flush();
  assert.equal(app.persisted.prefs.month,'2026-08');assert.equal(app.persisted.prefs.currency,'USD');
  const reopened=await harness({events:periodEvents,prefs:app.persisted.prefs,freezePreferences:true});
  assert.equal(reopened.elements.get('month').value,'2026-08');assert.equal(reopened.elements.get('currency').value,'USD');
  assert.equal(reopened.elements.get('total').textContent,'Partial total · USD 30.00');
});

const syntheticReceipt = (id,extra={})=>({id,messageId:'synthetic-'+id,serviceKey:'fictional',service:'Fictional Workbench',category:'Software',kind:'payment_succeeded',authenticated:true,receivedAt:'2026-08-20T01:00:00Z',payment:{currency:'USD',minor:1200},paymentDay:'2026-08-20',paymentDateBasis:'explicit',...extra});

test('unknown currencies never gain an assumed decimal scale or become zero spending',async()=>{
  for(const language of ['en','zh']) {
    const app=await harness({events:[syntheticReceipt('currency-unknown',{payment:{currency:null,minor:12345}})],prefs:{language}});
    const list=app.elements.get('list').innerHTML;
    assert.match(list,language==='zh'?/幣別待確認/:/Currency unconfirmed/);
    assert.doesNotMatch(list,/123\.45|12345|USD\s*0\.00/);
    assert.equal(app.elements.get('total').textContent,'—');
    await app.open('fictional');
    assert.match(app.elements.get('detail-body').innerHTML,language==='zh'?/幣別待確認/:/Currency unconfirmed/);
    assert.doesNotMatch(app.elements.get('detail-body').innerHTML,/123\.45|12345|USD\s*0\.00/);
  }
});

test('the subscription list shows the earliest trial decision deadline while details retain all dates',async()=>{
  const trial=syntheticReceipt('trial-deadline',{kind:'trial_confirmed',payment:undefined,cancelBy:'2027-01-09',trialEnds:'2027-01-11',nextBilling:'2027-01-12',nextCharge:{currency:'USD',minor:2000},cadence:'monthly'});
  for(const language of ['en','zh']) {
    const app=await harness({events:[trial],prefs:{language}});
    const list=app.elements.get('list').innerHTML;
    assert.match(list,language==='zh'?/2027年1月9日/:/Jan 9, 2027/);
    assert.match(list,language==='zh'?/取消期限/:/Cancel by/);
    await app.open('fictional');
    const details=app.elements.get('detail-body').innerHTML;
    assert.match(details,language==='zh'?/2027年1月11日/:/Jan 11, 2027/);
    assert.match(details,language==='zh'?/2027年1月12日/:/Jan 12, 2027/);
    assert.doesNotMatch(details,/>check_trial</);
  }
});

test('turning renewal off keeps the recorded access end distinct from an old trial deadline',async()=>{
  const trial=syntheticReceipt('old-trial',{kind:'trial_confirmed',payment:undefined,cancelBy:'2027-01-09',trialEnds:'2027-01-11',nextBilling:'2027-01-12',nextCharge:{currency:'USD',minor:2000}});
  const off=syntheticReceipt('off',{kind:'renewal_disabled',payment:undefined,receivedAt:'2026-08-21T01:00:00Z',accessEnds:'2027-01-11'});
  const app=await harness({events:[trial,off]});
  const list=app.elements.get('list').innerHTML;
  assert.match(list,/Jan 11, 2027/);
  assert.match(list,/Recorded access end/);
  assert.doesNotMatch(list,/<small>Trial ends<\/small>/);
});

test('duplicate providers show account labels without exposing raw references in visible text or details',async()=>{
  const first='SYNTHETIC-PRIVATE-ONE',second='SYNTHETIC-PRIVATE-TWO';
  const events=[syntheticReceipt('one',{accountRef:first}),syntheticReceipt('two',{accountRef:second,payment:{currency:'USD',minor:2400}})];
  const app=await harness({events});
  const list=app.elements.get('list').innerHTML,visibleText=list.replace(/<[^>]*>/g,'');
  assert.match(visibleText,/Account 1/);assert.match(visibleText,/Account 2/);
  assert.ok(!visibleText.includes(first));assert.ok(!visibleText.includes(second));
  await app.open('fictional|account:'+encodeURIComponent(first));
  assert.equal(app.elements.get('detail-title').textContent,'Fictional Workbench · Account 1');
  const details=app.elements.get('detail-body').innerHTML;
  assert.ok(!details.includes(first));assert.ok(!details.includes(second));
  assert.match(details,/USD 12\.00/);assert.doesNotMatch(details,/USD 24\.00/);
  // Canonical scoped keys still exist in the private native DOM to route actions.
  // This test does not claim that the runtime DOM has been anonymized or is public-safe.
});

test('Today is a real persisted review choice and can be cleared without implying a notification',async()=>{
  const app=await harness({now:'2026-09-03T12:00:00'});await app.open('alpha');
  assert.match(app.elements.get('review').innerHTML,/<option value="-1">Today<\/option>/);
  assert.match(app.elements.get('detail-body').innerHTML,/No email, calendar event or push notification is sent/);
  const today=app.change(-1);await flush();
  assert.equal(app.pendingSaves[0].next.prefs.reviews.alpha,'2026-09-03');
  app.pendingSaves[0].resolve();await today;
  assert.equal(app.persisted.prefs.reviews.alpha,'2026-09-03');
  assert.match(app.elements.get('review-result').textContent,/Review on Sep 3, 2026/);
  app.elements.get('detail').close();await app.open('alpha');
  assert.equal(app.elements.get('review').value,'saved');
  const clear=app.change(0);await flush();app.pendingSaves[1].resolve();await clear;
  assert.equal(app.persisted.prefs.reviews.alpha,undefined);
  assert.equal(app.elements.get('review').value,'0');
});

test('a persisted review after the trial deadline warns in both languages, while Today remains within it',async()=>{
  const trial=syntheticReceipt('short-trial',{kind:'trial_confirmed',payment:undefined,cancelBy:'2026-09-04',trialEnds:'2026-09-06',nextBilling:'2026-09-06',nextCharge:{currency:'USD',minor:2000}});
  for(const language of ['en','zh']) {
    const app=await harness({events:[trial],prefs:{language},now:'2026-09-03T12:00:00'});await app.open('fictional');
    const later=app.change(7);await flush();
    assert.equal(app.pendingSaves[0].next.prefs.reviews.fictional,'2026-09-10');
    app.pendingSaves[0].resolve();await later;
    assert.match(app.elements.get('review-result').textContent,language==='zh'?/已超過信件記載的期限/:/after the recorded deadline/);
    const today=app.change(-1);await flush();app.pendingSaves[1].resolve();await today;
    assert.equal(app.persisted.prefs.reviews.fictional,'2026-09-03');
    assert.doesNotMatch(app.elements.get('review-result').textContent,/after the recorded deadline|已超過信件記載的期限/);
    assert.match(app.elements.get('review').innerHTML,language==='zh'?/今天/:/Today/);
  }
});

test('bundled logos and their attribution remain static data in the empty-account app',async()=>{
  const app=await harness({events:[syntheticReceipt('vercel',{serviceKey:'vercel',service:'Vercel'})]});
  assert.match(app.elements.get('list').innerHTML,/<img src="data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(app.elements.get('list').innerHTML,/<img src="https?:/);
  assert.match(app.elements.get('brand-notice').textContent,/trademarks or registered trademarks of Vercel/);
  assert.doesNotMatch(template,/SYNTHETIC-PRIVATE|synthetic-vercel|synthetic-alpha/);
});


test('likely-canceled plans hide by default but remain inspectable and bilingual without changing the saved ledger',async()=>{
  const events=[{id:'fictional-old',messageId:'fictional-old-mail',serviceKey:'fictional-old',service:'Fictional Old Plan',category:'Software',kind:'subscription_confirmed',authenticated:true,receivedAt:'2020-01-01T00:00:00Z',nextBilling:'2020-02-01'}];
  const app=await harness({events});
  assert.match(app.elements.get('count').textContent,/0 records · All dates · 1 likely inactive hidden/);
  assert.doesNotMatch(app.elements.get('list').innerHTML,/data-record="fictional-old"/);
  const filter=app.elements.get('filter');filter.value='likely_canceled';await filter.dispatch('change');
  assert.match(app.elements.get('list').innerHTML,/Fictional Old Plan/);assert.match(app.elements.get('list').innerHTML,/Likely inactive/);
  await app.open('fictional-old');assert.match(app.elements.get('detail-body').innerHTML,/not confirmed cancellation/);assert.match(app.elements.get('detail-body').innerHTML,/Inactivity threshold/);
  app.elements.get('detail').close();await app.elements.get('language').dispatch('click');await app.open('fictional-old');
  assert.equal(filter.value,'likely_canceled');assert.match(app.elements.get('list').innerHTML,/可能已停用/);
  assert.match(app.elements.get('detail-body').innerHTML,/並非確認取消/);
  assert.deepEqual(app.persisted.events,events);
});


test('saved records render before a stalled Gmail handshake and remain usable without live tools',async()=>{
  const app=await harness({mcpReady:new Promise(()=>{})});
  assert.match(app.elements.get('list').innerHTML,/Fictional alpha/);
  assert.equal(app.elements.get('refresh').disabled,false);assert.equal(app.elements.get('sync').disabled,true);
  assert.equal(app.elements.get('month').disabled,false);
  await app.open('alpha');assert.equal(app.elements.get('detail').open,true);
});

test('Refresh reads externally updated records without scanning Gmail or replacing financial history',async()=>{
  let scans=0;const app=await harness({syncRun:()=>{scans++;throw new Error('Unexpected Gmail scan');},prefs:{language:'en'}});
  const original=app.persisted,added={...original.events[0],id:'gamma',messageId:'mail-gamma',serviceKey:'gamma',service:'Fictional gamma'};
  app.replace({...original,storageRevision:'revision-two',events:[...original.events,added]});
  await app.elements.get('refresh').dispatch('click');for(let i=0;i<8;i++)await flush();
  assert.equal(scans,0);assert.match(app.elements.get('status').textContent,/Saved records reloaded/);assert.equal(app.elements.get('count').textContent,'3 records · All dates');assert.match(app.elements.get('list').innerHTML,/Fictional gamma/);
  assert.deepEqual(app.persisted.events.slice(0,2),original.events);
  assert.equal(app.elements.get('refresh').disabled,false);
});

test('month and currency selections stay interactive during sync and persist after the single writer finishes',async()=>{
  let finish;const app=await harness({prefs:{language:'en',month:'all',currency:'USD'},syncRun:()=>new Promise(resolve=>{finish=()=>resolve({state:app.persisted,complete:true});})});
  const running=app.elements.get('sync').dispatch('click');await flush();
  assert.equal(app.elements.get('month').disabled,false);assert.equal(app.elements.get('currency').disabled,false);
  const month=app.elements.get('month');month.value='2026-07';await month.dispatch('change');
  const currency=app.elements.get('currency');currency.value='EUR';await currency.dispatch('change');
  assert.equal(app.pendingSaves.length,0);finish();for(let i=0;i<4;i++)await flush();
  assert.equal(app.pendingSaves.length,1);app.pendingSaves[0].resolve();await running;
  assert.equal(app.persisted.prefs.month,'2026-07');assert.equal(app.persisted.prefs.currency,'EUR');
  assert.equal(month.value,'2026-07');assert.equal(currency.value,'EUR');
});

test('choosing a payment month opens exactly the verified expense rows used by its total, with full annual charges only in their payment month',async()=>{
  const events=[
    syntheticReceipt('annual-paid',{serviceKey:'annual',service:'Fictional Annual',cadence:'annual',payment:{currency:'USD',minor:12000},paymentDay:'2026-07-31',receivedAt:'2026-08-01T00:30:00Z'}),
    syntheticReceipt('monthly-paid',{serviceKey:'monthly',service:'Fictional Monthly',paymentDay:'2026-08-20'}),
    syntheticReceipt('future-renewal',{serviceKey:'upcoming',service:'Fictional Upcoming',kind:'renewal_notice',payment:undefined,nextCharge:{currency:'USD',minor:99900},nextBilling:'2026-08-25'}),
    syntheticReceipt('unknown-date',{serviceKey:'unknown',service:'Fictional Date Unknown',paymentDay:null,paymentDateBasis:'unknown'}),
    syntheticReceipt('held-paid',{serviceKey:'held',service:'Fictional Held',sourceProcessingConflict:true})
  ];
  const app=await harness({events,prefs:{language:'en'}}),month=app.elements.get('month');
  month.value='2026-08';await month.dispatch('change');
  assert.match(app.elements.get('tabs').innerHTML,/data-view="payments" aria-pressed="true"/);
  assert.equal(app.elements.get('originals').textContent,'USD 12.00');
  assert.match(app.elements.get('list').innerHTML,/Fictional Monthly/);
  assert.doesNotMatch(app.elements.get('list').innerHTML,/Fictional Annual|Fictional Upcoming|Fictional Date Unknown|Fictional Held/);
  month.value='2026-07';await month.dispatch('change');
  assert.equal(app.elements.get('originals').textContent,'USD 120.00');
  assert.match(app.elements.get('list').innerHTML,/Fictional Annual/);
  assert.doesNotMatch(app.elements.get('list').innerHTML,/Fictional Monthly/);
  month.value='2026-09';await month.dispatch('change');
  assert.match(app.elements.get('list').innerHTML,/No matching records/);
  assert.doesNotMatch(app.elements.get('originals').textContent,/120|12\.00|999/);
});

test('reopening a selected month restores its expense list while the subscription library and review queue explicitly cover all dates',async()=>{
  for(const language of ['en','zh']){
    const events=[syntheticReceipt('known'),syntheticReceipt('no-date',{serviceKey:'unknown',service:'Fictional Unknown Date',paymentDay:null,paymentDateBasis:'unknown'})];
    const app=await harness({events,prefs:{language,month:'2026-08'}});
    assert.match(app.elements.get('tabs').innerHTML,/data-view="payments" aria-pressed="true"/);
    assert.doesNotMatch(app.elements.get('list').innerHTML,/Fictional Unknown Date/);
    const choose=async view=>app.elements.get('tabs').dispatch('click',{target:{closest:()=>({dataset:{view}})}});
    await choose('other');
    assert.match(app.elements.get('list').innerHTML,/Fictional Unknown Date/);
    assert.match(app.elements.get('list').innerHTML,language==='zh'?/付款仍需核對/:/Payment needs verification/);
    assert.match(app.elements.get('count').textContent,language==='zh'?/所有日期/:/All dates/);
    await choose('subs');
    assert.equal(app.elements.get('list-label').textContent,language==='zh'?'全部訂閱':'All subscriptions');
    assert.match(app.elements.get('count').textContent,language==='zh'?/所有日期/:/All dates/);
    await app.open('fictional');
    assert.match(app.elements.get('detail-body').innerHTML,language==='zh'?/已記錄付款・所有月份/:/Recorded payments · all months/);
  }
});


test('saved stale review counts are recomputed across parser versions before Gmail connects',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const initialState={parserVersion:'4',scannedIds:['old','new'],sourceProcessing:{old:['3','needs_review',1,1,null,'document_review'],new:['4','needs_review',1,1,null,'currency_unknown']},processingSummary:{needsReview:1}};
  const app=await harness({initialState,mcpReady:gate});
  assert.match(app.elements.get('coverage').textContent,/2 messages need another look/);
  assert.match(app.elements.get('list').innerHTML,/Fictional alpha/);
  release({});
});
