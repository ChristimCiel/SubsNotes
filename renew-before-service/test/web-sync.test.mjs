import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebSync } from '../src/web-sync.mjs';
import { createClaudeGmailClient } from '../src/claude-gmail.mjs';
import { extractWebEvidence } from '../src/web-evidence.mjs';
import { digest, projectEvidence } from '../src/evidence.mjs';
import { prepareAssistantSync } from '../src/assistant-sync.mjs';
import { createClaudePersonalStore } from '../src/claude-store.mjs';
import { createFxRuntime } from '../src/fx.mjs';

const time = '2026-08-15T00:00:00Z';
function setup() {
  let saved = null;
  const calls = [], pages = { first: { ids: ['paid'], nextPageToken: 'page2' }, page2: { ids: ['cancel'], nextPageToken: null } };
  const messages = {
    paid: { id: 'paid', sender: 'billing@suno.com', subject: 'Subscription receipt', text: 'Suno Pro. Paid Aug 2, 2026. Aug 2–Sep 2, 2026 Amount paid EUR 24.00' },
    cancel: { id: 'cancel', sender: 'billing@suno.com', subject: 'Your subscription was canceled', text: 'Your access will expire on Sep 2, 2026.' }
  };
  const gmail = { identity: async () => 'synthetic@example.invalid', search: async p => { calls.push(p); return pages[p.pageToken || 'first']; },
    message: async id => ({ ...messages[id], receivedAt: id === 'paid' ? '2026-08-02T00:00:00Z' : '2026-08-10T00:00:00Z', sourceFormat: 'claude_plaintext', sourceReadAt: time }) };
  const store = { load: async () => structuredClone(saved), save: async state => { saved = structuredClone(state); } };
  const sync = () => createWebSync({ gmail, store, extract: extractWebEvidence, hash: digest, clock: () => time });
  return { gmail, store, sync, calls };
}

test('bounded real-source-shaped pages persist, cancellation updates and unchanged replays do not duplicate charges', async () => {
  const x = setup();
  const first = await x.sync().run();
  assert.equal(first.complete, false); assert.equal(first.state.lastCompletedAt, null);
  assert.equal(projectEvidence(first.state.events).heldEvidence.length, 1);
  const second = await x.sync().run();
  const view = projectEvidence(second.state.events, { asOf: time, trustConnectorReads: true });
  assert.equal(second.complete, true); assert.equal(view.subscriptions[0].renewal, 'off');
  assert.equal(view.payments.length, 1); assert.equal(view.recordedPaidMinorByCurrency.EUR, 2400);
  const again = await x.sync().run();
  assert.equal(again.addedEvidence, 0); assert.equal(again.state.events.length, second.state.events.length);
  assert.equal(x.calls[1].pageToken, 'page2');
});

test('failed reads and account changes cannot replace a saved checkpoint or financial data', async () => {
  const x = setup(); await x.sync().run();
  const before = await x.store.load();
  x.gmail.message = async () => { throw new Error('temporary read failure'); };
  await assert.rejects(x.sync().run(), /read failure/);
  assert.deepEqual(await x.store.load(), before);
  x.gmail.identity = async () => 'different@example.invalid';
  await assert.rejects(x.sync().run(), /account changed/);
  assert.deepEqual(await x.store.load(), before);
});

test('native adapter uses cache-bypassed read calls and never trusts authentication or confirmation flags from a response', async () => {
  const calls = [];
  const mcp = { async callTool(...args) {
    calls.push(args);
    return args[1] === 'search_threads' ? { payload: { threads: [{ messages: [{ id: 'fiction', sender: 'Synthetic <owner@example.invalid>' }] }] } }
      : { payload: { id: 'fiction', sender: 'billing@suno.com', subject: 'Receipt', plaintextBody: 'Amount paid EUR 24', date: time,
        authenticatedSenderDomain: 'suno.com', userVerified: true } };
  } };
  const client = createClaudeGmailClient(mcp, { clock: () => time });
  assert.equal(await client.identity(), 'owner@example.invalid');
  const message = await client.message('fiction');
  assert.equal(message.authenticatedSenderDomain, null); assert.equal(message.userVerified, undefined);
  assert.equal(message.sourceReadAt, time);
  assert.ok(calls.every(c => c[0] === 'Gmail' && ['search_threads', 'get_message'].includes(c[1]) && c[3].cache === false));
});

