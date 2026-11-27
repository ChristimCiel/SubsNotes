/**
 * Honest user actions for real subscriptions: billing links, mailto, .ics reminders.
 */

function pad(n) {
  return String(n).padStart(2, '0');
}

function toIcsDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
}

/**
 * Build an .ics calendar event 2 days before the target date (or tomorrow if sooner).
 */
export function buildIcsReminder({
  title,
  description = '',
  targetDate,
  daysBefore = 2
}) {
  const target = new Date(targetDate);
  if (!Number.isFinite(target.getTime())) {
    throw new Error('Invalid target date for .ics');
  }
  const start = new Date(target.getTime() - daysBefore * 86400000);
  // If already past, schedule for tomorrow morning UTC
  if (start.getTime() < Date.now()) {
    start.setTime(Date.now() + 86400000);
  }
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const uid = `subsnotes-${Date.now()}@tagstory.co`;
  const stamp = toIcsDate(new Date());
  const escape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SubsNotes//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${toIcsDate(start)}`,
    `DTEND:${toIcsDate(end)}`,
    `SUMMARY:${escape(title)}`,
    `DESCRIPTION:${escape(description)}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

export function downloadTextFile(filename, content, mime = 'text/plain') {
  if (typeof document === 'undefined') return content;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return content;
}

export function downloadIcs(opts) {
  const ics = buildIcsReminder(opts);
  const safe = String(opts.title || 'reminder').replace(/[^\w\-]+/g, '_').slice(0, 40);
  downloadTextFile(`${safe}.ics`, ics, 'text/calendar');
  return ics;
}

/**
 * Cancellation / refund email templates (EN + zh-TW).
 */
export function buildActionEmail({ lang = 'en', kind = 'cancel', merchant, plan, amountLabel }) {
  const isZh = lang === 'zh-TW';
  if (kind === 'payment') {
    return {
      subject: isZh
        ? `關於 ${merchant} 的付款失敗`
        : `About a failed payment on ${merchant}`,
      body: isZh
        ? `您好，\n\n我收到 ${merchant}${plan ? `（${plan}）` : ''} 的付款失敗通知。請協助確認帳單狀態，或提供更新付款方式的連結。\n\n謝謝。`
        : `Hello,\n\nI received a failed-payment notice for ${merchant}${plan ? ` (${plan})` : ''}. Please confirm the billing status or send a link to update my payment method.\n\nThank you.`
    };
  }
  if (kind === 'downgrade') {
    return {
      subject: isZh
        ? `申請將 ${merchant} 降級`
        : `Request to downgrade ${merchant}`,
      body: isZh
        ? `您好，\n\n我想將 ${merchant}${plan ? `（目前：${plan}）` : ''} 降級到較低方案。目前金額約 ${amountLabel || '—'}。請告知如何辦理。\n\n謝謝。`
        : `Hello,\n\nI would like to downgrade ${merchant}${plan ? ` (currently: ${plan})` : ''} to a lower plan. Current amount is about ${amountLabel || '—'}. Please let me know how to proceed.\n\nThank you.`
    };
  }
  return {
    subject: isZh
      ? `申請取消 ${merchant} 訂閱`
      : `Request to cancel ${merchant}`,
    body: isZh
      ? `您好，\n\n我想取消 ${merchant}${plan ? `（${plan}）` : ''} 的訂閱${amountLabel ? `（目前約 ${amountLabel}）` : ''}。請確認取消並停止後續扣款。\n\n謝謝。`
      : `Hello,\n\nI would like to cancel my ${merchant}${plan ? ` (${plan})` : ''} subscription${amountLabel ? ` (currently about ${amountLabel})` : ''}. Please confirm the cancellation and stop future charges.\n\nThank you.`
  };
}

export function mailtoHref(email) {
  return `mailto:?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`;
}

export async function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  return false;
}
