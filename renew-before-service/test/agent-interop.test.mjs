import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createAgentRuntime} from '../src/agent-runtime.mjs';
import {createAssistantScanRuntime} from '../src/assistant-scan.mjs';
import {createPaymentConfirmationRuntime} from '../src/payment-confirmations.mjs';
import {getAgentContract} from '../src/agent-contract.mjs';
import {createEvidenceRuntime} from '../src/evidence-runtime.mjs';
import {createCashflowRuntime} from '../src/cashflow.mjs';
import {createSubscriptionActivityRuntime} from '../src/subscription-activity.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const now='2026-11-06T08:00:00Z',ownerBinding='a'.repeat(64);
async function connect(directory,{write=false,name='synthetic-host'}={}) {
  const client=new Client({name,version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/agent-mcp.mjs')],env:{SUBSNOTES_DATA_DIR:directory,SUBSNOTES_ALLOW_PROPOSALS:write?'1':'0'},stderr:'pipe'});
  await client.connect(transport);return client;
}
const call=async(client,name,args={})=>client.callTool({name,arguments:args});
function result(request,{id='synthetic-mail',minor=2000,partial=false}={}) {
  const text='Example subscription. Amount paid USD '+(minor/100).toFixed(2)+'. Paid November 1, 2026.';
  const candidate={schemaVersion:1,messageId:id,serviceKey:'example',service:'Example',kind:'payment_succeeded',...(partial?{}:{payment:{currency:'USD',minor},paymentDay:'2026-11-01',paymentDateBasis:'explicit'}),fieldEvidence:{}};
  for(const key of Object.keys(candidate))if(!['schemaVersion','messageId','fieldEvidence'].includes(key))candidate.fieldEvidence[key]={quote:text};
  return {schemaVersion:1,kind:'subsnotes.assistant-scan-result',requestId:request.requestId,ledgerRevision:request.ledgerRevision,records:[{candidate,observation:{messageId:id,receivedAt:'2026-11-01T12:00:00Z',observedAt:now,text}}],coverage:{queriesComplete:false,attachmentsComplete:false,mailboxExhaustive:false}};
}
function memory(initial={version:1,events:[],prefs:{language:'zh-TW'},storageRevision:'fixture-rev'}) {
  let state=structuredClone(initial),journal=null,n=0;
  const store={load:async()=>structuredClone(state),save:async next=>{state={...structuredClone(next),storageRevision:'fixture-rev-'+(++n)};}};
  const requestStorage={read:async()=>structuredClone(journal),write:async value=>{journal=structuredClone(value);}};
  return {store,requestStorage,get:()=>structuredClone(state),runtime:()=>createAgentRuntime({store,requestStorage,ownerBinding,hash,clock:()=>now,requestId:()=> 'fixture-request-'+(++n),allowProposals:true})};
}

test('MCP discovery is provider neutral, defaults to read-only and does not initialize a ledger',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'subsnotes-agent-discovery-')),client=await connect(directory);
  try{
    const tools=(await client.listTools()).tools;
    assert.equal(tools.length,7);assert.equal(tools.filter(t=>t.annotations.readOnlyHint).length,6);
    assert.equal(tools.find(t=>t.name==='open_dashboard').annotations.readOnlyHint,false);
    assert.ok(!tools.some(t=>/confirm|cancel|gmail|submit|prepare/.test(t.name)));
    const caps=(await call(client,'get_capabilities')).structuredContent;
    assert.equal(caps.proposalsEnabled,false);assert.equal(caps.directMailboxAccess,false);assert.equal(caps.confirmationsWritable,false);
    assert.equal(caps.interactiveUi,'local-browser');assert.equal(caps.dashboardTool,'open_dashboard');
    const contract=(await call(client,'get_integration_contract')).structuredContent;
    assert.equal(contract.protocol,'subsnotes-agent');assert.equal(contract.resultSchema.$defs.result.properties.kind.const,'subsnotes.assistant-scan-result');
    assert.deepEqual(await readdir(directory),[]);
    const missing=await call(client,'get_dashboard');assert.equal(missing.isError,true);assert.equal(missing.structuredContent.error.code,'agent_store_uninitialized');
    assert.deepEqual(await readdir(directory),[]);
  }finally{await client.close();}
});

