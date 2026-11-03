import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEvidence, projectEvidence, parseDay, money, htmlToText } from '../src/evidence.mjs';
// Synthetic receipt scenarios; never paste personal receipts into test fixtures.
const asOf = '2026-11-02T10:00:00Z';
const message = (id, sender, subject, text, receivedAt = '2026-10-05T10:00:00Z') => ({ id, sender, subject, text, receivedAt, authenticatedSenderDomain: sender.split('@')[1] });
const claude = (id, subject, text, day) => message(id, 'billing@mail.anthropic.com', subject, text, day + 'T10:00:00Z');

test('a dated Substack payment receipt establishes its amount and full paid period without using delivery time',()=>{
  const [event]=extractEvidence(message('fictional-newsletter','billing@substack.com',"Your payment receipt from Lenny's Newsletter #EXAMPLE-8",'Subscription for reader@example.invalid Jan 8, 2026 through Jan 8, 2027 $231.40 USD. This is your receipt for invoice #EXAMPLE-8 on Jan 8, 2026.','2026-01-09T00:00:00Z'));
  assert.equal(event.kind,'payment_succeeded');assert.equal(event.payment.minor,23140);assert.equal(event.payment.currency,'USD');
  assert.equal(event.paymentDay,'2026-01-08');assert.equal(event.period.end,'2027-01-08');assert.equal(event.cadence,'annual');
});

test('a multiyear prepaid period with a generic yearly-renewal footer is not an annual billing cadence',()=>{
  const [event]=extractEvidence(message('fictional-long-plan','billing@surfshark.com','Subscription receipt','Paid January 8, 2026. Jan 8, 2026–May 8, 2028 Amount paid USD 47.90\nRenewal can be monthly or yearly depending on subscription type.'));
  assert.equal(event.cadence,null);assert.equal(event.period.end,'2028-05-08');
});

test('a reviewed provider invoice can show an amount without creating a payment or clearing a payment problem',()=>{
  const issue=extractEvidence(message('fictional-failure','billing@youtube.com','Payment failed','Your payment failed.'))[0];
  const invoice={...issue,id:'fictional-invoice',messageId:'fictional-invoice-mail',receivedAt:'2026-10-06T00:00:00Z',kind:'invoice_recorded',invoiceAmount:{minor:32100,currency:'TWD'},invoiceDay:'2026-10-06'};
  const s=projectEvidence([issue,invoice],{asOf});assert.equal(s.payments.length,0);assert.equal(s.subscriptions[0].lastInvoice.minor,32100);assert.equal(s.subscriptions[0].status,'payment_problem');
});

test('Adobe bundles do not silently become Stock and an explicit Creative Cloud cancellation has its own identity',()=>{
  const [cc]=extractEvidence(message('fictional-adobe-cc','billing@adobe.com','Cancellation confirmed','ADOBE CREATIVE CLOUD. Your subscription was canceled. Creative Cloud Pro.'));
  assert.equal(cc.serviceKey,'adobe-creative-cloud');
  const bundled=extractEvidence(message('fictional-adobe-bundle','billing@adobe.com','Your receipt','Adobe Stock and Creative Cloud Pro. Amount paid TWD 1729.00'));
  assert.ok(bundled.every(e=>e.serviceKey!=='adobe-stock'&&e.serviceKey!=='adobe-creative-cloud'));
});

test('an explicit charge timestamp is retained for local display and a cancellation clears it',()=>{
  const sub={id:'fictional-time',messageId:'fictional-time-mail',serviceKey:'fictional',service:'Fictional',category:'Software',authenticated:true,receivedAt:'2026-10-01T00:00:00Z',kind:'subscription_confirmed',nextBilling:'2027-02-03',nextBillingAt:'2027-02-03T18:30:00Z'};
  assert.equal(projectEvidence([sub],{asOf}).subscriptions[0].nextBillingAt,sub.nextBillingAt);
  const canceled={...sub,id:'fictional-off',receivedAt:'2026-10-02T00:00:00Z',kind:'renewal_disabled',accessEnds:'2027-02-03'};
  assert.equal(projectEvidence([sub,canceled],{asOf}).subscriptions[0].nextBillingAt,null);
});

