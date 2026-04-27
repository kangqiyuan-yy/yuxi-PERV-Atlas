// Multi-omics Visualization Download Modal
// Provides a dialog that lets users select a genomic region, choose BigWig
// tracks and annotation overlays, pick an output format, and trigger a
// server-side render (matplotlib) delivered as PDF / SVG / PNG.
(function () {
  'use strict';

  // ── i18n helper ────────────────────────────────────────────────────────────
  function t(key, fallback) {
    try {
      if (window.I18n && typeof window.I18n.t === 'function') {
        const v = window.I18n.t(key);
        return v === key ? fallback : v;
      }
    } catch (_) {}
    return fallback;
  }

  function tVal(type, raw) {
    return t(`${type}.${raw}`, raw);
  }

  // ── Multi-select widget factory (mirrors multiomics.js) ────────────────────
  const _dlmPanels = new Set();

  function clearDlmPanels() {
    _dlmPanels.forEach(p => p.remove());
    _dlmPanels.clear();
  }

  /** Keep wheel events inside a scrollable list so parent panels do not move. */
  function bindContainedScroll(el) {
    if (!el || el.dataset.containedScroll) return;
    el.dataset.containedScroll = '1';
    el.addEventListener('wheel', (e) => {
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      const y = el.scrollTop;
      if ((e.deltaY < 0 && y > 0) || (e.deltaY > 0 && y < max - 1)) {
        e.stopPropagation();
      }
    }, { passive: true });
  }

  function makeDlmMultiSelect(label, key, values, currentSet, onChange, dispFn) {
    if (!values || !values.length) return null;

    const wrap = document.createElement('div');
    wrap.className = 'mo-filter-label';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    wrap.appendChild(labelSpan);

    const msWrap = document.createElement('div');
    msWrap.className = 'mo-ms-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mo-ms-btn';

    const valSpan = document.createElement('span');
    valSpan.className = 'mo-ms-val';
    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'mo-ms-arrow';
    arrowSpan.textContent = '▾';
    btn.appendChild(valSpan);
    btn.appendChild(arrowSpan);
    msWrap.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'mo-ms-panel';
    document.body.appendChild(panel);
    _dlmPanels.add(panel);

    function display(v) { return dispFn ? dispFn(v) : v; }

    function updateBtn() {
      if (currentSet.size === 0) {
        valSpan.textContent = t('mo.filter.all', 'All');
        btn.classList.remove('active');
      } else if (currentSet.size === 1) {
        valSpan.textContent = display([...currentSet][0]);
        btn.classList.add('active');
      } else {
        valSpan.textContent = currentSet.size + ' ' + t('mo.filter.selected', 'selected');
        btn.classList.add('active');
      }
    }

    function buildPanel() {
      panel.innerHTML = '';
      values.forEach(v => {
        const row = document.createElement('div');
        row.className = 'mo-ms-option' + (currentSet.has(v) ? ' checked' : '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = currentSet.has(v);
        const txt = document.createElement('span');
        txt.textContent = display(v);
        row.appendChild(cb);
        row.appendChild(txt);
        row.addEventListener('click', (e) => {
          if (e.target === cb) return;
          cb.checked = !cb.checked;
          toggle(v, cb.checked, row);
        });
        cb.addEventListener('change', () => toggle(v, cb.checked, row));
        panel.appendChild(row);
      });
    }

    function toggle(v, checked, row) {
      if (checked) currentSet.add(v); else currentSet.delete(v);
      if (row) row.classList.toggle('checked', checked);
      updateBtn();
      onChange();
    }

    function openPanel() {
      buildPanel();
      const rect = btn.getBoundingClientRect();
      panel.style.top  = (rect.bottom + 3) + 'px';
      panel.style.left = rect.left + 'px';
      panel.classList.add('open');
      btn.classList.add('open');
    }

    function closePanel() {
      panel.classList.remove('open');
      btn.classList.remove('open');
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel.classList.contains('open')) { closePanel(); return; }
      document.querySelectorAll('.mo-ms-panel.open').forEach(p => p.classList.remove('open'));
      document.querySelectorAll('.mo-ms-btn.open').forEach(b => b.classList.remove('open'));
      openPanel();
    });

    panel.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', closePanel, { passive: true });

    wrap.appendChild(msWrap);
    updateBtn();

    return {
      el: wrap,
      reset() { currentSet.clear(); updateBtn(); },
    };
  }

  // ── Category colours (match multiomics.js) ─────────────────────────────────
  const CAT_COLOR = {
    'ATAC-seq': '#f97316',
    'ChIP-seq': '#8b5cf6',
    'RNA-seq':  '#0891b2',
    'WGBS':     '#dc2626',
    'Hi-C':     '#6b7280',
  };
  function catColor(id) { return CAT_COLOR[id] || '#10b981'; }

  // Hard-coded drawer order — these four categories always render in this exact
  // order, regardless of backend response or active filters.
  const CAT_ORDER = ['ATAC-seq', 'ChIP-seq', 'RNA-seq', 'WGBS'];

  // ── State ───────────────────────────────────────────────────────────────────
  let dlmRegion   = null;   // {chrom, start, end, name, length}
  let dlmSrc      = 'gene'; // current region source type
  let tracksLoaded = false;
  let dlmCategories = [];   // cached category index from /api/multiomics/index

  // Global search / filter state (mirrors the genome-browser drawer).
  const dlmGlobalFilter = { q: '', period: new Set(), tissue: new Set(), target: new Set(), replicates: new Set(), std_method: new Set(), sample: new Set() };
  // Persistent selection set keyed by "Category/filename.bw" so selections
  // survive filter-driven re-renders (a hidden-but-selected track stays chosen).
  const dlmSelectedKeys = new Set();

  // PERV / homologous caches (loaded lazily when user clicks the tab)
  let pervCache     = null;
  let homoSeqCache  = null;
  let homoLocusCache = null;

  // Chromosome list cache (from /api/genome/chromosomes)
  let chromList = null;

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const overlay      = document.getElementById('dlm-overlay');
  const openBtn      = document.getElementById('g-download-viz');
  const closeBtn     = document.getElementById('dlm-close');
  const cancelBtn    = document.getElementById('dlm-cancel');
  const generateBtn  = document.getElementById('dlm-generate');
  const errEl        = document.getElementById('dlm-err');
  const previewEl    = document.getElementById('dlm-preview');
  const previewText  = document.getElementById('dlm-preview-text');
  const tracksBody   = document.getElementById('dlm-tracks-body');
  const extendOn     = document.getElementById('dlm-extend-on');
  const extendFields = document.getElementById('dlm-extend-fields');

  if (!overlay) return; // genome not ready

  // ── Open / Close ────────────────────────────────────────────────────────────
  function openModal() {
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    if (!tracksLoaded) loadTracks();
    applyEngineVisibility();
    document.addEventListener('keydown', onKeyDown);
  }
  function closeModal() {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    setErr('');
    document.removeEventListener('keydown', onKeyDown);
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') closeModal();
  }

  if (openBtn)   openBtn.addEventListener('click', openModal);
  if (closeBtn)  closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  // ── Extension toggle ────────────────────────────────────────────────────────
  if (extendOn && extendFields) {
    extendOn.addEventListener('change', () => {
      if (extendOn.checked) extendFields.removeAttribute('hidden');
      else extendFields.setAttribute('hidden', '');
    });
    // Auto-enable extension when user types a non-zero value in either field.
    ['dlm-upstream', 'dlm-downstream'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        const v = parseInt(el.value, 10);
        if (v > 0 && !extendOn.checked) {
          extendOn.checked = true;
          extendFields.removeAttribute('hidden');
        }
      });
    });
  }

  // ── Region source tabs ──────────────────────────────────────────────────────
  const srcTabs = document.querySelectorAll('.dlm-src-tab');
  srcTabs.forEach((tab) => {
    tab.addEventListener('click', () => switchSrc(tab.dataset.src));
  });

  function switchSrc(src) {
    dlmSrc = src;
    // Update tab active state
    srcTabs.forEach((t) => {
      const isActive = t.dataset.src === src;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    // Show/hide panels
    document.querySelectorAll('.dlm-src-panel').forEach((p) => {
      p.setAttribute('hidden', '');
    });
    const panel = document.getElementById('dlm-src-' + src);
    if (panel) panel.removeAttribute('hidden');

    // Lazy-load list data for specific types
    if (src === 'perv' && !pervCache) loadPervList();
    if (src === 'homo_seq' && !homoSeqCache) loadHomoSeqList();
    if (src === 'homo_locus' && !homoLocusCache) loadHomoLocusList();
    if ((src === 'custom' || src === 'position') && !chromList) loadChromList();

    // Clear region preview when switching source type
    clearPreview();
  }

  // ── Region preview ──────────────────────────────────────────────────────────
  function showPreview(region) {
    dlmRegion = region;
    if (previewEl) previewEl.removeAttribute('hidden');
    if (previewText) {
      const lenStr = region.length >= 1000
        ? (region.length / 1000).toFixed(1) + ' kb'
        : region.length + ' bp';
      previewText.textContent =
        `${region.chrom}:${region.start.toLocaleString()}–${region.end.toLocaleString()}`
        + `  (${lenStr})  ${region.name ? '· ' + region.name : ''}`;
    }
    setErr('');
  }
  function clearPreview() {
    dlmRegion = null;
    if (previewEl) previewEl.setAttribute('hidden', '');
    if (previewText) previewText.textContent = '';
  }

  // ── Error display ───────────────────────────────────────────────────────────
  function setErr(msg) {
    if (errEl) errEl.textContent = msg;
  }

  // ── Resolve region via API ──────────────────────────────────────────────────
  async function resolveRegion(params) {
    try {
      const qs = new URLSearchParams(params).toString();
      const res = await fetch('/api/download/resolve_region?' + qs);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      setErr(err.message);
      return null;
    }
  }

  // ── Gene / Transcript search autocomplete ───────────────────────────────────
  function setupSearchAutocomplete(inputId, resultsId, isTranscript) {
    const input   = document.getElementById(inputId);
    const results = document.getElementById(resultsId);
    if (!input || !results) return;

    let debTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(debTimer);
      const q = input.value.trim();
      if (q.length < 2) { results.classList.remove('open'); return; }
      debTimer = setTimeout(() => fetchSuggestions(q, results, isTranscript), 280);
    });
    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 2) results.classList.add('open');
    });
    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !results.contains(e.target)) {
        results.classList.remove('open');
      }
    });
    // Keyboard navigation
    input.addEventListener('keydown', (e) => {
      const items = results.querySelectorAll('li[data-idx]');
      if (!items.length) return;
      const sel = results.querySelector('li.selected');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = sel ? sel.nextElementSibling : items[0];
        if (next) { sel && sel.classList.remove('selected'); next.classList.add('selected'); }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = sel ? sel.previousElementSibling : items[items.length - 1];
        if (prev) { sel && sel.classList.remove('selected'); prev.classList.add('selected'); }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const active = results.querySelector('li.selected') || items[0];
        if (active) active.click();
      } else if (e.key === 'Escape') {
        results.classList.remove('open');
      }
    });
  }

  async function fetchSuggestions(q, resultsEl, isTranscript) {
    resultsEl.innerHTML = `<li style="color:var(--muted);font-size:12px;padding:8px 12px;">${t('gn.dl_viz.loading', 'Loading…')}</li>`;
    resultsEl.classList.add('open');
    try {
      const res = await fetch(`/api/genome/search?q=${encodeURIComponent(q)}&limit=20`);
      const data = await res.json();
      let items = data.items || [];
      if (isTranscript) items = items.filter((i) => i.type === 'transcript');
      renderSuggestions(items, resultsEl);
    } catch (_) {
      resultsEl.classList.remove('open');
    }
  }

  function renderSuggestions(items, resultsEl) {
    if (!items.length) {
      resultsEl.innerHTML = '<li style="color:var(--muted);font-size:12px;padding:8px 12px;">No results</li>';
      return;
    }
    resultsEl.innerHTML = '';
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.dataset.idx = i;
      const pill = item.type === 'transcript'
        ? t('gn.detail.kind.tx', 'Transcript')
        : t('gn.detail.kind.gene', 'Gene');
      const name = item.gene_name || item.gene_id || item.transcript_id;
      const meta = item.transcript_id || item.gene_id;
      const loc = `${item.chrom}:${item.start.toLocaleString()}`;
      li.innerHTML = `
        <span class="dlm-ac-pill">${pill}</span>
        <span class="dlm-ac-name">${name}</span>
        <span class="dlm-ac-meta">${meta}</span>
        <span class="dlm-ac-meta">${loc}</span>`;
      li.addEventListener('click', async () => {
        resultsEl.classList.remove('open');
        const region = await resolveRegion({
          type: item.type === 'transcript' ? 'transcript' : 'gene',
          id: item.type === 'transcript' ? item.transcript_id : (item.gene_id || item.gene_name),
        });
        if (region) showPreview(region);
      });
      resultsEl.appendChild(li);
    });
  }

  setupSearchAutocomplete('dlm-gene-search', 'dlm-gene-results', false);
  setupSearchAutocomplete('dlm-tx-search', 'dlm-tx-results', true);

  // ── PERV list ───────────────────────────────────────────────────────────────
  async function loadPervList() {
    const listEl   = document.getElementById('dlm-perv-list');
    const filterEl = document.getElementById('dlm-perv-filter');
    if (!listEl) return;
    listEl.innerHTML = `<li class="dlm-list-loading">${t('gn.dl_viz.loading', 'Loading…')}</li>`;
    try {
      const res = await fetch('/api/genome/perv/list');
      const data = await res.json();
      pervCache = data.sequences || [];
      renderFilterList(pervCache, listEl, filterEl, (item) => ({
        label: item.name,
        meta: `${item.chrom}:${(item.start || 0).toLocaleString()}`,
        onClick: async () => {
          const region = await resolveRegion({ type: 'perv', id: item.name });
          if (region) showPreview(region);
        },
      }));
    } catch (err) {
      listEl.innerHTML = `<li class="dlm-list-empty">${err.message}</li>`;
    }
  }

  // ── Homologous sequence list ─────────────────────────────────────────────────
  async function loadHomoSeqList() {
    const listEl   = document.getElementById('dlm-homo-seq-list');
    const filterEl = document.getElementById('dlm-homo-seq-filter');
    if (!listEl) return;
    listEl.innerHTML = `<li class="dlm-list-loading">${t('gn.dl_viz.loading', 'Loading…')}</li>`;
    try {
      const res = await fetch('/api/genome/homologous/list');
      const data = await res.json();
      homoSeqCache = data.sequences || [];
      renderFilterList(homoSeqCache, listEl, filterEl, (item) => ({
        label: item.q_name,
        meta: `${item.chrom}:${(item.start || 0).toLocaleString()}`,
        onClick: async () => {
          const region = await resolveRegion({ type: 'homo_seq', id: item.q_name });
          if (region) showPreview(region);
        },
      }));
    } catch (err) {
      listEl.innerHTML = `<li class="dlm-list-empty">${err.message}</li>`;
    }
  }

  // ── Homologous locus list ────────────────────────────────────────────────────
  async function loadHomoLocusList() {
    const listEl   = document.getElementById('dlm-homo-locus-list');
    const filterEl = document.getElementById('dlm-homo-locus-filter');
    if (!listEl) return;
    listEl.innerHTML = `<li class="dlm-list-loading">${t('gn.dl_viz.loading', 'Loading…')}</li>`;
    try {
      const res = await fetch('/api/genome/homologous/loci');
      const data = await res.json();
      homoLocusCache = data.loci || [];
      renderFilterList(homoLocusCache, listEl, filterEl, (item) => ({
        label: item.locus_id,
        meta: `${item.chrom}:${(item.start || 0).toLocaleString()} (${item.count} seqs)`,
        onClick: async () => {
          const region = await resolveRegion({ type: 'homo_locus', id: item.locus_id });
          if (region) showPreview(region);
        },
      }));
    } catch (err) {
      listEl.innerHTML = `<li class="dlm-list-empty">${err.message}</li>`;
    }
  }

  // Generic filterable list renderer
  function renderFilterList(allItems, listEl, filterEl, itemDescFn) {
    function render(q) {
      const items = q
        ? allItems.filter((i) => JSON.stringify(i).toLowerCase().includes(q.toLowerCase()))
        : allItems;
      listEl.innerHTML = '';
      if (!items.length) {
        const li = document.createElement('li');
        li.className = 'dlm-list-empty';
        li.textContent = 'No matches';
        listEl.appendChild(li);
        return;
      }
      const frag = document.createDocumentFragment();
      items.slice(0, 200).forEach((item) => {
        const desc = itemDescFn(item);
        const li = document.createElement('li');
        const nameSpan = document.createElement('span');
        nameSpan.textContent = desc.label;
        li.appendChild(nameSpan);
        if (desc.meta) {
          const metaSpan = document.createElement('span');
          metaSpan.className = 'dlm-item-meta';
          metaSpan.textContent = desc.meta;
          li.appendChild(metaSpan);
        }
        li.addEventListener('click', () => {
          listEl.querySelectorAll('li').forEach((el) => el.classList.remove('selected'));
          li.classList.add('selected');
          desc.onClick();
        });
        frag.appendChild(li);
      });
      listEl.appendChild(frag);
    }

    render('');
    if (filterEl) {
      let timer = null;
      filterEl.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => render(filterEl.value.trim()), 200);
      });
    }
  }

  // ── Chromosome list (for custom / position panels) ───────────────────────────
  async function loadChromList() {
    try {
      const res = await fetch('/api/genome/chromosomes');
      const data = await res.json();
      chromList = (data.items || []).map((i) => i.name);
      ['dlm-custom-chrom', 'dlm-pos-chrom'].forEach((id) => {
        const sel = document.getElementById(id);
        if (!sel) return;
        chromList.forEach((name) => {
          const opt = document.createElement('option');
          opt.value = opt.textContent = name;
          sel.appendChild(opt);
        });
        if (window.PervSelect) PervSelect.refresh(sel);
      });
    } catch (_) {}
  }

  // ── Custom region "Go" button ────────────────────────────────────────────────
  const customGoBtn = document.getElementById('dlm-custom-go');
  if (customGoBtn) {
    customGoBtn.addEventListener('click', async () => {
      const chrom = document.getElementById('dlm-custom-chrom').value;
      const start = parseInt(document.getElementById('dlm-custom-start').value, 10);
      const end   = parseInt(document.getElementById('dlm-custom-end').value, 10);
      if (!chrom) { setErr('Please select a chromosome'); return; }
      if (!start || !end || start < 1 || end < start) {
        setErr('Invalid coordinates: start must be ≥ 1 and end ≥ start');
        return;
      }
      const region = await resolveRegion({ type: 'custom', chrom, start, end });
      if (region) showPreview(region);
    });
  }

  // ── Single position "Go" button ──────────────────────────────────────────────
  const posGoBtn = document.getElementById('dlm-pos-go');
  if (posGoBtn) {
    posGoBtn.addEventListener('click', async () => {
      const chrom = document.getElementById('dlm-pos-chrom').value;
      const pos   = parseInt(document.getElementById('dlm-pos-pos').value, 10);
      if (!chrom) { setErr('Please select a chromosome'); return; }
      if (!pos || pos < 1) { setErr('Invalid position'); return; }
      const region = await resolveRegion({ type: 'position', chrom, pos });
      if (region) showPreview(region);
    });
  }

  // ── BigWig track list ────────────────────────────────────────────────────────
  async function loadTracks() {
    if (!tracksBody) return;
    tracksBody.innerHTML = `<div class="dlm-loading">${t('gn.dl_viz.loading', 'Loading…')}</div>`;
    try {
      const res = await fetch('/api/multiomics/index');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      tracksLoaded = true;
      renderTracks(data.categories || []);
    } catch (err) {
      tracksBody.innerHTML = `<div class="dlm-tracks-empty" style="color:var(--orange);">Failed to load: ${err.message}</div>`;
    }
  }

  // Per-category filter state for the download modal
  const dlmFilterState = {};

  // Fixed-order categories (unknown ones fall to the end).
  function orderedDlmCategories() {
    const rank = new Map(CAT_ORDER.map((id, i) => [id, i]));
    return [...dlmCategories].sort((a, b) => {
      const ia = rank.has(a.id) ? rank.get(a.id) : CAT_ORDER.length;
      const ib = rank.has(b.id) ? rank.get(b.id) : CAT_ORDER.length;
      return ia - ib;
    });
  }

  function isDlmGlobalActive() {
    const g = dlmGlobalFilter;
    return !!(g.q || g.period.size || g.tissue.size || g.target.size || g.replicates.size || g.std_method.size || g.sample.size);
  }

  // Combine global filter + per-category filter. When the global filter is
  // active it takes over completely — the per-category filters are suppressed.
  function getDlmMatchedFiles(cat) {
    const g = dlmGlobalFilter;
    const globalActive = isDlmGlobalActive();
    const cs = globalActive ? {} : (dlmFilterState[cat.id] || {});
    const q = g.q;
    return cat.files.filter(f => {
      if (cs.period?.size     && !cs.period.has(f.period))         return false;
      if (cs.tissue?.size     && !cs.tissue.has(f.tissue))         return false;
      if (cs.target?.size     && !cs.target.has(f.target))         return false;
      if (cs.replicates?.size && !cs.replicates.has(f.replicates)) return false;
      if (cs.std_method?.size && !cs.std_method.has(f.std_method)) return false;
      if (cs.sample?.size     && !cs.sample.has(f.sample))         return false;
      if (g.period.size     && !g.period.has(f.period))         return false;
      if (g.tissue.size     && !g.tissue.has(f.tissue))         return false;
      if (g.target.size     && !g.target.has(f.target))         return false;
      if (g.replicates.size && !g.replicates.has(f.replicates)) return false;
      if (g.std_method.size && !g.std_method.has(f.std_method)) return false;
      if (g.sample.size     && !g.sample.has(f.sample))         return false;
      if (q) {
        const haystack = [f.filename, f.period, f.tissue, f.target, f.replicates, f.std_method, f.sample]
          .join('\t').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  // Files to display for a category = matched files ∪ already-selected files.
  // Selected-but-unmatched files stay visible (pinned) so a filter never hides
  // a track the user already picked.
  function getDlmDisplayFiles(cat) {
    const matched = getDlmMatchedFiles(cat);
    const matchedNames = new Set(matched.map((f) => f.filename));
    const out = [];
    for (const f of cat.files) {
      const isMatched  = matchedNames.has(f.filename);
      const isSelected = dlmSelectedKeys.has(`${cat.id}/${f.filename}`);
      if (isMatched || isSelected) {
        out.push({ file: f, pinned: !isMatched && isSelected });
      }
    }
    return out;
  }

  function renderTracks(categories) {
    clearDlmPanels();
    dlmCategories = categories || [];
    if (!dlmCategories.length) {
      tracksBody.innerHTML = `<div class="dlm-tracks-empty">${t('gn.dl_viz.no_bw', 'No .bw files found')}</div>`;
      return;
    }
    dlmCategories.forEach((cat) => {
      if (!dlmFilterState[cat.id]) {
        dlmFilterState[cat.id] = { period: new Set(), tissue: new Set(), target: new Set(), replicates: new Set(), std_method: new Set(), sample: new Set() };
      }
    });

    tracksBody.innerHTML = '';
    tracksBody.appendChild(buildDlmGlobalBar());
    const catsWrap = document.createElement('div');
    catsWrap.id = 'dlm-cats-wrap';
    tracksBody.appendChild(catsWrap);
    renderDlmCategories(catsWrap);
  }

  // ── Global search bar + global filter dropdowns ──────────────────────────────
  function buildDlmGlobalBar() {
    const allPeriods    = [...new Set(dlmCategories.flatMap(c => c.filter_options?.periods     || []))].sort();
    const allTissues    = [...new Set(dlmCategories.flatMap(c => c.filter_options?.tissues     || []))].sort();
    const allTargets    = [...new Set(dlmCategories.flatMap(c => c.filter_options?.targets     || []))].sort();
    const allReplicates = [...new Set(dlmCategories.flatMap(c => c.filter_options?.replicates  || []))].sort();
    const allStdMethods = [...new Set(dlmCategories.flatMap(c => c.filter_options?.std_methods || []))].sort();
    const allSamples    = [...new Set(dlmCategories.flatMap(c => c.filter_options?.samples     || []))].sort();

    const bar = document.createElement('div');
    bar.className = 'mo-global-bar';
    bar.innerHTML = `
      <div class="mo-global-search-wrap">
        <span class="mo-global-search-icon">&#128269;</span>
        <input class="mo-global-search" id="dlm-global-q" type="search"
               placeholder="${t('gn.tracks.global.ph', 'Search filename / sample / tissue / period…')}"
               autocomplete="off" value="${dlmGlobalFilter.q}" />
        <button class="mo-global-clear" id="dlm-global-clear" type="button"
                data-i18n-tip="mo.filter.reset" style="${dlmGlobalFilter.q ? '' : 'display:none'}">&#x2715;</button>
      </div>
      <div class="mo-filter-row mo-filter-grid" id="dlm-global-filter-row"></div>
      <div class="mo-filter-actions">
        <div class="mo-global-count" id="dlm-global-count"></div>
      </div>`;

    const filterRow = bar.querySelector('#dlm-global-filter-row');
    const dlmGlobalHandles = [];
    [
      [t('gn.tracks.filter.period',     'Period'),                  'period',     allPeriods],
      [t('gn.tracks.filter.tissue',     'Tissue'),                  'tissue',     allTissues],
      [t('gn.tracks.filter.target',     'Sequence.target'),         'target',     allTargets],
      [t('gn.tracks.filter.replicates', 'Replicates'),              'replicates', allReplicates],
      [t('gn.tracks.filter.std_method', 'Standardization.methods'), 'std_method', allStdMethods],
      [t('gn.tracks.filter.sample',     'Sample'),                  'sample',     allSamples],
    ].forEach(([label, key, values]) => {
      if (!values.length) return;
      const dispFn = (key === 'tissue' || key === 'period') ? v => tVal(key, v) : null;
      const handle = makeDlmMultiSelect(label, key, values, dlmGlobalFilter[key], () => refreshDlmTracks(), dispFn);
      if (handle) { filterRow.appendChild(handle.el); dlmGlobalHandles.push(handle); }
    });

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'mo-filter-reset';
    resetBtn.textContent = t('mo.filter.reset', 'Reset');
    resetBtn.addEventListener('click', () => {
      ['period', 'tissue', 'target', 'replicates', 'std_method', 'sample'].forEach(k => dlmGlobalFilter[k].clear());
      dlmGlobalFilter.q = '';
      dlmGlobalHandles.forEach(h => h.reset());
      const qi = bar.querySelector('#dlm-global-q');
      if (qi) qi.value = '';
      const clr = bar.querySelector('#dlm-global-clear');
      if (clr) clr.style.display = 'none';
      refreshDlmTracks();
    });
    bar.querySelector('.mo-filter-actions').appendChild(resetBtn);

    const qInput   = bar.querySelector('#dlm-global-q');
    const clearBtn = bar.querySelector('#dlm-global-clear');
    if (qInput) {
      let timer = null;
      qInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          dlmGlobalFilter.q = qInput.value.trim().toLowerCase();
          if (clearBtn) clearBtn.style.display = dlmGlobalFilter.q ? '' : 'none';
          refreshDlmTracks();
        }, 180);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        dlmGlobalFilter.q = '';
        if (qInput) qInput.value = '';
        clearBtn.style.display = 'none';
        refreshDlmTracks();
      });
    }

    return bar;
  }

  function updateDlmGlobalCount() {
    const countEl = document.getElementById('dlm-global-count');
    if (!countEl) return;
    let total = 0, matched = 0;
    dlmCategories.forEach((cat) => {
      total += cat.files.length;
      matched += getDlmMatchedFiles(cat).length;
    });
    if (isDlmGlobalActive()) {
      const tpl = t('gn.tracks.global.count.filtered', '{matched} / {total} files matched');
      countEl.textContent = tpl.replace('{matched}', matched).replace('{total}', total);
    } else {
      const tpl = t('gn.tracks.global.count.all', '{total} files total');
      countEl.textContent = tpl.replace('{total}', total);
    }
  }

  // Re-render the category list + refresh the global count. Selection state is
  // preserved across re-renders via dlmSelectedKeys.
  function refreshDlmTracks() {
    const catsWrap = document.getElementById('dlm-cats-wrap');
    if (catsWrap) renderDlmCategories(catsWrap);
    updateDlmGlobalCount();
    if (getCurrentEngine() === 'pygt') refreshPygtTrackPanel();
  }

  function renderDlmCategories(wrap) {
    const globalActive = isDlmGlobalActive();
    wrap.innerHTML = '';
    for (const cat of orderedDlmCategories()) {
      wrap.appendChild(buildDlmCategoryDetails(cat, globalActive));
    }
    updateDlmGlobalCount();
  }

  function buildDlmFileItem(cat, file, pinned) {
    const item = document.createElement('div');
    item.className = 'dlm-file-item' + (pinned ? ' pinned' : '');
    if (pinned) item.style.setProperty('--pin-color', catColor(cat.id));
    item.dataset.tip = file.filename;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = `${cat.id}/${file.filename}`;
    cb.checked = dlmSelectedKeys.has(cb.value);
    item.appendChild(cb);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'dlm-fname';
    nameSpan.textContent = file.name;
    item.appendChild(nameSpan);
    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'dlm-fsize';
    sizeSpan.textContent = fmtSize(file.size);
    item.appendChild(sizeSpan);
    item.addEventListener('click', (e) => {
      if (e.target !== cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    return item;
  }

  function buildDlmCategoryDetails(cat, globalActive) {
    const details = document.createElement('details');
    details.className = 'dlm-tracks-cat';
    details.dataset.catId = cat.id;
    const color = catColor(cat.id);
    const matched = getDlmMatchedFiles(cat);

    const catActive = globalActive || Object.values(dlmFilterState[cat.id] || {}).some(Boolean);
    const badgeText = catActive ? `${matched.length} / ${cat.files.length}` : `${cat.files.length}`;

    const summary = document.createElement('summary');
    summary.innerHTML = `
      <span class="dlm-cat-left">
        <span class="dlm-cat-dot" style="background:${color};"></span>
        <span>${cat.label}</span>
      </span>
      <span style="display:flex;align-items:center;gap:6px;">
        <span class="dlm-cat-badge">${badgeText}</span>
        <span class="dlm-cat-caret">&#x276F;</span>
      </span>`;
    details.appendChild(summary);

    if (!cat.files.length) {
      const empty = document.createElement('div');
      empty.className = 'dlm-tracks-empty';
      empty.textContent = 'No files';
      details.appendChild(empty);
      return details;
    }

    // Per-category filter bar is suppressed while a global filter is active.
    if (!globalActive) {
      details.appendChild(buildDlmCatFilterBar(cat));
    }

    const fileList = document.createElement('div');
    fileList.className = 'dlm-file-list';
    const display = getDlmDisplayFiles(cat);
    if (!display.length) {
      const empty = document.createElement('div');
      empty.className = 'dlm-tracks-empty';
      empty.textContent = 'No files match the selected filters.';
      fileList.appendChild(empty);
    } else {
      for (const d of display) fileList.appendChild(buildDlmFileItem(cat, d.file, d.pinned));
    }
    bindContainedScroll(fileList);
    details.appendChild(fileList);
    return details;
  }

  function buildDlmCatFilterBar(cat) {
    const opts = cat.filter_options || {};
    const filterBar = document.createElement('div');
    filterBar.className = 'mo-filter-bar';
    const filterRow = document.createElement('div');
    filterRow.className = 'mo-filter-row mo-filter-grid';
    const countEl = document.createElement('div');
    countEl.className = 'mo-filter-count';

    const updateCount = () => {
      const filtered = getDlmMatchedFiles(cat);
      countEl.textContent = filtered.length === cat.files.length
        ? `${cat.files.length} files`
        : `${filtered.length} / ${cat.files.length} files`;
    };

    const catDlmHandles = [];
    [
      ['mo.filter.period',     'Period',            'period',     opts.periods],
      ['mo.filter.tissue',     'Tissue',            'tissue',     opts.tissues],
      ['mo.filter.target',     'Sequencing target', 'target',     opts.targets],
      ['mo.filter.replicates', 'Replicates',        'replicates', opts.replicates],
      ['mo.filter.std_method', 'Std. method',       'std_method', opts.std_methods],
      ['mo.filter.sample',     'Sample',            'sample',     opts.samples],
    ].forEach(([i18nKey, fallback, key, vals]) => {
      if (!vals || !vals.length) return;
      const dispFn = (key === 'tissue' || key === 'period') ? v => tVal(key, v) : null;
      const handle = makeDlmMultiSelect(t(i18nKey, fallback), key, vals, dlmFilterState[cat.id][key], () => {
        const details = filterRow.closest('details.dlm-tracks-cat');
        if (details) { details.open = true; refreshDlmCategoryPanel(details, cat); }
        updateDlmGlobalCount();
        updateCount();
      }, dispFn);
      if (handle) { filterRow.appendChild(handle.el); catDlmHandles.push(handle); }
    });

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'mo-filter-reset';
    resetBtn.textContent = t('mo.filter.reset', 'Reset');
    resetBtn.addEventListener('click', () => {
      ['period', 'tissue', 'target', 'replicates', 'std_method', 'sample'].forEach(k => dlmFilterState[cat.id][k].clear());
      catDlmHandles.forEach(h => h.reset());
      const details = resetBtn.closest('details.dlm-tracks-cat');
      if (details) { details.open = true; refreshDlmCategoryPanel(details, cat); }
      updateDlmGlobalCount();
      updateCount();
    });

    const actionsRow = document.createElement('div');
    actionsRow.className = 'mo-filter-actions';
    actionsRow.appendChild(countEl);
    actionsRow.appendChild(resetBtn);

    filterBar.appendChild(filterRow);
    filterBar.appendChild(actionsRow);
    updateCount();
    return filterBar;
  }

  // In-place refresh of one category's file list + badge after a per-cat filter
  // change, so the accordion's open/scroll state is preserved.
  function refreshDlmCategoryPanel(details, cat) {
    const matched = getDlmMatchedFiles(cat);
    const badge = details.querySelector('.dlm-cat-badge');
    if (badge) {
      const active = Object.values(dlmFilterState[cat.id] || {}).some(Boolean);
      badge.textContent = active ? `${matched.length} / ${cat.files.length}` : `${cat.files.length}`;
    }
    const countEl = details.querySelector('.mo-filter-count');
    if (countEl) {
      countEl.textContent = matched.length === cat.files.length
        ? `${cat.files.length} files`
        : `${matched.length} / ${cat.files.length} files`;
    }
    const fileList = details.querySelector('.dlm-file-list');
    if (fileList) {
      fileList.innerHTML = '';
      const display = getDlmDisplayFiles(cat);
      if (!display.length) {
        const empty = document.createElement('div');
        empty.className = 'dlm-tracks-empty';
        empty.textContent = 'No files match the selected filters.';
        fileList.appendChild(empty);
      } else {
        for (const d of display) fileList.appendChild(buildDlmFileItem(cat, d.file, d.pinned));
      }
      bindContainedScroll(fileList);
    }
  }

  function fmtSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
    return (bytes / 1e3).toFixed(0) + ' KB';
  }

  // ── Engine toggle / pyGenomeTracks panel ─────────────────────────────────────
  const pygtSection = document.getElementById('dlm-pygt-section');
  const pygtTracksEl = document.getElementById('dlm-pygt-tracks');
  const pygtResultEl = document.getElementById('dlm-pygt-result');
  const pygtStatusEl   = document.getElementById('dlm-pygt-status');
  const pygtWarningsEl = document.getElementById('dlm-pygt-warnings');
  const pygtActionsEl  = document.getElementById('dlm-pygt-actions');
  const pygtIniPre     = document.getElementById('dlm-pygt-ini-preview');
  const pygtDlImgBtn = document.getElementById('dlm-pygt-dl-image');
  const pygtDlIniBtn = document.getElementById('dlm-pygt-dl-ini');
  const pygtToggleIniBtn = document.getElementById('dlm-pygt-toggle-ini');

  // Per-track override state keyed by "Category/filename.bw".
  // Each entry: { color, height, order, title }
  const pygtTrackState = new Map();

  // Stable default colours derived from the seqtype implied by the filename.
  const PYGT_DEFAULT_COLOR_RULES = [
    [/_ATAC(_|\.)/i,     '#8dd3c7'],
    [/_H3K27ac(_|\.)/i,  '#bf812d'],
    [/_H3K9ac(_|\.)/i,   '#bc80bd'],
    [/_Pol2(_|\.)/i,     '#a65628'],
    [/_H3K4me1(_|\.)/i,  '#bebada'],
    [/_H3K4me3(_|\.)/i,  '#fb8072'],
    [/_H3K36me3(_|\.)/i, '#80b1d3'],
    [/_H3K27me3(_|\.)/i, '#fdb462'],
    [/_H3K9me3(_|\.)/i,  '#b3de69'],
    [/_CTCF(_|\.)/i,     '#80b1d3'],
    [/_RNA(_|\.)/i,      '#fccde5'],
    [/_WGBS(_|\.)/i,     '#d9d9d9'],
  ];
  function defaultColorFor(filename) {
    for (const [re, hex] of PYGT_DEFAULT_COLOR_RULES) {
      if (re.test(filename)) return hex;
    }
    return '#2563eb';
  }

  function getCurrentEngine() {
    const r = document.querySelector('input[name="dlm-engine"]:checked');
    return r ? r.value : 'pygt';
  }

  function applyEngineVisibility() {
    const engine = getCurrentEngine();
    const isPygt = engine === 'pygt';

    // pyGenomeTracks-only sections
    if (pygtSection) pygtSection.hidden = !isPygt;

    // matplotlib-only elements (Step 4 annotation, Step 3 hints)
    document.querySelectorAll('.dlm-mpl-only').forEach((el) => {
      el.hidden = isPygt;
    });
    document.querySelectorAll('.dlm-pygt-only').forEach((el) => {
      el.hidden = !isPygt;
    });

    if (isPygt) {
      refreshPygtTrackPanel();
    } else {
      if (pygtResultEl) pygtResultEl.hidden = true;
    }
  }

  document.querySelectorAll('input[name="dlm-engine"]').forEach((r) => {
    r.addEventListener('change', applyEngineVisibility);
  });

  // Listen for track checkbox toggles so the pygt customisation panel stays
  // in sync with what's selected in Step 3.
  document.addEventListener('change', (e) => {
    if (!(e.target instanceof HTMLInputElement)) return;
    if (e.target.matches('#dlm-tracks-body input[type="checkbox"]')) {
      const val = e.target.value;
      const checked = e.target.checked;
      if (checked) dlmSelectedKeys.add(val);
      else dlmSelectedKeys.delete(val);
      // On deselect, re-render the affected category so a now-unselected pinned
      // (filtered-out) row disappears immediately.
      if (!checked) {
        const details = e.target.closest('details.dlm-tracks-cat');
        const catId = details && details.dataset.catId;
        const cat = catId && dlmCategories.find((c) => c.id === catId);
        if (details && cat) refreshDlmCategoryPanel(details, cat);
        updateDlmGlobalCount();
      }
      if (getCurrentEngine() === 'pygt') refreshPygtTrackPanel();
    }
  });

  function refreshPygtTrackPanel() {
    if (!pygtTracksEl) return;
    const selected = Array.from(dlmSelectedKeys);

    // Drop stale entries
    for (const key of Array.from(pygtTrackState.keys())) {
      if (!selected.includes(key)) pygtTrackState.delete(key);
    }
    // Add new ones with sensible defaults
    let nextOrder = pygtTrackState.size;
    for (const key of selected) {
      if (pygtTrackState.has(key)) continue;
      const parts  = key.split('/');
      const fname  = parts[parts.length - 1] || key;
      const stem   = fname.replace(/\.bw$/, '');
      pygtTrackState.set(key, {
        color: defaultColorFor(fname),
        height: 2.0,
        order: nextOrder++,
        title: stem.length > 40 ? stem.slice(0, 40) : stem,
      });
    }

    pygtTracksEl.innerHTML = '';
    if (!selected.length) {
      const empty = document.createElement('div');
      empty.className = 'dlm-tracks-empty';
      empty.dataset.i18n = 'gn.dl_viz.pygt.no_tracks_selected';
      empty.textContent = t('gn.dl_viz.pygt.no_tracks_selected',
        'No tracks selected yet — pick BigWig files in Step 3.');
      pygtTracksEl.appendChild(empty);
      return;
    }

    const ordered = selected
      .map((k) => ({ key: k, ...pygtTrackState.get(k) }))
      .sort((a, b) => a.order - b.order);

    for (const item of ordered) {
      const row = document.createElement('div');
      row.className = 'dlm-pygt-track-row';
      row.draggable = true;
      row.dataset.key = item.key;

      const drag = document.createElement('span');
      drag.className = 'dlm-pygt-drag';
      drag.textContent = '\u2630';
      drag.dataset.i18nTip = 'gn.dl_viz.pygt.drag';

      const title = document.createElement('span');
      title.className = 'dlm-pygt-title';
      title.textContent = item.title;
      title.dataset.tip = item.key;

      const color = document.createElement('input');
      color.type = 'color';
      color.className = 'dlm-pygt-color';
      color.value = item.color;
      color.addEventListener('input', () => {
        const st = pygtTrackState.get(item.key); if (st) st.color = color.value;
      });

      const height = document.createElement('input');
      height.type = 'number';
      height.className = 'dlm-pygt-height';
      height.min = '0.5'; height.max = '8'; height.step = '0.1';
      height.value = String(item.height);
      height.addEventListener('input', () => {
        const v = parseFloat(height.value);
        const st = pygtTrackState.get(item.key);
        if (st && !isNaN(v)) st.height = v;
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'dlm-pygt-remove';
      remove.textContent = '\u2715';
      remove.dataset.i18nTip = 'gn.dl_viz.pygt.remove';
      remove.addEventListener('click', () => {
        // Uncheck the matching checkbox in Step 3 (if currently rendered)
        const cb = document.querySelector(
          `#dlm-tracks-body input[type="checkbox"][value="${CSS.escape(item.key)}"]`,
        );
        if (cb) { cb.checked = false; }
        dlmSelectedKeys.delete(item.key);
        pygtTrackState.delete(item.key);
        refreshPygtTrackPanel();
      });

      row.appendChild(drag);
      row.appendChild(title);
      row.appendChild(color);
      row.appendChild(height);
      row.appendChild(remove);
      pygtTracksEl.appendChild(row);
    }

    bindDragReorder(pygtTracksEl);
  }

  function bindDragReorder(container) {
    let dragKey = null;
    container.querySelectorAll('.dlm-pygt-track-row').forEach((row) => {
      row.addEventListener('dragstart', (e) => {
        dragKey = row.dataset.key;
        try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
      });
      row.addEventListener('dragend', () => {
        dragKey = null;
        container.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (dragKey && dragKey !== row.dataset.key) row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const targetKey = row.dataset.key;
        if (!dragKey || dragKey === targetKey) return;
        const entries = Array.from(pygtTrackState.entries())
          .sort((a, b) => a[1].order - b[1].order)
          .map(([k]) => k);
        const from = entries.indexOf(dragKey);
        const to   = entries.indexOf(targetKey);
        if (from < 0 || to < 0) return;
        entries.splice(to, 0, entries.splice(from, 1)[0]);
        entries.forEach((k, i) => { pygtTrackState.get(k).order = i; });
        refreshPygtTrackPanel();
      });
    });
  }

  // ── Collect selections ───────────────────────────────────────────────────────
  function getSelectedTracks() {
    return Array.from(dlmSelectedKeys);
  }

  function getSelectedAnnot() {
    return Array.from(document.querySelectorAll('input[name="dlm-annot"]:checked'))
      .map((cb) => cb.value);
  }

  function getFormat() {
    const checked = document.querySelector('input[name="dlm-fmt"]:checked');
    return checked ? checked.value : 'pdf';
  }

  // ── Generate & Download ──────────────────────────────────────────────────────
  if (generateBtn) {
    generateBtn.addEventListener('click', generate);
  }

  async function generate() {
    setErr('');

    if (!dlmRegion) {
      setErr(t('gn.dl_viz.err.no_region', 'Please select a region first'));
      return;
    }

    const bwTracks = getSelectedTracks();
    if (!bwTracks.length) {
      setErr(t('gn.dl_viz.err.no_tracks', 'Please select at least one multi-omics track'));
      return;
    }

    const upstream   = extendOn && extendOn.checked ? (parseInt(document.getElementById('dlm-upstream').value, 10) || 0) : 0;
    const downstream = extendOn && extendOn.checked ? (parseInt(document.getElementById('dlm-downstream').value, 10) || 0) : 0;

    const span = dlmRegion.end - dlmRegion.start + 1 + upstream + downstream;
    if (span > 10_000_000) {
      setErr(t('gn.dl_viz.err.too_large', 'Region too large (>10 Mb). Reduce the range or extension.'));
      return;
    }

    const engine = getCurrentEngine();
    if (engine === 'pygt') {
      await generatePygt(bwTracks, upstream, downstream);
      return;
    }

    const body = {
      chrom:        dlmRegion.chrom,
      start:        dlmRegion.start,
      end:          dlmRegion.end,
      upstream,
      downstream,
      bw_tracks:    bwTracks,
      annot_tracks: getSelectedAnnot(),
      format:       getFormat(),
    };

    generateBtn.disabled = true;
    generateBtn.textContent = t('gn.dl_viz.generating', 'Generating…');

    try {
      const res = await fetch('/api/download/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const cd = res.headers.get('Content-Disposition') || '';
      const fnMatch = cd.match(/filename="([^"]+)"/);
      const filename = fnMatch ? fnMatch[1] : `multiomics_${dlmRegion.chrom}_${dlmRegion.start}.${body.format}`;

      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      closeModal();
    } catch (err) {
      setErr(err.message);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = t('gn.dl_viz.generate', 'Generate & Download');
    }
  }

  // ── pyGenomeTracks async path ────────────────────────────────────────────────
  let pygtCurrentJob = null;

  async function generatePygt(bwTracks, upstream, downstream) {
    const tracks = bwTracks
      .map((key) => {
        const parts = key.split('/');
        const category = parts[0];
        const filename = parts.slice(1).join('/') || parts[0];
        const st = pygtTrackState.get(key) || {};
        return {
          category,
          filename,
          title:     st.title || filename.replace(/\.bw$/, ''),
          color:     st.color || defaultColorFor(filename),
          height_cm: typeof st.height === 'number' ? st.height : 2.0,
          order:     typeof st.order === 'number' ? st.order : 0,
        };
      })
      .sort((a, b) => a.order - b.order)
      .map(({ order, ...rest }) => rest);

    const body = {
      chrom:      dlmRegion.chrom,
      start:      dlmRegion.start,
      end:        dlmRegion.end,
      upstream,
      downstream,
      tracks,
      annotation: {
        perv_structure:        !!document.getElementById('dlm-pygt-perv')?.checked,
        genes:                 !!document.getElementById('dlm-pygt-genes')?.checked,
        transcripts:           !!document.getElementById('dlm-pygt-transcripts')?.checked,
        transcripts_display:   (document.querySelector('input[name="dlm-pygt-tx-display"]:checked')?.value) || 'collapsed',
        include_partial_genes: !(document.getElementById('dlm-pygt-clip-genes')?.checked),
      },
      options: {
        fontsize:             parseInt(document.getElementById('dlm-pygt-fontsize').value, 10) || 12,
        track_label_fraction: parseFloat(document.getElementById('dlm-pygt-label-frac').value) || 0.25,
        number_of_bins:       parseInt(document.getElementById('dlm-pygt-bins').value, 10) || 700,
        show_data_range:      !!document.getElementById('dlm-pygt-show-range')?.checked,
      },
      interval_title: document.getElementById('dlm-pygt-interval-title').value.trim()
                      || dlmRegion.name || '',
      format: getFormat(),
    };

    generateBtn.disabled = true;
    generateBtn.textContent = t('gn.dl_viz.pygt.submitting', 'Queuing…');
    showPygtResult();
    setPygtStatus(t('gn.dl_viz.pygt.queuing', 'Submitting job…'), 'pending');
    pygtActionsEl.hidden = true;
    pygtIniPre.hidden = true;
    pygtIniPre.textContent = '';
    if (pygtWarningsEl) { pygtWarningsEl.hidden = true; pygtWarningsEl.innerHTML = ''; }

    let jobId;
    try {
      const res = await fetch('/api/pygt/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      jobId = data.job_id;
      pygtCurrentJob = { id: jobId, fmt: body.format };
    } catch (err) {
      setErr(err.message);
      setPygtStatus(`${t('gn.dl_viz.pygt.error', 'Error')}: ${err.message}`, 'error');
      generateBtn.disabled = false;
      generateBtn.textContent = t('gn.dl_viz.generate', 'Generate & Download');
      return;
    }

    setPygtStatus(t('gn.dl_viz.pygt.running', 'Rendering with pyGenomeTracks…'), 'pending');

    try {
      const finalState = await pollPygtJob(jobId);
      if (finalState.state === 'done') {
        setPygtStatus(t('gn.dl_viz.pygt.done', 'Render complete'), 'done');
        pygtActionsEl.hidden = false;
        // Show warning if any genes/transcripts extended beyond the plot region
        if (pygtWarningsEl && finalState.warnings && finalState.warnings.length > 0) {
          const clipOn = !!document.getElementById('dlm-pygt-clip-genes')?.checked;
          const names = finalState.warnings.join('、');
          const msgKey = clipOn ? 'gn.dl_viz.pygt.partial_excluded' : 'gn.dl_viz.pygt.partial_warn';
          const msgFallback = clipOn
            ? '以下基因 / 转录本超出绘图区域，已被排除'
            : '以下基因 / 转录本超出了绘图区域';
          pygtWarningsEl.innerHTML = `⚠️ ${t(msgKey, msgFallback)}: <b>${names}</b>`;
          pygtWarningsEl.hidden = false;
          pygtWarningsEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else if (pygtWarningsEl) {
          pygtWarningsEl.hidden = true;
          pygtWarningsEl.innerHTML = '';
        }
      } else {
        setPygtStatus(`${t('gn.dl_viz.pygt.failed', 'Render failed')}: ${finalState.error || ''}`, 'error');
        setErr(finalState.error || 'Render failed');
      }
    } catch (err) {
      setPygtStatus(`${t('gn.dl_viz.pygt.error', 'Error')}: ${err.message}`, 'error');
      setErr(err.message);
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = t('gn.dl_viz.generate', 'Generate & Download');
    }
  }

  async function pollPygtJob(jobId, { intervalMs = 1500, maxMs = 180000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const res = await fetch(`/api/pygt/status/${encodeURIComponent(jobId)}`);
      if (!res.ok) throw new Error(`status HTTP ${res.status}`);
      const data = await res.json();
      if (data.state === 'done' || data.state === 'error') return data;
    }
    throw new Error('Polling timed out after 3 minutes');
  }

  function showPygtResult() { if (pygtResultEl) pygtResultEl.hidden = false; }
  function setPygtStatus(msg, kind) {
    if (!pygtStatusEl) return;
    pygtStatusEl.textContent = msg;
    pygtStatusEl.classList.toggle('is-error', kind === 'error');
    pygtStatusEl.classList.toggle('is-done',  kind === 'done');
  }

  if (pygtDlImgBtn) {
    pygtDlImgBtn.addEventListener('click', () => {
      if (!pygtCurrentJob) return;
      window.location.href =
        `/api/pygt/result/${encodeURIComponent(pygtCurrentJob.id)}?kind=image`;
    });
  }
  if (pygtDlIniBtn) {
    pygtDlIniBtn.addEventListener('click', async () => {
      if (!pygtCurrentJob) return;
      try {
        const res = await fetch(
          `/api/pygt/result/${encodeURIComponent(pygtCurrentJob.id)}?kind=ini`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const txt = await res.text();
        const blob = new Blob([txt], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `tracks_${pygtCurrentJob.id}.ini`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) { setErr(err.message); }
    });
  }
  if (pygtToggleIniBtn) {
    pygtToggleIniBtn.addEventListener('click', async () => {
      if (!pygtCurrentJob || !pygtIniPre) return;
      if (!pygtIniPre.hidden) {
        pygtIniPre.hidden = true;
        pygtToggleIniBtn.textContent = t('gn.dl_viz.pygt.show_ini', 'Show .ini');
        return;
      }
      try {
        const res = await fetch(
          `/api/pygt/result/${encodeURIComponent(pygtCurrentJob.id)}?kind=ini`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        pygtIniPre.textContent = await res.text();
        pygtIniPre.hidden = false;
        pygtToggleIniBtn.textContent = t('gn.dl_viz.pygt.hide_ini', 'Hide .ini');
      } catch (err) { setErr(err.message); }
    });
  }

  // Transcripts checkbox → show/hide display-mode sub-option
  const pygtTxCb = document.getElementById('dlm-pygt-transcripts');
  const pygtTxOpts = document.getElementById('dlm-pygt-tx-opts');
  if (pygtTxCb && pygtTxOpts) {
    pygtTxCb.addEventListener('change', () => {
      pygtTxOpts.hidden = !pygtTxCb.checked;
    });
  }

  // Preload track list in the background so it's ready before the user opens
  // the modal. Delay 1 s to avoid competing with critical page startup requests.
  setTimeout(() => { if (!tracksLoaded) loadTracks(); }, 1000);

  // Apply engine visibility on load
  applyEngineVisibility();

  // ── Re-apply i18n when language switches ─────────────────────────────────────
  document.addEventListener('i18nchange', () => {
    if (generateBtn && !generateBtn.disabled) {
      generateBtn.textContent = t('gn.dl_viz.generate', 'Generate & Download');
    }
    if (getCurrentEngine() === 'pygt') {
      refreshPygtTrackPanel();
    }
  });

  // ── Expose for external access if needed ─────────────────────────────────────
  window.__pervDownloadModal = { openModal, closeModal };
})();
