import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {createLedgerContracts} from '../src/ledger-contracts.mjs';
import {createPaymentConfirmationRuntime} from '../src/payment-confirmations.mjs';
import {projectLedgerIdentities,withLedgerIdentityIndex} from '../src/ledger-identities.mjs';
const contracts=createLedgerContracts(),now='2026-11-18T00:00:00Z';
const event=(id,extra={})=>({id,messageId:'synthetic-'+id,serviceKey:'fictional',service:'Fictional Workspace',category:'Software',kind:'payment_succeeded',receivedAt:'2026-11-01T12:00:00Z',sourceFormat:'connector_plaintext',sourceReadAt:now,payment:{minor:1700,currency:'USD'},paymentDay:'2026-11-01',paymentDateBasis:'explicit',accountRef:'DEMO-A',subscriptionRef:'DEMO-CONTRACT',...extra});
test('portable bounded identifiers match SHA-256 for canonical ASCII, Unicode and long identities',()=>{
 for(const value of ['', '帳戶 😀 é','x'.repeat(5000),{z:'b',a:'a'},['a:b','a','b:c']]){const input=contracts.canonicalJSON(['subsnotes.identity.v1','vendor',value]);assert.equal(contracts.identityId('vendor',value),'vendor:'+createHash('sha256').update(input).digest('hex'));}
 const embedded=vm.runInNewContext(createPaymentConfirmationRuntime.toString()+';('+createLedgerContracts.toString()+')()');assert.equal(embedded.identityId('account',['DEMO','帳戶']),contracts.identityId('account',['DEMO','帳戶']));
});
test('five entity identities survive a copy roundtrip without changing events or user confirmations',()=>{
 const p=event('paid',{transactionRef:'DEMO-TXN'}),invoice=event('invoice',{kind:'invoice_recorded',payment:undefined,paymentDay:undefined,paymentDateBasis:undefined,transactionRef:'DEMO-TXN',invoiceAmount:{minor:1700,currency:'USD'},invoiceDay:'2026-11-01'});
 const state=createPaymentConfirmationRuntime().set({version:1,events:[p,invoice]},{eventId:p.id,precision:'day',date:'2026-11-01',amount:{minor:1700,currency:'USD'},expectedRevision:0},{now});
 const before=contracts.canonicalJSON(state),copy=withLedgerIdentityIndex(state),reopened=JSON.parse(JSON.stringify(copy)),index=projectLedgerIdentities(reopened);
 assert.equal(contracts.canonicalJSON(state),before);assert.deepEqual(copy.events,state.events);assert.deepEqual(copy.paymentConfirmations,state.paymentConfirmations);assert.deepEqual(index,copy.identityIndex);
 assert.equal(index.vendors.length,1);assert.equal(index.accounts.length,1);assert.equal(index.subscriptionInstances.length,1);assert.equal(index.financialTransactions.length,1);assert.equal(index.supportingDocuments.length,2);assert.equal(index.financialTransactions[0].documentIds.length,2);
});
test('an invoice with no payment evidence creates a document but no financial transaction',()=>{
 const index=projectLedgerIdentities({events:[event('invoice',{kind:'invoice_recorded',payment:undefined,paymentDay:undefined,invoiceAmount:{minor:1700,currency:'USD'},invoiceDay:'2026-11-01'})]});assert.equal(index.financialTransactions.length,0);assert.equal(index.supportingDocuments.length,1);
});
test('legacy unknown identities remain unknown and a line item is explicitly marked as legacy scope',()=>{
 const index=projectLedgerIdentities({events:[event('unknown',{accountRef:undefined,subscriptionRef:undefined}),event('legacy',{subscriptionRef:undefined,lineItemRef:'LEGACY-LINE'})]});
 const unknown=index.eventLinks.find(x=>x.eventId==='unknown');assert.equal(unknown.accountId,null);assert.equal(unknown.subscriptionInstanceId,null);assert.ok(unknown.legacyReasons.includes('subscription_identity_unknown'));assert.equal(index.subscriptionInstances[0].legacy,true);assert.equal(index.subscriptionInstances[0].identityBasis,'legacy_line_item');
});
test('equal amounts in different months and different accounts remain separate transactions',()=>{
 const index=projectLedgerIdentities({events:[event('oct',{paymentDay:'2026-10-01',transactionRef:'OCT'}),event('nov',{transactionRef:'NOV'}),event('other',{accountRef:'DEMO-B',transactionRef:'NOV'})]});assert.equal(index.financialTransactions.length,3);assert.equal(index.accounts.length,2);
});
test('one original PDF can support multiple separate transactions',()=>{
 const source={attachmentId:'synthetic.pdf',sha256:'b'.repeat(64),page:1,parserVersion:'synthetic-v1'};
 const index=projectLedgerIdentities({events:[event('a',{transactionRef:'DEMO-A',sourceDocument:source}),event('b',{messageId:'synthetic-a',transactionRef:'DEMO-B',sourceDocument:source})]});assert.equal(index.financialTransactions.length,2);assert.equal(index.supportingDocuments.length,1);assert.equal(index.supportingDocuments[0].transactionIds.length,2);
});
test('new candidate identifiers retain legacy saved candidates through exact source matching',async()=>{
 const {createAssistantHandoffRuntime}=await import('../src/assistant-handoff.mjs'),runtime=createAssistantHandoffRuntime(),quote='Fictional Workspace Amount paid USD 17.00 Paid November 1, 2026';
 const candidate={schemaVersion:1,messageId:'synthetic-legacy',serviceKey:'fictional',service:'Fictional Workspace',kind:'payment_succeeded',payment:{minor:1700,currency:'USD'},paymentDay:'2026-11-01',paymentDateBasis:'explicit',fieldEvidence:{}};
 for(const key of Object.keys(candidate))if(!['schemaVersion','messageId','fieldEvidence'].includes(key))candidate.fieldEvidence[key]={quote};
 const observation={messageId:candidate.messageId,receivedAt:now,observedAt:now,text:quote},old={...contracts.validateCandidate(candidate,{observation}),id:'candidate:synthetic-legacy:payment_succeeded:'},state={version:1,storageRevision:'r1',events:[old]},request=runtime.createRequest({requestId:'synthetic-replay',ledgerRevision:'r1'});
 const result={schemaVersion:1,kind:'subsnotes.assistant-scan-result',requestId:request.requestId,ledgerRevision:'r1',records:[{candidate,observation}],coverage:{queriesComplete:false,attachmentsComplete:false,mailboxExhaustive:false}},merged=runtime.prepareMerge({state,request,result,ownerBinding:'a'.repeat(64),observedAt:now});assert.equal(merged.addedCount,0);assert.equal(merged.duplicateCount,1);assert.equal(merged.state.events[0].id,old.id);
});
test('explicit contract identity cannot erase a more specific line-item boundary',()=>{
 const a=event('line-a',{lineItemRef:'A'}),b=event('line-b',{lineItemRef:'B'}),index=projectLedgerIdentities({events:[a,b]});assert.equal(index.subscriptionInstances.length,2);assert.notEqual(contracts.serviceScope(a),contracts.serviceScope(b));
});
test('an old confirmed candidate retains its ID and confirmation when replayed with the new identity algorithm',async()=>{
 const {createAssistantHandoffRuntime}=await import('../src/assistant-handoff.mjs'),runtime=createAssistantHandoffRuntime(),quote='Fictional Workspace Invoice amount USD 17.00 Invoice date November 1, 2026';
 const candidate={schemaVersion:1,messageId:'synthetic-old-confirmed',accountRef:'DEMO-A',serviceKey:'fictional',service:'Fictional Workspace',kind:'invoice_recorded',invoiceAmount:{minor:1700,currency:'USD'},invoiceDay:'2026-11-01',fieldEvidence:{}};
 for(const k of Object.keys(candidate))if(!['schemaVersion','messageId','fieldEvidence'].includes(k))candidate.fieldEvidence[k]={quote};
 const observation={messageId:candidate.messageId,receivedAt:now,observedAt:now,text:quote},old={...contracts.validateCandidate(candidate,{observation}),id:'candidate:synthetic-old-confirmed:invoice_recorded:'};
 const state=createPaymentConfirmationRuntime().set({version:1,storageRevision:'r1',events:[old]},{eventId:old.id,precision:'month',month:'2026-11',amount:{minor:1900,currency:'EUR'},expectedRevision:0},{now}),before=contracts.canonicalJSON(state.paymentConfirmations),request=runtime.createRequest({requestId:'old-confirmed-replay',ledgerRevision:'r1'});
 const result={schemaVersion:1,kind:'subsnotes.assistant-scan-result',requestId:request.requestId,ledgerRevision:'r1',records:[{candidate,observation}],coverage:{queriesComplete:false,attachmentsComplete:false,mailboxExhaustive:false}},next=runtime.prepareMerge({state,request,result,ownerBinding:'a'.repeat(64),observedAt:now}).state;
 assert.equal(next.events.length,1);assert.equal(next.events[0].id,old.id);assert.equal(contracts.canonicalJSON(next.paymentConfirmations),before);
});
test('the same invoice reference in different accounts within one email is not one logical document',()=>{
 const a=event('a',{messageId:'synthetic-shared',kind:'invoice_recorded',payment:undefined,paymentDay:undefined,reference:'INV-SAME',invoiceAmount:{minor:1700,currency:'USD'},invoiceDay:'2026-11-01'}),b={...a,id:'b',accountRef:'DEMO-B'};
 const index=projectLedgerIdentities({events:[a,b]});assert.equal(index.accounts.length,2);assert.equal(index.supportingDocuments.length,2);
});