test('exact minor units, ISO currencies and calendar validation', () => {
  assert.deepEqual(money('NT$4,321.50'), { minor: 432150, currency: 'TWD', source: 'NT$4,321.50' });
  assert.equal(money('$10.36').currency, null);
  assert.equal(money('EUR 0.00').minor, 0);
  assert.equal(money('JPY 1500').minor, 1500);
  assert.equal(money('JPY 1500.20'), null);
  assert.equal(money('KRW 1500').minor, 1500);
  assert.equal(money('KWD 12.345').minor, 12345);
  assert.equal(money('EUR 12,99'), null);
  assert.equal(money('EUR 1.234,56'), null);
  assert.equal(money('EUR 1.234,56', null, 'de-DE').minor, 123456);
  assert.equal(parseDay('11th April 2027'), '2027-04-11');
  assert.equal(parseDay('2026-02-30'), null);
});

test('receipt paid amount differs from full price and a credit-adjusted charge', () => {
  const [e] = extractEvidence(claude('upgrade', 'Your receipt from Anthropic',
    'Receipt number ABC-123 Invoice number BILL-2 Oct 4–Nov 4, 2026 Max plan - 20x Qty 1 NT$4,500.00 Unused time on Max plan - 5x -NT$2,126.90 VAT NT$118.65 Amount paid NT$2,491.75', '2026-10-05'));
  assert.equal(e.payment.minor, 249175); assert.equal(e.recurringRate.minor, 450000);
  assert.equal(e.hasAdjustments, true); assert.equal(e.period.end, '2026-11-04');
});

test('latest cancellation wins over an earlier receipt; paid access remains', () => {
  const events = [
    ...extractEvidence(claude('confirm', 'Your Max subscription is confirmed', 'The next charge will be on Oct 28, 2026.', '2026-09-28')),
    ...extractEvidence(claude('receipt', 'Your receipt from Anthropic', 'Oct 4–Nov 4, 2026 Max plan - 20x Qty 1 TWD 4500 Amount paid TWD 2491.75', '2026-10-05')),
    ...extractEvidence(claude('cancel', 'Your Claude Max subscription was canceled', 'Your subscription to Claude Max has been successfully canceled. Your access to Claude Max will expire on Nov 5, 2026.', '2026-10-07'))
  ];
  const result = projectEvidence(events.reverse(), { asOf });
  assert.equal(result.subscriptions[0].renewal, 'off'); assert.equal(result.subscriptions[0].access, 'available');
  assert.equal(result.subscriptions[0].accessEnds, '2026-11-05'); assert.equal(result.subscriptions[0].nextBilling, null);
  assert.equal(result.recordedPaidMinorByCurrency.TWD, 249175);
});

test('an explicit restart reopens renewal; a later receipt alone does not', () => {
  const cancel = extractEvidence(claude('cancel', 'Your Claude Max subscription was canceled', 'Your access will expire on Oct 28, 2026.', '2026-10-01'));
  const receipt = extractEvidence(claude('paid', 'Your receipt from Anthropic', 'Oct 4–Nov 4, 2026 Claude Pro Qty 1 USD 20 Amount paid USD 10', '2026-10-05'));
  assert.equal(projectEvidence([...cancel, ...receipt], { asOf }).subscriptions[0].renewal, 'off');
  const restart = extractEvidence(claude('restart', 'Your Max subscription is confirmed', 'The next charge will be on Dec 1, 2026.', '2026-11-01'));
  assert.equal(projectEvidence([...cancel, ...receipt, ...restart], { asOf }).subscriptions[0].status, 'active');
});

