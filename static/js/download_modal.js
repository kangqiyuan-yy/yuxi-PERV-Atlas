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

  // ── Category colours (match multiomics.js) ─────────────────────────────────
  const CAT_COLOR = {
    'ATAC-seq': '#f97316',
    'ChIP-seq': '#8b5cf6',
    'RNA-seq':  '#0891b2',
    'WGBS':     '#dc2626',
    'Hi-C':     '#6b7280',
  };
  function catColor(id) { return CAT_COLOR[id] || '#10b981'; }

  // ── State ───────────────────────────────────────────────────────────────────
  let dlmRegion   = null;   // {chrom, start, end, name, length}
  let dlmSrc      = 'gene'; // current region source type
  let tracksLoaded = false;

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
      const pill = item.type === 'transcript' ? 'TX' : 'GENE';
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
      const chrom  = document.getElementById('dlm-pos-chrom').value;
      const pos    = parseInt(document.getElementById('dlm-pos-pos').value, 10);
      const window = parseInt(document.getElementById('dlm-pos-window').value, 10) || 10000;
      if (!chrom) { setErr('Please select a chromosome'); return; }
      if (!pos || pos < 1) { setErr('Invalid position'); return; }
      const region = await resolveRegion({ type: 'position', chrom, pos, window });
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

  function applyDlmFilters(cat, state) {
    return cat.files.filter(f => {
      if (state.period     && f.period     !== state.period)     return false;
      if (state.tissue     && f.tissue     !== state.tissue)     return false;
      if (state.target     && f.target     !== state.target)     return false;
      if (state.replicates && f.replicates !== state.replicates) return false;
      if (state.std_method && f.std_method !== state.std_method) return false;
      if (state.sample     && f.sample     !== state.sample)     return false;
      return true;
    });
  }

  function renderTracks(categories) {
    if (!categories.length) {
      tracksBody.innerHTML = `<div class="dlm-tracks-empty">${t('gn.dl_viz.no_bw', 'No .bw files found')}</div>`;
      return;
    }
    tracksBody.innerHTML = '';
    for (const cat of categories) {
      if (!dlmFilterState[cat.id]) {
        dlmFilterState[cat.id] = { period: '', tissue: '', target: '', replicates: '', std_method: '', sample: '' };
      }
      const details = document.createElement('details');
      details.className = 'dlm-tracks-cat';
      const color = catColor(cat.id);
      const summary = document.createElement('summary');
      summary.innerHTML = `
        <span class="dlm-cat-left">
          <span class="dlm-cat-dot" style="background:${color};"></span>
          <span>${cat.label}</span>
        </span>
        <span style="display:flex;align-items:center;gap:6px;">
          <span class="dlm-cat-badge">${cat.files.length}</span>
          <span class="dlm-cat-caret">&#x276F;</span>
        </span>`;
      details.appendChild(summary);

      if (!cat.files.length) {
        const empty = document.createElement('div');
        empty.className = 'dlm-tracks-empty';
        empty.textContent = 'No files';
        details.appendChild(empty);
      } else {
        details.open = false;
        const opts = cat.filter_options || {};

        // Filter bar
        const filterBar = document.createElement('div');
        filterBar.className = 'mo-filter-bar';
        const filterRow = document.createElement('div');
        filterRow.className = 'mo-filter-row';
        const countEl = document.createElement('div');
        countEl.className = 'mo-filter-count';

        const fileList = document.createElement('div');
        fileList.className = 'dlm-file-list';

        const refreshList = () => {
          const state = dlmFilterState[cat.id];
          const filtered = applyDlmFilters(cat, state);
          countEl.textContent = filtered.length === cat.files.length
            ? `${cat.files.length} files`
            : `${filtered.length} / ${cat.files.length} files`;
          fileList.innerHTML = '';
          if (!filtered.length) {
            const empty = document.createElement('div');
            empty.className = 'dlm-tracks-empty';
            empty.textContent = 'No files match the selected filters.';
            fileList.appendChild(empty);
            return;
          }
          for (const file of filtered) {
            const item  = document.createElement('div');
            item.className = 'dlm-file-item';
            item.title = file.filename;
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = `${cat.id}/${file.filename}`;
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
            fileList.appendChild(item);
          }
        };

        const makeSelect = (labelKey, fallback, key, values) => {
          if (!values || !values.length) return null;
          const wrap = document.createElement('label');
          wrap.className = 'mo-filter-label';
          wrap.textContent = t(labelKey, fallback) + ' ';
          const sel = document.createElement('select');
          sel.className = 'mo-filter-select';
          const allOpt = document.createElement('option');
          allOpt.value = '';
          allOpt.textContent = t('mo.filter.all', 'All');
          sel.appendChild(allOpt);
          for (const v of values) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = (key === 'tissue' || key === 'period') ? tVal(key, v) : v;
            if (dlmFilterState[cat.id][key] === v) opt.selected = true;
            sel.appendChild(opt);
          }
          sel.addEventListener('change', () => { dlmFilterState[cat.id][key] = sel.value; refreshList(); });
          wrap.appendChild(sel);
          return wrap;
        };

        [
          ['mo.filter.period',     'Period',                'period',     opts.periods],
          ['mo.filter.tissue',     'Tissue',                'tissue',     opts.tissues],
          ['mo.filter.target',     'Sequencing target',     'target',     opts.targets],
          ['mo.filter.replicates', 'Replicates',            'replicates', opts.replicates],
          ['mo.filter.std_method', 'Std. method',           'std_method', opts.std_methods],
          ['mo.filter.sample',     'Sample',                'sample',     opts.samples],
        ].forEach(([i18nKey, fallback, key, vals]) => {
          const el = makeSelect(i18nKey, fallback, key, vals);
          if (el) filterRow.appendChild(el);
        });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'mo-filter-reset';
        resetBtn.textContent = t('mo.filter.reset', 'Reset');
        resetBtn.addEventListener('click', () => {
          dlmFilterState[cat.id] = { period: '', tissue: '', target: '', replicates: '', std_method: '', sample: '' };
          filterRow.querySelectorAll('select').forEach(s => { s.value = ''; });
          refreshList();
        });
        filterRow.appendChild(resetBtn);

        filterBar.appendChild(filterRow);
        filterBar.appendChild(countEl);
        details.appendChild(filterBar);
        details.appendChild(fileList);
        refreshList();
      }
      tracksBody.appendChild(details);
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
      if (getCurrentEngine() === 'pygt') refreshPygtTrackPanel();
    }
  });

  function refreshPygtTrackPanel() {
    if (!pygtTracksEl) return;
    const selected = Array.from(
      document.querySelectorAll('#dlm-tracks-body input[type="checkbox"]:checked'),
    ).map((cb) => cb.value);

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
      drag.title = t('gn.dl_viz.pygt.drag', 'Drag to reorder');

      const title = document.createElement('span');
      title.className = 'dlm-pygt-title';
      title.textContent = item.title;
      title.title = item.key;

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
      remove.title = t('gn.dl_viz.pygt.remove', 'Deselect this track');
      remove.addEventListener('click', () => {
        // Uncheck the matching checkbox in Step 3
        const cb = document.querySelector(
          `#dlm-tracks-body input[type="checkbox"][value="${CSS.escape(item.key)}"]`,
        );
        if (cb) { cb.checked = false; }
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
    return Array.from(document.querySelectorAll('#dlm-tracks-body input[type="checkbox"]:checked'))
      .map((cb) => cb.value);
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
