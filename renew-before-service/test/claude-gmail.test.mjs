import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeGmailClient } from '../src/claude-gmail.mjs';
import { extractWebEvidence } from '../src/web-evidence.mjs';

const time = '2026-08-15T00:00:00Z';
const base = { id: 'fiction', sender: 'billing@suno.com', subject: 'Subscription receipt', date: time };
function clientFor(value) {
  const calls = [];
  const client = createClaudeGmailClient({ callTool: async (...args) => { calls.push(args); return { payload: value }; } }, { clock: () => time });
  return { client, calls };
}

test('HTML fallback consumes only returned fields and keeps the proven plain-text request', async () => {
  for (const field of ['htmlBody', 'html']) {
    const { client, calls } = clientFor({ ...base, plaintextBody: '',
      [field]: '<style>.x{display:none}</style><p>Suno Pro</p><p>Paid Aug 2, 2026</p><p>Aug 2–Sep 2, 2026</p><p>Amount paid EUR 24.00</p><script>ignored()</script>',
      attachments: [{ name: 'receipt.pdf', content: 'This is metadata, not verified PDF content' }] });
    const message = await client.message('fiction');
    assert.equal(calls[0][2].messageFormat, 'PLAIN_TEXT');
    assert.equal(calls[0][3].cache, false);
    assert.equal(message.bodyFormat, 'html');
    assert.equal(message.sourceFormat, 'claude_plaintext');
    assert.equal(message.attachmentCount, 1);
    assert.equal(message.attachmentContentRead, false);
    assert.ok(!message.text.includes('ignored') && !message.text.includes('metadata'));
    const events = await extractWebEvidence(message);
    assert.equal(events[0].payment.minor, 2400);
    assert.equal(events[0].payment.currency, 'EUR');
  }
});

test('nonempty plain text wins over HTML; empty bodies remain explicit empty reads', async () => {
  const plain = clientFor({ ...base, plaintextBody: 'Amount paid EUR 24', htmlBody: '<p>Amount paid USD 99</p>' });
  const message = await plain.client.message('fiction');
  assert.equal(message.text, 'Amount paid EUR 24');
  assert.equal(message.bodyFormat, 'plain_text');
  const empty = await clientFor({ ...base, plaintextBody: '', attachments: [{ name: 'invoice.pdf' }] }).client.message('fiction');
  assert.equal(empty.text, '');
  assert.equal(empty.attachmentCount, 1);
  const unavailable=await clientFor({ ...base, attachments: [{ name: 'invoice.pdf' }] }).client.message('fiction');
  assert.equal(unavailable.sourceContentUnavailable,true);
});

test('body limits and identity checks also apply to HTML responses', async () => {
  const message = await clientFor({ ...base, htmlBody: '<p>' + 'x'.repeat(260_000) + '</p>' }).client.message('fiction');
  assert.equal(message.truncated, true);
  assert.ok(message.text.length <= 256_000);
  await assert.rejects(clientFor({ ...base, id: 'wrong', htmlBody: '<p>receipt</p>' }).client.message('fiction'), /identity/);
  await assert.rejects(clientFor({ ...base, date: 'bad date', htmlBody: '<p>receipt</p>' }).client.message('fiction'), /required fields/);
});

test('identity accepts address objects and falls back to usable from metadata without inventing profile calls', async () => {
  for (const message of [
    { id: 'sent', sender: { emailAddress: { address: 'OWNER@example.invalid' } } },
    { id: 'sent', sender: { displayName: 'Synthetic' }, from: { email: 'owner@example.invalid' } }
  ]) {
    const { client, calls } = clientFor({ threads: [{ messages: [message] }] });
    assert.equal(await client.identity(), 'owner@example.invalid');
    assert.equal(calls[0][1], 'search_threads');
    assert.equal(calls[0][2].query, 'in:sent from:me');
    assert.equal(calls.length, 1);
  }
  const { client } = clientFor({ threads: [{ messages: [
    { id: 'sent-a', sender: 'first@example.invalid' }, { id: 'sent-b', sender: 'second@example.invalid' }
  ] }] });
  await assert.rejects(client.identity(), /Could not identify/);
});

test('object-shaped message senders normalize to a usable source address', async () => {
  const message = await clientFor({ ...base, sender: { emailAddress: { address: 'billing@suno.com' } }, plaintextBody: 'Amount paid EUR 24' }).client.message('fiction');
  assert.equal(message.sender, 'billing@suno.com');
  assert.equal(message.authenticatedSenderDomain, null);
});

