import { readFile, readdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractEvidence, projectEvidence } from './evidence.mjs';
import { renderReport } from './report.mjs';

export async function atomicWrite(path, content) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}

export async function loadPrivateMessages(directory) {
  const files = (await readdir(directory)).filter(name => /^messages-\d+\.json$/.test(name));
  const messages = (await Promise.all(files.map(name => readFile(join(directory, name), 'utf8').then(JSON.parse)))).flat();
  return [...new Map(messages.map(message => [message.id, message])).values()];
}

export async function buildAudit(directory, { asOf = new Date().toISOString(), scanState = null, persist = true } = {}) {
  const messages = await loadPrivateMessages(directory);
  const mailboxes = [...new Set(messages.map(m => m.mailboxEmail).filter(Boolean))];
  if (mailboxes.length > 1) throw new Error('Use a separate private data directory for each connected mailbox');
  const mailboxEmail = mailboxes[0] || null;
  const events = messages.flatMap(message => extractEvidence({ ...message, mailboxEmail: message.mailboxEmail || mailboxEmail }));
  if (!scanState) { try { scanState = JSON.parse(await readFile(join(directory, 'scan-state.json'), 'utf8')); } catch { /* Projection time is not scan time. */ } }
  const snapshot = projectEvidence(events, { asOf, coverage: {
    messageCount: messages.length, queryWindow: '2 years', method: 'Gmail connector targeted searches',
    exhaustiveMailboxAudit: false, mailboxCheckedAt: scanState?.lastCompletedAt || null,
    backgroundUpdatesConfigured: scanState?.backgroundUpdatesConfigured === true,
    note: 'Only billing-related queries were inspected. Absence of evidence is not proof of cancellation.'
  } });
  if (persist) {
    // Evidence goes first, so an older snapshot can still resolve its source IDs.
    await atomicWrite(join(directory, 'evidence.json'), JSON.stringify(events, null, 2));
    await atomicWrite(join(directory, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    await atomicWrite(join(directory, 'review.html'), renderReport(snapshot, events));
  }
  return { messages, events, snapshot, mailboxEmail };
}
