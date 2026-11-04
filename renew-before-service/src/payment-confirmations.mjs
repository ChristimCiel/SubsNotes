// User corrections are a separate ledger layer, never rewritten email evidence.
// Self-contained so exactly the same rules run in the browser and Node hosts.
export function createPaymentConfirmationRuntime() {
  const currencies = new Set(Intl.supportedValuesOf('currency'));
  const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
  const fail = code => { const error = new Error(code); error.code = code; throw error; };
  const clone = value => structuredClone(value);
  const canonical = value => JSON.stringify(value,(_,x)=>object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
  const token = value => typeof value === 'string' && value.trim() && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value) && !['__proto__','prototype','constructor'].includes(value);
  const day = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  const month = value => typeof value === 'string' && /^20\d{2}-(?:0[1-9]|1[0-2])$/.test(value);
  const instant = value => typeof value === 'string' && day(value.slice(0,10)) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  const localDay = value => {const parts=new Intl.DateTimeFormat('en',{year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');};
  const amountValid = value => object(value) && Number.isSafeInteger(value.minor) && value.minor >= 0 && currencies.has(value.currency) && Object.keys(value).every(k=>['minor','currency'].includes(k));
  const identityKeys = ['serviceKey','accountRef','lineItemRef'];
  const optionalIdentity = ['accountRef','lineItemRef','transactionRef','refundRef','reference'];
  function same(a,b) {
    return identityKeys.every(k=>(a[k]??null)===(b[k]??null))
      && ['reference','transactionRef'].every(k=>!a[k]||!b[k]||a[k]===b[k])
      && (a.id===b.id || (a.duplicateEvidenceIds||[]).includes(b.id) || (b.duplicateEvidenceIds||[]).includes(a.id)
        || a.messageId===b.messageId || a.reference&&a.reference===b.reference || a.transactionRef&&a.transactionRef===b.transactionRef);
  }
  function snapshot(event) {
    const out={};
    for(const k of ['id','messageId','serviceKey','service','category','kind','receivedAt',...optionalIdentity])if(event[k]!=null)out[k]=event[k];
    return out;
  }
  function validateSnapshot(value) {
    if(!object(value)||!['invoice_recorded','payment_succeeded'].includes(value.kind)||!instant(value.receivedAt))fail('confirmation_invalid');
    if(Object.keys(value).some(k=>!['id','messageId','serviceKey','service','category','kind','receivedAt',...optionalIdentity].includes(k)))fail('confirmation_invalid');
    for(const k of ['id','messageId','serviceKey','service'])if(!token(value[k]))fail('confirmation_invalid');
    for(const k of ['category',...optionalIdentity])if(value[k]!=null&&!token(value[k]))fail('confirmation_invalid');
  }
  function validateEntry(entry) {
    if(!object(entry)||entry.schemaVersion!==1||entry.provenance!=='user'||!token(entry.eventId)||!Number.isSafeInteger(entry.revision)||entry.revision<1||typeof entry.active!=='boolean'||!amountValid(entry.amount)||!instant(entry.createdAt)||!instant(entry.updatedAt)||Date.parse(entry.createdAt)>Date.parse(entry.updatedAt))fail('confirmation_invalid');
    if(Object.keys(entry).some(k=>!['schemaVersion','provenance','eventId','revision','active','amount','precision','date','month','createdAt','updatedAt','source','history'].includes(k)))fail('confirmation_invalid');
    validateSnapshot(entry.source);if(entry.source.id!==entry.eventId)fail('confirmation_invalid');
    if(entry.precision==='day'){if(!day(entry.date)||entry.month!=null)fail('confirmation_date_invalid');}
    else if(entry.precision==='month'){if(!month(entry.month)||entry.date!=null)fail('confirmation_month_invalid');}
    else fail('confirmation_invalid');
    const latestDay=new Date(Date.parse(entry.updatedAt)+14*60*60*1000).toISOString().slice(0,10);
    if(entry.precision==='day'?entry.date>latestDay:entry.month>latestDay.slice(0,7))fail('confirmation_future');
  }
  function validate(input = {}) {
    if(!object(input)||Object.keys(input).length>50_000)fail('confirmation_invalid');
    const result={};
    for(const [id,entry]of Object.entries(input)){
      if(!token(id)||id!==entry?.eventId)fail('confirmation_invalid');
      validateEntry(entry);
      if(!Array.isArray(entry.history)||entry.history.length!==entry.revision-1||entry.history.length>100)fail('confirmation_invalid');
      for(const [i,prior]of entry.history.entries()){
        validateEntry(prior);
        if(Object.hasOwn(prior,'history')||prior.eventId!==id||prior.revision!==i+1||canonical(prior.source)!==canonical(entry.source)||prior.createdAt!==entry.createdAt||Date.parse(prior.updatedAt)>Date.parse(entry.updatedAt)||i>0&&Date.parse(prior.updatedAt)<Date.parse(entry.history[i-1].updatedAt))fail('confirmation_invalid');
      }
      result[id]=clone(entry);
    }
    return result;
  }
  const entries = state => validate(state?.paymentConfirmations ?? {});
  function record(state,eventId) {
    if(!token(eventId))fail('confirmation_invalid');
    const map=entries(state);if(map[eventId])return map[eventId];
    const event=state?.events?.find(e=>e.id===eventId);
    return event?Object.values(map).find(r=>same(r.source,event))||null:null;
  }
  const get = (state,eventId) => {const r=record(state,eventId);return r?.active?r:null;};
  const revision = (state,eventId) => record(state,eventId)?.revision||0;
  const history = (state,eventId) => {const r=record(state,eventId);return r?[...r.history,(({history,...rest})=>rest)(r)]:[];};
  function parseAmount(input,currency) {
    if(!currencies.has(currency)||typeof input!=='string')fail('confirmation_amount_invalid');
    const value=input.trim();
    if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)||value.length>40)fail('confirmation_amount_invalid');
    const decimals=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
    const [whole,fraction='']=value.replaceAll(',','').split('.');if(fraction.length>decimals)fail('confirmation_amount_invalid');
    const minor=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');
    if(minor>BigInt(Number.MAX_SAFE_INTEGER))fail('confirmation_amount_invalid');
    return {minor:Number(minor),currency};
  }
  function append(state,previous,next,now) {
    if(!instant(now)||previous&&Date.parse(now)<Date.parse(previous.updatedAt))fail('confirmation_invalid');
    const map=entries(state),history=previous?[...previous.history,(({history,...rest})=>rest)(previous)]:[];
    if(history.length>100)fail('confirmation_invalid');
    const entry={...next,revision:(previous?.revision||0)+1,createdAt:previous?.createdAt||now,updatedAt:now,history};
    map[entry.eventId]=entry;validate(map);
    return {...state,paymentConfirmations:map};
  }
  function set(state,input,{now=new Date().toISOString()}={}) {
    if(!state||!Array.isArray(state.events)||!object(input)||Object.keys(input).some(k=>!['eventId','precision','date','month','amount','expectedRevision'].includes(k)))fail('confirmation_invalid');
    const previous=record(state,input.eventId);
    if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision!==(previous?.revision||0))fail('confirmation_stale');
    const event=state.events.find(e=>e.id===(previous?.eventId||input.eventId));
    if(!event)fail('confirmation_missing_source');
    if(!previous&&!['invoice_recorded','payment_succeeded'].includes(event.kind))fail('confirmation_missing_source');
    if(previous&&optionalIdentity.some(k=>(previous.source[k]??null)!==(event[k]??null))||previous&&(previous.source.serviceKey!==event.serviceKey||previous.source.messageId!==event.messageId))fail('confirmation_identity_changed');
    if(!amountValid(input.amount))fail('confirmation_amount_invalid');
    if(input.precision==='day'){if(!day(input.date)||input.month!=null)fail('confirmation_date_invalid');}
    else if(input.precision==='month'){if(!month(input.month)||input.date!=null)fail('confirmation_month_invalid');}
    else fail('confirmation_invalid');
    if(!instant(now))fail('confirmation_invalid');
    const today=localDay(now);
    if(input.precision==='day'?input.date>today:input.month>today.slice(0,7))fail('confirmation_future');
    const source=previous?.source||snapshot(event),map=entries(state);
    if(Object.values(map).some(r=>r.active&&r.eventId!==source.id&&same(r.source,source)))fail('confirmation_duplicate');
    return append(state,previous,{schemaVersion:1,provenance:'user',eventId:source.id,active:true,source,amount:clone(input.amount),precision:input.precision,...(input.precision==='day'?{date:input.date}:{month:input.month})},now);
  }
  function remove(state,eventId,{now=new Date().toISOString(),expectedRevision}={}) {
    const previous=record(state,eventId);
    if(!previous||!previous.active||expectedRevision!==previous.revision)fail('confirmation_stale');
    const {history,createdAt,updatedAt,revision,...rest}=previous;
    return append(state,previous,{...rest,active:false},now);
  }
  function undo(state,eventId,{now=new Date().toISOString(),expectedRevision}={}) {
    const previous=record(state,eventId);
    if(!previous||expectedRevision!==previous.revision||!previous.history.length)fail('confirmation_stale');
    const target=previous.history.at(-1),{createdAt,updatedAt,revision,...rest}=target;
    return append(state,previous,rest,now);
  }
  function validateTransition(previous,next) {
    const before=validate(previous??{}),after=validate(next??{});
    for(const [id,old]of Object.entries(before)){
      const entry=after[id];if(!entry)fail('confirmation_stale');
      if(canonical(entry)===canonical(old))continue;
      if(entry.revision!==old.revision+1||canonical(entry.history)!==canonical([...old.history,(({history,...rest})=>rest)(old)])||canonical(entry.source)!==canonical(old.source)||entry.createdAt!==old.createdAt||Date.parse(entry.updatedAt)<Date.parse(old.updatedAt))fail('confirmation_stale');
    }
    for(const [id,entry]of Object.entries(after))if(!before[id]&&entry.revision!==1)fail('confirmation_stale');
    return after;
  }
  function resolve(snapshot,input={}) {
    const map=validate(input),all=[...(snapshot.payments||[]),...(snapshot.invoices||[]),...(snapshot.oneTimePurchases||[]),...(snapshot.otherRecurringPayments||[]),...(snapshot.unclassifiedPurchases||[]),...(snapshot.heldEvidence||[])];
    const rows=[],supersededIds=new Set(),conflicts=[];
    for(const confirmation of Object.values(map).filter(r=>r.active)){
      const matches=all.filter(e=>same(confirmation.source,e));
      if(rows.some(row=>same(row.paymentConfirmation.source,confirmation.source)))fail('confirmation_duplicate');
      const source=all.find(e=>e.id===confirmation.eventId)||matches[0];
      const codes=[];
      if(!source)codes.push('source_missing');
      if(source&&(['serviceKey','messageId',...optionalIdentity].some(k=>(source[k]??null)!==(confirmation.source[k]??null))))codes.push('source_identity_changed');
      if(source&&(source.category!==confirmation.source.category||['one_time_purchase','wallet_top_up'].includes(source.kind)))codes.push('source_classification_changed');
      if(source?.id===confirmation.eventId&&codes.includes('source_identity_changed'))supersededIds.add(source.id);
      for(const e of matches){
        const amount=e.payment||e.invoiceAmount;
        if(amount&&Number.isSafeInteger(amount.minor)&&(amount.minor!==confirmation.amount.minor||amount.currency&&amount.currency!==confirmation.amount.currency)||e.conflict)codes.push('source_amount_changed');
        if(e.paymentDay&&(confirmation.precision==='day'?e.paymentDay!==confirmation.date:e.paymentDay.slice(0,7)!==confirmation.month))codes.push('source_date_changed');
        if(e.sourceProcessingConflict)codes.push('source_needs_review');
        supersededIds.add(e.id);for(const id of e.duplicateEvidenceIds||[])supersededIds.add(id);
      }
      const row={...(source||{}),...confirmation.source,id:confirmation.eventId,sourceEventId:confirmation.eventId,kind:'payment_succeeded',sourceKind:confirmation.source.kind,
        payment:clone(confirmation.amount),paymentDay:confirmation.precision==='day'?confirmation.date:null,paymentMonth:confirmation.precision==='day'?confirmation.date.slice(0,7):confirmation.month,
        paymentDatePrecision:confirmation.precision,paymentDateBasis:'user',paymentConfirmation:clone(confirmation),confirmationConflicts:[...new Set(codes)],
        subscriptionClassification:matches.some(e=>['one_time_purchase','wallet_top_up'].includes(e.kind))||[confirmation.source.category,...matches.map(e=>e.category)].some(category=>['One-time purchases','Donations'].includes(category))?'non_subscription':[confirmation.source.category,...matches.map(e=>e.category)].includes('Unclassified')?'unverified':'subscription',
        cashflowType:'user_confirmed_payment',sourceFormat:'user_confirmation',authenticated:false,userVerified:true};
      delete row.conflict;delete row.sourceProcessingConflict;rows.push(row);
      if(codes.length)conflicts.push({id:row.id,serviceKey:row.serviceKey,reasons:row.confirmationConflicts});
    }
    return {rows,supersededIds:[...supersededIds],conflicts};
  }
  return {validate,set,remove,undo,get,record,revision,history,parseAmount,resolve,validateTransition};
}
