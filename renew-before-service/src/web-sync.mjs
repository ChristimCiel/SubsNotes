import { preserveReceiptVerification } from './receipt-verification.mjs';
import { createLedgerContracts } from './ledger-contracts.mjs';

// Both full discovery and targeted assistant reads use this source-scoped
// merge. Dependencies are explicit so the same function runs in the Artifact.
export function createSourceEvidenceMerger({ preserveReceiptVerification, billingExcerpt }) {
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
    if (!String(message.text || '').trim()) return 'empty_body';
    if (message.truncated) return 'truncated_body';
    if (!events.length) return 'unrecognized_format';
    if (events.some(event => event.sourceProcessingConflict)) return 'source_reclassified';
    if (events.some(event => event.sourceRequiresDocumentReview && !reviewed(event) || event.kind === 'unclassified_purchase')) return 'document_review';
    for (const event of events) {
      const key = family(event);
      if (key && !Number.isSafeInteger(event[key]?.minor)) return 'amount_unknown';
      if (key && !event[key]?.currency || event.currencyAmbiguous) return 'currency_unknown';
      if (event.kind === 'payment_succeeded' && !event.paymentDay) return 'payment_date_unknown';
      if (event.kind === 'refund_recorded' && !event.refundDay) return 'refund_date_unknown';
    }
    return null;
  }
  function merge({ events, message, parsed, parserVersion = '3' }) {
    if (!(events instanceof Map) || !message?.id || !Array.isArray(parsed)) throw new Error('Observed source and parsed records are required');
    if (typeof parserVersion !== 'string' || !parserVersion.trim() || parserVersion.length > 24) throw new Error('A bounded parser version is required');
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
      if (previousRecord && (previousRecord.messageId !== event.messageId || previousRecord.serviceKey !== event.serviceKey || !sameTransaction(previousRecord, event))) {
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
    return { newEvents, reason: identityConflict ? 'source_identity_conflict' : conflict ? 'reviewed_source_conflict' : unresolvedReason(message, parsed.length ? sourceEvents : []) || (incomplete ? 'incomplete_reread' : null) };
  }
  const retryLimit = 3, day = 86400000;
  const validProcessingRecord = record => Array.isArray(record) && record.length === 6 && typeof record[0] === 'string'
    && ['extracted', 'needs_review'].includes(record[1]) && Number.isInteger(record[2]) && record[2] > 0 && record[2] <= retryLimit
    && Number.isFinite(record[3]) && (record[4] === null || Number.isFinite(record[4])) && (record[5] === null || typeof record[5] === 'string');
  const processingDue = (record, parserVersion, now) => !validProcessingRecord(record) || record[0] !== parserVersion || record[1] === 'needs_review'
    && record[2] < retryLimit && record[4] !== null && record[4] <= now;
  function nextProcessingRecord(previous, { parserVersion, now, reason }) {
    const attempts = validProcessingRecord(previous) && previous[0] === parserVersion ? Math.min(retryLimit, previous[2] + 1) : 1;
    return [parserVersion, reason ? 'needs_review' : 'extracted', attempts, now,
      reason && attempts < retryLimit ? now + (attempts === 1 ? day : 3 * day) : null, reason];
  }
  function summarizeProcessing(known, processing, { parserVersion, now }) {
    const records = [...known].map(id => validProcessingRecord(processing[id]) ? processing[id] : null);
    return { read: known.size,
      extracted: records.filter(record => record?.[0] === parserVersion && record[1] === 'extracted').length,
      needsReview: records.filter(record => record?.[0] === parserVersion && record[1] === 'needs_review').length,
      retryPending: records.filter(record => record?.[0] === parserVersion && record[1] === 'needs_review' && record[2] < retryLimit).length,
      retryDue: records.filter(record => record?.[0] === parserVersion && processingDue(record, parserVersion, now)).length,
      retryExhausted: records.filter(record => record?.[0] === parserVersion && record[1] === 'needs_review' && record[2] >= retryLimit).length,
      reprocessPending: records.filter(record => !record || record[0] !== parserVersion).length };
  }
  return { merge, validProcessingRecord, processingDue, nextProcessingRecord, summarizeProcessing };
}

