/**
 * Suite i18n — EN + zh-TW for SubsNotes product pages.
 * Persist: localStorage['sx-lang']; accept ?lang=en|zh-TW.
 */

export const DICT = {
  en: {
    'nav.overview': 'Overview',
    'nav.guided': 'Guided cancel',
    'nav.judge': 'Judge Mode',
    'nav.lang': '中文',
    'nav.suite': 'by TAG Story Labs',
    'nav.switch': 'Switch to Fetscape ↗',
    'nav.hideTour': 'Hide tour',
    'chip.sample': 'Sample data · fictional',
    'hero.eyebrow': 'For people who pay for too many AI tools',
    'hero.h1': 'Keep the AI tools you use. Drop the rest.',
    'hero.sub': 'SubsNotes finds overlapping subscriptions, explains why, and cancels only what you approve.',
    'hero.cta': 'Review 3 findings',
    'hero.secondary': 'How it stays safe',
    'snapshot.month': 'This month',
    'snapshot.of': 'of',
    'snapshot.envelope': 'envelope',
    'snapshot.review': 'to review',
    'snapshot.saving': 'potential saving',
    'snapshot.tools': 'tools',
    'snapshot.overlaps': 'overlaps',
    'snapshot.unused': 'unused',
    'step.detect': 'Detect',
    'step.judge': 'Judge',
    'step.approve': 'Approve',
    'step.execute': 'Execute',
    'step.verify': 'Verify',
    'findings.title': 'Findings',
    'findings.approveCancel': 'Approve cancel',
    'findings.approveDowngrade': 'Approve downgrade',
    'findings.keep': 'Keep',
    'findings.snooze': 'Snooze 30 days',
    'findings.why': 'Why?',
    'findings.saves': 'saves',
    'findings.confidenceHigh': 'High confidence',
    'findings.confidenceMed': 'Medium confidence',
    'findings.next': 'Next finding',
    'findings.audit': 'View audit log',
    'findings.done': "You're within your envelope this month.",
    'findings.guided': 'Try a guided cancel yourself',
    'approval.kicker': 'Needs your approval',
    'approval.approveRun': 'Approve & run',
    'approval.notNow': 'Not now',
    'approval.reassure': 'Nothing runs until you approve. You can revoke any time.',
    'approval.what': 'What will happen',
    'approval.scope': 'Scope',
    'approval.limit': 'Max amount',
    'approval.expires': 'Expires',
    'approval.executedBy': 'Executed by',
    'approval.tech': 'Technical details',
    'approval.executing': 'Cancelling on Premium Streaming…',
    'approval.handling': 'Handling 2 retention screens for you',
    'receipt.cancelled': 'Cancelled',
    'budget.title': 'Budget envelope',
    'budget.note': 'No money is held',
    'budget.held': 'Licensed-partner wallets come later. This envelope only tracks capacity.',
    'safety.title': 'How it stays safe',
    'safety.1t': 'Reads receipts on your device',
    'safety.1d': 'Local agents never upload raw financial documents.',
    'safety.2t': 'Signed summaries only',
    'safety.2d': 'Ed25519 envelopes with a strict field allowlist.',
    'safety.3t': 'You approve every action',
    'safety.3d': 'Mandates set merchant, action, limit, and expiry.',
    'safety.4t': 'Every step is logged',
    'safety.4d': 'Append-only audit trail you can review anytime.',
    'safety.tiers': 'Execution tiers (T0 / T1 / T2)',
    'safety.limits': 'Known limits',
    'close.price': 'US$30/month when available. Today everything here is a fictional sample.',
    'footer.fictional': 'Fictional sample data',
    'footer.sibling': 'Fetscape',
    'footer.github': 'GitHub',
    'judge.purpose': 'One-click offline demo of the closed loop. Pauses for your approval at step 3.',
    'judge.run': 'Run the full loop',
    'judge.running': 'Running demo…',
    'judge.complete': 'Demo Complete',
    'judge.approve': 'Approve & run',
    'judge.pause': 'Waiting for your approval',
    'supervised.h1': 'T1: Supervised Cancellation',
    'supervised.ready': 'Ready to Start',
    'toast.snoozed': 'Snoozed for 30 days',
    'toast.kept': 'Kept for now',
    'coach.guide': 'Guide',
    'coach.next': 'Next',
    'coach.back': 'Back',
    'coach.hide': 'Hide tour',
    'coach.1t': 'See your sample stack',
    'coach.1d': 'Spend versus envelope and the top finding load instantly from fictional data.',
    'coach.2t': 'Review a finding',
    'coach.2d': 'Open Why? for reasons, then Approve cancel to start a mandate.',
    'coach.3t': 'Approve the mandate',
    'coach.3d': 'Scope, max amount, and expiry are explicit. Nothing runs until you approve.',
    'coach.4t': 'Watch execute and verify',
    'coach.4d': 'The agent handles retention screens and returns a confirmation id.',
    'coach.5t': 'Read the receipt',
    'coach.5d': 'Savings and the audit trail stay on device for this demo.',
    'coach.6t': 'Try a guided cancel',
    'coach.6d': 'Use Guided cancel (T1) to walk the fictional merchant yourself.'
  },
  'zh-TW': {
    'nav.overview': '總覽',
    'nav.guided': '引導取消',
    'nav.judge': '評審模式',
    'nav.lang': 'English',
    'nav.suite': 'by TAG Story Labs',
    'nav.switch': '切換至 Fetscape ↗',
    'nav.hideTour': '隱藏導覽',
    'chip.sample': '範例資料・虛構',
    'hero.eyebrow': '給訂太多 AI 工具的人',
    'hero.h1': '留下常用的 AI 工具，砍掉其餘的。',
    'hero.sub': 'SubsNotes 找出重疊訂閱、說明原因，並只取消你核准的項目。',
    'hero.cta': '查看 3 項建議',
    'hero.secondary': '如何確保安全',
    'snapshot.month': '本月',
    'snapshot.of': '／',
    'snapshot.envelope': '預算包絡',
    'snapshot.review': '待檢視',
    'snapshot.saving': '預估可省',
    'snapshot.tools': '項工具',
    'snapshot.overlaps': '項重疊',
    'snapshot.unused': '項未使用',
    'step.detect': '偵測',
    'step.judge': '判斷',
    'step.approve': '核准',
    'step.execute': '執行',
    'step.verify': '驗證',
    'findings.title': '建議清單',
    'findings.approveCancel': '核准取消',
    'findings.approveDowngrade': '核准降級',
    'findings.keep': '保留',
    'findings.snooze': '30 天後再提醒',
    'findings.why': '為什麼？',
    'findings.saves': '可省',
    'findings.confidenceHigh': '高信心',
    'findings.confidenceMed': '中信心',
    'findings.next': '下一項',
    'findings.audit': '查看稽核紀錄',
    'findings.done': '本月已落在預算包絡內。',
    'findings.guided': '自己試一次引導取消',
    'approval.kicker': '需要你的核准',
    'approval.approveRun': '核准並執行',
    'approval.notNow': '先不要',
    'approval.reassure': '你核准前不會執行任何動作，隨時可撤回。',
    'approval.what': '將會發生',
    'approval.scope': '範圍',
    'approval.limit': '金額上限',
    'approval.expires': '到期',
    'approval.executedBy': '執行者',
    'approval.tech': '技術細節',
    'approval.executing': '正在取消…',
    'approval.handling': '正在替你處理 2 個挽留畫面',
    'receipt.cancelled': '已取消',
    'budget.title': '預算包絡',
    'budget.note': '不代管任何資金',
    'budget.held': '授權合作錢包之後才會出現。此包絡只追蹤容量。',
    'safety.title': '如何確保安全',
    'safety.1t': '在你裝置上讀取收據',
    'safety.1d': '本機代理從不上傳原始財務文件。',
    'safety.2t': '只傳送已簽名摘要',
    'safety.2d': 'Ed25519 信封搭配嚴格欄位白名單。',
    'safety.3t': '每個動作都需你核准',
    'safety.3d': '授權指定商家、動作、上限與到期。',
    'safety.4t': '每一步都有紀錄',
    'safety.4d': '只附加稽核軌跡，隨時可回看。',
    'safety.tiers': '執行層級（T0 / T1 / T2）',
    'safety.limits': '已知限制',
    'close.price': '正式上線後為每月 US$30。今天這裡全是虛構範例。',
    'footer.fictional': '虛構範例資料',
    'footer.sibling': 'Fetscape',
    'footer.github': 'GitHub',
    'judge.purpose': '一鍵離線展示完整閉環。在第 3 步暫停等你核准。',
    'judge.run': '執行完整流程',
    'judge.running': '執行展示中…',
    'judge.complete': '展示完成',
    'judge.approve': '核准並執行',
    'judge.pause': '等待你的核准',
    'supervised.h1': 'T1: Supervised Cancellation',
    'supervised.ready': 'Ready to Start',
    'toast.snoozed': '已延後 30 天',
    'toast.kept': '暫時保留',
    'coach.guide': '導覽',
    'coach.next': '下一步',
    'coach.back': '上一步',
    'coach.hide': '隱藏導覽',
    'coach.1t': '查看範例工具組合',
    'coach.1d': '支出對預算與首要建議會立刻載入虛構資料。',
    'coach.2t': '檢視一項建議',
    'coach.2d': '打開「為什麼？」看理由，再按核准取消以建立授權。',
    'coach.3t': '核准授權',
    'coach.3d': '範圍、金額上限與到期都很明確。你核准前不會執行。',
    'coach.4t': '看執行與驗證',
    'coach.4d': '代理會處理挽留畫面並回傳確認編號。',
    'coach.5t': '閱讀收據',
    'coach.5d': '節省金額與稽核紀錄都留在本機示範中。',
    'coach.6t': '試一次引導取消',
    'coach.6d': '用「引導取消 (T1)」親自走一遍虛構商家。'
  }
};