test('annual receipts include both years and do not require a recent 90-day receipt', () => {
  const e = extractEvidence(message('annual', 'billing@stripe.com', 'Your receipt from X #123',
    'Mar 23, 2026–Mar 23, 2027 X Premium Plus Qty 1 NT$8,340.00 Amount paid NT$8,340.00'));
  const view = projectEvidence(e, { asOf });
  assert.equal(view.subscriptions[0].cadence, 'annual'); assert.equal(view.subscriptions[0].status, 'paid_access');
  assert.equal(view.subscriptions[0].accessEnds, '2027-03-23'); assert.equal(view.oneTimePurchases.length, 0);
});

test('Paddle confirmed renewal price includes currency and annual date', () => {
  const e = extractEvidence(message('paddle', 'help@paddle.com', 'Your subscription to Vibe Tech Co., Ltd',
    '逐字飽 pro_yearly NT$4,321.50 Amount every year Payment method NT$4,321.50 Your subscription will renew at NT$4,321.50 on Feb 1, 2027 6:38 pm UTC'));
  const view = projectEvidence(e, { asOf });
  assert.equal(view.subscriptions[0].nextCharge.currency, 'TWD');
  assert.equal(view.subscriptions[0].nextCharge.minor, 432150); assert.equal(view.subscriptions[0].nextBilling, '2027-02-01');
});

test('trial/promo confirmation records the cancellation deadline without inventing a charge date', () => {
  const e = extractEvidence(message('paddle-n8n', 'help@paddle.com', 'Welcome to Cloud Start Yearly',
    'Thank you for signing up for your Cloud Start Yearly subscription. n8n Promo Price €0.00 Price €288.00/year Your subscription will renew at €288.00 unless you cancel by 11th April 2027.'));
  const view = projectEvidence(e, { asOf });
  assert.equal(view.subscriptions[0].status, 'active'); assert.equal(view.subscriptions[0].nextBilling, null);
  assert.equal(view.subscriptions[0].cancelBy, '2027-04-11'); assert.equal(view.subscriptions[0].nextCharge.minor, 28800);
  assert.equal(view.payments.length, 0);
});

test('delivery and airfare do not become recurring costs; top-ups are not double counted', () => {
  const events = [
    ...extractEvidence(message('delivery', 'no-reply@lalamove.com', '您的Lalamove送貨收據', '您的配送收據 總價 (TWD) NT$318')),
    ...extractEvidence(message('topup', 'no-reply@lalamove.com', '2026年9月17日的儲值收據', 'NT$500')),
    ...extractEvidence(message('air', 'no-reply@ecommerce.evaair.com', '長榮航空網路購票訊息-EXAMPLE', 'Airfare receipt')),
    ...extractEvidence(message('miles', 'eservice@mh1.evaair.com', '長榮會員個人哩程核對表', 'Membership mileage'))
  ];
  const view = projectEvidence(events, { asOf });
  assert.equal(view.subscriptions.length, 0); assert.equal(view.oneTimePurchases.length, 3);
  assert.equal(view.oneTimePurchases[0].kind, 'one_time_purchase'); assert.deepEqual(view.recordedPaidMinorByCurrency, {});
});

test('unknown receipts remain unclassified rather than being called one-time purchases', () => {
  const e = extractEvidence(message('unknown', 'billing@merchant.example', 'Your receipt from Example', 'Amount paid USD 10'));
  assert.equal(e[0].kind, 'unclassified_purchase');
});

test('one-time delivery and top-up amounts retain fractional minor units',()=>{
  const delivery=extractEvidence(message('synthetic-fractional-delivery','billing@lalamove.com','送貨收據','您的配送收據 總價 (TWD) NT$412.75'))[0];
  const topup=extractEvidence(message('synthetic-fractional-topup','billing@lalamove.com','儲值收據','總付款金額 NT$20.55'))[0];
  assert.equal(delivery.payment.minor,41275);assert.equal(topup.payment.minor,2055);
  assert.deepEqual(projectEvidence([delivery,topup],{asOf}).recordedPaidMinorByCurrency,{});
});

