import { randomUUID } from 'node:crypto';
import { billingQuery, decodeGmailMessage, GmailError, isBillingCandidate } from './gmail.mjs';
import { extractEvidence, dayOf } from './evidence.mjs';

async function mapLimited(items, concurrency, action) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await action(items[index]); }
  }));
  return results;
}

// Repository commits must atomically check the lease and persist events + cursor.
// A failed page is replayed; event IDs make replay idempotent.
export async function runSync({ gmail, repository, ownerId, now = () => new Date().toISOString(), maxPages = 2 }) {
  const lease = randomUUID();
  if (!await repository.acquire(ownerId, lease, now())) return { status: 'already_running' };
  let state;
  try {
    state = await repository.getState(ownerId);
    const profile = await gmail.profile();
    if (state?.email && state.email.toLowerCase() !== profile.emailAddress.toLowerCase()) throw new Error('Connected Gmail identity changed. Reconnect the intended account.');
    if (!state) {
      const start = new Date(now()); start.setUTCFullYear(start.getUTCFullYear() - 2);
      state = { email: profile.emailAddress, phase: 'backfill', since: dayOf(start.toISOString()), query: billingQuery(dayOf(start.toISOString())), anchorHistoryId: profile.historyId, pageToken: null, historyId: null, processedMessages: 0, retainedEvents: 0, startedAt: now() };
      await repository.commit(ownerId, lease, [], state);
    }
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      let page, ids;
      const backfill = state.phase === 'backfill';
      try {
        page = backfill ? await gmail.list({ query: state.query, pageToken: state.pageToken }) : await gmail.history({ historyId: state.historyId, pageToken: state.pageToken });
      } catch (error) {
        if (!backfill && error instanceof GmailError && error.status === 404) {
          state = { ...state, phase: 'backfill', anchorHistoryId: profile.historyId, pageToken: null, lastError: null, recoveryReason: 'history_expired', coverageComplete: false };
          await repository.commit(ownerId, lease, [], state);
          continue;
        }
        throw error;
      }
      ids = backfill ? (page.messages || []).map(m => m.id) : (page.history || []).flatMap(h => (h.messagesAdded || []).map(m => m.message.id));
      ids = [...new Set(ids)];
      const outcomes = await mapLimited(ids, 4, async id => {
        try {
          if (!backfill) {
            const metadata = await gmail.metadata(id);
            if (!isBillingCandidate(metadata.payload?.headers)) return { events: [], excluded: true };
          }
          const raw = await gmail.message(id);
          const normalized = decodeGmailMessage(raw, profile.emailAddress);
          if (!isBillingCandidate(raw.payload?.headers)) return { events: [], excluded: true };
          const events = extractEvidence(normalized).map(e => ({ ...e, parserVersion: '0.1.0', attachmentCount: normalized.attachmentCount, bodyTruncated: normalized.truncated }));
          return { events, reviewNeeded: normalized.truncated || normalized.attachmentCount > 0 && events.every(e => !e.payment && !e.nextBilling && !e.accessEnds) };
        } catch (error) {
          if (error instanceof GmailError && error.status === 404) return { events: [], disappeared: true };
          throw error;
        }
      });
      const events = outcomes.flatMap(o => o.events);
      const complete = !page.nextPageToken;
      state = {
        ...state, lastAttemptAt: now(), lastError: null, pageToken: page.nextPageToken || null,
        processedMessages: state.processedMessages + ids.length,
        retainedEvents: state.retainedEvents + events.length,
        attachmentReviewCount: (state.attachmentReviewCount || 0) + outcomes.filter(o => o.reviewNeeded).length,
        unavailableMessageCount: (state.unavailableMessageCount || 0) + outcomes.filter(o => o.disappeared).length,
        coverageComplete: backfill ? complete : state.coverageComplete
      };
      if (complete && backfill) state = { ...state, phase: 'incremental', historyId: state.anchorHistoryId, backfillCompletedAt: now() };
      else if (complete) state = { ...state, historyId: page.historyId || state.historyId, lastSuccessAt: now(), recoveryReason: null };
      await repository.commit(ownerId, lease, events, state);
      if (complete) break;
    }
    return { status: state.phase === 'backfill' || state.pageToken || state.recoveryReason || !state.lastSuccessAt ? 'catching_up' : 'updated', state };
  } catch (error) {
    await repository.recordFailure(ownerId, lease, {
      at: now(), code: error instanceof GmailError ? error.status : 'sync_failed',
      message: error instanceof GmailError ? error.message : 'Sync did not finish. The last successful cursor was preserved.',
      reconnectRequired: error instanceof GmailError && [401, 403].includes(error.status)
    });
    throw error;
  } finally { await repository.release(ownerId, lease); }
}
