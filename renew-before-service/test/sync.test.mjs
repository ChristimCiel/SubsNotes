import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync } from '../src/sync.mjs';
import { createGmailClient, decodeGmailMessage, GmailError, billingQuery, isBillingCandidate } from '../src/gmail.mjs';

const now = () => '2026-11-02T10:00:00.000Z';
const raw = (id = 'a') => ({ id, internalDate: String(Date.parse('2026-10-05T00:00:00Z')), payload: { mimeType: 'text/plain', headers: [
  { name: 'From', value: 'billing@anthropic.com' }, { name: 'Subject', value: 'Your receipt from Anthropic' },
  { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=anthropic.com' }
], body: { data: Buffer.from('Oct 4–Nov 4, 2026 Claude Pro Amount paid USD 20').toString('base64url') } } });
function repository(initialState = null) {
  let state = initialState, locked = false, lease;
  const events = new Map(), failures = [];
  return {
    events, failures,
    acquire: async (_, key) => { if (locked) return false; locked = true; lease = key; return true; },
    getState: async () => structuredClone(state),
    commit: async (_, key, rows, next) => { assert.equal(key, lease); rows.forEach(e => events.set(e.id, e)); state = structuredClone(next); },
    recordFailure: async (_, key, error) => { assert.equal(key, lease); failures.push(error); },
    release: async (_, key) => { assert.equal(key, lease); locked = false; },
    state: () => state
  };
}
const gmail = overrides => ({ profile: async () => ({ emailAddress: 'owner@example.com', historyId: '100' }), list: async () => ({ messages: [{ id: 'a' }] }), message: async id => raw(id), history: async () => ({ historyId: '101' }), metadata: async () => ({ payload: raw().payload }), ...overrides });

test('paginated backfill persists a cursor and captures a pre-scan history anchor', async () => {
  const repo = repository();
  const client = gmail({ list: async ({ pageToken }) => pageToken ? { messages: [{ id: 'b' }] } : { messages: [{ id: 'a' }], nextPageToken: 'page2' } });
  await runSync({ gmail: client, repository: repo, ownerId: 'u1', now, maxPages: 1 });
  assert.equal(repo.state().phase, 'backfill'); assert.equal(repo.state().pageToken, 'page2');
  assert.equal(repo.state().coverageComplete, false); assert.equal(repo.events.size, 1);
  await runSync({ gmail: client, repository: repo, ownerId: 'u1', now });
  assert.equal(repo.state().phase, 'incremental'); assert.equal(repo.state().historyId, '100'); assert.equal(repo.events.size, 2);
  await runSync({ gmail: client, repository: repo, ownerId: 'u1', now });
  assert.equal(repo.state().historyId, '101'); assert.equal(repo.state().lastSuccessAt, now());
});

test('failed page does not advance its cursor, replay cannot duplicate a receipt', async () => {
  const repo = repository(); let fails = true;
  const client = gmail({ list: async () => ({ messages: [{ id: 'a' }, { id: 'b' }] }), message: async id => { if (id === 'b' && fails) throw new GmailError(503, 'Temporarily unavailable'); return raw(id); } });
  await assert.rejects(runSync({ gmail: client, repository: repo, ownerId: 'u1', now }));
  assert.equal(repo.state().pageToken, null); assert.equal(repo.events.size, 0); assert.equal(repo.failures.length, 1);
  fails = false;
  await runSync({ gmail: client, repository: repo, ownerId: 'u1', now });
  assert.equal(repo.events.size, 2);
});

test('history pages do not advance the history anchor until all pages finish', async () => {
  const repo = repository({ email: 'owner@example.com', phase: 'incremental', historyId: '100', since: '2024-11-02', query: billingQuery('2024-11-02'), processedMessages: 0, retainedEvents: 0, coverageComplete: true });
  const client = gmail({ history: async ({ historyId, pageToken }) => { assert.equal(historyId, '100'); return pageToken ? { historyId: '200' } : { historyId: '199', nextPageToken: 'next', history: [{ messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'a' } }] }] }; } });
  await runSync({ gmail: client, repository: repo, ownerId: 'u1', now, maxPages: 1 });
  assert.equal(repo.state().historyId, '100'); assert.equal(repo.events.size, 1);
  await runSync({ gmail: client, repository: repo, ownerId: 'u1', now });
  assert.equal(repo.state().historyId, '200');
});

