import {createLedgerContracts} from './ledger-contracts.mjs';
const contracts=createLedgerContracts();
import {projectBillingRecords,resolvedSourceService,sourceVerification} from './billing-ledger.mjs';
import {billingDay,belongsToBillingMonth,validateBillingMonth} from './billing-calendar.mjs';
import {createPaymentConfirmationRuntime} from './payment-confirmations.mjs';
import {describeVerification,verificationAuditSummary} from './verification-audit.mjs';

const sourceUrl=id=>'https://mail.google.com/mail/u/0/#all/'+encodeURIComponent(id);
const identity=createPaymentConfirmationRuntime();
export const observedSource=e=>!e.candidateStatus&&!e.importStatus&&!e.sourceProcessingConflict&&!e.conflict&&(e.authenticated===true||['connector_plaintext','claude_plaintext'].includes(e.sourceFormat)&&Number.isFinite(Date.parse(e.sourceReadAt)));
const sameAccount=(a,b)=>['accountRef','subscriptionRef','lineItemRef'].every(k=>(a[k]??null)===(b[k]??null));
function sameTransaction(a,b){
  if(!a||!b||!sameAccount(a,b)||identity.distinctDocumentRecords(a,b))return false;
  if(a.transactionRef&&b.transactionRef)return a.transactionRef===b.transactionRef;
  if(a.reference&&b.reference)return a.reference===b.reference;
  return a.messageId===b.messageId;
}
const complete=row=>['source_verified','user_confirmed'].includes(row.verification);

// A single presentation ledger; original documents and confirmation authority
// are untouched. An invoice can support a payment but cannot create one.
export function projectPaymentHistory(state,{month=null,paidEventIds=null}={}){
  validateBillingMonth(month);
  const byId=new Map(state.events.map(e=>[e.id,e]));
  const payments=projectBillingRecords(state),invoices=projectBillingRecords(state,{view:'invoices'}),linked=new Set();
  const document=row=>({eventId:row.eventId,messageId:row.messageId,type:row.sourceKind,date:row.date,amount:row.amount,reference:row.reference,sourceUrl:row.sourceUrl,verification:row.verification,
    amountEvidence:row.amountEvidence,dateEvidence:row.dateEvidence,fieldEvidence:byId.get(row.eventId)?.fieldEvidence||{},sourceDocument:byId.get(row.eventId)?.sourceDocument||null});
  const rows=[];
  for(const row of payments.slice().sort((a,b)=>Number(b.confirmed)-Number(a.confirmed))){
    const valid=complete(row)&&(row.kind==='refund_recorded'||paidEventIds===null||paidEventIds.has(row.eventId));
    const old=rows.find(p=>p.kind===row.kind&&p.serviceKey===row.serviceKey&&sameTransaction(byId.get(p.eventId),byId.get(row.eventId))
      &&(p.confirmed||p.amount?.currency===row.amount?.currency&&p.amount?.minor===row.amount?.minor&&p.date===row.date&&p.paymentMonth===row.paymentMonth));
    if(old){old.documents.push(document(row));continue;}
    rows.push({...row,verificationAssessment:describeVerification(byId.get(row.eventId),state.paymentConfirmations?.[row.eventId]),verificationAudit:verificationAuditSummary(byId.get(row.eventId)),documents:[document(row)],status:row.kind==='refund_recorded'?(valid?'refunded':'refund_unverified'):(valid?'paid':'payment_unverified'),countsAsPayment:row.kind==='payment_succeeded'&&valid,dateRole:row.kind==='refund_recorded'?'refund_date':'payment_date'});
  }
  for(const invoice of invoices){
    const event=byId.get(invoice.eventId);
    const matches=rows.filter(p=>p.kind==='payment_succeeded'&&complete(p)&&p.serviceKey===invoice.serviceKey&&sameTransaction(event,byId.get(p.eventId)));
    if(matches.length===1){const p=matches[0];p.documents.push({...document(invoice),amountDifferenceMinor:invoice.amount?.currency===p.amount?.currency?invoice.amount.minor-p.amount.minor:null});linked.add(invoice.eventId);}
  }
  for(const row of invoices.filter(r=>!linked.has(r.eventId)))rows.push({...row,paymentMonth:null,documentMonth:row.paymentMonth,verificationAssessment:describeVerification(byId.get(row.eventId),state.paymentConfirmations?.[row.eventId]),verificationAudit:verificationAuditSummary(byId.get(row.eventId)),documents:[document(row)],status:'payment_unverified',countsAsPayment:false,dateRole:'invoice_date'});
  for(const row of rows.filter(r=>r.confirmed))for(const ev of state.events){
    if(ev.kind!=='payment_succeeded'||sourceVerification(ev)!=='source_verified'||resolvedSourceService(state,ev)!==resolvedSourceService(state,byId.get(row.eventId))||!sameTransaction(ev,byId.get(row.eventId))||row.documents.some(d=>d.eventId===ev.id))continue;
    row.documents.push({eventId:ev.id,messageId:ev.messageId,type:ev.kind,date:ev.paymentDay,amount:ev.payment,reference:ev.reference||null,sourceUrl:sourceUrl(ev.messageId),verification:'source_verified',fieldEvidence:ev.fieldEvidence||{},sourceDocument:ev.sourceDocument||null});
  }
  return rows.filter(row=>month===null||(row.paymentMonth||row.documentMonth)===month).sort((a,b)=>(a.date||a.paymentMonth||'9999').localeCompare(b.date||b.paymentMonth||'9999')||a.receivedAt.localeCompare(b.receivedAt)||a.eventId.localeCompare(b.eventId));
}

