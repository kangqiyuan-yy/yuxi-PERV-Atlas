// Site-wide custom tooltip (replaces native title tooltips).
(function () {
  const SHOW_DELAY = 320;
  const HIDE_DELAY = 60;
  const GAP = 8;

  let tipEl = null;
  let anchor = null;
  let pendingEl = null;
  let showTimer = null;
  let hideTimer = null;

  function ensureTip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'perv-tooltip';
      tipEl.setAttribute('role', 'tooltip');
      tipEl.hidden = true;
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  function tipTarget(el) {
    return el && el.closest ? el.closest('[data-tip], [data-i18n-tip]') : null;
  }

  function getText(el) {
    if (!el) return '';
    const i18nKey = el.dataset.i18nTip;
    if (i18nKey && window.I18n) return window.I18n.t(i18nKey);
    return el.dataset.tip || '';
  }

  // Walk up from the anchor and intersect the viewport with the bounds of
  // any clipping ancestor (overflow hidden/auto/scroll), e.g. a narrow
  // side panel. This keeps long tooltips from spilling past a panel's own
  // edge even when the browser viewport itself is much wider.
  function getBounds(el) {
    let left = 0;
    let right = window.innerWidth;
    let node = el ? el.parentElement : null;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|hidden|scroll)/.test(style.overflowX)) {
        const r = node.getBoundingClientRect();
        left = Math.max(left, r.left);
        right = Math.min(right, r.right);
      }
      node = node.parentElement;
    }
    if (right - left < 80) { left = 0; right = window.innerWidth; }
    return { left, right };
  }

  function positionTip(el) {
    const tip = ensureTip();
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const tipRect = tip.getBoundingClientRect();
    const bounds = getBounds(el);

    let top = rect.bottom + GAP;
    if (top + tipRect.height > vh - GAP && rect.top - tipRect.height - GAP >= GAP) {
      top = rect.top - tipRect.height - GAP;
    }
    top = Math.max(GAP, Math.min(top, vh - tipRect.height - GAP));

    // Single line: center on anchor, then shift left (there's usually
    // plenty of room there) if the right edge would overflow the
    // available bounds - the viewport, or a clipping ancestor if the
    // anchor sits inside a narrower panel.
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    if (left + tipRect.width > bounds.right - GAP) {
      left = bounds.right - tipRect.width - GAP;
    }
    left = Math.max(bounds.left + GAP, left);

    tip.style.top = `${Math.round(top + window.scrollY)}px`;
    tip.style.left = `${Math.round(left + window.scrollX)}px`;
  }

  function show(el) {
    const text = getText(el);
    if (!text) return;
    clearTimeout(hideTimer);
    anchor = el;
    const tip = ensureTip();
    tip.textContent = text;
    tip.hidden = false;
    positionTip(el);
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    pendingEl = null;
    anchor = null;
    if (tipEl) tipEl.hidden = true;
  }

  function sanitizeAnchor() {
    if (anchor && !document.contains(anchor)) hide();
    else if (pendingEl && !document.contains(pendingEl)) {
      clearTimeout(showTimer);
      pendingEl = null;
    }
  }

  function scheduleShow(el) {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    pendingEl = el;
    showTimer = setTimeout(() => {
      pendingEl = null;
      show(el);
    }, SHOW_DELAY);
  }

  function onPointerOver(e) {
    sanitizeAnchor();
    const el = tipTarget(e.target);
    if (!el) return;
    if (anchor === el) return;
    scheduleShow(el);
  }

  function onPointerOut(e) {
    const el = tipTarget(e.target);
    if (!el) return;
    const related = e.relatedTarget;
    if (related && el.contains(related)) return;

    if (pendingEl === el) {
      clearTimeout(showTimer);
      pendingEl = null;
    }

    if (anchor === el) {
      clearTimeout(showTimer);
      hideTimer = setTimeout(hide, HIDE_DELAY);
    }
  }

  function refreshVisible() {
    sanitizeAnchor();
    if (!anchor) return;
    const text = getText(anchor);
    if (!text) { hide(); return; }
    tipEl.textContent = text;
    positionTip(anchor);
  }

  function stripNativeTitle(el) {
    if (el && el.hasAttribute && el.hasAttribute('title')) {
      el.removeAttribute('title');
    }
  }

  function migrateLegacy(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
      if (!el.dataset.i18nTip) el.dataset.i18nTip = el.dataset.i18nTitle;
      el.removeAttribute('data-i18n-title');
      stripNativeTitle(el);
    });
    scope.querySelectorAll('[data-tip], [data-i18n-tip]').forEach(stripNativeTitle);
  }

  const PervTip = {
    hide,
    refresh: refreshVisible,
    migrate: migrateLegacy,
    set(el, text) {
      if (!el) return;
      if (text) el.dataset.tip = text;
      else delete el.dataset.tip;
      delete el.dataset.i18nTip;
      stripNativeTitle(el);
      if (anchor === el && !text) hide();
    },
    setI18n(el, key) {
      if (!el) return;
      if (key) el.dataset.i18nTip = key;
      else delete el.dataset.i18nTip;
      delete el.dataset.tip;
      stripNativeTitle(el);
      if (anchor === el && !key) hide();
    },
    clear(el) {
      if (!el) return;
      delete el.dataset.tip;
      delete el.dataset.i18nTip;
      stripNativeTitle(el);
      if (anchor === el) hide();
    },
    syncFromSelect(sel, display) {
      if (!sel || !display) return;
      if (sel.dataset.i18nTip) {
        display.dataset.i18nTip = sel.dataset.i18nTip;
        delete display.dataset.tip;
      } else if (sel.dataset.tip) {
        display.dataset.tip = sel.dataset.tip;
        delete display.dataset.i18nTip;
      } else {
        delete display.dataset.tip;
        delete display.dataset.i18nTip;
      }
      stripNativeTitle(sel);
      stripNativeTitle(display);
    },
  };

  window.PervTip = PervTip;

  document.addEventListener('mouseover', onPointerOver, true);
  document.addEventListener('mouseout', onPointerOut, true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('i18nchange', refreshVisible);

  const anchorObserver = new MutationObserver(sanitizeAnchor);
  anchorObserver.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('DOMContentLoaded', () => {
    migrateLegacy(document);
    const tracksBody = document.getElementById('g-tracks-body');
    if (tracksBody) {
      tracksBody.addEventListener('scroll', hide, { passive: true, capture: true });
    }
  });
})();
