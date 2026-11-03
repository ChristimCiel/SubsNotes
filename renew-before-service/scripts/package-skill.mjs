import { mkdtemp, mkdir, copyFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = resolve(import.meta.dirname,'..');
// Explicit allowlist: never package working directories, records or credentials.
const files = [
  ['skills/subscription-review/SKILL.md','SKILL.md'],
  ['dist/subsnotes-claude.html','assets/subsnotes-claude.html'],
  ['scripts/subscription-view.mjs','scripts/subscription-view.mjs'],
  ['scripts/assistant-sync.mjs','scripts/assistant-sync.mjs'],
  ...['ledger-contracts','evidence-runtime','cashflow','fx','service-brands','subscription-view','private-directory','assistant-sync','claude-store','claude-gmail','web-sync','web-evidence','receipt-verification'].map(name=>['src/'+name+'.mjs','src/'+name+'.mjs'])
];
const stage = await mkdtemp(join(tmpdir(),'subsnotes-skill-'));
try {
  await promisify(execFile)(process.execPath,[join(root,'scripts/package-claude-web.mjs')]);
  for (const [source,destination] of files) {
    const target = join(stage,'subscription-review',destination);
    await mkdir(dirname(target),{recursive:true});
    await copyFile(join(root,source),target);
  }
  // Keep the MIT notice with the bundled source.
  await copyFile(join(root,'../LICENSE'),join(stage,'subscription-review/LICENSE'));
  const manifest = await readFile(join(stage,'subscription-review/SKILL.md'),'utf8');
  if (!/^---\nname: subscription-review\n/.test(manifest)) throw new Error('The skill manifest is missing');
  const output = join(root,'dist/subsnotes-subscription-review.zip');
  await mkdir(dirname(output),{recursive:true});
  // zip updates retain removed entries, so start from a fresh generated archive.
  await rm(output,{force:true});
  await promisify(execFile)('zip',['-X','-q','-r',output,'subscription-review'],{cwd:stage});
  console.log('Created the subscription-review skill ZIP with the shared deterministic view tools and no account data.');
} finally { await rm(stage,{recursive:true,force:true}); }
