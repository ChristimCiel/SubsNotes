import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEvidence, projectEvidence } from '../src/evidence.mjs';
import { extractWebEvidence } from '../src/web-evidence.mjs';
import { createLedgerContracts } from '../src/ledger-contracts.mjs';

// Fictional account notices: no personal source records or identifiers.
const msg = (id, sender, subject, text) => ({id:'synthetic-context-'+id,sender,subject,text,
  receivedAt:'2027-06-18T09:00:00Z',authenticatedSenderDomain:sender.split('@')[1]});
const project = events => projectEvidence(events,{asOf:'2027-06-20T00:00:00Z'});

test('a Kimi paused-membership notice records expiry without deriving a date or paid charge',()=>{
  const [event]=extractEvidence(msg('expired','notice@membership.kimi.ai','Check your membership',
    'Your Kimi membership has expired. Your membership benefits remain paused. Renew within 8 days.'));
  assert.equal(event.kind,'access_expired');assert.equal(event.serviceKey,'kimi');assert.equal(event.accessEnds,null);
  assert.equal(project([event]).subscriptions[0].status,'expired');assert.equal(project([event]).payments.length,0);
  assert.equal(extractEvidence(msg('lookalike','notice@kimi.ai.attacker.invalid','Check your membership',
    'Your Kimi membership has expired. Your membership benefits remain paused.')).length,0);
});

test('a Google YouTube invoice remains a document task rather than a paid subscription receipt',()=>{
  const [pending]=extractEvidence(msg('youtube-document','billing@google.com','YouTube invoice available',
    'YouTube: the invoice is attached. Please review the original document.'));
  assert.equal(pending.kind,'invoice_recorded');assert.equal(pending.serviceKey,'youtube-premium');
  assert.equal(pending.invoiceAmount,null);assert.equal(pending.invoiceDay,null);assert.equal(pending.sourceRequiresDocumentReview,true);
  assert.equal(pending.service,'YouTube');assert.equal(pending.productUnconfirmed,true);
  assert.equal(project([pending]).payments.length,0);assert.equal(project([pending]).subscriptions[0].status,'needs_verification');
  const [invoice]=extractEvidence(msg('youtube-fields','billing@google.com','YouTube invoice available',
    'YouTube. Invoice amount: EUR 18.73. Invoice date: 2027-06-17.'));
  assert.deepEqual(invoice.invoiceAmount,{minor:1873,currency:'EUR',source:'EUR 18.73'});
  assert.equal(invoice.invoiceDay,'2027-06-17');assert.equal(invoice.sourceRequiresDocumentReview,true);
  assert.equal(project([invoice]).payments.length,0);
  const [paid]=extractEvidence(msg('youtube-paid','billing@google.com','YouTube invoice and receipt',
    'YouTube membership. Amount paid EUR 18.73. Paid June 16, 2027.'));
  assert.equal(paid.kind,'payment_succeeded');assert.equal(paid.paymentDay,'2027-06-16');
  assert.equal(extractEvidence(msg('other-google','billing@google.com','Invoice available','Another Google product invoice.')).some(e=>e.serviceKey==='youtube-premium'),false);
});

test('a Gumlet update retains plan and cadence without manufacturing renewal or payment',()=>{
  const [event]=extractEvidence(msg('plan-update','billing@gumlet.com','Your plan details',
    'Your Gumlet subscription was successfully updated.\nProduct: Fictional Creator\nBilling Cycle: Yearly'));
  assert.equal(event.kind,'renewal_notice');assert.equal(event.plan,'Fictional Creator');assert.equal(event.cadence,'annual');
  assert.equal(event.sourceFact,'plan_updated');assert.equal(event.renewal,'unknown');assert.equal(event.period,undefined);
  const s=project([event]);assert.equal(s.payments.length,0);assert.equal(s.subscriptions[0].plan,'Fictional Creator');
  assert.equal(s.subscriptions[0].status,'needs_verification');
});

test('a free-to-paid renewal intention never guesses a year or overrides recorded cancellation',()=>{
  const [notice]=extractEvidence(msg('promotional-renewal','notice@magicpatterns.com','Your promotional plan information',
    'Your free year of Magic Patterns will end on July 12. Your plan is set to renew as a paid subscription for $31/month. You still have one week to try it for free.'));
  assert.equal(notice.kind,'renewal_notice');assert.equal(notice.sourceFact,'free_to_paid_renewal');
  assert.equal(notice.nextCharge.minor,3100);assert.equal(notice.nextCharge.currency,null);assert.equal(notice.nextBilling,null);
  assert.equal(notice.dateRequiresReview,true);assert.equal(notice.renewal,'unknown');assert.equal(project([notice]).payments.length,0);
  const [off]=extractEvidence({...msg('promotional-off','notice@magicpatterns.com','Your subscription was canceled','Your subscription was canceled.'),receivedAt:'2027-06-15T00:00:00Z'});
  assert.equal(project([off,notice]).subscriptions[0].renewal,'off');
  const [contradiction]=extractEvidence(msg('promotional-date-conflict','notice@magicpatterns.com','Your promotional plan information',
    'Your free year of Magic Patterns will end on June 18, 2027. Your plan is set to renew as a paid subscription for $31/month. You still have 1 week to try it for free.'));
  assert.equal(contradiction.nextBilling,null);assert.equal(contradiction.dateRequiresReview,true);
});

