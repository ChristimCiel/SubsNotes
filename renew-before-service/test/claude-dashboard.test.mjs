import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { mountClaudeDashboard } from '../src/claude-dashboard.mjs';
import { createSubscriptionActivityRuntime } from '../src/subscription-activity.mjs';
import { createEvidenceRuntime } from '../src/evidence-runtime.mjs';
import { createCashflowRuntime } from '../src/cashflow.mjs';
import { createFxRuntime } from '../src/fx.mjs';
import { createSubscriptionViewRuntime } from '../src/subscription-view.mjs';
import { createServiceBrandsRuntime } from '../src/service-brands.mjs';
import { createSourceEvidenceMerger } from '../src/web-sync.mjs';
import { preserveReceiptVerification } from '../src/receipt-verification.mjs';
import { createLedgerContracts } from '../src/ledger-contracts.mjs';
import { createI18nRuntime } from '../src/i18n.mjs';
import { createPaymentConfirmationRuntime } from '../src/payment-confirmations.mjs';

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
        for(const [id]of elements)if(id==='review'||id==='review-result'||id.startsWith('confirm-')||id.startsWith('confirmation-'))elements.delete(id);
        for(const [,attrs,id]of value.matchAll(/<[^>]*?(\bid="([^"]+)"[^>]*)>/g)) {
          const element=new Element(id),initial=attrs.match(/\bvalue="([^"]*)"/);element.value=initial?.[1]||'';element.hidden=/\bhidden(?:\s|$)/.test(attrs);elements.set(id,element);
        }
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
  store.saveUserConfirmations=next=>store.save(next);
  const capabilities={mcp:{},db:{},user:{id:async()=>'fictional-user'},permissions:{manage(){}}};
  const window={claude:{use:async key=>key==='mcp'&&mcpReady?await mcpReady:capabilities[key]},addEventListener(){}};
  const ClockDate = now ? class extends Date { constructor(...args){super(...(args.length?args:[now]));}static now(){return new Date(now).getTime();} } : Date;
  const mount=vm.runInNewContext('('+mountClaudeDashboard.toString()+')',{document,window,crypto:webcrypto,TextEncoder,Date:ClockDate,setInterval(){}});
  mount({createI18nRuntime,createPaymentConfirmationRuntime:()=>{const runtime=createPaymentConfirmationRuntime();return {...runtime,set:(state,input,options)=>runtime.set(state,clone(input),options)};},createSubscriptionActivityRuntime,createEvidenceRuntime,createCashflowRuntime,createFxRuntime,createSubscriptionViewRuntime,createServiceBrandsRuntime,createSourceEvidenceMerger,preserveReceiptVerification,createLedgerContracts,extractWebEvidence(){},createClaudePersonalStore:()=>store,createClaudeRatesClient:()=>({load:async()=>{throw new Error('Rates unavailable in this test');}}),createClaudeGmailClient:()=>({}),createWebSync:()=>({run:syncRun||(()=>{throw new Error('No scan is requested by these tests');})})});
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
  assert.match(app.elements.get('count').textContent,/0 services · All dates · 1 likely inactive hidden/);
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
  assert.equal(scans,0);assert.match(app.elements.get('status').textContent,/Saved records reloaded/);assert.equal(app.elements.get('count').textContent,'3 services · All dates');assert.match(app.elements.get('list').innerHTML,/Fictional gamma/);
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

