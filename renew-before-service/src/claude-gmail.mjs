import { createEvidenceRuntime } from './evidence-runtime.mjs';

// Uses only the two native, user-approved, read-only Gmail tools.
export function createClaudeGmailClient(mcp, { clock = () => new Date().toISOString() } = {}) {
  const { htmlToText } = createEvidenceRuntime(() => '');
  function payload(result) {
    if (result?.isError || result?.error) throw new Error('Gmail reported a tool error');
    let value = result?.payload ?? result?.structuredContent;
    if (value === undefined && Array.isArray(result?.content)) {
      const block = result.content.find(x => x.type === 'text');
      value = block?.text;
    }
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw new Error('Gmail returned an unsupported result'); } }
    if (!value || typeof value !== 'object') throw new Error('Gmail returned an unsupported result');
    return value;
  }
  const address = (value, depth = 0) => {
    if (typeof value === 'string') return value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || null;
    if (!value || typeof value !== 'object' || depth > 2) return null;
    return ['email', 'emailAddress', 'address'].map(key => address(value[key], depth + 1)).find(Boolean) || null;
  };
  async function search({ query, pageToken = null, pageSize = 10 } = {}) {
    if (!mcp?.callTool) throw new Error('Claude Gmail connector is unavailable');
    const args = { query, pageSize, view: 'THREAD_VIEW_SUMMARY' };
    if (pageToken) args.pageToken = pageToken;
    const value = payload(await mcp.callTool('Gmail', 'search_threads', args, { cache: false }));
    if (!Array.isArray(value.threads)) throw new Error('Gmail search did not return threads');
    const messages = value.threads.flatMap(t => Array.isArray(t.messages) ? t.messages : []);
    if (messages.some(m => !m.id && !m.messageId)) throw new Error('Gmail search omitted a message ID');
    const nextPageToken=value.nextPageToken || value.next_page_token || null;
    const estimate=Number(value.resultCountEstimate);
    return { messages, nextPageToken,
      paginationUnknown: !nextPageToken && (value.threads.length>=pageSize || Number.isFinite(estimate)&&estimate>value.threads.length),
      ids: [...new Set(messages.map(m => m.id || m.messageId))], searchedAt: clock() };
  }
  return {
    search,
    // from:me is evaluated by Gmail. This is a bounded fallback identity check,
    // not a claim that the connector exposes a profile endpoint.
    async identity() {
      const found = await search({ query: 'in:sent from:me', pageSize: 1 });
      const senders = [...new Set(found.messages.map(m => address(m.sender) || address(m.from)).filter(Boolean))];
      if (senders.length !== 1) throw new Error('Could not identify the connected mailbox from sent-message metadata');
      return senders[0];
    },
    async message(id) {
      const value = payload(await mcp.callTool('Gmail', 'get_message', { messageId: id, messageFormat: 'PLAIN_TEXT' }, { cache: false }));
      if (value.id !== id || !address(value.sender) || !Number.isFinite(Date.parse(value.date))) throw new Error('Gmail message identity or required fields are missing');
      // Do not request an unverified FULL_CONTENT enum or invent attachment
      // contents. Some connector responses include HTML despite PLAIN_TEXT;
      // consume it only when it is actually present and plain text is empty.
      const plain = typeof value.plaintextBody === 'string' ? value.plaintextBody : null;
      const html = [value.htmlBody, value.html].find(body => typeof body === 'string' && body.trim());
      if (plain === null && !html) throw new Error('Gmail message body is unavailable');
      const useHtml = !plain?.trim() && !!html;
      const body = useHtml ? html : plain;
      return { id, sender: typeof value.sender === 'string' ? value.sender : address(value.sender), subject: typeof value.subject === 'string' ? value.subject : '',
        text: useHtml ? htmlToText(body.slice(0, 256_000)) : body.slice(0, 256_000), bodyFormat: useHtml ? 'html' : 'plain_text',
        receivedAt: new Date(value.date).toISOString(), sourceReadAt: clock(), sourceFormat: 'claude_plaintext',
        authenticatedSenderDomain: null, truncated: body.length > 256_000,
        attachmentCount: Array.isArray(value.attachments) ? value.attachments.length : 0,
        attachmentContentRead: false };
    }
  };
}