test('both recipient-oriented Stripe failure phrases survive while merchant notifications remain excluded',()=>{
  for(const phrase of ['We attempted to charge your card','We were unable to charge your card']){
    const [event]=extractEvidence(msg('failure-'+phrase,'notice@stripe.com','Payment was unsuccessful',
      phrase+' for your Magic Patterns subscription. Please update your payment method.'));
    assert.equal(event.kind,'payment_failed');assert.equal(event.serviceKey,'magic-patterns');assert.equal(event.payment,undefined);
  }
  assert.deepEqual(extractEvidence(msg('merchant','notice@stripe.com','Payment was unsuccessful',
    'Your customer failed to pay. We were unable to charge your card for your Magic Patterns subscription.')),[]);
});

test('a Deepstash activation proves a source-time membership statement without turning on renewal',()=>{
  const [event]=extractEvidence(msg('activation','notice@deepstash.com','Account information',
    'Welcome to Deepstash Pro. Your subscription is now\nactive. Enjoy premium access.'));
  assert.equal(event.sourceFact,'subscription_active');assert.equal(event.kind,'subscription_confirmed');
  assert.equal(event.renewal,'unknown');assert.equal(event.nextBilling,undefined);assert.equal(event.period,undefined);
  const s=project([event]);assert.equal(s.payments.length,0);assert.equal(s.subscriptions[0].renewal,'unknown');
  assert.equal(s.subscriptions[0].status,'needs_verification');
  const [offer]=extractEvidence(msg('old-offer','notice@deepstash.com','Try another offer','We offer a discount on a future subscription.'));
  assert.equal(offer,undefined);
});

test('a later account-plan rename cannot reactivate renewal or prove payment after cancellation',()=>{
  const [off]=extractEvidence({...msg('prior-off','billing@anthropic.com','Your subscription was canceled','Your subscription was canceled.'),receivedAt:'2027-06-10T09:00:00Z'});
  const [rename]=extractEvidence(msg('rename','notice@anthropic.com','Account plan update',
    'Starting today, your Fictional Plus plan is called Fictional Advanced. Your price and billing date stay the same.'));
  assert.equal(rename.sourceFact,'plan_renamed');assert.equal(rename.previousPlan,'Fictional Plus');assert.equal(rename.plan,'Fictional Advanced');
  const s=project([off,rename]);assert.equal(s.subscriptions[0].renewal,'off');assert.equal(s.subscriptions[0].status,'needs_verification');
  assert.equal(s.subscriptions[0].plan,'Fictional Advanced');assert.equal(s.payments.length,0);
  assert.ok(s.subscriptions[0].warnings.some(x=>x.includes('account-plan evidence')));
});

test('introductory membership terms keep price, relative timing and uncertain currency separate from actual spending',()=>{
  const [event]=extractEvidence(msg('intro','notice@personalityhub.ai','Your introductory membership',
    'Total: $3.27. Your subscription begins immediately and automatically renews after 9 days, providing recurring service priced at $31.40 billed every month.'));
  assert.equal(event.kind,'subscription_confirmed');assert.equal(event.sourceFact,'intro_membership_terms');
  assert.equal(event.introductoryAmount.minor,327);assert.equal(event.introductoryAmount.currency,null);
  assert.equal(event.recurringRate.minor,3140);assert.equal(event.recurringRate.currency,null);
  assert.equal(event.relativeRenewalDays,9);assert.equal(event.nextBilling,null);assert.equal(event.cadence,'monthly');
  assert.equal(event.payment,undefined);assert.equal(event.paymentDay,undefined);assert.equal(project([event]).payments.length,0);
  const [explicit]=extractEvidence(msg('intro-iso','notice@personalityhub.ai','Your introductory membership',
    'Currency: CAD. Total: $3.27. Your subscription begins immediately and automatically renews after 9 days, providing recurring service priced at $31.40 billed every month.'));
  assert.equal(explicit.recurringRate.currency,'CAD');
});

test('Figma education reminders preserve relative warnings without inventing dates or paid subscription costs',()=>{
  const [event]=extractEvidence(msg('education','notice@figma.com','Your Education plan expires in 3 weeks',
    'Your Figma for Education verification will expire soon. The Education teams you own will become view-only for all members.'));
  assert.equal(event.kind,'access_expiring');assert.equal(event.sourceFact,'education_expiry');assert.equal(event.relativeDaysRemaining,21);
  assert.equal(event.accessType,'education');assert.equal(event.accessEnds,null);assert.equal(event.payment,undefined);
  assert.equal(project([event]).payments.length,0);
});

