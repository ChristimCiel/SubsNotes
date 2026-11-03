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

const flush = () => new Promise(resolve=>setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const template = await readFile(new URL('../src/claude-dashboard.html',import.meta.url),'utf8');

// A minimal DOM harness exercises the mounted handlers against delayed storage.
// Native dialog focus and browser layout are separately verified in browser QA.
async function harness() {
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
  let persisted={version:1,events:['alpha','beta'].map(key=>({id:key,messageId:'synthetic-'+key,serviceKey:key,service:'Fictional '+key,category:'Software',kind:'payment_succeeded',authenticated:true,receivedAt:'2026-07-01T01:00:00Z',payment:{currency:'USD',minor:1200},paymentDay:'2026-07-01',paymentDateBasis:'explicit'})),prefs:{}};
  const pendingSaves=[];
  const store={load:async()=>clone(persisted),getRevision:async()=>persisted.storageRevision||null,save:next=>new Promise((resolve,reject)=>pendingSaves.push({next:clone(next),resolve:()=>{persisted=clone(next);resolve();},reject}))};
  const capabilities={mcp:{},db:{},user:{id:async()=>'fictional-user'},permissions:{manage(){}}};
  const window={claude:{use:async key=>capabilities[key]},addEventListener(){}};
  const mount=vm.runInNewContext('('+mountClaudeDashboard.toString()+')',{document,window,crypto:webcrypto,TextEncoder,setInterval(){}});
  mount({createEvidenceRuntime,createCashflowRuntime,createFxRuntime,createSubscriptionViewRuntime,extractWebEvidence(){},createClaudePersonalStore:()=>store,createClaudeRatesClient:()=>({load:async()=>{throw new Error('Rates unavailable in this test');}}),createClaudeGmailClient:()=>({}),createWebSync:()=>({run(){throw new Error('No scan is requested by these tests');}})});
  for(let i=0;i<4;i++)await flush();
  const open=async key=>{const button=new Element('row');button.dataset.record=key;button.closest=()=>button;await elements.get('list').dispatch('click',{target:button});};
  const change=days=>{const select=elements.get('review');select.value=String(days);return select.dispatch('change');};
  return {elements,pendingSaves,open,change,get persisted(){return clone(persisted);}};
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
