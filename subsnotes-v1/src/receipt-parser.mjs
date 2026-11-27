/**
 * Client-side receipt / subscription import parser.
 * No network. Pure functions for paste, CSV, EML, and JSON.
 */

const MERCHANT_HINTS = [
  { re: /anthropic|claude\.ai|claude pro/i, merchant: 'Claude Pro', category: 'Chat', billingUrl: 'https://claude.ai/settings/billing' },
  { re: /openai|chatgpt\s*(plus|pro|team)?/i, merchant: 'ChatGPT Plus', category: 'Chat', billingUrl: 'https://chatgpt.com/#settings/Account' },
  { re: /\bcursor\b/i, merchant: 'Cursor', category: 'Coding', billingUrl: 'https://cursor.com/settings' },
  { re: /perplexity/i, merchant: 'Perplexity', category: 'Chat', billingUrl: 'https://www.perplexity.ai/account' },
  { re: /meshy/i, merchant: 'Meshy', category: 'Image', billingUrl: 'https://www.meshy.ai/settings' },
  { re: /suno/i, merchant: 'Suno', category: 'Music', billingUrl: 'https://suno.com/account' },
  { re: /\bn8n\b/i, merchant: 'n8n Cloud', category: 'Automation', billingUrl: 'https://app.n8n.cloud/' },
  { re: /surfshark/i, merchant: 'Surfshark', category: 'Security', billingUrl: 'https://my.surfshark.com/' },
  { re: /youtube\s*(premium|music)?/i, merchant: 'YouTube Premium', category: 'Media', billingUrl: 'https://www.youtube.com/paid_memberships' },
  { re: /\bx\.com\b|twitter|x premium/i, merchant: 'X Premium', category: 'Social', billingUrl: 'https://x.com/settings/premium' },
  { re: /stripe/i, merchant: 'Stripe Billing', category: 'Other' },
  { re: /paddle/i, merchant: 'Paddle', category: 'Other' },
  { re: /apple\.com|itunes|app store/i, merchant: 'Apple', category: 'Other', billingUrl: 'https://apps.apple.com/account/subscriptions' },
  { re: /google play|play\.google/i, merchant: 'Google Play', category: 'Other', billingUrl: 'https://play.google.com/store/account/subscriptions' },
  { re: /github/i, merchant: 'GitHub', category: 'Coding', billingUrl: 'https://github.com/settings/billing' },
  { re: /notion/i, merchant: 'Notion', category: 'Notes', billingUrl: 'https://www.notion.so/my-account' },
  { re: /figma/i, merchant: 'Figma', category: 'Design', billingUrl: 'https://www.figma.com/settings' },
  { re: /midjourney/i, merchant: 'Midjourney', category: 'Image', billingUrl: 'https://www.midjourney.com/account' },
  { re: /adobe/i, merchant: 'Adobe', category: 'Design', billingUrl: 'https://account.adobe.com/plans' },
  { re: /spotify/i, merchant: 'Spotify', category: 'Media', billingUrl: 'https://www.spotify.com/account/subscription/' },
  { re: /netflix/i, merchant: 'Netflix', category: 'Media', billingUrl: 'https://www.netflix.com/YourAccount' },
];

const AMOUNT_RE = /(?:US\$|USD\s*|\$|NT\$|TWD\s*|EUR\s*|€)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i;
const AMOUNT_RE_GLOBAL = /(?:US\$|USD\s*|\$|NT\$|TWD\s*|EUR\s*|€)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/gi;

function parseAmountToken(raw) {
  if (!raw) return null;
  const m = String(raw).match(AMOUNT_RE);
  if (!m) {
    const n = Number(String(raw).replace(/,/g, ''));
    return Number.isFinite(n) ? { amount: n, currency: 'USD' } : null;
  }
  const amount = Number(m[1].replace(/,/g, ''));
  const token = m[0].toUpperCase();
  let currency = 'USD';
  if (token.includes('NT') || token.includes('TWD')) currency = 'TWD';
  else if (token.includes('EUR') || token.includes('€')) currency = 'EUR';
  return { amount, currency };
}

function detectCurrencyHint(text) {
  const t = text.toUpperCase();
  if (/\bNT\$|\bTWD\b|新台幣/.test(t)) return 'TWD';
  if (/\bEUR\b|€/.test(t)) return 'EUR';
  return 'USD';
}