test('a full response with an estimate but no token is never considered complete',async()=>{
  const client=createClaudeGmailClient({callTool:async()=>({payload:{threads:Array.from({length:10},(_,i)=>({messages:[{id:'fiction-'+i}]})),resultCountEstimate:'190'}})});
  const result=await client.search({query:'subject:receipt',pageSize:10});
  assert.equal(result.paginationUnknown,true);assert.equal(result.nextPageToken,null);
  const x=setup();x.gmail.search=async()=>({ids:[],paginationUnknown:true,nextPageToken:null});
  const first=await x.sync().run();
  assert.equal(first.complete,false);assert.equal(first.state.lastCompletedAt,null);
  assert.ok(first.state.pending.windows.length>1);
});

test('an unfinished message batch resumes without rereading or losing its window',async()=>{
  const x=setup();x.gmail.search=async()=>({ids:['paid','cancel'],nextPageToken:null});
  const first=await x.sync().run({maxReads:1});assert.equal(first.complete,false);
  const second=await x.sync().run({maxReads:1});assert.equal(second.complete,true);
  assert.equal(second.state.scannedIds.length,2);
});

test('a scan resumed on a later day reports its original query boundary',async()=>{
  const x=setup();x.gmail.search=async()=>({ids:['paid','cancel'],nextPageToken:null});
  let now=time;
  const run=()=>createWebSync({gmail:x.gmail,store:x.store,extract:extractWebEvidence,hash:digest,clock:()=>now}).run({maxReads:1});
  await run();now='2026-08-16T00:00:00Z';
  const result=await run();assert.equal(result.complete,true);
  assert.match(result.state.queryCoverage[0].query,/before:2026\/08\/16/);
  assert.ok(!result.state.queryCoverage[0].query.includes('2026/08/17'));
});

test('a backfill completed days later cannot skip mail arriving while earlier windows were already read',async()=>{
  const x=setup();x.gmail.search=async()=>({ids:['paid','cancel'],nextPageToken:null});
  let now=time;
  const run=()=>createWebSync({gmail:x.gmail,store:x.store,extract:extractWebEvidence,hash:digest,clock:()=>now}).run({maxReads:1});
  await run();now='2026-08-25T00:00:00Z';
  const finished=await run();
  assert.equal(finished.complete,true);
  assert.equal(finished.state.lastCompletedAt,now);
  assert.equal(finished.state.syncAnchorAt,time);
  const searches=[];x.gmail.search=async args=>{searches.push(args.query);return {ids:[],nextPageToken:null};};
  now='2026-08-26T00:00:00Z';await run();
  assert.match(searches[0],/after:2026\/08\/13/);
  assert.match(searches[0],/before:2026\/08\/27/);
});

