import { decodeGmailMessage } from './gmail.mjs';

// Accept the actual connector MIME tree. Authentication facts come from headers,
// never from an assistant's guessed sender or a text-only receipt extract.
export function fromConnectorMessage(message, mailboxEmail) {
  if (!message?.id) throw new Error('A complete Gmail message ID is required');
  // Claude's native web connector returns a flat plaintext message, not MIME.
  // It does not expose receiving-server authentication headers: keep that fact
  // unknown rather than treating a familiar sender as authenticated.
  if (Object.hasOwn(message, 'plaintextBody')) {
    if (typeof message.sender !== 'string' || !message.sender ||
        typeof message.subject !== 'string' || typeof message.plaintextBody !== 'string' ||
        !Number.isFinite(Date.parse(message.date))) throw new Error('A complete plaintext connector message is required');
    const bytes = Buffer.from(message.plaintextBody);
    return {
      id: message.id, sender: message.sender, subject: message.subject,
      receivedAt: new Date(message.date).toISOString(),
      text: bytes.subarray(0, 256_000).toString('utf8'), mailboxEmail,
      authenticatedSenderDomain: null, sourceFormat: 'claude_plaintext',
      attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
      truncated: bytes.length > 256_000
    };
  }
  const convert = part => {
    if (!part) return part;
    const mimeType = part.mime_type || part.mimeType;
    const content = part.body?.content;
    return {
      mimeType, filename: part.filename,
      headers: part.headers,
      body: { data: typeof content === 'string' ? Buffer.from(content).toString('base64url') : part.body?.data, attachmentId: part.body?.attachment_id || part.body?.attachmentId },
      parts: (part.parts || []).map(convert)
    };
  };
  return decodeGmailMessage({ id: message.id, internalDate: message.internal_date || message.internalDate, payload: convert(message.payload) }, mailboxEmail);
}

export function connectorMessages(input) {
  const value = input.structuredContent || input;
  const messages = Array.isArray(value) ? value : value.responses || (value.id ? [value] : null);
  if (!Array.isArray(messages)) throw new Error('Expected a Gmail batch response, message or array of messages');
  return messages;
}
