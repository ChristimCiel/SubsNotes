import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMandate,
  approveMandate,
  revokeMandate,
  recordExecution,
  checkMandateValidity,
  AuditLog,
  MandateManager
} from '../src/mandates.mjs';

test('createMandate creates valid mandate', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  const mandate = createMandate({
    merchant: 'Netflix',
    action: 'cancel',
    scope: 'single',
    maxAmount: 15.99,
    expiresAt: futureDate.toISOString()
  });

  assert.ok(mandate.id);
  assert.strictEqual(mandate.merchant, 'Netflix');
  assert.strictEqual(mandate.action, 'cancel');
  assert.strictEqual(mandate.status, 'pending');
  assert.ok(mandate.createdAt);
});

test('createMandate validates inputs', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  assert.throws(
    () => createMandate({ action: 'cancel', scope: 'single', expiresAt: futureDate.toISOString() }),
    /Merchant name is required/
  );

  assert.throws(
    () => createMandate({ merchant: 'Test', action: 'delete', scope: 'single', expiresAt: futureDate.toISOString() }),
    /Action must be one of/
  );

  assert.throws(
    () => createMandate({ merchant: 'Test', action: 'cancel', scope: 'invalid', expiresAt: futureDate.toISOString() }),
    /Scope must be one of/
  );
});

test('createMandate rejects past expiry dates', () => {
  const pastDate = new Date();
  pastDate.setDate(pastDate.getDate() - 1);

  assert.throws(
    () => createMandate({
      merchant: 'Test',
      action: 'cancel',
      scope: 'single',
      expiresAt: pastDate.toISOString()
    }),
    /Expiry date must be in the future/
  );
});

