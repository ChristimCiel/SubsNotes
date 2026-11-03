// An immutable email can be read again without discarding document-reviewed fields.
export function preserveReceiptVerification(previous, incoming) {
  const proof=previous?.receiptVerification;
  if(!proof||previous.messageId!==incoming.messageId||previous.id!==incoming.id||!Array.isArray(proof.fields)||!Number.isFinite(Date.parse(proof.checkedAt)))return incoming;
  for(const field of ['accountRef','lineItemRef','transactionRef','refundRef'])if(previous[field]!==incoming[field])return incoming;
  const allowed=new Set(['kind','payment','paymentDay','paymentDateBasis','refund','refundDay','refundDateBasis','reference','period','cadence','recurringRate','nextCharge','nextBilling','nextBillingAt','accessEnds','accessEndsAt','plan','service','category','evidence','currencyAmbiguous','invoiceAmount','invoiceDay','lineItemRef','transactionRef','refundRef']);
  const verified={};
  for(const field of proof.fields)if(allowed.has(field)&&Object.hasOwn(previous,field))verified[field]=structuredClone(previous[field]);
  return {...incoming,...verified,receiptVerification:structuredClone(proof)};
}
