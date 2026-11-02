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
