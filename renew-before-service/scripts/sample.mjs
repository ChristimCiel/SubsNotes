import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildAudit, atomicWrite } from '../src/audit.mjs';
import { renderReport } from '../src/report.mjs';

// Packaging helper only: fictional fixtures run through the existing data core.
// No network access, mailbox scan, credential lookup, or provider action.
const directory = resolve(import.meta.dirname, '../../.private/sample');
await mkdir(resolve(directory, '..'), { recursive: true, mode: 0o700 });
await mkdir(directory, { mode: 0o700 }); // Existing data, including an empty folder, is never overwritten.
const mailboxEmail = 'sample@example.invalid';
const fixture = (id, sender, subject, text, receivedAt) => ({
  id: `fictional-${id}`, mailboxEmail, sender, subject, text, receivedAt,
  // Synthetic authentication is a fixture input, not an assertion about real mail.
  authenticatedSenderDomain: sender.split('@')[1]
});
const messages = [
  fixture('claude-paid', 'billing@mail.anthropic.com', 'Your receipt from Anthropic',
    'Oct 8–Nov 8, 2026 Claude Pro Qty 1 USD 20 Amount paid USD 20', '2026-10-08T10:00:00Z'),
  fixture('claude-renew', 'billing@mail.anthropic.com', 'Your subscription is confirmed',
    'Your Claude Pro subscription is confirmed. The next charge will be on Nov 8, 2026.', '2026-10-08T10:01:00Z'),
  fixture('suno-paid', 'billing@suno.com', 'Your receipt from Suno',
    'Oct 12–Nov 12, 2026 Suno Pro Monthly Qty 1 USD 10 Amount paid USD 10', '2026-10-12T10:00:00Z'),
  fixture('suno-canceled', 'billing@suno.com', 'Your Suno subscription was canceled',
    'Your Suno subscription was successfully canceled. Your access will expire on Nov 12, 2026.', '2026-10-20T10:00:00Z'),
  fixture('youtube-unknown', 'no-reply@youtube.com', 'Your receipt from YouTube',
    'Oct 23–Nov 23, 2026 Subscription Amount paid $10.00', '2026-10-23T10:00:00Z')
];
const file = await open(resolve(directory, 'messages-0.json'), 'wx', 0o600);
try { await file.writeFile(JSON.stringify(messages, null, 2)); } finally { await file.close(); }
const { snapshot, events } = await buildAudit(directory, { asOf: '2026-11-03T00:00:00Z', persist: false });
snapshot.coverage = { ...snapshot.coverage, method: 'Fictional sample only', mailboxCheckedAt: null,
  backgroundUpdatesConfigured: false, note: 'Fictional example. No Gmail account was scanned. Fixed demonstration date: 2026-11-03.' };
await atomicWrite(resolve(directory, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
await atomicWrite(resolve(directory, 'evidence.json'), JSON.stringify(events, null, 2));
const html = renderReport(snapshot, events).replace('<body>', '<body><aside role="note" style="padding:12px;text-align:center;background:#fff0c2;color:#392d13">Fictional sample · No account connected · Fixed date: November 3, 2026 · Amounts are illustrative</aside>');
await atomicWrite(resolve(directory, 'review.html'), html);
console.log('Fictional sample ready. From the repository root, run npm start and open http://127.0.0.1:4183/.');
