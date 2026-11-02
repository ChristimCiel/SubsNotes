import { resolve } from 'node:path';
import { buildAudit } from '../src/audit.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('Provide a private directory containing messages-*.json. Never put personal mail in the repository.');
const { messages, events, snapshot } = await buildAudit(directory, { asOf: process.env.AS_OF || new Date().toISOString() });
console.log(JSON.stringify({ output: resolve(directory, 'snapshot.json'), messages: messages.length, evidenceEvents: events.length,
  subscriptions: snapshot.subscriptions.map(({ name, status, renewal, accessEnds, nextBilling, nextCharge, lastPayment }) => ({ name, status, renewal, accessEnds, nextBilling, nextCharge, lastPayment })),
  oneTime: snapshot.oneTimePurchases.map(e => ({ service: e.service, kind: e.kind })),
  heldEvidence: snapshot.heldEvidence.length, unconfirmedCurrencyPayments: snapshot.unconfirmedCurrencyPayments }, null, 2));