export function detectLang() {
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get('lang');
  if (fromQuery === 'en' || fromQuery === 'zh-TW') return fromQuery;
  try {
    const stored = localStorage.getItem('sx-lang');
    if (stored === 'en' || stored === 'zh-TW') return stored;
  } catch {}
  const nav = (navigator.language || 'en').toLowerCase();
  return nav.startsWith('zh') ? 'zh-TW' : 'en';
}

export function setLang(lang) {
  const next = lang === 'zh-TW' ? 'zh-TW' : 'en';
  try { localStorage.setItem('sx-lang', next); } catch {}
  document.documentElement.lang = next;
  return next;
}

export function t(lang, key) {
  const table = DICT[lang] || DICT.en;
  return table[key] ?? DICT.en[key] ?? key;
}

export function applyI18n(root = document, lang = detectLang()) {
  setLang(lang);
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const value = t(lang, key);
    if (el.dataset.i18nAttr) {
      el.setAttribute(el.dataset.i18nAttr, value);
    } else {
      el.textContent = value;
    }
  });
  const langBtn = root.querySelector('.sx-lang');
  if (langBtn) langBtn.textContent = t(lang, 'nav.lang');
  return lang;
}

export function toggleLang(root = document) {
  const current = document.documentElement.lang === 'zh-TW' ? 'zh-TW' : 'en';
  return applyI18n(root, current === 'en' ? 'zh-TW' : 'en');
}
