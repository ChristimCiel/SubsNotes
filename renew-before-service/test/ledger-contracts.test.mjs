import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLedgerContracts} from '../src/ledger-contracts.mjs';
import {digest,projectEvidence} from '../src/evidence.mjs';

const contracts=createLedgerContracts();
const event=()=>({id:'fixture-event',messageId:'fixture-mail',serviceKey:'fixture',service:'Fixture',kind:'payment_succeeded',receivedAt:'2026-09-01T00:00:00Z',payment:{minor:2000,currency:'USD'},paymentDay:'2026-09-01',paymentDateBasis:'explicit',authenticated:true});
const state=()=>({version:1,storageRevision:'fixture-revision',mailboxHash:digest('fictional-mailbox'),events:[event()]});

test('billing excerpts retain controlled amount, dates and state phrases without retaining personal email prefixes',()=>{
  const source='Hello Fictional Person,\nBilling address: 123 Fictional Street\nYour subscription has been canceled.\nAmount paid USD 20.00 Fictional Person 123 Fictional Street\nNext charge on Nov 2, 2026.\nContact reader@example.invalid or https://example.invalid/signed?token=secret.\nCard ending in 4242\nPersonal note: happy birthday 2026-09-01.';
  const excerpt=contracts.billingExcerpt(source);
  assert.match(excerpt,/subscription has been canceled/i);assert.match(excerpt,/USD 20\.00/);assert.match(excerpt,/Nov 2, 2026/);
  for(const privateText of ['Fictional Person','Fictional Street','reader@','4242','secret','2026-09-01'])assert.ok(!excerpt.includes(privateText));
  assert.equal(contracts.billingExcerpt('Dear Person, your secret unrelated message is here.'),'');
});

test('billing excerpts never retain arbitrary free-form text following a billing label',()=>{
  assert.equal(contracts.billingExcerpt('Amount paid USD 20.00 CustomerSecret ABC 123 ApartmentSeven'),'Amount paid · USD 20.00');
  assert.throws(()=>contracts.billingExcerpt('USD 10',{maxLength:1_000_000}),/limit/);
});

test('canonical ledgers preserve legacy missing revision while guarding schema, accounts, dates and identities',()=>{
  const legacy=state();delete legacy.storageRevision;
  assert.deepEqual(contracts.validateCanonicalState(legacy),legacy);
  assert.equal(contracts.revisionContract(legacy).persisted,false);
  assert.throws(()=>contracts.validateCanonicalState(legacy,{requireRevision:true}),/revision/);
  assert.throws(()=>contracts.validateCanonicalState(state(),{expectedMailboxHash:digest('other')}),/mailbox/);
  assert.throws(()=>contracts.validateCanonicalState({...state(),events:[event(),event()]}),/Duplicate/);
  assert.throws(()=>contracts.validateCanonicalState({...state(),events:[event(),{...event(),payment:{minor:999,currency:'USD'}}]}),/Conflicting/);
  assert.throws(()=>contracts.validateCanonicalState({...state(),events:[{...event(),paymentDay:'2026-02-30'}]}),/paymentDay/);
  assert.throws(()=>contracts.validateCanonicalState({...state(),events:[{...event(),payment:{minor:Number.MAX_SAFE_INTEGER+1,currency:'USD'}}]}),/payment/);
});

test('canonical JSON rejects prototype keys, classes, cycles and nonfinite data',()=>{
  for(const input of [JSON.parse('{"__proto__":{"polluted":true}}'),{constructor:'bad'},{value:NaN},{value:new Date()}])assert.throws(()=>contracts.canonicalJSON(input));
  const cycle={};cycle.self=cycle;assert.throws(()=>contracts.canonicalJSON(cycle));
  assert.equal(contracts.canonicalJSON({z:1,a:{b:2,a:3},missing:undefined}),'{"a":{"a":3,"b":2},"z":1}');
});