// Resolve reminders against verified payments across the entire history,
// then select the requested month. Never resolve by amount or arrival alone.
export function projectServiceActivity(state,{asOf=new Date().toISOString(),month=null,history=projectPaymentHistory(state)}={}){
  validateBillingMonth(month);const today=billingDay(asOf),byId=new Map(state.events.map(e=>[e.id,e]));
  const paid=history.filter(r=>r.countsAsPayment),trusted=state.events.filter(observedSource),notices=[];
  const key=e=>contracts.serviceScope({...e,serviceKey:resolvedSourceService(state,e)},{separator:'::'});
  for(const e of trusted.filter(e=>['renewal_notice','subscription_confirmed'].includes(e.kind)&&e.nextBilling)){
    const due=billingDay(e.nextBilling);if(!due)continue;
    const matches=paid.filter(p=>{
      const pe=byId.get(p.eventId);if(p.serviceKey!==key(e)||!sameAccount(pe,e))return false;
      if(e.plan&&pe.plan&&e.plan.trim().toLowerCase()!==pe.plan.trim().toLowerCase())return false;
      if(e.reference&&pe.reference&&e.reference!==pe.reference)return false;
      if(e.transactionRef&&pe.transactionRef&&e.transactionRef!==pe.transactionRef)return false;
      const identity=e.transactionRef&&e.transactionRef===pe.transactionRef||e.reference&&e.reference===pe.reference;
      return identity||p.date===due||pe.period?.start===due;
    });
    const laterCancel=trusted.find(c=>key(c)===key(e)&&c.kind==='renewal_disabled'&&c.receivedAt>e.receivedAt&&billingDay(c.receivedAt)<=due
      &&(!c.plan||!e.plan||c.plan.trim().toLowerCase()===e.plan.trim().toLowerCase()));
    const resolution=matches.length===1?'resolved_payment':laterCancel?'resolved_cancellation':due<today?'past_due_unverified':'scheduled';
    notices.push({eventId:e.id,messageId:e.messageId,serviceKey:key(e),kind:e.kind,date:due,dateRole:'scheduled_billing_date',resolution,resolvedBy:matches.length===1?matches[0].eventId:laterCancel?.id||null,sourceUrl:sourceUrl(e.messageId),outstanding:resolution==='scheduled'});
  }
  const statuses=new Map();
  for(const serviceKey of new Set([...trusted.map(key),...history.map(r=>r.serviceKey)])){
    const events=trusted.filter(e=>key(e)===serviceKey).sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt));
    const payments=paid.filter(p=>p.serviceKey===serviceKey),latest=payments.slice().sort((a,b)=>(a.date||a.paymentMonth).localeCompare(b.date||b.paymentMonth)).at(-1),pe=byId.get(latest?.eventId);
    const cancel=events.filter(e=>e.kind==='renewal_disabled').at(-1),expiry=events.filter(e=>e.kind==='access_expired').at(-1),issue=events.filter(e=>['payment_failed','access_paused'].includes(e.kind)).at(-1),refund=events.filter(e=>['refund_recorded','refund_pending'].includes(e.kind)).at(-1);
    const afterPayment=e=>e&&(!pe||e.receivedAt>=pe.receivedAt);
    const laterInvoice=cancel&&events.some(e=>e.kind==='invoice_recorded'&&e.receivedAt>cancel.receivedAt);
    let status='unverified',basis=null,evidenceIds=[];
    if(afterPayment(issue)){status='payment_issue';basis='source_payment_issue';evidenceIds=[issue.id];}
    else if(afterPayment(cancel)&&!laterInvoice){status='confirmed_canceled';basis='explicit_cancellation_notice';evidenceIds=[cancel.id];}
    else if(afterPayment(expiry)&&(!expiry.accessEnds||expiry.accessEnds<=today)){status='expired';basis='explicit_expiry_notice';evidenceIds=[expiry.id];}
    else if(pe?.period?.start<=today&&pe.period.end>today&&!afterPayment(refund)&&!laterInvoice){status='confirmed_active';basis='verified_payment_with_current_source_period; not_live_account_check';evidenceIds=[pe.id];}
    const related=notices.filter(n=>n.serviceKey===serviceKey);
    statuses.set(serviceKey,{statusCode:status,statusBasis:basis,statusEvidenceIds:evidenceIds,statusAsOf:today,currentStatusVerified:false,
      recordedAccessEnds:status==='confirmed_active'?pe.period.end:status==='confirmed_canceled'?cancel.accessEnds||null:status==='expired'?expiry.accessEnds||null:null,
      renewalNotices:related,outstandingRenewalCount:related.filter(n=>n.outstanding).length});
  }
  return {statuses,notices:notices.filter(n=>belongsToBillingMonth(n.date,month))};
}
