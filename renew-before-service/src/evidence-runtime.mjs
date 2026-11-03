import { createLedgerContracts } from './ledger-contracts.mjs';
// The same deterministic receipt rules run in Node and in Claude web.
export function createEvidenceRuntime(digest, contracts = createLedgerContracts()) {
  if (typeof digest !== 'function') throw new Error('A stable digest function is required');
  const {billingExcerpt} = contracts;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const dayOf = instant => new Date(instant).toISOString().slice(0, 10);
const ISO_CURRENCIES = Intl.supportedValuesOf('currency');
const CURRENCY_MARKERS = ISO_CURRENCIES.join('|') + '|NT\\$|US\\$|CA\\$|AU\\$|€|£|\\$';
const currencyDecimals = currency => currency ? new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits : 2;
function parseDay(value) {
  if (!value) return null;
  value = value.replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1');
  const iso = value.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const day = iso[0];
    return !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day ? day : null;
  }
  const named = value.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (named) {
    const month = MONTHS[named[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    const candidate = `${named[3]}-${String(month).padStart(2, '0')}-${named[2].padStart(2, '0')}`;
    return parseDay(candidate);
  }
  const chinese = value.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (chinese) return parseDay(`${chinese[1]}-${chinese[2].padStart(2, '0')}-${chinese[3].padStart(2, '0')}`);
  const dayFirst = value.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d{2})\b/);
  return dayFirst ? parseDay(`${dayFirst[2]} ${dayFirst[1]}, ${dayFirst[3]}`) : null;
}

function money(raw, currencyHint = null, numberLocale = null) {
  if (!raw) return null;
  const matched = raw.match(new RegExp('(' + CURRENCY_MARKERS + ')\\s*(\\d[\\d,.\\u00a0\\u202f ]*)', 'i'));
  if (!matched) return null;
  const marker = matched[1].toUpperCase();
  const currencies = { 'NT$': 'TWD', 'US$': 'USD', 'CA$': 'CAD', 'AU$': 'AUD', '€': 'EUR', '£': 'GBP' };
  const currency = marker === '$' ? currencyHint : currencies[marker] ?? marker;
  const decimals = currencyDecimals(currency);
  let numeric = matched[2].trim();
  if (numberLocale) {
    const parts = new Intl.NumberFormat(numberLocale).formatToParts(1234.5);
    const group = parts.find(p => p.type === 'group')?.value;
    const decimal = parts.find(p => p.type === 'decimal')?.value;
    if (group) numeric = numeric.replaceAll(group, '');
    if (decimal && decimal !== '.') numeric = numeric.replaceAll(decimal, '.');
  } else {
    // Without a stated number locale accept invariant English receipt grouping;
    // reject decimal-comma or mixed formats rather than multiplying the charge.
    if (numeric.includes(',') && !/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(numeric)) return null;
    numeric = numeric.replaceAll(',', '');
  }
  if (!/^\d+(?:\.\d+)?$/.test(numeric)) return null;
  const [integer, fraction = ''] = numeric.split('.');
  if (fraction.length > decimals && Number(fraction) !== 0) return null;
  if (decimals === 0 && Number(fraction) > 0) return null;
  const minor = Number(integer) * 10 ** decimals + (decimals ? Number(fraction.padEnd(decimals, '0')) : 0);
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  return { minor, currency: currency || null, source: matched[0] };
}

