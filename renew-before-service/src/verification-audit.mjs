import {sourceVerification} from './billing-ledger.mjs';

export const VERIFICATION_POLICY_VERSION='source-financial-1';
const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const financial=e=>['payment_succeeded','refund_recorded','invoice_recorded'].includes(e?.kind);

// Document facts, payment proof and date allocation are separate dimensions.
// History is an audit record, never a grant of source/payment authority.
export function describeVerification(event,confirmation=null){
  const code=sourceVerification(event),invoice=event.kind==='invoice_recorded',refund=event.kind==='refund_recorded';
  const document=code==='source_verified_invoice'||code==='source_verified'?'verified':code==='source_partial'?'partial':'unverified';
  const confirmed=confirmation?.active===true;
  const payment=confirmed?'user_confirmed':!invoice&&code==='source_verified'?'source_verified':'unverified';
  const date=confirmed?(confirmation.precision==='day'?confirmation.date:null):!invoice&&code==='source_verified'?(refund?event.refundDay:event.paymentDay):null;
  const recordedMonth=confirmed&&confirmation.precision==='month'?confirmation.month:date?.slice(0,7)||null;
  return {policyVersion:VERIFICATION_POLICY_VERSION,document:{status:document,kind:invoice?'invoice':refund?'refund_receipt':'payment_receipt',
      verifiedFields:document==='unverified'?[]:Object.keys(event.fieldEvidence||{}).filter(k=>event[k]!=null),sourceVerifiedAt:event.receiptVerification?.checkedAt||null},
    payment:{status:payment,kind:refund?'refund':'payment',reason:confirmed?'user_confirmation':invoice?'invoice_is_not_payment_receipt':code==='source_verified'?'explicit_success_amount_currency_date':code==='source_partial'?'transaction_date_not_verified':'source_or_required_fields_not_verified'},
    allocation:{paymentMonth:recordedMonth,transactionDate:date,precision:confirmed?confirmation.precision:date?'day':null,
      documentDate:invoice?event.invoiceDay||null:null,documentMonth:invoice?event.invoiceDay?.slice(0,7)||null:null,rawDocumentDate:event.fieldEvidence?.invoiceDay?.excerpt||null},
    subscriptionTerms:{plan:event.plan||null,cadence:event.cadence||null,cadenceBasis:event.cadenceBasis||null,servicePeriod:event.period||null}};
}

function facts(event,confirmation){
  const source={};for(const k of ['id','messageId','receivedAt','sourceUrl','sourceDay','serviceKey','service','category','kind','accountRef','subscriptionRef','lineItemRef','transactionRef','refundRef','reference','payment','paymentDay','paymentDateBasis','refund','refundDay','refundDateBasis','invoiceAmount','invoiceDay','rawInvoiceDate','currencyAmbiguous','period','plan','productUnconfirmed','cadence','cadenceBasis','evidence','sourceFact','sourceRequiresDocumentReview','issuerDomain','sourceDocument','sourceDigest','fieldEvidence','sourceFormat','authenticated','candidateStatus','importStatus','sourceProcessingConflict','conflict'])if(event[k]!==undefined)source[k]=event[k];
  const proof=event.receiptVerification?clone(event.receiptVerification):null;if(proof)delete proof.checkedAt;
  return {source,reviewedProof:proof,confirmation:confirmation?.active?{amount:confirmation.amount,precision:confirmation.precision,date:confirmation.date||null,month:confirmation.month||null,revision:confirmation.revision,createdAt:confirmation.createdAt||null,updatedAt:confirmation.updatedAt||null,provenance:confirmation.provenance||null}:null};
}
const latestDecision=history=>history?.entries?.filter(e=>e.type==='decision').at(-1)||null;
export function verificationAuditSummary(event){
  const history=event.verificationHistory,last=latestDecision(history);
  return last?{persisted:true,decisionId:last.id,recordedAt:last.recordedAt,sourceVerifiedAt:last.assessment.document.sourceVerifiedAt,reason:last.reason,
    decisionCount:history.entries.filter(e=>e.type==='decision').length,observationCount:history.entries.filter(e=>e.type==='observation').length}: {persisted:false};
}