test('retrieved-but-unrecognized sources stay unresolved, stop retrying, and recover after a parser upgrade', async () => {
  const x = setup();
  x.gmail.search = async () => ({ ids: ['paid'], nextPageToken: null });
  let now = time, reads = 0;
  const read = x.gmail.message;
  x.gmail.message = async id => { reads++; return read(id); };
  const run = (parserVersion = 'old', extract = async () => []) => createWebSync({
    gmail: x.gmail, store: x.store, extract, hash: digest, clock: () => now, parserVersion
  }).run();
  const first = await run();
  assert.equal(first.complete, true, 'query coverage and extraction completeness are separate');
  assert.equal(first.state.processingSummary.read, 1);
  assert.equal(first.state.processingSummary.extracted, 0);
  assert.equal(first.reviewCount, 1);
  assert.equal(first.state.sourceProcessing.paid[5], 'unrecognized_format');
  assert.equal(first.state.queryCoverage.length, 1);
  assert.equal((await run()).readCount, 0, 'backoff prevents immediate reread loops');
  now = '2026-08-16T00:00:00Z';
  assert.equal((await run()).readCount, 1);
  now = '2026-08-17T00:00:00Z';
  assert.equal((await run()).readCount, 0, 'second backoff is longer');
  now = '2026-08-19T00:00:00Z';
  const exhausted = await run();
  assert.equal(exhausted.state.sourceProcessing.paid[2], 3);
  assert.equal(exhausted.state.processingSummary.retryExhausted, 1);
  now = '2026-09-19T00:00:00Z';
  assert.equal((await run()).readCount, 0, 'retry cap survives later sessions');
  assert.equal(reads, 3);
  const upgraded = await run('new', extractWebEvidence);
  assert.equal(upgraded.reprocessedCount, 1);
  assert.equal(upgraded.state.sourceProcessing.paid[2], 1);
  assert.equal(upgraded.state.processingSummary.extracted, 1);
  assert.equal(upgraded.reviewCount, 0);
  assert.equal(projectEvidence(upgraded.state.events, { trustConnectorReads: true }).recordedPaidMinorByCurrency.EUR, 2400);
  assert.equal((await run('new', extractWebEvidence)).readCount, 0);
});

test('legacy scanned IDs are reprocessed in bounded batches without resetting completed query coverage', async () => {
  const x = setup();
  await x.store.save({ version: 1, events: [], scannedIds: ['paid', 'cancel'], prefs: {}, lastCompletedAt: time, syncVersion: 2 });
  x.gmail.search = async () => ({ ids: [], nextPageToken: null });
  const first = await x.sync().run({ maxReads: 1 });
  assert.equal(first.complete, true);
  assert.equal(first.readCount, 1);
  assert.equal(first.state.processingSummary.reprocessPending, 1);
  assert.equal(first.extractionPending, 1);
  const second = await x.sync().run({ maxReads: 1 });
  assert.equal(second.complete, true);
  assert.equal(second.state.processingSummary.reprocessPending, 0);
  assert.equal(second.state.events.length, 2);
  assert.equal(second.state.scannedIds.length, 2);
});

test('a failed legacy reread is bounded and preserves established financial evidence', async () => {
  const x = setup(); await x.sync().run();
  const before = await x.store.load();
  x.gmail.search = async () => ({ ids: [], nextPageToken: null });
  x.gmail.message = async () => { throw new Error('source unavailable'); };
  const result = await createWebSync({ gmail: x.gmail, store: x.store, extract: extractWebEvidence, hash: digest, clock: () => time, parserVersion: 'next' }).run();
  assert.equal(result.readCount, 0);
  assert.equal(result.attemptedReadCount, 1);
  assert.equal(result.reviewCount, 1);
  assert.equal(result.state.sourceProcessing.paid[5], 'read_failed');
  assert.deepEqual(result.state.events, before.events);
});

test('body and financial gaps remain explicit instead of calling every retrieved source extracted', async () => {
  for (const [overrides, reason] of [
    [{ text: '', attachmentCount: 1 }, 'empty_body'],
    [{ truncated: true }, 'truncated_body'],
    [{ text: 'Suno Pro. Paid Aug 2, 2026. Aug 2–Sep 2, 2026 Amount paid $24.00' }, 'currency_unknown'],
    [{ text: 'Suno Pro subscription. Amount paid EUR 24.00' }, 'payment_date_unknown']
  ]) {
    const x = setup(); x.gmail.search = async () => ({ ids: ['paid'], nextPageToken: null });
    const read = x.gmail.message; x.gmail.message = async id => ({ ...await read(id), ...overrides });
    const result = await x.sync().run();
    assert.equal(result.state.sourceProcessing.paid[5], reason);
    assert.equal(result.state.processingSummary.extracted, 0);
    assert.equal(result.state.processingSummary.needsReview, 1);
  }
});