test('bare dollar symbols never inherit USD, and a late payment cannot silently close a failure notice', () => {
  const events = [
    ...extractEvidence(message('failed', 'no-reply@youtube.com', 'Your payment failed', 'Payment failed')),
    ...extractEvidence(message('later', 'no-reply@youtube.com', 'Your receipt from YouTube', 'Oct 3–Nov 3, 2026 Subscription Amount paid $10.00', '2026-10-06T00:00:00Z'))
  ];
  const view = projectEvidence(events, { asOf });
  assert.equal(view.subscriptions[0].status, 'payment_problem'); assert.equal(view.unconfirmedCurrencyPayments, 1);
  assert.deepEqual(view.recordedPaidMinorByCurrency, {});
});

test('duplicate receipts count once; conflicting copies are held outside totals', () => {
  const a = extractEvidence(claude('receipt-a', 'Your receipt from Anthropic', 'Invoice number FIXTURE-1 Oct 3–Nov 3, 2026 Claude Pro Amount paid USD 20', '2026-10-03'));
  const b = extractEvidence(claude('receipt-b', 'Your receipt from Anthropic', 'Invoice number FIXTURE-1 Oct 3–Nov 3, 2026 Claude Pro Amount paid USD 20.00', '2026-10-04'));
  assert.equal(projectEvidence([...a, ...b], { asOf }).recordedPaidMinorByCurrency.USD, 2000);
  const conflicting = extractEvidence(claude('receipt-c', 'Your receipt from Anthropic', 'Invoice number FIXTURE-1 Oct 3–Nov 3, 2026 Claude Pro Amount paid USD 200', '2026-10-05'));
  assert.deepEqual(projectEvidence([...a, ...b, ...conflicting], { asOf }).recordedPaidMinorByCurrency, {});
});

test('unverified sources do not silently become confirmed subscriptions or payments', () => {
  const m = claude('untrusted', 'Your Max subscription is confirmed', 'The next charge will be on Dec 1, 2026.', '2026-10-01');
  m.authenticatedSenderDomain = null;
  const view = projectEvidence(extractEvidence(m), { asOf });
  assert.equal(view.subscriptions.length, 0); assert.equal(view.heldEvidence.length, 1);
});

test('lookalike sender domains and internal customer notifications cannot create plans', () => {
  assert.deepEqual(extractEvidence(message('spoof', 'billing@evil-cloudflare.com', '30 Day Domain Renewal Notice', 'expires Nov 6, 2026')), []);
  assert.deepEqual(extractEvidence(message('internal', 'non-reply@auth.merchant.example', '有人點擊訂閱按鈕', 'Subscription clicked')), []);
});

test('auto-renew enabled is never parsed as disabled', () => {
  const e = extractEvidence(message('domain-on', 'noreply@notify.cloudflare.com', 'Domain example.com Auto Renewal Updated', 'Auto renewal for your domain, example.com, has been enabled.'));
  assert.equal(projectEvidence(e, { asOf }).subscriptions[0].renewal, 'on');
});

test('HTML-only cancellation and passed dates remain visible without fabricated cycles', () => {
  const m = claude('html', 'Your Claude Max subscription was canceled', '', '2026-10-07');
  m.html = '<p>Your access to Claude Max will expire on <b>Nov 5, 2026</b>.</p>';
  assert.equal(projectEvidence(extractEvidence(m), { asOf }).subscriptions[0].accessEnds, '2026-11-05');
  assert.equal(htmlToText('<script>ignore()</script><div>A &amp; B</div>'), 'A & B');
});

