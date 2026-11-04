// An immutable email can be read again without discarding document-reviewed fields.
export function preserveReceiptVerification(previous, incoming) {
  const proof=previous?.receiptVerification;
  if(!proof||previous.messageId!==incoming.messageId||previous.id!==incoming.id||!Array.isArray(proof.fields)||!Number.isFinite(Date.parse(proof.checkedAt)))return incoming;
  for(const field of ['accountRef','lineItemRef','transactionRef','refundRef'])if(previous[field]!==incoming[field])return incoming;
  const allowed=new Set(['kind','payment','paymentDay','paymentDateBasis','refund','refundDay','refundDateBasis','reference','period','cadence','recurringRate','nextCharge','nextBilling','nextBillingAt','accessEnds','accessEndsAt','plan','serviceKey','service','category','evidence','currencyAmbiguous','invoiceAmount','invoiceDay','lineItemRef','transactionRef','refundRef','renewal','explicitOff']);
  const verified={};
  for(const field of proof.fields)if(allowed.has(field)&&Object.hasOwn(previous,field))verified[field]=structuredClone(previous[field]);
  // Older document reviews did not list their summary as a reviewed field.
  // A link-only reread must not erase it; a nonempty new summary is still used.
  if(previous.kind==='invoice_recorded'&&proof.fields.includes('kind')&&typeof previous.evidence==='string'&&previous.evidence.trim()&&!(typeof incoming.evidence==='string'&&incoming.evidence.trim()))verified.evidence=previous.evidence;
  return {...incoming,...verified,receiptVerification:structuredClone(proof)};
}