test('expired history triggers a recoverable backfill without discarding saved evidence', async () => {
  const repo = repository({ email: 'owner@example.com', phase: 'incremental', historyId: 'old', since: '2024-11-02', query: billingQuery('2024-11-02'), processedMessages: 0, retainedEvents: 0 });
  const client = gmail({ history: async () => { throw new GmailError(404, 'History expired'); } });
  await runSync({ gmail: client, repository: repo, ownerId: 'u1', now });
  assert.equal(repo.state().historyId, '100'); assert.equal(repo.state().phase, 'incremental'); assert.equal(repo.events.size, 1);
});

test('revoked authorization is actionable and does not erase data', async () => {
  const repo = repository();
  await assert.rejects(runSync({ gmail: gmail({ profile: async () => { throw new GmailError(401, 'Reconnect Gmail'); } }), repository: repo, ownerId: 'u1', now }));
  assert.equal(repo.failures[0].reconnectRequired, true); assert.equal(repo.events.size, 0);
});

test('concurrent runs are excluded by a per-owner lease', async () => {
  const repo = repository(); await repo.acquire('u1', 'another');
  assert.deepEqual(await runSync({ gmail: gmail(), repository: repo, ownerId: 'u1', now }), { status: 'already_running' });
});

test('non-billing incremental mail is not downloaded or retained', async () => {
  const repo = repository({ email: 'owner@example.com', phase: 'incremental', historyId: '100', processedMessages: 0, retainedEvents: 0 });
  let downloads = 0;
  const client = gmail({ history: async () => ({ historyId: '101', history: [{ messagesAdded: [{ message: { id: 'personal' } }] }] }), metadata: async () => ({ payload: { headers: [{ name: 'Subject', value: 'Dinner this weekend?' }] } }), message: async () => { downloads++; return raw(); } });
  await runSync({ gmail: client, repository: repo, ownerId: 'u1', now });
  assert.equal(downloads, 0); assert.equal(repo.events.size, 0); assert.equal(repo.state().historyId, '101');
});

test('MIME decoding supports HTML, Gmail authentication, UTF8 and correct mailbox source', () => {
  const m = raw(); m.payload.mimeType = 'multipart/alternative';
  m.payload.parts = [{ mimeType: 'text/html', body: { data: Buffer.from('<p>訂閱 $20</p>').toString('base64url') } }]; delete m.payload.body;
  const normalized = decodeGmailMessage(m, 'owner@example.com');
  assert.equal(normalized.text, '訂閱 $20'); assert.equal(normalized.authenticatedSenderDomain, 'anthropic.com');
  assert.equal(normalized.mailboxEmail, 'owner@example.com');
  m.payload.headers[2].value = 'untrusted.example; dmarc=pass header.from=anthropic.com';
  assert.equal(decodeGmailMessage(m).authenticatedSenderDomain, null);
});

test('Gmail client retries temporary errors and never exposes provider error bodies', async () => {
  let calls = 0;
  const client = createGmailClient({ accessToken: 'fixture-secret', sleep: async () => {}, fetchImpl: async () => { calls++; return calls < 3 ? new Response('sensitive provider error', { status: 429 }) : Response.json({ historyId: '1' }); } });
  assert.equal((await client.profile()).historyId, '1'); assert.equal(calls, 3);
  const invalid = createGmailClient({ accessToken: 'fixture-secret', fetchImpl: async () => new Response('PRIVATE', { status: 401 }) });
  await assert.rejects(invalid.profile(), error => error.status === 401 && !error.message.includes('PRIVATE'));
});

test('refund and cancellation subjects are covered by backfill and incremental filters', () => {
  assert.ok(billingQuery('2024-11-02').includes('subject:refund'));
  assert.equal(isBillingCandidate([{ name: 'Subject', value: 'Your refund from Cursor' }]), true);
  assert.equal(isBillingCandidate([{ name: 'Subject', value: '退款已核准' }]), true);
  assert.equal(isBillingCandidate([{ name: 'Subject', value: 'Your payment failed' }]), true);
  assert.equal(isBillingCandidate([{ name: 'From', value: 'notifications@github.com' }, { name: 'Subject', value: 'Your GitHub payment receipt' }]), true);
});