test('MCP dashboard launch shares the saved ledger, isolates profiles and reopens after a new process',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'subsnotes-agent-dashboard-a-')),otherDirectory=join(await mkdtemp(join(tmpdir(),'subsnotes-agent-dashboard-b-')),'new-private-profile');
  let first=await connect(directory,{write:true,name:'synthetic-dashboard-a'}),reopened;
  const other=await connect(otherDirectory,{name:'synthetic-dashboard-b'});
  const session=async client=>{
    const response=await call(client,'open_dashboard');assert.notEqual(response.isError,true);
    const launch=response.structuredContent;assert.equal(launch.sameLedger,true);assert.equal(launch.remoteEndpoint,false);
    const url=new URL(launch.url);assert.equal(url.hostname,'127.0.0.1');
    assert.equal((await fetch(url.origin+'/api/dashboard')).status,401);
    const html=await fetch(url.origin+'/');assert.equal(html.status,200);assert.match(await html.text(),/SubsNotes/);
    const login=await fetch(url.origin+'/api/session',{method:'POST',headers:{Origin:url.origin,'Content-Type':'application/json','X-Subsnotes-Request':'1'},body:JSON.stringify({token:new URLSearchParams(url.hash.slice(1)).get('token')})});
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const get=async path=>{const res=await fetch(url.origin+path,{headers:{Cookie:cookie}});assert.equal(res.status,200);return res.json();};
    return {url,cookie,get};
  };
  try{
    const request=(await call(first,'prepare_scan')).structuredContent.request;
    await call(first,'submit_scan_result',{result:result(request)});
    const [a,b]=await Promise.all([session(first),session(other)]);
    const reread=(await call(first,'open_dashboard')).structuredContent;assert.equal(reread.url,a.url.href);
    const dash=await a.get('/api/dashboard'),mcp=(await call(first,'get_dashboard')).structuredContent;
    assert.equal(dash.ledgerRevision,mcp.ledgerRevision);assert.equal(dash.counts.events,1);assert.equal(dash.services.items[0].name,'Example');
    const evidence=await a.get('/api/evidence?serviceKey=example');assert.equal(evidence.items[0].messageId,'synthetic-mail');
    const blank=await b.get('/api/dashboard');assert.equal(blank.counts.events,0);assert.equal(blank.setup.initialized,false);
    assert.equal((await fetch(b.url.origin+'/api/dashboard',{headers:{Cookie:a.cookie}})).status,401);
    await assert.rejects(()=>readdir(otherDirectory),error=>error.code==='ENOENT');
    await first.close();first=null;
    await assert.rejects(()=>fetch(a.url.origin+'/api/dashboard',{headers:{Cookie:a.cookie}}));
    assert.equal((await b.get('/api/dashboard')).counts.events,0);
    reopened=await connect(directory,{name:'synthetic-dashboard-reopened'});
    const next=await session(reopened),saved=await next.get('/api/dashboard');
    assert.equal(saved.ledgerRevision,mcp.ledgerRevision);assert.equal(saved.counts.events,1);
    assert.notEqual(next.url.hash,a.url.hash);
  }finally{if(first)await first.close();if(reopened)await reopened.close();await other.close();}
});

test('two independent stdio clients scan, persist, reopen and rescan the same private ledger',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'subsnotes-agent-roundtrip-'));let first=await connect(directory,{write:true,name:'synthetic-host-a'});
  let envelope,savedRevision;
  try{
    const request=(await call(first,'prepare_scan',{language:'zh-TW'})).structuredContent;
    const repeated=(await call(first,'prepare_scan',{language:'en'})).structuredContent;
    assert.equal(repeated.request.requestId,request.request.requestId);
    envelope=result(request.request);
    const saved=(await call(first,'submit_scan_result',{result:envelope})).structuredContent;
    assert.equal(saved.scanCompleted,true);assert.equal(saved.addedCount,1);assert.equal(saved.heldCount,1);assert.equal(saved.proposalAuthority,'unverified');
    savedRevision=saved.ledgerRevision;
    const replay=(await call(first,'submit_scan_result',{result:envelope})).structuredContent;
    assert.equal(replay.scanCompleted,true);assert.equal(replay.ledgerRevision,savedRevision);
  }finally{await first.close();}
  const reopened=await connect(directory,{write:true,name:'synthetic-host-b'});
  try{
    const dashboard=(await call(reopened,'get_dashboard',{month:'2026-11'})).structuredContent;
    assert.equal(dashboard.ledgerRevision,savedRevision);assert.equal(dashboard.counts.events,1);assert.equal(dashboard.counts.discoveredServices,0);assert.equal(dashboard.counts.held,0);
    assert.equal(dashboard.services.total,0,'unverified proposals are not monthly spending services');
    const historical=(await call(reopened,'get_dashboard')).structuredContent;
    assert.equal(historical.counts.held,1);
    assert.equal(historical.services.items[0].status,'needs_verification');assert.equal(historical.services.items[0].knownAmounts[0].amount.minor,2000);
    assert.deepEqual(dashboard.spending.recordedPaidMinorByCurrency,{});assert.equal(dashboard.spending.bankReconciled,false);
    const req=(await call(reopened,'prepare_scan')).structuredContent;
    const rescan=(await call(reopened,'submit_scan_result',{result:result(req.request)})).structuredContent;
    assert.equal(rescan.addedCount,0);assert.equal(rescan.duplicateCount,1);
    assert.equal((await call(reopened,'get_dashboard')).structuredContent.counts.events,1);
    const evidence=(await call(reopened,'get_evidence',{serviceKey:'example'})).structuredContent;
    assert.equal(evidence.total,1);assert.equal(evidence.items[0].messageId,'synthetic-mail');
    const before=await readFile(join(directory,'ledger-documents','subsnotes-assistant-request-v1.json'),'utf8');
    await call(reopened,'get_sync_status');
    assert.equal(await readFile(join(directory,'ledger-documents','subsnotes-assistant-request-v1.json'),'utf8'),before);
    assert.equal((await call(reopened,'get_dashboard',{directory:'/different/private/folder'})).isError,true);
  }finally{await reopened.close();}
  const readonly=await connect(directory);
  try{assert.equal((await call(readonly,'get_dashboard')).structuredContent.counts.events,1);await assert.rejects(()=>call(readonly,'submit_scan_result',{result:envelope}),/not found/);}
  finally{await readonly.close();}
});

