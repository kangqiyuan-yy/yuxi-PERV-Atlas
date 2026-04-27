// Site-wide styled select: wraps native <select> with a BLAST-style custom dropdown.
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m]);
  }

  function isCompact(sel) {
    return sel.classList.contains('homo-select')
      || sel.classList.contains('dlm-select')
      || !!sel.closest('.strand-tools');
  }

  function fitWidth(sel) {
    if (!sel) return;
    const combo = sel.closest('.blast-select-combo');
    const display = combo && combo.querySelector('.blast-select-display');
    const list = combo && combo.querySelector('.blast-combo-list');
    if (!display || !list) return;

    const listStyle = getComputedStyle(list);
    const liSample = list.querySelector('li');
    const liStyle = liSample ? getComputedStyle(liSample) : listStyle;
    const displayStyle = getComputedStyle(display);

    const probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;' +
      `font:${liStyle.font};letter-spacing:${liStyle.letterSpacing};`;
    document.body.appendChild(probe);

    let maxText = 0;
    Array.from(sel.options).forEach((o) => {
      probe.textContent = o.textContent || '';
      maxText = Math.max(maxText, probe.offsetWidth);
    });
    probe.textContent = 'M';
    const charW = probe.offsetWidth || 8;
    document.body.removeChild(probe);

    const liPadX =
      (parseFloat(liStyle.paddingLeft) || 0) + (parseFloat(liStyle.paddingRight) || 0);
    const listChrome =
      (parseFloat(listStyle.paddingLeft) || 0) +
      (parseFloat(listStyle.paddingRight) || 0) +
      (parseFloat(listStyle.borderLeftWidth) || 0) +
      (parseFloat(listStyle.borderRightWidth) || 0);
    const itemH = liSample ? liSample.offsetHeight : 31;
    const maxListH = parseFloat(listStyle.maxHeight) || 220;
    const scrollBarW = sel.options.length * itemH > maxListH ? 12 : 0;
    const listNeeded = maxText + liPadX + listChrome + scrollBarW;

    const padL = parseFloat(displayStyle.paddingLeft) || 0;
    const padR = parseFloat(displayStyle.paddingRight) || 0;
    const gap = parseFloat(displayStyle.columnGap || displayStyle.gap) || 10;
    const caretW = display.querySelector('.blast-select-caret')?.offsetWidth || 11;
    const displayNeeded = maxText + padL + padR + gap + caretW;

    const slack = parseInt(sel.getAttribute('data-fit-width-slack') || '2', 10);
    const extraChars = parseInt(sel.getAttribute('data-fit-width-chars') || '0', 10);
    const width = Math.ceil(
      Math.max(displayNeeded, listNeeded) + slack + charW * extraChars
    );

    combo.style.width = width + 'px';
    combo.classList.add('fit-width');
  }

  /**
   * @param {HTMLSelectElement} sel
   * @param {{ compact?: boolean }} [opts]
   */
  function enhance(sel, opts) {
    if (!sel || sel.tagName !== 'SELECT' || sel._refresh) return sel;
    if (sel.classList.contains('no-enhance') || sel.classList.contains('blast-native-hidden')) {
      return sel;
    }

    const compact = opts && opts.compact != null ? opts.compact : isCompact(sel);
    const combo = document.createElement('div');
    combo.className = 'blast-select-combo' + (compact ? ' compact' : '');

    sel.parentNode.insertBefore(combo, sel);
    combo.appendChild(sel);
    sel.classList.add('blast-native-hidden');
    sel.setAttribute('tabindex', '-1');

    const display = document.createElement('div');
    display.className = 'blast-select-display';
    display.setAttribute('role', 'button');
    display.setAttribute('tabindex', '0');
    display.innerHTML = '<span class="blast-select-text"></span>' +
      '<span class="blast-select-caret">▾</span>';

    const list = document.createElement('ul');
    list.className = 'blast-combo-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    combo.appendChild(display);
    combo.appendChild(list);

    const textEl = display.querySelector('.blast-select-text');
    const close = () => { list.hidden = true; combo.classList.remove('open'); };
    const open = () => {
      document.querySelectorAll('.blast-select-combo.open').forEach((c) => {
        if (c !== combo) {
          c.classList.remove('open');
          const ul = c.querySelector('.blast-combo-list');
          if (ul) ul.hidden = true;
        }
      });
      list.hidden = false;
      combo.classList.add('open');
    };

    function render() {
      const optsList = Array.from(sel.options);
      textEl.textContent = sel.selectedOptions[0]
        ? sel.selectedOptions[0].textContent : '';
      list.innerHTML = optsList
        .map((o) => `<li role="option" data-val="${esc(o.value)}"` +
          `${o.value === sel.value ? ' class="active"' : ''}>${esc(o.textContent)}</li>`)
        .join('');
      if (sel.hasAttribute('data-fit-width')) fitWidth(sel);
      if (window.PervTip) window.PervTip.syncFromSelect(sel, display);
    }

    display.addEventListener('click', () => {
      if (list.hidden) open(); else close();
    });
    display.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); display.click(); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-val]');
      if (!li) return;
      e.preventDefault();
      if (sel.value !== li.dataset.val) {
        sel.value = li.dataset.val;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      render();
      close();
    });
    document.addEventListener('click', (e) => {
      if (!combo.contains(e.target)) close();
    });

    sel._refresh = render;
    render();
    if (window.PervTip) window.PervTip.syncFromSelect(sel, display);
    return sel;
  }

  function refresh(sel) {
    if (sel && sel._refresh) sel._refresh();
    else if (sel && sel.hasAttribute('data-fit-width')) fitWidth(sel);
  }

  function enhanceAll(root, selector) {
    const scope = root || document;
    const q = selector || 'select:not(.no-enhance):not(.blast-native-hidden)';
    scope.querySelectorAll(q).forEach((sel) => enhance(sel));
  }

  window.PervSelect = { enhance, refresh, enhanceAll, fitWidth };

  document.addEventListener('DOMContentLoaded', () => {
    enhanceAll(document);
  });
})();
