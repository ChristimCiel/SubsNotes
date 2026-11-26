/**
 * SubsNotes i18n — EN + zh-TW.
 * Persist: localStorage['sx-lang']; accept ?lang=en|zh-TW.
 * v2.* keys are the home product surface. Judge/supervised keep their own keys.
 */

export const DICT = {
  en: {
    'nav.lang': '中文',
    'nav.judge': 'Judge Mode',
    'step.detect': 'Detect',
    'step.judge': 'Judge',
    'step.approve': 'Approve',
    'step.execute': 'Execute',
    'step.verify': 'Verify',
    'judge.purpose': 'One-click offline demo of the closed loop. Pauses for your approval at step 3.',
    'judge.run': 'Run the full loop',
    'judge.running': 'Running demo…',
    'judge.complete': 'Demo Complete',
    'judge.approve': 'Approve & run',
    'judge.pause': 'Waiting for your approval',
    'judge.back': '← Back to SubsNotes',
    'approval.kicker': 'Needs your approval',
    'approval.approveRun': 'Approve & run',
    'approval.notNow': 'Not now',
    'approval.reassure': 'Nothing runs until you approve. You can revoke any time.',
    'approval.what': 'What will happen',
    'approval.scope': 'Scope',
    'approval.limit': 'Max amount',
    'approval.expires': 'Expires',
    'approval.executedBy': 'Executed by',
    'chip.sample': 'Sample data',
    'supervised.h1': 'Cancel it yourself, step by step',
    'supervised.ready': 'Ready to Start',

    'v2.skip': 'Skip to decision',
    'v2.bar.tools': 'Your 7 tools',
    'v2.bar.judge': 'Judge demo',
    'v2.bar.toolsMobile': 'See all 7 tools',
    'v2.hero.label': 'Your AI tools this month',
    'v2.chip.sample': 'Sample data',
    'v2.unit.mo': '/mo',
    'v2.hook': '<b>US${waste}</b> of it pays for overlap and tools you don\'t use.',
    'v2.hook.done': 'Everything left is something you use.',
    'v2.saved': 'Saving US${n}/mo so far',
    'v2.strip.keep': 'Grey: you use it',
    'v2.strip.trim': 'Striped: overlap or unused',
    'v2.card.of': '{i} of {n}',
    'v2.card.approve': 'Approve · save US${n}/mo',
    'v2.card.keep': 'Keep it',
    'v2.card.why': 'Why this, and what happens',
    'v2.card.will': 'SubsNotes will {action} {merchant} for you — nothing else. The permission expires in 7 days.',
    'v2.action.switch': 'switch {merchant} to {plan}',
    'v2.action.cancel': 'cancel {merchant}',
    'v2.title.downgrade': '{merchant} → {plan}',
    'v2.title.cancel': 'Cancel {merchant}',
    'v2.reason.price_dup': 'The price went up {pct}% this month, and {other} already covers {category}.',
    'v2.reason.unused_dup': 'You haven\'t opened it in {days} days, and {other} does the same job.',
    'v2.reason.dup': '{other} already covers {category}. {plan} keeps what you actually use.',
    'v2.reason.unused': 'You haven\'t opened it in {days} days.',
    'v2.run.title': 'Working on it…',
    'v2.run.1': 'Signed in to the merchant',
    'v2.run.2': 'Skipped 2 retention offers',
    'v2.run.3': 'Confirmed the change',
    'v2.done.kicker': 'Done',
    'v2.done.saved': '/mo saved',
    'v2.done.next': 'Next',
    'v2.all.title': 'You\'re all set',
    'v2.all.sub': 'You now spend US${n}/mo, on tools you actually use.',
    'v2.all.log': 'See what changed',
    'v2.all.guided': 'Cancel one yourself, step by step',
    'v2.toast.kept': 'Kept {merchant}. We won\'t ask again this month.',
    'v2.how.1t': 'Finds the overlap',
    'v2.how.1d': 'Reads your receipts on your device and spots tools that do the same job.',
    'v2.how.2t': 'Asks first',
    'v2.how.2d': 'Nothing is cancelled or changed until you tap approve.',
    'v2.how.3t': 'Shows proof',
    'v2.how.3d': 'Every change comes back with a confirmation number.',
    'v2.fine.price': 'US$30/month when it launches.',
    'v2.fine.safety': 'Privacy & safety details',
    'v2.fine.sibling': 'Also from TAG Story Labs: Fetscape',
    'v2.sheet.tools': 'Your tools',
    'v2.sheet.safety': 'Privacy & safety details',
    'v2.sheet.log': 'Change log',
    'v2.sheet.close': 'Close',
    'v2.sheet.review': 'Review',
    'v2.sheet.budget': 'Monthly budget US${n} · no money is held',
    'v2.sheet.emptyLog': 'No changes yet.',
    'v2.category.Chat': 'chat',
    'v2.category.Notes': 'notes',
    'v2.category.Coding': 'coding',
    'v2.category.Image': 'images',
    'v2.safety.local': 'Reads receipts on your device. Local agents never upload raw financial documents.',
    'v2.safety.signed': 'Signed summaries only. Ed25519 envelopes with a strict field allowlist.',
    'v2.safety.mandate': 'You approve every action. Mandates set merchant, action, limit, and expiry.',
    'v2.safety.audit': 'Every step is logged in an append-only audit trail.',
    'v2.safety.tiers': 'Execution tiers: T0 deep links (Apple, Google Play, LINE Pay, 全支付, 街口). T1 supervised step-by-step. T2 autonomous Playwright within a mandate — demoed only on the fictional merchant.',
    'v2.safety.limits': 'Known limits: Apple / Google Play stay deep-link only. No real money, real accounts, or live merchant cancellations in this MVP. US$30/month when available.',
  },
  'zh-TW': {
    'nav.lang': 'English',
    'nav.judge': '評審模式',
    'step.detect': '偵測',
    'step.judge': '判斷',
    'step.approve': '核准',
    'step.execute': '執行',
    'step.verify': '驗證',
    'judge.purpose': '一鍵離線展示完整閉環。在第 3 步暫停等你核准。',
    'judge.run': '執行完整流程',
    'judge.running': '執行展示中…',
    'judge.complete': '展示完成',
    'judge.approve': '核准並執行',
    'judge.pause': '等待你的核准',
    'judge.back': '← 回到 SubsNotes',
    'approval.kicker': '需要你的核准',
    'approval.approveRun': '核准並執行',
    'approval.notNow': '先不要',
    'approval.reassure': '你核准前不會執行任何動作，隨時可撤回。',
    'approval.what': '將會發生',
    'approval.scope': '範圍',
    'approval.limit': '金額上限',
    'approval.expires': '到期',
    'approval.executedBy': '執行者',
    'chip.sample': '範例資料',
    'supervised.h1': '自己動手，一步步取消',
    'supervised.ready': 'Ready to Start',

    'v2.skip': '跳到決策卡',
    'v2.bar.tools': '你的 7 個工具',
    'v2.bar.judge': '評審展示',
    'v2.bar.toolsMobile': '查看全部 7 個工具',
    'v2.hero.label': '本月的 AI 工具支出',
    'v2.chip.sample': '範例資料',
    'v2.unit.mo': '/月',
    'v2.hook': '其中 <b>US${waste}</b> 花在功能重疊和沒在用的工具上。',
    'v2.hook.done': '剩下的都是你真的在用的工具。',
    'v2.saved': '目前每月已省 US${n}',
    'v2.strip.keep': '灰色：你有在用',
    'v2.strip.trim': '斜線：重疊或沒在用',
    'v2.card.of': '第 {i} 項，共 {n} 項',
    'v2.card.approve': '核准 · 每月省 US${n}',
    'v2.card.keep': '保留',
    'v2.card.why': '為什麼，以及會發生什麼',
    'v2.card.will': 'SubsNotes 只會替你{action} {merchant}，不做其他事。這次授權 7 天後失效。',
    'v2.action.switch': '把 {merchant} 降級為 {plan}',
    'v2.action.cancel': '取消 {merchant}',
    'v2.title.downgrade': '{merchant} → {plan} 方案',
    'v2.title.cancel': '取消 {merchant}',
    'v2.reason.price_dup': '這個月漲價 {pct}%，而且 {other} 已經涵蓋{category}。',
    'v2.reason.unused_dup': '你已經 {days} 天沒打開，而且 {other} 做的是同一件事。',
    'v2.reason.dup': '{other} 已經涵蓋{category}。{plan} 方案保留你真正會用的功能。',
    'v2.reason.unused': '你已經 {days} 天沒打開。',
    'v2.run.title': '處理中…',
    'v2.run.1': '已登入商家',
    'v2.run.2': '已略過 2 個挽留優惠',
    'v2.run.3': '已確認變更',
    'v2.done.kicker': '完成',
    'v2.done.saved': '/月 已省下',
    'v2.done.next': '下一項',
    'v2.all.title': '全部處理好了',
    'v2.all.sub': '現在每月花 US${n}，都是你真的在用的工具。',
    'v2.all.log': '查看變更紀錄',
    'v2.all.guided': '自己動手，一步步取消',
    'v2.toast.kept': '已保留 {merchant}，本月不會再問你。',
    'v2.how.1t': '找出重疊',
    'v2.how.1d': '在你的裝置上讀取收據，找出功能重複的工具。',
    'v2.how.2t': '先問你',
    'v2.how.2d': '你按下核准之前，不會取消或變更任何東西。',
    'v2.how.3t': '附上證明',
    'v2.how.3d': '每個變更都會回傳確認編號。',
    'v2.fine.price': '正式上線後每月 US$30。',
    'v2.fine.safety': '隱私與安全細節',
    'v2.fine.sibling': 'TAG Story Labs 的另一個產品：Fetscape',
    'v2.sheet.tools': '你的工具',
    'v2.sheet.safety': '隱私與安全細節',
    'v2.sheet.log': '變更紀錄',
    'v2.sheet.close': '關閉',
    'v2.sheet.review': '待檢視',
    'v2.sheet.budget': '每月預算 US${n} · 不代管任何資金',
    'v2.sheet.emptyLog': '尚無變更。',
    'v2.category.Chat': '聊天',
    'v2.category.Notes': '筆記',
    'v2.category.Coding': '程式',
    'v2.category.Image': '圖像',
    'v2.safety.local': '在你裝置上讀取收據。本機代理從不上傳原始財務文件。',
    'v2.safety.signed': '只傳送已簽名摘要。Ed25519 信封搭配嚴格欄位白名單。',
    'v2.safety.mandate': '每個動作都需你核准。授權指定商家、動作、上限與到期。',
    'v2.safety.audit': '每一步都寫入只附加的稽核軌跡。',
    'v2.safety.tiers': '執行層級：T0 深連結（Apple、Google Play、LINE Pay、全支付、街口）。T1 逐步引導。T2 在授權範圍內以 Playwright 自主執行——僅在虛構商家上示範。',
    'v2.safety.limits': '已知限制：Apple / Google Play 維持深連結。此 MVP 沒有真實金錢、真實帳號或線上商家取消。正式上線後每月 US$30。',
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

export function t(lang, key, vars = {}) {
  const table = DICT[lang] || DICT.en;
  let value = table[key] ?? DICT.en[key] ?? key;
  Object.entries(vars).forEach(([k, v]) => {
    value = value.replaceAll(`{${k}}`, String(v));
  });
  return value;
}

export function applyI18n(root = document, lang = detectLang()) {
  setLang(lang);
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const value = t(lang, key);
    if (el.dataset.i18nAttr) {
      el.setAttribute(el.dataset.i18nAttr, value);
    } else if (!el.dataset.i18nHtml) {
      el.textContent = value;
    } else {
      el.innerHTML = value;
    }
  });
  const langBtn = root.querySelector('#langBtn, .sx-lang, [data-testid="language-toggle"]');
  if (langBtn) langBtn.textContent = t(lang, 'nav.lang');
  return lang;
}

