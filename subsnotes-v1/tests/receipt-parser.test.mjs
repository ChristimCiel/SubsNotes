import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReceiptText,
  parseCsv,
  parseEml,
  parseJsonBackup,
  parseImportFile,
  normalizeSubscription
} from '../src/receipt-parser.mjs';
import { buildIcsReminder, buildActionEmail } from '../src/actions.mjs';
import {
  analyzeUserSubscriptions,
  spendByCurrency,
  formatSpendBreakdown,
  monthlyEquivalent
} from '../src/analyzer.mjs';

describe('receipt-parser', () => {
  it('parses Claude / Anthropic receipt paste', () => {
    const text = `
From: Anthropic Billing <billing@anthropic.com>
Subject: Your Claude Pro receipt

Thanks for your payment of US$20.00 for Claude Pro (monthly).
Next renewal: 2026-12-15
`;
    const [sub] = parseReceiptText(text);
    assert.equal(sub.merchant, 'Claude Pro');
    assert.equal(sub.amount, 20);
    assert.equal(sub.currency, 'USD');
    assert.equal(sub.cadence, 'monthly');
    assert.equal(sub.nextDate, '2026-12-15');
    assert.ok(sub.billingUrl.includes('claude.ai'));
  });

  it('parses TWD amount and payment failed', () => {
    const text = 'Surfshark 付款失敗 NT$1,188 / year. Card declined.';
    const [sub] = parseReceiptText(text);
    assert.equal(sub.merchant, 'Surfshark');
    assert.equal(sub.currency, 'TWD');
    assert.equal(sub.amount, 1188);
    assert.equal(sub.cadence, 'annual');
    assert.equal(sub.status, 'payment_failed');
  });

  it('parses CSV with common headers', () => {
    const csv = `service,amount,currency,cycle,renewal_date,category,status
Cursor,20,USD,monthly,2026-12-01,Coding,active
ChatGPT Plus,20,USD,monthly,2026-12-03,Chat,active`;
    const rows = parseCsv(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].merchant, 'Cursor');
    assert.equal(rows[1].merchant, 'ChatGPT Plus');
  });

  it('parses EML quoted-printable soft breaks', () => {
    const eml = `From: bills@openai.com
Content-Type: text/plain; charset=utf-8

ChatGPT Plus receipt US$=
20.00 monthly. Next charge 2026-12-10.
`;
    const rows = parseEml(eml);
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].merchant, 'ChatGPT Plus');
    assert.equal(rows[0].amount, 20);
  });

  it('parses JSON backup', () => {
    const json = JSON.stringify({
      subscriptions: [
        { merchant: 'Meshy', amount: 20, currency: 'USD', cadence: 'monthly', category: 'Image' }
      ]
    });
    const rows = parseJsonBackup(json);
    assert.equal(rows[0].merchant, 'Meshy');
    assert.equal(rows[0].source, 'json');
  });

  it('parseImportFile routes by extension', () => {
    const csv = parseImportFile({ name: 'subs.csv', text: 'merchant,amount\nSuno,10' });
    assert.equal(csv[0].merchant, 'Suno');
  });

  it('normalizeSubscription maps yearly and NT$', () => {
    const s = normalizeSubscription({
      merchant: 'X',
      amount: 8,
      currency: 'NT$',
      cadence: 'yearly'
    });
    assert.equal(s.currency, 'TWD');
    assert.equal(s.cadence, 'annual');
  });
});

describe('actions ics + email', () => {
  it('builds valid ICS 2 days before target', () => {
    const ics = buildIcsReminder({
      title: 'Cursor renewal',
      description: 'Review Cursor billing',
      targetDate: '2026-12-15'
    });
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /SUMMARY:Cursor renewal/);
    assert.match(ics, /DTSTART:/);
  });

  it('builds bilingual cancel email', () => {
    const en = buildActionEmail({ lang: 'en', kind: 'cancel', merchant: 'Cursor', amountLabel: 'US$20' });
    assert.match(en.subject, /cancel/i);
    assert.match(en.body, /Cursor/);
    const zh = buildActionEmail({ lang: 'zh-TW', kind: 'cancel', merchant: 'Cursor' });
    assert.match(zh.subject, /取消/);
  });
});

describe('analyzer multi-currency + priorities', () => {
  it('keeps currencies separate without inventing FX', () => {
    const subs = [
      { id: '1', merchant: 'A', amount: 20, currency: 'USD', cadence: 'monthly', status: 'active', category: 'Chat' },
      { id: '2', merchant: 'B', amount: 300, currency: 'TWD', cadence: 'monthly', status: 'active', category: 'Chat' }
    ];
    const by = spendByCurrency(subs);
    assert.equal(by.USD, 20);
    assert.equal(by.TWD, 300);
    assert.match(formatSpendBreakdown(by), /US\$20/);
    assert.match(formatSpendBreakdown(by), /NT\$300/);
  });

  it('prioritizes payment_failed before overlap', () => {
    const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const subs = [
      { id: 'a', merchant: 'Claude Pro', amount: 20, currency: 'USD', cadence: 'monthly', status: 'payment_failed', category: 'Chat', nextDate: future },
      { id: 'b', merchant: 'ChatGPT Plus', amount: 20, currency: 'USD', cadence: 'monthly', status: 'active', category: 'Chat', nextDate: future },
      { id: 'c', merchant: 'Perplexity', amount: 20, currency: 'USD', cadence: 'monthly', status: 'active', category: 'Chat', nextDate: future }
    ];
    const q = analyzeUserSubscriptions(subs);
    assert.equal(q.findings[0].kind, 'payment_failed');
    assert.ok(q.findings.some((f) => f.kind === 'overlap'));
  });

  it('monthlyEquivalent divides annual by 12', () => {
    assert.equal(monthlyEquivalent({ amount: 120, cadence: 'annual' }), 10);
  });
});