function proposal(){
  const observation={messageId:'fixture-source',mailboxHash:digest('fixture-mailbox'),receivedAt:'2026-09-01T00:00:00Z',observedAt:'2026-09-02T00:00:00Z',text:'Fixture subscription. Amount paid USD 20.00. Paid on Sep 1, 2026.'};
  const candidate={schemaVersion:1,messageId:observation.messageId,serviceKey:'fixture',service:'Fixture',kind:'payment_succeeded',payment:{minor:2000,currency:'USD'},paymentDay:'2026-09-01',fieldEvidence:{}};
  for(const field of ['serviceKey','service','kind','payment','paymentDay'])candidate.fieldEvidence[field]={quote:observation.text};
  return {observation,candidate};
}

test('candidate source binding requires exact observed text and rejects self-issued trust',()=>{
  const {observation,candidate}=proposal();
  const result=contracts.validateCandidate(candidate,{observation,expectedMailboxHash:observation.mailboxHash});
  assert.equal(result.authenticated,false);assert.equal(result.userVerified,false);assert.equal(result.candidateStatus,'needs_review');
  assert.equal(result.sourceReadAt,null);assert.equal(result.sourceFormat,'assistant_candidate');
  assert.equal(projectEvidence([result],{trustConnectorReads:true}).payments.length,0);
  assert.equal(projectEvidence([result],{trustConnectorReads:true}).heldEvidence.length,1);
  for(const key of ['authenticated','userVerified','receiptVerification','sourceFormat','sourceReadAt'])assert.throws(()=>contracts.validateCandidate({...candidate,[key]:true},{observation}),/authority/);
  const invented=structuredClone(candidate);invented.fieldEvidence.payment.quote='Amount paid USD 200.00';
  assert.throws(()=>contracts.validateCandidate(invented,{observation}),/observed source text/);
  assert.throws(()=>contracts.validateCandidate(candidate,{observation:{...observation,messageId:'other'}}),/observed message/);
  assert.throws(()=>contracts.validateCandidate(candidate,{observation,expectedMailboxHash:digest('other')}),/another mailbox/);
});

test('candidate source citations do not establish semantic correctness or attachment ownership',()=>{
  const {observation,candidate}=proposal();
  // A valid quote is not proof the model interpreted it correctly. Keep held.
  candidate.payment.minor=999999;
  const held=contracts.validateCandidate(candidate,{observation});
  assert.equal(held.candidateStatus,'needs_review');
  candidate.fieldEvidence.payment.attachmentId='not-observed';
  assert.throws(()=>contracts.validateCandidate(candidate,{observation:{...observation,attachmentId:'observed'}}),/attachment/);
});

test('portable export guards corruption and schema but does not attest financial source authenticity',async()=>{
  const before=state();before.events[0].receiptVerification={checkedAt:'2026-09-02T00:00:00Z',fields:['payment'],sources:[{quote:'USD 20'}]};
  const envelope=await contracts.createPortableExport(before,{hash:digest});
  const imported=await contracts.importPortableExport(envelope,{hash:digest,expectedMailboxHash:before.mailboxHash});
  assert.equal(imported.integrityVerified,true);assert.equal(imported.sourceAuthenticityVerified,false);assert.equal(imported.requiresSourceRecheck,true);
  assert.equal(imported.state.events[0].id,before.events[0].id);assert.equal(imported.state.events[0].authenticated,false);
  assert.equal(imported.state.events[0].receiptVerification,undefined);assert.ok(imported.state.events[0].importedReceiptVerification);
  assert.equal(imported.state.storageRevision,undefined);assert.equal(before.events[0].authenticated,true);
  assert.equal(projectEvidence(imported.state.events,{trustConnectorReads:true}).payments.length,0);
  const altered=structuredClone(envelope);altered.state.events[0].payment.minor=100;
  await assert.rejects(contracts.importPortableExport(altered,{hash:digest}),/integrity/);
  await assert.rejects(contracts.importPortableExport({...envelope,schemaVersion:2},{hash:digest}),/Unsupported/);
  await assert.rejects(contracts.importPortableExport(envelope,{hash:digest,expectedMailboxHash:digest('other')}),/mailbox/);
});
