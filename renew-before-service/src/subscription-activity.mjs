// Documentary service periods and actual payments answer different questions.
// This runtime derives a read view from the existing ledger; it writes nothing.
export function createSubscriptionActivityRuntime() {
  const day = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  const monthValid = value => typeof value === 'string' && /^20\d{2}-(?:0[1-9]|1[0-2])$/.test(value);
  const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const scope = event => event.accountRef ? event.serviceKey+'|account:'+encodeURIComponent(event.accountRef) : event.serviceKey;
  const kinds = new Set(['payment_succeeded','subscription_confirmed','trial_confirmed','invoice_recorded','renewal_notice','renewal_disabled','payment_failed','access_paused','access_expiring','access_expired','refund_recorded','refund_pending','account_not_subscribed']);
  const unique = values => [...new Set(values.filter(Boolean))];
  const transaction = event => event.transactionRef || event.reference || null;
  const nextMonth = month => { const d = new Date(month+'-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth()+1); return d.toISOString().slice(0,7); };
  const overlap = (period, month) => !month || period.start < nextMonth(month)+'-01' && period.end > month+'-01';
  const boundary = (period, month) => month && period.end === month+'-01';
  const meaningful = event => !['account_not_subscribed','refund_recorded','refund_pending'].includes(event.kind) && event.sourceFact !== 'future_credit';
  const positive = event => ['payment_succeeded','subscription_confirmed','trial_confirmed'].includes(event.kind);
  function build({events, snapshot = null, month = null, trustConnectorReads = false, asOf = new Date().toISOString(), timeZone = 'UTC'} = {}) {
    if (!Array.isArray(events)) throw new Error('An existing event ledger is required');
    if (month !== null && !monthValid(month)) throw new Error('Use a calendar month in YYYY-MM format');
    const evaluated = new Date(asOf); if (!Number.isFinite(evaluated.getTime())) throw new Error('A valid evaluation time is required');
    const formatter = new Intl.DateTimeFormat('en',{timeZone,year:'numeric',month:'2-digit'});
    const sourceMonth = value => {const parts=formatter.formatToParts(new Date(value));return parts.find(part=>part.type==='year').value+'-'+parts.find(part=>part.type==='month').value;};
    const todayMonth = sourceMonth(evaluated), first = new Date(todayMonth+'-01T00:00:00Z'); first.setUTCMonth(first.getUTCMonth()-119);
    const firstMonth = first.toISOString().slice(0,7), months = new Set([todayMonth]), groups = new Map(), canonicalScopes = new Map();
    const current = new Map([...(snapshot?.subscriptions || []),...(snapshot?.excludedServices || [])].map(row=>[row.serviceKey,row]));
    for (const row of current.values()) for (const id of row.evidenceIds || []) canonicalScopes.set(id,row.serviceKey);
    const heldIds = new Set((snapshot?.heldEvidence || []).map(event=>event.id));
    for(const event of [...(snapshot?.payments || []),...(snapshot?.refunds || [])])if(event.conflict===true)for(const id of [event.id,...(event.duplicateEvidenceIds || [])])heldIds.add(id);
    const conflicts = new Set(); const byId = new Map();
    for (const event of events) {
      if (!event || typeof event.id !== 'string') continue;
      if (byId.has(event.id) && JSON.stringify(byId.get(event.id)) !== JSON.stringify(event)) conflicts.add(event.id);
      else byId.set(event.id,event);
    }
    let rejectedCount = 0, monthsLimited = false;
    const remember = value => { if (!monthValid(value)) return; if(value < firstMonth || value > todayMonth){monthsLimited=true;return;} months.add(value); };
    const held = event => conflicts.has(event.id) || heldIds.has(event.id) || event.conflict === true || event.sourceProcessingConflict === true
      || event.candidateStatus === 'needs_review' || event.importStatus === 'needs_source_recheck';
    for (const event of byId.values()) {
      if (!kinds.has(event.kind) || !event.serviceKey || ['Donations','One-time purchases','Unclassified'].includes(event.category)) continue;
      const trusted = event.authenticated === true || event.userVerified === true || trustConnectorReads === true
        && event.sourceFormat === 'claude_plaintext' && instant(event.sourceReadAt);
      if (!trusted || !instant(event.receivedAt)) { rejectedCount++; continue; }
      const key = canonicalScopes.get(event.id) || scope(event);
      if (!groups.has(key)) groups.set(key,{serviceKey:key,providerServiceKey:event.serviceKey,name:event.service || event.serviceKey,events:[]});
      groups.get(key).events.push(event);
      remember(sourceMonth(event.receivedAt));
    }
    const matches = [], unmatched = [];
    for (const group of groups.values()) {
      const sources = group.events.sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
      if (!sources.some(meaningful)) continue;
      const warnings = new Set(), intervals = [], periodEvents = new Set(), periodsByReference = new Map();
      for (const event of sources) {
        const period = event.period;
        if (!period || !day(period.start) || !day(period.end) || period.start >= period.end) continue;
        if (!['payment_succeeded','subscription_confirmed','trial_confirmed','invoice_recorded'].includes(event.kind)) continue;
        periodEvents.add(event.id);
        const interval = {start:period.start,end:period.end,kind:event.kind,basis:event.kind==='invoice_recorded'?'invoice_period':event.kind==='trial_confirmed'?'trial_period':'recorded_service_period',
          evidenceIds:[event.id],messageIds:unique([event.messageId]),held:held(event),possible:event.kind==='invoice_recorded' || held(event),receivedAt:event.receivedAt,reference:transaction(event)};
        if (interval.held) warnings.add('source_needs_review');
        if (event.kind==='invoice_recorded') warnings.add('invoice_does_not_confirm_access');
        if (interval.reference) { if(!periodsByReference.has(interval.reference))periodsByReference.set(interval.reference,new Set()); periodsByReference.get(interval.reference).add(period.start+'|'+period.end); }
        intervals.push(interval);
      }
      for (const interval of intervals) {
        if (interval.reference && periodsByReference.get(interval.reference).size > 1) {interval.possible=true;warnings.add('conflicting_service_periods');}
        for (const event of sources) {
          if (held(event) || !day(event.accessEnds) || event.receivedAt < interval.receivedAt || event.accessEnds >= interval.end) continue;
          if (event.kind==='access_expired' && event.accessEnds >= interval.start) {
            interval.originalEnd ||= interval.end; interval.end=event.accessEnds;
            interval.evidenceIds=unique([...interval.evidenceIds,event.id]);interval.messageIds=unique([...interval.messageIds,event.messageId]);
            warnings.add('explicit_expiry_limits_recorded_period');
          } else if (event.kind==='renewal_disabled') { interval.possible=true;warnings.add('conflicting_access_end'); }
        }
        const lower = interval.start.slice(0,7) < firstMonth ? firstMonth : interval.start.slice(0,7);
        const upper = interval.end.slice(0,7) > todayMonth ? todayMonth : interval.end.slice(0,7);
        if(interval.start.slice(0,7)<firstMonth || interval.end.slice(0,7)>todayMonth)monthsLimited=true;
        if(interval.start < interval.end)for(let m=lower,steps=0;m<=upper&&steps<120;m=nextMonth(m),steps++)remember(m);
      }
      const relevant = sources.filter(event=>meaningful(event) && event.sourceFact !== 'future_credit');
      const unknownEpisodes = relevant.filter(event=>!periodEvents.has(event.id) && positive(event)
        && !intervals.some(interval=>event.messageId && interval.messageIds.includes(event.messageId) || transaction(event) && transaction(event)===interval.reference));
      const validIntervals = intervals.filter(interval=>interval.start < interval.end);
      const overlapping = validIntervals.filter(interval=>overlap(interval,month));
      const boundaryIntervals = validIntervals.filter(interval=>boundary(interval,month));
      if(boundaryIntervals.length)warnings.add('end_day_boundary_uncertain');
      const monthEvidence = month ? relevant.filter(event=>sourceMonth(event.receivedAt)===month
        && (!periodEvents.has(event.id) || [...overlapping,...boundaryIntervals].some(interval=>interval.evidenceIds.includes(event.id)))
        && !(event.kind==='access_expired' && day(event.accessEnds) && event.accessEnds < month+'-01')) : relevant;
      const usable = overlapping.filter(interval=>!interval.possible);
      const hasUnknown = !intervals.length || unknownEpisodes.length > 0;
      let classification = usable.length ? 'documented_period' : overlapping.length || boundaryIntervals.length || monthEvidence.length ? 'month_evidence' : hasUnknown ? 'period_unknown' : 'outside_period';
      const lastExpiry=sources.filter(event=>event.kind==='access_expired' && !held(event) && day(event.accessEnds)).at(-1);
      if(month && lastExpiry?.accessEnds < month+'-01' && !overlapping.length && !boundaryIntervals.length
        && !relevant.some(event=>positive(event) && (day(event.paymentDay)?event.paymentDay:event.receivedAt.slice(0,10)) > lastExpiry.accessEnds)
        && !monthEvidence.length) classification='outside_period';
      if (sources.some(event=>['refund_recorded','refund_pending'].includes(event.kind))) warnings.add('refund_does_not_establish_access_end');
      if (sources.some(event=>event.sourceRequiresDocumentReview===true)) warnings.add('document_review');
      if (sources.some(event=>event.productUnconfirmed===true)) warnings.add('product_unconfirmed');
      if (sources.some(event=>event.accessType==='education'))warnings.add('education_access');
      if (sources.some(event=>event.kind==='trial_confirmed'))warnings.add('trial_not_confirmed_paid');
      if (sources.some(event=>event.sourceFact==='future_credit'))warnings.add('future_credit_is_not_payment');
      if (sources.some(event=>held(event)))warnings.add('source_needs_review');
      const includedSources = unique([...overlapping.flatMap(interval=>interval.evidenceIds),...boundaryIntervals.flatMap(interval=>interval.evidenceIds),...monthEvidence.map(event=>event.id),...unknownEpisodes.map(event=>event.id)]);
      const row = {serviceKey:group.serviceKey,providerServiceKey:group.providerServiceKey,name:group.name,classification,
        intervals:validIntervals.map(({held,possible,receivedAt,reference,...interval})=>({...interval,classification:possible?'possible_period':'documented_period'})),
        evidenceIds:includedSources.length?includedSources:relevant.map(event=>event.id),messageIds:unique(sources.filter(event=>includedSources.includes(event.id)).map(event=>event.messageId)),
        currentStatus:current.get(group.serviceKey)?.status || null,accessType:sources.findLast(event=>event.accessType)?.accessType || (sources.some(event=>event.kind==='trial_confirmed')?'trial':null),
        warnings:[...warnings],liveAccessVerified:false};
      (classification==='outside_period'?unmatched:matches).push(row);
    }
    matches.sort((a,b)=>a.name.localeCompare(b.name));unmatched.sort((a,b)=>a.name.localeCompare(b.name));
    return {month,timeZone,asOf:evaluated.toISOString(),matches,unmatched,months:[...months].sort().reverse(),monthsLimited,
      documentedCount:matches.filter(row=>row.classification==='documented_period').length,candidateCount:matches.filter(row=>row.classification!=='documented_period').length,
      unallocatedCount:matches.filter(row=>row.classification==='period_unknown').length,rejectedCount,basis:'retrospective_recorded_evidence',liveAccessVerified:false};
  }
  return {build};
}
