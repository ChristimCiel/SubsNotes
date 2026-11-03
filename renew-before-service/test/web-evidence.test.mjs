import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEvidence } from '../src/evidence.mjs';
import { extractWebEvidence } from '../src/web-evidence.mjs';

test('Web Crypto produces exactly the same evidence and unknown-merchant IDs as the Node parser', async () => {
  for (const message of [
    { id: 'synthetic-web-paid', sender: 'billing@suno.com', subject: 'Subscription receipt', text: 'Suno Pro. Paid Aug 2, 2026. Amount paid EUR 24' },
    { id: 'synthetic-web-cancel', sender: 'billing@suno.com', subject: 'Your subscription was canceled', text: 'Your access will expire on Sep 2, 2026.' },
    { id: 'synthetic-web-未知', sender: 'billing@merchant.example', subject: 'Your receipt from Fictional Studio', text: 'Amount paid USD 18.00' },
    { id: 'synthetic-web-none', sender: 'newsletter@merchant.example', subject: 'Newsletter', text: 'Not a billing event' }
  ]) {
    const input = { ...message, receivedAt: '2026-08-03T00:00:00Z', authenticatedSenderDomain: null };
    assert.deepEqual(await extractWebEvidence(input), extractEvidence(input));
  }
  await assert.rejects(extractWebEvidence({}, { subtle: null }), /Web Crypto/);
});
