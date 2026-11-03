import { createHash } from 'node:crypto';
import { createEvidenceRuntime } from './evidence-runtime.mjs';

export { createEvidenceRuntime };
export const digest = text => createHash('sha256').update(text).digest('hex');
export const { dayOf, currencyDecimals, parseDay, money, htmlToText, normalizedMessage, extractEvidence, projectEvidence } = createEvidenceRuntime(digest);
