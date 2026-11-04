import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createEvidenceRuntime } from '../src/evidence-runtime.mjs';
import { createCashflowRuntime } from '../src/cashflow.mjs';
import { createFxRuntime } from '../src/fx.mjs';
import { createSubscriptionViewRuntime } from '../src/subscription-view.mjs';
import { createI18nRuntime } from '../src/i18n.mjs';

// All records, names and dates are fictional. No mailbox fixtures are used.
const core = createEvidenceRuntime(value => value), cashflow = createCashflowRuntime(), fx = createFxRuntime(), view = createSubscriptionViewRuntime();
const receipt = (id, extra = {}) => ({ id, messageId:id, serviceKey:'fictional', service:'Fictional Music', category:'Software', kind:'payment_succeeded', authenticated:true,
  receivedAt:'2026-08-02T01:00:00Z', sourceReadAt:'2026-09-03T02:00:00Z', paymentDay:'2026-07-31', paymentDateBasis:'explicit', payment:{currency:'USD',minor:14400}, cadence:'annual', ...extra });
const build = (events, extra = {}) => view.build({ state:{ events, storageRevision:'fictional-r2', savedAt:'2026-09-03T02:00:00Z', lastCompletedAt:'2026-09-03T02:00:00Z', prefs:{} }, core, cashflow, fx, asOf:'2026-09-03T03:00:00Z', ...extra });

test('the read view uses actual payment-month cashflow, preserving annual charges and excluding ambiguous dates', () => {
  const events = [receipt('annual'), receipt('date-unknown',{paymentDay:null,paymentDateBasis:'unknown',payment:{currency:'EUR',minor:2500}})];
  const july = build(events,{month:'2026-07'});
  assert.deepEqual(july.totals.paidMinorByCurrency,{USD:14400});
  assert.deepEqual(july.rows[0].paidMinorByCurrency,{USD:14400});
  assert.equal(july.totals.excludedPayments,1);
  assert.equal(july.rows[0].excludedPayments,1);
  assert.deepEqual(build(events,{month:'2026-08'}).totals.paidMinorByCurrency,{});
  assert.equal(july.totals.bankReconciled,false);
  assert.equal(july.coverage.exhaustive,false);
});

test('unknown currency and incomplete coverage cannot become zero spending or verified active status', () => {
  const snapshot = build([receipt('unknown-money',{payment:{currency:null,minor:2000}})]);
  assert.deepEqual(snapshot.totals.paidMinorByCurrency,{});
  assert.equal(snapshot.totals.excludedPayments,1);
  assert.equal(snapshot.rows[0].primaryAmount.currency,null);
  assert.equal(snapshot.rows[0].nextAction,'check_price');
  assert.equal(snapshot.rows[0].status,'needs_verification');
  const html = view.renderHTML(snapshot);
  assert.match(html,/Currency unconfirmed/);
  assert.match(html,/No dated payments recorded/);
  assert.doesNotMatch(html,/>USD\s*0\.00</);
});

test('next price, invoice, paid amount and source freshness retain different meanings', () => {
  const events = [receipt('first',{payment:{currency:'USD',minor:500},receivedAt:'2026-07-01T01:00:00Z'}), {
    ...receipt('future'), kind:'subscription_confirmed', payment:undefined, nextCharge:{currency:'USD',minor:1200}, nextBilling:'2026-10-01', cadence:'monthly', receivedAt:'2026-08-01T01:00:00Z'
  }];
  const snapshot = build(events), row = snapshot.rows[0];
  assert.deepEqual(row.primaryAmount,{currency:'USD',minor:1200});
  assert.deepEqual(row.lastPayment,{currency:'USD',minor:500});
  assert.equal(row.amountBasis,'upcoming');
  assert.equal(row.firstSourceAt,'2026-07-01T01:00:00Z');
  assert.equal(row.lastSourceAt,'2026-08-01T01:00:00Z');
  assert.equal(row.lastReadAt,'2026-09-03T02:00:00Z');
  assert.equal(row.startedAt,null);
  assert.equal(snapshot.ledgerRevision,'fictional-r2');
  assert.match(view.renderHTML(snapshot),/Reading an old email today does not establish today/);
});

