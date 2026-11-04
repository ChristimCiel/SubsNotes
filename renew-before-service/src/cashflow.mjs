// No platform imports: the web dashboard and local report use the same rules.
export function createCashflowRuntime() {
  const currencies = new Set(Intl.supportedValuesOf('currency'));
  const day = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const add = (totals, amount) => {
    const total = (totals[amount.currency] || 0) + amount.minor;
    if (!Number.isSafeInteger(total)) throw new Error('Recorded total exceeds the safe amount range');
    totals[amount.currency] = total;
  };
  function summarize(snapshot, { month = null, trustConnectorReads = false } = {}) {
    if (month !== null && !/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('Use a calendar month in YYYY-MM format');
    const totals = {}, refunds = {}, months = new Set(), excluded = [], included = [];
    const visit = (event, refund) => {
      const amount = refund ? event.refund : event.payment;
      const date = refund ? event.refundDay : event.paymentDay;
      const basis = refund ? event.refundDateBasis : event.paymentDateBasis;
      const trusted=event.authenticated===true||event.userVerified===true||(trustConnectorReads&&event.sourceFormat==='claude_plaintext'&&typeof event.sourceReadAt==='string'&&Number.isFinite(Date.parse(event.sourceReadAt)));
      const held=event.sourceProcessingConflict===true||event.candidateStatus==='needs_review'||event.importStatus==='needs_source_recheck';
      const recorded=event.kind===(refund?'refund_recorded':'payment_succeeded');
      if(trusted&&!held&&recorded&&day(date)&&basis==='explicit'){
        months.add(date.slice(0,7));
        if(month&&date.slice(0,7)!==month)return;
      }
      let reason = !trusted ? 'unverified_source'
        : held ? 'held_for_review'
        : !recorded ? refund ? 'refund_not_recorded' : 'payment_not_recorded'
        : event.conflict ? 'conflicting_amount'
        : !amount || !Number.isSafeInteger(amount.minor) || amount.minor < 0 ? 'amount_unknown'
        : !currencies.has(amount.currency) ? 'currency_unknown'
        : !day(date) || basis !== 'explicit' ? 'payment_date_unknown' : null;
      if (reason) { excluded.push({ id: event.id, serviceKey: event.serviceKey, refund, reason }); return; }
      add(refund ? refunds : totals, amount);
      included.push({ ...event, cashflowType: refund ? 'provider_refund' : 'receipt_payment' });
    };
    for (const event of snapshot.payments || []) visit(event, false);
    for (const event of snapshot.refunds || []) visit(event, true);
    // Annual charges stay in their payment month. Refunds remain separate:
    // provider-issued refunds are not independently verified bank deposits.
    return { month, paidMinorByCurrency: totals, providerRefundMinorByCurrency: refunds,
      months: [...months].sort().reverse(), included, excluded,
      basis: 'receipt_payment_date', bankReconciled: false,
      exhaustive: false, unallocatedCount: excluded.filter(x => x.reason === 'payment_date_unknown').length };
  }
  return { summarize };
}

export const summarizeCashflow = createCashflowRuntime().summarize;
