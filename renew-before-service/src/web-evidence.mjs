import { createEvidenceRuntime } from './evidence-runtime.mjs';

// Web Crypto is asynchronous. Discover the small set of hash inputs first,
// then rerun the unchanged synchronous parser with actual SHA-256 values.
// This preserves event and merchant identities across the web and Node cores.
export async function extractWebEvidence(message, { subtle = globalThis.crypto?.subtle } = {}) {
  if (!subtle) throw new Error('Web Crypto is required to identify source records');
  const inputs = new Set();
  createEvidenceRuntime(value => { inputs.add(value); return 'pending-digest'; }).extractEvidence(message);
  const entries = await Promise.all([...inputs].map(async value => [value,
    [...new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('')]));
  const hashes = new Map(entries);
  return createEvidenceRuntime(value => {
    if (!hashes.has(value)) throw new Error('Receipt identity changed during parsing');
    return hashes.get(value);
  }).extractEvidence(message);
}
