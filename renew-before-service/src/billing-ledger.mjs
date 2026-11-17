import {createLedgerContracts} from './ledger-contracts.mjs';
const contracts=createLedgerContracts();
// A read-only transaction view of saved evidence. Notices are not payments;
// invoices are not paid receipts. Source verification and user confirmation
// remain distinct; projection never grants authority to assistant proposals.
export function sourceVerification(event){
  if(!['payment_succeeded','refund_recorded','invoice_recorded'].includes(event.kind))return 'needs_review';
  const trusted=event.authenticated===true||(['connector_plaintext','claude_plaintext'].includes(event.sourceFormat)&&Number.isFinite(Date.parse(event.sourceReadAt)));
  if(!trusted||event.sourceProcessingConflict||event.candidateStatus==='needs_review'||event.importStatus==='needs_source_recheck'||event.conflict)return 'needs_review';
  const amount=event[event.kind==='invoice_recorded'?'invoiceAmount':event.kind==='refund_recorded'?'refund':'payment'];
  const date=event[event.kind==='invoice_recorded'?'invoiceDay':event.kind==='refund_recorded'?'refundDay':'paymentDay'];
  const basis=event.kind==='invoice_recorded'||event[event.kind==='refund_recorded'?'refundDateBasis':'paymentDateBasis']==='explicit';
  if(!Number.isSafeInteger(amount?.minor)||amount.minor<0||!Intl.supportedValuesOf('currency').includes(amount.currency))return 'needs_review';
  if(!date||!/^20\d{2}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||!basis)return 'source_partial';
  return event.kind==='invoice_recorded'?'source_verified_invoice':'source_verified';
}
export function resolvedSourceService(state,event){
  if(state.paymentConfirmations?.[event.id]?.active||!['openai-unclassified','openai-unknown-product','cloudflare-domains'].includes(event.serviceKey))return event.serviceKey;
  const keys=[...new Set((state.events||[]).filter(e=>e.messageId===event.messageId&&e.candidateStatus!=='needs_review'&&e.importStatus!=='needs_source_recheck'&&!e.sourceProcessingConflict
    &&['connector_plaintext','claude_plaintext'].includes(e.sourceFormat)&&Number.isFinite(Date.parse(e.sourceReadAt))&&!['openai-unclassified','openai-unknown-product','cloudflare-domains'].includes(e.serviceKey)).map(e=>e.serviceKey))];
  return keys.length===1?keys[0]:event.serviceKey;
}
export function projectBillingRecords(state,{view='payments',month=null}={}){
  const fields={payment_succeeded:['payment','paymentDay','paymentDateBasis'],refund_recorded:['refund','refundDay','refundDateBasis'],invoice_recorded:['invoiceAmount','invoiceDay',null]};
  const rows=[];
  for(const event of state.events||[]){
    if(!Object.hasOwn(fields,event.kind))continue;
    const [amountField,dateField,basisField]=fields[event.kind],confirmation=state.paymentConfirmations?.[event.id];
    const confirmed=confirmation?.active===true;
    const resolved=resolvedSourceService(state,event);
    const matchedPayments=(state.events||[]).filter(p=>p.kind==='payment_succeeded'&&sourceVerification(p)==='source_verified'&&p.serviceKey===resolved
      &&['accountRef','subscriptionRef','lineItemRef'].every(k=>(event[k]??null)===(p[k]??null))
      &&['reference','transactionRef'].every(k=>k==='reference'&&event.transactionRef&&event.transactionRef===p.transactionRef||!event[k]||!p[k]||event[k]===p[k])
      &&(event.transactionRef&&event.transactionRef===p.transactionRef||event.reference&&event.reference===p.reference||event.messageId===p.messageId));
    // A receipt re-read can correct an AI-only invoice classification. An
    // original invoice and all user confirmations remain their own records.
    if(!confirmed&&event.kind==='invoice_recorded'&&event.candidateStatus==='needs_review'&&matchedPayments.length===1
      &&(!event.invoiceAmount||event.invoiceAmount.minor===matchedPayments[0].payment.minor&&(!event.invoiceAmount.currency||event.invoiceAmount.currency===matchedPayments[0].payment.currency)))continue;
    if(view==='payments'?event.kind==='invoice_recorded'&&!confirmed:event.kind!=='invoice_recorded'||confirmed)continue;
    const alternatives=!confirmed&&event.kind==='invoice_recorded'?(state.assistantReview||[]).filter(r=>r.existingEventIds?.includes(event.id)&&r.candidate?.kind==='invoice_recorded'&&r.candidate.invoiceAmount).map(r=>r.candidate):[];
    const distinct=new Set(alternatives.map(c=>JSON.stringify([c.invoiceAmount,c.reference||null,c.plan||null])));
    // New invoice evidence remains an alternative proposal. Showing it never
    // replaces the original record or turns an invoice into a paid receipt.
    const proposal=!event.invoiceAmount&&distinct.size===1?alternatives[0]:null;
    const date=confirmed?(confirmation.precision==='day'?confirmation.date:null):(!basisField||event[basisField]==='explicit'?event[dateField]||null:null);
    const paymentMonth=confirmed&&confirmation.precision==='month'?confirmation.month:date?.slice(0,7)||null;
    if(month&&paymentMonth!==month)continue;
    const amount=confirmed?confirmation.amount:event[amountField]||proposal?.invoiceAmount||null;
    const quote=(proposal||event).fieldEvidence?.[amountField]?.excerpt||'';
    const dateQuote=(proposal||event).fieldEvidence?.[dateField]?.excerpt||'';
    const tokens=quote.replace(/\*\*/g,'').match(/(?:NT\$|US\$|CA\$|AU\$|[$€£])\s*\d[\d,.]*/g)||[];
    const rawToken=amount?.source,unmarked=typeof rawToken==='string'&&/^\d[\d,.]*$/.test(rawToken)&&quote.includes(rawToken)?rawToken:null;
    const linked=(state.events||[]).find(e=>e.messageId===event.messageId&&e.serviceKey===resolved&&e.id!==event.id);
    rows.push({eventId:event.id,messageId:event.messageId,serviceKey:contracts.serviceScope({...event,serviceKey:resolved},{separator:'::'}),name:resolved!==event.serviceKey?linked?.service||event.service:event.service,
      accountRef:event.accountRef||null,plan:event.plan||proposal?.plan||null,reference:event.reference||proposal?.reference||null,kind:confirmed?'payment_succeeded':event.kind,sourceKind:event.kind,amount,date,paymentMonth,
      alternativeEvidence:Boolean(proposal),conflictingAlternatives:distinct.size>1,
      // With unknown currency, show the source token rather than guessing a
      // currency exponent from the stored minor-unit field.
      sourceAmountText:!amount?.currency?(tokens.length===1?tokens[0]:tokens.length===0?unmarked:null):null,
      rawDateText:!date?(dateQuote.match(/\b\d{1,2}\/\d{1,2}\/(?:20\d{2}|\d{2})\b/)||[])[0]||null:null,
      confirmed,verification:confirmed?'user_confirmed':sourceVerification(event),
      matchedReceipt:event.kind==='invoice_recorded'&&matchedPayments.length===1?{eventId:matchedPayments[0].id,amount:matchedPayments[0].payment,date:matchedPayments[0].paymentDay,
        amountDifferenceMinor:amount?.currency===matchedPayments[0].payment.currency?amount.minor-matchedPayments[0].payment.minor:null}:null,
      receivedAt:event.receivedAt,sourceUrl:'https://mail.google.com/mail/u/0/#all/'+encodeURIComponent(event.messageId),
      amountEvidence:quote,dateEvidence:dateQuote,
      sourceDetailsIncomplete:!(proposal||event).evidence||!quote});
  }
  // A re-read of the same single transaction can supersede an empty proposal
  // in this view. Preserve every stored record, account, line item and refund.
  const visible=rows.filter(row=>{
    if(!row.confirmed&&row.kind!=='refund_recorded'&&rows.some(other=>other.confirmed&&other.messageId===row.messageId&&other.serviceKey===row.serviceKey&&other.accountRef===row.accountRef)){
      const original=state.events.find(e=>e.id===row.eventId);
      const confirmed=rows.filter(other=>other.confirmed&&other.messageId===row.messageId&&other.serviceKey===row.serviceKey&&other.accountRef===row.accountRef);
      if(confirmed.length===1){const protectedSource=state.events.find(e=>e.id===confirmed[0].eventId);if(['lineItemRef'].every(k=>(original?.[k]??null)===(protectedSource?.[k]??null))&&['reference','transactionRef'].every(k=>!original?.[k]||!protectedSource?.[k]||original[k]===protectedSource[k]))return false;}
    }
    const source=state.events.find(e=>e.id===row.eventId);
    const originalRead=source&&['connector_plaintext','claude_plaintext'].includes(source.sourceFormat)&&Number.isFinite(Date.parse(source.sourceReadAt))&&!source.candidateStatus&&!source.importStatus&&!source.sourceProcessingConflict;
    if(row.confirmed||row.verification!=='needs_review'||originalRead)return true;
    const matches=rows.filter(other=>{
      const e=state.events.find(e=>e.id===other.eventId);
      const observed=e&&['connector_plaintext','claude_plaintext'].includes(e.sourceFormat)&&Number.isFinite(Date.parse(e.sourceReadAt))&&!e.candidateStatus&&!e.importStatus&&!e.sourceProcessingConflict&&Boolean(other.amountEvidence||other.dateEvidence);
      return other!==row&&other.messageId===row.messageId&&other.kind===row.kind&&other.serviceKey===row.serviceKey&&other.accountRef===row.accountRef
        &&(observed||['source_verified','source_verified_invoice','source_partial','user_confirmed'].includes(other.verification));
    });
    if(matches.length!==1)return true;
    const original=state.events.find(e=>e.id===row.eventId),replacement=state.events.find(e=>e.id===matches[0].eventId);
    if(['lineItemRef','transactionRef','refundRef'].some(k=>original?.[k]!=null&&replacement?.[k]!=null&&original[k]!==replacement[k]))return true;
    // An unsupported AI proposal is not an independent conflicting source.
    // Retain it in storage; show the uniquely identified original receipt.
    if(original?.candidateStatus==='needs_review')return false;
    return Boolean(row.amount&&matches[0].amount&&(row.amount.minor!==matches[0].amount.minor||row.amount.currency&&matches[0].amount.currency&&row.amount.currency!==matches[0].amount.currency)
      ||row.date&&matches[0].date&&row.date!==matches[0].date||row.reference&&matches[0].reference&&row.reference!==matches[0].reference);
  });
  return visible.sort((a,b)=>(a.date||a.paymentMonth||'9999').localeCompare(b.date||b.paymentMonth||'9999')||a.receivedAt.localeCompare(b.receivedAt)||a.eventId.localeCompare(b.eventId));
}
