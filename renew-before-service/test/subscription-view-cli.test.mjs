import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createLedgerContracts } from '../src/ledger-contracts.mjs';

const run = promisify(execFile);
const cli = resolve(import.meta.dirname,'../scripts/subscription-view.mjs');
const state = {version:1,storageRevision:'synthetic-r1',events:[{
  id:'synthetic-payment',messageId:'example-receipt',serviceKey:'example-tool',service:'Example Tool',category:'Software',kind:'payment_succeeded',
  receivedAt:'2026-04-03T00:00:00Z',authenticated:true,payment:{minor:2000,currency:'USD'},paymentDay:'2026-04-02',paymentDateBasis:'explicit',
  sourceFormat:'test_fixture'
}]};
test('private view CLI preserves exact shared totals, bilingual controls and restrictive file permissions',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'subsnotes-view-test-'));
  try {
    const input=join(dir,'state.json'),output=join(dir,'view.html'),snapshot=join(dir,'view.json');
    await writeFile(input,JSON.stringify(state),{mode:0o600});
    const {stdout}=await run(process.execPath,[cli,'--state',input,'--output',output,'--snapshot-json',snapshot,'--language','zh','--as-of','2026-05-01T00:00:00Z']);
    assert.match(stdout,/No ledger was changed/);
    const view=JSON.parse(await readFile(snapshot,'utf8'));
    assert.deepEqual(view.totals.paidMinorByCurrency,{USD:2000});
    assert.equal(view.ledgerRevision,'synthetic-r1');
    assert.equal(view.rows.length,1);
    const html=await readFile(output,'utf8');
    assert.match(html,/<html lang="zh-Hant">/);
    assert.match(html,/connect-src 'none'/);
    assert.doesNotMatch(html,/authenticated|test_fixture/);
    if(process.platform!=='win32')assert.equal((await stat(output)).mode&0o777,0o600);
    await assert.rejects(run(process.execPath,[cli,'--state',input,'--output',output]),/Output already exists/);
    const alias=join(dir,'view-command.mjs');
    await symlink(cli,alias);
    const throughAlias=await run(process.execPath,[alias,'--state',input,'--output',join(dir,'alias.html')]);
    assert.match(throughAlias.stdout,/Created a private read-only view/);
    assert.match(await readFile(join(dir,'alias.html'),'utf8'),/Example Tool/);
    assert.deepEqual(JSON.parse(await readFile(input,'utf8')),state);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('portable imports cannot impersonate authenticated source reads; tampering and unsafe paths fail',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'subsnotes-view-test-'));
  try {
    const contracts=createLedgerContracts(),hash=value=>createHash('sha256').update(value).digest('hex');
    const bundle=await contracts.createPortableExport(state,{hash}),input=join(dir,'portable.json');
    await writeFile(input,JSON.stringify(bundle),{mode:0o600});
    await run(process.execPath,[cli,'--state',input,'--output',join(dir,'imported.html'),'--snapshot-json',join(dir,'imported.json')]);
    assert.deepEqual(JSON.parse(await readFile(join(dir,'imported.json'),'utf8')).totals.paidMinorByCurrency,{});
    bundle.state.events[0].payment.minor=9999;
    await writeFile(input,JSON.stringify(bundle));
    await assert.rejects(run(process.execPath,[cli,'--state',input,'--output',join(dir,'bad.html')]),/integrity check failed/);
    await writeFile(input,JSON.stringify(state));
    await assert.rejects(run(process.execPath,[cli,'--state',input,'--output',resolve(import.meta.dirname,'../dist/private-view.html')]),/outside the source repository/);
    await symlink(input,join(dir,'linked.json'));
    await assert.rejects(run(process.execPath,[cli,'--state',join(dir,'linked.json'),'--output',join(dir,'link.html')]),/private regular ledger file/);
    await writeFile(input,'{"secret":"example-private-secret-DO-NOT-LOG",');
    try {await run(process.execPath,[cli,'--state',input,'--output',join(dir,'malformed.html')]);assert.fail('Malformed JSON must fail');}
    catch(error){assert.match(error.stderr,/Invalid ledger JSON/);assert.doesNotMatch(error.stderr,/example-private-secret|\{"secret"/);}
  } finally {await rm(dir,{recursive:true,force:true});}
});