function detectCadence(text) {
  if (/\/\s*yr|\/\s*year|per\s*year|annual|yearly|年繳|每年/i.test(text)) return 'annual';
  return 'monthly';
}

function detectStatus(text) {
  if (/payment\s*failed|failed\s*payment|card\s*declined|無法付款|付款失敗/i.test(text)) return 'payment_failed';
  if (/cancelled|canceled|cancellation confirmed|已取消/i.test(text)) return 'cancelled';
  if (/free\s*trial|trial\s*(ends|ending|expir)|試用/i.test(text)) return 'trial';
  return 'active';
}

function detectDate(text) {
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = text.match(/\b([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (us) {
    const months = {
      january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
      july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
      jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
    };
    const mo = months[us[1].toLowerCase()];
    if (mo) {
      return `${us[3]}-${String(mo).padStart(2, '0')}-${String(Number(us[2])).padStart(2, '0')}`;
    }
  }
  const tw = text.match(/\b(20\d{2})[\/年](\d{1,2})[\/月](\d{1,2})/);
  if (tw) {
    return `${tw[1]}-${String(Number(tw[2])).padStart(2, '0')}-${String(Number(tw[3])).padStart(2, '0')}`;
  }
  return null;
}

function matchMerchant(text) {
  for (const hint of MERCHANT_HINTS) {
    if (hint.re.test(text)) {
      return {
        merchant: hint.merchant,
        category: hint.category,
        billingUrl: hint.billingUrl || null
      };
    }
  }
  const from = text.match(/from:\s*([^\n<]+)/i);
  if (from) {
    const name = from[1].replace(/["']/g, '').trim().slice(0, 40);
    if (name) return { merchant: name, category: 'Other', billingUrl: null };
  }
  return { merchant: 'Unknown service', category: 'Other', billingUrl: null };
}

function detectPlan(text, merchant) {
  const m = text.match(/(?:plan|tier|subscription)\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9 .+]{1,40})/i);
  if (m) return m[1].trim();
  if (/plus/i.test(text) && /chatgpt|openai/i.test(text)) return 'Plus';
  if (/pro/i.test(text) && /claude|anthropic|cursor/i.test(text)) return 'Pro';
  if (/premium/i.test(text)) return 'Premium';
  return null;
}

function uid(prefix = 'sub') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize a subscription record.
 */
export function normalizeSubscription(input = {}) {
  const amount = Number(input.amount);
  const cadence = input.cadence === 'annual' || input.cadence === 'yearly' ? 'annual' : 'monthly';
  let currency = String(input.currency || 'USD').toUpperCase();
  if (currency === 'NTD' || currency === 'NT$') currency = 'TWD';
  if (currency === '€') currency = 'EUR';
  if (!['USD', 'TWD', 'EUR'].includes(currency)) currency = 'USD';

  const status = ['active', 'trial', 'payment_failed', 'cancelled'].includes(input.status)
    ? input.status
    : 'active';

  return {
    id: input.id || uid(),
    merchant: String(input.merchant || 'Unknown service').trim(),
    plan: input.plan || null,
    amount: Number.isFinite(amount) ? amount : 0,
    currency,
    cadence,
    category: input.category || 'Other',
    status,
    nextDate: input.nextDate || input.renewalDate || null,
    billingUrl: input.billingUrl || null,
    source: input.source || 'manual',
    notes: input.notes || null
  };
}

/**
 * Parse pasted receipt / billing email text into zero or more subscriptions.
 */
export function parseReceiptText(text) {
  if (!text || !String(text).trim()) return [];
  const chunks = String(text)
    .split(/\n{2,}(?=From:|Subject:|-----|====)/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const blocks = chunks.length > 1 ? chunks : [String(text).trim()];
  const out = [];

  for (const block of blocks) {
    const merchantInfo = matchMerchant(block);
    const money = parseAmountToken(block) || { amount: 0, currency: detectCurrencyHint(block) };
    // Prefer largest amount that looks like a subscription charge
    let amount = money.amount;
    let currency = money.currency;
    const all = [...block.matchAll(AMOUNT_RE_GLOBAL)];
    if (all.length > 1) {
      const parsed = all.map((m) => parseAmountToken(m[0])).filter(Boolean);
      const best = parsed.sort((a, b) => b.amount - a.amount)[0];
      if (best) {
        amount = best.amount;
        currency = best.currency;
      }
    }

    if (!amount && merchantInfo.merchant === 'Unknown service') continue;

    out.push(normalizeSubscription({
      merchant: merchantInfo.merchant,
      plan: detectPlan(block, merchantInfo.merchant),
      amount,
      currency,
      cadence: detectCadence(block),
      category: merchantInfo.category,
      status: detectStatus(block),
      nextDate: detectDate(block),
      billingUrl: merchantInfo.billingUrl,
      source: 'paste'
    }));
  }

  return out;
}

/**
 * Parse CSV text. Auto-detects common column names.
 */
export function parseCsv(text) {
  if (!text || !String(text).trim()) return [];
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const split = (line) => {
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; }
        else q = !q;
      } else if (ch === ',' && !q) {
        cells.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  };

  const headers = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const idx = (names) => headers.findIndex((h) => names.some((n) => h.includes(n)));

  const iMerchant = idx(['merchant', 'service', 'name', 'vendor', 'product']);
  const iAmount = idx(['amount', 'price', 'cost', 'charge']);
  const iCurrency = idx(['currency', 'curr']);
  const iCadence = idx(['cadence', 'cycle', 'billing', 'interval', 'period']);
  const iDate = idx(['renewal', 'next', 'date', 'renew']);
  const iCategory = idx(['category', 'type']);
  const iStatus = idx(['status', 'state']);
  const iPlan = idx(['plan', 'tier']);

  if (iMerchant < 0 || iAmount < 0) return [];

  const out = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = split(lines[r]);
    if (!cells[iMerchant]) continue;
    const amountRaw = cells[iAmount] || '0';
    const parsed = parseAmountToken(amountRaw) || { amount: Number(String(amountRaw).replace(/[^0-9.]/g, '')), currency: 'USD' };
    let cadence = 'monthly';
    const cadenceRaw = (cells[iCadence] || '').toLowerCase();
    if (/year|annual|yr/.test(cadenceRaw)) cadence = 'annual';
    let status = 'active';
    const statusRaw = (cells[iStatus] || '').toLowerCase();
    if (/fail/.test(statusRaw)) status = 'payment_failed';
    else if (/trial/.test(statusRaw)) status = 'trial';
    else if (/cancel/.test(statusRaw)) status = 'cancelled';

    const hint = matchMerchant(cells[iMerchant]);
    out.push(normalizeSubscription({
      merchant: cells[iMerchant],
      plan: iPlan >= 0 ? cells[iPlan] : null,
      amount: parsed.amount,
      currency: (iCurrency >= 0 && cells[iCurrency]) ? cells[iCurrency] : parsed.currency,
      cadence,
      category: (iCategory >= 0 && cells[iCategory]) ? cells[iCategory] : hint.category,
      status,
      nextDate: iDate >= 0 ? (detectDate(cells[iDate]) || cells[iDate] || null) : null,
      billingUrl: hint.billingUrl,
      source: 'csv'
    }));
  }
  return out;
}

/**
 * Strip EML wrappers and parse as receipt text.
 */
export function parseEml(text) {
  if (!text) return [];
  let body = String(text);
  // Prefer text/plain part
  const plain = body.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i);
  if (plain) body = plain[1];
  body = body
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return parseReceiptText(body);
}

/**
 * Parse SubsNotes JSON backup or array of subscriptions.
 */
export function parseJsonBackup(text) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  const list = Array.isArray(data)
    ? data
    : (data.subscriptions || data.items || data.data || []);
  if (!Array.isArray(list)) throw new Error('JSON must contain a subscriptions array');
  return list.map((item) => normalizeSubscription({ ...item, source: item.source || 'json' }));
}

/**
 * Dispatch by filename / mime hint.
 */
export function parseImportFile({ name = '', text = '' }) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.csv')) return parseCsv(text);
  if (lower.endsWith('.eml')) return parseEml(text);
  if (lower.endsWith('.json')) return parseJsonBackup(text);
  // sniff
  const trimmed = String(text).trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJsonBackup(text);
  if (/^from:/im.test(trimmed) && /content-type:/im.test(trimmed)) return parseEml(text);
  if (/,/.test(trimmed.split(/\r?\n/)[0] || '') && /merchant|service|amount/i.test(trimmed.split(/\r?\n/)[0])) {
    return parseCsv(text);
  }
  return parseReceiptText(text);
}

export { MERCHANT_HINTS, matchMerchant, detectDate, detectCadence, detectStatus };
