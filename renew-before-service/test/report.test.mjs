import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/report.mjs';
import { createReportServer } from '../src/server.mjs';
import { projectEvidence } from '../src/evidence.mjs';
import { get } from 'node:http';
import vm from 'node:vm';

function mountReport(html) {
  const elements=new Map();
  class Element {
    constructor(id=''){this.id=id;this.value='';this.textContent='';this.innerHTML='';this.children=[];this.listeners={};this.className='';}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=children;}
    setAttribute(){}
    addEventListener(type,handler){this.listeners[type]=handler;}
    focus(){}
    showModal(){this.open=true;}
  }
  for(const [,id] of html.matchAll(/id="([^"]+)"/g))elements.set(id,new Element(id));
  elements.get('report-data').textContent=html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const document={getElementById:id=>elements.get(id),createElement:()=>new Element(),documentElement:{},addEventListener(){}};
  let networkCalls=0;
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{
    document,URL,window:{addEventListener(){}},localStorage:{getItem(){return null;},setItem(){}},fetch(){networkCalls++;throw new Error('No network is required for an identity conversion');}
  });
  const descendants=element=>[element,...element.children.flatMap(descendants)];
  return {elements,fx:className=>descendants(elements.get('fx-summary')).find(element=>element.className===className),get networkCalls(){return networkCalls;}};
}