test('Traditional Chinese Google Play trial is active evidence without assumed currency or a paid charge', () => {
  const events = extractEvidence(message('google-trial', 'googleplay-noreply@google.com', '您的 Google Play 訂單收據', '你已在 Google Play 申請試用的訂閱方案。試用期將於\n2027年4月22日結束。如未取消訂閱，系統會收取目前費\n用：每月 $650.00 的費用。Google AI Pro (5 TB) 總計: $0.00 自動續訂'));
  const view = projectEvidence(events, { asOf });
  assert.equal(view.subscriptions[0].status, 'active');
  assert.equal(view.subscriptions[0].trialEnds, '2027-04-22');
  assert.equal(view.subscriptions[0].nextCharge.minor, 65000);
  assert.equal(view.subscriptions[0].nextCharge.currency, null);
  assert.equal(view.payments.length, 0);
});

test('renewal notices keep their original date, even when stale', () => {
  const e = extractEvidence(message('replit', 'billing@stripe.com', 'Your Replit subscription will renew soon', 'Your subscription will renew soon This is a friendly reminder that your Replit subscription for Replit Core will automatically renew on April 16, 2026.'));
  const view = projectEvidence(e, { asOf });
  assert.equal(view.subscriptions[0].nextBilling, '2026-04-16');
  assert.equal(view.subscriptions[0].status, 'needs_verification');
});

test('booking copies consolidate while distinct bookings remain separate', () => {
  const events = ['air-a','air-b'].flatMap(id => extractEvidence(message(id, 'billing@evaair.com', '長榮航空網路購票訊息-ABC123', 'Booking')));
  assert.equal(projectEvidence(events, { asOf }).oneTimePurchases.length, 1);
});

test('unknown processor merchants are retained without creating a confirmed plan', () => {
  const e = extractEvidence(message('unknown-stripe', 'billing@stripe.com', 'Your receipt from Fictional Shop #123', 'Amount paid USD 25'));
  const v = projectEvidence(e, { asOf });
  assert.equal(v.subscriptions.length, 0); assert.equal(v.unclassifiedPurchases.length, 1);
});

test('refund receipts cannot create a second charge or an active annual period', () => {
  const e = extractEvidence(message('refund', 'billing@stripe.com', 'Your refund from Cursor #123', 'Refund from Cursor $192.00 Refunded on April 6, 2026 Invoice number EXAMPLE-2 Apr 4, 2026–Apr 4, 2027 Cursor Pro Amount paid $192.00 Total refunded without credit note $192.00'));
  const v = projectEvidence(e, { asOf });
  assert.equal(v.payments.length, 0); assert.equal(v.refunds[0].refund.minor, 19200);
  assert.equal(v.refunds[0].kind, 'refund_recorded'); assert.notEqual(v.subscriptions[0].status, 'paid_access');
});

test('provider support can approve a refund and explicitly cancel in one reply', () => {
  const e = extractEvidence(message('support', 'hi@cursor.com', 'Re: Refund and cancellation request', 'Your refund request is now approved. The refund of $192 should appear in 5-10 days. Your subscription has also been cancelled, so you will not be charged.\nOn Sat, Apr 4, 2026, User wrote:\n> My old subscription is confirmed.'));
  const v = projectEvidence(e, { asOf });
  assert.equal(v.subscriptions[0].renewal, 'off'); assert.equal(v.refunds[0].kind, 'refund_pending');
});

test('a processed refund makes older paid-through access uncertain', () => {
  const events = [
    ...extractEvidence(message('off', 'no-reply@surfshark.com', 'Subscription auto-renewal is turned off', 'Your automatic renewal is off. You will still have access to Surfshark until2028-10-25.', '2026-06-25T10:00:00Z')),
    ...extractEvidence(message('refunded', 'no-reply@surfshark.com', 'Your refund was processed successfully', 'We have processed your refund. Total refunded $193.46', '2026-06-26T10:00:00Z'))
  ];
  const v = projectEvidence(events, { asOf });
  assert.equal(v.subscriptions[0].renewal, 'off'); assert.equal(v.subscriptions[0].accessEnds, '2028-10-25');
  assert.equal(v.subscriptions[0].access, 'unknown');
});

