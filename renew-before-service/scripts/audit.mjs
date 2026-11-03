import { buildAudit } from '../src/audit.mjs';
import { assertPrivateDirectory } from '../src/private-directory.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('Provide a private directory containing messages-*.json. Never put personal mail in the repository.');
await assertPrivateDirectory(directory);
const { messages, events, snapshot } = await buildAudit(directory, { asOf: process.env.AS_OF || new Date().toISOString() });
console.log(JSON.stringify({ messages: messages.length, evidenceEvents: events.length,
  subscriptions: snapshot.subscriptions.length, oneTimePurchases: snapshot.oneTimePurchases.length,
  heldEvidence: snapshot.heldEvidence.length, unconfirmedCurrencyPayments: snapshot.unconfirmedCurrencyPayments }, null, 2));