// Platform adapters are injected. Financial state is saved only after a whole
// bounded page was read successfully; failures preserve the prior checkpoint.
export function createWebSync({ gmail, store, extract, hash, clock = () => new Date().toISOString(), onProgress = () => {}, parserVersion = '3' }) {
  let running = false;
  const { billingExcerpt, canonicalJSON: canonical } = createLedgerContracts();
  const sourceMerger = createSourceEvidenceMerger({ preserveReceiptVerification, billingExcerpt });
  const { validProcessingRecord, processingDue, nextProcessingRecord, summarizeProcessing } = sourceMerger;
  if (typeof parserVersion !== 'string' || !parserVersion.trim() || parserVersion.length > 24) throw new Error('A bounded parser version is required');
  // Compact tuples keep source bookkeeping below the host's document limit:
  // [parser version, status, attempts, last attempt epoch, retry epoch, reason].
  // scannedIds still means retrieved, never successfully understood.
  function query(since, until) {
    return `after:${since.replaceAll('-', '/')} before:${until.replaceAll('-', '/')} -in:sent {subject:receipt subject:invoice subject:eGUI subject:subscription subject:membership subject:renew subject:renewal subject:expiration subject:registered subject:payment subject:refund subject:cancelled subject:canceled subject:cancellation subject:expire subject:trial subject:收據 subject:發票 subject:訂閱 subject:續訂 subject:付款 subject:退款 subject:取消 subject:試用 subject:到期}`;
  }
  async function run({ maxReads = 20 } = {}) {
    if (running) throw new Error('A sync is already running');
    if (!Number.isInteger(maxReads) || maxReads < 1 || maxReads > 100) throw new Error('maxReads must be between 1 and 100');
    running = true;
    try {
      const previous = await store.load() || { version: 1, events: [], scannedIds: [], prefs: {} };
      const identity = await hash(await gmail.identity());
      if (previous.mailboxHash && previous.mailboxHash !== identity) throw new Error('The connected Gmail account changed; the saved data was kept separate');
      const startedAt = clock(), date = new Date(startedAt), now = date.getTime();
      if (!Number.isFinite(now)) throw new Error('A valid sync time is required');
      const until = new Date(date); until.setUTCDate(until.getUTCDate() + 1);
      // Resume from the start of the completed scan, not its finish time: a
      // backfill can take days, with new mail arriving in already-read windows.
      const checkpoint = previous.syncVersion === 2 ? previous.syncAnchorAt || previous.lastCompletedAt : null;
      const start = checkpoint ? new Date(Date.parse(checkpoint) - 2 * 86400000) : new Date(date);
      if (!checkpoint) start.setUTCFullYear(start.getUTCFullYear() - 2);
      // This connector can omit continuation tokens even for a full page.
      // Split date windows instead of calling a missing token "complete".
      const pending = previous.pending?.mode === 'windows-v2' ? structuredClone(previous.pending) : {
        mode:'windows-v2', scopeQuery:query(start.toISOString().slice(0,10),until.toISOString().slice(0,10)), windows:[{since:start.toISOString().slice(0,10),until:until.toISOString().slice(0,10)}],
        pageToken:null, ids:[], nextPageToken:null, startedAt
      };
      let ids=[...pending.ids], nextPageToken=pending.nextPageToken, searched=ids.length>0;
      for(let attempt=0;!ids.length && pending.windows.length && attempt<4;attempt++) {
        const window=pending.windows[0];
        const span=(Date.parse(window.until)-Date.parse(window.since))/86400000;
        onProgress('searching');
        const page=await gmail.search({query:query(window.since,window.until),pageToken:pending.pageToken,pageSize:span<=1?50:10});
        if(page.paginationUnknown&&!page.nextPageToken) {
          if(span<=1)throw new Error('Gmail omitted pagination for a crowded day. Coverage is incomplete; the previous data was kept');
          const middle=new Date(Date.parse(window.since)+Math.floor(span/2)*86400000).toISOString().slice(0,10);
          pending.windows.splice(0,1,{since:middle,until:window.until},{since:window.since,until:middle});
          pending.pageToken=null;
          continue;
        }
        ids=page.ids;nextPageToken=page.nextPageToken;searched=true;
        if(!ids.length&&!nextPageToken){pending.windows.shift();pending.pageToken=null;searched=false;}
      }
      const known = new Set(previous.scannedIds), fresh = [...new Set(ids)].filter(id => !known.has(id));
      const processing = Object.assign(Object.create(null), Object.fromEntries([...known].filter(id => validProcessingRecord(previous.sourceProcessing?.[id])).map(id => [id, previous.sourceProcessing[id]])));
      const retries = [...known].filter(id => processingDue(processing[id], parserVersion, now));
      // New messages take priority; old sources are replayed in bounded batches
      // after a parser upgrade, including legacy reads that produced no events.
      const batch = [...fresh, ...retries].slice(0, maxReads), newEvents = [];
      let readCount = 0;
      const merged = new Map((previous.events || []).map(event => [event.id, event]));
      for (const [i, id] of batch.entries()) {
        onProgress('reading', i + 1, batch.length);
        const prior = processing[id];
        let message, parsed, reason = null;
        try {
          message = await gmail.message(id);
          readCount++;
          parsed = await extract(message);
          if (!Array.isArray(parsed)) throw new Error('Receipt extraction did not return records');
        } catch (error) {
          // A headless host suspends here to perform the real tool call. This
          // is control flow, never a failed provider read or a saved attempt.
          if (error?.requiredTool) throw error;
          // Required new reads remain atomic. Failed reprocessing is bounded,
          // preserves the earlier evidence, and cannot block all new mail.
          if (!known.has(id)) throw error;
          reason = message ? 'extraction_failed' : 'read_failed';
        }
        if (!reason) {
          const result = sourceMerger.merge({ events: merged, message, parsed, parserVersion });
          newEvents.push(...result.newEvents); reason = result.reason;
        }
        processing[id] = nextProcessingRecord(prior, { parserVersion, now, reason });
        known.add(id);
      }
      const remaining=fresh.filter(id => !known.has(id));
      if(searched&&!remaining.length){
        if(nextPageToken)pending.pageToken=nextPageToken;
        else {pending.windows.shift();pending.pageToken=null;}
      }
      pending.ids=remaining;pending.nextPageToken=remaining.length?nextPageToken:null;
      const complete=!pending.windows.length&&!remaining.length;
      const events=[...merged.values()];
      const processingSummary = summarizeProcessing(known, processing, { parserVersion, now });
      const state = { ...previous, version: 1, syncVersion:2, mailboxHash: identity, events, scannedIds: [...known],
        sourceProcessingFormat: 'tuple-v1', sourceProcessing: processing, parserVersion, processingSummary,
        lastAttemptAt: startedAt, savedAt: clock(),
        lastCompletedAt: complete ? clock() : previous.lastCompletedAt || null,
        syncAnchorAt: complete ? pending.startedAt || startedAt : previous.syncAnchorAt || null,
        queryCoverage: [...(previous.queryCoverage || []), ...(complete ? [{ query:pending.scopeQuery||null,completedAt:clock() }] : [])].slice(-20),
        pending: complete ? null : pending, updatesWhileClosed: false };
      await store.save(state);
      const readback = await store.load();
      if (readback?.savedAt !== state.savedAt || readback?.mailboxHash !== identity || canonical(readback?.events) !== canonical(events)
        || canonical(readback?.sourceProcessing) !== canonical(processing) || canonical(readback?.pending) !== canonical(state.pending)) {
        throw new Error('Storage did not confirm this sync; reopen before retrying');
      }
      return { state: readback, complete, readCount, attemptedReadCount: batch.length, reprocessedCount: batch.filter(id => (previous.scannedIds || []).includes(id)).length,
        extractionPending: processingSummary.reprocessPending + processingSummary.retryPending, reviewCount: processingSummary.needsReview,
        addedEvidence: newEvents.filter(e => !(previous.events || []).some(old => old.id === e.id)).length };
    } finally { running = false; }
  }
  return { run };
}
