import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createEvidenceRuntime } from '../src/evidence-runtime.mjs';
import { createCashflowRuntime } from '../src/cashflow.mjs';
import { createFxRuntime } from '../src/fx.mjs';
import { createSubscriptionViewRuntime } from '../src/subscription-view.mjs';

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
  const a = element(), b = element(); a.dataset={name:'beta',state:'renewal_off',next:'2026-10-03',source:'2026-09-01'}; b.dataset={name:'alpha',state:'active',next:'2026-10-01',source:'2026-09-02'};
  const nodes = Object.fromEntries(['view-list','view-search','view-state','view-sort','view-language','view-count','view-no-match'].map(id=>[id,element()]));
  nodes['view-list'].children=[a,b]; nodes['view-list'].append = row => { nodes['view-list'].children=nodes['view-list'].children.filter(item=>item!==row); nodes['view-list'].children.push(row); };
  nodes['view-sort'].value='name';
  const timestamp = element(), calendarDay = element();
  timestamp.dataset.date='2026-02-01T18:38:00Z'; calendarDay.dataset.date='2026-02-01';
  const document = { getElementById:id=>nodes[id], documentElement:{}, querySelectorAll:selector=>selector==='time[data-date]'?[timestamp,calendarDay]:[], querySelector:()=>element() };
  const viewerIntl = { DateTimeFormat: function(locale,options){return new Intl.DateTimeFormat(locale,{timeZone:'Asia/Taipei',...options});} };
  vm.runInNewContext(script,{document,Intl:viewerIntl});
  assert.equal(nodes['view-language'].disabled,false);
  assert.match(timestamp.textContent,/Feb 2, 2026/);
  assert.match(timestamp.textContent,/GMT\+8/);
  assert.equal(calendarDay.textContent,'Feb 1, 2026');
  assert.deepEqual(nodes['view-list'].children,[b,a]);
  nodes['view-search'].value='beta'; nodes['view-search'].listeners.input();
  assert.equal(b.hidden,true); assert.equal(a.hidden,false); assert.equal(nodes['view-count'].textContent,'1 services');
  nodes['view-state'].value='active'; nodes['view-state'].listeners.change();
  assert.equal(nodes['view-no-match'].hidden,false);
  nodes['view-search'].value=''; nodes['view-state'].value=''; nodes['view-sort'].value='newest'; nodes['view-sort'].listeners.change();
  assert.deepEqual(nodes['view-list'].children,[b,a]);
  nodes['view-language'].listeners.click();
  assert.equal(document.documentElement.lang,'zh-Hant');
  assert.equal(nodes['view-count'].textContent,'2 項服務');
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
