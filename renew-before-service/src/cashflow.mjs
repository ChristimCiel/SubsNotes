import { createPaymentConfirmationRuntime } from './payment-confirmations.mjs';
// No platform imports: the web dashboard and local report use the same rules.
export function createCashflowRuntime() {
  const confirmations = createPaymentConfirmationRuntime();
  const currencies = new Set(Intl.supportedValuesOf('currency'));
  const day = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const add = (totals, amount) => {
    const total = (totals[amount.currency] || 0) + amount.minor;
    if (!Number.isSafeInteger(total)) throw new Error('Recorded total exceeds the safe amount range');
    totals[amount.currency] = total;
  };
  function summarize(snapshot, { month = null, trustConnectorReads = false, paymentConfirmations = snapshot.paymentConfirmations ?? {}, confirmationEventIds = null } = {}) {
    if (month !== null && !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('Use a calendar month in YYYY-MM format');
    if(confirmationEventIds!==null&&(!Array.isArray(confirmationEventIds)||confirmationEventIds.some(id=>typeof id!=='string')))throw new Error('Use source event identities for scoped confirmations');
    const scopedConfirmations=confirmationEventIds===null?paymentConfirmations:Object.fromEntries(Object.entries(paymentConfirmations).filter(([id])=>confirmationEventIds.includes(id)));
    const manual=confirmations.resolve(snapshot,scopedConfirmations),superseded=new Set(manual.supersededIds);
    const totals = {}, sourceTotals = {}, userTotals = {}, refunds = {}, months = new Set(), excluded = [], included = [], confirmedPayments = [];
    const visit = (event, refund) => {
      if(!refund&&(superseded.has(event.id)||(event.duplicateEvidenceIds||[]).some(id=>superseded.has(id))))return;
      const amount = refund ? event.refund : event.payment;
      const date = refund ? event.refundDay : event.paymentDay;
      const basis = refund ? event.refundDateBasis : event.paymentDateBasis;
      const trusted=event.authenticated===true||event.userVerified===true||(trustConnectorReads&&event.sourceFormat==='claude_plaintext'&&typeof event.sourceReadAt==='string'&&Number.isFinite(Date.parse(event.sourceReadAt)));
      const held=event.sourceProcessingConflict===true||event.candidateStatus==='needs_review'||event.importStatus==='needs_source_recheck';
      const recorded=event.kind===(refund?'refund_recorded':'payment_succeeded');
      let reason = !trusted ? 'unverified_source'
        : held ? 'held_for_review'
        : !recorded ? refund ? 'refund_not_recorded' : 'payment_not_recorded'
        : event.conflict ? 'conflicting_amount'
        : !amount || !Number.isSafeInteger(amount.minor) || amount.minor < 0 ? 'amount_unknown'
        : !currencies.has(amount.currency) ? 'currency_unknown'
        : !day(date) || basis !== 'explicit' ? 'payment_date_unknown' : null;
      if (!refund && !reason) confirmedPayments.push(event);
      if(trusted&&!held&&recorded&&day(date)&&basis==='explicit'){
        months.add(date.slice(0,7));
        if(month&&date.slice(0,7)!==month)return;
      }
      if (reason) { excluded.push({ id: event.id, serviceKey: event.serviceKey, refund, reason }); return; }
      add(refund ? refunds : totals, amount);
      if(!refund)add(sourceTotals,amount);
      included.push({ ...event, cashflowType: refund ? 'provider_refund' : 'receipt_payment' });
    };
    for (const event of snapshot.payments || []) visit(event, false);
    for (const event of snapshot.refunds || []) visit(event, true);
    for(const row of manual.rows){
      confirmedPayments.push(row);months.add(row.paymentMonth);
      if(month&&row.paymentMonth!==month)continue;
      if(row.subscriptionClassification!=='subscription'){
        excluded.push({id:row.id,serviceKey:row.serviceKey,refund:false,reason:row.subscriptionClassification==='non_subscription'?'not_subscription':'subscription_classification_unverified'});
        continue;
      }
      add(totals,row.payment);add(userTotals,row.payment);included.push(row);
    }
    // Match an invoice to a dated receipt by identity, never amount/date alone.
    // Use receipts across all months: a later payment does not leave an older
    // invoice pending merely because a different month is selected.
    const matched = invoice => !invoice.conflict && confirmedPayments.some(payment =>
      invoice.serviceKey === payment.serviceKey
      && ['accountRef','lineItemRef'].every(key => (invoice[key] ?? null) === (payment[key] ?? null))
      && ['reference','transactionRef'].every(key => !invoice[key] || !payment[key] || invoice[key] === payment[key])
      && (invoice.transactionRef && invoice.transactionRef === payment.transactionRef
        || invoice.reference && invoice.reference === payment.reference
        || invoice.messageId && invoice.messageId === payment.messageId)
      && Number.isSafeInteger(invoice.invoiceAmount?.minor)
      && invoice.invoiceAmount.minor === payment.payment.minor
      && invoice.invoiceAmount.currency === payment.payment.currency);
    const invoiceNotifications = (snapshot.unclassifiedPurchases || []).filter(event => event.kind === 'unclassified_purchase'
      && event.sourceRequiresDocumentReview && (event.sourceFact === 'invoice_notification'
        || event.providerKey === 'openai' && event.issuerDomain === 'tax.openai.com'));
    const pendingInvoices = [...new Map([...(snapshot.invoices || []),...invoiceNotifications].map(event=>[event.id,event])).values()].filter(invoice => !superseded.has(invoice.id)&&!(invoice.duplicateEvidenceIds||[]).some(id=>superseded.has(id))&&!matched(invoice))
      .map(invoice => ({...invoice, cashflowType:'unverified_invoice', reviewReason:invoice.conflict ? 'conflicting_amount'
        : !Number.isSafeInteger(invoice.invoiceAmount?.minor) ? 'amount_unknown'
        : !currencies.has(invoice.invoiceAmount?.currency) ? 'currency_unknown' : 'payment_unverified'}));
    // Annual charges stay in their payment month. Refunds remain separate:
    // provider-issued refunds are not independently verified bank deposits.
    return { month, paidMinorByCurrency: totals, providerRefundMinorByCurrency: refunds,
      sourcePaidMinorByCurrency:sourceTotals,userConfirmedPaidMinorByCurrency:userTotals,
      userConfirmedCount:included.filter(row=>row.cashflowType==='user_confirmed_payment').length,
      monthPrecisionPaymentCount:included.filter(row=>row.cashflowType==='user_confirmed_payment'&&row.paymentDatePrecision==='month').length,
      confirmationConflicts:manual.conflicts,
      months: [...months].sort().reverse(), included, excluded, pendingInvoices,
      basis: manual.rows.length?'recorded_payment_period':'receipt_payment_date', bankReconciled: false,
      exhaustive: false, unallocatedCount: excluded.filter(x => x.reason === 'payment_date_unknown').length };
  }
  return { summarize };
}

export const summarizeCashflow = createCashflowRuntime().summarize;
