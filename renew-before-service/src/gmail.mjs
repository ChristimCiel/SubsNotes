import { htmlToText } from './evidence.mjs';

export class GmailError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Search is a coverage boundary, not a claim to inspect every personal email.
export function billingQuery(since) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(since)) throw new Error('A valid coverage date is required');
  return `after:${since.replaceAll('-', '/')} {subject:receipt subject:invoice subject:eGUI subject:subscription subject:membership subject:renewal subject:renew subject:payment subject:refund subject:cancelled subject:canceled subject:expire subject:trial subject:ChatGPT subject:收據 subject:訂閱 subject:續訂 subject:續約 subject:付款 subject:退款 subject:取消 subject:試用 subject:到期}`;
}

export function isBillingCandidate(headers) {
  const subject = header(headers, 'subject');
  const sender = header(headers, 'from');
  if (/有人點擊訂閱|\bPR run failed\b/.test(subject)) return false;
  return /receipt|invoice|eGUI|ChatGPT|subscription|membership|renew|payment|billing|refund|cancelled|canceled|expire|trial|收據|發票|訂閱|續訂|續約|付款|退款|取消|試用|到期/i.test(subject)
    && !/有人點擊訂閱|newsletter|會員福利|哩程核對表/i.test(subject);
}

export const header = (headers = [], name) => headers.find(h => h.name.toLowerCase() === name)?.value || '';

export function decodeGmailMessage(raw, mailboxEmail) {
  const headers = raw.payload?.headers || [];
  const sender = header(headers, 'from');
  const result = headers.find(h => h.name.toLowerCase() === 'authentication-results' && /^mx\.google\.com[;\s]/i.test(h.value))?.value || '';
  const authenticatedSenderDomain = /\bdmarc=pass\b/i.test(result) ? result.match(/header\.from=([a-z0-9.-]+)/i)?.[1]?.toLowerCase() || null : null;
  const text = [], html = [], attachments = [];
  let truncated = false;
  const visit = part => {
    if (!part) return;
    const type = (part.mimeType || '').toLowerCase();
    if (part.filename && part.body?.attachmentId) attachments.push({ name: part.filename, mimeType: type, id: part.body.attachmentId });
    if (!part.filename && part.body?.data && ['text/plain', 'text/html'].includes(type)) {
      const bytes = Buffer.from(part.body.data, 'base64url');
      if (bytes.length > 256_000) truncated = true;
      const decoded = bytes.subarray(0, 256_000).toString('utf8');
      (type === 'text/plain' ? text : html).push(decoded);
    }
    for (const child of part.parts || []) visit(child);
  };
  visit(raw.payload);
  const receivedAt = new Date(Number(raw.internalDate)).toISOString();
  return {
    id: raw.id, receivedAt, sender, subject: header(headers, 'subject'),
    text: text.join('\n') || htmlToText(html.join('\n')), authenticatedSenderDomain,
    mailboxEmail, attachmentCount: attachments.length, truncated
  };
}

export function createGmailClient({ accessToken, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!accessToken) throw new Error('A Gmail access token is required');
  async function request(path, parameters = {}) {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/' + path);
    for (const [key, value] of Object.entries(parameters)) if (value != null) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
      if (response.ok) return response.json();
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Math.min(5000, retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt));
        continue;
      }
      // Never log provider response bodies, tokens, or email text in errors.
      throw new GmailError(response.status, response.status === 401 ? 'Gmail authorization needs to be renewed.' : `Gmail request failed (${response.status}).`);
    }
  }
  return {
    profile: () => request('profile'),
    list: ({ query, pageToken, maxResults = 50 }) => request('messages', { q: query, pageToken, maxResults }),
    metadata: id => request('messages/' + encodeURIComponent(id), { format: 'metadata', fields: 'id,payload/headers' }),
    message: id => request('messages/' + encodeURIComponent(id), { format: 'full' }),
    history: ({ historyId, pageToken, maxResults = 50 }) => request('history', { startHistoryId: historyId, pageToken, historyTypes: 'messageAdded', maxResults })
  };
}
