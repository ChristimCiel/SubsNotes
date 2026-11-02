import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { extractEvidence, projectEvidence } from '../src/evidence.mjs';

test('real stdio MCP discovery and tools read only the configured private dataset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renew-before-mcp-fixture-'));
  const events = extractEvidence({ id: 'fixture-plan', sender: 'billing@anthropic.com', authenticatedSenderDomain: 'anthropic.com', subject: 'Your Max subscription is confirmed', receivedAt: '2026-11-01T00:00:00Z', text: 'Your next charge will be on Dec 1, 2026.' });
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
    assert.equal(dashboard.structuredContent.counts.active, 1);
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