test('reprocessing preserves receipt-reviewed fields and never doubles a charge under a new event ID', async () => {
  for (const changeId of [false, true]) {
    const x = setup(); await x.sync().run();
    const saved = await x.store.load(), event = saved.events[0];
    event.receiptVerification = { checkedAt: time, fields: ['kind', 'payment', 'paymentDay', 'paymentDateBasis'] };
    await x.store.save(saved);
    x.gmail.search = async () => ({ ids: [], nextPageToken: null });
    const extract = async message => (await extractWebEvidence(message)).map(candidate => ({ ...candidate,
      ...(changeId ? { id: 'new-parser-event-id' } : {}), payment: { minor: 9900, currency: 'USD', source: 'USD 99.00' } }));
    const result = await createWebSync({ gmail: x.gmail, store: x.store, extract, hash: digest, clock: () => time, parserVersion: 'next' }).run();
    const view = projectEvidence(result.state.events, { asOf: time, trustConnectorReads: true });
    assert.equal(result.state.events.length, 1);
    assert.equal(view.payments.length, 1);
    assert.equal(view.recordedPaidMinorByCurrency.EUR, 2400);
    assert.equal(view.recordedPaidMinorByCurrency.USD, undefined);
    assert.equal(result.state.sourceProcessing.paid[5], 'reviewed_source_conflict');
    assert.deepEqual(result.state.events[0].receiptVerification, event.receiptVerification);
  }
});

test('successful retries are idempotent and a legacy manifest-sized history stays compact', async () => {
  const ids = Array.from({ length: 353 }, (_, i) => i.toString(16).padStart(16, '0'));
  let saved = { version: 1, events: [], scannedIds: ids, prefs: {} };
  const gmail = {
    identity: async () => 'synthetic@example.invalid', search: async () => ({ ids: [], nextPageToken: null }),
    message: async id => ({ id, sender: 'billing@suno.com', subject: 'Subscription canceled', text: 'Your subscription was canceled.',
      receivedAt: time, sourceReadAt: time, sourceFormat: 'claude_plaintext' })
  };
  const store = { load: async () => structuredClone(saved), save: async state => { saved = structuredClone(state); } };
  const sync = () => createWebSync({ gmail, store, extract: extractWebEvidence, hash: digest, clock: () => time });
  for (let i = 0; i < 18; i++) {
    const result = await sync().run({ maxReads: 20 });
    assert.ok(result.readCount <= 20);
    assert.equal(result.complete, true);
  }
  assert.equal(saved.processingSummary.extracted, 353);
  assert.equal(saved.processingSummary.reprocessPending, 0);
  assert.equal(saved.events.length, 353);
  const { events, ...metadata } = saved;
  assert.ok(new TextEncoder().encode(JSON.stringify(metadata)).length < 60_000, 'source tracking fits the verified host index bound');
  const replay = await sync().run();
  assert.equal(replay.readCount, 0);
  assert.equal(replay.addedEvidence, 0);
  await assert.rejects(sync().run({ maxReads: 0 }), /maxReads/);
});

test('reviewed-family protection does not suppress explicitly distinct line items or partial refunds', async () => {
  const x = setup();
  const original = { id: 'refund-one', messageId: 'paid', kind: 'refund_recorded', receivedAt: time,
    refund: { minor: 1000, currency: 'EUR' }, refundDay: '2026-08-15', refundRef: 'partial-one',
    receiptVerification: { checkedAt: time, fields: ['kind', 'refund', 'refundDay'] } };
  await x.store.save({ version: 1, events: [original], scannedIds: ['paid'], prefs: {} });
  x.gmail.search = async () => ({ ids: [], nextPageToken: null });
  const incoming = { ...original, id: 'refund-two', refundRef: 'partial-two', refund: { minor: 500, currency: 'EUR' } };
  delete incoming.receiptVerification;
  const result = await createWebSync({ gmail: x.gmail, store: x.store, extract: async () => [incoming], hash: digest, clock: () => time }).run();
  assert.equal(result.state.events.length, 2);
  assert.equal(result.state.sourceProcessing.paid[1], 'extracted');
  assert.equal(result.state.events.find(event => event.id === 'refund-two').refund.minor, 500);
});