function htmlToText(html = '') {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '')
    .replace(/&#x([a-f0-9]+);/gi, (_, n) => Number.parseInt(n, 16) <= 0x10ffff ? String.fromCodePoint(Number.parseInt(n, 16)) : '')
    .replace(/&zwnj;|&zwj;/gi, '')
    .replace(/[\u034f\u200b-\u200f]/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

function normalizedMessage(message) {
  const content = message.text || message.body || htmlToText(message.html);
  return { ...message, text: content.replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : '').replace(/[\u034f\u200b-\u200f\ufeff]/g, '').replace(/\r/g, '').replace(/\*\*/g, '') };
}

function issuer(message) {
  const sender = message.sender.toLowerCase();
  const subject = message.subject;
  const text = message.text;
  const domain = sender.match(/@([a-z0-9.-]+)/)?.[1] ?? '';
  const from = root => domain === root || domain.endsWith('.' + root);
  if (from('tax.openai.com')) return { key: 'openai-unknown-product', name: 'OpenAI · invoice needs review', category: 'Unclassified', domain };
  if(from('adobe.com')){
    const body=subject+' '+text,stock=/Adobe Stock/i.test(body),creative=/Creative Cloud Pro|ADOBE CREATIVE CLOUD/i.test(body);
    if(stock&&creative)return {key:'adobe-multiple-products',name:'Adobe · multiple products need review',category:'Unclassified',domain};
    if(creative)return {key:'adobe-creative-cloud',name:'Adobe Creative Cloud',category:'Software',domain};
    if(stock)return {key:'adobe-stock',name:'Adobe Stock',category:'Software',domain};
    return {key:'adobe-unknown-product',name:'Adobe · product needs review',category:'Unclassified',domain};
  }
  const names = [
    ['anthropic.com', 'claude', 'Claude'], ['openai.com', 'chatgpt', 'ChatGPT'],
    ['suno.com', 'suno', 'Suno'], ['meshy.ai', 'meshy', 'Meshy'],
    ['vocalimage.net', 'vocal-image', 'Vocal Image'], ['personalityhub.ai', 'animaltypes', 'AnimalTypes'],
    ['mobbin.com', 'mobbin', 'Mobbin'], ['capcut.com', 'capcut', 'CapCut'],
    ['youtube.com', 'youtube-premium', 'YouTube Premium'], ['github.com', 'github', 'GitHub'],
    ['replit.com', 'replit', 'Replit'], ['notion.so', 'notion', 'Notion'], ['figma.com', 'figma', 'Figma'],
    ['gumlet.com', 'gumlet', 'Gumlet'], ['linear.app', 'linear', 'Linear'], ['assembla.com', 'assembla', 'Assembla'],
    ['cursor.com', 'cursor', 'Cursor'], ['surfshark.com', 'surfshark', 'Surfshark'],
    ['microsoft.com', 'microsoft-365', 'Microsoft 365'],
    ['mintmobile.com', 'mint-mobile', 'Mint Mobile'], ['perplexity.ai', 'perplexity', 'Perplexity']
  ];
  if (from('cloudflare.com')) {
    const name = (subject + ' ' + text).match(/\b([a-z0-9-]+\.(?:com|co|io|net|org|ai|app|dev))\b/i)?.[1];
    return { key: `cloudflare:${name?.toLowerCase() || 'unknown-domain'}`, name: name ? `Cloudflare · ${name}` : 'Cloudflare Registrar', category: 'Domains', domain };
  }
  if (domain === 'paddle.com' || domain.endsWith('.paddle.com')) {
    if (/Vibe Tech|逐字飽/.test(subject + text)) return { key: 'vibe-transcription', name: '逐字飽', category: 'Productivity', domain };
    if (/\bn8n\b|Cloud Start Yearly/.test(subject + text)) return { key: 'n8n', name: 'n8n', category: 'Automation', domain };
  }
  if (domain === 'stripe.com') {
    for (const [pattern, key, name] of [
      [/receipt from Meshy/i, 'meshy', 'Meshy'], [/receipt from X\b/i, 'x-premium', 'X Premium'],
      [/Replit/i, 'replit', 'Replit'], [/Linear Orbit/i, 'linear', 'Linear'], [/Assembla/i, 'assembla', 'Assembla'],
      [/NOVASCENT/i, 'novascent', 'NOVASCENT'], [/Cursor/i, 'cursor', 'Cursor']
    ]) if (pattern.test(subject)) return { key, name, category: 'Software', domain };
  }
  for (const [root, key, name] of names) if (domain === root || domain.endsWith('.' + root)) {
    return { key, name, category: ['claude','chatgpt'].includes(key) ? 'AI tools' : 'Software', domain };
  }
  if (from('lalamove.com')) return { key: 'lalamove', name: 'Lalamove', category: 'One-time purchases', domain };
  if (from('evaair.com')) return { key: 'eva-airways', name: 'EVA Airways', category: 'One-time purchases', domain };
  if (from('substack.com') && /Lenny's Newsletter/i.test(subject)) return { key: 'lennys-newsletter', name: "Lenny's Newsletter", category: 'Reading', domain };
  if (from('cw.com.tw')) return { key: 'commonwealth', name: 'CommonWealth', category: 'Reading', domain };
  if (from('cleverbridge.com') && /refund/i.test(subject)) return { key: 'cleverbridge-unknown-product', name: 'Cleverbridge · product needs review', category: 'Unclassified', domain };
  if (from('google.com') && /Google AI Pro|Google One/.test(subject + text)) return { key: 'google-ai-pro', name: 'Google AI Pro', category: 'AI tools', domain };
  if (from('google.com') && /Google Play/.test(subject + text)) return { key: 'google-play', name: 'Google Play purchase', category: 'Unclassified', domain };
  if (/newsletter|哩程|核對表|訂位|報名人|system update/i.test(subject)) return null;
  const merchant = subject.match(/^(?:Your receipt from|Your subscription to)\s+([^#]{2,80})/i)?.[1]?.trim();
  if (merchant) {
    return { key: 'merchant:' + domain + ':' + digest(merchant.toLowerCase()).slice(0, 12), name: merchant, category: 'Unclassified', domain };
  }
  if (/receipt|invoice|收據|發票/i.test(subject)) return { key: 'unclassified:' + domain, name: domain, category: 'Unclassified', domain };
  return null;
}

function servicePeriod(text) {
  const full = text.match(/\b([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(20\d{2})(?:\s+\d{1,2}:\d{2}\s*(?:am|pm)?\s*(?:UTC)?)?\s*(?:[–—-]|through)\s*([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (full) {
    const start = parseDay(`${full[1]} ${full[2]}, ${full[3]}`), end = parseDay(`${full[4]} ${full[5]}, ${full[6]}`);
    if (start && end && start < end) return { start, end };
  }
  const found = text.match(/\b([A-Z][a-z]{2,8})\s+(\d{1,2})\s*[–—-]\s*(?:([A-Z][a-z]{2,8})\s+)?(\d{1,2}),?\s+(20\d{2})\b/);
  if (!found) return null;
  let startYear = Number(found[5]);
  const startMonth = MONTHS[found[1].slice(0, 3).toLowerCase()];
  const endMonth = MONTHS[(found[3] || found[1]).slice(0, 3).toLowerCase()];
  if (startMonth > endMonth) startYear--;
  const start = parseDay(`${found[1]} ${found[2]}, ${startYear}`);
  const end = parseDay(`${found[3] || found[1]} ${found[4]}, ${found[5]}`);
  return start && end && start < end ? { start, end } : null;
}

const MONEY_PATTERN = '(?:' + CURRENCY_MARKERS + ')\\s*[\\d,.]+(?![\\d,.])';
const afterMoney = (text, label, hint) => money(text.match(new RegExp('(?:' + label + ')\\s*[:：]?\\s*(' + MONEY_PATTERN + ')', 'i'))?.[1], hint);

function extractEvidence(input) {
  const message = normalizedMessage(input);
  if (!message.id || !message.receivedAt || !message.sender) throw new Error('Message identity and source are required');
  const subject = message.subject.trim();
  // A quoted earlier conversation must not override the provider's current reply.
  const text = message.text.split(/\nOn [^\n]{5,200}wrote:\s*\n|\n>{1,2}\s|\n-{5,}\s*Forwarded message/i)[0];
  if (/有人點擊訂閱|\bPR run failed\b/.test(subject)) return [];
  const service = issuer(message);
  if (!service) return [];
  // Billing events are data, not instructions. No links or commands from messages are executed.
  const base = {
    id: digest(message.id), messageId: message.id, receivedAt: message.receivedAt,
    sourceDay: dayOf(message.receivedAt), serviceKey: service.key, service: service.name,
    category: service.category, issuerDomain: service.domain, subject:billingExcerpt(subject,{maxLength:200}),
    sourceUrl: `https://mail.google.com/mail/?${message.mailboxEmail ? 'authuser=' + encodeURIComponent(message.mailboxEmail) : ''}#all/${encodeURIComponent(message.id)}`,
    authenticated: message.authenticatedSenderDomain ? (service.domain === message.authenticatedSenderDomain || service.domain.endsWith('.' + message.authenticatedSenderDomain)) : false,
    sourceFormat: message.sourceFormat || 'gmail_mime', sourceReadAt: message.sourceReadAt || null,
    evidence: '', kind: 'unknown', currencyAmbiguous: false
  };
  const event = (kind, evidence, extra = {}) => ({ ...base, id: digest(message.id + '|' + kind + '|v1'), kind, evidence: billingExcerpt(evidence), ...extra });
  if(service.key==='cloudflare:unknown-domain')return /invoice|eGUI|發票/i.test(subject)?[event('unclassified_purchase','Cloudflare invoice notification without an identified domain or amount. Review the invoice before linking it to a subscription.',{sourceRequiresDocumentReview:true,providerKey:'cloudflare'})]:[];
  if (service.key === 'openai-unknown-product') return [event('unclassified_purchase', 'OpenAI prepared a tax invoice. The email body does not identify the product, amount or payment status. Review the invoice document before linking it to ChatGPT or API usage.', { sourceRequiresDocumentReview: true, providerKey: 'openai' })];
  if (service.key === 'lalamove') {
    if (/儲值收據|top.?up/i.test(subject)) return [event('wallet_top_up', subject, { payment: money(text.match(/總付款金額\s*(NT\$[\d,.]+)/)?.[1]) })];
    if (/送貨收據|配送收據/.test(subject + text)) return [event('one_time_purchase', 'Delivery receipt, not recurring billing', { payment: money(text.match(/總價\s*\(TWD\)\s*(NT\$[\d,.]+)/)?.[1]) })];
    return [];
  }
  if (service.key === 'eva-airways') return /購票|e.?ticket|itinerary|ticket receipt/i.test(subject) ? [event('one_time_purchase', 'Airfare booking notification; a settled amount is not established.', { reference: subject.match(/購票訊息-([A-Z0-9]{6})\b/)?.[1] || null })] : [];
  if (/會員福利|系統安全性更新|unsubscribe confirmation|訂位|報名人/i.test(subject) || /newsletter|special offer/i.test(subject) && !/refund|receipt|invoice/i.test(subject)) return [];
  if (/目前並未訂閱|無成立任何訂閱訂單/.test(text)) return [event('account_not_subscribed', 'The issuer explicitly corrected a mistakenly sent subscription notice. No subscription order or charge exists.')];
  const refunds = [];
  if (/refund|退款/i.test(subject)) {
    const refund = afterMoney(text, 'Total refunded(?: without credit note)?|Total refunded|refund of|To be refunded') || money(text.match(/Total:\s*(\$[\d,.]+)/i)?.[1]);
    const processed = /refund was processed|Refunded on|Total refunded|have issued a refund|refund has (?:already )?been processed successfully/i.test(text + '\n' + subject);
    const refundDay = parseDay(text.match(/Refunded on\s*([^.!\n]{6,45})/i)?.[1]);
    refunds.push(event(processed ? 'refund_recorded' : 'refund_pending', `${processed ? 'Issuer reports a refund; bank receipt is not verified.' : 'Refund requested or approved; settlement is not verified.'}${refund ? ' ' + refund.source : ''}`, {
      refund, reference: text.match(/Invoice (?:number|#)\s*([A-Z0-9-]+)/i)?.[1] || null,
      ...(text.match(/\bRefund (?:number|ID|#)\s*[:：]?\s*([A-Z0-9][A-Z0-9_-]{1,100})\b/i)?.[1] ? {refundRef:text.match(/\bRefund (?:number|ID|#)\s*[:：]?\s*([A-Z0-9][A-Z0-9_-]{1,100})\b/i)[1]} : {}),
      refundDay, refundDateBasis: refundDay ? 'explicit' : 'unknown'
    }));
  }
  if (service.key === 'google-ai-pro' && /申請試用/.test(text)) {
    const trialEnds = parseDay(text.match(/試用期將於\s*([^。]{6,45})/)?.[1]);
    const nextCharge = money(text.match(/目前費\s*用[：:]\s*(?:每月\s*)?(\$[\d,.]+)/)?.[1]);
    return [event('trial_confirmed', `Google AI Pro trial${trialEnds ? ' ends ' + trialEnds : ''}; renews automatically unless canceled. Currency needs confirmation.`, { trialEnds, nextBilling: trialEnds, nextCharge, cadence: /每月/.test(text) ? 'monthly' : null, renewal: 'on', plan: 'Google AI Pro (5 TB)' })];
  }
  const cancellation = /subscription[^.!\n]{0,80}(?:has (?:also )?been|was|is)\s+(?:successfully\s+)?cancel[le]+d|membership[^.!\n]{0,80}cancel[le]+d|processed your cancellation|auto.?renew(?:al)?[^.!\n]{0,80}(?:disabled|off|canceled|cancelled)|自動續(?:訂|約|費)[^。\n]{0,20}(?:關閉|停用)|訂閱[^。\n]{0,20}已取消|已經處理您的取消要求|your plan will not renew/i;
  if (cancellation.test(subject + '\n' + text) || /subscription.*cancel[le]+d|Membership Cancellation/i.test(subject)) {
    const endPhrase = text.match(/(?:access[^.!]{0,70}(?:expire|end)(?:s)?\s+(?:on\s+)?|membership\s+will\s+end\s+on\s+|membership[^.!]{0,60}will end\s+on\s+|cancel[le]+d\s+and\s+will\s+end\s+on\s+|access[^.!]{0,60}until\s*|end of your billing period on\s*|訂閱將於\s*)([^.!\n]{6,40})/i)?.[1];
    const accessEnds = parseDay(endPhrase);
    const explicitOff = /disabled|auto.?renew.*off|has been canceled|was canceled|is cancelled|successfully cancel|processed your cancellation|membership has been cancelled/i.test(subject + text);
    return [...refunds, event('renewal_disabled', (text.match(cancellation)?.[0] || subject) + (endPhrase ? ` · ${endPhrase}` : ''), { accessEnds, explicitOff })];
  }
  if (refunds.length) return refunds;
  if (service.key === 'chatgpt' && /你已成功訂閱|subscription will automatically renew monthly/.test(text.replace(/\n/g, ' '))) {
    const nextBilling = parseDay(text.replace(/\n/g, ' ').match(/starting\s+([^.!]{6,40})/i)?.[1]);
    const recurringRate = afterMoney(text, '總計');
    return [event('subscription_confirmed', nextBilling ? `ChatGPT records a monthly plan change starting ${nextBilling}.` : 'ChatGPT confirms a monthly subscription. The next exact billing date is not stated.', { nextBilling, plan: /Plus/.test(text) ? 'ChatGPT Plus' : null, recurringRate, cadence: 'monthly' })];
  }
  if (service.key === 'mint-mobile' && /AUTO RENEWAL:\s*Not Active/i.test(text)) {
    const date = text.match(/RENEWAL DATE:\s*(\d{2})\/(\d{2})\/(\d{2}|20\d{2})\b/i);
    const year = date && (date[3].length === 2 ? '20' + date[3] : date[3]);
    const accessEnds = date ? parseDay(`${year}-${date[1]}-${date[2]}`) : null;
    return [event('renewal_disabled', `Mint Mobile says auto renewal is not active.${accessEnds ? ' Recorded plan end: ' + accessEnds : ''}`, { accessEnds })];
  }
  if (service.key === 'microsoft-365' && /訂閱(?:已|即將)到期/.test(subject)) {
    const accessEnds = parseDay(text.match(/訂閱到期日[：:]\s*([^\n]{6,30})/)?.[1]);
    return [event(/已到期/.test(subject) ? 'access_expired' : 'access_expiring', subject, { accessEnds })];
  }
  if (/subscription expires (?:soon|on)/i.test(subject + text)) return [event('access_expiring', subject, { accessEnds: parseDay(text.match(/subscription expires on\s*([^.!\n]{6,45})/i)?.[1]) })];
  if (/automatically downgraded to the free tier/i.test(text)) return [event('access_paused', 'Provider support reports a downgrade to the free tier after a missing payment method. Current promotional access needs verification.')];
  if (service.key.startsWith('cloudflare:') && /auto renewal.*enabled/i.test(text)) return [event('renewal_notice', text.match(/Auto renewal[^\n]+/i)?.[0] || subject, { renewal: 'on' })];
  if (/payment.*(?:failed|declined)|access has been paused|無法順利處理.*付款|付款失敗|逾期未支付/i.test(subject + '\n' + text.slice(0, 1600))) return [event('payment_failed', billingExcerpt(text) || subject)];
  const tomorrow = /subscription will expire tomorrow/i.test(subject + text);
  if (/subscription will expire/i.test(subject)) {
    const days = tomorrow ? 1 : Number(subject.match(/in\s+(\d+)\s+days/i)?.[1]);
    const end = Number.isInteger(days) && days > 0 ? dayOf(Date.parse(message.receivedAt) + days * 86400000) : null;
    return [event('access_expiring', billingExcerpt(text) || subject, { accessEnds: end, dateBasis: 'relative_notice', renewal: 'unknown' })];
  }
  if (service.key.startsWith('cloudflare:')) {
    const end = parseDay(text.match(/expires\s+([^\n)]{5,35})/i)?.[1]);
    const renewal = /auto-renew off/i.test(text) ? 'off' : /auto-renew on/i.test(text) ? 'on' : 'unknown';
    return [event('renewal_notice', text.match(/-\s+[^\n]+/)?.[0] || subject, { accessEnds: end, renewal, nextCharge: null })];
  }
  const hint = text.match(/(?:currency(?: code)?\s*[:：]\s*|\b)(USD|TWD|EUR|GBP|CAD|AUD|JPY)\b/)?.[1] ?? null;
  let paid = afterMoney(text, 'Amount paid\\*?|Total paid|實付金額', hint)
    ?? (/payment was successful/i.test(subject) ? money(subject.match(/(\$[\d,.]+)/)?.[1]) : null)
    ?? (/(?:receipt|收據)/i.test(subject) ? money(text.match(new RegExp('Receipt from[^\n]{0,100}?(' + MONEY_PATTERN + ')\\s+Paid', 'i'))?.[1], hint) : null);
  const newsletterReceipt=service.key==='lennys-newsletter'&&/This is your receipt for invoice\s*#/i.test(text);
  if(!paid&&newsletterReceipt)paid=money(text.match(/(\$[\d,.]+)\s+USD\b/)?.[1],'USD');
  const period = servicePeriod(text);
  const plan = text.match(/\b(Max plan\s*-\s*(?:5x|20x)|Claude Pro|Suno Pro|Premium|Pro|pro_yearly|Cloud Start Yearly)\b/)?.[1]
    ?? (text.includes('逐字飽 pro_yearly') ? 'pro_yearly' : null);
  const rateMatch = text.match(new RegExp('(?:Max plan\\s*-\\s*(?:5x|20x)|Claude Pro|Suno Pro|Premium|Pro)\\s+Qty\\s+1\\s+(' + MONEY_PATTERN + ')', 'i'));
  const recurringRate = money(rateMatch?.[1], hint);
  const periodDays=period?(Date.parse(period.end)-Date.parse(period.start))/86400000:null;
  const annual = /(?:every year|pro_yearly|billed annually|billed yearly|Cloud Start Yearly|billing cycle[:：]?\s*yearly|年繳)/i.test(text) || periodDays>350&&periodDays<380;
  const monthly = !!period && (Date.parse(period.end) - Date.parse(period.start)) / 86400000 < 35;
  const explicitlyRecurring = /subscription|membership|renew|recurring|Max plan|Claude Pro|Suno Pro|pro_yearly|逐字飽|月費|年繳/i.test(subject + text) || !!period;
  const nextPhrase = [
    /automatically renew on\s*([^.!\n]{6,45})/i,
    /next charge will be on\s*([^.!\n]{6,45})/i,
    /will renew at[^\n]{0,70}?\bon\s*([^.!\n]{6,45})/i,
    /subscription will renew\s+(?:automatically\s+)?on\s*([^.!\n]{6,45})/i,
    /renews on\s*([^.!\n]{6,45})/i,
    /下次扣款日[^\n]{0,4}\s*([^.!\n]{6,45})/i
  ].map(pattern => text.match(pattern)?.[1]).find(phrase => parseDay(phrase));
  const nextBilling = parseDay(nextPhrase);
  const nextAmount = text.match(new RegExp('will renew at\\s*(' + MONEY_PATTERN + ')','i'))?.[1];
  const cancelBy = parseDay(text.match(/unless you cancel by\s+([^.!\n]{6,40})/i)?.[1]);
  const reference = text.match(/Invoice (?:number|#)\s*([A-Z0-9-]+)/i)?.[1] ?? text.match(/Receipt (?:number|#)\s*([A-Z0-9-]+)/i)?.[1];
  const paymentDay = parseDay(text.match(/\bPaid\s+([A-Za-z]+\s+\d{1,2},?\s+20\d{2}|20\d{2}-\d{2}-\d{2})/)?.[1] || (newsletterReceipt?text.match(/This is your receipt for invoice\s*#[A-Z0-9-]+\s+on\s+([^.!\n]{6,40})/i)?.[1]:null));
  const events = [];
  if (paid) events.push(event(explicitlyRecurring ? 'payment_succeeded' : 'unclassified_purchase', `Amount paid ${paid.source}${period ? ` · ${period.start}–${period.end}` : ''}`, {
    payment: paid, paymentDay, paymentDateBasis: paymentDay ? 'explicit' : 'unknown',
    reference, period, plan, recurringRate, cadence: annual ? 'annual' : monthly ? 'monthly' : null,
    hasAdjustments: /Unused time|prorat|discount|50%|50 Off|credit|折抵/i.test(text), currencyAmbiguous: !paid.currency
  }));
  if (explicitlyRecurring && (nextBilling || cancelBy || /subscription (?:is )?confirmed|subscription confirmation|Your subscription to|signing up for your/i.test(subject + text))) {
    events.push(event('subscription_confirmed', nextPhrase || billingExcerpt(text), { nextBilling, cancelBy, nextCharge: money(nextAmount, hint), cadence: annual ? 'annual' : monthly ? 'monthly' : null, plan }));
  }
  if (!events.length && /renew soon|renewal notification/i.test(subject)) events.push(event('renewal_notice', nextPhrase || billingExcerpt(text), { nextBilling, renewal: nextBilling ? 'on' : 'unknown' }));
  if (!events.length && /receipt|invoice|收據/i.test(subject)) events.push(event('unclassified_purchase', 'A purchase exists, but recurring billing and/or a settled amount are not established.'));
  return events;
}

function projectEvidence(events, { asOf = new Date().toISOString(), coverage = null, trustConnectorReads = false } = {}) {
  const today = dayOf(asOf);
  const unique = new Map(), conflicts = new Set();
  const financialIdentity = event => contracts.canonicalJSON(Object.fromEntries(['kind','serviceKey','accountRef','reference','transactionRef','lineItemRef','refundRef','payment','refund','invoiceAmount','paymentDay','refundDay','nextBilling','accessEnds','period'].filter(key=>event[key]!==undefined).map(key=>[key,event[key]])));
  for (const event of events) {
    if (unique.has(event.id) && financialIdentity(unique.get(event.id)) !== financialIdentity(event)) conflicts.add(event.id);
    else unique.set(event.id,event);
  }
  const ordered = [...unique.values()].filter(event=>!conflicts.has(event.id)).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
  // Existing identities are untouched. New explicit references add scope only;
  // an invoice ID alone cannot distinguish two partial refunds or line items.
  const scope = event => event.accountRef ? event.serviceKey + '|account:' + encodeURIComponent(event.accountRef) : event.serviceKey;
  const transactionKey = (event, refund = false) => scope(event) + '|' + (refund && event.refundRef ? 'refund:' + encodeURIComponent(event.refundRef) : event.transactionRef ? 'transaction:' + encodeURIComponent(event.transactionRef) : event.reference || event.messageId) + (event.lineItemRef ? '|line:' + encodeURIComponent(event.lineItemRef) : '');
  const groups = new Map();
  const payments = new Map();
  const oneTime = new Map();
  const unclassifiedPurchases = [];
  const heldEvidence = events.filter(event=>conflicts.has(event.id)).map(event=>({...event,holdReason:'conflicting_event_identity'}));
  const refunds = new Map();
  for (const event of ordered) {
    if (event.sourceProcessingConflict === true || event.candidateStatus === 'needs_review' || event.importStatus === 'needs_source_recheck' || !event.authenticated && !event.userVerified && !(trustConnectorReads && event.sourceFormat === 'claude_plaintext' && event.sourceReadAt)) { heldEvidence.push(event); continue; }
    if (event.kind === 'unclassified_purchase') { unclassifiedPurchases.push(event); continue; }
    if (event.category === 'Unclassified' && ['refund_recorded', 'refund_pending'].includes(event.kind)) {
      refunds.set(transactionKey(event,true), event);
      unclassifiedPurchases.push(event);
      continue;
    }
    if (['one_time_purchase', 'wallet_top_up'].includes(event.kind)) {
      const key = transactionKey({...event,messageId:event.id});
      const previous = oneTime.get(key);
      oneTime.set(key, previous ? { ...previous, duplicateEvidenceIds: [...(previous.duplicateEvidenceIds || []), event.id] } : event);
      continue;
    }
    const groupKey = scope(event);
    const group = groups.get(groupKey) ?? {
      serviceKey: groupKey, providerServiceKey:event.serviceKey, name: event.service, category: event.category,
      renewal: 'unknown', accessEnds: null, accessEndsAt:null, nextBilling: null, nextBillingAt:null, nextCharge: null,
      plan: null, recurringRate: null, lastInvoice: null, cadence: null, latestSourceAt: null,
      renewalSourceAt: null, unresolvedPaymentProblem: null, evidenceIds: [], warnings: []
    };
    group.latestSourceAt = event.receivedAt;
    group.evidenceIds.push(event.id);
    if (event.kind === 'account_not_subscribed') {
      group.notSubscribed = true; group.renewal = 'unknown'; group.nextBilling = null; group.accessEnds = null;
    } else if (event.kind === 'refund_recorded' || event.kind === 'refund_pending') {
      const key = transactionKey(event,true);
      const existing = refunds.get(key);
      if(existing?.kind==='refund_recorded'&&event.kind==='refund_recorded'&&existing.refund&&event.refund&&(existing.refund.minor!==event.refund.minor||existing.refund.currency!==event.refund.currency)){
        refunds.set(key,{...existing,conflict:true});group.warnings.push('Conflicting refund evidence needs checking.');
      }else if (!existing || existing.kind === 'refund_pending') refunds.set(key, event);
      if (group.refundStatus !== 'refund_recorded' || event.kind === 'refund_recorded') group.refundStatus = event.kind;
      group.refundSourceAt = event.receivedAt;
      group.warnings.push('Refund evidence does not establish bank settlement or continued access. Check the provider before relying on an older paid-through date.');
    } else if (event.kind === 'renewal_disabled') {
      group.renewal = 'off'; group.renewalSourceAt = event.receivedAt;
      if (event.accessEnds && group.accessEnds && event.accessEnds !== group.accessEnds) group.warnings.push('The cancellation and an earlier receipt state different access-end dates. Both source records are retained.');
      if (event.accessEnds) {group.accessEnds = event.accessEnds;group.accessEndsAt=event.accessEndsAt||null;}
      if (event.accessEnds) group.accessSourceAt = event.receivedAt;
      group.nextBilling = null; group.nextBillingAt=null;group.nextCharge = null;
    } else if (event.kind === 'subscription_confirmed' || event.kind === 'trial_confirmed') {
      group.notSubscribed = false;
      group.renewal = 'on'; group.renewalSourceAt = event.receivedAt;
      group.nextBilling = event.nextBilling || null;
      group.nextBillingAt=event.nextBillingAt||null;
      group.nextCharge = event.nextCharge || null;
      group.cancelBy = event.cancelBy || null;
      group.trialEnds = event.trialEnds || null;
      // An explicit restart supersedes a prior cancellation; a receipt alone never does.
      group.accessEnds = event.nextBilling || group.accessEnds;
      if(event.nextBilling)group.accessEndsAt=event.nextBillingAt||null;
      if (event.nextBilling) group.accessSourceAt = event.receivedAt;
      if (event.cadence) group.cadence = event.cadence;
      if (event.plan) group.plan = event.plan;
      if (event.recurringRate) group.recurringRate = event.recurringRate;
    } else if(event.kind==='invoice_recorded'){
      group.lastInvoice={...event.invoiceAmount,day:event.invoiceDay||null,evidenceId:event.id};
      group.warnings.push('An invoice amount is recorded; payment, product match and renewal are not established by the invoice alone.');
    } else if (event.kind === 'payment_succeeded') {
      const key = transactionKey(event);
      const previous = payments.get(key);
      if (previous && (previous.payment.minor !== event.payment.minor || previous.payment.currency !== event.payment.currency)) {
        payments.set(key, { ...previous, conflict: true }); group.warnings.push('Conflicting payment evidence needs checking.');
      } else if (!previous) payments.set(key, event);
      if (event.period?.end && (!group.accessEnds || event.period.end >= group.accessEnds)) { group.accessEnds = event.period.end;group.accessEndsAt=event.period.endAt||null; group.accessSourceAt = event.receivedAt; }
      group.lastPayment = { ...event.payment, day: event.paymentDay, evidenceId: event.id };
      if (event.recurringRate) group.recurringRate = event.recurringRate;
      if (event.plan) group.plan = event.plan;
      if (event.cadence) group.cadence = event.cadence;
      if (event.hasAdjustments) group.warnings.push('The last payment includes an adjustment or discount. It is not the next renewal price.');
    } else if (event.kind === 'payment_failed' || event.kind === 'access_paused') {
      group.unresolvedPaymentProblem = event.id;
    } else if (event.kind === 'access_expiring' || event.kind === 'access_expired') {
      if (event.accessEnds) group.accessEnds = event.accessEnds;
      if (event.accessEnds) group.accessSourceAt = event.receivedAt;
      group.warnings.push('Access end comes from a relative expiry notice. Renewal status needs checking.');
    } else if (event.kind === 'renewal_notice') {
      if(event.recurringRate)group.recurringRate=event.recurringRate;
      if(event.cadence)group.cadence=event.cadence;
      if (event.accessEnds) group.accessEnds = event.accessEnds;
      if (event.accessEnds) group.accessSourceAt = event.receivedAt;
      if (event.nextBilling) group.nextBilling = event.nextBilling;
      if (event.renewal && event.renewal !== 'unknown') { group.renewal = event.renewal; group.renewalSourceAt = event.receivedAt; }
    }
    groups.set(groupKey, group);
  }
  const subscriptions = [...groups.values()].map(group => {
    const access = !group.accessEnds || group.refundSourceAt && group.refundSourceAt >= (group.accessSourceAt || '') ? 'unknown' : group.accessEnds > today ? 'available' : group.accessEnds === today ? 'ends_today' : 'past_recorded_period';
    const status = group.notSubscribed ? 'not_subscribed' : group.renewal === 'off' ? 'renewal_off'
      : group.unresolvedPaymentProblem ? 'payment_problem'
      : group.renewal === 'on' && (group.nextBilling > today || group.cancelBy > today) ? 'active'
      : access === 'available' ? 'paid_access'
      : 'needs_verification';
    const warnings = [...new Set(group.warnings)];
    if (group.nextBilling && group.nextBilling <= today && group.renewal !== 'off') warnings.push('The recorded renewal date has arrived or passed. No new billing cycle was invented.');
    if (group.unresolvedPaymentProblem) warnings.push('A payment failure was recorded. Gmail does not establish whether the provider has since resolved it.');
    return { ...group, status, access, warnings };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const confirmedPayments = [...payments.values()].filter(e => !e.conflict && e.payment.currency);
  const chatgpt = subscriptions.find(s => s.serviceKey === 'chatgpt');
  if (chatgpt) {
    const laterOpenAI = unclassifiedPurchases.filter(e => e.providerKey === 'openai' && e.receivedAt > chatgpt.latestSourceAt);
    if (laterOpenAI.length) {
      chatgpt.status = 'needs_verification';
      chatgpt.relatedEvidenceIds = laterOpenAI.map(e => e.id);
      chatgpt.warnings.push('Newer OpenAI tax invoices are unclassified. Current ChatGPT status needs verification; these may relate to a different product.');
    }
  }
  const totals = {};
  for (const e of confirmedPayments) {
    const total=(totals[e.payment.currency] || 0)+e.payment.minor;
    if(!Number.isSafeInteger(total))throw new Error('Recorded total exceeds the safe amount range');
    totals[e.payment.currency]=total;
  }
  return { asOf, coverage, subscriptions: subscriptions.filter(s => s.status !== 'not_subscribed'), excludedServices: subscriptions.filter(s => s.status === 'not_subscribed'), refunds: [...refunds.values()], oneTimePurchases: [...oneTime.values()], unclassifiedPurchases, heldEvidence, payments: [...payments.values()], recordedPaidMinorByCurrency: totals,
    unconfirmedCurrencyPayments: [...payments.values()].filter(e => !e.payment.currency).length };
}

return { dayOf, currencyDecimals, parseDay, money, htmlToText, normalizedMessage, extractEvidence, projectEvidence };
}
