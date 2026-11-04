import { preserveReceiptVerification } from './receipt-verification.mjs';
import { createLedgerContracts } from './ledger-contracts.mjs';

// Both full discovery and targeted assistant reads use this source-scoped
// merge. Dependencies are explicit so the same function runs in the Artifact.
export function createSourceEvidenceMerger({ preserveReceiptVerification, billingExcerpt, hash = null }) {
  if (typeof preserveReceiptVerification !== 'function' || typeof billingExcerpt !== 'function') throw new Error('Source merge dependencies are required');
  const family = event => ['payment_succeeded', 'one_time_purchase', 'wallet_top_up', 'unclassified_purchase'].includes(event.kind) ? 'payment'
    : ['refund_recorded', 'refund_pending'].includes(event.kind) ? 'refund' : null;
  const sameTransaction = (a, b) => ['accountRef', 'lineItemRef', 'transactionRef', 'refundRef'].every(key => (a[key] ?? null) === (b[key] ?? null));
  const reviewed = event => Array.isArray(event.receiptVerification?.fields) && event.receiptVerification.fields.length > 0 && Number.isFinite(Date.parse(event.receiptVerification.checkedAt));
  function contradicts(previous, incoming) {
    const key = family(incoming), old = previous[key], next = incoming[key];
    if (old?.minor !== undefined && next?.minor !== undefined && old.minor !== next.minor) return true;
    if (old?.currency && next?.currency && old.currency !== next.currency) return true;
    const dateKey = key === 'refund' ? 'refundDay' : 'paymentDay';
    return !!(previous[dateKey] && incoming[dateKey] && previous[dateKey] !== incoming[dateKey]);
  }
  function unresolvedReason(message, events) {
    if (message.sourceContentUnavailable === true) return 'source_content_unavailable';
    if (!String(message.text || '').trim()) return 'empty_body';
    if (message.truncated) return 'truncated_body';
    if (!events.length) return 'unrecognized_format';
    if (events.some(event => event.sourceProcessingConflict)) return 'source_reclassified';
    if (events.some(event => event.sourceRequiresDocumentReview && !reviewed(event) || event.kind === 'unclassified_purchase')) return 'document_review';
    for (const event of events) {
      if (event.kind === 'invoice_recorded') {
        if (!Number.isSafeInteger(event.invoiceAmount?.minor)) return 'amount_unknown';
        if (!event.invoiceAmount?.currency || event.currencyAmbiguous) return 'currency_unknown';
        if (!event.invoiceDay) return 'invoice_date_unknown';
      }
      const key = family(event);
      if (key && !Number.isSafeInteger(event[key]?.minor)) return 'amount_unknown';
      if (key && !event[key]?.currency || event.currencyAmbiguous) return 'currency_unknown';
      if (event.kind === 'payment_succeeded' && (!event.paymentDay || event.paymentDateBasis !== 'explicit')) return 'payment_date_unknown';
      if (event.kind === 'refund_recorded' && (!event.refundDay || event.refundDateBasis !== 'explicit')) return 'refund_date_unknown';
    }
    return null;
  }
  function merge({ events, message, parsed, parserVersion = '5', processingRecord = null, sourceDigest = null }) {
    if (!(events instanceof Map) || !message?.id || !Array.isArray(parsed)) throw new Error('Observed source and parsed records are required');
    if (typeof parserVersion !== 'string' || !parserVersion.trim() || parserVersion.length > 24) throw new Error('A bounded parser version is required');
    if (message.sourceContentUnavailable === true) return { newEvents: [], reason:'source_content_unavailable' };
    if (reviewedNonBilling(processingRecord) && processingRecord[6][1] === sourceDigest) return { newEvents: [], reason:null, sourceReview:structuredClone(processingRecord[6]) };
    const changedReview = reviewedNonBilling(processingRecord);
    if (changedReview) parsed = parsed.map(event=>({...event,sourceProcessingConflict:true}));
    const sourceBefore = [...events.values()].filter(event => event.messageId === message.id), reviewedBefore = sourceBefore.filter(reviewed);
    const newEvents = [];
    let conflict = false, identityConflict = false, incomplete = false;
    for (const event of parsed) {
      if (!event?.id || event.messageId !== message.id) throw new Error('Parsed evidence does not match the observed source');
      const existingReview = reviewedBefore.find(old => old.id !== event.id && family(old) && family(old) === family(event) && sameTransaction(old, event));
      if (existingReview) {
        conflict ||= contradicts(existingReview, event);
        continue;
      }
      const sameReview = reviewedBefore.find(old => old.id === event.id && family(old) && family(old) === family(event) && sameTransaction(old, event));
      if (sameReview) conflict ||= contradicts(sameReview, event);
      const previousRecord = events.get(event.id);
      let record = preserveReceiptVerification(previousRecord, { ...event,
        subject: billingExcerpt(event.subject, { maxLength: 200 }), evidence: billingExcerpt(event.evidence),
        attachmentCount: message.attachmentCount || 0, attachmentContentRead: false,
        bodyFormat: message.bodyFormat || 'plain_text', bodyTruncated: !!message.truncated, senderAuthenticationAvailable: false });
      if (previousRecord && (previousRecord.messageId !== event.messageId || previousRecord.serviceKey !== record.serviceKey || !sameTransaction(previousRecord, event))) {
        // A reused ID must not move facts or document proof to another account,
        // line item or service. Keep the original identity and hold the reread.
        if (!reviewed(previousRecord)) events.set(previousRecord.id, { ...previousRecord, sourceProcessingConflict: true });
        record = { ...record, id: 'reprocess:' + event.id + ':' + parserVersion + ':identity', sourceProcessingConflict: true };
        delete record.receiptVerification;
        events.set(record.id, record); newEvents.push(record); identityConflict = true;
        continue;
      }
      // A new explicit classification is uncertainty, even if its amount is
      // missing. An empty parse or missing field in the SAME kind is not a
      // contradictory classification and cannot erase previously known facts.
      const reclassified = sourceBefore.filter(old => !reviewed(old) && !old.sourceProcessingConflict && family(old)
        && family(old) === family(event) && sameTransaction(old, event) && Number.isSafeInteger(old[family(old)]?.minor)
        && (old.kind !== event.kind || Number.isSafeInteger(event[family(event)]?.minor) && contradicts(old, event)));
      for (const old of reclassified) events.set(old.id, { ...old, sourceProcessingConflict: true });
      if (reclassified.some(old => old.id === event.id) || previousRecord?.sourceProcessingConflict && !reviewed(previousRecord) && family(previousRecord)
        && family(previousRecord) === family(event) && sameTransaction(previousRecord, event)
        && (previousRecord.kind !== event.kind || contradicts(previousRecord, event))) {
        record = { ...record, id: 'reprocess:' + event.id + ':' + parserVersion };
      }
      if (reclassified.length || previousRecord?.sourceProcessingConflict && !reviewed(record)) record = { ...record, sourceProcessingConflict: true };
      if (previousRecord && previousRecord.kind === event.kind && sameTransaction(previousRecord, event) && !reviewed(previousRecord) && !record.sourceProcessingConflict) {
        for (const key of ['payment', 'refund', 'invoiceAmount', 'paymentDay', 'refundDay', 'invoiceDay', 'period', 'cadence', 'recurringRate', 'nextCharge', 'nextBilling', 'nextBillingAt', 'accessEnds', 'accessEndsAt']) {
          if (previousRecord[key] != null && record[key] == null) {
            record[key] = structuredClone(previousRecord[key]); incomplete = true;
            const basis = key === 'paymentDay' ? 'paymentDateBasis' : key === 'refundDay' ? 'refundDateBasis' : null;
            if (basis && previousRecord[basis]) record[basis] = previousRecord[basis];
          }
        }
        for (const key of ['payment', 'refund', 'invoiceAmount', 'recurringRate', 'nextCharge']) {
          if (previousRecord[key]?.currency && record[key]?.minor === previousRecord[key].minor && !record[key].currency) {
            record[key] = { ...record[key], currency: previousRecord[key].currency }; incomplete = true;
          }
        }
      }
      events.set(record.id, record); newEvents.push(record);
    }
    const sourceEvents = [...events.values()].filter(event => event.messageId === message.id);
    const reviewedSource = !parsed.length && sourceBefore.length > 0 && sourceBefore.every(reviewed) && String(message.text || '').trim() && !message.truncated;
    return { newEvents, reason: changedReview ? 'reviewed_source_changed' : identityConflict ? 'source_identity_conflict' : conflict ? 'reviewed_source_conflict' : unresolvedReason(message, parsed.length || reviewedSource ? sourceEvents : []) || (incomplete ? 'incomplete_reread' : null) };
  }
  const retryLimit = 3, day = 86400000;
  const validSourceReview = review => Array.isArray(review) && review.length === 2 && review[0] === 'non_billing' && typeof review[1] === 'string' && /^[a-f0-9]{64}$/.test(review[1]);
  const validProcessingRecord = record => Array.isArray(record) && [6,7].includes(record.length) && typeof record[0] === 'string'
    && ['extracted', 'needs_review'].includes(record[1]) && Number.isInteger(record[2]) && record[2] > 0 && record[2] <= retryLimit
    && Number.isFinite(record[3]) && (record[4] === null || Number.isFinite(record[4])) && (record[5] === null || typeof record[5] === 'string')
    && (record.length === 6 || record[1] === 'extracted' && record[4] === null && record[5] === null && validSourceReview(record[6]));
  const reviewedNonBilling = record => validProcessingRecord(record) && record.length === 7;
  const processingDue = (record, parserVersion, now) => !reviewedNonBilling(record) && (!validProcessingRecord(record) || record[0] !== parserVersion || record[1] === 'needs_review'
    && record[2] < retryLimit && record[4] !== null && record[4] <= now);
  async function sourceFingerprint(message) {
    if (typeof hash !== 'function' || !message?.id || typeof message.text !== 'string' || !message.sender || !Number.isFinite(Date.parse(message.receivedAt))) throw new Error('A real source observation and digest function are required');
    const fingerprint = await hash(JSON.stringify([message.id,message.sender,message.subject || '',new Date(message.receivedAt).toISOString(),message.text.replace(/\r\n?/g,'\n').trim()]));
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('A SHA-256 source fingerprint is required');
    return fingerprint;
  }
  async function reviewSource({ events, message, parserVersion, now, decision }) {
    if (decision !== 'non_billing' || !(events instanceof Map) || !Number.isFinite(now) || typeof parserVersion !== 'string' || !parserVersion.trim() || parserVersion.length > 24) throw new Error('A supported source review is required');
    if (!message?.text?.trim() || message.truncated || !Number.isFinite(Date.parse(message.sourceReadAt))) throw new Error('Read the complete original source before reviewing it');
    const meaningful = event => event.kind !== 'unclassified_purchase' || event.sourceRequiresDocumentReview || ['payment','refund','invoiceAmount','recurringRate','nextCharge','paymentDay','refundDay','invoiceDay','period','nextBilling','accessEnds','trialEnds','cancelBy','plan','reference'].some(key=>event[key]!=null);
    if ([...events.values()].some(event=>event.messageId === message.id && meaningful(event))) throw new Error('Existing billing or subscription evidence cannot be dismissed as non-billing');
    return [parserVersion,'extracted',1,now,null,null,[decision,await sourceFingerprint(message)]];
  }
  function nextProcessingRecord(previous, { parserVersion, now, reason, sourceReview = null }) {
    const attempts = validProcessingRecord(previous) && previous[0] === parserVersion ? Math.min(retryLimit, previous[2] + 1) : 1;
    const record = [parserVersion, reason ? 'needs_review' : 'extracted', attempts, now,
      reason && attempts < retryLimit ? now + (attempts === 1 ? day : 3 * day) : null, reason];
    if (!reason && validSourceReview(sourceReview)) {record.push(structuredClone(sourceReview));record[3]=reviewedNonBilling(previous)?previous[3]:now;}
    return record;
  }
  function summarizeProcessing(known, processing, { parserVersion, now }) {
    const records = [...known].map(id => validProcessingRecord(processing[id]) ? processing[id] : null);
    return { read: known.size,
      extracted: records.filter(record => reviewedNonBilling(record) || record?.[0] === parserVersion && record[1] === 'extracted').length,
      reviewedNonBilling:records.filter(reviewedNonBilling).length,
      needsReview: records.filter(record => record?.[1] === 'needs_review').length,
      retryPending: records.filter(record => record?.[0] === parserVersion && record[1] === 'needs_review' && record[2] < retryLimit).length,
      retryDue: records.filter(record => record?.[0] === parserVersion && processingDue(record, parserVersion, now)).length,
      retryExhausted: records.filter(record => record?.[0] === parserVersion && record[1] === 'needs_review' && record[2] >= retryLimit).length,
      reprocessPending: records.filter(record => !record || record[0] !== parserVersion && !reviewedNonBilling(record)).length };
  }
  return { merge, validProcessingRecord, processingDue, nextProcessingRecord, summarizeProcessing, sourceFingerprint, reviewSource };
}

