import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this builder through npm run package:mcpb');
const stage = await mkdtemp(join(tmpdir(), 'renew-before-reader-build-'));
await mkdir(join(stage, 'src'));
// Explicit allowlist. No private data, environment files or application exports.
for (const file of ['mcp.mjs','cashflow.mjs','payment-confirmations.mjs']) await cp(join(root, 'src', file), join(stage, 'src', file));
await cp(join(root, 'mcpb', 'manifest.json'), join(stage, 'manifest.json'));
for (const file of ['package.json','package-lock.json','LICENSE']) await cp(join(root, file), join(stage, file));
const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error('Packaging command failed');
};
run(['ci','--omit=dev','--ignore-scripts'], stage);
await mkdir(join(root, 'dist'), { recursive: true });
const manifest=JSON.parse(await readFile(join(root,'mcpb','manifest.json'),'utf8'));
const output = join(root, 'dist', `SubsNotes-Evidence-Reader-${manifest.version}.mcpb`);
run(['exec','--yes','--package=@anthropic-ai/mcpb@2.1.2','--','mcpb','pack',stage,output], root);
console.log(output);
