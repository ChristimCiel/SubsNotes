import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationProblems } from './check-publication.mjs';

test('internal maintainer documents are blocked independently of secrets', () => {
  for (const path of ['AGENTS.md', 'docs/ROADMAP.md', 'docs/NEXT_VERSION_PLAN.md', 'TEAM_CONTRACT.md']) {
    assert.ok(publicationProblems(path, '').includes('private maintainer document'));
  }
  assert.ok(publicationProblems('notes.md', '# Execution ' + 'plan').includes('internal planning content'));
  assert.deepEqual(publicationProblems('README.md', '# SubsNotes\nRun npm start.'), []);
});

test('loopback and documentation examples do not reveal a user network address', () => {
  assert.deepEqual(publicationProblems('README.md', '127.0.0.1 192.0.2.1 198.51.100.3 203.0.113.2'), []);
});
test('non-loopback addresses are blocked without logging their value', () => {
  const address = [192, 168, 4, 5].join('.');
  assert.deepEqual(publicationProblems('config.json', address), ['non-loopback IPv4 literal']);
});
test('private exports and actual environment files cannot be published', () => {
  for (const file of ['.env.local', 'App/GmailDesktopClient.json', '.private/messages-0.json', 'scan-state.json']) {
    assert.ok(publicationProblems(file, '').includes('private or generated file'));
  }
  assert.deepEqual(publicationProblems('.env.example', 'PORT=4183'), []);
});
test('home paths and personal mailboxes are blocked with values kept out of reports', () => {
  assert.ok(publicationProblems('notes.md', '/Users/' + 'someone/private').includes('developer home path'));
  assert.ok(publicationProblems('notes.md', 'person' + '@' + 'gmail.com').includes('personal mailbox literal'));
  assert.deepEqual(publicationProblems('fixture.json', 'reader@example.invalid'), []);
});
test('credential patterns block output without retaining credential values', () => {
  const fake = 'GOC' + 'SPX-' + 'fictional-test-material';
  const issues = publicationProblems('config.json', fake);
  assert.ok(issues.includes('credential material'));
  assert.ok(issues.every(x => !x.includes(fake)));
});

test('private native links and Gmail receipt links cannot enter documentation',()=>{
  const artifact='https://claude.ai/'+'artifact/'+'x'.repeat(22);
  const mail='https://mail.google.com/mail/'+'#all/'+'a'.repeat(16);
  assert.ok(publicationProblems('README.md',artifact).includes('private assistant link'));
  assert.ok(publicationProblems('README.md',mail).includes('private Gmail source link'));
});

test('financial and message dumps are blocked even under an innocent JSON filename',()=>{
  const state=JSON.stringify({mailboxHash:'a'.repeat(64),eventChunks:[]});
  const mail=JSON.stringify({id:'a'.repeat(16),plaintextBody:'Synthetic private message'});
  for(const value of [state,mail])assert.ok(publicationProblems('input.json',value).includes('private mail or financial dataset'));
  assert.deepEqual(publicationProblems('fixture.json',JSON.stringify({id:'fictional-id',kind:'payment_succeeded'})),[]);
});

test('IPv6 privacy checks allow loopback/documentation and reject other host literals',()=>{
  assert.deepEqual(publicationProblems('README.md','[::1] 2001:db8::1'),[]);
  assert.deepEqual(publicationProblems('style.css','button::before { color: red; } p::after { display: block; }'),[]);
  const address='fd00'+'::'+'1234';
  assert.ok(publicationProblems('config.json',address).includes('non-loopback IPv6 literal'));
});
