import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { extractEvidence, projectEvidence } from '../src/evidence.mjs';
import { createPaymentConfirmationRuntime } from '../src/payment-confirmations.mjs';

test('real stdio MCP discovery and tools read only the configured private dataset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renew-before-mcp-fixture-'));
  const events = extractEvidence({ id: 'fixture-plan', sender: 'billing@anthropic.com', authenticatedSenderDomain: 'anthropic.com', subject: 'Your Max subscription is confirmed', receivedAt: '2026-11-01T00:00:00Z', text: 'Your next charge will be on Dec 1, 2026.' });
  events.push(...extractEvidence({id:'fixture-old-plan',sender:'billing@stripe.com',authenticatedSenderDomain:'stripe.com',subject:'Your Replit subscription will renew soon',receivedAt:'2026-01-01T00:00:00Z',text:'Your subscription will renew soon This is a friendly reminder that your Replit subscription for Replit Core will automatically renew on February 1, 2026.'}));
  events.push(...extractEvidence({id:'fixture-dated-payment',sender:'billing@anthropic.com',authenticatedSenderDomain:'anthropic.com',subject:'Your Claude subscription receipt',receivedAt:'2026-10-15T00:00:00Z',text:'Claude Pro monthly subscription. Paid October 15, 2026. Amount paid USD 20.00'}));
  events.push(...extractEvidence({id:'fixture-undated-annual',sender:'billing@anthropic.com',authenticatedSenderDomain:'anthropic.com',subject:'Your Claude subscription receipt',receivedAt:'2026-10-16T00:00:00Z',text:'Claude Pro annual subscription. Amount paid USD 144.00'}));
  events.push({id:'fixture-undated-refund',messageId:'fixture-undated-refund-mail',serviceKey:'claude',service:'Claude',category:'Software',kind:'refund_recorded',authenticated:true,receivedAt:'2026-10-17T00:00:00Z',refund:{currency:'USD',minor:500},refundDay:null,refundDateBasis:'unknown'});
  events.push({id:'fictional-chatgpt-invoice',messageId:'fictional-tax-mail',serviceKey:'chatgpt',service:'ChatGPT',category:'AI tools',kind:'invoice_recorded',authenticated:true,receivedAt:'2026-10-17T00:00:00Z',invoiceAmount:{currency:'EUR',minor:1900},invoiceDay:'2026-10-16'});
  const snapshot = projectEvidence(events, { asOf: '2026-11-02T00:00:00Z', coverage: { messageCount: 1, exhaustiveMailboxAudit: false } });
  await writeFile(join(directory, 'snapshot.json'), JSON.stringify(snapshot));
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(events));
  await symlink(resolve('src/mcp.mjs'), join(directory, 'entry.mjs'));
  const client = new Client({ name: 'fixture-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(directory, 'entry.mjs')], env: { RENEW_BEFORE_DATA_DIR: directory }, stderr: 'pipe' });
  await client.connect(transport);
  try {
    const tools = await client.listTools(); assert.equal(tools.tools.length, 4);
    assert.ok(tools.tools.every(t => t.annotations.readOnlyHint === true));
    const dashboard = await client.callTool({ name: 'get_dashboard', arguments: {} });
    assert.equal(dashboard.structuredContent.counts.active, 1);assert.equal(dashboard.structuredContent.counts.likely_canceled,1);
    assert.deepEqual(snapshot.recordedPaidMinorByCurrency,{USD:16400});
    assert.deepEqual(dashboard.structuredContent.recordedGrossPaidMinorByCurrency,{USD:2000});
    assert.equal(dashboard.structuredContent.financialExclusions.length,2);
    assert.equal(dashboard.structuredContent.financialExclusions[0].reason,'payment_date_unknown');
    assert.equal(dashboard.structuredContent.unallocatedPaymentCount,1);
    assert.deepEqual(dashboard.structuredContent.providerRefundMinorByCurrency,{});
    assert.equal(dashboard.structuredContent.paymentBasis,'receipt_payment_date');
    assert.equal(dashboard.structuredContent.bankReconciled,false);
    assert.equal(dashboard.structuredContent.unverifiedInvoiceCount,1);
    assert.equal(dashboard.structuredContent.pendingInvoices[0].messageId,'fictional-tax-mail');
    assert.equal(dashboard.structuredContent.pendingInvoices[0].reviewReason,'payment_unverified');
    assert.equal(dashboard.structuredContent.userConfirmationAvailability,'not_in_snapshot');
    assert.equal(dashboard.structuredContent.userConfirmedCount,null);
    const confirmed=createPaymentConfirmationRuntime().set({version:1,events},{eventId:'fictional-chatgpt-invoice',precision:'month',month:'2026-10',amount:{currency:'EUR',minor:1900},expectedRevision:0},{now:'2026-11-02T00:00:00Z'});
    await writeFile(join(directory,'snapshot.json'),JSON.stringify({...snapshot,paymentConfirmations:confirmed.paymentConfirmations}));
    const manual=(await client.callTool({name:'get_dashboard',arguments:{}})).structuredContent;
    assert.deepEqual(manual.recordedGrossPaidMinorByCurrency,{USD:2000,EUR:1900});
    assert.deepEqual(manual.sourcePaidMinorByCurrency,{USD:2000});
    assert.deepEqual(manual.userConfirmedPaidMinorByCurrency,{EUR:1900});
    assert.equal(manual.userConfirmationAvailability,'included_in_private_snapshot');
    assert.equal(manual.userConfirmedCount,1);assert.equal(manual.monthPrecisionPaymentCount,1);
    assert.equal(manual.userConfirmedPayments[0].paymentDay,null);
    assert.equal(manual.userConfirmedPayments[0].paymentMonth,'2026-10');
    assert.equal(manual.userConfirmedPayments[0].provenance,'user');
    assert.equal(manual.unverifiedInvoiceCount,0);
    const inactive=await client.callTool({name:'list_subscriptions',arguments:{status:'likely_canceled'}});
    assert.equal(inactive.structuredContent.subscriptions.length,1);assert.equal(inactive.structuredContent.subscriptions[0].inactivityInference.confirmed,false);
    const evidence = await client.callTool({ name: 'get_evidence', arguments: { serviceKey: 'claude' } });
    assert.equal(evidence.structuredContent.evidence[0].messageId, 'fixture-plan');
    const status = await client.callTool({ name: 'get_sync_status', arguments: {} });
    assert.equal(status.structuredContent.backgroundUpdatesConfigured, false);
    const bad = await client.callTool({ name: 'get_dashboard', arguments: { directory: '/another/account' } });
    assert.equal(bad.isError, true);
  } finally { await client.close(); }
});

test('a symlink cannot expand the local MCP evidence boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renew-before-mcp-isolation-'));
  const outside = await mkdtemp(join(tmpdir(), 'renew-before-mcp-outside-'));
  await writeFile(join(outside, 'private.json'), JSON.stringify({ confidential: 'fixture-only' }));
  await symlink(join(outside, 'private.json'), join(directory, 'snapshot.json'));
  const client = new Client({ name: 'fixture-isolation', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('src/mcp.mjs')], env: { RENEW_BEFORE_DATA_DIR: directory }, stderr: 'pipe' }));
  try {
    const response = await client.callTool({ name: 'get_dashboard', arguments: {} });
    assert.equal(response.isError, true); assert.ok(!JSON.stringify(response).includes('fixture-only'));
  } finally { await client.close(); }
});