test('a corrected mistaken notice does not remain a canceled subscription', () => {
  const events = extractEvidence(message('correction', 'sub1@cw.com.tw', '關於誤收的取消自動續訂通知', '您目前並未訂閱我們的服務，無成立任何訂閱訂單。'));
  const v = projectEvidence(events, { asOf });
  assert.equal(v.subscriptions.length, 0); assert.equal(v.excludedServices[0].status, 'not_subscribed');
});

test('Traditional Chinese Adobe cancellation decodes date entities', () => {
  const v = projectEvidence(extractEvidence(message('adobe-off', 'message@adobe.com', '您的訂閱將結束', '我們已經處理您的取消要求。您的 Adobe Stock 訂閱將於 2025&#24180;09&#26376;29&#26085; (PT)結束。')), { asOf });
  assert.equal(v.subscriptions[0].renewal, 'off'); assert.equal(v.subscriptions[0].accessEnds, '2025-09-29');
});

test('Mint explicit auto-renew setting takes priority over marketing renewal buttons', () => {
  const v = projectEvidence(extractEvidence(message('mint-off', 'noreply@email.mintmobile.com', 'Your Mint Plan Renewal Date is Here in 5 days', 'Renew Now! RENEWAL DATE: 08/15/26 AUTO RENEWAL: Not Active')), { asOf });
  assert.equal(v.subscriptions[0].renewal, 'off'); assert.equal(v.subscriptions[0].accessEnds, '2026-08-15');
});

test('refund emails for a newsletter remain financial evidence', () => {
  const v = projectEvidence(extractEvidence(message('lenny-refund', 'lenny@substack.com', "Refund for Lenny's Newsletter", 'Original Payment Amount $200 Total Refunded $5.30')), { asOf });
  assert.equal(v.refunds[0].refund.minor, 530); assert.equal(v.payments.length, 0);
});

test('OpenAI tax invoices cannot silently reactivate ChatGPT or count as payments', () => {
  const canceled = extractEvidence(message('chatgpt-off', 'noreply@tm.openai.com', 'ChatGPT - Your plan will not renew', 'Your plan will not renew and will be canceled, but is still available until the end of your billing period on September 18, 2026.', '2026-09-18T00:00:00Z'));
  const invoice = extractEvidence(message('tax', 'noreply@tax.openai.com', 'Your eGUI EXAMPLE123 from OpenAI', 'An invoice has been prepared for your purchase. Download a PDF version.', '2026-11-01T00:00:00Z'));
  const v = projectEvidence([...canceled,...invoice], { asOf });
  assert.equal(v.subscriptions[0].renewal, 'off'); assert.equal(v.subscriptions[0].accessEnds, '2026-09-18');
  assert.equal(v.subscriptions[0].status, 'needs_verification'); assert.equal(v.subscriptions[0].relatedEvidenceIds.length, 1);
  assert.equal(v.unclassifiedPurchases.length, 1); assert.equal(v.payments.length, 0);
});

test('ChatGPT plan confirmation records the stated rate without inventing a paid charge', () => {
  const v = projectEvidence(extractEvidence(message('chatgpt-new', 'noreply@tm.openai.com', 'ChatGPT - 你的新方案', '你已成功訂閱 ChatGPT Plus。你的訂閱方案將自動續訂：monthly.。總計：NT$690.00')), { asOf });
  assert.equal(v.subscriptions[0].cadence, 'monthly'); assert.equal(v.subscriptions[0].recurringRate.minor, 69000);
  assert.equal(v.payments.length, 0);
});


test('a domain-less Cloudflare invoice notification cannot create a phantom subscription',()=>{
  const events=extractEvidence(message('fictional-domain-tax-notice','noreply@notify.cloudflare.com','eGUI Issuance Notification','An electronic invoice has been issued.'));
  assert.equal(events[0].kind,'unclassified_purchase');const s=projectEvidence(events,{asOf});assert.equal(s.subscriptions.length,0);assert.equal(s.payments.length,0);assert.equal(s.unclassifiedPurchases.length,1);
});
