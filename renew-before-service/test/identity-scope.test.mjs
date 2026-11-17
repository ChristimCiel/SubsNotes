import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFileAgentAccess,importObservedSources} from '../src/agent-file-store.mjs';
import {createEvidenceRuntime} from '../src/evidence-runtime.mjs';
import {renderReport} from '../src/report.mjs';
const now='2026-11-18T00:00:00Z',mailboxHash='a'.repeat(64);
async function store(t){const directory=await mkdtemp(join(tmpdir(),'subsnotes-identity-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,api:createFileAgentAccess({directory,allowProposals:true})};}
function proposed(account,reference){const text=`Fictional Workspace\nAccount ${account}\nInvoice ${reference}\nInvoice amount USD 17.00\nInvoice date November 1, 2026`,candidate={schemaVersion:1,messageId:'synthetic-shared-email',serviceKey:'fictional-workspace',service:'Fictional Workspace',kind:'invoice_recorded',accountRef:account,reference,invoiceAmount:{minor:1700,currency:'USD'},invoiceDay:'2026-11-01',fieldEvidence:{}};for(const k of Object.keys(candidate))if(!['schemaVersion','messageId','fieldEvidence'].includes(k))candidate.fieldEvidence[k]={quote:text};return {candidate,observation:{messageId:candidate.messageId,receivedAt:'2026-11-01T12:00:00Z',observedAt:now,text}};}
for(const [label,records]of [['two accounts',[proposed('DEMO-A','INV-A'),proposed('DEMO-B','INV-B')]],['two invoices in one account',[proposed('DEMO-A','INV-A'),proposed('DEMO-A','INV-B')]]])test(`one email preserves ${label} across save, reopen and replay`,async t=>{
 const {directory,api}=await store(t),{request}=await api.invoke('prepareScan');
 const envelope=r=>({schemaVersion:1,kind:'subsnotes.assistant-scan-result',requestId:r.requestId,ledgerRevision:r.ledgerRevision,records,coverage:{queriesComplete:false,attachmentsComplete:false,mailboxExhaustive:false}});
 const saved=await api.invoke('submitScanResult',envelope(request));assert.equal(saved.addedCount,2);
 const reopened=createFileAgentAccess({directory,allowProposals:true}),d=await reopened.invoke('dashboard');assert.equal(d.counts.events,2);assert.deepEqual(d.spending.recordedPaidMinorByCurrency,{});
 const next=await reopened.invoke('prepareScan');assert.equal((await reopened.invoke('submitScanResult',envelope(next.request))).addedCount,0);assert.equal((await reopened.invoke('dashboard')).counts.events,2);
});
const event=(id,extra={})=>({id,messageId:'synthetic-'+id,serviceKey:'fictional-workspace',service:'Fictional Workspace',category:'Software',kind:'payment_succeeded',receivedAt:'2026-11-01T12:00:00Z',sourceFormat:'connector_plaintext',sourceReadAt:now,payment:{minor:1700,currency:'USD'},paymentDay:'2026-11-01',paymentDateBasis:'explicit',accountRef:'DEMO-A',...extra});
test('a cancellation in one explicit line does not cancel another paid line in the native view or report',async t=>{
 const {directory,api}=await store(t);await api.userAction('preferences',{language:'en'});
 const events=[event('paid-a',{lineItemRef:'CONTRACT-A',plan:'Plan A',period:{start:'2026-11-01',end:'2026-12-01'}}),event('cancel-b',{lineItemRef:'CONTRACT-B',plan:'Plan B',kind:'renewal_disabled',receivedAt:'2026-11-03T00:00:00Z',payment:undefined,paymentDay:undefined,paymentDateBasis:undefined,accessEnds:'2026-11-30'})];
 const messages=events.map(e=>({id:e.messageId,mailboxHash,receivedAt:e.receivedAt,sourceFormat:e.sourceFormat,sourceReadAt:e.sourceReadAt,text:'Fictional Workspace\n'+e.plan+'\nAmount paid USD 17.00'}));
 await importObservedSources({directory,expectedRevision:(await api.invoke('dashboard')).ledgerRevision,mailboxHash,messages,extract:m=>events.filter(e=>e.messageId===m.id)});
 const reopened=createFileAgentAccess({directory}),all=await reopened.invoke('listSubscriptions');
 assert.equal(all.items.length,2);assert.equal(all.items.find(s=>s.plan==='Plan A').statusCode,'confirmed_active');assert.equal(all.items.find(s=>s.plan==='Plan B').statusCode,'confirmed_canceled');
 const month=await reopened.invoke('dashboard',{month:'2026-11'});assert.equal(month.services.total,1);assert.equal(month.services.items[0].plan,'Plan A');assert.deepEqual(month.spending.recordedPaidMinorByCurrency,{USD:1700});
 const snapshot=createEvidenceRuntime(x=>x).projectEvidence(events,{asOf:now,trustConnectorReads:true});assert.equal(snapshot.subscriptions.length,2);assert.equal(snapshot.subscriptions.find(s=>s.lineItemRef==='CONTRACT-B').plan,'Plan B');const html=renderReport(snapshot,events);assert.ok(html.includes('Plan A'));assert.ok(html.includes('Plan B'));
});
test('long encoded account scopes remain reachable through the authenticated evidence endpoint',async t=>{
 const {directory,api}=await store(t),record=proposed('帳'.repeat(80),'INV-A'),{request}=await api.invoke('prepareScan');
 await api.invoke('submitScanResult',{schemaVersion:1,kind:'subsnotes.assistant-scan-result',requestId:request.requestId,ledgerRevision:request.ledgerRevision,records:[record],coverage:{queriesComplete:false,attachmentsComplete:false,mailboxExhaustive:false}});
 const key=(await api.invoke('listSubscriptions')).items[0].serviceKey;assert.ok(key.length>300);
 const {createAgentDashboardServer}=await import('../src/agent-dashboard-server.mjs'),app=await createAgentDashboardServer({access:createFileAgentAccess({directory}),html:'<!doctype html><main>synthetic</main>'});t.after(()=>app.close());const url=new URL(app.url);
 const login=await fetch(url.origin+'/api/session',{method:'POST',headers:{Origin:url.origin,'Content-Type':'application/json','X-SubsNotes-Request':'1'},body:JSON.stringify({token:new URLSearchParams(url.hash.slice(1)).get('token')})});assert.equal(login.status,200);
 const response=await fetch(url.origin+'/api/evidence?serviceKey='+encodeURIComponent(key),{headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}});assert.equal(response.status,200);assert.equal((await response.json()).total,1);
});
