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

  // Hard-coded drawer order — these four categories always render in this exact
  // order, regardless of backend response or active global filters.
  const CAT_ORDER = ['ATAC-seq', 'ChIP-seq', 'RNA-seq', 'WGBS'];
  function orderedCategories() {
    const rank = new Map(CAT_ORDER.map((id, i) => [id, i]));
    return [...allCategories].sort((a, b) => {
      const ia = rank.has(a.id) ? rank.get(a.id) : CAT_ORDER.length;
      const ib = rank.has(b.id) ? rank.get(b.id) : CAT_ORDER.length;
      return ia - ib;
    });
  }

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

  // Default IGV / pyGenomeTracks stack order — keep in sync with
  // generate_and_plot.py SEQTYPE_ORDER.
  const ASSAY_ORDER = [
    'ATAC', 'H3K27ac', 'H3K4me1', 'H3K4me3', 'H3K36me3', 'H3K9ac',
    'Pol2', 'H3K27me3', 'H3K9me3',
    'RNA', 'RNA_Rep1', 'RNA_Rep2',
    'WGBS', 'WGBS_Rep1', 'WGBS_Rep2', 'CTCF',
  ];
  const ASSAY_ORDER_BY_LEN = [...ASSAY_ORDER].sort((a, b) => b.length - a.length);
  const ASSAY_RANK = new Map(ASSAY_ORDER.map((a, i) => [a, i]));

  function targetFromTrackName(name) {
    const s = String(name || '');
    for (const assay of ASSAY_ORDER_BY_LEN) {
      if (s.includes('_' + assay + '_') || s.includes('_' + assay + '.')) {
        return assay;
      }
    }
    return '';
  }

  function sortFilenamesByAssayOrder(filenames) {
    return [...filenames].sort((a, b) => {
      const ka = targetFromTrackName(String(a).replace(/\.bw$/i, ''));
      const kb = targetFromTrackName(String(b).replace(/\.bw$/i, ''));
      const ia = ASSAY_RANK.has(ka) ? ASSAY_RANK.get(ka) : ASSAY_ORDER.length;
      const ib = ASSAY_RANK.has(kb) ? ASSAY_RANK.get(kb) : ASSAY_ORDER.length;
      if (ia !== ib) return ia - ib;
      return String(a).localeCompare(String(b));
    });
  }

  // Monotonic add-order within the same assay (ATAC Rep1 before ATAC Rep2, etc.).
  let moLoadSeqCounter = 0;

  const MO_ORDER_FIXED_KEY = 'perv:multiomics:orderFixed';
  function readMoOrderFixedPref() {
    try { return localStorage.getItem(MO_ORDER_FIXED_KEY) !== '0'; } catch (_) { return true; }
  }
  let moOrderFixed = readMoOrderFixedPref();

  function assayForFile(file) {
    if (!file) return '';
    const fromMeta = (file.target || '').trim();
    if (fromMeta) return fromMeta;
    return targetFromTrackName(file.name || file.filename || '');
  }

  function compareMoFilesByAssayThenName(a, b) {
    const ia = ASSAY_RANK.has(assayForFile(a)) ? ASSAY_RANK.get(assayForFile(a)) : ASSAY_ORDER.length;
    const ib = ASSAY_RANK.has(assayForFile(b)) ? ASSAY_RANK.get(assayForFile(b)) : ASSAY_ORDER.length;
    if (ia !== ib) return ia - ib;
    return String(a.name || a.filename || '').localeCompare(String(b.name || b.filename || ''));
  }

  /** Assign loadSeq for a batch (e.g. Load all) before parallel enqueue. */
  function reserveLoadSeqsForBatch(files) {
    const seqByUrl = new Map();
    const sorted = moOrderFixed
      ? [...files].sort(compareMoFilesByAssayThenName)
      : [...files];
    for (const f of sorted) {
      if (!f || !f.url || activeTracks[f.url]) continue;
      const loadSeq = moLoadSeqCounter++;
      seqByUrl.set(f.url, loadSeq);
      pendingMoMeta[f.url] = { assay: assayForFile(f), loadSeq };
    }
    return seqByUrl;
  }

  function compareMoSortEntries(a, b) {
    if (moOrderFixed) {
      const ia = ASSAY_RANK.has(a.assay) ? ASSAY_RANK.get(a.assay) : ASSAY_ORDER.length;
      const ib = ASSAY_RANK.has(b.assay) ? ASSAY_RANK.get(b.assay) : ASSAY_ORDER.length;
      if (ia !== ib) return ia - ib;
    }
    return a.loadSeq - b.loadSeq;
  }

  function gatherMoSortEntries() {
    const byUrl = new Map();
    for (const [url, meta] of Object.entries(activeTracks)) {
      if (!meta) continue;
      byUrl.set(url, { url, assay: meta.assay || '', loadSeq: meta.loadSeq || 0 });
    }
    for (const [url, meta] of Object.entries(pendingMoMeta)) {
      if (!byUrl.has(url)) {
        byUrl.set(url, { url, assay: meta.assay || '', loadSeq: meta.loadSeq || 0 });
      }
    }
    return [...byUrl.values()].sort(compareMoSortEntries);
  }

  function maxNonMoTrackOrder(br) {
    let maxNonMo = 0;
    if (!br || !br.trackViews) return maxNonMo;
    for (const tv of br.trackViews) {
      if (!tv || !tv.track || isMoTrack(tv.track)) continue;
      const o = tv.track.order;
      if (typeof o === 'number' && o > maxNonMo) maxNonMo = o;
    }
    return maxNonMo;
  }

  /** Target igv `order` for a track about to load (includes queued siblings). */
  function computeMoTrackIgvOrder(url) {
    const br = window.__pervBrowser;
    if (!br) return maxNonMoTrackOrder(br) + 1;
    const entries = gatherMoSortEntries();
    const idx = entries.findIndex((e) => e.url === url);
    const base = maxNonMoTrackOrder(br) + 1;
    return idx >= 0 ? base + idx : base + entries.length;
  }

  function clearPendingMoMeta(url) {
    if (url) delete pendingMoMeta[url];
  }

  /** Resolve the live igv track object for a url (loaded OR mid-load). */
  function findMoTrackObjByUrl(br, url) {
    const meta = activeTracks[url];
    if (meta && meta.trackObj) return meta.trackObj;
    if (br && br.trackViews) {
      for (const tv of br.trackViews) {
        if (tv && tv.track && tv.track.url === url) return tv.track;
      }
    }
    return null;
  }

  /** MO track urls in current igv panel order (top → bottom). */
  function moTrackUrlsInPanelOrder(br) {
    if (!br || !br.trackViews) return [];
    const urls = [];
    for (const tv of br.trackViews) {
      if (!tv || !tv.track || !isMoTrack(tv.track)) continue;
      const url = tv.track.url;
      if (url) urls.push(url);
    }
    return urls;
  }

  /** Set igv `order` on MO tracks; return true if reorderTracks is needed. */
  function applyMoTrackOrders() {
    const br = window.__pervBrowser;
    if (!br || !br.trackViews) return false;

    const entries = gatherMoSortEntries()
      .map((e) => ({ ...e, track: findMoTrackObjByUrl(br, e.url) }))
      .filter((e) => !!e.track);
    if (!entries.length) return false;

    const base = maxNonMoTrackOrder(br) + 1;
    let orderChanged = false;
    entries.forEach((entry, i) => {
      const want = base + i;
      if (entry.track.order !== want) {
        entry.track.order = want;
        orderChanged = true;
      }
    });

    const desiredUrls = entries.map((e) => e.url);
    const visualUrls = moTrackUrlsInPanelOrder(br);
    const visualMo = visualUrls.filter((u) => desiredUrls.includes(u));
    const visualWrong = visualMo.length !== desiredUrls.length ||
      desiredUrls.some((u, i) => visualMo[i] !== u);

    return orderChanged || visualWrong;
  }

  /** Re-stack MO tracks. Skips reorderTracks when stack is already correct —
   *  reorderTracks refreshes every track (incl. Transcripts) and shows spinners. */
  function syncMoTrackOrderNow() {
    const br = window.__pervBrowser;
    if (!br || typeof br.reorderTracks !== 'function') return;
    if (!applyMoTrackOrders()) return;
    br.reorderTracks();
  }

  let syncMoTrackOrderTimer = null;
  function cancelSyncMoTrackOrderDebounced() {
    if (syncMoTrackOrderTimer) {
      clearTimeout(syncMoTrackOrderTimer);
      syncMoTrackOrderTimer = null;
    }
  }

  /** Debounced reorder — merges post-load / batch callbacks into one reorderTracks. */
  function syncMoTrackOrderDebounced() {
    cancelSyncMoTrackOrderDebounced();
    syncMoTrackOrderTimer = setTimeout(() => {
      syncMoTrackOrderTimer = null;
      syncMoTrackOrderNow();
    }, 120);
  }

  /** Immediate reorder (track removed, or after a track finishes loading). */
  function syncMoTrackOrder() {
    syncMoTrackOrderNow();
  }

  /** Force igv to repaint a MO track after loadTrack() resolves. */
  function refreshMoTrackView(track) {
    if (!track) return;
    const tv = track.trackView;
    if (tv && typeof tv.updateViews === 'function') {
      tv.updateViews();
    } else if (typeof track.updateViews === 'function') {
      track.updateViews();
    }
  }

  function trackColor(file, catId) {
    const tgt = (file && file.target || '').trim();
    if (tgt && SEQTYPE_COLORS[tgt]) return SEQTYPE_COLORS[tgt];
    return catColor(catId);
  }

  // ── active track registry ─────────────────────────────────────────────────
  const activeTracks  = {};
  /** Queued/loading MO tracks not yet in activeTracks — used for slot reservation. */
  const pendingMoMeta = {};
  const autoscaleState = {};

  // ── serial load queue ─────────────────────────────────────────────────────
  // igv.js loads each bigwig via several dependent HTTP Range requests; firing
  // 10 tracks at once just thrashes the browser connection pool and the (few)
  // gunicorn workers/threads.
  //
  // MUST stay 1 (serial). Every br.loadTrack() call internally runs igv's
  // loadTrackList(), which calls reorderTracks() — and reorderTracks() detaches
  // & re-attaches EVERY track's viewport DOM. If two loads overlap, a sibling
  // track that is mid-load reads `viewportElement.clientWidth === 0` inside
  // igv's viewport.loadFeatures() (its element is momentarily detached / not yet
  // laid out). That makes the requested bp-range collapse to zero width, so the
  // bigWig R-tree query matches no data blocks: the track ends up with an empty
  // (loading=false) feature cache and never re-fetches — a checked box with a
  // blank track (only the 0–100 axis), and the network stops right after the
  // index reads (64→280→32 bytes) with no data-block requests.
  //
  // Loading serially (never two loadTrack() in flight) is exactly what the
  // known-good path does (applyWantedTrackNames awaits each track one by one),
  // so keep this at 1. Raising it re-introduces the "checked but blank" bug.
  const MAX_CONCURRENT = 1;
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
    const tpl = t('gn.tracks.progress', 'Loading tracks ({done}/{total})…');
    const progressText = tpl
      .replace('{done}', loadStats.done)
      .replace('{total}', loadStats.total);
    if (label) {
      label.textContent = progressText;
    }
  }

  function pumpQueue() {
    while (activeLoads < MAX_CONCURRENT && loadQueue.length) {
      const task = loadQueue.shift();
      activeLoads++;
      Promise.resolve()
        .then(() => task.run())
        .catch((err) => { console.warn('[multiomics] queued load error:', err); return false; })
        .then((ok) => { if (task.onSettled) { try { task.onSettled(ok); } catch (_) {} } })
        .finally(() => {
          queuedUrls.delete(task.url);
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

  function enqueueLoadAwait(task) {
    return new Promise((resolve) => {
      enqueueLoad({
        url: task.url,
        run: task.run,
        onSettled: (ok) => {
          if (task.onSettled) task.onSettled(ok);
          resolve(ok);
        },
      });
    });
  }

  // Remove a not-yet-started task for `url`. Returns true if it was pending.
  function dequeueLoad(url) {
    const idx = loadQueue.findIndex((t) => t.url === url);
    if (idx >= 0) {
      loadQueue.splice(idx, 1);
      queuedUrls.delete(url);
      clearPendingMoMeta(url);
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
    Object.keys(pendingMoMeta).forEach((k) => delete pendingMoMeta[k]);
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
  const globalFilter = { q: '', period: new Set(), tissue: new Set(), target: new Set(), replicates: new Set(), std_method: new Set(), sample: new Set() };

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
  function setAutoscaleTip(el, isOn) {
    el.dataset.i18nTip = isOn ? 'gn.tracks.autoscale.auto.tip' : 'gn.tracks.autoscale.fixed.tip';
    delete el.dataset.tip;
  }

  function isAutoscaleOn(url) {
    return autoscaleState[url] !== false;
  }

  function repaintMoTrack(track) {
    if (!track) return;
    const tv = track.trackView;
    if (tv && typeof tv.repaintViews === 'function') tv.repaintViews();
    else if (typeof track.updateViews === 'function') track.updateViews();
  }

  function applyAutoscaleMode(track, url) {
    if (!track) return;
    if (isAutoscaleOn(url)) {
      track.autoscale = true;
      track.autoscaleGroup = undefined;
      repaintMoTrack(track);
      return;
    }
    const dr = track.dataRange || {};
    let min = Number.isFinite(dr.min) ? dr.min : 0;
    let max = Number.isFinite(dr.max) ? dr.max : 100;
    if (max <= min) max = min + 1;
    if (typeof track.setDataRange === 'function') {
      track.setDataRange({ min, max });
    } else {
      track.dataRange = { min, max };
      track.autoscale = false;
      track.autoscaleGroup = undefined;
      repaintMoTrack(track);
    }
  }

  // ── Multi-select widget factory ───────────────────────────────────────────
  // Panels are appended to document.body (position:fixed) to escape overflow.
  // Call clearMoPanels() before any full re-render to avoid leaks.
  const _moPanels = new Set();

  function clearMoPanels() {
    _moPanels.forEach(p => p.remove());
    _moPanels.clear();
  }

  /**
   * Build a multi-select dropdown widget.
   * @param {string}    label      - Label text shown before the button
   * @param {string}    key        - Filter key ('period', 'tissue', …)
   * @param {string[]}  values     - Available option values
   * @param {Set}       currentSet - Shared Set that holds selected values
   * @param {Function}  onChange   - Called after any selection change
   * @param {Function}  [dispFn]   - Optional v => display string
   * @returns {{ el: HTMLElement, reset: Function }}
   */
  function makeMultiSelect(label, key, values, currentSet, onChange, dispFn) {
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
    _moPanels.add(panel);

    function display(v) { return dispFn ? dispFn(v) : v; }

    function updateBtn() {
      if (currentSet.size === 0) {
        valSpan.textContent = t('gn.tracks.filter.all', 'All');
        btn.classList.remove('active');
      } else if (currentSet.size === 1) {
        valSpan.textContent = display([...currentSet][0]);
        btn.classList.add('active');
      } else {
        valSpan.textContent = currentSet.size + ' ' + t('gn.tracks.filter.selected', 'selected');
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

  // ── drawer open / close ───────────────────────────────────────────────────
  let drawerOpen  = false;
  let indexLoaded = false;
  const drawer    = document.getElementById('g-tracks-drawer');
  const mask      = document.getElementById('g-tracks-mask');
  const toggleBtn  = document.getElementById('g-tracks-toggle');
  const closeBtn   = document.getElementById('g-tracks-close');
  const clearMoBtn = document.getElementById('g-clear-mo-tracks');
  const clearMoBadge = document.getElementById('g-clear-mo-badge');
  const moOrderFixedEl = document.getElementById('g-mo-order-fixed');

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
  if (moOrderFixedEl) {
    moOrderFixedEl.checked = moOrderFixed;
    moOrderFixedEl.addEventListener('change', () => {
      moOrderFixed = moOrderFixedEl.checked;
      try {
        localStorage.setItem(MO_ORDER_FIXED_KEY, moOrderFixed ? '1' : '0');
      } catch (_) {}
      syncMoTrackOrderNow();
    });
  }
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
    cancelSyncMoTrackOrderDebounced();
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
    Object.keys(pendingMoMeta).forEach((k) => delete pendingMoMeta[k]);
    moLoadSeqCounter = 0;
    syncDrawerCheckboxes();
    updateClearBtnState();
    return toRemove.length;
  }

  if (clearMoBtn) {
    // The label stays static ("Clear Multi-omics Tracks"); the disabled/greyed
    // state (via updateClearBtnState, called inside clearAllMultiomicsTracks)
    // is the sole feedback that the action completed.
    clearMoBtn.addEventListener('click', () => {
      clearAllMultiomicsTracks();
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
      await consumeMoTracksParam();
      await consumeMoGroupParam();
      consumePreselect();
    } catch (err) {
      body.innerHTML = `<div class="tracks-empty" style="color:var(--orange);">Failed to load index: ${err.message}</div>`;
    }
  }

  function stripQueryParam(key) {
    try {
      const params = new URLSearchParams(location.search);
      if (!params.has(key)) return;
      params.delete(key);
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (_) {}
  }

  async function waitForBrowserReady() {
    const deadline = Date.now() + 15000;
    while (!window.__pervBrowser && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return !!window.__pervBrowser;
  }

  async function applyWantedTrackNames(filenames) {
    if (!(await waitForBrowserReady())) {
      console.warn('[multiomics] browser not ready for track preload');
      return 0;
    }
    const body = document.getElementById('g-tracks-body');
    if (!body) return 0;
    const sorted = moOrderFixed ? sortFilenamesByAssayOrder(filenames) : [...filenames];
    const byName = new Map();
    body.querySelectorAll('input[type="checkbox"][data-name]').forEach((cb) => {
      const name = cb.dataset.name;
      if (!name || byName.has(name)) return;
      byName.set(name, cb);
    });

    let hit = 0;
    for (const f of sorted) {
      const key = String(f).replace(/\.bw$/i, '');
      const cb = byName.get(key);
      if (!cb) continue;
      const url = cb.dataset.url || key;
      if (activeTracks[url]) {
        hit++;
        continue;
      }
      if (cb.checked || isPendingOrActive(url)) {
        hit++;
        continue;
      }
      const catId = cb.dataset.cat || inferCategoryFromFile({ url, name: key });
      const color = cb.dataset.color || trackColor({ target: targetFromTrackName(key) }, catId);
      const file = {
        url,
        name: key,
        filename: /\.bw$/i.test(String(f)) ? String(f) : `${f}.bw`,
        target: targetFromTrackName(key),
      };
      cb.checked = true;
      setItemsLoading(url, true);
      await enqueueLoadAwait({
        url,
        run: () => loadTrackDirect(file, catId, color, undefined),
        onSettled: () => setItemsLoading(url, false),
      });
      hit++;
    }
    syncDrawerCheckboxes();
    updateClearBtnState();
    syncMoTrackOrderNow();
    return hit;
  }

  async function consumeMoTracksParam() {
    let raw = null;
    try {
      raw = new URLSearchParams(location.search).get('mo_tracks');
    } catch (_) {}
    if (!raw) return;

    const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) {
      stripQueryParam('mo_tracks');
      return;
    }

    const hit = await applyWantedTrackNames(names);
    if (hit === 0) {
      console.warn('[multiomics] mo_tracks: no checkboxes matched', names);
    }
    stripQueryParam('mo_tracks');
  }

  async function consumeMoGroupParam() {
    let groupId = null;
    try {
      groupId = new URLSearchParams(location.search).get('mo_group');
    } catch (_) {}
    if (!groupId) return;
    if (new URLSearchParams(location.search).get('mo_tracks')) return;

    let groups = recommendedGroups;
    if (!groups.length) {
      try {
        const recRes = await fetch('/api/multiomics/recommended');
        if (recRes.ok) {
          const recData = await recRes.json();
          groups = recData.groups || [];
        }
      } catch (_) {}
    }

    const group = groups.find((g) => g.id === groupId);
    if (!group || !Array.isArray(group.files) || !group.files.length) {
      console.warn('[multiomics] mo_group not found:', groupId);
      stripQueryParam('mo_group');
      return;
    }

    const limitRaw = new URLSearchParams(location.search).get('mo_limit');
    let limit = group.files.length;
    if (limitRaw) {
      const n = parseInt(limitRaw, 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
    const names = group.files.slice(0, limit).map((f) => f.filename || f.name);
    const hit = await applyWantedTrackNames(names);
    if (hit === 0) {
      console.warn('[multiomics] mo_group: no checkboxes matched', groupId);
    }
    stripQueryParam('mo_group');
    stripQueryParam('mo_limit');
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

    const hit = await applyWantedTrackNames(payload.filenames);
    if (hit === 0) {
      console.warn('[multiomics] preselect: no checkboxes matched', payload);
    }
  }

  // ── top-level render: global search bar + category list ───────────────────
  function renderAll(container) {
    clearMoPanels();
    if (window.PervTip && typeof window.PervTip.hide === 'function') window.PervTip.hide();
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
        <button class="mo-global-clear" id="mo-global-clear" data-i18n-tip="gn.tracks.search_clear.tip" style="${globalFilter.q ? '' : 'display:none'}">&#x2715;</button>
      </div>
      <div class="mo-filter-row mo-filter-grid" id="mo-global-filter-row"></div>
      <div class="mo-filter-actions">
        <div class="mo-global-count" id="mo-global-count"></div>
      </div>`;
    container.appendChild(globalBar);

    // Populate global filter dropdowns (multi-select)
    const filterRow = globalBar.querySelector('#mo-global-filter-row');
    const msHandles = [];
    [
      [t('gn.tracks.filter.period',     'Period'),                   'period',     allPeriods],
      [t('gn.tracks.filter.tissue',     'Tissue'),                   'tissue',     allTissues],
      [t('gn.tracks.filter.target',     'Sequence.target'),          'target',     allTargets],
      [t('gn.tracks.filter.replicates', 'Replicates'),               'replicates', allReplicates],
      [t('gn.tracks.filter.std_method', 'Standardization.methods'),  'std_method', allStdMethods],
      [t('gn.tracks.filter.sample',     'Sample'),                   'sample',     allSamples],
    ].forEach(([label, key, values]) => {
      if (!values.length) return;
      const dispFn = (key === 'tissue' || key === 'period') ? v => tVal(key, key, v) : null;
      const handle = makeMultiSelect(label, key, values, globalFilter[key], () => refreshGlobal(), dispFn);
      if (handle) { filterRow.appendChild(handle.el); msHandles.push(handle); }
    });

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'mo-filter-reset';
    resetBtn.textContent = t('gn.tracks.filter.reset', 'Reset');
    resetBtn.addEventListener('click', () => {
      globalFilter.q = '';
      ['period', 'tissue', 'target', 'replicates', 'std_method', 'sample'].forEach(k => globalFilter[k].clear());
      msHandles.forEach(h => h.reset());
      const qi = globalBar.querySelector('#mo-global-q');
      if (qi) qi.value = '';
      const clr = globalBar.querySelector('#mo-global-clear');
      if (clr) clr.style.display = 'none';
      refreshGlobal();
    });
    globalBar.querySelector('.mo-filter-actions').appendChild(resetBtn);

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
        filterState[cat.id] = { period: new Set(), tissue: new Set(), target: new Set(), replicates: new Set(), std_method: new Set(), sample: new Set() };
      }
    });

    renderCategories(catsWrap);
    bindContainedScroll(catsWrap);
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
        <span class="cat-badge" data-tip="${groupsTip}">${groupCount}</span>
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
    el.addEventListener('scroll', () => {
      if (window.PervTip && typeof window.PervTip.hide === 'function') window.PervTip.hide();
    }, { passive: true });
  }

  function bindRecommendedScroll(el) {
    bindContainedScroll(el);
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
        <span class="cat-badge" data-tip="${tracksTip}">${trackCount}</span>
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
    const countEl = document.createElement('div');
    countEl.className = 'mo-filter-count';
    const filesWord = t('gn.tracks.filter.files', 'files');
    countEl.textContent = `${group.files.length} ${filesWord}`;
    actionRow.appendChild(countEl);
    const loadAllBtn = document.createElement('button');
    loadAllBtn.type = 'button';
    loadAllBtn.className = 'mo-filter-reset';
    loadAllBtn.textContent = t('gn.tracks.recommended.load_all', 'Load all');
    loadAllBtn.dataset.i18nTip = 'gn.tracks.recommended.load_all.tip';
    loadAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      loadAllGroupTracks(group, loadAllBtn);
    });
    actionRow.appendChild(loadAllBtn);
    actionBar.appendChild(actionRow);
    details.appendChild(actionBar);

    const fileList = document.createElement('div');
    fileList.className = 'tracks-file-list';
    group.files.forEach((file) => {
      const catId = file.category || inferCategoryFromFile(file);
      fileList.appendChild(makeFileItem(file, catId, trackColor(file, catId)));
    });
    bindContainedScroll(fileList);
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
    const pending = group.files
      .filter((f) => !isPendingOrActive(f.url))
      .sort(compareMoFilesByAssayThenName);
    const total = pending.length;
    if (total === 0) {
      btn.disabled = true;
      btn.textContent = t('gn.tracks.recommended.already_loaded', 'All loaded');
      restore();
      return;
    }

    const loadSeqByUrl = reserveLoadSeqsForBatch(pending);

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
      const presetLoadSeq = loadSeqByUrl.get(file.url);
      setItemsLoading(file.url, true);
      enqueueLoad({
        url: file.url,
        run: () => loadTrackDirect(file, catId, color, presetLoadSeq),
        onSettled: (ok) => {
          done++;
          if (ok) loaded++;
          setItemsLoading(file.url, false);
          syncDrawerCheckboxes();
          updateClearBtnState();
          if (done < total) {
            updateBtn();
          } else {
            syncMoTrackOrderNow();
            btn.textContent = loaded > 0
              ? t('gn.tracks.recommended.loaded', 'Loaded ({count})').replace('{count}', loaded)
              : t('gn.tracks.recommended.already_loaded', 'All loaded');
            restore();
          }
        },
      });
    });
  }

  async function loadTrackDirect(file, catId, color, presetLoadSeq) {
    const br = window.__pervBrowser;
    if (!br || activeTracks[file.url]) {
      return false;
    }
    if (br.trackViews && br.trackViews.some(
      (tv) => tv && tv.track && tv.track.url === file.url
    )) {
      syncDrawerCheckboxes();
      return true;
    }
    const useAutoscale = isAutoscaleOn(file.url);
    const assay = assayForFile(file);
    const loadSeq = (typeof presetLoadSeq === 'number') ? presetLoadSeq : moLoadSeqCounter++;
    if (!pendingMoMeta[file.url]) {
      pendingMoMeta[file.url] = { assay, loadSeq };
    }
    const targetOrder = computeMoTrackIgvOrder(file.url);
    // Do NOT reorder while br.loadTrack() is in flight — igv's loadTrackList()
    // already calls reorderTracks() at the end, and an extra reorder during the
    // async load detaches viewports so loadFeatures() sees clientWidth === 0
    // and caches an empty feature set (blank track with only the 0–100 axis).
    try {
      const track = await br.loadTrack({
        id:        'mo_' + file.url.replace(/[^a-z0-9]/gi, '_'),
        name:      `${catId}: ${file.name}`,
        type:      'wig',
        format:    'bigwig',
        url:       file.url,
        height:    60,
        autoscale: true,
        min:       0,
        color:     color,
        order:     targetOrder,
      });
      activeTracks[file.url] = {
        name: track ? (track.name || file.name) : file.name,
        trackObj: track,
        assay,
        loadSeq,
      };
      applyAutoscaleMode(track, file.url);
      if (!useAutoscale) {
        setTimeout(() => applyAutoscaleMode(track, file.url), 400);
      }
      clearPendingMoMeta(file.url);
      refreshMoTrackView(track);
      syncMoTrackOrderNow();
      return true;
    } catch (err) {
      clearPendingMoMeta(file.url);
      console.warn('[multiomics] loadTrack failed:', file.url, err);
      return false;
    }
  }

  // ── Called whenever global or per-category filter changes ─────────────────
  function isGlobalFilterActive() {
    return !!(globalFilter.q || globalFilter.period.size || globalFilter.tissue.size ||
      globalFilter.target.size || globalFilter.replicates.size || globalFilter.std_method.size || globalFilter.sample.size);
  }

  function isCatFilterActive(catId) {
    const cs = filterState[catId] || {};
    return !!(cs.period?.size || cs.tissue?.size || cs.target?.size || cs.replicates?.size || cs.std_method?.size || cs.sample?.size);
  }

  function categoryBadgeText(cat, matched, isGlobalActive) {
    if (isGlobalActive || isCatFilterActive(cat.id)) {
      return `${matched.length} / ${cat.files.length}`;
    }
    return `${cat.files.length}`;
  }

  function updateCatFilterCountEl(countEl, cat, matched) {
    if (!countEl) return;
    const count = Array.isArray(matched) ? matched.length : matched;
    const filesWord = t('gn.tracks.filter.files', 'files');
    countEl.textContent = count === cat.files.length
      ? `${cat.files.length} ${filesWord}`
      : `${count} / ${cat.files.length} ${filesWord}`;
  }

  function populateCategoryFileList(fileList, cat, matched) {
    if (!fileList) return;
    if (window.PervTip && typeof window.PervTip.hide === 'function') window.PervTip.hide();
    fileList.innerHTML = '';
    // Display = matched files ∪ already-selected (loaded/queued) files. A track
    // the user already loaded stays visible (pinned) even if the active filter
    // would otherwise hide it.
    const matchedUrls = new Set(matched.map((f) => f.url));
    const display = [];
    for (const f of cat.files) {
      const isMatched  = matchedUrls.has(f.url);
      const isSelected = isPendingOrActive(f.url);
      if (isMatched || isSelected) {
        display.push({ file: f, pinned: !isMatched && isSelected });
      }
    }
    if (display.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tracks-empty';
      empty.textContent = t('gn.tracks.filter.empty', 'No files match the selected filters.');
      fileList.appendChild(empty);
      bindContainedScroll(fileList);
      return;
    }
    display.forEach(({ file, pinned }) => {
      fileList.appendChild(makeFileItem(file, cat.id, trackColor(file, cat.id), pinned));
    });
    bindContainedScroll(fileList);
  }

  function refreshGlobal() {
    const catsWrap = document.getElementById('mo-cats-wrap');
    if (catsWrap) {
      if (catsWrap.querySelector('details.tracks-cat[data-cat-id]')) {
        refreshCategoryLists(catsWrap);
      } else {
        renderCategories(catsWrap);
      }
    }
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
    // When the global filter is active it takes over completely — each drawer's
    // own per-category filters are suppressed (ignored), not just hidden.
    const globalActive = isGlobalFilterActive();
    const cs = globalActive ? {} : (filterState[cat.id] || {});
    return cat.files.filter(f => {
      // Per-category dropdown filters
      if (cs.period?.size     && !cs.period.has(f.period))         return false;
      if (cs.tissue?.size     && !cs.tissue.has(f.tissue))         return false;
      if (cs.target?.size     && !cs.target.has(f.target))         return false;
      if (cs.replicates?.size && !cs.replicates.has(f.replicates)) return false;
      if (cs.std_method?.size && !cs.std_method.has(f.std_method)) return false;
      if (cs.sample?.size     && !cs.sample.has(f.sample))         return false;
      // Global dropdown filters
      if (gs.period.size     && !gs.period.has(f.period))         return false;
      if (gs.tissue.size     && !gs.tissue.has(f.tissue))         return false;
      if (gs.target.size     && !gs.target.has(f.target))         return false;
      if (gs.replicates.size && !gs.replicates.has(f.replicates)) return false;
      if (gs.std_method.size && !gs.std_method.has(f.std_method)) return false;
      if (gs.sample.size     && !gs.sample.has(f.sample))         return false;
      // Global text search
      if (q) {
        const haystack = [f.filename, f.period, f.tissue, f.target, f.replicates, f.std_method, f.sample]
          .join('\t').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  // ── Render / re-render all category accordions (initial build only) ───────
  function renderCategories(wrap) {
    if (window.PervTip && typeof window.PervTip.hide === 'function') window.PervTip.hide();
    wrap.innerHTML = '';
    for (const cat of orderedCategories()) {
      wrap.appendChild(createCategoryDetails(cat));
    }
    syncGlobalNoResultMessage(wrap);
  }

  /** Update badges + file lists in place — preserves accordion open/scroll state. */
  function refreshCategoryLists(wrap) {
    const isGlobalActive = isGlobalFilterActive();
    const seen = new Set();

    for (const cat of orderedCategories()) {
      const matched = getMatchedFiles(cat);
      seen.add(cat.id);

      let details = wrap.querySelector(`details.tracks-cat[data-cat-id="${CSS.escape(cat.id)}"]`);
      if (!details) {
        wrap.appendChild(createCategoryDetails(cat));
        continue;
      }
      refreshCategoryPanel(details, cat, matched, isGlobalActive);
    }

    wrap.querySelectorAll('details.tracks-cat[data-cat-id]').forEach((details) => {
      const id = details.dataset.catId;
      if (id && !seen.has(id)) details.remove();
    });

    syncGlobalNoResultMessage(wrap);
  }

  function syncGlobalNoResultMessage(wrap) {
    const isGlobalActive = isGlobalFilterActive();
    const existing = wrap.querySelector('.mo-global-noresult');
    if (existing) existing.remove();
    if (isGlobalActive && !wrap.querySelector('details.tracks-cat')) {
      const empty = document.createElement('div');
      empty.className = 'tracks-empty mo-global-noresult';
      empty.style.padding = '16px 18px';
      empty.textContent = t('gn.tracks.global.noresult', 'No files found matching your search');
      wrap.appendChild(empty);
    }
  }

  function openCategoryDrawerFrom(el) {
    const details = el && el.closest && el.closest('details.tracks-cat[data-cat-id]');
    if (details) details.open = true;
  }

  function refreshCategoryPanel(details, cat, matched, isGlobalActive) {
    const badge = details.querySelector('.cat-badge');
    if (badge) badge.textContent = categoryBadgeText(cat, matched, isGlobalActive);

    const filterBar = details.querySelector('.mo-filter-bar');
    if (filterBar) {
      filterBar.hidden = isGlobalActive;
      updateCatFilterCountEl(filterBar.querySelector('.mo-filter-count'), cat, matched);
    } else if (!isGlobalActive && cat.files.length > 0) {
      const fileList = details.querySelector('.tracks-file-list');
      const bar = buildCatFilterBar(cat);
      if (fileList) details.insertBefore(bar, fileList);
      else details.appendChild(bar);
    }

    populateCategoryFileList(details.querySelector('.tracks-file-list'), cat, matched);
  }

  function createCategoryDetails(cat) {
    const matched = getMatchedFiles(cat);
    const isGlobalActive = isGlobalFilterActive();
    const color = catColor(cat.id);

    const details = document.createElement('details');
    details.className = 'tracks-cat';
    details.dataset.catId = cat.id;
    if (isCatFilterActive(cat.id)) details.open = true;

    const summary = document.createElement('summary');
    summary.innerHTML = `
      <span class="cat-left">
        <span class="cat-dot" style="background:${color};"></span>
        <span>${cat.label}</span>
      </span>
      <span style="display:flex;align-items:center;gap:6px;">
        <span class="cat-badge">${categoryBadgeText(cat, matched, isGlobalActive)}</span>
        <span class="cat-caret">&#x276F;</span>
      </span>`;
    details.appendChild(summary);

    if (cat.files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tracks-empty';
      empty.textContent = t('gn.tracks.cat.empty', 'No files');
      details.appendChild(empty);
      return details;
    }

    if (!isGlobalActive) {
      details.appendChild(buildCatFilterBar(cat));
    }

    const fileList = document.createElement('div');
    fileList.className = 'tracks-file-list';
    populateCategoryFileList(fileList, cat, matched);
    bindContainedScroll(fileList);
    details.appendChild(fileList);
    return details;
  }

  // ── Build per-category filter bar ─────────────────────────────────────────
  function buildCatFilterBar(cat) {
    const opts = cat.filter_options || {};
    const filterBar = document.createElement('div');
    filterBar.className = 'mo-filter-bar';
    const filterRow = document.createElement('div');
    filterRow.className = 'mo-filter-row mo-filter-grid';
    const countEl = document.createElement('div');
    countEl.className = 'mo-filter-count';

    const catHandles = [];
    [
      [t('gn.tracks.filter.period',     'Period'),                  'period',     opts.periods],
      [t('gn.tracks.filter.tissue',     'Tissue'),                  'tissue',     opts.tissues],
      [t('gn.tracks.filter.target',     'Sequence.target'),         'target',     opts.targets],
      [t('gn.tracks.filter.replicates', 'Replicates'),              'replicates', opts.replicates],
      [t('gn.tracks.filter.std_method', 'Standardization.methods'), 'std_method', opts.std_methods],
      [t('gn.tracks.filter.sample',     'Sample'),                  'sample',     opts.samples],
    ].forEach(([lbl, key, vals]) => {
      if (!vals || !vals.length) return;
      const dispFn = (key === 'tissue' || key === 'period') ? v => tVal(key, key, v) : null;
      const handle = makeMultiSelect(lbl, key, vals, filterState[cat.id][key], () => {
        openCategoryDrawerFrom(filterRow);
        refreshGlobal();
      }, dispFn);
      if (handle) { filterRow.appendChild(handle.el); catHandles.push(handle); }
    });

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'mo-filter-reset';
    resetBtn.textContent = t('gn.tracks.filter.reset', 'Reset');
    resetBtn.addEventListener('click', () => {
      ['period', 'tissue', 'target', 'replicates', 'std_method', 'sample'].forEach(k => filterState[cat.id][k].clear());
      catHandles.forEach(h => h.reset());
      openCategoryDrawerFrom(resetBtn);
      refreshGlobal();
    });

    const actionsRow = document.createElement('div');
    actionsRow.className = 'mo-filter-actions';
    updateCatFilterCountEl(countEl, cat, getMatchedFiles(cat));
    actionsRow.appendChild(countEl);
    actionsRow.appendChild(resetBtn);

    filterBar.appendChild(filterRow);
    filterBar.appendChild(actionsRow);
    return filterBar;
  }

  // ── Build a single file item row ──────────────────────────────────────────
  function makeFileItem(file, catId, color, pinned) {
    const item = document.createElement('div');
    item.className = 'tracks-file-item' + (pinned ? ' pinned' : '');
    if (pinned) item.style.setProperty('--pin-color', catColor(catId));

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
    const isOn = isAutoscaleOn(file.url);
    asBtn.className = 'tf-autoscale' + (isOn ? ' on' : '');
    asBtn.textContent = autoscaleLabel(isOn);
    setAutoscaleTip(asBtn, isOn);
    asBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const newState = !isAutoscaleOn(file.url);
      autoscaleState[file.url] = newState;
      asBtn.className = 'tf-autoscale' + (newState ? ' on' : '');
      asBtn.textContent = autoscaleLabel(newState);
      setAutoscaleTip(asBtn, newState);
      const entry = activeTracks[file.url];
      if (entry && entry.trackObj) applyAutoscaleMode(entry.trackObj, file.url);
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
      if (isPendingOrActive(file.url)) {
        syncDrawerCheckboxes();
        return;
      }
      setItemsLoading(file.url, true);
      const loadSeq = moLoadSeqCounter++;
      pendingMoMeta[file.url] = { assay: assayForFile(file), loadSeq };
      enqueueLoad({
        url: file.url,
        run: () => loadTrackDirect(file, catId, color, loadSeq),
        onSettled: (ok) => {
          setItemsLoading(file.url, false);
          if (!ok) clearPendingMoMeta(file.url);
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
      refreshListsAfterDeselect(catId);
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
      syncMoTrackOrder();
      refreshListsAfterDeselect(catId);
    } catch (err) {
      console.error('[multiomics] toggleTrack remove error:', err);
      checkbox.checked = true;
    } finally {
      updateClearBtnState();
    }
  }

  // After a track is deselected, re-render the drawer lists when a filter is
  // active so a now-unselected pinned row disappears immediately.
  function refreshListsAfterDeselect(catId) {
    if (isGlobalFilterActive() || isCatFilterActive(catId)) refreshGlobal();
  }

  // ── expose ────────────────────────────────────────────────────────────────
  window.__pervMultiomics = {
    openDrawer,
    closeDrawer,
    loadIndex,
    clearAll: clearAllMultiomicsTracks,
    syncMoTrackOrder: syncMoTrackOrderNow,
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

  // If we landed here via the home-page atlas hand-off or ?mo_group=, auto-open
  // the drawer so loadIndex() runs and tracks can be preloaded.
  (function autoOpenOnDeepLink() {
    try {
      const hash = (window.location.hash || '').toLowerCase();
      const params = new URLSearchParams(location.search);
      if (hash === '#mo-load' || params.get('mo_group') || params.get('mo_tracks')) {
        if (drawer) openDrawer();
      }
    } catch (_) {}
  })();
})();