test('an adjusted paid amount wins over the listed recurring price unless an explicit next charge exists', () => {
  const event = receipt('discounted',{payment:{currency:'USD',minor:1036},recurringRate:{currency:'USD',minor:4000},hasAdjustments:true});
  const paid = build([event]).rows[0];
  assert.deepEqual(paid.primaryAmount,{currency:'USD',minor:1036});
  assert.equal(paid.amountBasis,'paid');
  assert.deepEqual(paid.recurringRate,{currency:'USD',minor:4000});
  const renewal = {...receipt('explicit-future'),kind:'subscription_confirmed',payment:undefined,receivedAt:'2026-08-03T01:00:00Z',nextCharge:{currency:'USD',minor:2500},nextBilling:'2026-10-01'};
  const upcoming = build([event,renewal]).rows[0];
  assert.deepEqual(upcoming.primaryAmount,{currency:'USD',minor:2500});
  assert.equal(upcoming.amountBasis,'upcoming');
  assert.deepEqual(upcoming.lastPayment,{currency:'USD',minor:1036});
});

test('the minimized snapshot excludes evidence, contact details, credentials and arbitrary URLs', () => {
  const privateMarker = 'DO-NOT-EXPORT-FICTIONAL-SECRET';
  const event = receipt('safe-id',{ evidence:privateMarker, sender:'fictional@example.invalid', subject:privateMarker, reference:privateMarker, account:privateMarker,
    receiptVerification:{checkedAt:'2026-09-03T02:00:00Z',sources:[{quote:privateMarker,attachment:privateMarker,sha256:privateMarker}]}, billingURL:'https://example.invalid/?token='+privateMarker });
  const snapshot = build([event],{state:{events:[event],mailboxHash:privateMarker,tokens:privateMarker,prefs:{},storageRevision:'fictional-r3'}});
  const encoded = JSON.stringify(snapshot), html = view.renderHTML(snapshot);
  assert.ok(!encoded.includes(privateMarker));
  assert.ok(!encoded.includes('example.invalid'));
  assert.ok(!html.includes(privateMarker));
  assert.match(html,/https:\/\/mail.google.com\/mail\/#all\/safe-id/);
  assert.equal(snapshot.rows[0].receiptCheckedAt,'2026-09-03T02:00:00Z');
});

test('different accounts at one provider retain separate totals without exporting account identifiers', () => {
  const events = [receipt('account-a',{accountRef:'PRIVATE-ACCOUNT-A',payment:{currency:'USD',minor:1000}}),receipt('account-b',{accountRef:'PRIVATE-ACCOUNT-B',payment:{currency:'USD',minor:2000}})];
  const snapshot = build(events);
  assert.equal(snapshot.rows.length,2);
  assert.deepEqual(snapshot.rows.map(row=>row.paidMinorByCurrency.USD).sort((a,b)=>a-b),[1000,2000]);
  assert.deepEqual(snapshot.totals.paidMinorByCurrency,{USD:3000});
  assert.deepEqual(snapshot.rows.map(row=>row.serviceKey),['row-1','row-2']);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE-ACCOUNT-'));
  assert.ok(!view.renderHTML(snapshot).includes('PRIVATE-ACCOUNT-'));
});

test('inline output escapes hostile fields and never assumes a host bridge or remote execution', () => {
  const snapshot = build([receipt('safe-id',{service:'</summary><script>evil()</script>',plan:'<img src=x onerror=evil()>'})]);
  snapshot.rows[0].sources.push({messageId:'javascript:evil()'});
  const html = view.renderHTML(snapshot), scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,1);
  assert.doesNotThrow(()=>new Function(scripts[0][1]));
  assert.match(html,/&lt;script&gt;evil\(\)&lt;\/script&gt;/);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html,/connect-src 'none'/);
  assert.doesNotMatch(scripts[0][1],/fetch\(|window\.claude|localStorage|postMessage|callTool|eval\(/);
  assert.match(html,/Changes require your assistant/);
  assert.match(html,/<details class="subscription"/);
  assert.match(html,/<summary>/);
  assert.match(html,/aria-live="polite"/);
  assert.ok(!createSubscriptionViewRuntime.toString().includes('</script'));
});

test('local filter, sort and language controls work without any host or persistence API', () => {
  const html = view.renderHTML(build([receipt('a')]));
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const element = (value = '') => ({ value, dataset:{}, disabled:true, hidden:false, textContent:'', listeners:{}, addEventListener(event,fn){this.listeners[event]=fn;} });
  const a = element(), b = element(), c = element(); c.dataset={name:'gamma',state:'likely_canceled',next:'2026-01-01',source:'2025-12-01'}; a.dataset={name:'beta',state:'renewal_off',next:'2026-10-03',source:'2026-09-01'}; b.dataset={name:'alpha',state:'active',next:'2026-10-01',source:'2026-09-02'};
  const nodes = Object.fromEntries(['view-list','view-scroll','view-search','view-state','view-sort','view-language','view-count','view-no-match'].map(id=>[id,element()]));
  nodes['view-list'].children=[a,b,c]; nodes['view-list'].append = row => { nodes['view-list'].children=nodes['view-list'].children.filter(item=>item!==row); nodes['view-list'].children.push(row); };
  nodes['view-sort'].value='name';
  const timestamp = element(), calendarDay = element();
  timestamp.dataset.date='2026-02-01T18:38:00Z'; calendarDay.dataset.date='2026-02-01';
  const document = { getElementById:id=>nodes[id], documentElement:{}, querySelectorAll:selector=>selector==='time[data-date]'?[timestamp,calendarDay]:[], querySelector:()=>element(), addEventListener(){} };
  const viewerIntl = { DateTimeFormat: function(locale,options){return new Intl.DateTimeFormat(locale,{timeZone:'Asia/Taipei',...options});} };
  vm.runInNewContext(script,{document,Intl:viewerIntl});
  assert.equal(nodes['view-language'].disabled,false);
  assert.match(timestamp.textContent,/Feb 2, 2026/);
  assert.match(timestamp.textContent,/GMT\+8/);
  assert.equal(calendarDay.textContent,'Feb 1, 2026');
  assert.deepEqual(nodes['view-list'].children,[b,a,c]);
  assert.equal(c.hidden,true);assert.equal(nodes['view-state'].value,'current');
  assert.equal(nodes['view-count'].textContent,'2 services · 1 likely inactive hidden');
  nodes['view-scroll'].scrollTop=420;
  nodes['view-search'].value='beta'; nodes['view-search'].listeners.input();
  assert.equal(nodes['view-scroll'].scrollTop,0);
  assert.equal(b.hidden,true); assert.equal(a.hidden,false); assert.equal(nodes['view-count'].textContent,'1 service');
  nodes['view-state'].value='active'; nodes['view-state'].listeners.change();
  assert.equal(nodes['view-no-match'].hidden,false);
  nodes['view-search'].value=''; nodes['view-state'].value=''; nodes['view-sort'].value='newest'; nodes['view-sort'].listeners.change();
  assert.deepEqual(nodes['view-list'].children,[b,a,c]);
  nodes['view-language'].listeners.click();
  assert.equal(document.documentElement.lang,'zh-Hant');
  assert.equal(nodes['view-count'].textContent,'3 項服務');
  nodes['view-state'].value='likely_canceled';nodes['view-state'].listeners.change();
  assert.equal(c.hidden,false);assert.equal(a.hidden,true);assert.equal(b.hidden,true);assert.equal(nodes['view-count'].textContent,'1 項服務');
  assert.equal(nodes['view-search'].ariaLabel,'搜尋服務');
});

test('an empty read view provides an honest next action in both languages', () => {
  const snapshot = build([]);
  for (const language of ['en','zh']) {
    const html = view.renderHTML(snapshot,{language});
    assert.match(html,/empty result does not mean zero spending/);
    assert.match(html,/沒有紀錄不代表沒有支出/);
    assert.match(html,/Read-only snapshot/);
    assert.match(html,/唯讀快照/);
    assert.doesNotMatch(html,/>USD\s*0\.00</);
  }
  assert.throws(()=>view.renderHTML({...snapshot,version:2}),/supported/);
});

test('inline fragments reuse the same dated records and controls without a document wrapper or viewport sizing loop', () => {
  const snapshot = build([receipt('inline')]);
  for (const language of ['en','zh']) {
    const standalone = view.renderHTML(snapshot,{language});
    const inline = view.renderInlineHTML(snapshot,{language});
    assert.match(standalone,/^<!doctype html>/);
    assert.match(standalone,/connect-src 'none'/);
    assert.match(inline,/^<style>/);
    assert.doesNotMatch(inline,/<(?:html|head|body|meta)(?:\s|>)/i);
    assert.doesNotMatch(inline,/Content-Security-Policy/);
    assert.doesNotMatch(inline,/html,body|body\{padding:/);
    assert.doesNotMatch(inline,/height:min\(560px,calc\(100d?vh/);
    assert.match(inline,/max-width:760px;height:560px/);
    assert.match(inline,/id="view-scroll" role="region" tabindex="0"/);
    const standaloneBody = standalone.slice(standalone.indexOf('<body>')+6,standalone.lastIndexOf('</body>'));
    assert.equal(inline.slice(inline.indexOf('</style>')+8),standaloneBody);
    assert.deepEqual([...inline.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]),[...standalone.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]));
  }
});

test('inline rendering remains escaped and read-only when the shared factories are embedded in a host', () => {
  const snapshot = build([receipt('inline-hostile',{service:'<script>alert(1)</script>',plan:'<img src=x onerror=alert(1)>'})]);
  const embedded = vm.runInNewContext(createI18nRuntime.toString()+';('+createSubscriptionViewRuntime.toString()+')()');
  const html = embedded.renderInlineHTML(snapshot);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<img src=x|<script>alert\(1\)/);
  assert.match(html,/Read-only snapshot/);
  assert.match(html,/This view does not update itself/);
  assert.doesNotMatch(html,/fetch\(|window\.claude|window\.openai|localStorage/);
  assert.throws(()=>embedded.renderInlineHTML({...snapshot,version:2}),/supported/);
});

test('synthetic views identify their data and cannot open a real mailbox while real receipt links remain unchanged',()=>{
  const snapshot=build([receipt('synthetic-source')]);
  const before=JSON.stringify(snapshot);
  const real=view.renderHTML(snapshot);
  assert.match(real,/href="https:\/\/mail\.google\.com\/mail\/#all\/synthetic-source"/);
  assert.doesNotMatch(real,/Synthetic demo/);
  for(const language of ['en','zh'])for(const render of [view.renderHTML,view.renderInlineHTML]){
    const demo=render(snapshot,{language,synthetic:true});
    assert.match(demo,/Synthetic demo · no Gmail access/);
    assert.match(demo,/合成來源・不會開啟信箱/);
    assert.match(demo,/class="view-mode synthetic-mode"/);
    assert.doesNotMatch(demo,/mail\.google\.com|href="https:/);
    assert.match(demo,/USD\s*144\.00/);
  }
  assert.equal(JSON.stringify(snapshot),before);
});

test('duplicate providers get local account labels without revealing account identifiers', () => {
  const snapshot = build([receipt('account-1',{accountRef:'PRIVATE-ONE'}),receipt('account-2',{accountRef:'PRIVATE-TWO'})]);
  assert.deepEqual(snapshot.rows.map(row=>[row.accountOrdinal,row.accountCount]),[[1,2],[2,2]]);
  const html = view.renderHTML(snapshot);
  assert.match(html,/Account 1 \/ 2/);
  assert.match(html,/Account 2 \/ 2/);
  assert.match(html,/帳戶 1 \/ 2/);
  assert.ok(!html.includes('PRIVATE-'));
  assert.equal(build([receipt('only-one')]).rows[0].accountOrdinal,null);
});

test('trial deadlines stay canonical and attention dates do not imply an inferred renewal', () => {
  const trial = receipt('trial',{kind:'trial_confirmed',payment:undefined,nextCharge:{currency:'USD',minor:2000},nextBilling:'2026-09-10',cancelBy:'2026-09-08',trialEnds:'2026-09-10'});
  const snapshot = build([trial]), row = snapshot.rows[0];
  assert.equal(row.cancelBy,'2026-09-08');
  assert.equal(row.trialEnds,'2026-09-10');
  assert.equal(row.nextAt,'2026-09-10');
  assert.equal(row.nextAction,'check_trial');
  const html = view.renderHTML(snapshot);
  assert.match(html,/data-next="2026-09-08"/);
  assert.match(html,/Recorded cancel-by date/);
  assert.match(html,/信件記載試用結束/);
  assert.deepEqual(snapshot.totals.paidMinorByCurrency,{});
  const canceled = build([trial,receipt('off',{kind:'renewal_disabled',payment:undefined,receivedAt:'2026-08-03T01:00:00Z',accessEnds:'2026-09-10'})]);
  assert.equal(canceled.rows[0].nextAction,'off_next');
  assert.match(view.renderHTML(canceled),/data-next="2026-09-10"/);
});

test('source links have minimal typed dates, newest first, without exporting email contents', () => {
  const snapshot = build([receipt('old',{receivedAt:'2026-07-01T01:00:00Z'}),receipt('new',{receivedAt:'2026-08-01T01:00:00Z',subject:'PRIVATE-SUBJECT'})]);
  assert.deepEqual(snapshot.rows[0].sources,[{messageId:'new',receivedAt:'2026-08-01T01:00:00Z',type:'payment'},{messageId:'old',receivedAt:'2026-07-01T01:00:00Z',type:'payment'}]);
  const html = view.renderHTML(snapshot);
  assert.ok(html.indexOf('/#all/new') < html.indexOf('/#all/old'));
  assert.match(html,/Payment email/);
  assert.match(html,/付款信件/);
  assert.ok(!html.includes('PRIVATE-SUBJECT'));
  // An older saved snapshot can still open its original messages.
  snapshot.rows[0].sources=[{messageId:'legacy-id'}];
  assert.match(view.renderHTML(snapshot),/Original email/);
});

test('discount warnings use controlled localized categories, never raw warning contents', () => {
  const adjusted = receipt('adjusted',{payment:{currency:'USD',minor:1036},recurringRate:{currency:'USD',minor:4000},hasAdjustments:true});
  const guardedCore = {...core,projectEvidence(...args){const result=core.projectEvidence(...args);result.subscriptions[0].warnings.push('PRIVATE-RAW-WARNING');return result;}};
  const snapshot = build([adjusted],{core:guardedCore});
  assert.deepEqual(snapshot.rows[0].warningCodes,['adjusted_payment']);
  assert.equal(snapshot.rows[0].warningCount,2);
  const html = view.renderHTML(snapshot);
  assert.match(html,/discount or adjustment/);
  assert.match(html,/不代表下次續訂價格/);
  assert.match(html,/USD\s*10\.36/);
  assert.match(html,/USD\s*40\.00/);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE-RAW-WARNING'));
  assert.ok(!html.includes('PRIVATE-RAW-WARNING'));
});

test('bundled branding accepts only bounded data images and preserves initials when unavailable', () => {
  const snapshot = build([receipt('brand')]);
  const safeData = 'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>').toString('base64');
  const branded = createSubscriptionViewRuntime({brands:{resolve:()=>({src:safeData,initials:'FM'}),notices:()=>[{attribution:'Fictional brand attribution.'}]}}).renderHTML(snapshot);
  assert.match(branded,/img-src data:/);
  assert.ok(branded.includes('src="'+safeData+'"'));
  assert.match(branded,/<span>FM<\/span>/);
  assert.match(branded,/Fictional brand attribution/);
  assert.match(branded,/no affiliation or endorsement/);
  for (const src of ['https://remote.invalid/logo.svg','data:image/svg+xml;base64,'+'A'.repeat(32769),'javascript:alert(1)']) {
    const fallback = createSubscriptionViewRuntime({brands:{resolve:()=>({src,initials:'FM'})}}).renderHTML(snapshot);
    assert.doesNotMatch(fallback,/<img data-brand-logo/);
    assert.match(fallback,/<span>FM<\/span>/);
  }
  const failedCatalog = createSubscriptionViewRuntime({brands:{resolve(){throw Error('unavailable');}}}).renderHTML(snapshot);
  assert.match(failedCatalog,/<span>FI<\/span>/);
  assert.doesNotMatch(failedCatalog,/<img data-brand-logo/);
});

test('service expansion, disclosure dismissal and broken-logo fallback work without a host bridge', () => {
  const script = [...view.renderHTML(build([receipt('controls')])).matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const element = (value='') => ({value,dataset:{},disabled:true,hidden:false,open:false,textContent:'',listeners:{},addEventListener(event,fn){this.listeners[event]=fn;},focus(){this.focused=true;}});
  const rows = ['alpha','beta'].map(name=>Object.assign(element(),{dataset:{name,state:'active',next:'2026-10-01',source:'2026-09-01'}}));
  const nodes = Object.fromEntries(['view-list','view-scroll','view-search','view-state','view-sort','view-language','view-count','view-no-match'].map(id=>[id,element()]));
  nodes['view-list'].children=[...rows]; nodes['view-list'].append=()=>{}; nodes['view-sort'].value='name';
  const popovers = [element(),element()];
  for (const popover of popovers) { popover.summary=element();popover.close=element();popover.querySelector=selector=>selector==='summary'?popover.summary:popover.close;popover.contains=target=>target===popover; }
  const broken=element();broken.complete=true;broken.naturalWidth=0;
  const laterFailure=element();laterFailure.complete=false;laterFailure.naturalWidth=0;
  const document={getElementById:id=>nodes[id],documentElement:{},listeners:{},addEventListener(event,fn){this.listeners[event]=fn;},querySelector:()=>element(),querySelectorAll(selector){return selector==='[data-popover]'?popovers:selector==='[data-brand-logo]'?[broken,laterFailure]:[];}};
  vm.runInNewContext(script,{document,Intl});
  rows[0].open=true;rows[1].open=true;rows[1].listeners.toggle();
  assert.equal(rows[0].open,false);assert.equal(rows[1].open,true);
  popovers[0].open=true;popovers[1].open=true;popovers[1].listeners.toggle();
  assert.equal(popovers[0].open,false);assert.equal(popovers[1].open,true);
  document.listeners.keydown({key:'Escape'});
  assert.equal(popovers[1].open,false);assert.equal(popovers[1].summary.focused,true);
  popovers[0].open=true;popovers[0].close.listeners.click();
  assert.equal(popovers[0].open,false);assert.equal(popovers[0].summary.focused,true);
  popovers[0].open=true;document.listeners.click({target:{}});
  assert.equal(popovers[0].open,false);
  assert.equal(broken.hidden,true);assert.equal(laterFailure.hidden,false);
  laterFailure.listeners.error();assert.equal(laterFailure.hidden,true);
});

test('long lists and empty states share one keyboard-accessible list region; extra currencies remain explicit', () => {
  const snapshot = build(Array.from({length:81},(_,index)=>receipt('row-'+index,{serviceKey:'fictional-'+index,service:'Fictional '+index})));
  snapshot.totals.paidMinorByCurrency={USD:2000,EUR:1000,JPY:3000};
  const html = view.renderHTML(snapshot);
  assert.equal([...html.matchAll(/id="view-scroll"/g)].length,1);
  assert.equal([...html.matchAll(/<details class="subscription"/g)].length,81);
  assert.match(html,/<div id="view-scroll" role="region" tabindex="0"/);
  assert.ok(html.indexOf('id="view-no-match"')>html.indexOf('id="view-scroll"'));
  assert.match(html,/3 currency totals/);
  assert.match(html,/3 種幣別分開合計/);
  assert.match(html,/USD\s*20\.00/);
  assert.match(html,/EUR\s*10\.00/);
  assert.match(html,/JPY\s*3,000/);
  // Browser geometry is verified separately; these assertions cover only the DOM contract.
});


test('likely-canceled rows keep traceable dates, receipt totals and bilingual uncertainty without exporting source identifiers',()=>{
  const initial={...receipt('fictional-inference'),kind:'subscription_confirmed',receivedAt:'2026-04-01T00:00:00Z',nextBilling:'2026-05-01',payment:undefined};
  const snapshot=build([initial,receipt('fictional-paid',{receivedAt:'2026-04-01T00:00:00Z',paymentDay:'2026-04-01',cadence:'monthly'})]);
  const row=snapshot.rows[0];assert.equal(row.status,'likely_canceled');assert.equal(row.nextAction,'verify_inactive');
  assert.equal(row.inactivityInference.expectedPaymentDay,'2026-05-01');assert.equal(row.inactivityInference.thresholdDay,'2026-06-30');
  assert.equal(row.inactivityInference.confirmed,false);assert.equal(row.inactivityInference.sourceEvidenceId,undefined);
  assert.deepEqual(snapshot.totals.paidMinorByCurrency,{USD:14400});
  for(const language of ['en','zh']) {
    const html=view.renderHTML(snapshot,{language});
    assert.match(html,/Likely inactive/);assert.match(html,/可能已停用/);assert.match(html,/not confirmed cancellation/);assert.match(html,/並非確認取消/);
    assert.match(html,/Email coverage may be incomplete/);assert.match(html,/2026-06-30/);assert.match(html,/value="likely_canceled"/);
    assert.match(html,/fictional-inference/);assert.match(html,/Last expected payment/);assert.match(html,/推測評估時間/);
  }
});

test('status assessments expose controlled bilingual evidence strength and source links, never raw account details',()=>{
  const fields={serviceKey:'fictional',service:'Fictional Music',category:'Software',authenticated:true};
  const events=[{...fields,id:'warning',messageId:'fictional-warning',kind:'access_expiring',receivedAt:'2026-05-01T00:00:00Z',accessEnds:'2026-05-04'},
    {...fields,id:'issue',messageId:'fictional-issue',kind:'payment_failed',receivedAt:'2026-05-03T00:00:00Z'}];
  const snapshot=build(events),row=snapshot.rows[0];
  assert.equal(row.statusAssessment.confidence,'moderate');assert.deepEqual(row.statusAssessment.signals.map(s=>s.messageIds),[['fictional-warning'],['fictional-issue']]);
  assert.ok(!JSON.stringify(row.statusAssessment).includes('evidenceIds'));
  for(const language of ['en','zh']){
    const html=view.renderHTML(snapshot,{language});assert.match(html,/Evidence strength/);assert.match(html,/證據強度/);assert.match(html,/not a probability/);assert.match(html,/不是機率/);assert.match(html,/fictional-warning/);
  }
});
