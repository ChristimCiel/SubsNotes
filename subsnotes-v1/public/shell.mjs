/**
 * Shared shell helpers: toast, suite menu, coach, language wiring.
 */
import { applyI18n, detectLang, toggleLang, t } from './i18n.mjs';

export function showToast(message, ms = 4000) {
  let el = document.querySelector('.sx-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'sx-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('is-visible'), ms);
}

export function wireShell({ page = 'overview', guide = false } = {}) {
  let lang = applyI18n(document, detectLang());

  document.querySelectorAll('.sx-lang').forEach((btn) => {
    btn.addEventListener('click', () => {
      lang = toggleLang(document);
      document.dispatchEvent(new CustomEvent('sx:lang', { detail: { lang } }));
    });
  });

  const wordmark = document.querySelector('.sx-wordmark');
  if (wordmark) {
    wordmark.addEventListener('click', (e) => {
      if (e.target.closest('.sx-suite-menu')) return;
      const open = wordmark.getAttribute('aria-expanded') === 'true';
      wordmark.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    document.addEventListener('click', (e) => {
      if (!wordmark.contains(e.target)) wordmark.setAttribute('aria-expanded', 'false');
    });
  }

  // Preserve ?lang= on suite / tab links
  document.querySelectorAll('a[href]').forEach((a) => {
    try {
      const url = new URL(a.getAttribute('href'), location.href);
      if (url.origin === location.origin) {
        url.searchParams.set('lang', document.documentElement.lang || 'en');
        if (a.getAttribute('href').startsWith('http') && !a.getAttribute('href').includes('tagstory') && !a.getAttribute('href').includes('github')) {
          return;
        }
        if (a.dataset.keepHref) return;
        if (url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/')) {
          const rel = a.getAttribute('href');
          if (rel.startsWith('http')) return;
          const next = new URL(rel, location.href);
          next.searchParams.set('lang', document.documentElement.lang || 'en');
          a.setAttribute('href', next.pathname.split('/').pop() + next.search + next.hash);
        }
      }
    } catch {}
  });

  const sibling = document.querySelector('[data-suite-sibling]');
  if (sibling) {
    const langQ = document.documentElement.lang || 'en';
    sibling.setAttribute('href', `https://fetscape.tagstory.co/?lang=${encodeURIComponent(langQ)}`);
  }

  if (guide || new URLSearchParams(location.search).get('guide') === '1') {
    openCoach(lang);
  }

  return { getLang: () => document.documentElement.lang === 'zh-TW' ? 'zh-TW' : 'en' };
}

const COACH_STEPS = [1, 2, 3, 4, 5, 6];

export function openCoach(lang = detectLang()) {
  let aside = document.querySelector('aside.sx-coach');
  if (!aside) {
    aside = document.createElement('aside');
    aside.className = 'sx-coach';
    aside.innerHTML = `
      <div class="sx-coach__meta"><span data-coach-step></span> · <span data-i18n="coach.guide"></span></div>
      <h2 class="sx-coach__title" data-coach-title></h2>
      <p class="sx-coach__body" data-coach-body></p>
      <div class="sx-coach__actions">
        <button type="button" class="sx-btn sx-btn--ghost sx-btn--compact" data-coach-back data-i18n="coach.back"></button>
        <button type="button" class="sx-btn sx-btn--primary sx-btn--compact" data-coach-next data-i18n="coach.next"></button>
        <button type="button" class="sx-btn sx-btn--ghost sx-btn--compact" data-coach-hide data-i18n="coach.hide"></button>
      </div>`;
    document.body.appendChild(aside);
  }
  let step = 1;
  const render = () => {
    applyI18n(aside, lang);
    aside.querySelector('[data-coach-step]').textContent = `${step} / ${COACH_STEPS.length}`;
    aside.querySelector('[data-coach-title]').textContent = t(lang, `coach.${step}t`);
    aside.querySelector('[data-coach-body]').textContent = t(lang, `coach.${step}d`);
    aside.querySelector('[data-coach-back]').disabled = step === 1;
    aside.querySelector('[data-coach-next]').textContent = step === COACH_STEPS.length ? t(lang, 'coach.hide') : t(lang, 'coach.next');
  };
  aside.querySelector('[data-coach-back]').onclick = () => { step = Math.max(1, step - 1); render(); };
  aside.querySelector('[data-coach-next]').onclick = () => {
    if (step >= COACH_STEPS.length) { aside.remove(); return; }
    step += 1; render();
  };
  aside.querySelector('[data-coach-hide]').onclick = () => aside.remove();
  aside.hidden = false;
  render();
}

export function navHtml({ active = 'overview', judgeActive = false } = {}) {
  const overviewCurrent = active === 'overview' ? 'aria-current="page" class="is-active"' : '';
  const guidedCurrent = active === 'guided' ? 'aria-current="page" class="is-active"' : '';
  return `
  <header class="sx-nav">
    <div class="sx-nav__inner">
      <button type="button" class="sx-wordmark" aria-expanded="false" aria-haspopup="true">
        SubsNotes
        <span class="sx-suite" data-i18n="nav.suite">by TAG Story Labs</span>
        <span class="sx-suite-menu" role="menu">
          <a data-suite-sibling href="https://fetscape.tagstory.co/" role="menuitem" data-i18n="nav.switch">Switch to Fetscape ↗</a>
        </span>
      </button>
      <nav class="sx-tabs" aria-label="Primary">
        <a href="index.html" ${overviewCurrent} data-i18n="nav.overview">Overview</a>
        <a href="supervised.html" ${guidedCurrent} data-i18n="nav.guided">Guided cancel</a>
      </nav>
      <div class="sx-nav__right">
        <a class="sx-judge-pill${judgeActive ? ' is-active' : ''}" href="judge.html" data-i18n="nav.judge">Judge Mode</a>
        <button type="button" class="sx-lang" data-i18n="nav.lang">中文</button>
      </div>
    </div>
  </header>
  <div class="sx-tabs--row" aria-label="Primary mobile">
    <a href="index.html" class="sx-btn sx-btn--ghost sx-btn--compact${active === 'overview' ? ' is-active' : ''}" data-i18n="nav.overview">Overview</a>
    <a href="supervised.html" class="sx-btn sx-btn--ghost sx-btn--compact${active === 'guided' ? ' is-active' : ''}" data-i18n="nav.guided">Guided cancel</a>
  </div>`;
}

export function footerHtml() {
  return `
  <footer class="sx-footer">
    <div class="sx-footer__inner">
      <span>SubsNotes</span>
      <span data-i18n="footer.fictional">Fictional sample data</span>
      <a data-suite-sibling href="https://fetscape.tagstory.co/" data-i18n="footer.sibling">Fetscape</a>
      <a href="https://github.com/ChristimCiel/SubsNotes" data-keep-href="1" data-i18n="footer.github">GitHub</a>
    </div>
  </footer>`;
}
