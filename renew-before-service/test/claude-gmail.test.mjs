import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeGmailClient } from '../src/claude-gmail.mjs';
import { extractWebEvidence } from '../src/web-evidence.mjs';

const time = '2026-08-15T00:00:00Z';
const base = { id: 'fiction', sender: 'billing@suno.com', subject: 'Subscription receipt', date: time };
function clientFor(value) {
  const calls = [];
  const client = createClaudeGmailClient({ callTool: async (...args) => { calls.push(args); return { payload: value }; } }, { clock: () => time });
  return { client, calls };
}

test('HTML fallback consumes only returned fields and keeps the proven plain-text request', async () => {
  for (const field of ['htmlBody', 'html']) {
    const { client, calls } = clientFor({ ...base, plaintextBody: '',
      [field]: '<style>.x{display:none}</style><p>Suno Pro</p><p>Paid Aug 2, 2026</p><p>Aug 2–Sep 2, 2026</p><p>Amount paid EUR 24.00</p><script>ignored()</script>',
      attachments: [{ name: 'receipt.pdf', content: 'This is metadata, not verified PDF content' }] });
    const message = await client.message('fiction');
    assert.equal(calls[0][2].messageFormat, 'PLAIN_TEXT');
    assert.equal(calls[0][3].cache, false);
    assert.equal(message.bodyFormat, 'html');
    assert.equal(message.sourceFormat, 'claude_plaintext');
    assert.equal(message.attachmentCount, 1);
    assert.equal(message.attachmentContentRead, false);
    assert.ok(!message.text.includes('ignored') && !message.text.includes('metadata'));
    const events = await extractWebEvidence(message);
    assert.equal(events[0].payment.minor, 2400);
    assert.equal(events[0].payment.currency, 'EUR');
  }
});

test('nonempty plain text wins over HTML; empty bodies remain explicit empty reads', async () => {
  const plain = clientFor({ ...base, plaintextBody: 'Amount paid EUR 24', htmlBody: '<p>Amount paid USD 99</p>' });
  const message = await plain.client.message('fiction');
  assert.equal(message.text, 'Amount paid EUR 24');
  assert.equal(message.bodyFormat, 'plain_text');
  const empty = await clientFor({ ...base, plaintextBody: '', attachments: [{ name: 'invoice.pdf' }] }).client.message('fiction');
  assert.equal(empty.text, '');
  assert.equal(empty.attachmentCount, 1);
  await assert.rejects(clientFor({ ...base, attachments: [{ name: 'invoice.pdf' }] }).client.message('fiction'), /body is unavailable/);
});

test('body limits and identity checks also apply to HTML responses', async () => {
  const message = await clientFor({ ...base, htmlBody: '<p>' + 'x'.repeat(260_000) + '</p>' }).client.message('fiction');
  assert.equal(message.truncated, true);
  assert.ok(message.text.length <= 256_000);
  await assert.rejects(clientFor({ ...base, id: 'wrong', htmlBody: '<p>receipt</p>' }).client.message('fiction'), /identity/);
  await assert.rejects(clientFor({ ...base, date: 'bad date', htmlBody: '<p>receipt</p>' }).client.message('fiction'), /required fields/);
});

test('identity accepts address objects and falls back to usable from metadata without inventing profile calls', async () => {
  for (const message of [
    { id: 'sent', sender: { emailAddress: { address: 'OWNER@example.invalid' } } },
    { id: 'sent', sender: { displayName: 'Synthetic' }, from: { email: 'owner@example.invalid' } }
  ]) {
    const { client, calls } = clientFor({ threads: [{ messages: [message] }] });
    assert.equal(await client.identity(), 'owner@example.invalid');
    assert.equal(calls[0][1], 'search_threads');
    assert.equal(calls[0][2].query, 'in:sent from:me');
    assert.equal(calls.length, 1);
  }
  const { client } = clientFor({ threads: [{ messages: [
    { id: 'sent-a', sender: 'first@example.invalid' }, { id: 'sent-b', sender: 'second@example.invalid' }
  ] }] });
  await assert.rejects(client.identity(), /Could not identify/);
});

test('object-shaped message senders normalize to a usable source address', async () => {
  const message = await clientFor({ ...base, sender: { emailAddress: { address: 'billing@suno.com' } }, plaintextBody: 'Amount paid EUR 24' }).client.message('fiction');
  assert.equal(message.sender, 'billing@suno.com');
  assert.equal(message.authenticatedSenderDomain, null);
});
