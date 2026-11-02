import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('a symlink alias cannot import private mail into the source repository', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'renew-before-import-fixture-'));
  const repository = resolve(import.meta.dirname, '..');
  const raw = join(temporary, 'response.json');
  try {
    await writeFile(raw, '[]');
    const alias = join(temporary, 'repository-alias');
    await symlink(repository, alias, 'dir');
    await assert.rejects(promisify(execFile)(process.execPath, [join(repository, 'scripts/import-connector.mjs'), alias, raw, 'fixture@example.com']), error => {
      assert.match(error.stderr, /outside the source repository/);
      return true;
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