export function toggleLang(root = document) {
  const current = document.documentElement.lang === 'zh-TW' ? 'zh-TW' : 'en';
  return applyI18n(root, current === 'en' ? 'zh-TW' : 'en');
}

/** Keys used on the primary home surface (must stay jargon-free). */
export const V2_PRIMARY_KEYS = [
  'v2.skip', 'v2.bar.tools', 'v2.bar.judge', 'v2.bar.toolsMobile',
  'v2.hero.label', 'v2.chip.sample', 'v2.unit.mo', 'v2.hook', 'v2.hook.done', 'v2.saved',
  'v2.strip.keep', 'v2.strip.trim', 'v2.card.of', 'v2.card.approve', 'v2.card.keep', 'v2.card.why',
  'v2.card.will', 'v2.action.switch', 'v2.action.cancel', 'v2.title.downgrade', 'v2.title.cancel',
  'v2.reason.price_dup', 'v2.reason.unused_dup', 'v2.reason.dup', 'v2.reason.unused',
  'v2.run.title', 'v2.run.1', 'v2.run.2', 'v2.run.3',
  'v2.done.kicker', 'v2.done.saved', 'v2.done.next',
  'v2.all.title', 'v2.all.sub', 'v2.all.log', 'v2.all.guided', 'v2.toast.kept',
  'v2.how.1t', 'v2.how.1d', 'v2.how.2t', 'v2.how.2d', 'v2.how.3t', 'v2.how.3d',
  'v2.fine.price', 'v2.fine.safety', 'v2.fine.sibling',
  'v2.category.Chat', 'v2.category.Notes', 'v2.category.Coding', 'v2.category.Image'
];
