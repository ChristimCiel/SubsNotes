import {createLedgerContracts} from './ledger-contracts.mjs';

// The host assistant owns mailbox authorization and retrieval. This boundary
// sends a user request and receives proposals; it never connects to Gmail.
export function createAssistantHandoffRuntime() {
  const contracts=createLedgerContracts();
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  const strict=(value,keys,label)=>{
    if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Unsupported '+label);
  };
  const id=(value,label)=>{
    if(typeof value!=='string'||!value.trim()||value.length>200||/[\u0000-\u001f\u007f]/.test(value))throw new Error('Invalid '+label);
    return value;
  };
  function createRequest({requestId,ledgerRevision=null,language='en',scope='new_and_unresolved'}={}) {
    id(requestId,'request identity');
    if(ledgerRevision!==null)id(ledgerRevision,'ledger revision');
    if(!['en','zh-TW'].includes(language))throw new Error('Unsupported language');
    if(!['new_and_unresolved','all_available_billing_history'].includes(scope))throw new Error('Unsupported scan scope');
    return {schemaVersion:1,kind:'subsnotes.assistant-scan-request',requestId,ledgerRevision,language,scope};
  }
  function validateRequest(input) {
    strict(input,['schemaVersion','kind','requestId','ledgerRevision','language','scope'],'scan request');
    if(input.schemaVersion!==1||input.kind!=='subsnotes.assistant-scan-request')throw new Error('Unsupported scan request version');
    return createRequest(input);
  }
  function prompt(input,{expectedMailboxHash=null}={}) {
    const request=validateRequest(input);
    if(expectedMailboxHash!=null&&!/^[a-f0-9]{64}$/.test(expectedMailboxHash))throw new Error('Invalid expected mailbox binding');
    const text=request.language==='zh-TW'
      ? '請使用你已獲授權的 Gmail 連線核對我的訂閱，將結構化結果交回 SubsNotes。SubsNotes 不取得 Gmail 授權。請區分實際付款、發票、續費與取消證據，附上最少必要帳務摘錄及原信參照，保留未知欄位與我已確認的資料；沒有完成讀取或儲存時請明說。不要寄信或取消服務。'
      : 'Use your authorized Gmail connection to review my subscriptions and return structured results to SubsNotes. SubsNotes must not obtain Gmail authorization. Separate actual payments, invoices, renewals and cancellation evidence. Include minimal billing excerpts and original source references, preserve unknown fields and my confirmed edits, and report incomplete reads or saves. Do not send email or cancel services.';
    const instructions=request.language==='zh-TW'
      ? '請只回傳單一 JSON 物件，不加 Markdown。以下格式中的 records 預設為空；有實際讀到的帳務資料才加入紀錄，最多 100 筆。每個 candidate 至少需要 schemaVersion:1、messageId、serviceKey、service、kind 和 fieldEvidence。對每個提供的事實欄位（含 serviceKey、service、kind），fieldEvidence[欄位名稱] 必須是 {"quote":"原文中逐字存在的短句"}；未知欄位省略，不要猜。observation 需提供 messageId、實際收信時間 receivedAt、實際讀取時間 observedAt（含時區的 ISO 時間）及 text（最多 4000 字的最少帳務原文）。text 必須包含引用短句，不能填摘要。付款金額格式為 payment:{"currency":"ISO 幣別","minor":整數最小貨幣單位}；有明確已付款日期才提供 paymentDay:"YYYY-MM-DD" 與 paymentDateBasis:"explicit"，不要把收信日或發票日當付款日。nextBilling、accessEnds、invoiceDay 可在原文明示時提供；帳期 cadence 使用 monthly 或 annual。不得加入 token、完整郵件、本人確認或來源已驗證旗標。coverage 的兩個完成欄位請依實際情形填寫，mailboxExhaustive 必須為 false。'
      : 'Return one JSON object only, without Markdown. The envelope below starts with empty records; add only actually read billing observations, at most 100. Each candidate requires schemaVersion:1, messageId, serviceKey, service, kind and fieldEvidence. For every supplied fact field, including serviceKey, service and kind, fieldEvidence[fieldName] must be {"quote":"an exact short quote from the observed text"}. Omit unknown fields; do not guess. Each observation requires messageId, actual receivedAt and observedAt (ISO timestamps with offsets), and text (minimal original billing text, at most 4000 characters, containing the exact quotes; not a summary). Payment amounts use payment:{"currency":"ISO code","minor":integer minor currency units}. Supply paymentDay:"YYYY-MM-DD" and paymentDateBasis:"explicit" only for an explicit paid date; email or invoice dates are not payment dates. Supply nextBilling, accessEnds or invoiceDay only when stated. cadence is monthly or annual. Never include tokens, full messages, user-confirmation or source-verification flags. Set coverage completion booleans from actual results; mailboxExhaustive must remain false.';
    const kinds='payment_succeeded, invoice_recorded, subscription_confirmed, trial_confirmed, renewal_notice, renewal_disabled, payment_failed, access_expiring, access_expired, access_paused, refund_recorded, refund_pending, one_time_purchase, wallet_top_up, unclassified_purchase, account_not_subscribed';
    const envelope={schemaVersion:1,kind:'subsnotes.assistant-scan-result',requestId:request.requestId,ledgerRevision:request.ledgerRevision,records:[],coverage:{queriesComplete:false,attachmentsComplete:false,mailboxExhaustive:false}};
    return text+'\n\nSubsNotes request: '+contracts.canonicalJSON(request)+'\n\n'+instructions+'\nSupported kind values: '+kinds+'\nResult envelope: '+contracts.canonicalJSON(envelope)+(expectedMailboxHash?'\nInclude observation.mailboxHash: '+expectedMailboxHash+' (request binding only; this does not verify the sender).':'\nOmit observation.mailboxHash unless the host actually knows it. Do not invent or derive credentials.');
  }
  function createBridge({capabilities={},sendMessage}={}) {
    let pending=null;
    const dispatched=new Map();
    return {
      async requestScan(input,{expectedMailboxHash=null}={}) {
        const request=validateRequest(input);
        const fingerprint=contracts.canonicalJSON(request),prior=dispatched.get(request.requestId);
        if(prior)return {status:prior===fingerprint?'awaiting_assistant':'request_identity_conflict',requestId:request.requestId,scanCompleted:false};
        if(pending)return {status:'request_in_progress',requestId:pending,scanCompleted:false};
        if(!capabilities.message||typeof sendMessage!=='function')return {status:'host_message_unavailable',requestId:request.requestId,scanCompleted:false,prompt:prompt(request,{expectedMailboxHash})};
        pending=request.requestId;
        try {
          const result=await sendMessage({role:'user',content:[{type:'text',text:prompt(request,{expectedMailboxHash})}]});
          if(!result?.isError){dispatched.set(request.requestId,fingerprint);if(dispatched.size>128)dispatched.delete(dispatched.keys().next().value);}
          return {status:result?.isError?'host_rejected_request':'awaiting_assistant',requestId:request.requestId,scanCompleted:false};
        } catch {
          // Provider errors may contain credentials or private context.
          return {status:'host_request_failed',requestId:request.requestId,scanCompleted:false};
        } finally {pending=null;}
      }
    };
  }
  function validateResult(input,{request,expectedMailboxHash=null}={}) {
    request=validateRequest(request);
    const encoded=contracts.canonicalJSON(input);
    if(new TextEncoder().encode(encoded).length>2_000_000)throw new Error('Assistant result is too large');
    const result=JSON.parse(encoded);
    strict(result,['schemaVersion','kind','requestId','ledgerRevision','records','coverage'],'assistant result');
    if(result.schemaVersion!==1||result.kind!=='subsnotes.assistant-scan-result')throw new Error('Unsupported assistant result version');
    if(result.requestId!==request.requestId)throw new Error('Assistant result belongs to another request');
    if(result.ledgerRevision!==request.ledgerRevision)throw new Error('Assistant result targets another ledger revision');
    if(!Array.isArray(result.records)||result.records.length>100)throw new Error('A bounded assistant record batch is required');
    strict(result.coverage,['queriesComplete','attachmentsComplete','mailboxExhaustive'],'coverage');
    if(typeof result.coverage.queriesComplete!=='boolean'||typeof result.coverage.attachmentsComplete!=='boolean'||result.coverage.mailboxExhaustive!==false)throw new Error('Explicit, non-exhaustive source coverage is required');
    const seen=new Set();
    const candidates=result.records.map(record=>{
      strict(record,['candidate','observation'],'assistant record');
      strict(record.observation,['messageId','receivedAt','observedAt','mailboxHash','text','attachmentId','document'],'billing observation');
      if(typeof record.observation.text!=='string'||record.observation.text.length>4000)throw new Error('Only a minimal billing observation is accepted');
      const candidate=contracts.validateCandidate(record.candidate,{observation:record.observation,expectedMailboxHash});
      if(seen.has(candidate.id))throw new Error('Duplicate assistant candidate');
      seen.add(candidate.id);
      return candidate;
    });
    // Host authentication and exact quotation checks do not authenticate the
    // original provider. A separate accepted write must preserve user authority.
    return {requestId:request.requestId,ledgerRevision:request.ledgerRevision,candidates,coverage:result.coverage,
      stored:false,requiresReview:true,sourceAuthenticityVerified:false};
  }
  // Prepare against a freshly loaded ledger. The caller must use the protected
  // store's save/readback path; preparing a merge is not a successful write.
  function prepareMerge({state:input,result,request,expectedMailboxHash=null,ownerBinding=null,observedAt}={}) {
    request=validateRequest(request);
    const mailbox=expectedMailboxHash||input?.mailboxHash;
    const state=contracts.validateCanonicalState(input);
    if(mailbox!=null&&(typeof mailbox!=='string'||!/^[a-f0-9]{64}$/.test(mailbox)))throw new Error('Invalid trusted mailbox binding');
    // The app supplies a hash of the authenticated host user identity. The
    // assistant result cannot establish either an owner or mailbox authority.
    if(ownerBinding!=null&&(typeof ownerBinding!=='string'||!/^[a-f0-9]{64}$/.test(ownerBinding)))throw new Error('Invalid host owner binding');
    if(state.assistantOwnerBinding!=null&&state.assistantOwnerBinding!==ownerBinding)throw new Error('The ledger belongs to another host owner');
    if(!mailbox&&!ownerBinding)throw new Error('A trusted mailbox binding or host owner binding is required');
    if(state.mailboxHash!=null&&state.mailboxHash!==mailbox)throw new Error('The ledger belongs to a different mailbox');
    if((state.storageRevision||null)!==request.ledgerRevision)throw new Error('The ledger revision changed; reopen before syncing');
    if(typeof observedAt!=='string'||!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt)||!Number.isFinite(Date.parse(observedAt)))throw new Error('The actual merge time is required');
    const proposal=validateResult(result,{request,expectedMailboxHash:mailbox||null});
    const review=state.assistantReview??[];
    if(!Array.isArray(review)||review.length>5000)throw new Error('Unsupported assistant review history');
    const factKeys=['serviceKey','service','category','kind','payment','paymentDay','paymentDateBasis','refund','refundDay','refundDateBasis','invoiceAmount','invoiceDay','period','cadence','recurringRate','nextCharge','nextBilling','accessEnds','trialEnds','cancelBy','plan','reference','accountRef','lineItemRef','transactionRef','refundRef'];
    const facts=value=>Object.fromEntries(factKeys.filter(key=>value[key]!=null).map(key=>[key,value[key]]));
    const sameFacts=(candidate,existing)=>Object.entries(facts(candidate)).every(([key,value])=>contracts.canonicalJSON(value)===contracts.canonicalJSON(existing[key]??null));
    const sameAccount=(a,b)=>['accountRef','lineItemRef'].every(key=>(a[key]??null)===(b[key]??null));
    const compatibleReferences=(a,b)=>['reference','transactionRef','refundRef'].every(key=>!a[key]||!b[key]||a[key]===b[key]);
    const sameSource=(a,b)=>!contracts.distinctDocumentRecords(a,b)&&(a.id===b.id||a.messageId===b.messageId&&a.kind===b.kind&&sameAccount(a,b)&&compatibleReferences(a,b));
    const confirmationSources=Object.values(state.paymentConfirmations||{}).map(entry=>entry.source);
    const protectedSource=(a,b)=>!contracts.distinctDocumentRecords(a,b)&&a.serviceKey===b.serviceKey&&sameAccount(a,b)&&compatibleReferences(a,b)&&(a.id===b.id||a.messageId===b.messageId||a.reference&&a.reference===b.reference||a.transactionRef&&a.transactionRef===b.transactionRef);
    const events=[...state.events],conflicts=[];
    const reviewKeys=new Set(review.map(entry=>contracts.canonicalJSON({candidate:facts(entry.candidate||{}),messageId:entry.candidate?.messageId??null,reason:entry.reason,existingEventIds:entry.existingEventIds})));
    let addedCount=0,duplicateCount=0;
    for(const candidate of proposal.candidates) {
      const matches=events.filter(event=>sameSource(candidate,event));
      if(matches.some(event=>sameFacts(candidate,event))){duplicateCount++;continue;}
      const protectedMatches=confirmationSources.filter(source=>protectedSource(candidate,source));
      if(matches.length||protectedMatches.length){
        const entry={candidate,reason:protectedMatches.length?'confirmed_record_protected':'source_facts_conflict',existingEventIds:[...new Set([...matches.map(event=>event.id),...protectedMatches.map(source=>source.id)])].sort()};
        const key=contracts.canonicalJSON({candidate:facts(candidate),messageId:candidate.messageId,reason:entry.reason,existingEventIds:entry.existingEventIds});
        if(!reviewKeys.has(key)){review.push(entry);reviewKeys.add(key);}else duplicateCount++;
        conflicts.push(entry);continue;
      }
      events.push(candidate);addedCount++;
    }
    if(review.length>5000)throw new Error('The assistant review history is full; existing records were preserved');
    const mailboxBinding=mailbox?'bound':'unverified';
    const next=contracts.validateCanonicalState({...state,...(mailbox?{mailboxHash:mailbox}:{}),...(ownerBinding?{assistantOwnerBinding:ownerBinding}:{}),assistantMailboxBinding:mailboxBinding,events,assistantReview:review,
      lastAssistantProposalAt:observedAt,assistantScan:{requestId:request.requestId,processedAt:observedAt,coverage:proposal.coverage,addedCount,duplicateCount,conflictCount:conflicts.length}});
    return {state:next,requestId:request.requestId,ledgerRevision:request.ledgerRevision,coverage:proposal.coverage,
      stored:false,requiresReview:proposal.candidates.length>0,sourceAuthenticityVerified:false,mailboxBinding,addedCount,duplicateCount,conflicts};
  }
  return {createRequest,prompt,createBridge,validateResult,prepareMerge};
}
