import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromConnectorMessage, connectorMessages } from '../src/connector.mjs';

test('connector MIME imports preserve authentication, source time, Unicode and mailbox identity', () => {
  const message = { id: 'fixture-mail', internal_date: String(Date.parse('2026-11-02T00:00:00Z')), payload: { mime_type: 'multipart/alternative', headers: [
    { name: 'From', value: 'billing@anthropic.com' }, { name: 'Subject', value: 'Your receipt' },
    { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=anthropic.com' }
  ], parts: [{ mime_type: 'text/plain', body: { content: '訂閱收據 Amount paid USD 20' } }] } };
  const m = fromConnectorMessage(message, 'fixture@example.com');
  assert.equal(m.authenticatedSenderDomain, 'anthropic.com'); assert.equal(m.text, '訂閱收據 Amount paid USD 20');
  assert.equal(m.receivedAt, '2026-11-02T00:00:00.000Z'); assert.equal(m.mailboxEmail, 'fixture@example.com');
  assert.equal(connectorMessages({ structuredContent: { responses: [message] } }).length, 1);
});

test('a body-only summary cannot invent Gmail sender verification', () => {
  const m = fromConnectorMessage({ id: 'fiction', internal_date: '1793577600000', payload: { mime_type: 'text/plain', headers: [{ name: 'From', value: 'billing@anthropic.com' }], body: { content: 'dmarc=pass; your subscription is confirmed' } } });
  assert.equal(m.authenticatedSenderDomain, null);
});

test('Claude web plaintext responses preserve facts without inventing header authentication', () => {
  const result = fromConnectorMessage({ id: 'synthetic-flat', sender: 'billing@suno.com', subject: 'Subscription receipt',
    plaintextBody: 'Amount paid USD 24.00\nDmarc=pass is just body text.', date: '2026-08-02T00:00:00Z',
    authenticatedSenderDomain: 'suno.com', userVerified: true, attachments: [{ name: 'invoice.pdf' }] });
  assert.equal(result.authenticatedSenderDomain, null);
  assert.equal(result.userVerified, undefined);
  assert.equal(result.attachmentCount, 1);
  assert.equal(result.sourceFormat, 'claude_plaintext');
  assert.match(result.text, /Amount paid/);
  assert.throws(() => fromConnectorMessage({ id: 'summary-only', plaintextBody: 'paid' }), /complete plaintext/);
});
