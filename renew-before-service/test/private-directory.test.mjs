import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertPrivateDirectory } from '../src/private-directory.mjs';

const run = promisify(execFile);
const service = resolve(import.meta.dirname, '..');

async function fixture(action) {
  const temporary = await mkdtemp(join(tmpdir(), 'subsnotes-private-path-'));
  try {
    const root = join(temporary, 'source');
    const source = join(root, 'service');
    await mkdir(source, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'subsnotes' }));
    await action({ temporary, root, source, check: directory => assertPrivateDirectory(directory, { sourceDirectory: source }) });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test('private data cannot enter any part of a publication source archive', async () => fixture(async ({ root, source, check }) => {
  for (const target of [root, source, join(root, 'other-component', 'new-mail'), join(root, '.private', 'new-mail')]) {
    await assert.rejects(check(target), /outside the source repository/);
  }
  await assert.rejects(access(join(root, 'other-component')), { code: 'ENOENT' });
}));

test('an enclosing Git worktree is protected even without the project package name', async () => fixture(async ({ root, check }) => {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'other-source-project' }));
  await writeFile(join(root, '.git'), 'gitdir: /fixture/worktree-metadata\n');
  await assert.rejects(check(join(root, 'untracked', 'mail')), /outside the source repository/);
}));

test('a symlinked ancestor cannot redirect an outside destination into the source tree', async () => fixture(async ({ temporary, root, check }) => {
  const alias = join(temporary, 'source-alias');
  await symlink(root, alias, 'dir');
  await assert.rejects(check(join(alias, 'not-created', 'mail')), /outside the source repository/);
}));

test('an external symlink inside the source tree is also rejected as a destination', async () => fixture(async ({ temporary, root, check }) => {
  const outside = join(temporary, 'private-data');
  await mkdir(outside);
  const alias = join(root, 'private-alias');
  await symlink(outside, alias, 'dir');
  await assert.rejects(check(alias), /outside the source repository/);
}));

test('an outside sibling sharing the source name prefix remains usable', async () => fixture(async ({ temporary, check }) => {
  const target = join(temporary, 'source-private', 'mail');
  assert.equal(await check(target), join(await realpath(temporary), 'source-private', 'mail'));
  await assert.rejects(access(join(temporary, 'source-private')), { code: 'ENOENT' });
}));

test('all evidence CLIs reject the publication root before creating data', async () => fixture(async ({ temporary, root, source }) => {
  await cp(join(service, 'src'), join(source, 'src'), { recursive: true });
  await cp(join(service, 'scripts'), join(source, 'scripts'), { recursive: true });
  const raw = join(temporary, 'response.json');
  await writeFile(raw, '[]');
  const target = join(root, 'another-component', 'mail');
  for (const [script, args] of [
    ['import-connector.mjs', [target, raw, 'fixture@example.com']],
    ['audit.mjs', [target]],
    ['refresh.mjs', ['plan', target]],
    ['refresh.mjs', ['finish', target, raw]]
  ]) {
    await assert.rejects(run(process.execPath, [join(source, 'scripts', script), ...args]), error => {
      assert.match(error.stderr, /outside the source repository/);
      return true;
    });
    await assert.rejects(access(join(root, 'another-component')), { code: 'ENOENT' });
  }
}));

test('an outside import still succeeds without exposing its path or mailbox in output', async () => fixture(async ({ temporary }) => {
  const raw = join(temporary, 'response.json');
  const target = join(temporary, 'private-mail');
  await writeFile(raw, '[]');
  const { stdout } = await run(process.execPath, [join(service, 'scripts/import-connector.mjs'), target, raw, 'fixture@example.com']);
  assert.deepEqual(JSON.parse(stdout), { imported: 0, senderAuthenticated: 0 });
  assert.equal((await stat(target)).mode & 0o777, 0o700);
  const files = await readdir(target);
  assert.equal(files.length, 1);
  assert.equal((await stat(join(target, files[0]))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(target, files[0]), 'utf8')), []);
  const audit = await run(process.execPath, [join(service, 'scripts/audit.mjs'), target]);
  assert.deepEqual(JSON.parse(audit.stdout), {
    messages: 0, evidenceEvents: 0, subscriptions: 0, oneTimePurchases: 0,
    heldEvidence: 0, unconfirmedCurrencyPayments: 0
  });
  assert.ok((await readdir(target)).includes('snapshot.json'));
}));
