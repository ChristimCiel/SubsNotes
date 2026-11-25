/**
 * Mandate and approval system with audit log
 * User must explicitly approve actions with scope, limits, and expiry
 */

/**
 * Create a new mandate
 * @param {Object} params - { merchant, action, scope, maxAmount, expiresAt }
 * @returns {Object} Mandate
 */
export function createMandate(params) {
  const { merchant, action, scope, maxAmount, expiresAt } = params;

  if (!merchant || typeof merchant !== 'string') {
    throw new Error('Merchant name is required');
  }

  const validActions = ['keep', 'downgrade', 'cancel'];
  if (!validActions.includes(action)) {
    throw new Error(`Action must be one of: ${validActions.join(', ')}`);
  }

  const validScopes = ['single', 'recurring', 'category'];
  if (!validScopes.includes(scope)) {
    throw new Error(`Scope must be one of: ${validScopes.join(', ')}`);
  }

  if (maxAmount !== undefined && (!Number.isFinite(maxAmount) || maxAmount < 0)) {
    throw new Error('Max amount must be a non-negative number');
  }

  if (!expiresAt || !isValidDate(expiresAt)) {
    throw new Error('Valid expiry date is required');
  }

  const now = new Date();
  const expiry = new Date(expiresAt);
  
  if (expiry <= now) {
    throw new Error('Expiry date must be in the future');
  }

  return {
    id: `mandate_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    merchant,
    action,
    scope,
    maxAmount,
    expiresAt,
    status: 'pending',
    createdAt: now.toISOString(),
    approvedAt: null,
    revokedAt: null,
    executedAt: null,
    executionResult: null
  };
}

/**
 * Approve a mandate
 * @param {Object} mandate - Mandate to approve
 * @param {string} approverSignature - Signature from approver
 * @returns {Object} Approved mandate
 */
export function approveMandate(mandate, approverSignature) {
  if (mandate.status !== 'pending') {
    throw new Error(`Cannot approve mandate with status: ${mandate.status}`);
  }

  if (!approverSignature || typeof approverSignature !== 'string') {
    throw new Error('Approver signature is required');
  }

  const expiry = new Date(mandate.expiresAt);
  if (expiry <= new Date()) {
    throw new Error('Cannot approve expired mandate');
  }

  return {
    ...mandate,
    status: 'approved',
    approvedAt: new Date().toISOString(),
    approverSignature
  };
}

/**
 * Revoke a mandate
 * @param {Object} mandate - Mandate to revoke
 * @param {string} reason - Reason for revocation
 * @returns {Object} Revoked mandate
 */
export function revokeMandate(mandate, reason) {
  if (!['pending', 'approved'].includes(mandate.status)) {
    throw new Error(`Cannot revoke mandate with status: ${mandate.status}`);
  }

  if (!reason || typeof reason !== 'string') {
    throw new Error('Revocation reason is required');
  }

  return {
    ...mandate,
    status: 'revoked',
    revokedAt: new Date().toISOString(),
    revocationReason: reason
  };
}

/**
 * Record mandate execution
 * @param {Object} mandate - Mandate being executed
 * @param {Object} result - Execution result
 * @returns {Object} Updated mandate
 */
export function recordExecution(mandate, result) {
  if (mandate.status !== 'approved') {
    throw new Error('Only approved mandates can be executed');
  }

  const expiry = new Date(mandate.expiresAt);
  if (expiry <= new Date()) {
    throw new Error('Cannot execute expired mandate');
  }

  if (!result || typeof result !== 'object') {
    throw new Error('Execution result is required');
  }

  const { success, message, evidence } = result;

  return {
    ...mandate,
    status: success ? 'executed' : 'failed',
    executedAt: new Date().toISOString(),
    executionResult: {
      success,
      message,
      evidence,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * Check if mandate is still valid
 * @param {Object} mandate - Mandate to check
 * @returns {Object} { valid, reason }
 */
export function checkMandateValidity(mandate) {
  const now = new Date();
  const expiry = new Date(mandate.expiresAt);

  if (mandate.status === 'revoked') {
    return { valid: false, reason: 'Mandate was revoked' };
  }

  if (mandate.status === 'executed') {
    return { valid: false, reason: 'Mandate already executed' };
  }

  if (mandate.status === 'failed') {
    return { valid: false, reason: 'Previous execution failed' };
  }

  if (expiry <= now) {
    return { valid: false, reason: 'Mandate has expired' };
  }

  if (mandate.status !== 'approved') {
    return { valid: false, reason: 'Mandate not yet approved' };
  }

  return { valid: true, reason: 'Mandate is valid' };
}

/**
 * Audit log entry
 */
export class AuditLog {
  constructor() {
    this.entries = [];
  }

  /**
   * Add entry to audit log
   * @param {Object} params - { mandateId, action, actor, result, metadata }
   */
  logEntry(params) {
    const { mandateId, action, actor, result, metadata = {} } = params;

    if (!mandateId || !action) {
      throw new Error('Mandate ID and action are required');
    }

    const entry = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      mandateId,
      action,
      actor: actor || 'system',
      result,
      metadata,
      timestamp: new Date().toISOString()
    };

    this.entries.push(entry);
    return entry;
  }

  /**
   * Get all entries for a mandate
   * @param {string} mandateId - Mandate ID
   * @returns {Array} Audit entries
   */
  getEntriesForMandate(mandateId) {
    return this.entries.filter(e => e.mandateId === mandateId);
  }

  /**
   * Get entries by action type
   * @param {string} action - Action type
   * @returns {Array} Audit entries
   */
  getEntriesByAction(action) {
    return this.entries.filter(e => e.action === action);
  }

  /**
   * Get all entries sorted by timestamp (newest first)
   * @returns {Array} All audit entries
   */
  getAllEntries() {
    return [...this.entries].sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );
  }

  /**
   * Export audit log as JSON
   * @returns {string} JSON string
   */
  export() {
    return JSON.stringify({
      exported: new Date().toISOString(),
      entryCount: this.entries.length,
      entries: this.entries
    }, null, 2);
  }

  /**
   * Import audit log from JSON
   * @param {string} json - JSON string
   */
  import(json) {
    try {
      const data = JSON.parse(json);
      if (!Array.isArray(data.entries)) {
        throw new Error('Invalid audit log format');
      }
      this.entries = data.entries;
    } catch (error) {
      throw new Error(`Failed to import audit log: ${error.message}`);
    }
  }
}

/**
 * Mandate manager - coordinates mandates and audit log
 */
export class MandateManager {
  constructor() {
    this.mandates = new Map();
    this.auditLog = new AuditLog();
  }

  /**
   * Create and store a new mandate
   */
  createMandate(params) {
    const mandate = createMandate(params);
    this.mandates.set(mandate.id, mandate);
    
    this.auditLog.logEntry({
      mandateId: mandate.id,
      action: 'mandate_created',
      result: 'success',
      metadata: { merchant: mandate.merchant, action: mandate.action }
    });

    return mandate;
  }

  /**
   * Approve a mandate
   */
  approveMandate(mandateId, approverSignature) {
    const mandate = this.mandates.get(mandateId);
    if (!mandate) {
      throw new Error('Mandate not found');
    }

    const approved = approveMandate(mandate, approverSignature);
    this.mandates.set(mandateId, approved);

    this.auditLog.logEntry({
      mandateId,
      action: 'mandate_approved',
      actor: 'user',
      result: 'success',
      metadata: { approverSignature: approverSignature.slice(0, 20) + '...' }
    });

    return approved;
  }

  /**
   * Revoke a mandate
   */
  revokeMandate(mandateId, reason) {
    const mandate = this.mandates.get(mandateId);
    if (!mandate) {
      throw new Error('Mandate not found');
    }

    const revoked = revokeMandate(mandate, reason);
    this.mandates.set(mandateId, revoked);

    this.auditLog.logEntry({
      mandateId,
      action: 'mandate_revoked',
      actor: 'user',
      result: 'success',
      metadata: { reason }
    });

    return revoked;
  }

  /**
   * Execute a mandate
   */
  executeMandate(mandateId, executionResult) {
    const mandate = this.mandates.get(mandateId);
    if (!mandate) {
      throw new Error('Mandate not found');
    }

    const validity = checkMandateValidity(mandate);
    if (!validity.valid) {
      this.auditLog.logEntry({
        mandateId,
        action: 'execution_blocked',
        actor: 'system',
        result: 'failure',
        metadata: { reason: validity.reason }
      });
      throw new Error(`Cannot execute: ${validity.reason}`);
    }

    const executed = recordExecution(mandate, executionResult);
    this.mandates.set(mandateId, executed);

    this.auditLog.logEntry({
      mandateId,
      action: 'mandate_executed',
      actor: 'agent',
      result: executionResult.success ? 'success' : 'failure',
      metadata: { 
        message: executionResult.message,
        hasEvidence: !!executionResult.evidence
      }
    });

    return executed;
  }

  /**
   * Get all mandates
   */
  getAllMandates() {
    return Array.from(this.mandates.values());
  }

  /**
   * Get mandates by status
   */
  getMandatesByStatus(status) {
    return this.getAllMandates().filter(m => m.status === status);
  }

  /**
   * Get audit log
   */
  getAuditLog() {
    return this.auditLog;
  }
}

function isValidDate(dateString) {
  try {
    const date = new Date(dateString);
    return date.toISOString() === dateString || !isNaN(date.getTime());
  } catch {
    return false;
  }
}
