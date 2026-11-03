import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preserveReceiptVerification} from '../src/receipt-verification.mjs';
test('a later plaintext re-read retains document-verified financial fields without importing arbitrary properties',()=>{
  const prior={id:'same-event',messageId:'same-mail',payment:{minor:1725,currency:'USD'},evidence:'Invoice explicitly says USD.',evil:'no',receiptVerification:{checkedAt:'2026-10-01T00:00:00Z',fields:['payment','evidence','evil'],sources:[{page:1,quote:'USD'}]}};
  const incoming={id:'same-event',messageId:'same-mail',payment:{minor:1725,currency:null},sourceReadAt:'2026-10-02T00:00:00Z'};
  const result=preserveReceiptVerification(prior,incoming);
  assert.equal(result.payment.currency,'USD');assert.equal(result.sourceReadAt,incoming.sourceReadAt);assert.equal(result.evil,undefined);
  assert.equal(incoming.payment.currency,null);assert.notEqual(result.receiptVerification,prior.receiptVerification);
  assert.equal(preserveReceiptVerification(prior,{...incoming,messageId:'other-mail'}).payment.currency,null);
});

test('reviewed fields cannot cross explicit account or line-item identities',()=>{
  const prior={id:'fixture-event',messageId:'fixture-mail',accountRef:'account-one',lineItemRef:'line-one',payment:{minor:1000,currency:'USD'},receiptVerification:{checkedAt:'2026-10-01T00:00:00Z',fields:['payment']}};
  const incoming={...prior,payment:{minor:2000,currency:null}};delete incoming.receiptVerification;
  assert.equal(preserveReceiptVerification(prior,incoming).payment.currency,'USD');
  assert.equal(preserveReceiptVerification(prior,{...incoming,accountRef:'account-two'}).payment.currency,null);
  assert.equal(preserveReceiptVerification(prior,{...incoming,lineItemRef:'line-two'}).payment.currency,null);
});