test('a Wispr future-invoice reward cannot create a payment, an access period or an immediate trial',()=>{
  const [event]=extractEvidence(msg('credit','notice@updates.wispr.ai','Account reward ready',
    'You earned a free month of Pro as a reward. Your credit will automatically apply to your next invoice!'));
  assert.equal(event.kind,'renewal_notice');assert.equal(event.serviceKey,'wispr-flow');assert.equal(event.sourceFact,'future_credit');
  assert.equal(event.creditTiming,'next_invoice');assert.equal(event.period,undefined);assert.equal(event.accessEnds,undefined);
  assert.equal(event.payment,undefined);assert.equal(project([event]).subscriptions[0].renewal,'unknown');
  assert.equal(project([event]).payments.length,0);
});

test('explicit provider corrections and cancellation take priority over quoted introductory or activation claims',()=>{
  const [off]=extractEvidence(msg('intro-canceled','notice@personalityhub.ai','Your subscription was canceled',
    'Your subscription was canceled. Previous terms: Your subscription begins immediately and automatically renews after 9 days, providing recurring service priced at $31.40 billed every month.'));
  assert.equal(off.kind,'renewal_disabled');
  const [none]=extractEvidence(msg('correction','notice@deepstash.com','Account correction',
    '目前並未訂閱。 Earlier message: Welcome to Deepstash Pro. Your subscription is now active.'));
  assert.equal(none.kind,'account_not_subscribed');
});

test('new context notices validate in the existing ledger and produce identical Node and Web Crypto events',async()=>{
  const inputs=[msg('web-kimi','notice@kimi.ai','Membership information','Your Kimi membership has expired. Your membership benefits remain paused.'),
    msg('web-doc','billing@google.com','YouTube invoice available','YouTube invoice attached.'),
    msg('web-plan','billing@gumlet.com','Account information','Your Gumlet subscription was successfully updated.\nProduct: Fictional Studio\nBilling Cycle: Monthly'),
    msg('web-credit','notice@wispr.ai','Reward ready','You earned a free month of Pro. Your credit will automatically apply to your next invoice!')];
  for(const input of inputs){const events=extractEvidence(input);assert.deepEqual(await extractWebEvidence(input),events);createLedgerContracts().validateCanonicalState({version:1,events});}
});

test('an ezPay HTML invoice keeps explicit document fields in Other without claiming a recurring charge',async()=>{
  const input={...msg('platform-invoice','notice@ezpay.com.tw','電子發票開立通知',''),html:
    '<p>Fictional Merchant 使用電子發票平台</p><p>發 票 號 碼： ZZ12345678</p><p>發票金額： $ 83.75 TWD</p><p>開立日期：2027-06-17 11:42:00</p>'};
  const [event]=extractEvidence(input);assert.equal(event.kind,'invoice_recorded');assert.equal(event.category,'Unclassified');
  assert.equal(event.serviceKey,'ezpay:unknown-merchant');assert.equal(event.sourceFact,'unknown_merchant_invoice');
  assert.equal(event.invoiceAmount.minor,8375);assert.equal(event.invoiceAmount.currency,'TWD');assert.equal(event.invoiceDay,'2027-06-17');
  assert.equal(event.reference,'ZZ12345678');assert.equal(event.sourceRequiresDocumentReview,true);assert.equal(event.payment,undefined);
  const s=project([event]);assert.equal(s.subscriptions.length,0);assert.equal(s.payments.length,0);assert.equal(s.unclassifiedPurchases.length,1);
  assert.equal(s.unclassifiedPurchases[0].invoiceDay,'2027-06-17');assert.deepEqual(await extractWebEvidence(input),[event]);
});

test('unknown-currency and placeholder invoices never gain a payment date or a merchant subscription identity',()=>{
  const [amount]=extractEvidence(msg('platform-unknown','notice@ezpay.com.tw','Invoice notification','Invoice amount: $83.75. Invoice date: 2027-06-17.'));
  assert.equal(amount.invoiceAmount.currency,null);assert.equal(amount.currencyAmbiguous,true);assert.equal(amount.paymentDay,undefined);
  const [pending]=extractEvidence(msg('platform-placeholder','notice@ezpay.com.tw','電子發票開立通知','Your browser does not support HTML'));
  assert.equal(pending.invoiceAmount,null);assert.equal(pending.invoiceDay,null);assert.equal(pending.sourceRequiresDocumentReview,true);
  assert.equal(extractEvidence(msg('platform-marketing','notice@ezpay.com.tw','Product news','See our latest software.')).length,0);
  const other=extractEvidence(msg('platform-lookalike','notice@ezpay.com.tw.attacker.invalid','Invoice notification','Invoice amount: TWD 83.75.'));
  assert.ok(other.every(e=>e.serviceKey!=='ezpay:unknown-merchant'));assert.equal(project(other).payments.length,0);
});
