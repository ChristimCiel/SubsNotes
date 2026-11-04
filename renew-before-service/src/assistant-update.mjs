import { preserveReceiptVerification } from './receipt-verification.mjs';
import { createLedgerContracts } from './ledger-contracts.mjs';
import { createSourceEvidenceMerger } from './web-sync.mjs';
// The assistant supplies actual observed tool replies, not invented summaries.
// This merges a targeted read; it never claims the mailbox backfill completed.
export async function mergeAssistantEvidence({state, identityReply, messages, asOf, fxSnapshot=null, parserVersion='4'}, {createClaudeGmailClient,extractWebEvidence,createFxRuntime,hash}) {
  if(!state||!Array.isArray(state.events)||!Number.isFinite(Date.parse(asOf))||!Array.isArray(messages))throw new Error('A saved state, observed messages and actual processing time are required');
  if(typeof parserVersion!=='string'||!parserVersion.trim()||parserVersion.length>24)throw new Error('A bounded parser version is required');
  const replies=new Map(messages.map(m=>[m.id,m]));
  if(replies.size!==messages.length)throw new Error('Observed message identities must be unique');
  const client=createClaudeGmailClient({callTool:async(server,tool,args)=>{
    if(server!=='Gmail')throw new Error('Unexpected connector');
    if(tool==='search_threads'&&args.query==='in:sent from:me')return identityReply;
    if(tool==='get_message'&&replies.has(args.messageId))return {payload:replies.get(args.messageId)};
    throw new Error('A required observed tool reply is missing');
  }},{clock:()=>asOf});
  const identity=await hash(await client.identity());
  if(state.mailboxHash&&state.mailboxHash!==identity)throw new Error('Connected mailbox does not match the saved records');
  const {billingExcerpt}=createLedgerContracts();
  const merger=createSourceEvidenceMerger({preserveReceiptVerification,billingExcerpt,hash});
  const events=new Map(state.events.map(e=>[e.id,e])),known=new Set(state.scannedIds||[]),before=new Set(events.keys()),added=new Set();
  const processing=Object.assign(Object.create(null),Object.fromEntries([...known].filter(id=>merger.validProcessingRecord(state.sourceProcessing?.[id])).map(id=>[id,state.sourceProcessing[id]])));
  const now=Date.parse(asOf);
  for(const id of replies.keys()){
    const message=await client.message(id);
    const prior=processing[id];
    const result=merger.merge({events,message,parsed:await extractWebEvidence(message),parserVersion,processingRecord:prior,
      sourceDigest:prior?.length===7?await merger.sourceFingerprint(message):null});
    for(const event of result.newEvents)if(!before.has(event.id))added.add(event.id);
    processing[id]=merger.nextProcessingRecord(prior,{parserVersion,now,reason:result.reason,sourceReview:result.sourceReview});
    known.add(id);
  }
  const processingSummary=merger.summarizeProcessing(known,processing,{parserVersion,now});
  const next={...state,mailboxHash:identity,events:[...events.values()],scannedIds:[...known],savedAt:asOf,lastAssistantUpdateAt:asOf,
    parserVersion,sourceProcessingFormat:'tuple-v1',sourceProcessing:processing,processingSummary};
  if(fxSnapshot)next.fxSnapshot=createFxRuntime().validateSnapshot(fxSnapshot,new Date(asOf));
  return {state:JSON.parse(JSON.stringify(next)),addedEvidence:added.size,readCount:replies.size,reviewCount:processingSummary.needsReview,
    extractionPending:processingSummary.retryPending+processingSummary.reprocessPending};
}
