import { readFile, mkdir, open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLedgerContracts } from '../src/ledger-contracts.mjs';
import { createEvidenceRuntime } from '../src/evidence-runtime.mjs';
import { createCashflowRuntime } from '../src/cashflow.mjs';
import { createFxRuntime } from '../src/fx.mjs';
import { createSubscriptionViewRuntime } from '../src/subscription-view.mjs';
import { assertPrivateDirectory } from '../src/private-directory.mjs';

// The standalone skill bundle embeds this function and the same factories.
// No network, credentials or ledger writes are involved in rendering a view.
export async function runSubscriptionView(args, api) {
  const options = {};
  const names = new Set(['state','output','snapshot-json','language','month','currency','as-of']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help') return { help: true };
    if (!flag.startsWith('--') || !names.has(flag.slice(2)) || !args[i+1] || args[i+1].startsWith('--') || Object.hasOwn(options,flag.slice(2))) throw new Error('Use --state FILE --output FILE [--language en|zh] [--month YYYY-MM] [--currency ISO] [--snapshot-json FILE]');
    options[flag.slice(2)] = args[++i];
  }
  if (!options.state || !options.output) throw new Error('--state and --output are required');
  if (options.language && !['en','zh'].includes(options.language)) throw new Error('Use language en or zh');
  if (options.currency && !Intl.supportedValuesOf('currency').includes(options.currency)) throw new Error('Unsupported display currency');
  const { fs, paths, privateDirectory, contracts, core, cashflow, fx, view, hash } = api;
  const input = paths.resolve(options.state);
  await privateDirectory(paths.dirname(input));
  const stat = await fs.lstat(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 25_000_000) throw new Error('Use a private regular ledger file smaller than 25 MB');
  let raw;
  const encoded = await fs.readFile(input,'utf8');
  try { raw = JSON.parse(encoded); } catch { throw new Error('Invalid ledger JSON'); }
  let state, imported = false;
  if (raw.format === 'subsnotes-ledger') {
    state = (await contracts.importPortableExport(raw,{hash})).state;
    imported = true;
  } else state = contracts.validateCanonicalState(raw);
  const asOf = options['as-of'] ? new Date(options['as-of']) : new Date();
  if (!Number.isFinite(Number(asOf))) throw new Error('Invalid view date');
  const snapshot = view.build({state,core,cashflow,fx,month:options.month || null,currency:options.currency || state.prefs?.currency || null,fxSnapshot:state.fxSnapshot || null,asOf});
  const outputs = [[options.output,view.renderHTML(snapshot,{language:options.language || 'en'})]];
  if (options['snapshot-json']) outputs.push([options['snapshot-json'],JSON.stringify(snapshot,null,2)+'\n']);
  const targets = [];
  for (const [file,content] of outputs) {
    const parent = await privateDirectory(paths.dirname(paths.resolve(file)));
    const path = paths.resolve(parent,paths.basename(file));
    if (path === input || targets.some(target=>target.path === path)) throw new Error('Input and output files must be different');
    try {
      await fs.lstat(path);
      throw new Error('Output already exists. Choose a new private filename');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    targets.push({path,parent,content});
  }
  for (const target of targets) {
    await fs.mkdir(target.parent,{recursive:true,mode:0o700});
    // Exclusive creation refuses existing files and symlinks, including races.
    const file = await fs.open(target.path,'wx',0o600);
    try { await file.writeFile(target.content,'utf8'); } finally { await file.close(); }
  }
  return { rows:snapshot.rows.length, readOnly:true, imported, sourceAuthenticityVerified:false };
}

export async function main(args = process.argv.slice(2)) {
  const contracts = createLedgerContracts();
  const hash = value => createHash('sha256').update(value).digest('hex');
  const result = await runSubscriptionView(args,{
    fs:{readFile,mkdir,open,lstat}, paths:{basename,dirname,resolve},
    privateDirectory:assertPrivateDirectory,contracts,hash,
    core:createEvidenceRuntime(hash,contracts),cashflow:createCashflowRuntime(),fx:createFxRuntime(),view:createSubscriptionViewRuntime()
  });
  if (result.help) console.log('Render a private, dated read-only view: --state FILE --output FILE [--language en|zh] [--month YYYY-MM] [--currency ISO] [--snapshot-json FILE]. No network calls. A raw ledger must come from actual host reads; validation does not authenticate a source. Portable imports require source rechecks. Existing output files are never overwritten.');
  else console.log(`Created a private read-only view with ${result.rows} service rows.${result.imported ? ' Imported evidence requires source rechecks.' : ''} No ledger was changed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().catch(error=>{console.error(error.code ? 'Private file access failed ('+String(error.code).replace(/[^A-Z0-9_]/g,'')+')' : error.message);process.exitCode=1;});
}