// Platform adapters are injected. Financial state is saved only after a whole
// bounded page was read successfully; failures preserve the prior checkpoint.
export function createWebSync({ gmail, store, extract, hash, clock = () => new Date().toISOString(), onProgress = () => {}, parserVersion = '5' }) {
  let running = false;
  const { billingExcerpt, canonicalJSON: canonical } = createLedgerContracts();
  const sourceMerger = createSourceEvidenceMerger({ preserveReceiptVerification, billingExcerpt, hash });
  const { validProcessingRecord, processingDue, nextProcessingRecord, summarizeProcessing } = sourceMerger;
  if (typeof parserVersion !== 'string' || !parserVersion.trim() || parserVersion.length > 24) throw new Error('A bounded parser version is required');
  const queryVersion = 'billing-v3';
  const terms = '{subject:receipt subject:invoice subject:eGUI subject:subscription subject:membership subject:renew subject:renewal subject:expiration subject:registered subject:payment subject:refund subject:cancelled subject:canceled subject:cancellation subject:expire subject:expires subject:expiring subject:trial subject:plan subject:"purchase confirmation" subject:收據 subject:發票 subject:訂閱 subject:續訂 subject:付款 subject:退款 subject:取消 subject:試用 subject:到期 subject:扣款 subject:刷卡結果 "amount paid" "total paid" "payment failed" "payment method" "subscription is now active" "your subscription" "your membership" "your plan" "premium membership" "billing period" "next invoice" "free month of Pro" "定期定額" "自動續訂" "下次扣款" "實付金額"}';
  // Epoch seconds avoid Gmail's date-string timezone. Dates without an offset
  // mean UTC; callers reviewing a local month pass exact offset/epoch bounds.
  function epoch(value) {
    const ms = typeof value === 'number' ? value * 1000 : typeof value === 'string' && (/^\d{4}-\d{2}-\d{2}$/.test(value) || /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) ? Date.parse(value) : NaN;
    if (!Number.isFinite(ms) || ms < 0 || ms % 1000 !== 0) throw new Error('Use epoch seconds or an ISO date with an explicit timezone for the review range');
    if(typeof value==='string') {
      const day=value.slice(0,10),[year,month,date]=day.split('-').map(Number);
      if(new Date(Date.UTC(year,month-1,date)).toISOString().slice(0,10)!==day)throw new Error('The review range contains an invalid calendar date');
    }
    return ms / 1000;
  }
  const query = (since, until, includeSpamTrash) => `after:${since - 1} before:${until} ${includeSpamTrash ? 'in:anywhere ' : ''}-in:sent ${terms}`;
  const legacyQuery = (since, until) => `after:${since.replaceAll('-', '/')} before:${until.replaceAll('-', '/')} -in:sent {subject:receipt subject:invoice subject:eGUI subject:subscription subject:membership subject:renew subject:renewal subject:expiration subject:registered subject:payment subject:refund subject:cancelled subject:canceled subject:cancellation subject:expire subject:trial subject:收據 subject:發票 subject:訂閱 subject:續訂 subject:付款 subject:退款 subject:取消 subject:試用 subject:到期}`;
  function coverage(previous, pending, completedAt) {
    if(previous != null && (previous.format!=='ranges-v1' || !Array.isArray(previous.ranges)))throw new Error('Saved discovery coverage format is unsupported; previous records were kept');
    const ranges = previous ? structuredClone(previous.ranges) : [];
    if (ranges.some(r => !Array.isArray(r) || r.length !== 5 || typeof r[0] !== 'string' || typeof r[1] !== 'boolean' || !Number.isSafeInteger(r[2]) || !Number.isSafeInteger(r[3]) || r[2] >= r[3] || !Number.isFinite(Date.parse(r[4])))) throw new Error('Saved discovery coverage is invalid; previous records were kept');
    ranges.push([queryVersion,pending.includeSpamTrash,pending.since,pending.until,completedAt]);
    ranges.sort((a,b)=>a[0].localeCompare(b[0]) || Number(a[1])-Number(b[1]) || a[2]-b[2]);
    const merged=[];
    for(const range of ranges) {
      const last=merged.at(-1);
      if(last && last[0]===range[0] && last[1]===range[1] && range[2]<=last[3]) { last[3]=Math.max(last[3],range[3]);last[4]=last[4]<range[4]?last[4]:range[4]; }
      else merged.push(range);
    }
    // Never evict a completed historical interval to claim newer coverage.
    if(merged.length>64)throw new Error('Discovery coverage needs consolidation before another separate range can be saved');
    return {format:'ranges-v1',ranges:merged};
  }
  function recentJournal(previous, entry) {
    const unique=new Map();
    for(const record of [...(previous || []),entry]) {
      const key=record.query || canonical([record.queryVersion??null,record.includeSpamTrash??null,record.since??null,record.until??null]);
      const old=unique.get(key);
      unique.set(key,old?{...record,firstCompletedAt:old.firstCompletedAt || old.completedAt}:record);
    }
    return [...unique.values()].slice(-20);
  }
  async function run({ maxReads = 20, since = null, until = null, includeSpamTrash = false, recentOnly = false } = {}) {
    if (running) throw new Error('A sync is already running');
    if (!Number.isInteger(maxReads) || maxReads < 1 || maxReads > 100) throw new Error('maxReads must be between 1 and 100');
    if(typeof includeSpamTrash!=='boolean')throw new Error('The Spam and Trash scope must be explicit');
    if(typeof recentOnly!=='boolean')throw new Error('The recent-update mode must be explicit');
    const explicit=since!==null || until!==null;
    if(explicit && (since===null || until===null))throw new Error('Both review range boundaries are required');
    if(explicit && recentOnly)throw new Error('Choose either a historical review or a recent update');
    const requested=explicit?{since:epoch(since),until:epoch(until),includeSpamTrash}:null;
    if(requested && (requested.since>=requested.until || requested.until-requested.since>733*86400))throw new Error('Choose a nonempty review range of at most two years');
    running = true;
    try {
      const previous = await store.load() || { version: 1, events: [], scannedIds: [], prefs: {} };
      const identity = await hash(await gmail.identity());
      if (previous.mailboxHash && previous.mailboxHash !== identity) throw new Error('The connected Gmail account changed; the saved data was kept separate');
      const startedAt = clock(), date = new Date(startedAt), now = date.getTime();
      if (!Number.isFinite(now)) throw new Error('A valid sync time is required');
      const scope=includeSpamTrash?'anywhere':'default';
      const candidateCheckpoint=previous.discoveryCheckpoints?.[scope] || (scope==='default'?previous.discoveryCheckpoints?.anywhere:null);
      const checkpoint=Array.isArray(candidateCheckpoint) && candidateCheckpoint[0]===queryVersion && Number.isFinite(Date.parse(candidateCheckpoint[1]))?candidateCheckpoint:null;
      const legacyAnchor=scope==='default' && previous.syncVersion===2 && Number.isFinite(Date.parse(previous.syncAnchorAt || previous.lastCompletedAt))?previous.syncAnchorAt || previous.lastCompletedAt:null;
      const anchor=checkpoint?.[1] || legacyAnchor;
      // A recent-update checkpoint is not proof that this query version searched
      // historical mail. Only a finished version backfill writes this marker.
      const versionComplete=previous.discoveryHistoryVersions?.[scope]===queryVersion || scope==='default' && previous.discoveryHistoryVersions?.anywhere===queryVersion;
      const end = Math.floor(now/1000)+1, start=new Date(date);
      start.setUTCFullYear(start.getUTCFullYear()-2);
      if(requested && requested.since>=end)throw new Error('Choose a review range that has already started');
      const range=requested ? {...requested,requestedUntil:requested.until,until:Math.min(requested.until,end)} : {since:recentOnly || versionComplete?Math.floor((anchor?Date.parse(anchor):now)/1000)-2*86400:Math.floor(start.getTime()/1000),until:end,includeSpamTrash};
      const priorPending=previous.pending;
      if(recentOnly && priorPending && (priorPending.mode!=='epochs-v3' || priorPending.kind!=='incremental'))throw new Error('A saved historical review requires Continue checking before another automatic update');
      if(priorPending && !['windows-v2','epochs-v3'].includes(priorPending.mode))throw new Error('The saved discovery format is unsupported; existing records were kept');
      if(priorPending && requested && (priorPending.mode!=='epochs-v3' || priorPending.since!==requested.since || (priorPending.requestedUntil ?? priorPending.until)!==requested.until || priorPending.includeSpamTrash!==includeSpamTrash))throw new Error('Finish or continue the saved discovery range before reviewing a different month');
      const pending=priorPending?structuredClone(priorPending):{
        mode:'epochs-v3',kind:explicit?'history_review':recentOnly || versionComplete?'incremental':'version_backfill',queryVersion,recentOnly,
        ...range,windows:[{since:range.since,until:range.until}],pageToken:null,ids:[],nextPageToken:null,startedAt
      };
      const modern=pending.mode==='epochs-v3';
      if(modern && (pending.queryVersion!==queryVersion || !Number.isSafeInteger(pending.since) || !Number.isSafeInteger(pending.until) || pending.since>=pending.until || typeof pending.includeSpamTrash!=='boolean' || !['history_review','version_backfill','incremental'].includes(pending.kind)))throw new Error('Saved discovery boundaries are invalid; existing records were kept');
      if(!Array.isArray(pending.windows)||!Array.isArray(pending.ids))throw new Error('Saved discovery progress is invalid');
      let ids=[...pending.ids], nextPageToken=pending.nextPageToken, searched=ids.length>0;
      for(let attempt=0;!ids.length && pending.windows.length && attempt<4;attempt++) {
        const window=pending.windows[0];
        const first=modern?window.since:Date.parse(window.since)/1000, last=modern?window.until:Date.parse(window.until)/1000;
        if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first>=last || modern && (first<pending.since || last>pending.until))throw new Error('Saved discovery window is invalid');
        const span=(last-first)/86400;
        onProgress('searching');
        const page=await gmail.search({query:modern?query(first,last,pending.includeSpamTrash):legacyQuery(window.since,window.until),pageToken:pending.pageToken,pageSize:span<=1?50:10});
        if(!Array.isArray(page.ids) || page.ids.some(id=>typeof id!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(id)))throw new Error('Gmail search returned invalid source IDs; coverage is incomplete');
        if(page.nextPageToken && page.nextPageToken===pending.pageToken)throw new Error('Gmail repeated a page token; coverage is incomplete');
        if(page.paginationUnknown&&!page.nextPageToken) {
          if(span<=1)throw new Error('Gmail omitted pagination for a crowded day. Coverage is incomplete; the previous data was kept');
          const middle=modern?first+Math.floor((last-first)/2):new Date((first+Math.floor((last-first)/86400/2)*86400)*1000).toISOString().slice(0,10);
          pending.windows.splice(0,1,{since:middle,until:window.until},{since:window.since,until:middle});
          pending.pageToken=null;
          continue;
        }
        ids=page.ids;nextPageToken=page.nextPageToken;searched=true;
        if(!ids.length&&!nextPageToken){pending.windows.shift();pending.pageToken=null;searched=false;}
      }
      const known = new Set(previous.scannedIds), fresh = [...new Set(ids)].filter(id => !known.has(id));
      const processing = Object.assign(Object.create(null), Object.fromEntries([...known].filter(id => validProcessingRecord(previous.sourceProcessing?.[id])).map(id => [id, previous.sourceProcessing[id]])));
      const reviewing = modern && pending.kind === 'history_review';
      const scopedProcessing = reviewing || modern && pending.recentOnly === true;
      const retryPool = scopedProcessing ? [...new Set(ids)].filter(id=>known.has(id)) : [...known];
      const retries = retryPool.filter(id => processingDue(processing[id], parserVersion, now));
      const batch = [...fresh, ...retries].slice(0, maxReads), newEvents = [];
      let readCount = 0;
      const merged = new Map((previous.events || []).map(event => [event.id, event]));
      for (const [i, id] of batch.entries()) {
        onProgress('reading', i + 1, batch.length);
        const prior = processing[id];
        let message, parsed, reason = null, sourceReview = null;
        try {
          message = await gmail.message(id);
          readCount++;
          parsed = message.sourceContentUnavailable === true ? [] : await extract(message);
          if (!Array.isArray(parsed)) throw new Error('Receipt extraction did not return records');
        } catch (error) {
          if (error?.requiredTool) throw error;
          if (!known.has(id)) throw error;
          reason = message ? 'extraction_failed' : 'read_failed';
        }
        if (!reason) {
          const result = sourceMerger.merge({ events: merged, message, parsed, parserVersion, processingRecord:prior,
            sourceDigest:prior?.length===7?await sourceMerger.sourceFingerprint(message):null });
          newEvents.push(...result.newEvents); reason = result.reason; sourceReview = result.sourceReview || null;
        }
        processing[id] = nextProcessingRecord(prior, { parserVersion, now, reason, sourceReview });
        known.add(id);
      }
      const attempted = new Set(batch);
      const remaining=scopedProcessing ? [...fresh,...retries].filter(id=>!attempted.has(id)) : fresh.filter(id => !known.has(id));
      if(searched&&!remaining.length){
        if(nextPageToken)pending.pageToken=nextPageToken;
        else {pending.windows.shift();pending.pageToken=null;}
      }
      pending.ids=remaining;pending.nextPageToken=remaining.length?nextPageToken:null;
      const complete=!pending.windows.length&&!remaining.length;
      const events=[...merged.values()],completedAt=clock();
      const processingSummary = summarizeProcessing(known, processing, { parserVersion, now });
      const historyReview=modern && pending.kind==='history_review';
      const checkpoints={...(previous.discoveryCheckpoints || {})},historyVersions={...(previous.discoveryHistoryVersions || {})};
      if(complete && modern && pending.kind==='version_backfill')historyVersions[pending.includeSpamTrash?'anywhere':'default']=queryVersion;
      if(complete && modern && !historyReview)checkpoints[pending.includeSpamTrash?'anywhere':'default']=[queryVersion,pending.startedAt || startedAt];
      const completedRange=complete && modern?{since:pending.since,until:pending.until,includeSpamTrash:pending.includeSpamTrash,queryVersion,completedAt}:null;
      const lastReview=complete && historyReview?completedRange:previous.lastReview || null;
      const journalEntry=modern?completedRange:{query:pending.scopeQuery || null,completedAt};
      const state = { ...previous, version: 1, syncVersion:2, mailboxHash: identity, events, scannedIds: [...known],
        sourceProcessingFormat: 'tuple-v1', sourceProcessing: processing, parserVersion, processingSummary,
        queryVersion,discoveryCheckpoints:checkpoints,discoveryHistoryVersions:historyVersions,
        ...(complete&&modern?{discoveryCoverage:coverage(previous.discoveryCoverage,pending,completedAt),lastReview}:{}),
        ...(complete&&historyReview?{lastHistoryReviewAt:completedAt}:{}),
        lastAttemptAt: startedAt, savedAt: completedAt,
        lastCompletedAt: complete&&!historyReview ? completedAt : previous.lastCompletedAt || null,
        syncAnchorAt: complete&&!historyReview ? pending.startedAt || startedAt : previous.syncAnchorAt || null,
        queryCoverage: complete ? recentJournal(previous.queryCoverage,journalEntry) : previous.queryCoverage || [],
        pending: complete ? null : pending, updatesWhileClosed: false };
      await store.save(state);
      const readback = await store.load();
      if (readback?.savedAt !== state.savedAt || readback?.mailboxHash !== identity || canonical(readback?.events) !== canonical(events)
        || canonical(readback?.sourceProcessing) !== canonical(processing) || canonical(readback?.pending) !== canonical(state.pending)
        || canonical(readback?.discoveryCoverage ?? null)!==canonical(state.discoveryCoverage ?? null) || canonical(readback?.discoveryCheckpoints)!==canonical(state.discoveryCheckpoints) || canonical(readback?.discoveryHistoryVersions)!==canonical(state.discoveryHistoryVersions)) {
        throw new Error('Storage did not confirm this sync; reopen before retrying');
      }
      return { state: readback, complete, scanKind:modern?pending.kind:'legacy_discovery', recentOnly:modern&&pending.recentOnly===true, readCount, attemptedReadCount: batch.length, reprocessedCount: batch.filter(id => (previous.scannedIds || []).includes(id)).length,
        extractionPending: processingSummary.reprocessPending + processingSummary.retryPending, reviewCount: processingSummary.needsReview,
        addedEvidence: newEvents.filter(e => !(previous.events || []).some(old => old.id === e.id)).length };
    } finally { running = false; }
  }
  return { run };
}