export function createVerificationAudit({hash,clock=()=>new Date().toISOString(),policyVersion=VERIFICATION_POLICY_VERSION}={}){
  if(typeof hash!=='function')throw Error('A private source digest function is required');
  async function reconcile(previous,next,{confirmationWrite=false,observations=next.events}={}){
    const prior=new Map((previous?.events||[]).map(e=>[e.id,e])),raw=new Map(observations.map(e=>[e.id,e])),recordedAt=clock(),events=[];
    for(const e of next.events){
      const old=prior.get(e.id),oldConfirmation=previous?.paymentConfirmations?.[e.id],confirmation=(confirmationWrite?next.paymentConfirmations:previous?.paymentConfirmations)?.[e.id];
      if(!financial(e)&&!financial(old)&&!old?.verificationHistory){const value={...e};delete value.verificationHistory;events.push(value);continue;}
      const oldHistory=old?.verificationHistory;
      if(oldHistory&&(!Array.isArray(oldHistory.entries)||oldHistory.schemaVersion!==1))throw Error('Saved verification history is invalid');
      const entries=clone(oldHistory?.entries||[]);
      const append=async(value,reason)=>{
        const snapshot=facts(value,reason==='existing_source_migrated'?oldConfirmation:confirmation),assessment=describeVerification(value,reason==='existing_source_migrated'?oldConfirmation:confirmation);
        assessment.policyVersion=policyVersion;
        const fingerprint=await hash(canonical({policy:policyVersion,snapshot,assessment:{...assessment,document:{...assessment.document,sourceVerifiedAt:null}}})),last=latestDecision({entries});
        if(last?.fingerprint===fingerprint)return;
        const changed=last?[...new Set([...Object.keys(last.snapshot.source),...Object.keys(snapshot.source)])].filter(k=>canonical(last.snapshot.source[k])!==canonical(snapshot.source[k])):[];
        const entry={type:'decision',recordedAt,observedAt:value.sourceReadAt||value.candidateObservedAt||null,reason,fingerprint,previousDecisionId:last?.id||null,assessment,snapshot,changedFields:changed,
          ledgerCoverageAtRecord:next.sourceImport?.coverage||null};
        entry.id=await hash(canonical(entry));entries.push(entry);
      };
      if(!entries.length&&old)await append(old,'existing_source_migrated');
      const last=latestDecision({entries}),snapshot=facts(e,confirmation);
      const reason=!last?'source_first_observed':canonical(last.snapshot.confirmation)!==canonical(snapshot.confirmation)?'user_confirmation_changed':last.assessment.policyVersion!==policyVersion?'validation_policy_changed':
        e.receiptVerification?.changeReason?'document_reverified: '+e.receiptVerification.changeReason:
        last.snapshot.source.sourceDocument?.sha256!==snapshot.source.sourceDocument?.sha256?'source_document_changed':
        e.sourceProcessingConflict||e.conflict?'source_conflict_requires_review':'source_facts_or_provenance_changed';
      await append(e,reason);
      const proposed=raw.get(e.id);
      if(proposed&&canonical(facts(proposed,confirmation))!==canonical(snapshot)){
        const proposedFacts=facts(proposed,confirmation),fingerprint=await hash(canonical({type:'observation',proposedFacts}));
        if(!entries.some(e=>e.type==='observation'&&e.fingerprint===fingerprint)){
          const observation={type:'observation',recordedAt,reason:'retained_document_verified_facts_on_reinspection',fingerprint,decisionId:latestDecision({entries}).id,proposedFacts};
          observation.id=await hash(canonical(observation));entries.push(observation);
        }
      }
      events.push({...e,verificationHistory:{schemaVersion:1,entries}});
    }
    return {...next,events};
  }
  return {reconcile};
}
