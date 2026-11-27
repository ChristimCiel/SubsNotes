/**
 * Ed25519 signature verification for local agent bridge
 * Verifies signed receipt summaries from user's local AI agent
 */

import { webcrypto } from 'node:crypto';

const ALLOWED_FIELDS = new Set([
  'merchant',
  'amount',
  'currency',
  'date',
  'subscriptionId',
  'receiptHash',
  'timestamp'
]);

/**
 * Canonicalize JSON for signing
 * - Sort keys alphabetically
 * - No whitespace
 * - Reject any fields not in allowlist
 */
export function canonicalizeJSON(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('Input must be a plain object');
  }

  const filtered = {};
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    if (typeof value === 'object' && value !== null) {
      throw new Error(`Nested objects not allowed (field: ${key})`);
    }
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(`Field '${key}' not allowed in signed envelope`);
    }
    filtered[key] = value;
  }

  return JSON.stringify(filtered);
}

/**
 * Verify Ed25519 signature on a receipt summary
 * @param {Object} envelope - { data, signature, publicKey }
 * @returns {Promise<boolean>}
 */
export async function verifySignature(envelope) {
  try {
    const { data, signature, publicKey } = envelope;

    if (!data || !signature || !publicKey) {
      throw new Error('Missing required fields: data, signature, publicKey');
    }

    // Canonicalize the data
    const canonical = canonicalizeJSON(data);
    const message = new TextEncoder().encode(canonical);

    // Import the public key
    const keyData = typeof publicKey === 'string' 
      ? Uint8Array.from(Buffer.from(publicKey, 'base64'))
      : publicKey;

    const cryptoKey = await webcrypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'Ed25519' },
      false,
      ['verify']
    );

    // Verify the signature
    const signatureData = typeof signature === 'string'
      ? Uint8Array.from(Buffer.from(signature, 'base64'))
      : signature;

    const isValid = await webcrypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      signatureData,
      message
    );

    return isValid;
  } catch (error) {
    console.error('Signature verification failed:', error.message);
    return false;
  }
}

/**
 * Generate a keypair for testing
 * Returns { publicKey, privateKey } as base64 strings
 */
export async function generateKeypair() {
  const keypair = await webcrypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  );

  const publicKeyBuffer = await webcrypto.subtle.exportKey('raw', keypair.publicKey);
  const privateKeyBuffer = await webcrypto.subtle.exportKey('pkcs8', keypair.privateKey);

  return {
    publicKey: Buffer.from(publicKeyBuffer).toString('base64'),
    privateKey: Buffer.from(privateKeyBuffer).toString('base64')
  };
}

/**
 * Sign data with a private key (for testing)
 */
export async function signData(data, privateKeyBase64) {
  const canonical = canonicalizeJSON(data);
  const message = new TextEncoder().encode(canonical);

  const privateKeyBuffer = Buffer.from(privateKeyBase64, 'base64');
  const cryptoKey = await webcrypto.subtle.importKey(
    'pkcs8',
    privateKeyBuffer,
    { name: 'Ed25519' },
    false,
    ['sign']
  );

  const signatureBuffer = await webcrypto.subtle.sign(
    'Ed25519',
    cryptoKey,
    message
  );

  return Buffer.from(signatureBuffer).toString('base64');
}

/**
 * Validate receipt summary schema
 * Ensures all required fields are present and valid
 */
export function validateReceiptSchema(data) {
  const required = ['merchant', 'amount', 'currency', 'date'];
  
  for (const field of required) {
    if (!(field in data)) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  // Validate types
  if (typeof data.merchant !== 'string' || data.merchant.length === 0) {
    throw new Error('merchant must be a non-empty string');
  }

  if (typeof data.amount !== 'number' || data.amount < 0 || !Number.isFinite(data.amount)) {
    throw new Error('amount must be a non-negative finite number');
  }

  if (typeof data.currency !== 'string' || !/^[A-Z]{3}$/.test(data.currency)) {
    throw new Error('currency must be a 3-letter currency code');
  }

  if (typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    throw new Error('date must be in YYYY-MM-DD format');
  }

  // Check for prompt injection attempts
  const suspiciousPatterns = [
    /ignore\s+previous/i,
    /system\s*:/i,
    /assistant\s*:/i,
    /<\|im_start\|>/i,
    /<\|im_end\|>/i,
    /\[INST\]/i,
    /\[\/INST\]/i
  ];

  const allValues = Object.values(data).join(' ');
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(allValues)) {
      throw new Error('Potential prompt injection detected');
    }
  }

  return true;
}