test('the chosen Payments view keeps exact actual-payment rows when changing months, with annual charges only in their payment month',async()=>{
  const events=[
    syntheticReceipt('annual-paid',{serviceKey:'annual',service:'Fictional Annual',cadence:'annual',payment:{currency:'USD',minor:12000},paymentDay:'2026-07-31',receivedAt:'2026-08-01T00:30:00Z'}),
    syntheticReceipt('monthly-paid',{serviceKey:'monthly',service:'Fictional Monthly',paymentDay:'2026-08-20'}),
    syntheticReceipt('future-renewal',{serviceKey:'upcoming',service:'Fictional Upcoming',kind:'renewal_notice',payment:undefined,nextCharge:{currency:'USD',minor:99900},nextBilling:'2026-08-25'}),
    syntheticReceipt('unknown-date',{serviceKey:'unknown',service:'Fictional Date Unknown',paymentDay:null,paymentDateBasis:'unknown'}),
    syntheticReceipt('held-paid',{serviceKey:'held',service:'Fictional Held',sourceProcessingConflict:true})
  ];
  const app=await harness({events,prefs:{language:'en',view:'payments'}}),month=app.elements.get('month');
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

test('reopening preserves an explicit Payments view while subscriptions show selected-month evidence and Other retains all dates',async()=>{
  for(const language of ['en','zh']){
    const events=[syntheticReceipt('known'),syntheticReceipt('no-date',{serviceKey:'unknown',service:'Fictional Unknown Date',paymentDay:null,paymentDateBasis:'unknown'})];
    const app=await harness({events,prefs:{language,month:'2026-08',view:'payments'}});
    assert.match(app.elements.get('tabs').innerHTML,/data-view="payments" aria-pressed="true"/);
    assert.doesNotMatch(app.elements.get('list').innerHTML,/Fictional Unknown Date/);
    const choose=async view=>app.elements.get('tabs').dispatch('click',{target:{closest:()=>({dataset:{view}})}});
    await choose('other');
    assert.match(app.elements.get('list').innerHTML,/Fictional Unknown Date/);
    assert.match(app.elements.get('list').innerHTML,language==='zh'?/付款仍需核對/:/Payment needs verification/);
    assert.match(app.elements.get('count').textContent,language==='zh'?/所有日期/:/All dates/);
    await choose('subs');
    assert.equal(app.elements.get('list-label').textContent,language==='zh'?'當月訂閱依據':'Subscription evidence this month');
    assert.doesNotMatch(app.elements.get('count').textContent,/All dates|所有日期/);
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


test('annual access remains in monthly subscriptions without creating another payment, and today’s cancellation does not erase history',async()=>{
  const events=[
    syntheticReceipt('year',{serviceKey:'yearly',service:'Fictional Yearly',paymentDay:'2026-07-01',receivedAt:'2026-07-01T00:00:00Z',cadence:'annual',period:{start:'2026-07-01',end:'2027-07-01'}}),
    syntheticReceipt('off',{serviceKey:'yearly',service:'Fictional Yearly',kind:'renewal_disabled',payment:undefined,paymentDay:undefined,receivedAt:'2026-11-01T00:00:00Z',accessEnds:'2027-07-01'})
  ];
  const app=await harness({events,prefs:{month:'2026-10',language:'en'},now:'2026-11-04T00:00:00Z'});
  assert.match(app.elements.get('tabs').innerHTML,/data-view="subs" aria-pressed="true"/);
  assert.match(app.elements.get('list').innerHTML,/Fictional Yearly/);assert.match(app.elements.get('list').innerHTML,/Service period recorded/);
  assert.equal(app.elements.get('originals').textContent,'No dated payments recorded');
  assert.match(app.elements.get('month').innerHTML,/2026-09/);
  await app.open('yearly');assert.match(app.elements.get('detail-body').innerHTML,/Evidence for the selected month/);assert.match(app.elements.get('detail-body').innerHTML,/Current recorded status/);
  app.elements.get('detail').close();
  await app.elements.get('tabs').dispatch('click',{target:{closest:()=>({dataset:{view:'payments'}})}});
  assert.doesNotMatch(app.elements.get('list').innerHTML,/Fictional Yearly/);
  const month=app.elements.get('month');month.value='2026-07';await month.dispatch('change');
  assert.match(app.elements.get('list').innerHTML,/Fictional Yearly/);
  assert.match(app.elements.get('tabs').innerHTML,/data-view="payments" aria-pressed="true"/);
});

test('month changes keep Subscriptions selected and persist the view instead of silently switching to Payments',async()=>{
  const app=await harness({prefs:{language:'en'}}),month=app.elements.get('month');
  month.value='2026-08';await month.dispatch('change');await flush();
  assert.match(app.elements.get('tabs').innerHTML,/data-view="subs" aria-pressed="true"/);
  assert.equal(app.pendingSaves[0].next.prefs.view,'subs');
  app.pendingSaves[0].resolve();await flush();await flush();
  const reopened=await harness({events:app.persisted.events,prefs:app.persisted.prefs});
  assert.match(reopened.elements.get('tabs').innerHTML,/data-view="subs" aria-pressed="true"/);
});

test('selected-month review passes real calendar boundaries, preserves the view and shows scope separately from extraction',async()=>{
  let received;const app=await harness({prefs:{language:'en',month:'2026-09',timeZone:'Asia/Taipei'},syncRun:async options=>{received=options;return {state:app.persisted,complete:true};}});
  await app.elements.get('review-month').dispatch('click');for(let i=0;i<5;i++)await flush();
  assert.equal(received.since,1788192000);assert.equal(received.until,1790784000);assert.equal(received.includeSpamTrash,false);
  assert.match(app.elements.get('month-coverage').textContent,/not been fully reviewed/);
  assert.match(app.elements.get('tabs').innerHTML,/data-view="subs" aria-pressed="true"/);
  if(app.pendingSaves.length){app.pendingSaves[0].resolve();await flush();}
});

test('saved month coverage never implies extraction completeness or a global excluded count for that month',async()=>{
  const app=await harness({events:[syntheticReceipt('unknown-date',{paymentDay:null,paymentDateBasis:'unknown'})],prefs:{month:'2026-09',language:'en',timeZone:'Asia/Taipei'},initialState:{discoveryCoverage:{format:'ranges-v1',ranges:[['billing-v3',false,1788192000,1790784000,'2026-11-04T00:00:00Z']]}}});
  assert.match(app.elements.get('month-coverage').textContent,/query was completed; extraction may still need review/);
  assert.match(app.elements.get('basis').textContent,/across all dates/);
  assert.match(app.elements.get('list').innerHTML,/Service dates need checking/);
});


test('undated history stays accessible in a separate disclosure and never inflates the documented-period count',async()=>{
  const events=[syntheticReceipt('annual',{serviceKey:'annual',service:'Fictional Annual',period:{start:'2026-07-01',end:'2027-07-01'}}),syntheticReceipt('undated',{serviceKey:'undated',service:'Fictional Undated',period:null,paymentDay:null})];
  const app=await harness({events,prefs:{month:'2026-10',language:'en'},now:'2026-11-04T00:00:00Z'});
  assert.equal(app.elements.get('count').textContent,'1 with periods · 1 to check');
  assert.match(app.elements.get('list').innerHTML,/<details class="unassigned"><summary>Dates needed · not assigned to this month · 1/);
  assert.match(app.elements.get('list').innerHTML,/Fictional Undated/);
  app.elements.get('search').value='Undated';await app.elements.get('search').dispatch('input');
  assert.match(app.elements.get('list').innerHTML,/<details class="unassigned" open>/);
});


test('an immediately requested month review uses the selected Spam scope while its preference write is still pending',async()=>{
  let received;const app=await harness({prefs:{language:'en',month:'2026-09',includeSpamTrash:false},syncRun:async options=>{received=options;return {state:app.persisted,complete:true,scanKind:'history_review'};}});
  const checkbox=app.elements.get('spam');checkbox.checked=true;await checkbox.dispatch('change');await flush();
  assert.equal(app.persisted.prefs.includeSpamTrash,false);assert.equal(app.pendingSaves.length,1);
  const scan=app.elements.get('review-month').dispatch('click');await flush();assert.equal(checkbox.checked,true);
  app.pendingSaves[0].resolve();for(let i=0;i<8;i++)await flush();await scan;
  assert.equal(received.includeSpamTrash,true);assert.equal(app.persisted.prefs.includeSpamTrash,true);
});

// Synthetic invoice fixtures exercise the previously invisible financial queue.
const fictionalInvoices=Array.from({length:10},(_,i)=>({id:'fictional-reviewed-invoice-'+i,messageId:'synthetic-invoice-mail-'+i,kind:'invoice_recorded',serviceKey:'chatgpt',service:'ChatGPT',category:'AI tools',issuerDomain:'tax.openai.com',authenticated:true,receivedAt:`2026-${String(i+1).padStart(2,'0')}-12T00:00:00Z`,invoiceDay:`2026-${String(i+1).padStart(2,'0')}-10`,reference:'FICTIONAL-INVOICE-'+i,invoiceAmount:{currency:'EUR',minor:1700+i},payment:null,paymentDay:null,paymentDateBasis:'unknown',receiptVerification:{checkedAt:'2026-11-01T00:00:00Z',fields:['invoiceAmount'],sources:[]}}));

test('all document-reviewed invoices are reachable from the total and searchable under OpenAI or ChatGPT',async()=>{
 const app=await harness({events:fictionalInvoices,prefs:{month:'2026-08',language:'en'}});
 assert.equal(app.elements.get('invoice-review').hidden,false);assert.match(app.elements.get('invoice-review').textContent,/10 invoices need payment verification/);
 await app.elements.get('invoice-review').dispatch('click');
 assert.equal(app.elements.get('filter').value,'invoices');assert.equal(app.elements.get('filter').hidden,false);
 assert.equal(app.elements.get('count').textContent,'10 records · All dates');
 for(const query of ['OpenAI','ChatGPT']){app.elements.get('search').value=query;await app.elements.get('search').dispatch('input');assert.equal(app.elements.get('count').textContent,'10 records · All dates');}
 assert.equal((app.elements.get('list').innerHTML.match(/data-record=/g)||[]).length,10);
 await app.open(fictionalInvoices[0].id);
 const detail=app.elements.get('detail-body').innerHTML;
 assert.match(detail,/This invoice is not included in payments/);assert.match(detail,/Invoice document checked · payment unverified/);assert.doesNotMatch(detail,/Receipt\/document checked/);assert.match(detail,/Invoice issue date/);assert.match(detail,/EUR/);assert.match(detail,/synthetic-invoice-mail-0/);
 assert.doesNotMatch(app.elements.get('originals').textContent,/EUR/);
 assert.equal(app.elements.get('total').textContent,'No dated payments recorded');
});

test('invoice review survives saved-state reopening in both languages and never appears as paid',async()=>{
 for(const language of ['en','zh']){
  const app=await harness({events:fictionalInvoices,prefs:{language,view:'other',month:'2026-08'}});
  assert.match(app.elements.get('list').innerHTML,/fictional-reviewed-invoice-9/);
  assert.match(app.elements.get('invoice-review').textContent,language==='zh'?/10 張發票的付款待核對/:/10 invoices need payment verification/);
  const target={dataset:{view:'payments'},closest(){return this;}};await app.elements.get('tabs').dispatch('click',{target});
  assert.doesNotMatch(app.elements.get('list').innerHTML,/data-record=/);
 }
});

test('a newly discovered invoice notification is queued even before its product and document amounts are known',async()=>{
 const [event]=createEvidenceRuntime(x=>x).extractEvidence({id:'synthetic-fresh-tax-mail',sender:'noreply@tax.openai.com',subject:'Your eGUI FICTIONAL from OpenAI',text:'An invoice has been prepared for your purchase.',receivedAt:'2026-08-03T00:00:00Z',authenticatedSenderDomain:'tax.openai.com'});
 const app=await harness({events:[event],prefs:{month:'2026-08',language:'en'}});
 assert.match(app.elements.get('invoice-review').textContent,/1 invoices need payment verification/);
 await app.elements.get('invoice-review').dispatch('click');
 assert.match(app.elements.get('list').innerHTML,/OpenAI/);assert.equal(app.elements.get('count').textContent,'1 records · All dates');
 await app.open(event.id);assert.match(app.elements.get('detail-body').innerHTML,/This invoice is not included in payments/);
});

async function flushUi(){for(let i=0;i<8;i++)await flush();}
async function settleWrites(app){
 app.settledWrites||=0;
 for(let i=0;i<20;i++){
  await flushUi();
  const next=app.pendingSaves[app.settledWrites];if(!next)return;
  next.resolve();app.settledWrites++;
 }
 throw new Error('Synthetic UI writes did not settle');
}
async function submitPayment(app,{precision='month',month='2026-08',date='',amount,currency}={}){
 app.elements.get('confirm-precision').value=precision;await app.elements.get('confirm-precision').dispatch('change');
 if(month!==undefined)app.elements.get('confirm-month').value=month;
 if(date!==undefined)app.elements.get('confirm-date').value=date;
 if(amount!==undefined)app.elements.get('confirm-amount').value=amount;
 if(currency!==undefined)app.elements.get('confirm-currency').value=currency;
 await app.elements.get('confirmation-form').dispatch('submit');await flushUi();
}
const confirmationNow='2027-02-12T00:00:00Z';

test('an exact-day confirmation saves privately, leaves original evidence intact and appears only in its paid month',async()=>{
 const invoice=fictionalInvoices[0],app=await harness({events:fictionalInvoices,prefs:{language:'en',view:'other',month:'2026-08'},now:confirmationNow});
 await app.open(invoice.id);assert.ok(app.elements.get('confirmation-form'));
 await submitPayment(app,{precision:'day',date:'2026-08-31'});
 assert.equal(app.elements.get('confirm-save').disabled,true);assert.match(app.elements.get('confirmation-result').textContent,/Saving confirmation/);
 await settleWrites(app);
 const record=app.persisted.paymentConfirmations[invoice.id];assert.equal(record.precision,'day');assert.equal(record.date,'2026-08-31');assert.equal(record.provenance,'user');
 assert.deepEqual(app.persisted.events,fictionalInvoices);assert.match(app.elements.get('detail-body').innerHTML,/Confirmed by you/);assert.match(app.elements.get('detail-body').innerHTML,/saved privately/);
 assert.match(app.elements.get('invoice-review').textContent,/9 invoices/);assert.match(app.elements.get('originals').textContent,/EUR.*17\.00/);
 await app.elements.get('confirm-view-payment').dispatch('click');await settleWrites(app);
 assert.match(app.elements.get('tabs').innerHTML,/data-view="payments" aria-pressed="true"/);assert.match(app.elements.get('list').innerHTML,/Aug 31, 2026/);assert.match(app.elements.get('list').innerHTML,/Confirmed by you/);
 app.elements.get('month').value='2026-09';await app.elements.get('month').dispatch('change');await settleWrites(app);
 assert.doesNotMatch(app.elements.get('list').innerHTML,new RegExp('data-record="'+invoice.id+'"'));
 const reopened=await harness({initialState:app.persisted,now:confirmationNow});assert.equal(reopened.persisted.paymentConfirmations[invoice.id].date,'2026-08-31');
});

test('month-only confirmation stores no invented day and migrates legacy Traditional Chinese on a saved user action',async()=>{
 const invoice=fictionalInvoices[0],app=await harness({events:[invoice],prefs:{language:'zh',view:'other',month:'2026-02'},now:confirmationNow});
 await app.open(invoice.id);await submitPayment(app,{precision:'month',month:'2026-02'});await settleWrites(app);
 const record=app.persisted.paymentConfirmations[invoice.id];assert.equal(record.precision,'month');assert.equal(record.month,'2026-02');assert.equal(record.date,undefined);assert.equal(app.persisted.prefs.language,'zh-TW');
 assert.match(app.elements.get('detail-body').innerHTML,/已確認月份・未指定日期/);assert.doesNotMatch(JSON.stringify(record),/2026-02-01/);
 await app.elements.get('confirm-view-payment').dispatch('click');await settleWrites(app);
 assert.match(app.elements.get('list').innerHTML,/2026年2月/);assert.match(app.elements.get('list').innerHTML,/由你確認/);assert.doesNotMatch(app.elements.get('list').innerHTML,/2026年2月1日/);
 const reopened=await harness({initialState:app.persisted,now:confirmationNow});assert.match(reopened.elements.get('list').innerHTML,/2026年2月/);
 reopened.elements.get('detail').close();await reopened.elements.get('language').dispatch('click');await settleWrites(reopened);
 assert.equal(reopened.persisted.prefs.language,'en');assert.match(reopened.elements.get('list').innerHTML,/February 2026/);
 assert.deepEqual(reopened.persisted.paymentConfirmations,app.persisted.paymentConfirmations);
});

test('editing, undoing and removing a confirmation preserve history and original invoices without duplicating payments',async()=>{
 const invoice=fictionalInvoices[0],app=await harness({events:[invoice],prefs:{language:'en',view:'other',month:'all'},now:confirmationNow});
 await app.open(invoice.id);await submitPayment(app,{precision:'day',date:'2026-08-25'});await settleWrites(app);
 assert.equal(app.elements.get('confirm-undo'),undefined);
 await app.elements.get('confirm-edit').dispatch('click');await submitPayment(app,{precision:'month',month:'2026-09',currency:'JPY',amount:'800'});await settleWrites(app);
 let record=app.persisted.paymentConfirmations[invoice.id];assert.equal(record.revision,2);assert.equal(record.month,'2026-09');assert.deepEqual(record.amount,{minor:800,currency:'JPY'});assert.equal(record.history.length,1);
 assert.match(app.elements.get('detail-body').innerHTML,/New source information differs/);
 await app.elements.get('confirm-undo').dispatch('click');await settleWrites(app);record=app.persisted.paymentConfirmations[invoice.id];assert.equal(record.revision,3);assert.equal(record.date,'2026-08-25');assert.equal(record.amount.currency,'EUR');
 await app.elements.get('confirm-remove').dispatch('click');await settleWrites(app);assert.equal(app.persisted.paymentConfirmations[invoice.id].active,false);assert.match(app.elements.get('invoice-review').textContent,/1 invoices/);assert.match(app.elements.get('detail-body').innerHTML,/removed/);
 await app.elements.get('confirm-undo').dispatch('click');await settleWrites(app);record=app.persisted.paymentConfirmations[invoice.id];assert.equal(record.active,true);assert.equal(record.revision,5);assert.equal(record.history.length,4);assert.deepEqual(app.persisted.events,[invoice]);
 assert.match(app.elements.get('originals').textContent,/EUR.*17\.00/);assert.equal(app.elements.get('invoice-review').hidden,true);
});

test('invalid calendar days and currency precision show localized errors without saving a confirmation',async()=>{
 for(const language of ['en','zh-TW']){
  const app=await harness({events:[fictionalInvoices[0]],prefs:{language,view:'other'},now:confirmationNow});await app.open(fictionalInvoices[0].id);
  await submitPayment(app,{precision:'day',date:'2026-02-30'});assert.equal(app.pendingSaves.length,0);assert.equal(app.persisted.paymentConfirmations,undefined);assert.match(app.elements.get('detail-body').innerHTML,language==='en'?/valid payment date/:/有效的付款日期/);
  await submitPayment(app,{precision:'month',month:'2026-03',currency:'JPY',amount:'1.23'});assert.equal(app.pendingSaves.length,0);assert.match(app.elements.get('detail-body').innerHTML,language==='en'?/decimal places/:/小數位數/);
 }
});

test('a failed payment save keeps the persisted confirmation and the unsaved draft with clear recovery feedback',async()=>{
 const invoice=fictionalInvoices[0],initial=createPaymentConfirmationRuntime().set({events:[invoice],prefs:{language:'en',view:'other'}},{eventId:invoice.id,precision:'day',date:'2026-07-08',amount:{currency:'EUR',minor:1700},expectedRevision:0},{now:confirmationNow});
 const app=await harness({initialState:initial,now:confirmationNow});await app.open(invoice.id);await app.elements.get('confirm-edit').dispatch('click');await submitPayment(app,{precision:'month',month:'2026-08',amount:'19.60'});
 assert.equal(app.pendingSaves.length,1);app.pendingSaves[0].reject(new Error('Synthetic private https://example.invalid/secret'));await flushUi();
 assert.equal(app.persisted.paymentConfirmations[invoice.id].date,'2026-07-08');assert.equal(app.elements.get('confirm-amount').value,'19.60');assert.match(app.elements.get('detail-body').innerHTML,/could not be confirmed/);assert.doesNotMatch(app.elements.get('detail-body').innerHTML,/example|secret/);
});

test('a stale edit cannot overwrite a later saved confirmation',async()=>{
 const runtime=createPaymentConfirmationRuntime(),invoice=fictionalInvoices[0];let initial=runtime.set({events:[invoice],prefs:{language:'en',view:'other'}},{eventId:invoice.id,precision:'month',month:'2026-06',amount:{currency:'EUR',minor:1700},expectedRevision:0},{now:confirmationNow});
 const app=await harness({initialState:initial,now:confirmationNow});await app.open(invoice.id);await app.elements.get('confirm-edit').dispatch('click');
 const external=runtime.set(app.persisted,{eventId:invoice.id,precision:'month',month:'2026-07',amount:{currency:'EUR',minor:1700},expectedRevision:1},{now:confirmationNow});app.replace(external);
 await submitPayment(app,{precision:'month',month:'2026-08'});assert.equal(app.pendingSaves.length,0);assert.equal(app.persisted.paymentConfirmations[invoice.id].month,'2026-07');assert.match(app.elements.get('detail-body').innerHTML,/changed elsewhere/);
 app.elements.get('detail').close();await app.open(invoice.id);assert.match(app.elements.get('detail-body').innerHTML,/July 2026/);await app.elements.get('confirm-edit').dispatch('click');await submitPayment(app,{precision:'month',month:'2026-08'});await settleWrites(app);assert.equal(app.persisted.paymentConfirmations[invoice.id].month,'2026-08');assert.equal(app.persisted.paymentConfirmations[invoice.id].revision,3);
});

test('a scan waits for an accepted confirmation save and retains it when the source data is refreshed',async()=>{
 const invoice=fictionalInvoices[0];let observed;
 const app=await harness({events:[invoice],prefs:{language:'en',view:'other',month:'all'},now:confirmationNow,syncRun:async()=>{observed=app.persisted.paymentConfirmations;return{state:app.persisted,complete:true,scanKind:'history_review'};}});
 await app.open(invoice.id);await submitPayment(app,{precision:'month',month:'2026-08'});assert.equal(app.pendingSaves.length,1);
 await app.elements.get('sync').dispatch('click');await flushUi();assert.equal(observed,undefined);assert.equal(app.elements.get('confirm-save').disabled,true);
 await settleWrites(app);await flushUi();assert.equal(observed[invoice.id].month,'2026-08');assert.equal(app.persisted.paymentConfirmations[invoice.id].month,'2026-08');assert.match(app.elements.get('detail-body').innerHTML,/Confirmed by you/);
});


test('future renewal dates and months cannot be saved as payments that already happened in either language',async()=>{
 for(const language of ['en','zh-TW']){
  const app=await harness({events:[fictionalInvoices[0]],prefs:{language,view:'other'},now:confirmationNow});await app.open(fictionalInvoices[0].id);
  for(const input of [{precision:'day',date:'2028-01-01'},{precision:'month',month:'2028-01'}]){
   await submitPayment(app,input);assert.equal(app.pendingSaves.length,0);assert.equal(app.persisted.paymentConfirmations,undefined);
   assert.match(app.elements.get('detail-body').innerHTML,language==='en'?/payment already happened/:/付款已發生/);
   assert.equal(app.elements.get('confirmation-result').focused,true);
  }
 }
});


test('confirming a one-time, donation or unclassified payment does not promise subscription spending or an empty Payments destination',async()=>{
 for(const category of ['One-time purchases','Donations','Unclassified'])for(const language of ['en','zh-TW']){
  const invoice={...fictionalInvoices[0],category},app=await harness({events:[invoice],prefs:{language,view:'other',month:'all'},now:confirmationNow});await app.open(invoice.id);
  assert.match(app.elements.get('detail-body').innerHTML,language==='en'?/does not establish a subscription/:/不代表已有訂閱/);
  await submitPayment(app,{precision:'month',month:'2026-01'});await settleWrites(app);
  assert.equal(app.persisted.paymentConfirmations[invoice.id].active,true);assert.equal(app.elements.get('confirm-view-payment'),undefined);
  assert.doesNotMatch(app.elements.get('originals').textContent,/17\.00/);assert.match(app.elements.get('detail-body').innerHTML,language==='en'?/Confirmed by you/:/由你確認/);
 }
});

test('ChatGPT retains its bundled OpenAI mark in both languages while permission-gated Claude retains initials',async()=>{
 for(const language of ['en','zh-TW']){
  const app=await harness({events:[syntheticReceipt('chatgpt-logo',{serviceKey:'chatgpt',service:'ChatGPT'}),syntheticReceipt('claude-logo',{serviceKey:'claude',service:'Claude'})],prefs:{language,view:'payments'}});
  const rows=app.elements.get('list').innerHTML.split('</button>'),chatgpt=rows.find(row=>row.includes('data-record="chatgpt-logo"')),claude=rows.find(row=>row.includes('data-record="claude-logo"'));
  assert.match(chatgpt,/<img src="data:image\/svg\+xml;base64,/);assert.match(claude,/<span>CL<\/span>/);assert.doesNotMatch(claude,/<img/);
  assert.match(app.elements.get('brand-notice').textContent,/OpenAI Blossom/);
 }
});


test('a rescan that reclassifies a confirmed invoice keeps its user confirmation, edit and undo history accessible',async()=>{
 const runtime=createPaymentConfirmationRuntime(),invoice=fictionalInvoices[0];let state=runtime.set({events:[invoice],prefs:{language:'en',view:'other',month:'all'}},{eventId:invoice.id,precision:'month',month:'2026-01',amount:{currency:'EUR',minor:1700},expectedRevision:0},{now:confirmationNow});
 state={...state,events:[{...invoice,kind:'one_time_purchase',payment:{currency:'EUR',minor:1700}}]};const app=await harness({initialState:state,now:confirmationNow});await app.open(invoice.id);
 assert.match(app.elements.get('detail-body').innerHTML,/Confirmed by you/);assert.match(app.elements.get('detail-body').innerHTML,/does not establish a subscription/);assert.equal(app.elements.get('confirm-view-payment'),undefined);
 await app.elements.get('confirm-edit').dispatch('click');await submitPayment(app,{precision:'day',date:'2026-01-19'});await settleWrites(app);assert.equal(app.persisted.paymentConfirmations[invoice.id].date,'2026-01-19');assert.equal(app.persisted.paymentConfirmations[invoice.id].source.kind,'invoice_recorded');
 await app.elements.get('confirm-remove').dispatch('click');await settleWrites(app);assert.equal(app.persisted.paymentConfirmations[invoice.id].active,false);assert.ok(app.elements.get('confirm-undo'));
 await app.elements.get('confirm-undo').dispatch('click');await settleWrites(app);assert.equal(app.persisted.paymentConfirmations[invoice.id].active,true);assert.match(app.elements.get('detail-body').innerHTML,/Confirmed by you/);assert.doesNotMatch(app.elements.get('originals').textContent,/17\.00/);
});


test('a missing local source never hides the saved user confirmation or its undo history and original message link',async()=>{
 const runtime=createPaymentConfirmationRuntime(),invoice=fictionalInvoices[0];let state=runtime.set({events:[invoice],prefs:{language:'en',view:'payments',month:'all'}},{eventId:invoice.id,precision:'month',month:'2026-01',amount:{currency:'EUR',minor:1700},expectedRevision:0},{now:confirmationNow});
 state={...state,events:[]};const app=await harness({initialState:state,now:confirmationNow});assert.match(app.elements.get('list').innerHTML,/Confirmed by you/);await app.open(invoice.id);
 assert.match(app.elements.get('detail-body').innerHTML,/Confirmed by you/);assert.match(app.elements.get('detail-body').innerHTML,/original payment record is unavailable/);assert.match(app.elements.get('detail-body').innerHTML,new RegExp(invoice.messageId));assert.equal(app.elements.get('confirm-edit').disabled,true);
 await app.elements.get('confirm-remove').dispatch('click');await settleWrites(app);assert.equal(app.persisted.paymentConfirmations[invoice.id].active,false);assert.ok(app.elements.get('confirm-undo'));assert.equal(app.elements.get('confirm-save').disabled,true);
 await app.elements.get('confirm-undo').dispatch('click');await settleWrites(app);assert.equal(app.persisted.paymentConfirmations[invoice.id].active,true);assert.match(app.elements.get('detail-body').innerHTML,/Confirmed by you/);assert.equal(app.persisted.events.length,0);
});

test('a confirmation queued after a language save clears the settings-saving header once both writes finish',async()=>{
 const invoice=fictionalInvoices[0],app=await harness({events:[invoice],prefs:{language:'en',view:'other'},now:confirmationNow});
 await app.elements.get('language').dispatch('click');await flushUi();assert.equal(app.pendingSaves.length,1);await app.open(invoice.id);await submitPayment(app,{precision:'month',month:'2026-01'});
 assert.match(app.elements.get('status').textContent,/正在儲存設定/);app.pendingSaves[0].resolve();await flushUi();assert.equal(app.pendingSaves.length,2);assert.match(app.elements.get('status').textContent,/正在儲存設定/);
 app.pendingSaves[1].resolve();await flushUi();assert.match(app.elements.get('status').textContent,/設定已儲存於私人空間/);assert.doesNotMatch(app.elements.get('status').textContent,/正在儲存/);assert.equal(app.persisted.paymentConfirmations[invoice.id].month,'2026-01');assert.equal(app.persisted.prefs.language,'zh-TW');
});

test('a failed confirmation after a language save retains its meaningful error instead of replacing it with settings-saved status',async()=>{
 const invoice=fictionalInvoices[0],app=await harness({events:[invoice],prefs:{language:'zh-TW',view:'other'},now:confirmationNow});
 await app.elements.get('language').dispatch('click');await flushUi();await app.open(invoice.id);await submitPayment(app,{precision:'month',month:'2026-01'});
 app.pendingSaves[0].resolve();await flushUi();assert.equal(app.pendingSaves.length,2);app.pendingSaves[1].reject(new Error('Synthetic storage failure'));await flushUi();
 assert.match(app.elements.get('status').textContent,/change could not be confirmed/);assert.doesNotMatch(app.elements.get('status').textContent,/Saving your settings|Settings saved privately/);assert.equal(app.elements.get('status').dataset.error,'true');assert.equal(app.persisted.paymentConfirmations,undefined);assert.equal(app.persisted.prefs.language,'en');
});
