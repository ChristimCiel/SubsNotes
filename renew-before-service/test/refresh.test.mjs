import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAudit } from '../src/audit.mjs';
import { planRefresh, finishRefresh } from '../src/refresh.mjs';
import { acquireFileLock } from '../src/file-lock.mjs';

const mailboxEmail = 'fixture@example.com';
const at = '2026-11-02T08:00:00.000Z';
async function seed() {
  const dir = await mkdtemp(join(tmpdir(), 'renew-before-refresh-fixture-'));
  await writeFile(join(dir, 'messages-1.json'), JSON.stringify([{ id: 'seed', mailboxEmail, receivedAt: '2026-11-01T00:00:00Z', sender: 'billing@anthropic.com', authenticatedSenderDomain: 'anthropic.com', subject: 'Your Max subscription is confirmed', text: 'The next charge will be on Dec 1, 2026.' }]));
  await writeFile(join(dir, 'scan-state.json'), JSON.stringify({ mailboxEmail, lastCompletedAt: '2026-11-01T01:00:00Z', backgroundUpdatesConfigured: false }));
  await buildAudit(dir, { asOf: at });
  return dir;
}
const result = plan => ({ ...plan, mailboxEmail, completedAt: at, profileVerified: true, allMessageReadsSucceeded: true, queries: [{ query: plan.query, complete: true, nextPageToken: null }], backgroundUpdatesConfigured: false });

test('refresh planning uses a two-day overlap and a single expected account', async () => {
  const dir = await seed(); const plan = await planRefresh(dir, { now: at });
  assert.equal(plan.expectedMailboxEmail, mailboxEmail); assert.match(plan.query, /after:2026\/10\/30/);
  assert.deepEqual(plan.knownMessageIds, ['seed']);
});

test('partial queries, failed reads and wrong accounts cannot advance a refresh checkpoint', async () => {
  const dir = await seed(); const plan = await planRefresh(dir, { now: at });
  await assert.rejects(finishRefresh(dir, { ...result(plan), queries: [{ complete: false }] }, { now: at }), /Incomplete/);
  await assert.rejects(finishRefresh(dir, { ...result(plan), allMessageReadsSucceeded: false }, { now: at }), /Successful source/);
  await assert.rejects(finishRefresh(dir, { ...result(plan), mailboxEmail: 'another@example.com' }, { now: at }), /does not match/);
  await assert.rejects(finishRefresh(dir, { ...result(plan), startedAt: '2026-10-30T00:00:00Z', completedAt: '2026-10-31T00:00:00Z' }, { now: at }), /Invalid scan time/);
  assert.equal(JSON.parse(await readFile(join(dir, 'scan-state.json'))).lastCompletedAt, plan.baselineCompletedAt);
});

test('a completed update becomes visible to the reader and an unchanged repeat is quiet', async () => {
  const dir = await seed(); const plan = await planRefresh(dir, { now: at });
  await writeFile(join(dir, 'messages-2.json'), JSON.stringify([{ id: 'cancel', mailboxEmail, receivedAt: '2026-11-02T07:00:00Z', sender: 'billing@anthropic.com', authenticatedSenderDomain: 'anthropic.com', subject: 'Your Claude Max subscription was canceled', text: 'Your access will expire on Dec 1, 2026.' }]));
  const output = await finishRefresh(dir, result(plan), { now: at });
  assert.equal(output.changed, true); assert.deepEqual(output.changedServiceKeys, ['claude']);
  const snapshot = JSON.parse(await readFile(join(dir, 'snapshot.json')));
  assert.equal(snapshot.subscriptions[0].renewal, 'off'); assert.equal(snapshot.coverage.mailboxCheckedAt, at);
  const again = await planRefresh(dir, { now: at });
  assert.equal((await finishRefresh(dir, result(again), { now: at })).changed, false);
});

test('a stale scan cannot overwrite the cursor from a newer successful run', async () => {
  const dir = await seed(); const plan = await planRefresh(dir, { now: at });
  await finishRefresh(dir, result(plan), { now: at });
  await assert.rejects(finishRefresh(dir, result(plan), { now: at }), /newer scan/);
});

test('a live lock excludes another run, and a dead expired owner can recover', async () => {
  const dir = await seed(); const release = await acquireFileLock(dir);
  await assert.rejects(acquireFileLock(dir), /Another refresh/); await release();
  await mkdir(join(dir, '.refresh-lock'));
  await writeFile(join(dir, '.refresh-lock','lease.json'), JSON.stringify({ pid: 99999999, at: Date.parse('2020-01-01'), token: 'old-fixture' }));
  const recovered = await acquireFileLock(dir); await recovered();
});