test('private report serializes hostile email text without executable markup', () => {
  const snapshot = projectEvidence([], { asOf: '2026-11-02T10:00:00Z', coverage: { messageCount: 0 } });
  const html = renderReport(snapshot, [{ subject: '</script><script>alert("fixture")</script>', evidence: 'A & B' }]);
  assert.ok(!html.includes('</script><script>alert("fixture")'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
  assert.match(html, /Background updates are not enabled/);
});

test('report FX and payment rows use the same dated cashflow while undated annual evidence stays reviewable',()=>{
  const receipt=(id,name,extra={})=>({id,messageId:'synthetic-'+id,serviceKey:id,service:name,category:'Software',kind:'payment_succeeded',authenticated:true,receivedAt:'2026-07-01T00:00:00Z',payment:{currency:'USD',minor:2000},paymentDay:'2026-07-01',paymentDateBasis:'explicit',...extra});
  const events=[receipt('dated','Dated plan'),receipt('undated','Undated annual',{payment:{currency:'USD',minor:14400},paymentDay:null,paymentDateBasis:'unknown',cadence:'annual'}),
    receipt('unknown-currency','Unknown currency',{payment:{currency:null,minor:12345}}),
    receipt('giving','Giving plan',{category:'Donations',payment:{currency:'USD',minor:1000}}),
    receipt('one-off-invoice','One-off invoice',{kind:'invoice_recorded',category:'One-time purchases',payment:null,paymentDay:null,paymentDateBasis:'unknown',invoiceAmount:{currency:'EUR',minor:1200},invoiceDay:'2026-07-01'})];
  const snapshot=projectEvidence(events,{asOf:'2026-07-02T00:00:00Z',coverage:{messageCount:2}});
  assert.deepEqual(snapshot.recordedPaidMinorByCurrency,{USD:16400});
  const html=renderReport(snapshot,events),serialized=JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(serialized.cashflow.paidMinorByCurrency,{USD:2000});
  assert.deepEqual(serialized.cashflow.includedPaymentIds,['dated']);
  assert.equal(serialized.cashflow.excluded[0].reason,'payment_date_unknown');
  const app=mountReport(html);
  assert.match(app.fx('fx-total').textContent,/USD.*20\.00/);
  assert.equal(app.fx('fx-total-label').textContent,'Estimated subtotal');
  assert.match(app.fx('fx-status').textContent,/date, amount, currency or source verification/);
  app.elements.get('tabs').listeners.click({target:{closest:()=>({dataset:{view:'payments'}})}});
  assert.match(app.elements.get('list').innerHTML,/Dated plan/);
  assert.ok(!app.elements.get('list').innerHTML.includes('Undated annual'));
  app.elements.get('tabs').listeners.click({target:{closest:()=>({dataset:{view:'other'}})}});
  assert.match(app.elements.get('list').innerHTML,/Undated annual/);
  assert.match(app.elements.get('list').innerHTML,/Payment needs verification/);
  assert.match(app.elements.get('list').innerHTML,/Excluded from spending/);
  assert.match(app.elements.get('list').innerHTML,/Giving plan/);
  assert.match(app.elements.get('list').innerHTML,/Invoice amount · payment unverified/);
  assert.match(app.elements.get('list').innerHTML,/Invoice issue date/);
  assert.match(app.elements.get('list').innerHTML,/currency unconfirmed/);
  assert.ok(!app.elements.get('list').innerHTML.includes('$123.45'));
  app.elements.get('language').listeners.click();
  assert.match(app.fx('fx-status').textContent,/日期、金額、幣別或來源/);
  assert.match(app.elements.get('list').innerHTML,/付款仍待確認/);
  assert.match(app.elements.get('list').innerHTML,/幣別待確認/);
  assert.match(app.elements.get('list').innerHTML,/發票金額・付款尚未確認/);
  assert.equal(app.networkCalls,0);
});

test('report transaction proof retains every source used to enrich a deduplicated payment',()=>{
  const base={serviceKey:'synthetic-proof-service',service:'Proof plan',category:'Software',kind:'payment_succeeded',authenticated:true,reference:'synthetic-same-invoice'};
  const events=[{...base,id:'date-proof',messageId:'synthetic-date-source',receivedAt:'2026-07-01T00:00:00Z',payment:{currency:null,minor:2000},paymentDay:'2026-07-01',paymentDateBasis:'explicit',evidence:'Original date proof: Paid July 1, 2026.'},
    {...base,id:'currency-proof',messageId:'synthetic-currency-source',receivedAt:'2026-07-02T00:00:00Z',payment:{currency:'USD',minor:2000},paymentDay:null,paymentDateBasis:'unknown',evidence:'Original currency proof: amount USD20.00.'}];
  const snapshot=projectEvidence(events,{asOf:'2026-07-03T00:00:00Z',coverage:{messageCount:2}});
  assert.equal(snapshot.payments.length,1);assert.equal(snapshot.payments[0].id,'date-proof');
  const app=mountReport(renderReport(snapshot,events));
  app.elements.get('list').listeners.click({target:{closest:()=>({dataset:{proof:'date-proof'}})}});
  assert.match(app.elements.get('detail-content').innerHTML,/Original date proof/);
  assert.match(app.elements.get('detail-content').innerHTML,/Original currency proof/);
  assert.equal(app.elements.get('detail').open,true);
});

test('private preview is read-only, uncached, frame-isolated and rejects unknown hosts', async () => {
  const server = createReportServer({ html: '<html><script>void 0;</script></html>' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(url);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /sha256-/);
    assert.match(response.headers.get('content-security-policy'), /connect-src https:\/\/api.frankfurter.dev https:\/\/cdn.jsdelivr.net https:\/\/latest.currency-api.pages.dev/);
    assert.ok(!response.headers.get('content-security-policy').includes('connect-src *'));
    assert.equal((await fetch(url + '/messages-0.json')).status, 404);
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
    const rejectedStatus = await new Promise((resolve, reject) => { const req = get(url, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); });
    assert.equal(rejectedStatus, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('reloading the preview reads the latest saved report and its matching CSP', async () => {
  let html = '<html><script>void 1;</script>First</html>';
  const server = createReportServer({ readHtml: async () => html });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const first = await fetch(url); const firstCsp = first.headers.get('content-security-policy');
    assert.match(await first.text(), /First/);
    html = '<html><script>void 2;</script>Updated</html>';
    const next = await fetch(url);
    assert.match(await next.text(), /Updated/);
    assert.notEqual(next.headers.get('content-security-policy'), firstCsp);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
