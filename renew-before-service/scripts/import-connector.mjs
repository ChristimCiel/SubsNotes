import { readFile, writeFile, mkdir, chmod, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { connectorMessages, fromConnectorMessage } from '../src/connector.mjs';

const [directory, file, mailboxEmail] = process.argv.slice(2);
if (!directory || !file || !mailboxEmail) throw new Error('Usage: node scripts/import-connector.mjs /private/directory /private/gmail-response.json verified-mailbox-email');
await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
const target = await realpath(resolve(directory));
const repository = await realpath(resolve(import.meta.dirname, '..'));
const relativeTarget = relative(repository, target);
const isOutside = relativeTarget === '..' || relativeTarget.startsWith('..' + sep) || isAbsolute(relativeTarget);
if (!isOutside) throw new Error('Private mail must be stored outside the source repository');
const raw = connectorMessages(JSON.parse(await readFile(file, 'utf8')));
const messages = raw.map(message => fromConnectorMessage(message, mailboxEmail));
await chmod(target, 0o700);
const suffix = BigInt('0x' + randomBytes(7).toString('hex')).toString(10);
await writeFile(join(target, 'messages-' + suffix + '.json'), JSON.stringify(messages, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ imported: messages.length, senderAuthenticated: messages.filter(m => m.authenticatedSenderDomain).length, privateDirectory: target }));
