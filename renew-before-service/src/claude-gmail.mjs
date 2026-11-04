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
    if (value.threads.some(t => !Array.isArray(t.messages) || !t.messages.length)) throw new Error('Gmail search omitted message summaries; coverage is incomplete');
    const messages = value.threads.flatMap(t => t.messages);
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
      let value = payload(await mcp.callTool('Gmail', 'get_message', { messageId: id, messageFormat: 'PLAIN_TEXT' }, { cache: false }));
      const valid = item => item.id === id && address(item.sender) && Number.isFinite(Date.parse(item.date));
      if (!valid(value)) throw new Error('Gmail message identity or required fields are missing');
      const placeholder = plain => typeof plain === 'string' && /^(?:your browser does not support html|this (?:message|email) (?:is|was sent) (?:in )?html(?:[- ]only| format)?|please (?:view|read) this (?:message|email) in (?:an? )?html[- ](?:capable|enabled) (?:browser|email client))[.!\s]*$/i.test(plain.trim());
      const content = item => ({plain:typeof item.plaintextBody === 'string' ? item.plaintextBody : null,
        html:[item.htmlBody,item.html].find(body=>typeof body==='string' && body.trim()) || null});
      let {plain,html}=content(value);
      // FULL_CONTENT was verified for this native get_message tool. Request it
      // only when the initial response has no usable body; never invent HTML,
      // RAW payloads or attachment reads when a host does not support it.
      if((!plain?.trim() || placeholder(plain)) && !html) {
        let expanded=null;
        try { expanded=payload(await mcp.callTool('Gmail','get_message',{messageId:id,messageFormat:'FULL_CONTENT'},{cache:false})); }
        catch(error) { if(error?.requiredTool)throw error; }
        if(expanded) {
          if(!valid(expanded) || address(expanded.sender)!==address(value.sender) || Date.parse(expanded.date)!==Date.parse(value.date))throw new Error('Expanded Gmail content does not match the original message identity');
          const next=content(expanded);
          if(next.html || next.plain?.trim() && !placeholder(next.plain)){value=expanded;plain=next.plain;html=next.html;}
        }
      }
      const useHtml = (!plain?.trim() || placeholder(plain)) && !!html;
      const body = (useHtml ? html : plain) || '';
      const text = useHtml ? htmlToText(body.slice(0, 256_000)) : placeholder(plain) ? '' : body.slice(0, 256_000);
      const sourceContentUnavailable = !text.trim() && (!plain?.trim() || placeholder(plain));
      return { id, sender: typeof value.sender === 'string' ? value.sender : address(value.sender), subject: typeof value.subject === 'string' ? value.subject : '',
        text, bodyFormat: sourceContentUnavailable ? 'unavailable' : useHtml ? 'html' : 'plain_text', sourceContentUnavailable,
        receivedAt: new Date(value.date).toISOString(), sourceReadAt: clock(), sourceFormat: 'claude_plaintext',
        authenticatedSenderDomain: null, truncated: body.length > 256_000,
        attachmentCount: Array.isArray(value.attachments) ? value.attachments.length : 0,
        attachmentContentRead: false };

    }
  };
}