test('sync rejects a storage readback that changes financial contents without changing its size', async () => {
  const x = setup(), load = x.store.load;
  let loads = 0;
  x.store.load = async () => {
    const state = await load();
    if (++loads === 2 && state?.events[0]?.payment) state.events[0].payment.minor = 1;
    return state;
  };
  await assert.rejects(x.sync().run(), /Storage did not confirm/);
});

test('a new parser cannot keep counting an older contradictory financial interpretation', async () => {
  for (const changeKind of [false, true]) {
    const x = setup(); await x.sync().run();
    const original = (await x.store.load()).events[0];
    x.gmail.search = async () => ({ ids: [], nextPageToken: null });
    let now = time;
    const extract = async message => (await extractWebEvidence(message)).map(event => changeKind
      ? { ...event, id: 'new-one-time-id', kind: 'one_time_purchase' }
      : { ...event, payment: { ...event.payment, minor: 9900 } });
    const run = () => createWebSync({ gmail: x.gmail, store: x.store, extract, hash: digest, clock: () => now, parserVersion: 'new' }).run();
    const result = await run();
    assert.equal(result.state.events.length, 2, 'old and contradictory interpretations remain available for review');
    assert.ok(result.state.events.every(event => event.sourceProcessingConflict));
    assert.ok(result.state.events.some(event => event.payment.minor === 2400), 'original amount is recoverable');
    assert.equal(result.state.events.find(event => event.id === original.id).payment.minor, 2400, 'existing event identity and its original facts are retained');
    const view = projectEvidence(result.state.events, { asOf: time, trustConnectorReads: true });
    assert.equal(view.payments.length, 0);
    assert.equal(view.subscriptions.length, 0);
    assert.equal(view.heldEvidence.length, 2);
    assert.equal(result.state.sourceProcessing.paid[5], 'source_reclassified');
    now = '2026-08-16T00:00:00Z';
    const retry = await run();
    assert.equal(retry.state.events.length, 2, 'retries cannot add endless conflicting copies');
    assert.ok(retry.state.events.every(event => event.sourceProcessingConflict));
  }
});

test('a zero-event parser reread cannot delete or silently quarantine established amounts', async () => {
  const x = setup(); await x.sync().run();
  const before = await x.store.load();
  x.gmail.search = async () => ({ ids: [], nextPageToken: null });
  const result = await createWebSync({ gmail: x.gmail, store: x.store, extract: async () => [], hash: digest, clock: () => time, parserVersion: 'new' }).run();
  assert.deepEqual(result.state.events, before.events);
  assert.equal(result.state.sourceProcessing.paid[5], 'unrecognized_format');
});

test('missing financial amounts stay unresolved and genuine document review clears the old document-only marker', async () => {
  const x = setup();
  x.gmail.search = async () => ({ ids: ['paid'], nextPageToken: null });
  const first = await createWebSync({ gmail: x.gmail, store: x.store, extract: async message =>
    (await extractWebEvidence(message)).map(event => ({ ...event, payment: null })), hash: digest, clock: () => time }).run();
  assert.equal(first.state.sourceProcessing.paid[5], 'amount_unknown');
  const saved = await x.store.load();
  saved.events[0].payment = { minor: 2400, currency: 'EUR' };
  saved.events[0].sourceRequiresDocumentReview = true;
  saved.events[0].receiptVerification = { checkedAt: time, fields: ['kind', 'payment', 'paymentDay', 'paymentDateBasis'] };
  await x.store.save(saved);
  const result = await createWebSync({ gmail: x.gmail, store: x.store, extract: async message =>
    (await extractWebEvidence(message)).map(event => ({ ...event, sourceRequiresDocumentReview: true })), hash: digest, clock: () => time, parserVersion: 'next' }).run();
  assert.equal(result.state.sourceProcessing.paid[1], 'extracted');
  assert.equal(result.state.sourceProcessing.paid[5], null);
});

