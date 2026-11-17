// An immutable email can be read again without discarding document-reviewed fields.
export function preserveReceiptVerification(previous, incoming) {
  const proof=previous?.receiptVerification;
  if(!proof||previous.messageId!==incoming.messageId||previous.id!==incoming.id||!Array.isArray(proof.fields)||!Number.isFinite(Date.parse(proof.checkedAt)))return incoming;
  for(const field of ['accountRef','subscriptionRef','lineItemRef','transactionRef','refundRef'])if(incoming[field]!=null&&(previous[field]??null)!==incoming[field])return incoming;
  // A host-reviewed replacement document requires an explicit reason. A
  // body-only reread cannot replace the reviewed PDF or its payment-date role.
  if(incoming.receiptVerification?.changeReason?.trim()&&Number.isFinite(Date.parse(incoming.receiptVerification.checkedAt))
    &&Date.parse(incoming.receiptVerification.checkedAt)>Date.parse(proof.checkedAt)&&Array.isArray(incoming.receiptVerification.sources)&&incoming.receiptVerification.sources.some(s=>s.sha256&&s.quote))return incoming;
  const allowed=new Set(['kind','payment','paymentDay','paymentDateBasis','refund','refundDay','refundDateBasis','reference','period','cadence','recurringRate','nextCharge','nextBilling','nextBillingAt','accessEnds','accessEndsAt','plan','serviceKey','service','category','evidence','currencyAmbiguous','invoiceAmount','invoiceDay','lineItemRef','transactionRef','refundRef','renewal','explicitOff','sourceDocument','fieldEvidence']);
  const verified={};
  for(const field of proof.fields)if(allowed.has(field)&&Object.hasOwn(previous,field))verified[field]=structuredClone(previous[field]);
  for(const field of ['accountRef','subscriptionRef','lineItemRef','transactionRef','refundRef'])if(previous[field]!=null&&incoming[field]==null)verified[field]=previous[field];
  for(const field of ['sourceFormat','sourceReadAt','authenticated'])if(incoming[field]==null&&previous[field]!=null)verified[field]=previous[field];
  for(const [date,basis]of [['paymentDay','paymentDateBasis'],['refundDay','refundDateBasis']])if(proof.fields.includes(date)&&previous[date]&&previous[basis]==='explicit')verified[basis]='explicit';
  const excerpts={...incoming.fieldEvidence};for(const field of proof.fields)if(previous.fieldEvidence?.[field])excerpts[field]=structuredClone(previous.fieldEvidence[field]);
  if(Object.keys(excerpts).length&&!verified.fieldEvidence)verified.fieldEvidence=excerpts;
  // Older document reviews did not list their summary as a reviewed field.
  // A link-only reread must not erase it; a nonempty new summary is still used.
  if(previous.kind==='invoice_recorded'&&proof.fields.includes('kind')&&typeof previous.evidence==='string'&&previous.evidence.trim()&&!(typeof incoming.evidence==='string'&&incoming.evidence.trim()))verified.evidence=previous.evidence;
  return {...incoming,...verified,receiptVerification:structuredClone(proof)};
}