test('partial records remain visible, invalid authority and stale request cannot be submitted',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'subsnotes-agent-validation-')),client=await connect(directory,{write:true});
  try{
    const req=(await call(client,'prepare_scan')).structuredContent.request;
    const bad=result(req);bad.records[0].candidate.userVerified=true;
    assert.equal((await call(client,'submit_scan_result',{result:bad})).isError,true);
    const wrong=result({...req,requestId:'another-request'});
    assert.equal((await call(client,'submit_scan_result',{result:wrong})).structuredContent.error.code,'assistant_request_mismatch');
    const partial=result(req,{partial:true});partial.records[0].candidate.payment=null;partial.records[0].candidate.paymentDay=null;
    const accepted=(await call(client,'submit_scan_result',{result:partial})).structuredContent;
    assert.equal(accepted.addedCount,1);
    const dash=(await call(client,'get_dashboard')).structuredContent;
    assert.equal(dash.services.total,1);assert.equal(dash.services.items[0].knownAmounts.length,0);assert.deepEqual(dash.spending.recordedPaidMinorByCurrency,{});
    assert.equal((await call(client,'list_subscriptions',{offset:0,limit:1})).structuredContent.total,1);
  }finally{await client.close();}
});

test('malformed files and symlinks cannot expand the configured private boundary or leak paths',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'subsnotes-agent-isolation-')),outside=await mkdtemp(join(tmpdir(),'subsnotes-agent-outside-'));
  await writeFile(join(outside,'private.json'),JSON.stringify({private:'synthetic-secret-marker'}),{mode:0o600});
  await symlink(join(outside,'private.json'),join(directory,'agent-identity.json'));
  const client=await connect(directory,{write:true});
  try{
    const r=await call(client,'prepare_scan');assert.equal(r.isError,true);
    assert.ok(!JSON.stringify(r).includes('synthetic-secret-marker'));assert.ok(!JSON.stringify(r).includes(outside));
  }finally{await client.close();}
});

test('a preexisting reader snapshot is never silently replaced by a new empty agent ledger',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'subsnotes-agent-migration-'));
  const content='{"syntheticExistingLedger":true}';await writeFile(join(directory,'snapshot.json'),content,{mode:0o600});
  const client=await connect(directory,{write:true});
  try{
    const r=await call(client,'prepare_scan');assert.equal(r.structuredContent.error.code,'agent_legacy_store_requires_migration');
    assert.equal(await readFile(join(directory,'snapshot.json'),'utf8'),content);assert.ok(!(await readdir(directory)).includes('agent-identity.json'));
  }finally{await client.close();}
});

test('parallel clients cannot both acknowledge conflicting results and lose a saved event',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'subsnotes-agent-concurrency-'));
  const a=await connect(directory,{write:true,name:'synthetic-parallel-a'}),b=await connect(directory,{write:true,name:'synthetic-parallel-b'});
  try{
    const request=(await call(a,'prepare_scan')).structuredContent.request;
    const rs=await Promise.all([call(a,'submit_scan_result',{result:result(request,{id:'source-a'})}),call(b,'submit_scan_result',{result:result(request,{id:'source-b'})})]);
    assert.equal(rs.filter(r=>!r.isError).length,1);assert.equal(rs.filter(r=>r.isError).length,1);
    const dash=(await call(a,'get_dashboard')).structuredContent;assert.equal(dash.counts.events,1);
    assert.ok(['agent_store_busy','assistant_result_conflict'].includes(rs.find(r=>r.isError).structuredContent.error.code));
  }finally{await a.close();await b.close();}
});

