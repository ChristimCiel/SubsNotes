// Encoded account and instance scopes are longer than raw source identifiers.
export const MAX_SCOPED_SERVICE_KEY_LENGTH=8192;
import {createPaymentConfirmationRuntime} from './payment-confirmations.mjs';
// Shared JSON contracts. A hash detects corruption, not who supplied a record.
// Keep this factory self-contained so browser and CLI hosts use the same rules.
export function createLedgerContracts() {
  const confirmations=createPaymentConfirmationRuntime();
  const kinds = new Set(['payment_succeeded','refund_recorded','refund_pending','renewal_disabled','subscription_confirmed','trial_confirmed','payment_failed','access_paused','access_expiring','access_expired','renewal_notice','one_time_purchase','wallet_top_up','unclassified_purchase','account_not_subscribed','invoice_recorded']);
  const currencies = new Set(Intl.supportedValuesOf('currency'));
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const instant = value => typeof value === 'string' && /T/.test(value) && Number.isFinite(Date.parse(value));
  const day = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  function canonicalJSON(value) {
    const seen = new Set();
    const visit = (item, depth = 0) => {
      if(depth>40)throw new Error('Records are nested too deeply');
      if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
      if (typeof item === 'number' && Number.isFinite(item)) return item;
      if (typeof item !== 'object' || seen.has(item)) throw new Error('Records must contain finite JSON values');
      if (!Array.isArray(item) && ![Object.prototype,null].includes(Object.getPrototypeOf(item))) throw new Error('Records must contain plain JSON objects');
      seen.add(item);
      let next;
      if (Array.isArray(item)) next = item.map(value=>visit(value,depth+1));
      else {
        next = {};
        for (const key of Object.keys(item).sort()) {
          if (['__proto__','prototype','constructor'].includes(key)) throw new Error('Unsafe record key');
          if (item[key] !== undefined) next[key] = visit(item[key],depth+1);
        }
      }
      seen.delete(item);
      return next;
    };
    return JSON.stringify(visit(value));
  }
  const text = (value, name, limit = 256) => {
    if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('Invalid ' + name);
    return value;
  };
  const amount = (value, name) => {
    if (value == null) return;
    if (!object(value) || !Number.isSafeInteger(value.minor) || value.minor < 0 || (value.currency !== null && !currencies.has(value.currency))) throw new Error('Invalid ' + name);
  };
  function documentSource(value) {
    return confirmations.validateDocumentSource(value);
  }
  // Stable content identifiers, not signatures or source authentication. Keep
  // the digest synchronous and self-contained for serialized browser hosts.
  function identityId(kind, parts) {
    const input=canonicalJSON(['subsnotes.identity.v1',kind,parts]);
    const bytes=Array.from(encodeURIComponent(input).replace(/%([0-9A-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16))),c=>c.charCodeAt(0));
    const bits=bytes.length*8;bytes.push(128);while(bytes.length%64!==56)bytes.push(0);
    for(let i=7;i>=0;i--)bytes.push(Math.floor(bits/2**(i*8))&255);
    const constants=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const state=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],rotate=(n,b)=>(n>>>b)|(n<<(32-b));
    for(let offset=0;offset<bytes.length;offset+=64){
      const words=new Array(64);for(let i=0;i<16;i++)words[i]=((bytes[offset+i*4]<<24)|(bytes[offset+i*4+1]<<16)|(bytes[offset+i*4+2]<<8)|bytes[offset+i*4+3])>>>0;
      for(let i=16;i<64;i++){const x=words[i-15],y=words[i-2];words[i]=(words[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+words[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10)))>>>0;}
      let [a,b,c,d,e,f,g,h]=state;
      for(let i=0;i<64;i++){const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]+words[i])>>>0,t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
      for(const [i,n]of [a,b,c,d,e,f,g,h].entries())state[i]=(state[i]+n)>>>0;
    }
    return kind+':'+state.map(n=>n.toString(16).padStart(8,'0')).join('');
  }
  function instanceReference(event) {
    if(event.subscriptionRef)return {basis:'subscription_reference',value:event.subscriptionRef,lineItemRef:event.lineItemRef||null};
    // Existing line-item scope separates evidence, but does not establish a
    // provider-issued subscription/contract identity.
    return event.lineItemRef?{basis:'legacy_line_item',value:event.lineItemRef}:null;
  }
  function serviceScope(event,{separator='|'}={}) {
    const instance=instanceReference(event);
    return event.serviceKey+(event.accountRef?separator+'account:'+encodeURIComponent(event.accountRef):'')
      +(instance?separator+'instance:'+encodeURIComponent((instance.basis==='subscription_reference'?'subscription:':'line:')+instance.value):'')
      +(instance?.lineItemRef?separator+'line:'+encodeURIComponent(instance.lineItemRef):'');
  }
  // Store only allowlisted billing clauses, never an arbitrary email prefix.
  // Removing a clause is preferable to retaining a customer's greeting/address.
  function billingExcerpt(input, {maxLength = 650} = {}) {
    if (!Number.isInteger(maxLength) || maxLength < 0 || maxLength > 2000) throw new Error('Invalid excerpt limit');
    const scrubbed = String(input || '').replace(/<[^>]*>/g,' ')
      .replace(/https?:\/\/[^\s<>]+/gi,'[link removed]')
      .replace(/[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+/g,'[email removed]')
      .replace(/\b(?:\d[ -]?){12,18}\d\b/g,'[number removed]')
      .replace(/\b(?:visa|mastercard|amex|card|payment method)[^\n.!?。]{0,45}(?:ending\s+(?:in\s+)?|[x*·-]{2,})\s*\d{4}\b/gi,'[payment method removed]');
    const moneyToken = new RegExp('(?:\\b(?:' + [...currencies].join('|') + ')\\b|NT\\$|US\\$|CA\\$|AU\\$|[$€£])\\s*\\d[\\d,.]*','g');
    const dateToken = /\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/(?:20\d{2}|\d{2})\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:–\d{1,2})?,?\s+20\d{2}\b|20\d{2}年\s*\d{1,2}月\s*\d{1,2}日/gi;
    const labels = /\b(?:amount paid|total paid|total refunded(?: without credit note)?|refunded on|refund (?:requested|approved|recorded|processed)|payment (?:failed|declined|successful)|invoice (?:amount|date)|next (?:charge|billing)|billing (?:period|cycle)|trial (?:ends|end)|auto[- ]?renew(?:al)?\s+(?:is\s+)?(?:off|on|disabled|enabled)|subscription(?:\s+(?:has|also|been|was|is|will|successfully)){0,5}\s+(?:cancelled|canceled|confirmed|expires|renew)|membership(?:\s+(?:has|also|been|was|is|will|successfully)){0,5}\s+(?:cancelled|canceled|end)|access (?:ends|expires|paused)|cancellation confirmed)\b|實付金額|總付款金額|總計|退款(?:已完成|待確認)?|下次扣款日|自動續(?:訂|約|費)(?:已)?(?:關閉|停用|開啟)|訂閱已取消|付款失敗|訂閱到期日/gi;
    const pieces = [];
    for (const clause of scrubbed.split(/\r?\n|[;。!?]|\.(?!\d)(?:\s+|$)/)) {
      if (/(?:\b(?:dear|hello|hi|customer name|billing address|shipping address|postal address|phone|telephone|tax id|vat id|birthdate|birthday|date of birth)\b|姓名|地址|電話|統一編號|生日)\s*[:：,]?/i.test(clause)) continue;
      // Match controlled phrases and tokens only: even a line containing a
      // charge may also contain a name, address or unrelated message text.
      pieces.push(...(clause.match(labels) || []));
      pieces.push(...(clause.match(moneyToken) || []).filter(token=>!/^\d/.test(token)));
      pieces.push(...(clause.match(dateToken) || []));
    }
    return [...new Set(pieces)].join(' · ').slice(0,maxLength);
  }
  function expandCheckpointMetadata(state) {
    if (state.scannedIdsFormat == null) return state;
    if (state.scannedIdsFormat !== 'processing-keys-v1' || !object(state.sourceProcessing)) throw new Error('Unsupported saved checkpoint format');
    const ids=Object.keys(state.sourceProcessing).sort();
    if(ids.some(id=>!/^[A-Za-z0-9_-]{1,200}$/.test(id)||['__proto__','constructor','prototype'].includes(id)))throw new Error('Invalid saved message identity');
    if(state.scannedIds!=null&&(!Array.isArray(state.scannedIds)||state.scannedIds.length!==ids.length||new Set(state.scannedIds).size!==ids.length||state.scannedIds.some(id=>!Object.hasOwn(state.sourceProcessing,id))))throw new Error('Saved checkpoint identities disagree');
    return {...state,scannedIds:ids};
  }
  function compactCheckpointMetadata(state) {
    state=expandCheckpointMetadata(state);
    if(!object(state.sourceProcessing))return state;
    const ids=state.scannedIds,keys=object(state.sourceProcessing)?Object.keys(state.sourceProcessing):[];
    if(!Array.isArray(ids)||ids.length!==keys.length||new Set(ids).size!==ids.length||ids.some(id=>!Object.hasOwn(state.sourceProcessing,id)))return state;
    const {scannedIds,...rest}=state;
    const packed={...rest,scannedIdsFormat:'processing-keys-v1'};
    expandCheckpointMetadata(packed);
    return packed;
  }
  function validateCanonicalState(input, {expectedMailboxHash = null, requireRevision = false} = {}) {
    const encoded = canonicalJSON(input);
    if (new TextEncoder().encode(encoded).length > 25_000_000) throw new Error('The ledger is too large');
    const state = expandCheckpointMetadata(JSON.parse(encoded));
    if (!object(state) || !Array.isArray(state.events) || state.events.length > 50_000 || (state.version != null && state.version !== 1)) throw new Error('Unsupported ledger schema');
    if (state.mailboxHash != null && !/^[a-f0-9]{64}$/.test(state.mailboxHash)) throw new Error('Invalid mailbox identity');
    if (expectedMailboxHash && state.mailboxHash !== expectedMailboxHash) throw new Error('The ledger belongs to a different mailbox');
    if (state.storageRevision != null) text(state.storageRevision,'storage revision');
    if (requireRevision && !state.storageRevision) throw new Error('A persisted ledger revision is required');
    if(Object.hasOwn(state,'paymentConfirmationChunks'))throw new Error('Load the complete saved confirmations before validating');
    if(Object.hasOwn(state,'paymentConfirmations'))state.paymentConfirmations=confirmations.validate(state.paymentConfirmations);
    const byId = new Map();
    for (const event of state.events) {
      if (!object(event)) throw new Error('Invalid source record');
      text(event.id,'event identity'); text(event.messageId,'message identity');
      text(event.serviceKey,'service identity'); text(event.service,'service name',300);
      if (!kinds.has(event.kind) || !instant(event.receivedAt)) throw new Error('Invalid source record kind or time');
      if (event.sourceDocument != null) documentSource(event.sourceDocument);
      for (const field of ['payment','refund','recurringRate','nextCharge','invoiceAmount']) amount(event[field],field);
      for (const field of ['paymentDay','refundDay','invoiceDay','nextBilling','accessEnds','trialEnds','cancelBy']) if (event[field] != null && !day(event[field])) throw new Error('Invalid ' + field);
      for (const field of ['sourceReadAt','nextBillingAt','accessEndsAt']) if(event[field]!=null&&!instant(event[field]))throw new Error('Invalid '+field);
      if(event.period!=null&&(!object(event.period)||!day(event.period.start)||!day(event.period.end)||event.period.start>=event.period.end))throw new Error('Invalid paid service period');
      for (const field of ['accountRef','subscriptionRef','lineItemRef','transactionRef','refundRef']) if (event[field] != null) text(event[field],field,200);
      const fingerprint = canonicalJSON(event);
      if (byId.has(event.id)) throw new Error(byId.get(event.id) !== fingerprint?'Conflicting records share an event identity':'Duplicate event identity');
      byId.set(event.id,fingerprint);
    }
    return state;
  }
  // A model may propose fields, never grant itself trusted-source authority.
  // The observation must be supplied separately by the host after a real read.
  // Exact source quotes bind a proposal to text; they do not verify semantics.
  function validateCandidate(candidate, {observation, expectedMailboxHash = null} = {}) {
    if (!object(candidate) || candidate.schemaVersion !== 1 || !object(observation)) throw new Error('A versioned candidate and actual source observation are required');
    for (const key of ['authenticated','userVerified','receiptVerification','verificationHistory','sourceFormat','sourceReadAt','senderAuthenticationAvailable','paymentConfirmations','paymentConfirmation']) if (Object.hasOwn(candidate,key)) throw new Error('Candidates cannot supply source authority');
    text(observation.messageId,'observed message identity'); text(observation.text,'observed source text',1_000_000);
    if (!instant(observation.observedAt) || !instant(observation.receivedAt)) throw new Error('Observed source times are required');
    if (candidate.messageId !== observation.messageId) throw new Error('Candidate does not match the observed message');
    if (expectedMailboxHash && observation.mailboxHash !== expectedMailboxHash) throw new Error('Candidate source belongs to another mailbox');
    if (!kinds.has(candidate.kind)) throw new Error('Unsupported candidate kind');
    let sourceDocument=null;
    if(observation.document!=null){
      if(!object(observation.document)||Object.keys(observation.document).some(key=>!['sha256','page','parserVersion','recordKey','start','end'].includes(key)))throw new Error('Invalid document provenance');
      sourceDocument=documentSource({...observation.document,attachmentId:observation.attachmentId});
    }
    const allowed = new Set(['serviceKey','service','category','kind','payment','paymentDay','paymentDateBasis','refund','refundDay','refundDateBasis','invoiceAmount','invoiceDay','period','cadence','recurringRate','nextCharge','nextBilling','accessEnds','trialEnds','cancelBy','plan','reference','accountRef','subscriptionRef','lineItemRef','transactionRef','refundRef']);
    const record = {}, evidence = {};
    for (const key of Object.keys(candidate)) {
      if (['schemaVersion','messageId','fieldEvidence'].includes(key)) continue;
      if (!allowed.has(key)) throw new Error('Unsupported candidate field: ' + key);
      const proof = candidate.fieldEvidence?.[key];
      // Unknown values remain null. A supplied original quote still explains
      // the uncertainty and must pass the same source-match checks.
      if (candidate[key] == null && proof == null) { record[key] = null; continue; }
      if (!object(proof) || typeof proof.quote !== 'string' || !proof.quote.trim() || proof.quote.length > 1000 || !observation.text.includes(proof.quote)) throw new Error('Candidate field is not backed by observed source text: ' + key);
      if (proof.attachmentId != null && proof.attachmentId !== observation.attachmentId) throw new Error('Candidate attachment does not match the source read');
      if(proof.currencyQuote!=null&&(typeof proof.currencyQuote!=='string'||!proof.currencyQuote.trim()||proof.currencyQuote.length>1000||!observation.text.includes(proof.currencyQuote)))throw new Error('Candidate currency is not backed by observed source text');
      record[key] = JSON.parse(canonicalJSON(candidate[key]));
      // Persist only billing excerpts, not the whole source quote or body.
      const currencyCode=proof.currencyQuote?.match(/^(?:currency|billing currency|幣別|貨幣)\s*[:：]?\s*([A-Z]{3})$/i)?.[1]?.toUpperCase();
      evidence[key] = {excerpt:billingExcerpt(proof.quote,{maxLength:220}),...(proof.currencyQuote?{currencyExcerpt:currencyCode&&currencies.has(currencyCode)?'Currency '+currencyCode:billingExcerpt(proof.currencyQuote,{maxLength:100})}:{}),...(sourceDocument?{sourceDocument}: {})};
    }
    text(record.serviceKey,'candidate service identity'); text(record.service,'candidate service name',300);
    const candidateKey=(sourceDocument
      ? sourceDocument.recordKey ? ['document-record',candidate.messageId,sourceDocument.recordKey,record.kind] : ['document',candidate.messageId,sourceDocument.sha256,sourceDocument.page,record.kind]
      : record.accountRef||record.subscriptionRef||record.reference
        ? [identityId('scoped-candidate',[candidate.messageId,record.kind,record.serviceKey,record.accountRef||null,record.subscriptionRef||null,record.lineItemRef||null,record.refundRef||null,record.transactionRef||null,record.reference||null])]
        : [candidate.messageId,record.kind,record.refundRef||record.transactionRef||record.lineItemRef||'']).map(value=>encodeURIComponent(value)).join(':');
    const event = {...record,id:'candidate:' + candidateKey,messageId:observation.messageId,receivedAt:observation.receivedAt,
      authenticated:false,userVerified:false,sourceFormat:'assistant_candidate',sourceReadAt:null,
      candidateStatus:'needs_review',candidateObservedAt:observation.observedAt,fieldEvidence:evidence,
      ...(sourceDocument?{sourceDocument}:{}),
      evidence:billingExcerpt(Object.values(candidate.fieldEvidence || {}).map(p=>p.quote || '').join('\n'))};
    validateCanonicalState({version:1,events:[event]});
    return event;
  }
  async function createPortableExport(state, {hash} = {}) {
    if (typeof hash !== 'function') throw new Error('A SHA-256 digest function is required');
    const payload = {format:'subsnotes-ledger',schemaVersion:1,state:validateCanonicalState(state)};
    const value = await hash(canonicalJSON(payload));
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('The digest must be SHA-256 hex');
    return {...payload,integrity:{algorithm:'SHA-256',value}};
  }
  async function importPortableExport(bundle, {hash, expectedMailboxHash = null} = {}) {
    if (typeof hash !== 'function' || !object(bundle) || bundle.format !== 'subsnotes-ledger' || bundle.schemaVersion !== 1 || bundle.integrity?.algorithm !== 'SHA-256' || !/^[a-f0-9]{64}$/.test(bundle.integrity?.value)) throw new Error('Unsupported portable ledger');
    const payload = {format:bundle.format,schemaVersion:bundle.schemaVersion,state:bundle.state};
    if (await hash(canonicalJSON(payload)) !== bundle.integrity.value) throw new Error('Portable ledger integrity check failed');
    const state = validateCanonicalState(bundle.state,{expectedMailboxHash});
    if(state.paymentConfirmations){state.importedPaymentConfirmations=state.paymentConfirmations;delete state.paymentConfirmations;}
    for (const event of state.events) {
      if (event.receiptVerification) {event.importedReceiptVerification=event.receiptVerification;delete event.receiptVerification;}
      if (event.verificationHistory) {event.importedVerificationHistory=event.verificationHistory;delete event.verificationHistory;}
      event.authenticated=false; event.userVerified=false; event.sourceFormat='portable_import'; event.sourceReadAt=null;
      event.importStatus='needs_source_recheck';
    }
    // Portable data is not a newly persisted host revision or a sync checkpoint.
    for(const key of ['storageRevision','pending','lastCompletedAt','syncAnchorAt','sourceProcessing','sourceProcessingFormat','processingSummary','queryCoverage','queryVersion','parserVersion','discoveryCoverage','discoveryCheckpoints','discoveryHistoryVersions','lastReview','lastHistoryReviewAt','sourceProcessingChunks','scannedIdsFormat','scannedIds','eventChunks','storageFormat'])delete state[key];
    state.updatesWhileClosed=false;
    return {state,requiresSourceRecheck:true,integrityVerified:true,sourceAuthenticityVerified:false};
  }
  const revisionContract = state => ({schemaVersion:1,revision:state?.storageRevision || null,legacySavedAt:state?.storageRevision ? null : state?.savedAt || null,persisted:Boolean(state?.storageRevision)});
  return {canonicalJSON,billingExcerpt,identityId,instanceReference,serviceScope,expandCheckpointMetadata,compactCheckpointMetadata,validateCanonicalState,validateCandidate,createPortableExport,importPortableExport,revisionContract,distinctDocumentRecords:confirmations.distinctDocumentRecords};
}