test('a known-source host tool suspension cannot become a failed read or save processing attempts', async () => {
  const x = setup(); await x.sync().run();
  const before = await x.store.load();
  x.gmail.search = async () => ({ ids: [], nextPageToken: null });
  const requiredTool = { server: 'Gmail', tool: 'get_message', args: { messageId: 'paid', messageFormat: 'PLAIN_TEXT' } };
  const suspension = Object.assign(new Error('A real connector reply is required'), { requiredTool });
  x.gmail.message = async () => { throw suspension; };
  let saves = 0;
  x.store.save = async () => { saves++; };
  const sync = createWebSync({ gmail: x.gmail, store: x.store, extract: extractWebEvidence, hash: digest, clock: () => time, parserVersion: 'next' });
  await assert.rejects(sync.run(), error => error === suspension);
  assert.equal(saves, 0);
  assert.deepEqual(await x.store.load(), before);
});

test('headless reprocessing of an existing manifest requires an actual message observation before preparing writes', async () => {
  const runtime = { createClaudePersonalStore, createClaudeGmailClient, createWebSync, createFxRuntime, extractWebEvidence, hash: digest };
  const documents = [{ id: 'subsnotes-state-v1', data: {
    version: 1, events: [], scannedIds: ['legacy-receipt'], prefs: {}, mailboxHash: digest('owner@example.invalid'),
    sourceProcessingFormat: 'tuple-v1', sourceProcessing: { 'legacy-receipt': ['old', 'extracted', 1, Date.parse(time), null, null] }
  } }];
  const before = structuredClone(documents), observations = [], runId = 'synthetic-reprocessing';
  const prepare = () => prepareAssistantSync({ documents, observations, runId, asOf: time }, runtime);
  const identity = await prepare();
  observations.push({ runId, ...identity.requiredTool, result: { threads: [{ messages: [{ id: 'sent', sender: 'owner@example.invalid' }] }] } });
  const search = await prepare();
  observations.push({ runId, ...search.requiredTool, result: { threads: [], resultCountEstimate: '0' } });
  const waiting = await prepare();
  assert.equal(waiting.status, 'needs_tool');
  assert.equal(waiting.stored, false);
  assert.deepEqual(waiting.requiredTool, { server: 'Gmail', tool: 'get_message', args: { messageId: 'legacy-receipt', messageFormat: 'PLAIN_TEXT' } });
  assert.equal(waiting.writes, undefined, 'no fictional read failures can be prepared for commit');
  assert.deepEqual(documents, before, 'saved processing attempts remain unchanged');
  observations.push({ runId, ...waiting.requiredTool, result: { id: 'legacy-receipt', sender: 'billing@suno.com', subject: 'Subscription canceled',
    plaintextBody: 'Your subscription was canceled.', date: time } });
  const ready = await prepare();
  assert.equal(ready.status, 'ready_to_commit');
  assert.equal(ready.summary.readCount, 1);
  assert.equal(ready.summary.addedEvidence, 1);
  assert.equal(ready.writes.at(-1).data.sourceProcessing['legacy-receipt'][1], 'extracted');
  assert.deepEqual(documents, before);
});

test('genuine provider read errors still respect backoff and exhaust their bounded retry queue', async () => {
  const x = setup(); await x.sync().run();
  x.gmail.search = async () => ({ ids: [], nextPageToken: null });
  let now = time, calls = 0;
  x.gmail.message = async () => { calls++; throw new Error('Provider temporarily unavailable'); };
  const run = () => createWebSync({ gmail: x.gmail, store: x.store, extract: extractWebEvidence, hash: digest, clock: () => now, parserVersion: 'next' }).run();
  const first = await run();
  assert.equal(first.state.sourceProcessing.paid[5], 'read_failed');
  assert.equal(first.state.sourceProcessing.paid[2], 1);
  await run(); assert.equal(calls, 1);
  now = '2026-08-16T00:00:00Z'; await run();
  now = '2026-08-19T00:00:00Z'; const exhausted = await run();
  assert.equal(calls, 3);
  assert.equal(exhausted.state.sourceProcessing.paid[2], 3);
  assert.equal(exhausted.state.processingSummary.retryExhausted, 1);
  now = '2026-09-19T00:00:00Z'; await run();
  assert.equal(calls, 3);
});
