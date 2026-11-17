import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentDashboardServer} from '../src/agent-dashboard-server.mjs';
import {createFileAgentAccess} from '../src/agent-file-store.mjs';

const html='<!doctype html><title>SubsNotes</title><script>document.title="SubsNotes";</script><main>Connect your assistant</main>';
function profile(name,{uninitialized=false,throws=false}={}) {
  const calls=[],actions=[];
  return {calls,actions,access:{
    async invoke(method,args){calls.push({method,args});if(throws)throw new Error('/private/fictional-source-folder customer@example.invalid');if(uninitialized){const e=new Error('No private ledger');e.code='agent_store_uninitialized';throw e;}
      if(method==='dashboard')return {ledgerRevision:name+'-revision',services:{items:[{name:name+' synthetic subscription'}],total:1,nextOffset:null},counts:{events:1},spending:{userConfirmedPaidMinorByCurrency:{USD:2000}},prefs:{language:'en'}};
      if(method==='listSubscriptions')return {items:[{name}],total:1,nextOffset:null};
      if(method==='billingRecords')return {items:[{name,kind:'payment_succeeded',date:'2026-10-01'}],total:1,nextOffset:null};
      if(method==='evidence')return {items:[{service:name,messageId:name+'-synthetic-source'}],total:1,nextOffset:null};
      if(method==='syncStatus')return {status:'saved',ledgerRevision:name+'-revision'};
      throw new Error('Unexpected method');
    },async userAction(action,input){actions.push({action,input});return {saved:true};}
  }};
}
const origin=app=>new URL(app.url).origin;
const endpoint=(app,path)=>origin(app)+path;
async function connect(app,{token=new URL(app.url).hash.slice('#token='.length),headers={}}={}){
  const response=await fetch(endpoint(app,'/api/session'),{method:'POST',headers:{Origin:origin(app),'Content-Type':'application/json','X-SubsNotes-Request':'1',...headers},body:JSON.stringify({token})});
  return {response,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const read=(app,path,cookie,headers={})=>fetch(endpoint(app,path),{headers:{...(cookie?{Cookie:cookie}:{}),...headers}});
const write=(app,path,cookie,input,headers={})=>fetch(endpoint(app,path),{method:'POST',headers:{Cookie:cookie,Origin:origin(app),'Content-Type':'application/json','X-SubsNotes-Request':'1',...headers},body:JSON.stringify(input)});
const hostileHost=(app,host,cookie)=>new Promise((resolve,reject)=>{const r=httpRequest(endpoint(app,'/api/dashboard'),{headers:{Host:host,Cookie:cookie}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});r.on('error',reject);r.end();});

test('two independent local profiles use separate tokens and cookies with no cross-profile reads',async()=>{
  const pa=profile('Synthetic A'),pb=profile('Synthetic B');
  const a=await createAgentDashboardServer({access:pa.access,html}),b=await createAgentDashboardServer({access:pb.access,html});
  try{
    assert.equal(a.server.address().address,'127.0.0.1');
    assert.equal(a.server.address().family,'IPv4');
    const ca=await connect(a),cb=await connect(b);assert.equal(ca.response.status,200);assert.equal(cb.response.status,200);
    assert.notEqual(ca.cookie.split('=')[0],cb.cookie.split('=')[0],'cookies must not collide across ports');
    assert.match(ca.response.headers.get('set-cookie'),/HttpOnly/);assert.match(ca.response.headers.get('set-cookie'),/SameSite=Strict/);
    assert.equal((await connect(b,{token:new URL(a.url).hash.slice('#token='.length)})).response.status,401);
    assert.equal((await read(b,'/api/dashboard',ca.cookie)).status,401);assert.equal((await read(a,'/api/dashboard',cb.cookie)).status,401);
    const da=await (await read(a,'/api/dashboard',ca.cookie+'; '+cb.cookie)).json(),db=await (await read(b,'/api/dashboard',ca.cookie+'; '+cb.cookie)).json();
    assert.equal(da.services.items[0].name,'Synthetic A synthetic subscription');assert.equal(db.services.items[0].name,'Synthetic B synthetic subscription');
    assert.ok(!JSON.stringify(da).includes('Synthetic B'));assert.ok(!JSON.stringify(db).includes('Synthetic A'));
  }finally{await Promise.all([a.close(),b.close()]);}
});

test('public shell contains no billing data and every billing route requires authentication',async()=>{
  const p=profile('Secret synthetic'),app=await createAgentDashboardServer({access:p.access,html});
  try{
    const shell=await fetch(endpoint(app,'/'));const source=await shell.text();assert.equal(shell.status,200);assert.ok(!source.includes('Secret synthetic'));assert.equal(p.calls.length,0);
    assert.equal(shell.headers.get('cache-control'),'no-store');assert.equal(shell.headers.get('referrer-policy'),'no-referrer');assert.equal(shell.headers.get('x-frame-options'),'DENY');
    assert.match(shell.headers.get('content-security-policy'),/connect-src 'self'/);assert.match(shell.headers.get('content-security-policy'),/script-src 'self' 'sha256-/);assert.ok(!shell.headers.has('access-control-allow-origin'));
    for(const path of ['/api/dashboard','/api/subscriptions','/api/evidence?serviceKey=example','/api/sync'])assert.equal((await read(app,path)).status,401);
    assert.equal(p.calls.length,0);
    const c=await connect(app);assert.equal((await read(app,'/api/dashboard',c.cookie)).status,200);assert.equal(p.calls.length,1);
    assert.equal((await fetch(endpoint(app,'/../../agent-identity.json'))).status,404);
    assert.equal((await fetch(endpoint(app,'/?token=secret'))).status,404);
  }finally{await app.close();}
});

test('transaction history uses the same authenticated profile and rejects invalid billing filters',async()=>{
  const p=profile('Synthetic receipts'),app=await createAgentDashboardServer({access:p.access,html});
  try{
    assert.equal((await read(app,'/api/billing')).status,401);const c=await connect(app);
    const response=await read(app,'/api/billing?view=payments&month=2026-10&limit=100',c.cookie);
    assert.equal(response.status,200);assert.equal((await response.json()).items[0].date,'2026-10-01');
    assert.equal(p.calls.at(-1).method,'billingRecords');
    for(const path of ['/api/billing?view=all','/api/billing?month=2026-99','/api/billing?limit=101','/api/billing?directory=/another/profile'])assert.equal((await read(app,path,c.cookie)).status,400);
    assert.equal(p.actions.length,0);
  }finally{await app.close();}
});

test('host, origin and CSRF controls reject cross-site and rebinding-style requests',async()=>{
  const p=profile('Synthetic'),app=await createAgentDashboardServer({access:p.access,html,allowUserEdits:true});
  try{
    const c=await connect(app);const input={eventId:'synthetic-source',precision:'month',month:'2026-10',amount:{currency:'USD',minor:2000},expectedRevision:0};
    for(const hostile of ['https://attacker.invalid','null','http://localhost:'+app.server.address().port]){
      assert.equal((await read(app,'/api/dashboard',c.cookie,{Origin:hostile})).status,403);
      assert.equal((await write(app,'/api/confirm',c.cookie,input,{Origin:hostile})).status,403);
    }
    assert.equal(await hostileHost(app,'attacker.invalid',c.cookie),403);
    assert.equal(await hostileHost(app,'127.0.0.1.attacker.invalid',c.cookie),403);
    assert.equal((await write(app,'/api/confirm',c.cookie,input,{'X-SubsNotes-Request':''})).status,403);
    const noOrigin=await fetch(endpoint(app,'/api/confirm'),{method:'POST',headers:{Cookie:c.cookie,'Content-Type':'application/json','X-SubsNotes-Request':'1'},body:JSON.stringify(input)});assert.equal(noOrigin.status,403);
    assert.equal(p.actions.length,0);
    assert.equal((await write(app,'/api/confirm',c.cookie,input)).status,200);assert.deepEqual(p.actions,[{action:'confirm',input}]);
  }finally{await app.close();}
});

test('read-only viewer never exposes confirmation or preference writes and bounds query inputs',async()=>{
  const p=profile('Synthetic'),app=await createAgentDashboardServer({access:p.access,html});
  try{
    const c=await connect(app);
    assert.equal((await write(app,'/api/confirm',c.cookie,{})).status,403);assert.equal((await write(app,'/api/preferences',c.cookie,{language:'zh-TW'})).status,403);assert.equal(p.actions.length,0);
    const d=await (await read(app,'/api/dashboard',c.cookie)).json();assert.equal(d.setup.canConfirmPayments,false);
    for(const path of ['/api/dashboard?month=2026-99','/api/dashboard?directory=/private/other','/api/subscriptions?limit=101','/api/subscriptions?offset=-1','/api/subscriptions?limit=1&limit=2','/api/evidence?serviceKey='])assert.equal((await read(app,path,c.cookie)).status,400);
    const response=await read(app,'/api/evidence?serviceKey=example&offset=0&limit=10',c.cookie);assert.equal(response.status,200);assert.deepEqual(p.calls.at(-1),{method:'evidence',args:{offset:0,limit:10,serviceKey:'example'}});
  }finally{await app.close();}
});

test('new installations get explicit empty onboarding without initializing or writing a ledger',async()=>{
  const p=profile('Uninitialized',{uninitialized:true}),app=await createAgentDashboardServer({access:p.access,html,allowProposals:true});
  try{
    const c=await connect(app),d=await (await read(app,'/api/dashboard',c.cookie)).json();
    assert.equal(d.setup.initialized,false);assert.equal(d.setup.proposalsEnabled,true);assert.equal(d.setup.canConfirmPayments,false);assert.equal(d.counts.events,0);assert.equal(d.spending.coverage,'incomplete');assert.match(d.limits,/does not mean zero spending/);
    for(const path of ['/api/subscriptions','/api/evidence?serviceKey=example','/api/sync'])assert.equal((await (await read(app,path,c.cookie)).json()).setup.initialized,false);
    assert.equal(p.actions.length,0);assert.ok(p.calls.every(c=>['dashboard','listSubscriptions','evidence','syncStatus'].includes(c.method)));
  }finally{await app.close();}
});

test('invalid sessions, malformed writes and errors never return secrets or filesystem paths',async()=>{
  const p=profile('Synthetic',{throws:true}),app=await createAgentDashboardServer({access:p.access,html,allowUserEdits:true});
  try{
    assert.equal((await connect(app,{token:'é'.repeat(43)})).response.status,401);
    const c=await connect(app),r=await read(app,'/api/dashboard',c.cookie),error=await r.json();assert.equal(r.status,503);assert.deepEqual(error,{error:{code:'agent_operation_failed'},saved:null});
    const str=JSON.stringify(error);for(const privateText of ['/private/','customer@example.invalid',new URL(app.url).hash.slice(7)])assert.ok(!str.includes(privateText));
    assert.equal((await write(app,'/api/preferences',c.cookie,{language:'en',directory:'/private/other'})).status,400);
    const malformed=await fetch(endpoint(app,'/api/preferences'),{method:'POST',headers:{Cookie:c.cookie,Origin:origin(app),'Content-Type':'application/json','X-SubsNotes-Request':'1'},body:'['});assert.equal(malformed.status,400);
    assert.equal((await write(app,'/api/preferences',c.cookie,{language:'en',extra:'a'.repeat(20_000)})).status,413);
    assert.equal(p.actions.length,0);
  }finally{await app.close();}
});

test('independent real private stores preserve exact-day and month confirmations through rescan and reopening',async()=>{
  const directoryA=await mkdtemp(join(tmpdir(),'subsnotes-dashboard-a-')),directoryB=await mkdtemp(join(tmpdir(),'subsnotes-dashboard-b-'));
  const accessA=createFileAgentAccess({directory:directoryA,allowProposals:true}),accessB=createFileAgentAccess({directory:directoryB,allowProposals:true});
  let a=await createAgentDashboardServer({access:accessA,html,allowUserEdits:true,allowProposals:true}),b=await createAgentDashboardServer({access:accessB,html,allowUserEdits:true,allowProposals:true});
  const invoice=(request,{service,id,currency,minor})=>{
    const text=service+' subscription invoice. Invoice date October 1, 2026. Total '+currency+' '+(minor/100).toFixed(2)+'.';
    const candidate={schemaVersion:1,messageId:id,serviceKey:service.toLowerCase(),service,kind:'invoice_recorded',invoiceAmount:{currency,minor},invoiceDay:'2026-10-01',fieldEvidence:{}};
    for(const key of ['serviceKey','service','kind','invoiceAmount','invoiceDay'])candidate.fieldEvidence[key]={quote:text};
    return {schemaVersion:1,kind:'subsnotes.assistant-scan-result',requestId:request.requestId,ledgerRevision:request.ledgerRevision,records:[{candidate,observation:{messageId:id,receivedAt:'2026-10-01T12:00:00Z',observedAt:new Date().toISOString(),text}}],coverage:{queriesComplete:false,attachmentsComplete:false,mailboxExhaustive:false}};
  };
  try{
    const ca=await connect(a),cb=await connect(b);
    const initial=await (await read(a,'/api/dashboard',ca.cookie)).json();assert.equal(initial.setup.initialized,false);assert.deepEqual(await readdir(directoryA),[]);
    const qa=(await accessA.invoke('prepareScan',{})).request,qb=(await accessB.invoke('prepareScan',{})).request;
    const ra=invoice(qa,{service:'SyntheticA',id:'synthetic-a-invoice',currency:'USD',minor:2000}),rb=invoice(qb,{service:'SyntheticB',id:'synthetic-b-invoice',currency:'EUR',minor:14400});
    await accessA.invoke('submitScanResult',ra);await accessB.invoke('submitScanResult',rb);
    const month={eventId:'candidate:synthetic-a-invoice:invoice_recorded:',precision:'month',month:'2026-10',amount:{currency:'USD',minor:2000},expectedRevision:0};
    const day={eventId:'candidate:synthetic-b-invoice:invoice_recorded:',precision:'day',date:'2026-10-01',amount:{currency:'EUR',minor:14400},expectedRevision:0};
    assert.equal((await write(a,'/api/confirm',ca.cookie,month)).status,200);assert.equal((await write(b,'/api/confirm',cb.cookie,day)).status,200);
    const cross=await write(b,'/api/confirm',cb.cookie,month);assert.equal(cross.status,503);assert.equal((await cross.json()).error.code,'confirmation_missing_source');
    assert.equal((await write(a,'/api/confirm',ca.cookie,month)).status,409,'stale UI edits cannot overwrite a confirmation');
    const next=(await accessA.invoke('prepareScan',{})).request;
    const changed=await accessA.invoke('submitScanResult',invoice(next,{service:'SyntheticA',id:'synthetic-a-invoice',currency:'USD',minor:9000}));assert.equal(changed.conflictCount,1);
    const da=await (await read(a,'/api/dashboard?month=2026-10',ca.cookie)).json(),db=await (await read(b,'/api/dashboard?month=2026-10',cb.cookie)).json();
    assert.deepEqual(da.spending.userConfirmedPaidMinorByCurrency,{USD:2000});assert.deepEqual(db.spending.userConfirmedPaidMinorByCurrency,{EUR:14400});
    assert.equal((await (await read(a,'/api/evidence?serviceKey=syntheticb',ca.cookie)).json()).total,0);
    await a.close();
    a=await createAgentDashboardServer({access:createFileAgentAccess({directory:directoryA,allowProposals:true}),html,allowUserEdits:true,allowProposals:true});
    assert.equal((await read(a,'/api/dashboard',ca.cookie)).status,401,'reopened server rotates browser authorization');
    const reopened=await connect(a),again=await (await read(a,'/api/dashboard?month=2026-10',reopened.cookie)).json();
    assert.deepEqual(again.spending.userConfirmedPaidMinorByCurrency,{USD:2000});assert.equal(again.counts.events,1);assert.equal(again.counts.conflicts,1);
    assert.ok(!JSON.stringify(again).includes('SyntheticB'));
  }finally{await Promise.all([a.close(),b.close()]);await Promise.all([rm(directoryA,{recursive:true,force:true}),rm(directoryB,{recursive:true,force:true})]);}
});
