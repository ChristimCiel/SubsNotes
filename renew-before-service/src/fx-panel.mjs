export function mountFxPanel({ root, runtime, totals, unconfirmedPayments = 0, language = 'en', formatMoney }) {
  let storage = null;
  try { storage = localStorage; } catch { /* Private browsing may disable storage. */ }
  const preferenceKey = 'renew-before.fx.display-currency.v1';
  let currency = 'USD';
  try { const saved = storage?.getItem(preferenceKey); if (runtime.currencies.includes(saved)) currency = saved; } catch { /* Use the default. */ }
  let lang = language, result = null, busy = false;
  const client = runtime.createRatesClient({ storage });
  const words = {
    en: { title: 'Your recorded spending', scope: 'All inspected receipts · refunds listed separately', display: 'Display in', total: 'Estimated total', partial: 'Estimated subtotal',
      refresh: 'Update rates', updating: 'Updating rates…', original: 'Original amounts', pending: 'Loading reference rates…', empty: 'No confirmed payments recorded',
      unavailable: 'Rates are unavailable. Original amounts are still shown below.', identity: 'No conversion is needed for these known amounts.', cached: 'Using saved reference rates.',
      offline: 'Could not update rates; using the last saved reference rates.', stale: 'These reference rates are more than 7 days old.',
      missing: 'Missing exchange rates for', excluded: 'payments need a currency and are not included.',
      note: 'Converted using the latest daily reference rates. Card settlement amounts and fees may differ.', date: 'Reference date', source: 'Source' },
    zh: { title: '已記錄的訂閱支出', scope: '所有已核對收據・退款另列', display: '統一顯示幣別', total: '估算總額', partial: '估算小計',
      refresh: '更新匯率', updating: '更新匯率中…', original: '原幣金額', pending: '載入參考匯率中…', empty: '尚無已確認的付款紀錄',
      unavailable: '暫時無法取得匯率，原幣金額仍保留在下方。', identity: '目前已知金額不需要換匯。', cached: '使用已儲存的參考匯率。',
      offline: '無法更新匯率，暫用上次儲存的參考匯率。', stale: '這份參考匯率已超過 7 天。',
      missing: '以下幣別缺少匯率', excluded: '筆付款需確認幣別，未計入。',
      note: '依最新每日參考匯率估算；信用卡實際換匯金額與手續費可能不同。', date: '匯率日期', source: '來源' }
  };
  const t = key => words[lang][key];
  const make = (tag, className = '') => { const element = document.createElement(tag); element.className = className; return element; };
  const head = make('div', 'fx-head'), heading = make('div'), title = make('h2'), scope = make('p', 'muted');
  heading.append(title, scope);
  const controls = make('div', 'fx-controls'), picker = make('div', 'fx-picker'), label = make('label'), labelText = make('span'), select = make('select'), refresh = make('button');
  select.id = 'fx-currency'; label.htmlFor = select.id;
  const preferred = ['USD', 'TWD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'HKD', 'SGD', 'CNY', 'KRW'];
  const codes = [...preferred, ...runtime.currencies.filter(code => !preferred.includes(code)).sort()];
  for (const code of codes) { const option = make('option'); option.value = code; option.textContent = code; select.append(option); }
  select.value = currency; label.append(labelText); picker.append(label, select); controls.append(picker, refresh); head.append(heading, controls);
  const totalLabel = make('p', 'fx-total-label'), total = make('div', 'fx-total'), status = make('p', 'fx-status'), note = make('p', 'fx-note');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const originalsTitle = make('p', 'fx-original-label'), originals = make('div', 'fx-originals');
  root.className = 'fx-panel'; root.append(head, totalLabel, total, status, note, originalsTitle, originals);
  function render() {
    const converted = runtime.convertTotals(totals, currency, result?.snapshot, { unconfirmedPayments });
    title.textContent = t('title'); root.setAttribute('aria-label', t('title')); scope.textContent = t('scope'); labelText.textContent = t('display');
    refresh.textContent = t(busy ? 'updating' : 'refresh'); refresh.disabled = busy || Object.keys(totals).length === 0;
    root.setAttribute('aria-busy', String(busy));
    totalLabel.textContent = t(converted.complete ? 'total' : 'partial');
    total.textContent = converted.minor === null ? (Object.keys(totals).length ? '—' : t('empty'))
      : (converted.rateDates.length ? '≈ ' : '') + formatMoney({ minor: converted.minor, currency });
    const messages = [];
    if (busy) messages.push(t('pending'));
    if (converted.rateDates.length) {
      const range = converted.rateDates.length === 1 ? converted.rateDates[0] : converted.rateDates[0] + ' – ' + converted.rateDates.at(-1);
      messages.push(t('date') + ': ' + range + ' · ' + t('source') + ': ' + runtime.sources[converted.provider].name + '.');
      if (result?.offline) messages.push(t('offline')); else if (result?.cached) messages.push(t('cached'));
      if (converted.stale) messages.push(t('stale'));
    } else if (!converted.missingCurrencies.length && Object.keys(totals).length) messages.push(t('identity'));
    if (converted.missingCurrencies.length && !busy) messages.push(result?.offline ? t('unavailable') : t('missing') + ': ' + converted.missingCurrencies.join(', ') + '.');
    if (unconfirmedPayments) messages.push(unconfirmedPayments + ' ' + t('excluded'));
    status.textContent = messages.join(' '); note.textContent = t('note'); originalsTitle.textContent = t('original');
    originals.replaceChildren();
    for (const [code, minor] of Object.entries(totals).sort(([a], [b]) => a.localeCompare(b))) {
      const chip = make('span'); chip.textContent = formatMoney({ minor, currency: code }); originals.append(chip);
    }
    originalsTitle.hidden = !Object.keys(totals).length;
  }
  async function update(force = false) {
    if (busy || !Object.keys(totals).length) return;
    if (!force && !Object.keys(totals).some(code => code !== currency)) { render(); return; }
    busy = true; render();
    try { result = await client.load({ force }); } finally { busy = false; render(); }
  }
  select.addEventListener('change', () => {
    currency = select.value;
    try { storage?.setItem(preferenceKey, currency); } catch { /* Keep the selection for this visit. */ }
    render(); if (!result?.snapshot) void update();
  });
  refresh.addEventListener('click', () => { void update(true); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void update(); });
  window.addEventListener('online', () => { if (result?.offline) void update(true); });
  render(); void update();
  return { setLanguage(value) { lang = value; render(); }, setVisible(value) { root.hidden = !value; } };
}
