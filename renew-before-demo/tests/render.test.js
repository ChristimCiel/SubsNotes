import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../dist/data.js';
import { updateSubscription } from '../dist/domain.js';
import { renderApp, renderOverlay } from '../dist/views.js';

const ui = (changes = {}) => ({
  view: 'overview', filter: 'all', query: '', sort: 'date', period: 'monthly',
  modal: null, scanStep: 0, scanDone: false, rating: 0, showEvidence: false,
  feedbackMessage: '', ...changes,
});
const detail = (state, id, changes = {}) => renderOverlay(state, ui({ modal: { type: 'subscription', id }, ...changes }));

test('all routes render usable local screens with a focusable main destination', () => {
  for (const view of ['landing', 'overview', 'subscriptions', 'reminders']) {
    const html = renderApp(createInitialState(), ui({ view }));
    assert.match(html, /<main[^>]*id="main-content"[^>]*tabindex="-1"/);
    assert.match(html, /<h1>/);
    assert.doesNotMatch(html, /NaN|undefined|\[object Object\]/);
    assert.doesNotMatch(html, /(?:src|href)="https?:\/\//, 'demo screens do not connect to vendor accounts');
  }
});

test('dashboard distinguishes current monthly equivalent from actual future forecast', () => {
  const state = createInitialState();
  const monthly = renderApp(state, ui());
  const annual = renderApp(state, ui({ period: 'annual' }));
  assert.match(monthly, /Monthly equivalent/);
  assert.match(monthly, /\$73\.50/);
  assert.match(annual, /Next 12 months/);
  assert.match(annual, /\$965\.99/);
  assert.match(annual, /Based on renewal and offer schedules/);
  assert.match(annual, /Monthly equivalent/, 'category chart remains explicitly monthly under annual toggle');
});

test('different risks expose compatible complete actions rather than a generic keep button', () => {
  const state = createInitialState();
  const renewal = detail(state, 'notion');
  assert.match(renewal, /data-action="keep"/);
  assert.match(renewal, /data-action="cancel-intent"/);
  const promo = detail(state, 'canva');
  assert.match(promo, /data-action="reminder-settings"/);
  assert.match(promo, /data-action="cancel-intent"/);
  assert.doesNotMatch(promo, /data-action="keep"/);
  const payment = detail(state, 'github');
  assert.match(payment, /data-action="resolve-payment"/);
  assert.doesNotMatch(payment, /data-action="keep"/);
  assert.match(payment, /[Ss]imulat/);
});

test('cancellation intent and confirmation render as distinct states with retained access', () => {
  const intent = updateSubscription(createInitialState(), 'notion', 'cancel-intent');
  const intentHTML = detail(intent, 'notion');
  assert.match(intentHTML, /Cancellation is not confirmed/);
  assert.match(intentHTML, /data-action="simulate-cancel"/);
  const confirmed = updateSubscription(intent, 'notion', 'simulate-cancel');
  const confirmedHTML = detail(confirmed, 'notion');
  assert.match(confirmedHTML, /Sample access continues until Oct 28/);
  assert.match(confirmedHTML, /\$0\.00/);
  assert.doesNotMatch(confirmedHTML, /data-action="simulate-cancel"/);
  assert.match(confirmedHTML, /No real account was changed/);
});

test('future-year dates and historical failure evidence stay truthful after state changes', () => {
  const state = createInitialState();
  assert.match(detail(state, 'google-one'), /2027/);
  assert.match(detail(state, 'raycast'), /2027/);
  const resolved = updateSubscription(state, 'github', 'resolve-payment');
  const evidence = detail(resolved, 'github', { showEvidence: true });
  assert.match(evidence, /payment failed/);
  assert.match(evidence, /Action required: payment could not be processed/);
  assert.match(evidence, /Fictional email/);
});

test('untrusted local text is escaped in input, feedback, and evidence', () => {
  const attack = '<img src=x onerror="alert(1)">';
  const search = renderApp(createInitialState(), ui({ view: 'subscriptions', query: attack }));
  const feedback = renderOverlay(createInitialState(), ui({ modal: { type: 'feedback' }, feedbackMessage: attack }));
  const state = createInitialState();
  state.subscriptions[0].source = attack;
  const evidence = detail(state, 'notion', { showEvidence: true });
  for (const html of [search, feedback, evidence]) {
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img/);
  }
});

test('scan and feedback are explicitly simulated or locally stored', () => {
  const state = createInitialState();
  const scan = renderOverlay(state, ui({ modal: { type: 'scan' }, scanDone: true, scanStep: 3 }));
  assert.match(scan, /No inbox is being read/);
  assert.match(scan, /data-action="scan-finish"/);
  const feedback = renderOverlay(state, ui({ modal: { type: 'feedback' } }));
  assert.match(feedback, /not sent to the team automatically/);
  assert.match(feedback, /data-action="export"/);
  assert.match(feedback, /maxlength="2000" required/);
});


test('every built-in screen, dialog, and accessible label is English', () => {
  const state = createInitialState();
  const views = ['landing', 'overview', 'subscriptions', 'reminders'];
  const markup = views.map(view => renderApp(state, ui({ view })));
  for (const subscription of state.subscriptions) {
    markup.push(detail(state, subscription.id, { showEvidence: true }));
  }
  for (const type of ['scan', 'feedback', 'reset', 'export']) {
    markup.push(renderOverlay(state, ui({ modal: { type }, scanDone: true, scanStep: 3 })));
  }
  for (const html of markup) {
    assert.doesNotMatch(html, /[\p{Script=Han}]/u, 'built-in UI should not contain Chinese text');
  }
});
