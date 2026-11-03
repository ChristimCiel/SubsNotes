import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,symlink,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),cli=resolve(import.meta.dirname,'../scripts/assistant-sync.mjs');
const asOf='2026-08-15T00:00:00Z';
const initial=()=>({documents:[],observations:[],runId:'synthetic-cli-run',asOf});
async function invoke(dir,payload,name){
  const input=join(dir,name+'-input.json'),output=join(dir,name+'-output.json');
  await writeFile(input,JSON.stringify(payload),{mode:0o600});
  const result=await exec(process.execPath,[cli,'--input',input,'--output',output]);
  return {input,output,stdout:result.stdout,plan:JSON.parse(await readFile(output,'utf8'))};
}
async function observedRun(dir){
  const payload={...initial(),nativeIndexVersion:'observed-version-fixture'};
  for(let step=0;step<5;step++){
    const result=await invoke(dir,payload,'step-'+step);
    if(result.plan.status==='ready_to_commit')return {payload,...result};
    const required=result.plan.requiredTool;
    const reply=required.tool==='get_message'?{id:'fictional-receipt',sender:'billing@suno.com',subject:'Subscription receipt',plaintextBody:'Suno Pro subscription. Paid Aug 2, 2026. Amount paid EUR 24.00',date:'2026-08-02T00:00:00Z'}
      :required.args.query==='in:sent from:me'?{threads:[{messages:[{id:'fictional-sent',sender:'owner@example.invalid'}]}]}
      :{threads:[{messages:[{id:'fictional-receipt'}]}],resultCountEstimate:1};
    payload.observations.push({...required,runId:payload.runId,observedAt:asOf,result:reply});
  }
  assert.fail('A bounded observed run must prepare a plan');
}

test('headless CLI requests missing tools privately without performing external writes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'subsnotes-sync-cli-'));
  try{
    const result=await invoke(dir,initial(),'first');
    assert.equal(result.plan.status,'needs_tool');assert.equal(result.plan.requiredTool.tool,'search_threads');
    assert.equal(result.plan.requiredTool.args.query,'in:sent from:me');assert.equal(result.plan.stored,false);
    assert.equal(result.plan.executionMode,'plan-only');assert.equal(result.plan.sourceAuthenticityVerified,false);
    assert.match(result.stdout,/Nothing was stored externally/);assert.doesNotMatch(result.stdout,/example.invalid/);
    if(process.platform!=='win32')assert.equal((await stat(result.output)).mode&0o777,0o600);
    await assert.rejects(exec(process.execPath,[cli,'--input',result.input,'--output',result.output]),/Output already exists/);
    await symlink(result.input,join(dir,'linked-input.json'));
    await assert.rejects(exec(process.execPath,[cli,'--input',join(dir,'linked-input.json'),'--output',join(dir,'unused.json')]),/private regular input/);
    await assert.rejects(exec(process.execPath,[cli,'--input',result.input,'--output',resolve(import.meta.dirname,'../dist/unsafe-sync.json')]),/outside the source repository/);
    await writeFile(result.input,'{"secret":"fictional-private-secret-never-log",');
    try{await exec(process.execPath,[cli,'--input',result.input,'--output',join(dir,'malformed.json')]);assert.fail('Malformed input must fail');}
    catch(error){assert.match(error.stderr,/Invalid sync JSON/);assert.doesNotMatch(error.stderr,/fictional-private-secret|\{"secret"/);}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('actual-shaped dated observations produce only planned chunk and conditional-index writes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'subsnotes-sync-cli-'));
  try{
    const result=await observedRun(dir);
    assert.equal(result.plan.status,'ready_to_commit');assert.equal(result.plan.stored,false);
    assert.equal(result.plan.nativeIndexVersion,'observed-version-fixture');assert.equal(result.plan.summary.addedEvidence,1);
    assert.equal(result.plan.writes.at(-1).id,'subsnotes-state-v1');
    assert.ok(result.plan.writes.slice(0,-1).every(write=>/^events-[a-f0-9]{64}$/.test(write.id)));
    const source=result.plan.writes.flatMap(write=>write.data.events||[])[0];
    assert.equal(source.payment.minor,2400);assert.equal(source.payment.currency,'EUR');assert.equal(source.authenticated,false);
    assert.deepEqual(result.payload.documents,[]);assert.deepEqual(JSON.parse(await readFile(result.input,'utf8')),result.payload);
    assert.doesNotMatch(result.stdout,/owner@example.invalid|billing@suno.com/);
    const missing={...result.payload};delete missing.nativeIndexVersion;
    const input=join(dir,'no-version.json'),output=join(dir,'must-not-exist.json');await writeFile(input,JSON.stringify(missing),{mode:0o600});
    await assert.rejects(exec(process.execPath,[cli,'--input',input,'--output',output]),/native conditional storage version/);
    await assert.rejects(access(output));
    const undated=structuredClone(result.payload);delete undated.observations[0].observedAt;
    await assert.rejects(invoke(dir,undated,'undated'),/actual dated Gmail/);
    const duplicate=structuredClone(result.payload);duplicate.observations.push({...duplicate.observations[0],result:{threads:[]}});
    await assert.rejects(invoke(dir,duplicate,'conflicting'),/Conflicting connector observations/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('the CLI reuses existing ledger schema and chunk integrity checks before planning',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'subsnotes-sync-cli-'));
  try{
    await assert.rejects(invoke(dir,{...initial(),documents:[{id:'public-or-other-user',data:{}}]},'bad-path'),/Invalid or duplicate private document/);
    await assert.rejects(invoke(dir,{...initial(),documents:[{id:'subsnotes-state-v1',data:{events:[{id:'invalid-event'}]}}]},'bad-schema'),/message identity/);
    await assert.rejects(invoke(dir,{...initial(),documents:[{id:'subsnotes-state-v1',data:{storageFormat:'chunks-v1',eventChunks:['a'.repeat(64)],storageRevision:'fixture-revision'}},{id:'events-'+'a'.repeat(64),data:{events:[]}}]},'bad-chunk'),/did not match its reference/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