test('the same in-process API preserves exact-day and month user confirmations across model proposals',async()=>{
  const base=memory(),api=base.runtime(),prepared=await api.prepareScan();await api.submitScanResult(result(prepared.request));
  const source=base.get().events[0];
  for(const precision of ['day','month']){
    const confirmed=createPaymentConfirmationRuntime().set(base.get(),{eventId:source.id,precision,...(precision==='day'?{date:'2026-11-01'}:{month:'2026-11'}),amount:{currency:'USD',minor:2000},expectedRevision:0},{now});
    const f=memory(confirmed),runtime=f.runtime(),req=await runtime.prepareScan();
    const before=f.get().paymentConfirmations;
    const changed=await runtime.submitScanResult(result(req.request,{minor:3000}));
    assert.equal(changed.conflictCount,1);assert.deepEqual(f.get().paymentConfirmations,before);
    const dash=await runtime.dashboard({month:'2026-11'});assert.deepEqual(dash.spending.userConfirmedPaidMinorByCurrency,{USD:2000});
    assert.equal(dash.services.total,1);
    assert.equal(dash.services.items[0].lastObservedAt,now);
    assert.equal((await runtime.syncStatus()).lastSavedAt,now);
    const evidence=await runtime.evidence({serviceKey:'example'});
    assert.deepEqual(evidence.paymentConfirmations,before);
  }
});

test('Claude controller and neutral runtime share the v1 envelope without changing saved identities',async()=>{
  const f=memory();
  const legacy=createAssistantScanRuntime({...f,ownerBinding,hash,clock:()=>now,requestId:()=> 'legacy-compatible-request'});
  const prepared=await legacy.begin({dispatch:false});
  const outcome=await f.runtime().submitScanResult(result(prepared.request));
  assert.equal(outcome.scanCompleted,true);assert.equal(f.get().events[0].id,'candidate:synthetic-mail:payment_succeeded:');
  const second=await f.runtime().prepareScan();
  const accepted=await legacy.accept(result(second.request,{id:'another-source'}));
  assert.equal(accepted.scanCompleted,true);assert.equal(f.get().events.length,2);
});

test('contract explicitly separates model independence, Gmail source scope and unsupported platform actions',()=>{
  const c=getAgentContract();assert.equal(c.rules.directMailboxAccess,false);assert.equal(c.rules.assistantMayConfirmPayments,false);
  assert.equal(c.resultSchema.$defs.candidate.additionalProperties,false);assert.equal(c.resultSchema.$defs.result.properties.records.maxItems,100);
  assert.equal(c.requestSchema.additionalProperties,false);assert.ok(c.resultSchema.$defs.candidate.properties.paymentDay.anyOf.some(x=>x.type==='null'));
  for(const forbidden of ['authenticated','userVerified','paymentConfirmations'])assert.ok(!Object.hasOwn(c.resultSchema.$defs.candidate.properties,forbidden));
});

test('neutral and legacy host source markers use the same explicit trust gates',()=>{
  const core=createEvidenceRuntime(hash);
  for(const sourceFormat of ['connector_plaintext','claude_plaintext']){
    const event={id:'synthetic-trusted-read',messageId:'synthetic-read',serviceKey:'example',service:'Example',kind:'payment_succeeded',receivedAt:'2026-11-01T00:00:00Z',sourceFormat,sourceReadAt:now,authenticated:false,payment:{currency:'USD',minor:2000},paymentDay:'2026-11-01',paymentDateBasis:'explicit'};
    const snapshot=core.projectEvidence([event],{asOf:now,trustConnectorReads:true});
    assert.equal(snapshot.subscriptions.length,1);assert.equal(snapshot.heldEvidence.length,0);
    assert.deepEqual(createCashflowRuntime().summarize(snapshot,{month:'2026-11',trustConnectorReads:true}).paidMinorByCurrency,{USD:2000});
    assert.equal(createSubscriptionActivityRuntime().build({events:[event],snapshot,asOf:now,month:'2026-11',trustConnectorReads:true}).rejectedCount,0);
    assert.equal(core.projectEvidence([event],{asOf:now}).heldEvidence.length,1);
    assert.equal(core.projectEvidence([{...event,sourceReadAt:'invalid'}],{asOf:now,trustConnectorReads:true}).heldEvidence.length,1);
    assert.equal(core.projectEvidence([{...event,candidateStatus:'needs_review'}],{asOf:now,trustConnectorReads:true}).heldEvidence.length,1);
  }
});
