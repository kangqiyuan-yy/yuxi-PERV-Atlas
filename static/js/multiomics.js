// Multi-omics BigWig track loader for Genome Browser.
// Provides a slide-in drawer with a global search bar + per-category filters.
// Depends on window.__pervBrowser (set by genome.js after igv.createBrowser).
(function () {
  // ── colour palette per data type ──────────────────────────────────────────
  // Big-category fallback (used for drawer cat-dot decoration and as fallback
  // when a file has no recognised `target`).
  const CAT_COLOR = {
    'ATAC-seq': '#f97316',
    'ChIP-seq': '#8b5cf6',
    'RNA-seq':  '#0891b2',
    'WGBS':     '#dc2626',
    'Hi-C':     '#6b7280',
  };
  function catColor(id) { return CAT_COLOR[id] || '#2563eb'; }

  // Per-seqtype palette, inherited from generate_and_plot.py SEQTYPE_COLORS so
  // that IGV tracks match the colours used by pyGenomeTracks PDF output.
  // CTCF is not in the python script; WGBS is darkened from #d9d9d9 to #737373
  // for better contrast on white background.
  const SEQTYPE_COLORS = {
    'ATAC':     '#8dd3c7',
    'CTCF':     '#fc8d62',
    'H3K27ac':  '#bf812d',
    'H3K9ac':   '#bc80bd',
    'Pol2':     '#a65628',
    'H3K4me1':  '#bebada',
    'H3K4me3':  '#fb8072',
    'H3K36me3': '#80b1d3',
    'H3K27me3': '#fdb462',
    'H3K9me3':  '#b3de69',
    'RNA':      '#fccde5',
    'WGBS':     '#737373',
  };

  function trackColor(file, catId) {
    const tgt = (file && file.target || '').trim();
    if (tgt && SEQTYPE_COLORS[tgt]) return SEQTYPE_COLORS[tgt];
    return catColor(catId);
  }

  // ── active track registry ─────────────────────────────────────────────────
  const activeTracks  = {};
  const autoscaleState = {};

  // ── bounded-concurrency load queue ────────────────────────────────────────
  // igv.js loads each bigwig via several dependent HTTP Range requests; firing
  // 10 tracks at once just thrashes the browser connection pool and the (few)
  // gunicorn workers/threads. We cap simultaneous loads so tracks resolve and
  // appear progressively instead of all-at-once at the very end.
  const MAX_CONCURRENT = 3;
  const loadQueue   = [];          // pending tasks: { url, run, onSettled }
  const queuedUrls  = new Set();   // urls waiting (enqueued but not yet started)
  let   activeLoads = 0;

  // Aggregate progress across the current loading burst (any entry point).
  const loadStats = { total: 0, done: 0 };

  function updateLoadProgress() {
    const el = document.getElementById('g-tracks-progress');
    if (!el) return;
    const label = document.getElementById('g-tracks-progress-label');
    const remaining = activeLoads + loadQueue.length;
    if (remaining <= 0 || loadStats.total <= 0) {
      el.hidden = true;
      loadStats.total = 0;
      loadStats.done = 0;
      return;
    }
    el.hidden = false;
    if (label) {
      const tpl = t('gn.tracks.progress', 'Loading tracks ({done}/{total})…');
      label.textContent = tpl
        .replace('{done}', loadStats.done)
        .replace('{total}', loadStats.total);
    }
  }

  function pumpQueue() {
    while (activeLoads < MAX_CONCURRENT && loadQueue.length) {
      const task = loadQueue.shift();
      queuedUrls.delete(task.url);
      activeLoads++;
      Promise.resolve()
        .then(() => task.run())
        .catch((err) => { console.warn('[multiomics] queued load error:', err); return false; })
        .then((ok) => { if (task.onSettled) { try { task.onSettled(ok); } catch (_) {} } })
        .finally(() => {
          activeLoads--;
          loadStats.done++;
          pumpQueue();
          updateLoadProgress();
        });
    }
  }

  function enqueueLoad(task) {
    loadQueue.push(task);
    queuedUrls.add(task.url);
    loadStats.total++;
    updateLoadProgress();
    pumpQueue();
  }

  // Remove a not-yet-started task for `url`. Returns true if it was pending.
  function dequeueLoad(url) {
    const idx = loadQueue.findIndex((t) => t.url === url);
    if (idx >= 0) {
      loadQueue.splice(idx, 1);
      queuedUrls.delete(url);
      // The dropped task will never settle, so retire its slot in the total.
      loadStats.total = Math.max(loadStats.done, loadStats.total - 1);
      updateLoadProgress();
      return true;
    }
    return false;
  }

  function clearQueue() {
    loadQueue.length = 0;
    queuedUrls.clear();
    loadStats.total = 0;
    loadStats.done = 0;
    updateLoadProgress();
  }

  function isPendingOrActive(url) {
    return !!activeTracks[url] || queuedUrls.has(url);
  }

  // Toggle the per-file "loading" decoration on every drawer row sharing `url`
  // (a file can appear both in a recommended group and in its category list).
  function setItemsLoading(url, on) {
    const body = document.getElementById('g-tracks-body');
    if (!body) return;
    body.querySelectorAll(`input[type="checkbox"][data-url="${CSS.escape(url)}"]`).forEach((cb) => {
      const item = cb.closest('.tracks-file-item');
      if (item) item.classList.toggle('loading', on);
    });
  }

  // ── per-category filter state ─────────────────────────────────────────────
  const filterState = {};   // { [catId]: { period, tissue, target, sample } }

  // ── global search / filter state ─────────────────────────────────────────
  const globalFilter = { q: '', period: '', tissue: '', target: '', replicates: '', std_method: '', sample: '' };

  // ── cached data ───────────────────────────────────────────────────────────
  let allCategories = [];
  let recommendedGroups = [];

  // ── translate a filter option value (tissue / period) ─────────────────────
  function tVal(key, type, raw) {
    // type: 'tissue' | 'period'
    const v = t(`${type}.${raw}`, raw);
    return v;
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  function fmtSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
    return (bytes / 1e3).toFixed(0) + ' KB';
  }
  function t(key, fallback) {
    try {
      if (window.I18n && typeof window.I18n.t === 'function') {
        const v = window.I18n.t(key);
        return v === key ? fallback : v;
      }
    } catch (_) {}
    return fallback;
  }
  function autoscaleLabel(isOn) {
    return isOn ? t('gn.tracks.autoscale.auto', 'Auto') : t('gn.tracks.autoscale.fixed', 'Fixed');
  }
  function autoscaleTitle(isOn) {
    return isOn
      ? t('gn.tracks.autoscale.auto.tip', 'Y-axis: auto — click to fix')
      : t('gn.tracks.autoscale.fixed.tip', 'Y-axis: fixed — click to enable autoscale');
  }

  // ── drawer open / close ───────────────────────────────────────────────────
  let drawerOpen  = false;
  let indexLoaded = false;
  const drawer    = document.getElementById('g-tracks-drawer');
  const mask      = document.getElementById('g-tracks-mask');
  const toggleBtn  = document.getElementById('g-tracks-toggle');
  const closeBtn   = document.getElementById('g-tracks-close');
  const clearMoBtn = document.getElementById('g-clear-mo-tracks');
  const clearMoBadge = document.getElementById('g-clear-mo-badge');

  function openDrawer() {
    if (!drawer) return;
    drawerOpen = true;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    if (mask) { mask.classList.add('open'); mask.setAttribute('aria-hidden', 'false'); }
    if (!indexLoaded) loadIndex();
  }
  function closeDrawer() {
    drawerOpen = false;
    if (drawer) { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); }
    if (mask)   { mask.classList.remove('open');   mask.setAttribute('aria-hidden', 'true'); }
  }

  if (toggleBtn) toggleBtn.addEventListener('click', () => drawerOpen ? closeDrawer() : openDrawer());
  if (closeBtn)  closeBtn.addEventListener('click', closeDrawer);
  if (mask)      mask.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) closeDrawer();
    // Alt+Shift+M — clear all multi-omics tracks (ignore when typing in inputs)
    if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'm' &&
        !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      clearAllMultiomicsTracks();
    }
  });

  // ── multi-omics track detection / bulk remove ─────────────────────────────
  function isMoTrack(track) {
    if (!track) return false;
    const id = String(track.id || '');
    const url = String(track.url || '');
    return id.startsWith('mo_') || url.includes('/multiomics/data/');
  }

  function countMoTracksInBrowser() {
    const br = window.__pervBrowser;
    if (!br || !br.trackViews) return Object.keys(activeTracks).length;
    return br.trackViews.filter(tv => tv && tv.track && isMoTrack(tv.track)).length;
  }

  function syncDrawerCheckboxes() {
    document.querySelectorAll('#g-tracks-body input[type="checkbox"][data-url]').forEach((cb) => {
      cb.checked = !!activeTracks[cb.dataset.url];
    });
  }

  function updateClearBtnState() {
    const n = countMoTracksInBrowser();
    if (clearMoBtn) clearMoBtn.disabled = n === 0;
    if (clearMoBadge) {
      if (n > 0) {
        clearMoBadge.hidden = false;
        clearMoBadge.textContent = String(n);
      } else {
        clearMoBadge.hidden = true;
      }
    }
  }

  function removeMoTrackFromBrowser(track) {
    const br = window.__pervBrowser;
    if (!br || !track) return false;
    try {
      if (br.removeTrack) {
        br.removeTrack(track);
        return true;
      }
      if (track.name && br.removeTrackByName) {
        br.removeTrackByName(track.name);
        return true;
      }
    } catch (err) {
      console.warn('[multiomics] remove track:', err);
    }
    return false;
  }

  function clearAllMultiomicsTracks() {
    const br = window.__pervBrowser;
    if (!br) return 0;

    // Drop any not-yet-started loads so they don't reappear after clearing.
    clearQueue();
    document.querySelectorAll('#g-tracks-body .tracks-file-item.loading')
      .forEach((item) => item.classList.remove('loading'));

    const seen = new Set();
    const toRemove = [];

    if (br.trackViews) {
      for (const tv of br.trackViews) {
        if (tv && tv.track && isMoTrack(tv.track)) {
          const key = tv.track.id || tv.track.name || tv.track.url;
          if (!seen.has(key)) {
            seen.add(key);
            toRemove.push(tv.track);
          }
        }
      }
    }

    for (const track of toRemove) {
      removeMoTrackFromBrowser(track);
    }

    Object.keys(activeTracks).forEach((k) => delete activeTracks[k]);
    syncDrawerCheckboxes();
    updateClearBtnState();
    return toRemove.length;
  }

  function flashClearBtn(msgKey, fallback) {
    if (!clearMoBtn) return;
    const label = clearMoBtn.querySelector('[data-i18n="gn.tool.clear_mo_tracks"]');
    const orig = label ? label.textContent : clearMoBtn.textContent;
    const msg = t(msgKey, fallback);
    if (label) label.textContent = msg;
    else clearMoBtn.textContent = msg;
    setTimeout(() => {
      if (label) label.textContent = t('gn.tool.clear_mo_tracks', 'Clear MO Tracks');
      updateClearBtnState();
    }, 2000);
  }

  if (clearMoBtn) {
    clearMoBtn.addEventListener('click', () => {
      const n = clearAllMultiomicsTracks();
      flashClearBtn(
        n > 0 ? 'gn.tool.clear_mo_tracks.done' : 'gn.tool.clear_mo_tracks.none',
        n > 0 ? 'Cleared' : 'No MO tracks'
      );
    });
  }

  // ── load index ────────────────────────────────────────────────────────────
  async function loadIndex() {
    const body = document.getElementById('g-tracks-body');
    if (!body) return;
    body.innerHTML = `<div class="tracks-loading">${t('gn.tracks.loading', 'Loading…')}</div>`;
    try {
      const [indexRes, recRes] = await Promise.all([
        fetch('/api/multiomics/index'),
        fetch('/api/multiomics/recommended'),
      ]);
      if (!indexRes.ok) throw new Error(`HTTP ${indexRes.status}`);
      const data = await indexRes.json();
      indexLoaded = true;
      allCategories = data.categories || [];
      if (recRes.ok) {
        const recData = await recRes.json();
        recommendedGroups = recData.groups || [];
      } else {
        recommendedGroups = [];
      }
      renderAll(body);
      // Apply any pending preselect from the home-page atlas hand-off.
      consumePreselect();
    } catch (err) {
      body.innerHTML = `<div class="tracks-empty" style="color:var(--orange);">Failed to load index: ${err.message}</div>`;
    }
  }

  // ── consume external preselect command (from home_omics.js) ───────────────
  // Triggered by visiting /genome#mo-load with a payload stashed in
  // localStorage['perv:multiomics:preselect'] = {filenames, tissue, assay, ...}.
  // We map filenames (with `.bw` extension) back to track names by stripping
  // the suffix, then click the matching drawer checkbox so the existing
  // toggleTrack() flow handles loading.
  const PRESELECT_KEY = 'perv:multiomics:preselect';
  async function consumePreselect() {
    let trigger = false;
    try {
      trigger = (window.location.hash || '').toLowerCase() === '#mo-load';
    } catch (_) {}
    if (!trigger) return;
    let payload = null;
    try {
      const raw = localStorage.getItem(PRESELECT_KEY);
      if (raw) payload = JSON.parse(raw);
    } catch (_) {}
    if (!payload || !Array.isArray(payload.filenames)) return;

    // Consume once: remove key and clear hash so refreshing doesn't re-fire.
    try { localStorage.removeItem(PRESELECT_KEY); } catch (_) {}
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_) {}

    // Wait for igv browser to be ready (toggleTrack() requires __pervBrowser).
    const deadline = Date.now() + 15000;
    while (!window.__pervBrowser && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!window.__pervBrowser) {
      console.warn('[multiomics] preselect: genome browser never became ready');
      return;
    }

    const wanted = new Set(
      payload.filenames.map((f) => String(f).replace(/\.bw$/i, ''))
    );

    const body = document.getElementById('g-tracks-body');
    if (!body) return;
    const boxes = body.querySelectorAll('input[type="checkbox"][data-name]');
    let hit = 0;
    for (const cb of boxes) {
      if (wanted.has(cb.dataset.name) && !cb.checked) {
        // .click() triggers the existing change handler → toggleTrack(), which
        // now enqueues into the bounded-concurrency loader — no manual stagger
        // needed, the queue caps simultaneous loads.
        cb.click();
        hit++;
      }
    }
    if (hit === 0) {
      console.warn('[multiomics] preselect: no checkboxes matched', payload);
    }
  }

  // ── top-level render: global search bar + category list ───────────────────
  function renderAll(container) {
    container.innerHTML = '';

    if (recommendedGroups.length) {
      const recTop = document.createElement('div');
      recTop.className = 'mo-recommended-top';
      recTop.id = 'mo-recommended-top';
      recTop.appendChild(renderRecommendedRoot());
      container.appendChild(recTop);
    }

    // Collect unique filter values across ALL categories
    const allPeriods    = [...new Set(allCategories.flatMap(c => c.filter_options?.periods     || []))].sort();
    const allTissues    = [...new Set(allCategories.flatMap(c => c.filter_options?.tissues     || []))].sort();
    const allTargets    = [...new Set(allCategories.flatMap(c => c.filter_options?.targets     || []))].sort();
    const allReplicates = [...new Set(allCategories.flatMap(c => c.filter_options?.replicates  || []))].sort();
    const allStdMethods = [...new Set(allCategories.flatMap(c => c.filter_options?.std_methods || []))].sort();
    const allSamples    = [...new Set(allCategories.flatMap(c => c.filter_options?.samples     || []))].sort();

    // ── Global search bar ──────────────────────────────────────────────────
    const globalBar = document.createElement('div');
    globalBar.className = 'mo-global-bar';
    globalBar.innerHTML = `
      <div class="mo-global-search-wrap">
        <span class="mo-global-search-icon">&#128269;</span>
        <input class="mo-global-search" id="mo-global-q" type="search"
               placeholder="${t('gn.tracks.global.ph', 'Search filename / sample / tissue / period…')}"
               autocomplete="off" value="${globalFilter.q}" />
        <button class="mo-global-clear" id="mo-global-clear" title="清除搜索" style="${globalFilter.q ? '' : 'display:none'}">&#x2715;</button>
      </div>
      <div class="mo-filter-row" id="mo-global-filter-row"></div>
      <div class="mo-global-count" id="mo-global-count"></div>`;
    container.appendChild(globalBar);

    // Populate global filter dropdowns
    const filterRow = globalBar.querySelector('#mo-global-filter-row');
    [
      [t('gn.tracks.filter.period',     'Period'),                   'period',     allPeriods],
      [t('gn.tracks.filter.tissue',     'Tissue'),                   'tissue',     allTissues],
      [t('gn.tracks.filter.target',     'Sequence.target'),          'target',     allTargets],
      [t('gn.tracks.filter.replicates', 'Replicates'),               'replicates', allReplicates],
      [t('gn.tracks.filter.std_method', 'Standardization.methods'),  'std_method', allStdMethods],
      [t('gn.tracks.filter.sample',     'Sample'),                   'sample',     allSamples],
    ].forEach(([label, key, values]) => {
      if (!values.length) return;
      const wrap = document.createElement('label');
      wrap.className = 'mo-filter-label';
      wrap.textContent = label + ' ';
      const sel = document.createElement('select');
      sel.className = 'mo-filter-select';
      sel.dataset.key = key;
      const allOpt = document.createElement('option');
      allOpt.value = '';
      allOpt.textContent = t('gn.tracks.filter.all', 'All');
      sel.appendChild(allOpt);
      values.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = (key === 'tissue' || key === 'period') ? tVal(key, key, v) : v;
        if (globalFilter[key] === v) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => {
        globalFilter[key] = sel.value;
        refreshGlobal();
      });
      wrap.appendChild(sel);
      filterRow.appendChild(wrap);
    });

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.className = 'mo-filter-reset';
    resetBtn.textContent = t('gn.tracks.filter.reset', 'Reset');
    resetBtn.addEventListener('click', () => {
      globalFilter.q = '';
      globalFilter.period = '';
      globalFilter.tissue = '';
      globalFilter.target = '';
      globalFilter.replicates = '';
      globalFilter.std_method = '';
      globalFilter.sample = '';
      filterRow.querySelectorAll('select').forEach(s => { s.value = ''; });
      const qi = globalBar.querySelector('#mo-global-q');
      if (qi) qi.value = '';
      const clr = globalBar.querySelector('#mo-global-clear');
      if (clr) clr.style.display = 'none';
      refreshGlobal();
    });
    filterRow.appendChild(resetBtn);

    // Wire up search input
    const qInput = globalBar.querySelector('#mo-global-q');
    const clearBtn = globalBar.querySelector('#mo-global-clear');
    if (qInput) {
      qInput.addEventListener('input', () => {
        globalFilter.q = qInput.value.trim().toLowerCase();
        if (clearBtn) clearBtn.style.display = globalFilter.q ? '' : 'none';
        refreshGlobal();
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        globalFilter.q = '';
        if (qInput) qInput.value = '';
        clearBtn.style.display = 'none';
        refreshGlobal();
      });
    }

    // ── Category accordions container (scrollable section) ────────────────
    const catsSection = document.createElement('div');
    catsSection.className = 'mo-cats-section';
    const catsWrap = document.createElement('div');
    catsWrap.id = 'mo-cats-wrap';
    catsWrap.className = 'mo-cats-scroll';
    catsSection.appendChild(catsWrap);
    container.appendChild(catsSection);

    // Initialize per-category filter state
    allCategories.forEach(cat => {
      if (!filterState[cat.id]) {
        filterState[cat.id] = { period: '', tissue: '', target: '', replicates: '', std_method: '', sample: '' };
      }
    });

    renderCategories(catsWrap);
    updateGlobalCount(globalBar.querySelector('#mo-global-count'));
  }

  // ── Recommended track groups (represent.sample.info) ────────────────────
  const REC_COLLAPSED_KEY = 'perv:multiomics:recommended-collapsed';

  function isRecommendedCollapsed() {
    try { return localStorage.getItem(REC_COLLAPSED_KEY) === '1'; } catch (_) { return false; }
  }

  function setRecommendedCollapsed(collapsed) {
    try {
      if (collapsed) localStorage.setItem(REC_COLLAPSED_KEY, '1');
      else localStorage.removeItem(REC_COLLAPSED_KEY);
    } catch (_) {}
  }

  function recommendedGroupColor() {
    return '#eab308';
  }

  function renderRecommendedRoot() {
    const groupCount = recommendedGroups.length;
    const details = document.createElement('details');
    // Use only tracks-cat — no extra class that could pick up stale CSS
    details.className = 'tracks-cat';
    // Inline-reset any possible inherited / cached override
    details.style.cssText = 'border:1px solid var(--border);background:transparent;box-shadow:none;';
    details.open = !isRecommendedCollapsed();

    const summary = document.createElement('summary');
    // Reset summary inline too
    summary.style.cssText = 'background:var(--panel);';
    const groupsTip = t('gn.tracks.recommended.groups_count.tip', '{count} period + tissue combinations')
      .replace('{count}', groupCount);
    summary.innerHTML = `
      <span class="cat-left">
        <span class="cat-dot" style="background:#eab308;"></span>
        <span>${t('gn.tracks.recommended.title', 'Period + Tissue Examples')}</span>
      </span>
      <span style="display:flex;align-items:center;gap:6px;">
        <span class="cat-badge" title="${groupsTip}">${groupCount}</span>
        <span class="cat-caret">&#x276F;</span>
      </span>`;
    details.appendChild(summary);

    details.addEventListener('toggle', () => {
      setRecommendedCollapsed(!details.open);
    });

    const inner = document.createElement('div');
    inner.className = 'mo-recommended-inner';
    inner.setAttribute('tabindex', '0');
    inner.setAttribute('role', 'list');
    inner.setAttribute('aria-label', t('gn.tracks.recommended.title', 'Period + Tissue Examples'));
    for (const group of recommendedGroups) {
      inner.appendChild(renderRecommendedGroup(group));
    }
    bindRecommendedScroll(inner);

    const panel = document.createElement('div');
    panel.className = 'mo-recommended-panel';
    panel.style.cssText = 'border-top:1px solid var(--border);background:transparent;padding:6px 8px 8px 8px;';
    panel.appendChild(inner);
    details.appendChild(panel);
    return details;
  }

  function bindRecommendedScroll(el) {
    el.addEventListener('wheel', (e) => {
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      const y = el.scrollTop;
      if ((e.deltaY < 0 && y > 0) || (e.deltaY > 0 && y < max - 1)) {
        e.stopPropagation();
      }
    }, { passive: true });
  }

  function renderRecommendedGroup(group) {
    const color = recommendedGroupColor();
    const trackCount = group.files.length;
    const details = document.createElement('details');
    details.className = 'mo-rec-group';

    const summary = document.createElement('summary');
    const tracksTip = t('gn.tracks.recommended.tracks_count.tip', '{count} tracks')
      .replace('{count}', trackCount);
    summary.innerHTML = `
      <span class="cat-left">
        <span class="cat-dot" style="background:${color};"></span>
        <span>${group.label}</span>
      </span>
      <span style="display:flex;align-items:center;gap:6px;">
        <span class="cat-badge" title="${tracksTip}">${trackCount}</span>
        <span class="cat-caret">&#x276F;</span>
      </span>`;
    details.appendChild(summary);

    details.addEventListener('toggle', () => {
      if (!details.open) return;
      const inner = details.closest('.mo-recommended-inner');
      if (!inner) return;
      inner.querySelectorAll('.mo-rec-group[open]').forEach((el) => {
        if (el !== details) el.open = false;
      });
    });

    const actionBar = document.createElement('div');
    actionBar.className = 'mo-filter-bar';
    const actionRow = document.createElement('div');
    actionRow.className = 'mo-filter-row';
    const loadAllBtn = document.createElement('button');
    loadAllBtn.type = 'button';
    loadAllBtn.className = 'mo-filter-reset';
    loadAllBtn.textContent = t('gn.tracks.recommended.load_all', 'Load all');
    loadAllBtn.title = t('gn.tracks.recommended.load_all.tip', 'Load every track in this group');
    loadAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      loadAllGroupTracks(group, loadAllBtn);
    });
    actionRow.appendChild(loadAllBtn);
    actionBar.appendChild(actionRow);
    const countEl = document.createElement('div');
    countEl.className = 'mo-filter-count';
    const filesWord = t('gn.tracks.filter.files', 'files');
    countEl.textContent = `${group.files.length} ${filesWord}`;
    actionBar.appendChild(countEl);
    details.appendChild(actionBar);

    const fileList = document.createElement('div');
    fileList.className = 'tracks-file-list';
    group.files.forEach((file) => {
      const catId = file.category || inferCategoryFromFile(file);
      fileList.appendChild(makeFileItem(file, catId, trackColor(file, catId)));
    });
    details.appendChild(fileList);
    return details;
  }

  function inferCategoryFromFile(file) {
    const url = file.url || '';
    const m = url.match(/\/multiomics\/data\/([^/]+)\//);
    return m ? m[1] : 'RNA-seq';
  }

  function loadAllGroupTracks(group, btn) {
    const br = window.__pervBrowser;
    if (!br) {
      alert(t('gn.tracks.browser_not_ready', 'Genome browser not ready yet. Please wait and try again.'));
      return;
    }
    const orig = btn.textContent;
    const restore = () => setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 1800);

    // Only enqueue files that aren't already loaded or already in the queue.
    const pending = group.files.filter((f) => !isPendingOrActive(f.url));
    const total = pending.length;
    if (total === 0) {
      btn.disabled = true;
      btn.textContent = t('gn.tracks.recommended.already_loaded', 'All loaded');
      restore();
      return;
    }

    btn.disabled = true;
    let done = 0, loaded = 0;
    const tpl = t('gn.tracks.recommended.loading_progress', 'Loading ({done}/{total})…');
    const updateBtn = () => {
      btn.textContent = tpl.replace('{done}', done).replace('{total}', total);
    };
    updateBtn();

    pending.forEach((file) => {
      const catId = file.category || inferCategoryFromFile(file);
      const color = trackColor(file, catId);
      setItemsLoading(file.url, true);
      enqueueLoad({
        url: file.url,
        run: () => loadTrackDirect(file, catId, color),
        onSettled: (ok) => {
          done++;
          if (ok) loaded++;
          setItemsLoading(file.url, false);
          syncDrawerCheckboxes();
          updateClearBtnState();
          if (done < total) {
            updateBtn();
          } else {
            btn.textContent = loaded > 0
              ? t('gn.tracks.recommended.loaded', 'Loaded ({count})').replace('{count}', loaded)
              : t('gn.tracks.recommended.already_loaded', 'All loaded');
            restore();
          }
        },
      });
    });
  }

  async function loadTrackDirect(file, catId, color) {
    const br = window.__pervBrowser;
    if (!br || activeTracks[file.url]) return false;
    const useAutoscale = !!autoscaleState[file.url];
    try {
      const track = await br.loadTrack({
        id:        'mo_' + file.url.replace(/[^a-z0-9]/gi, '_'),
        name:      `${catId}: ${file.name}`,
        type:      'wig',
        format:    'bigwig',
        url:       file.url,
        height:    60,
        autoscale: useAutoscale,
        color:     color,
      });
      activeTracks[file.url] = { name: track ? (track.name || file.name) : file.name, trackObj: track };
      return true;
    } catch (err) {
      console.warn('[multiomics] loadTrack failed:', file.url, err);
      return false;
    }
  }

  // ── Called whenever global or per-category filter changes ─────────────────
  function refreshGlobal() {
    const catsWrap = document.getElementById('mo-cats-wrap');
    if (catsWrap) renderCategories(catsWrap);
    const countEl = document.getElementById('mo-global-count');
    if (countEl) updateGlobalCount(countEl);
  }

  function updateGlobalCount(countEl) {
    if (!countEl) return;
    let total = 0, matched = 0;
    allCategories.forEach(cat => {
      total   += cat.files.length;
      matched += getMatchedFiles(cat).length;
    });
    const isFiltered = globalFilter.q || globalFilter.period || globalFilter.tissue ||
                       globalFilter.target || globalFilter.replicates || globalFilter.std_method || globalFilter.sample;
    if (isFiltered) {
      const tpl = t('gn.tracks.global.count.filtered', '{matched} / {total} files matched');
      countEl.textContent = tpl.replace('{matched}', matched).replace('{total}', total);
    } else {
      const tpl = t('gn.tracks.global.count.all', '{total} files total');
      countEl.textContent = tpl.replace('{total}', total);
    }
  }

  // ── Combine global filter + per-category filter for a category ────────────
  function getMatchedFiles(cat) {
    const q  = globalFilter.q;
    const gs = globalFilter;
    const cs = filterState[cat.id] || {};
    return cat.files.filter(f => {
      // Per-category dropdown filters
      if (cs.period     && f.period     !== cs.period)     return false;
      if (cs.tissue     && f.tissue     !== cs.tissue)     return false;
      if (cs.target     && f.target     !== cs.target)     return false;
      if (cs.replicates && f.replicates !== cs.replicates) return false;
      if (cs.std_method && f.std_method !== cs.std_method) return false;
      if (cs.sample     && f.sample     !== cs.sample)     return false;
      // Global dropdown filters
      if (gs.period     && f.period     !== gs.period)     return false;
      if (gs.tissue     && f.tissue     !== gs.tissue)     return false;
      if (gs.target     && f.target     !== gs.target)     return false;
      if (gs.replicates && f.replicates !== gs.replicates) return false;
      if (gs.std_method && f.std_method !== gs.std_method) return false;
      if (gs.sample     && f.sample     !== gs.sample)     return false;
      // Global text search
      if (q) {
        const haystack = [f.filename, f.period, f.tissue, f.target, f.replicates, f.std_method, f.sample]
          .join('\t').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  // ── Render / re-render all category accordions ────────────────────────────
  function renderCategories(wrap) {
    wrap.innerHTML = '';
    const isGlobalActive = globalFilter.q || globalFilter.period || globalFilter.tissue ||
                           globalFilter.target || globalFilter.replicates || globalFilter.std_method || globalFilter.sample;

    for (const cat of allCategories) {
      const matched = getMatchedFiles(cat);
      const color   = catColor(cat.id);

      // Hide categories with 0 matches when global search is active
      if (isGlobalActive && matched.length === 0) continue;

      const details = document.createElement('details');
      details.className = 'tracks-cat';
      // Auto-expand when global search is active and there are matches
      if (isGlobalActive) details.open = true;

      const summary = document.createElement('summary');
      const badgeText = isGlobalActive
        ? `${matched.length} / ${cat.files.length}`
        : `${cat.files.length}`;
      summary.innerHTML = `
        <span class="cat-left">
          <span class="cat-dot" style="background:${color};"></span>
          <span>${cat.label}</span>
        </span>
        <span style="display:flex;align-items:center;gap:6px;">
          <span class="cat-badge">${badgeText}</span>
          <span class="cat-caret">&#x276F;</span>
        </span>`;
      details.appendChild(summary);

      if (cat.files.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tracks-empty';
        empty.textContent = t('gn.tracks.cat.empty', 'No files');
        details.appendChild(empty);
      } else {
        // Per-category filter bar (hidden when global search is active)
        if (!isGlobalActive) {
          const filterBar = buildCatFilterBar(cat);
          details.appendChild(filterBar);
        }

        // File list
        const fileList = document.createElement('div');
        fileList.className = 'tracks-file-list';
        if (matched.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'tracks-empty';
          empty.textContent = t('gn.tracks.filter.empty', 'No files match the selected filters.');
          fileList.appendChild(empty);
        } else {
          matched.forEach(file => fileList.appendChild(makeFileItem(file, cat.id, trackColor(file, cat.id))));
        }
        details.appendChild(fileList);
      }
      wrap.appendChild(details);
    }

    if (isGlobalActive && wrap.children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tracks-empty';
      empty.style.padding = '16px 18px';
      empty.textContent = t('gn.tracks.global.noresult', 'No files found matching your search');
      wrap.appendChild(empty);
    }
  }

  // ── Build per-category filter bar ─────────────────────────────────────────
  function buildCatFilterBar(cat) {
    const opts = cat.filter_options || {};
    const filterBar = document.createElement('div');
    filterBar.className = 'mo-filter-bar';
    const filterRow = document.createElement('div');
    filterRow.className = 'mo-filter-row';
    const countEl = document.createElement('div');
    countEl.className = 'mo-filter-count';

    const makeSelect = (label, key, values) => {
      if (!values || !values.length) return null;
      const wrap = document.createElement('label');
      wrap.className = 'mo-filter-label';
      wrap.textContent = label + ' ';
      const sel = document.createElement('select');
      sel.className = 'mo-filter-select';
      const allOpt = document.createElement('option');
      allOpt.value = ''; allOpt.textContent = t('gn.tracks.filter.all', 'All');
      sel.appendChild(allOpt);
      values.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = (key === 'tissue' || key === 'period') ? tVal(key, key, v) : v;
        if (filterState[cat.id][key] === v) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => {
        filterState[cat.id][key] = sel.value;
        refreshGlobal();
      });
      wrap.appendChild(sel);
      return wrap;
    };

    [
      [t('gn.tracks.filter.period',     'Period'),                  'period',     opts.periods],
      [t('gn.tracks.filter.tissue',     'Tissue'),                  'tissue',     opts.tissues],
      [t('gn.tracks.filter.target',     'Sequence.target'),         'target',     opts.targets],
      [t('gn.tracks.filter.replicates', 'Replicates'),              'replicates', opts.replicates],
      [t('gn.tracks.filter.std_method', 'Standardization.methods'), 'std_method', opts.std_methods],
      [t('gn.tracks.filter.sample',     'Sample'),                  'sample',     opts.samples],
    ].forEach(([lbl, key, vals]) => {
      const el = makeSelect(lbl, key, vals);
      if (el) filterRow.appendChild(el);
    });

    const resetBtn = document.createElement('button');
    resetBtn.className = 'mo-filter-reset';
    resetBtn.textContent = t('gn.tracks.filter.reset', 'Reset');
    resetBtn.addEventListener('click', () => {
        filterState[cat.id] = { period: '', tissue: '', target: '', replicates: '', std_method: '', sample: '' };
      filterRow.querySelectorAll('select').forEach(s => { s.value = ''; });
      refreshGlobal();
    });
    filterRow.appendChild(resetBtn);

    // Count label
    const matched = getMatchedFiles(cat).length;
    const filesWord = t('gn.tracks.filter.files', 'files');
    countEl.textContent = matched === cat.files.length
      ? `${cat.files.length} ${filesWord}`
      : `${matched} / ${cat.files.length} ${filesWord}`;

    filterBar.appendChild(filterRow);
    filterBar.appendChild(countEl);
    return filterBar;
  }

  // ── Build a single file item row ──────────────────────────────────────────
  function makeFileItem(file, catId, color) {
    const item = document.createElement('div');
    item.className = 'tracks-file-item';
    item.title = file.filename;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.url   = file.url;
    cb.dataset.name  = file.name;
    cb.dataset.cat   = catId;
    cb.dataset.color = color;
    cb.checked = !!activeTracks[file.url];
    cb.addEventListener('change', (e) => toggleTrack(file, catId, color, e.target));
    item.appendChild(cb);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tf-name';
    nameSpan.textContent = file.name;
    item.appendChild(nameSpan);

    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'tf-size';
    sizeSpan.textContent = fmtSize(file.size);
    item.appendChild(sizeSpan);

    const asBtn = document.createElement('span');
    const isOn = !!autoscaleState[file.url];
    asBtn.className = 'tf-autoscale' + (isOn ? ' on' : '');
    asBtn.textContent = autoscaleLabel(isOn);
    asBtn.title = autoscaleTitle(isOn);
    asBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const newState = !autoscaleState[file.url];
      autoscaleState[file.url] = newState;
      asBtn.className = 'tf-autoscale' + (newState ? ' on' : '');
      asBtn.textContent = autoscaleLabel(newState);
      asBtn.title = autoscaleTitle(newState);
      const entry = activeTracks[file.url];
      if (entry && entry.trackObj) {
        entry.trackObj.autoscale = newState;
        try { entry.trackObj.updateViews && entry.trackObj.updateViews(); } catch (_) {}
      }
    });
    item.appendChild(asBtn);

    return item;
  }

  // ── add / remove track ────────────────────────────────────────────────────
  function toggleTrack(file, catId, color, checkbox) {
    const br = window.__pervBrowser;
    if (!br) {
      alert(t('gn.tracks.browser_not_ready', 'Genome browser not ready yet. Please wait and try again.'));
      checkbox.checked = !checkbox.checked;
      return;
    }

    if (checkbox.checked) {
      // Already loaded or queued → nothing to do (keep the box checked).
      if (isPendingOrActive(file.url)) return;
      setItemsLoading(file.url, true);
      enqueueLoad({
        url: file.url,
        run: () => loadTrackDirect(file, catId, color),
        onSettled: (ok) => {
          setItemsLoading(file.url, false);
          if (!ok) {
            // Failed to load → reflect reality by unchecking every matching row.
            syncDrawerCheckboxes();
          }
          updateClearBtnState();
        },
      });
      return;
    }

    // Unchecking: if it's still waiting in the queue, just drop it (avoid the
    // "loads then immediately gets removed" waste).
    if (dequeueLoad(file.url)) {
      setItemsLoading(file.url, false);
      updateClearBtnState();
      return;
    }
    try {
      const entry = activeTracks[file.url];
      const trackName = entry ? entry.name : null;
      if (trackName && br.removeTrackByName) {
        br.removeTrackByName(trackName);
      } else if (br.trackViews) {
        const tv = br.trackViews.find(tv => tv && tv.track && tv.track.url === file.url);
        if (tv && br.removeTrack) br.removeTrack(tv.track);
      }
      delete activeTracks[file.url];
    } catch (err) {
      console.error('[multiomics] toggleTrack remove error:', err);
      checkbox.checked = true;
    } finally {
      updateClearBtnState();
    }
  }

  // ── expose ────────────────────────────────────────────────────────────────
  window.__pervMultiomics = {
    openDrawer,
    closeDrawer,
    loadIndex,
    clearAll: clearAllMultiomicsTracks,
    updateClearBtnState,
    countActive: countMoTracksInBrowser,
  };

  document.addEventListener('i18nchange', () => {
    if (!indexLoaded) return;
    const body = document.getElementById('g-tracks-body');
    if (body) renderAll(body);
    updateClearBtnState();
  });

  // Initial badge state once browser may already exist
  updateClearBtnState();

  // If we landed here via the home-page atlas hand-off, auto-open the drawer
  // so loadIndex() runs and the preselect can be applied to the checkboxes.
  (function autoOpenOnHashLoad() {
    try {
      if ((window.location.hash || '').toLowerCase() === '#mo-load') {
        if (drawer) openDrawer();
      }
    } catch (_) {}
  })();
})();