test('approveMandate approves pending mandate', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  const mandate = createMandate({
    merchant: 'Spotify',
    action: 'downgrade',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  const approved = approveMandate(mandate, 'user_signature_xyz');

  assert.strictEqual(approved.status, 'approved');
  assert.ok(approved.approvedAt);
  assert.strictEqual(approved.approverSignature, 'user_signature_xyz');
});

test('approveMandate rejects non-pending mandates', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  const mandate = createMandate({
    merchant: 'Test',
    action: 'cancel',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  const approved = approveMandate(mandate, 'sig');
  
  assert.throws(
    () => approveMandate(approved, 'sig2'),
    /Cannot approve mandate with status: approved/
  );
});

test('revokeMandate revokes mandate with reason', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  const mandate = createMandate({
    merchant: 'Test',
    action: 'cancel',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  const revoked = revokeMandate(mandate, 'User changed mind');

  assert.strictEqual(revoked.status, 'revoked');
  assert.ok(revoked.revokedAt);
  assert.strictEqual(revoked.revocationReason, 'User changed mind');
});

test('recordExecution records successful execution', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  let mandate = createMandate({
    merchant: 'Canva',
    action: 'cancel',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  mandate = approveMandate(mandate, 'user_sig');

  const executed = recordExecution(mandate, {
    success: true,
    message: 'Subscription cancelled successfully',
    evidence: { confirmationId: 'CNF123' }
  });

  assert.strictEqual(executed.status, 'executed');
  assert.ok(executed.executedAt);
  assert.strictEqual(executed.executionResult.success, true);
});

test('recordExecution records failed execution', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  let mandate = createMandate({
    merchant: 'Test',
    action: 'cancel',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  mandate = approveMandate(mandate, 'user_sig');

  const executed = recordExecution(mandate, {
    success: false,
    message: 'Could not locate cancel button',
    evidence: { screenshot: 'base64...' }
  });

  assert.strictEqual(executed.status, 'failed');
  assert.strictEqual(executed.executionResult.success, false);
});

test('recordExecution rejects unapproved mandates', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  const mandate = createMandate({
    merchant: 'Test',
    action: 'cancel',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  assert.throws(
    () => recordExecution(mandate, { success: true, message: 'Done' }),
    /Only approved mandates can be executed/
  );
});

test('checkMandateValidity validates approved mandate', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  let mandate = createMandate({
    merchant: 'Test',
    action: 'cancel',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  mandate = approveMandate(mandate, 'sig');

  const result = checkMandateValidity(mandate);

  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.reason, 'Mandate is valid');
});

test('checkMandateValidity rejects revoked mandate', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  let mandate = createMandate({
    merchant: 'Test',
    action: 'cancel',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  mandate = revokeMandate(mandate, 'test');

  const result = checkMandateValidity(mandate);

  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /revoked/);
});

test('AuditLog logs entries', () => {
  const log = new AuditLog();

  const entry = log.logEntry({
    mandateId: 'mandate_123',
    action: 'mandate_created',
    actor: 'user',
    result: 'success'
  });

  assert.ok(entry.id);
  assert.strictEqual(entry.mandateId, 'mandate_123');
  assert.strictEqual(entry.action, 'mandate_created');
  assert.ok(entry.timestamp);
});

test('AuditLog retrieves entries for mandate', () => {
  const log = new AuditLog();

  log.logEntry({ mandateId: 'mandate_1', action: 'created', result: 'success' });
  log.logEntry({ mandateId: 'mandate_2', action: 'created', result: 'success' });
  log.logEntry({ mandateId: 'mandate_1', action: 'approved', result: 'success' });

  const entries = log.getEntriesForMandate('mandate_1');

  assert.strictEqual(entries.length, 2);
  assert.ok(entries.every(e => e.mandateId === 'mandate_1'));
});

test('AuditLog exports and imports', () => {
  const log = new AuditLog();

  log.logEntry({ mandateId: 'mandate_1', action: 'created', result: 'success' });
  log.logEntry({ mandateId: 'mandate_1', action: 'approved', result: 'success' });

  const exported = log.export();
  const data = JSON.parse(exported);

  assert.strictEqual(data.entryCount, 2);
  assert.ok(Array.isArray(data.entries));

  const newLog = new AuditLog();
  newLog.import(exported);

  assert.strictEqual(newLog.entries.length, 2);
});

test('MandateManager creates and tracks mandate', () => {
  const manager = new MandateManager();
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  const mandate = manager.createMandate({
    merchant: 'GitHub',
    action: 'keep',
    scope: 'recurring',
    expiresAt: futureDate.toISOString()
  });

  assert.ok(mandate.id);
  assert.strictEqual(manager.getAllMandates().length, 1);

  const auditEntries = manager.getAuditLog().getEntriesForMandate(mandate.id);
  assert.strictEqual(auditEntries.length, 1);
  assert.strictEqual(auditEntries[0].action, 'mandate_created');
});

test('MandateManager approves mandate', () => {
  const manager = new MandateManager();
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  const mandate = manager.createMandate({
    merchant: 'Notion',
    action: 'downgrade',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  const approved = manager.approveMandate(mandate.id, 'user_signature');

  assert.strictEqual(approved.status, 'approved');

  const auditEntries = manager.getAuditLog().getEntriesForMandate(mandate.id);
  assert.strictEqual(auditEntries.length, 2);
  assert.ok(auditEntries.some(e => e.action === 'mandate_approved'));
});

test('MandateManager executes mandate', () => {
  const manager = new MandateManager();
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  const mandate = manager.createMandate({
    merchant: 'FictionalMerchant',
    action: 'cancel',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  manager.approveMandate(mandate.id, 'user_sig');

  const executed = manager.executeMandate(mandate.id, {
    success: true,
    message: 'Cancelled successfully',
    evidence: { screenshot: 'data...' }
  });

  assert.strictEqual(executed.status, 'executed');

  const auditEntries = manager.getAuditLog().getEntriesForMandate(mandate.id);
  assert.strictEqual(auditEntries.length, 3);
  assert.ok(auditEntries.some(e => e.action === 'mandate_executed'));
});

test('MandateManager blocks invalid execution', () => {
  const manager = new MandateManager();
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  const mandate = manager.createMandate({
    merchant: 'Test',
    action: 'cancel',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  assert.throws(
    () => manager.executeMandate(mandate.id, { success: true, message: 'test' }),
    /Cannot execute: Mandate not yet approved/
  );

  const auditEntries = manager.getAuditLog().getEntriesForMandate(mandate.id);
  assert.ok(auditEntries.some(e => e.action === 'execution_blocked'));
});

test('MandateManager filters mandates by status', () => {
  const manager = new MandateManager();
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);

  manager.createMandate({
    merchant: 'Service1',
    action: 'cancel',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  const mandate2 = manager.createMandate({
    merchant: 'Service2',
    action: 'cancel',
    scope: 'single',
    expiresAt: futureDate.toISOString()
  });

  manager.approveMandate(mandate2.id, 'sig');

  const pending = manager.getMandatesByStatus('pending');
  const approved = manager.getMandatesByStatus('approved');

  assert.strictEqual(pending.length, 1);
  assert.strictEqual(approved.length, 1);
});
