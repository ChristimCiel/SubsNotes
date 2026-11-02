import { mkdir, readFile, writeFile, readdir, stat, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function acquireFileLock(directory) {
  const token = randomUUID();
  const lock = join(directory, '.refresh-lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const entries = await readdir(lock);
    if (entries.some(name => name !== 'lease.json')) throw new Error('The refresh lock contains unexpected files');
    let previous = null; try { previous = JSON.parse(await readFile(join(lock, 'lease.json'), 'utf8')); } catch { /* Interrupted acquisition. */ }
    const age = Date.now() - (previous?.at || (await stat(lock)).mtimeMs);
    let alive = false;
    if (previous?.pid) { try { process.kill(previous.pid, 0); alive = true; } catch (e) { if (e.code !== 'ESRCH') alive = true; } }
    if (alive || age < (previous ? 15 * 60_000 : 60_000)) throw new Error('Another refresh is running');
    const stale = lock + '.stale.' + token;
    await rename(lock, stale);
    try { await mkdir(lock, { mode: 0o700 }); }
    finally { if (entries.includes('lease.json')) await unlink(join(stale, 'lease.json')); await rmdir(stale); }
  }
  await writeFile(join(lock, 'lease.json'), JSON.stringify({ token, pid: process.pid, at: Date.now() }), { mode: 0o600, flag: 'wx' });
  return async () => {
    const current = JSON.parse(await readFile(join(lock, 'lease.json'), 'utf8'));
    if (current.token !== token) throw new Error('Refresh lock ownership changed');
    await unlink(join(lock, 'lease.json')); await rmdir(lock);
  };
}