test('an exact HTML-only placeholder uses actual returned HTML but never invents missing content', async () => {
  const placeholder = 'Your browser does not support HTML';
  const missing = await clientFor({ ...base, plaintextBody: placeholder, attachments: [{ name: 'invoice.pdf' }] }).client.message('fiction');
  assert.equal(missing.text, '');
  assert.equal(missing.sourceContentUnavailable, true);
  assert.equal(missing.bodyFormat, 'unavailable');
  assert.equal(missing.attachmentContentRead, false);
  const available = await clientFor({ ...base, plaintextBody: placeholder, htmlBody: '<p>Amount paid EUR 24.00</p>' }).client.message('fiction');
  assert.equal(available.sourceContentUnavailable, false);
  assert.equal(available.bodyFormat, 'html');
  assert.match(available.text, /Amount paid EUR 24/);
  const genuine = 'Your browser does not support HTML. Amount paid EUR 24.00';
  assert.equal((await clientFor({ ...base, plaintextBody: genuine }).client.message('fiction')).text, genuine, 'a longer financial body is not discarded as a placeholder');
});

test('nonempty thread results without message summaries cannot silently complete discovery', async () => {
  for (const thread of [{ id: 'fictional-thread' }, { id: 'fictional-thread', messages: [] }]) {
    const { client } = clientFor({ threads: [thread] });
    await assert.rejects(client.search({ query: 'subscription' }), /omitted message summaries/);
  }
  assert.deepEqual((await clientFor({ threads: [] }).client.search()).ids, []);
});

test('a proven FULL_CONTENT fallback retrieves actual HTML once and validates the same source', async () => {
  const calls=[];
  const client=createClaudeGmailClient({callTool:async(...args)=>{calls.push(args);return{payload:{...base,
    plaintextBody:'Your browser does not support HTML',...(args[2].messageFormat==='FULL_CONTENT'?{htmlBody:'<p>Suno Pro subscription</p><p>Paid Aug 2, 2026</p><p>Aug 2–Sep 2, 2026</p><p>Amount paid EUR 24.00</p>'}:{})}};}},{clock:()=>time});
  const message=await client.message('fiction');
  assert.deepEqual(calls.map(c=>c[2]),[{messageId:'fiction',messageFormat:'PLAIN_TEXT'},{messageId:'fiction',messageFormat:'FULL_CONTENT'}]);
  assert.ok(calls.every(c=>c[0]==='Gmail'&&c[1]==='get_message'&&c[3].cache===false));
  assert.equal(message.bodyFormat,'html');assert.equal(message.sourceContentUnavailable,false);assert.equal(message.attachmentContentRead,false);
  assert.equal((await extractWebEvidence(message))[0].payment.minor,2400);
});

test('unsupported expanded content stays unavailable and headless tool suspension is never swallowed', async () => {
  for(const response of [{isError:true,content:[{type:'text',text:'unsupported format'}]},null]) {
    let calls=0;
    const client=createClaudeGmailClient({callTool:async()=>++calls===1?{payload:{...base,plaintextBody:'Your browser does not support HTML'}}:response});
    const message=await client.message('fiction');assert.equal(calls,2);assert.equal(message.sourceContentUnavailable,true);assert.equal(message.text,'');
  }
  const requiredTool={server:'Gmail',tool:'get_message',args:{messageId:'fiction',messageFormat:'FULL_CONTENT'}};
  const suspended=Object.assign(new Error('An actual tool result is required'),{requiredTool});let calls=0;
  const client=createClaudeGmailClient({callTool:async()=>{if(++calls===1)return{payload:{...base,plaintextBody:'Your browser does not support HTML'}};throw suspended;}});
  await assert.rejects(client.message('fiction'),e=>e===suspended);assert.equal(calls,2);
});

test('expanded HTML from a different message, sender or timestamp cannot become source evidence', async () => {
  for(const overrides of [{id:'different'},{sender:'billing@other.example.invalid'},{date:'2026-08-14T00:00:00Z'}]) {
    let calls=0;const client=createClaudeGmailClient({callTool:async()=>({payload:++calls===1?{...base,plaintextBody:'Your browser does not support HTML'}:{...base,...overrides,htmlBody:'<p>Amount paid USD 999</p>'}})});
    await assert.rejects(client.message('fiction'),/does not match the original message identity/);assert.equal(calls,2);
  }
});

test('FULL_CONTENT fallback retains body limits and a genuine initial body never triggers a second read', async () => {
  let calls=0;const client=createClaudeGmailClient({callTool:async()=>({payload:++calls===1?{...base,plaintextBody:''}:{...base,htmlBody:'<p>'+'x'.repeat(260000)+'</p>'}})});
  const message=await client.message('fiction');assert.equal(calls,2);assert.equal(message.truncated,true);assert.ok(message.text.length<=256000);
  const normal=clientFor({...base,plaintextBody:'Amount paid EUR 24.00'});await normal.client.message('fiction');assert.equal(normal.calls.length,1);
});
