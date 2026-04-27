// Genome browser: igv.js + custom GTF/FASTA backed by our Flask APIs.
// Adds a rich right-side detail panel: clicked feature -> gene + all
// alternative-splicing transcripts + exon-N-of-M callout.
(function () {
  let browser = null;
  let colorSyncTimer = null;
  let chromosomes = [];
  const state = {
    chrom: null,
    start: 1,
    end: 100000,
    selectedGeneId: null,
    selectedTxId: null,
    selectedExonRange: null, // { start, end } in 1-based GTF coordinates
    geneCache: new Map(), // gene_id -> { gene, transcripts }
    displayMode: 'EXPANDED',      // Transcripts track: 'EXPANDED' | 'SQUISHED' | 'COLLAPSED'
    geneDisplayMode: 'EXPANDED',  // Genes track: EXPANDED, same row height as Transcripts
    showFeatureTable: true, // GTF feature breakdown panel open by default
    // 'gene' shows the parent gene header (location, # transcripts, etc.)
    // 'transcript' switches the header to transcript-specific facts
    // (transcript_id, biotype, exon count, CDS length, ...).
    viewMode: 'gene',
    colorTrackId: 'ensembl-genes',
    strandColorLinked: {
      'ensembl-genes': true,
      'ensembl-transcripts': true,
      'perv-sequences': true,
      'homologous-sequences': true,
      'homologous-loci': true,
    },
  };

  // Factory-default strand colors for each built-in track (mirrors the
  // createBrowser() track config below). Used to restore a track's colors
  // after the user has customized them via the strand-color picker.
  const DEFAULT_STRAND_COLORS = {
    'ensembl-genes': { color: '#555555', altColor: '#555555', linked: true },
    'ensembl-transcripts': { color: '#a07800', altColor: '#a07800', linked: true },
    'perv-sequences': { color: '#e05c2b', altColor: '#e05c2b', linked: true },
    'homologous-sequences': { color: '#4a90e2', altColor: '#4a90e2', linked: true },
    'homologous-loci': { color: '#9b59b6', altColor: '#9b59b6', linked: true },
  };

  // Single source of truth for feature-type colors, shared by the exon
  // mini-map (renderTxRow) and the GTF feature breakdown table
  // (renderFeatureBreakdown) so the same feature type always gets the
  // same color everywhere in the detail panel.
  const FEATURE_COLORS = {
    transcript: '#0f172a',
    exon: '#d97706',
    CDS: '#2563eb',
    five_prime_utr: '#0ea5e9',
    three_prime_utr: '#0ea5e9',
    start_codon: '#16a34a',
    stop_codon: '#dc2626',
    noncoding: '#94a3b8',
  };

  // Static heights per display mode. We previously auto-scaled by feature
  // count and called browser.layoutChange() inside the locuschange handler,
  // but that re-entered locuschange in some igv.js builds and froze the
  // page after the first navigation. A fixed height per mode is simpler
  // and lets igv.js handle internal scrolling for very dense regions.
  const MODE_HEIGHT = { EXPANDED: 150, SQUISHED: 100, COLLAPSED: 50 };

  // Canonical igv stack order for built-in annotation tracks (top → bottom).
  const BUILTIN_TRACK_ORDER = {
    'ensembl-genes': 1,
    'ensembl-transcripts': 2,
    'perv-sequences': 3,
    'homologous-sequences': 4,
    'homologous-loci': 5,
  };

  function syncBuiltinTrackOrders() {
    if (!browser || !browser.trackViews) return false;
    let changed = false;
    for (const tv of browser.trackViews) {
      const t = tv && tv.track;
      if (!t || !t.id) continue;
      const want = BUILTIN_TRACK_ORDER[t.id];
      if (want == null) continue;
      if (t.order !== want) {
        t.order = want;
        changed = true;
      }
    }
    if (changed && typeof browser.reorderTracks === 'function') {
      browser.reorderTracks();
    }
    return changed;
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------
  function fmtBp(n) {
    if (n == null) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' Mb';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' kb';
    return n + ' bp';
  }
  function fmtInt(n) { return Number(n).toLocaleString(); }
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function biotypeClass(b) {
    if (!b) return '';
    return b.replace(/[^a-zA-Z0-9_]/g, '_');
  }
  function setLocusDisplay() {
    const el = document.getElementById('g-locus-display');
    if (el) el.textContent = `${state.chrom || ''}:${fmtInt(state.start)}-${fmtInt(state.end)} (${fmtBp(state.end - state.start + 1)})`;
  }

  // ---------------------------------------------------------------------
  // chromosome dropdown
  // ---------------------------------------------------------------------
  // Sscrofa11.1 has 600+ contigs. We render the dropdown from scratch as a
  // virtualised list with an embedded filter input - this avoids the native
  // <select>'s rendering bug (huge solid black overlay on some Linux remote
  // desktop sessions) while still letting users browse every scaffold.
  const MAIN_CHROMS = new Set([
    ...Array.from({ length: 18 }, (_, i) => `chr${i + 1}`),
    'chrX', 'chrY', 'chrM',
  ]);
  function isMainChrom(name) {
    if (!name) return false;
    return MAIN_CHROMS.has(name);
  }

  // Cap the number of scaffold rows we render at once. The user can keep
  // typing in the filter to narrow further; without a cap, painting 600+
  // rows on every open hurts perceived responsiveness.
  const SCAFFOLD_RENDER_LIMIT = 60;

  async function loadChromosomes() {
    const res = await fetch('/api/genome/chromosomes');
    const data = await res.json();
    chromosomes = data.items;
    if (chromosomes.length) {
      const main = chromosomes.filter((c) => isMainChrom(c.name));
      const first = main[0] || chromosomes[0];
      state.chrom = first.name;
      state.end = Math.min(200000, first.length);
      document.getElementById('g-start').value = state.start;
      document.getElementById('g-end').value = state.end;
      setLocusDisplay();
    }
    bindChromPicker();
    renderChromPicker('');
  }

  // Custom chromosome dropdown -------------------------------------------
  function chromLabel(name) {
    const c = chromosomes.find((x) => x.name === name);
    return c ? `${c.name} (${fmtBp(c.length)})` : (name || '—');
  }

  async function pickChromosome(name) {
    if (!name) return;
    const c = chromosomes.find((x) => x.name === name);
    const start = 1;
    const end = c ? Math.min(200000, c.length) : 200000;
    closeChromPicker();
    await gotoLocus(name, start, end);
  }

  function renderChromPicker(filter) {
    const list = document.getElementById('g-chrom-list');
    if (!list) return;
    const main = chromosomes.filter((c) => isMainChrom(c.name));
    const others = chromosomes.filter((c) => !isMainChrom(c.name));
    const f = (filter || '').trim().toLowerCase();
    const matchMain = f ? main.filter((c) => c.name.toLowerCase().includes(f)) : main;
    const matchOthers = f
      ? others.filter((c) => c.name.toLowerCase().includes(f))
      : others;
    const showOthers = matchOthers.slice(0, SCAFFOLD_RENDER_LIMIT);

    const row = (c) => `<li role="option" data-name="${esc(c.name)}" class="${c.name === state.chrom ? 'active' : ''}">
        <span>${esc(c.name)}</span>
        <span class="meta">${esc(fmtBp(c.length))}</span>
      </li>`;

    let html = '';
    if (matchMain.length) {
      html += `<li class="section">${esc(I18n ? I18n.t('gn.chrom.main') : 'Main chromosomes')}</li>`;
      html += matchMain.map(row).join('');
    }
    if (showOthers.length) {
      const labelKey = f ? 'gn.chrom.scaffolds.match' : 'gn.chrom.scaffolds';
      const fallback = f
        ? `Scaffolds matching "${f}"`
        : `Scaffolds (${others.length}; showing first ${showOthers.length})`;
      const tpl = I18n ? I18n.t(labelKey) : '';
      const text = tpl && tpl !== labelKey
        ? tpl.replace('{n}', String(others.length))
             .replace('{shown}', String(showOthers.length))
             .replace('{q}', f)
        : fallback;
      html += `<li class="section">${esc(text)}</li>`;
      html += showOthers.map(row).join('');
      if (matchOthers.length > showOthers.length) {
        const more = matchOthers.length - showOthers.length;
        const moreTpl = I18n ? I18n.t('gn.chrom.more') : '';
        const moreText = moreTpl && moreTpl !== 'gn.chrom.more'
          ? moreTpl.replace('{n}', String(more))
          : `${more} more — refine the filter to narrow down`;
        html += `<li class="section muted">${esc(moreText)}</li>`;
      }
    }
    if (!matchMain.length && !showOthers.length) {
      html += `<li class="section">${esc('No matching chromosome')}</li>`;
    }

    list.innerHTML = html;
    list.querySelectorAll('li[data-name]').forEach((li) => {
      li.addEventListener('click', () => pickChromosome(li.dataset.name));
    });
    const labelEl = document.getElementById('g-chrom-label');
    if (labelEl) labelEl.textContent = chromLabel(state.chrom);
    highlightChromKbd();
  }

  let chromKbdActive = -1;

  function chromPickerOptions() {
    return Array.from(document.querySelectorAll('#g-chrom-list li[data-name]'));
  }

  function highlightChromKbd() {
    const items = chromPickerOptions();
    if (chromKbdActive >= items.length) chromKbdActive = items.length - 1;
    items.forEach((li, i) => li.classList.toggle('kbd-focus', i === chromKbdActive));
  }

  function openChromPicker() {
    const wrap = document.getElementById('g-chrom-wrap');
    const btn = document.getElementById('g-chrom-btn');
    const inp = document.getElementById('g-chrom-filter');
    if (!wrap || !btn) return;
    wrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    if (inp) {
      inp.value = '';
      renderChromPicker('');
      const items = chromPickerOptions();
      chromKbdActive = items.findIndex((li) => li.dataset.name === state.chrom);
      if (chromKbdActive < 0 && items.length) chromKbdActive = 0;
      highlightChromKbd();
      // Focus on next tick so the click that opens the menu doesn't blur it.
      setTimeout(() => inp.focus(), 0);
    }
  }
  function closeChromPicker() {
    const wrap = document.getElementById('g-chrom-wrap');
    const btn = document.getElementById('g-chrom-btn');
    if (!wrap || !btn) return;
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    chromKbdActive = -1;
  }
  let _chromPickerBound = false;
  function bindChromPicker() {
    if (_chromPickerBound) return;
    const btn = document.getElementById('g-chrom-btn');
    const wrap = document.getElementById('g-chrom-wrap');
    const filter = document.getElementById('g-chrom-filter');
    if (!btn || !wrap) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (wrap.classList.contains('open')) closeChromPicker();
      else openChromPicker();
    });
    if (filter) {
      let fTimer;
      filter.addEventListener('input', (e) => {
        const v = e.target.value || '';
        clearTimeout(fTimer);
        fTimer = setTimeout(() => {
          renderChromPicker(v);
          chromKbdActive = chromPickerOptions().length ? 0 : -1;
          highlightChromKbd();
        }, 80);
      });
      filter.addEventListener('keydown', (e) => {
        const items = chromPickerOptions();
        if (e.key === 'Escape') {
          closeChromPicker();
        } else if (e.key === 'ArrowDown') {
          if (!items.length) return;
          chromKbdActive = chromKbdActive < 0 ? 0 : Math.min(items.length - 1, chromKbdActive + 1);
          highlightChromKbd();
          items[chromKbdActive].scrollIntoView({ block: 'nearest' });
          e.preventDefault();
        } else if (e.key === 'ArrowUp') {
          if (!items.length) return;
          chromKbdActive = chromKbdActive < 0 ? 0 : Math.max(0, chromKbdActive - 1);
          highlightChromKbd();
          items[chromKbdActive].scrollIntoView({ block: 'nearest' });
          e.preventDefault();
        } else if (e.key === 'Enter') {
          const idx = chromKbdActive >= 0 ? chromKbdActive : 0;
          if (items[idx]) pickChromosome(items[idx].dataset.name);
          e.preventDefault();
        }
      });
      filter.addEventListener('click', (e) => e.stopPropagation());
    }
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) closeChromPicker();
    });
    _chromPickerBound = true;
  }

  // ---------------------------------------------------------------------
  // IGV initialization
  // ---------------------------------------------------------------------
  async function initIgv(initialLocus) {
    const container = document.getElementById('igv-container');
    if (!container || browser) return;
    // If a deep-link target was already resolved by the time we get here
    // (see prefetchDeepLinkRegion / resolveInitialLocus below), seed IGV's
    // very first viewport with it instead of the generic default region.
    // This avoids a slow "render default view, then immediately jump to the
    // real target" double navigation on every Try-example / shared link.
    if (initialLocus && initialLocus.chrom) {
      state.chrom = initialLocus.chrom;
      state.start = initialLocus.start;
      state.end = initialLocus.end;
    }
    const reference = {
      id: 'sscrofa11.1',
      name: 'Sus scrofa Sscrofa11.1',
      fastaURL: '/genome/data/genome.fa',
      indexURL: '/genome/data/genome.fa.fai',
      tracks: [],
    };
    const tracks = [
      {
        id: 'ensembl-genes',
        name: 'Genes',
        type: 'annotation',
        format: 'bed',
        url: '/genome/data/genome.genes.bed',
        indexed: false,
        height: GENE_MODE_HEIGHT[state.geneDisplayMode] || 150,
        displayMode: state.geneDisplayMode,
        expandedRowHeight: 28,
        squishedRowHeight: 14,
        fontSize: 10,
        color: '#555555',
        altColor: '#555555',
        visibilityWindow: -1,
      },
      {
        id: 'ensembl-transcripts',
        name: 'Transcripts',
        type: 'annotation',
        format: 'bed',
        url: '/genome/data/genome.bed',
        indexed: false,
        height: MODE_HEIGHT[state.displayMode] || 150,
        displayMode: state.displayMode,
        expandedRowHeight: 28,
        squishedRowHeight: 14,
        maxRows: 500,
        fontSize: 10,
        color: '#a07800',
        altColor: '#a07800',
        visibilityWindow: -1,
      },
      {
        id: 'perv-sequences',
        name: 'PERV',
        type: 'annotation',
        format: 'bed',
        url: '/genome/data/perv.bed',
        indexed: false,
        height: 50,
        displayMode: 'EXPANDED',
        expandedRowHeight: 22,
        color: '#e05c2b',
        altColor: '#e05c2b',
        visibilityWindow: -1,
      },
      {
        id: 'homologous-sequences',
        name: 'Homologous Seq',
        type: 'annotation',
        format: 'bed',
        url: '/genome/data/homologous_seq.bed',
        indexed: false,
        height: 100,
        displayMode: 'EXPANDED',
        expandedRowHeight: 28,
        squishedRowHeight: 14,
        fontSize: 10,
        color: '#4a90e2',
        altColor: '#4a90e2',
        visibilityWindow: 300000000,
      },
      {
        id: 'homologous-loci',
        name: 'Homologous Loci',
        type: 'annotation',
        format: 'bed',
        url: '/genome/data/homologous_locus.bed',
        indexed: false,
        height: 50,
        displayMode: 'EXPANDED',
        expandedRowHeight: 28,
        squishedRowHeight: 14,
        fontSize: 10,
        color: '#9b59b6',
        altColor: '#9b59b6',
        visibilityWindow: 300000000,
      },
    ];
    const config = {
      reference,
      tracks,
      locus: `${state.chrom}:${state.start}-${state.end}`,
      showSampleNames: false,
      showChromosomeWidget: false,
      showCenterGuide: true,
      showCursorTrackingGuide: true,
      showSVGButton: false,
      // igv.js checks `browser.doShowTrackLabels` (set from this very flag)
      // the instant each track viewport creates its `.igv-track-label` div,
      // and immediately sets `display:none` on it if false — synchronously,
      // before any of our custom CSS could possibly apply. Starting with
      // labels hidden means the raw/unstyled igv.js label markup is never
      // painted at all (not even for one frame); we reveal the (by-then
      // styled) labels ourselves once _injectLabelStyleIntoShadow() has run.
      // This is more robust than racing to inject CSS before first paint.
      showTrackLabels: false,
    };
    // igv.createBrowser() attaches an open Shadow Root to `container`
    // synchronously (before its first internal `await`), then continues on
    // to fetch reference/feature data and paint the initial tracks. Kick it
    // off without awaiting yet, and poll for the Shadow Root on every
    // animation frame so our label CSS is injected as early as possible —
    // well before we reveal the (still-hidden) labels below.
    const browserPromise = igv.createBrowser(container, config);
    _pollInjectLabelStyleIntoShadow(60);
    try {
      browser = await browserPromise;
    } catch (err) {
      console.error('[genome] igv.createBrowser failed', err);
      container.innerHTML = `<div class="empty-hint">igv.js init failed: ${esc(err && err.message ? err.message : String(err))}</div>`;
      return;
    }

    // Expose browser instance for multiomics.js
    window.__pervBrowser = browser;
    if (window.__pervMultiomics && window.__pervMultiomics.updateClearBtnState) {
      window.__pervMultiomics.updateClearBtnState();
    }

    // Mark the initial (frozen) tracks with a CSS class so they can be
    // made sticky via CSS. We do this after a short tick to let IGV finish
    // painting the initial track DOM.
    setTimeout(() => { suppressFrozenSpinners(); _markAndStickyFrozenTracks(); }, 80);

    // Safety-net re-injection: normally the rAF polling above already
    // injected the CSS well before this point, but if it somehow missed the
    // window (e.g. an extremely fast synchronous createBrowser), this call
    // guarantees the style is present now. Idempotent — reuses the same
    // <style> element if already injected.
    _injectLabelStyleIntoShadow();

    // Labels were created hidden (config.showTrackLabels: false above) so
    // igv.js's raw/unstyled markup never painted. Reveal them now that our
    // CSS is definitely in place, and flip `doShowTrackLabels` so the
    // toolbar's own "Track Labels" toggle button stays in sync with reality.
    browser.doShowTrackLabels = true;
    if (typeof browser.setTrackLabelVisibility === 'function') {
      browser.setTrackLabelVisibility(true);
    }

    // Keep strand altColor synced with the main color.
    // IGV's "Set track color" menu can update `track.color` but leave
    // `track.altColor` unchanged, which makes only part of a strand-aware
    // track appear recolored. We force both to the same value so users get
    // true whole-track recoloring.
    try { suppressFrozenSpinners(); } catch (e) { console.warn('[genome] suppressFrozenSpinners init error:', e); }
    try { syncTrackColors(); } catch (e) { console.warn('[genome] syncTrackColors init error:', e); }
    if (colorSyncTimer) window.clearInterval(colorSyncTimer);
    colorSyncTimer = window.setInterval(() => {
      try { suppressFrozenSpinners(); } catch (e) { /* keep timer alive */ }
      try { syncTrackColors(); } catch (e) { /* keep timer alive */ }
    }, 2000);
    syncColorControlsFromTrack();
    let _locusHeavyDebounce = null;
    browser.on('locuschange', (referenceFrameList) => {
      try {
        if (!referenceFrameList || !referenceFrameList.length) return;
        const f = referenceFrameList[0];
        state.chrom = f.chr;
        state.start = Math.max(1, Math.round(f.start) + 1);
        state.end = Math.round(f.end);
        reflectInputs();
        setLocusDisplay();
        suppressFrozenSpinners();
        clearTimeout(_locusHeavyDebounce);
        _locusHeavyDebounce = setTimeout(() => {
          syncTrackColors();
          _markAndStickyFrozenTracks();
          loadDnaFootSequence();
        }, 150);
      } catch (e) {
        console.warn('[genome] locuschange handler error:', e);
      }
    });
    // Suppress the default popover entirely - we render our own panel.
    browser.on('trackclick', (track, popoverData) => {
      console.debug('[genome] trackclick popoverData:', popoverData);
      if (!popoverData || !popoverData.length) return undefined;
      const map = {};
      popoverData.forEach((d) => {
        if (!d) return;
        if (d.name && d.value !== undefined) map[d.name] = d.value;
        else if (d.html) map['_html'] = d.html;
      });
      handleFeatureClick(map);
      return false; // false -> suppress IGV popover
    });
  }

  // igv 3.8 re-runs loadFeatures() (and flashes the per-track spinner) for EVERY
  // track on every loadTrack()/reorderTracks() because of an internal
  // `needsReload` quirk — even though the built-in annotation tracks load with
  // visibilityWindow:-1 (whole-genome data cached after init, so it's a pure
  // cache hit and nothing is actually fetched). That makes adding a multi-omics
  // track look like the gene/transcript tracks are reloading. We neutralize the
  // spinner for every NON multi-omics track by overriding its viewports'
  // startSpinner to a no-op + hiding any spinner already shown. The genuine
  // multi-omics (wig / id "mo_…") spinner is preserved.
  function isMultiomicsTrack(t) {
    if (!t) return false;
    const id = String(t.id || '');
    const url = String(t.url || '');
    return id.startsWith('mo_') || t.type === 'wig' || url.includes('/multiomics/data/');
  }

  function suppressFrozenSpinners() {
    if (!browser || !browser.trackViews) return;
    // Browser-level spinner (root element, not inside any viewport): shown by
    // loadTrackList() over the whole view on every track add. Neutralize it so
    // only the genuinely-loading track's own spinner remains.
    if (browser.spinnerElement) {
      if (browser.spinnerElement.classList) browser.spinnerElement.classList.add('perv-hide-spinner');
      browser.spinnerElement.style.display = 'none';
    }
    if (!browser.__pervRootSpinnerPatched && typeof browser.startSpinner === 'function') {
      browser.startSpinner = function () {};
      browser.__pervRootSpinnerPatched = true;
    }
    for (const tv of browser.trackViews) {
      const t = tv && tv.track;
      if (!t) continue;
      const isMo = isMultiomicsTrack(t);
      const viewports = tv.viewports || [];
      for (const vp of viewports) {
        if (!vp) continue;
        const el = vp.viewportElement;
        if (isMo) {
          // Genuine multi-omics track: keep its spinner working normally.
          if (el && el.classList) el.classList.remove('perv-suppress-spinner');
          continue;
        }
        // Built-in / non-MO track: CSS class makes the shadow-root rule hide the
        // spinner with !important (beats startSpinner's inline display:flex).
        if (el && el.classList) el.classList.add('perv-suppress-spinner');
        // Belt-and-suspenders: also neutralize the JS path + hide any spinner
        // that is already showing.
        if (!vp.__pervSpinnerPatched) {
          vp.startSpinner = function () {};
          vp.__pervSpinnerPatched = true;
        }
        if (vp.spinnerElement) vp.spinnerElement.style.display = 'none';
      }
    }
  }

  function syncTrackColors() {
    if (!browser || !browser.trackViews) return;
    for (const tv of browser.trackViews) {
      if (!tv || !tv.track) continue;
      const t = tv.track;
      if (typeof t.color !== 'string' || !t.color) continue;
      if (!state.strandColorLinked[t.id]) continue;
      if (t.altColor === t.color) continue;
      t.altColor = t.color;
      if (typeof tv.repaintViews === 'function') tv.repaintViews();
      else if (typeof tv.updateViews === 'function') tv.updateViews();
    }
  }

  // ---- frozen-track sticky logic ------------------------------------------
  // Called once after igv.createBrowser and again after locuschange (heights
  // may change when display mode switches). Marks the initially created
  // trackView DOM nodes as .frozen-track and stacks their sticky top offsets.
  const _frozenDivs = [];

  // Poll (via requestAnimationFrame) for `#igv-container`'s Shadow Root to
  // appear, injecting the label CSS the moment it does — instead of waiting
  // for the entire igv.createBrowser() promise (reference load + feature
  // fetch + first paint) to resolve. See the call site in initIgv() for the
  // full rationale. `retriesLeft` bounds the polling so a failed/slow init
  // can't loop forever; _injectLabelStyleIntoShadow() is idempotent (reuses
  // the same <style> element), so calling it again later is harmless.
  function _pollInjectLabelStyleIntoShadow(retriesLeft) {
    const container = document.getElementById('igv-container');
    if (container && container.shadowRoot) {
      _injectLabelStyleIntoShadow();
      return;
    }
    if (retriesLeft <= 0) return;
    requestAnimationFrame(() => _pollInjectLabelStyleIntoShadow(retriesLeft - 1));
  }

  function _injectLabelStyleIntoShadow() {
    // igv.js v3 attaches an open shadow root directly to #igv-container.
    const container = document.getElementById('igv-container');
    if (!container) return;
    const sr = container.shadowRoot;
    if (!sr) {
      console.warn('[PERV] igv shadow root not found yet');
      return;
    }
    // Inject (or update) a <style> into the shadow root.
    // Use querySelector('#id') — more reliable than getElementById on ShadowRoot.
    let st = sr.querySelector('#__perv-label-css');
    if (!st) {
      st = document.createElement('style');
      st.id = '__perv-label-css';
      sr.appendChild(st);
    }
    st.textContent = `
      .igv-track-label {
        padding: 5px 14px !important;
        margin: 6px 4px !important;
        box-sizing: border-box !important;
        display: inline-block !important;
        line-height: 1.5 !important;
        font: 600 11px/1.5 -apple-system,"Segoe UI","PingFang SC",sans-serif !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        background: #eef2ff !important;
        border: 1px solid rgba(37,99,235,0.35) !important;
        border-radius: 6px !important;
        color: #1e40af !important;
      }
      /* The built-in annotation tracks (Genes, Transcripts, PERV, Homologous)
         load with visibilityWindow:-1, so their whole-genome data is cached
         after init. igv 3.8 still re-runs loadFeatures() (and flashes their
         spinner) on every loadTrack() due to an internal needsReload quirk,
         even though it's a pure cache hit. We tag every NON multi-omics
         viewport element with the perv-suppress-spinner class (see
         suppressFrozenSpinners) and hide its spinner here with !important, which
         beats startSpinner's inline display:flex regardless of timing or
         viewport recreation. The real wig (multi-omics) spinner is untouched. */
      .perv-suppress-spinner .igv-loading-spinner-container {
        display: none !important;
      }
      /* igv also has a single browser-level spinner appended directly to the
         root element (browser.js: this.root.appendChild(this.spinnerElement)).
         loadTrackList() shows it centered over the whole view whenever ANY
         track is added — that's the misleading "middle" spinner. The per-track
         spinner of the track actually being loaded is enough feedback, so we
         hide this root-level one. The class is added to browser.spinnerElement
         in suppressFrozenSpinners; !important beats startSpinner's inline flex. */
      .igv-loading-spinner-container.perv-hide-spinner {
        display: none !important;
      }
    `;
    const labels = sr.querySelectorAll('.igv-track-label');
    console.log('[PERV] shadow root found, labels:', labels.length, '— style injected');
  }

  function _markAndStickyFrozenTracks() {
    if (!browser || !browser.trackViews) return;
    if (_frozenDivs.length === 0) {
      // First call: collect & mark existing trackView divs as frozen.
      for (const tv of browser.trackViews) {
        const div = tv && (tv.trackDiv || (tv.viewportContainerDiv && tv.viewportContainerDiv.parentElement));
        if (div) {
          div.classList.add('frozen-track');
          _frozenDivs.push(div);
        }
      }
    }
    // (Re-)calculate cumulative top offsets for stacked sticky elements.
    let cumTop = 0;
    for (const div of _frozenDivs) {
      div.style.top = cumTop + 'px';
      cumTop += div.offsetHeight || 0;
    }
  }

  function findTrackById(id) {
    if (!browser || !browser.trackViews) return null;
    for (const tv of browser.trackViews) {
      const t = tv && tv.track;
      if (t && t.id === id) return { track: t, trackView: tv };
    }
    return null;
  }

  function normalizeHexColor(v, fallback) {
    const s = String(v || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
  }

  function syncColorControlsFromTrack() {
    const sel = document.getElementById('g-color-track');
    const plus = document.getElementById('g-color-plus');
    const minus = document.getElementById('g-color-minus');
    const link = document.getElementById('g-color-link');
    if (!sel || !plus || !minus || !link) return;
    state.colorTrackId = sel.value || state.colorTrackId;
    const picked = findTrackById(state.colorTrackId);
    if (!picked || !picked.track) return;
    const t = picked.track;
    plus.value = normalizeHexColor(t.color, plus.value || '#2563eb');
    minus.value = normalizeHexColor(t.altColor || t.color, plus.value);
    const linked = state.strandColorLinked[state.colorTrackId] !== false;
    link.checked = linked;
    minus.disabled = linked;
    updateColorResetState();
  }

  // Whether the currently-picked track's strand colors have drifted from
  // their factory defaults (i.e. the user customized them).
  function isStrandColorCustomized(trackId) {
    const def = DEFAULT_STRAND_COLORS[trackId];
    if (!def) return false;
    const picked = findTrackById(trackId);
    if (!picked || !picked.track) return false;
    const t = picked.track;
    const linked = state.strandColorLinked[trackId] !== false;
    return (
      normalizeHexColor(t.color, def.color) !== def.color ||
      normalizeHexColor(t.altColor || t.color, def.altColor) !== def.altColor ||
      linked !== def.linked
    );
  }

  function updateColorResetState() {
    const resetBtn = document.getElementById('g-color-reset');
    if (!resetBtn) return;
    resetBtn.disabled = !isStrandColorCustomized(state.colorTrackId);
  }

  // Restores the currently-picked track's strand colors to their factory
  // defaults, discarding any user customization.
  function resetStrandColor() {
    const trackId = state.colorTrackId;
    const def = DEFAULT_STRAND_COLORS[trackId];
    const picked = findTrackById(trackId);
    if (!def || !picked || !picked.track) return;
    const t = picked.track;
    t.color = def.color;
    t.altColor = def.altColor;
    state.strandColorLinked[trackId] = def.linked;
    if (picked.trackView && typeof picked.trackView.repaintViews === 'function') {
      picked.trackView.repaintViews();
    } else if (picked.trackView && typeof picked.trackView.updateViews === 'function') {
      picked.trackView.updateViews();
    }
    syncColorControlsFromTrack();
  }

  function applyStrandColors() {
    const sel = document.getElementById('g-color-track');
    const plusEl = document.getElementById('g-color-plus');
    const minusEl = document.getElementById('g-color-minus');
    const linkEl = document.getElementById('g-color-link');
    if (!sel || !plusEl || !minusEl || !linkEl) return;
    state.colorTrackId = sel.value || state.colorTrackId;
    const linked = !!linkEl.checked;
    state.strandColorLinked[state.colorTrackId] = linked;
    const plus = normalizeHexColor(plusEl.value, '#2563eb');
    const minus = linked ? plus : normalizeHexColor(minusEl.value, plus);
    if (linked) minusEl.value = plus;
    minusEl.disabled = linked;

    const picked = findTrackById(state.colorTrackId);
    if (!picked || !picked.track) return;
    const t = picked.track;
    t.color = plus;
    t.altColor = minus;
    if (picked.trackView && typeof picked.trackView.repaintViews === 'function') {
      picked.trackView.repaintViews();
    } else if (picked.trackView && typeof picked.trackView.updateViews === 'function') {
      picked.trackView.updateViews();
    }
    updateColorResetState();
  }

  function reflectInputs() {
    const labelEl = document.getElementById('g-chrom-label');
    if (labelEl) labelEl.textContent = chromLabel(state.chrom);
    document.getElementById('g-start').value = state.start;
    document.getElementById('g-end').value = state.end;
  }

  async function gotoLocus(chrom, start, end) {
    if (!browser) return;
    const c = chromosomes.find((x) => x.name === chrom);
    if (c) {
      start = Math.max(1, start);
      end = Math.min(c.length, end);
    }
    state.chrom = chrom;
    state.start = start;
    state.end = end;
    const locus = `${chrom}:${start}-${end}`;
    try {
      await browser.search(locus);
    } catch (err) {
      console.error('[genome] browser.search failed for', locus, err);
      alert('IGV navigation failed: ' + (err && err.message ? err.message : err));
      return;
    }
    reflectInputs();
    setLocusDisplay();
  }

  // ---------------------------------------------------------------------
  // search
  // ---------------------------------------------------------------------
  function bindSearch() {
    const input = document.getElementById('g-search');
    const list = document.getElementById('g-search-results');
    let active = -1;
    let items = [];
    let lastFetchedQ = '';
    let timer;
    let abortCtrl = null;

    function close() { list.style.display = 'none'; active = -1; }

    function reopenSuggest() {
      const q = (input.value || '').trim();
      if (!q) return;
      if (items.length && q.toLowerCase() === lastFetchedQ.toLowerCase()) {
        if (active < 0) active = 0;
        render();
      } else {
        fetchSuggest(q);
      }
    }

    function scrollActiveIntoView() {
      if (active < 0 || !list) return;
      const li = list.querySelector(`li[data-i="${active}"]`);
      if (!li) return;
      const itemTop = li.offsetTop;
      const itemBottom = itemTop + li.offsetHeight;
      const viewTop = list.scrollTop;
      const viewBottom = viewTop + list.clientHeight;
      if (itemTop < viewTop) {
        list.scrollTop = itemTop;
      } else if (itemBottom > viewBottom) {
        list.scrollTop = itemBottom - list.clientHeight;
      }
    }

    function highlightMatch(text, query) {
      if (text == null || text === '') return '';
      if (!query) return esc(text);
      const raw = String(text);
      const ql = String(query).toLowerCase();
      const lower = raw.toLowerCase();
      let out = '';
      let pos = 0;
      while (pos < raw.length) {
        const idx = lower.indexOf(ql, pos);
        if (idx < 0) {
          out += esc(raw.slice(pos));
          break;
        }
        out += esc(raw.slice(pos, idx));
        out += '<mark class="ac-hl">' + esc(raw.slice(idx, idx + ql.length)) + '</mark>';
        pos = idx + ql.length;
      }
      return out;
    }

    function render() {
      if (!items.length) { list.innerHTML = ''; list.style.display = 'none'; return; }
      const hlQ = lastFetchedQ || (input.value || '').trim();
      list.innerHTML = items.map((it, i) => {
        const isTx = it.type === 'transcript';
        const pillCls = isTx ? 'pill tx' : 'pill';
        const pillTxt = isTx
          ? (I18n ? I18n.t('gn.detail.kind.tx') : 'Transcript')
          : (I18n ? I18n.t('gn.detail.kind.gene') : 'Gene');
        const primaryRaw = isTx
          ? it.transcript_id
          : (it.gene_name || it.gene_id);
        const secondaryRaw = isTx
          ? `${it.gene_name || it.gene_id || ''} · ${it.transcript_biotype || it.gene_biotype || ''}`
          : `${it.gene_id || ''} · ${it.gene_biotype || ''}`;
        const primary = highlightMatch(primaryRaw, hlQ);
        const secondary = highlightMatch(secondaryRaw, hlQ);
        return `<li data-i="${i}" ${i === active ? 'class="active"' : ''}>` +
            `<span class="left">` +
              `<span class="${pillCls}">${pillTxt}</span>` +
              `<span class="name">${primary}</span>` +
              `<span class="meta">${secondary}</span>` +
            `</span>` +
            `<span class="meta loc">${esc(it.chrom)}:${fmtInt(it.start)}-${fmtInt(it.end)}</span>` +
          '</li>';
      }).join('');
      list.style.display = 'block';
      list.querySelectorAll('li').forEach((li) =>
        li.addEventListener('click', () => pick(Number(li.dataset.i))));
      if (active >= 0) scrollActiveIntoView();
    }

    async function pick(i) {
      const it = items[i];
      if (!it) return;
      const isTx = it.type === 'transcript';
      input.value = isTx ? it.transcript_id : (it.gene_name || it.gene_id || '');
      close();
      const pad = Math.max(500, Math.round((it.end - it.start) * 0.2));
      try {
        await gotoLocus(it.chrom, Math.max(1, it.start - pad), it.end + pad);
        if (isTx && it.gene_id) {
          state.viewMode = 'transcript';
          await showGeneDetail(it.gene_id, it.transcript_id, null);
        } else if (it.gene_id) {
          state.viewMode = 'gene';
          await showGeneDetail(it.gene_id, null, null);
        }
      } catch (e) {
        console.warn('[genome] pick failed:', e);
      }
    }

    async function fetchSuggest(q) {
      // Cancel any still-in-flight request so a slow, stale response can
      // never race past a newer one and clobber the dropdown.
      if (abortCtrl) abortCtrl.abort();
      if (!q) { items = []; lastFetchedQ = ''; render(); return; }
      abortCtrl = new AbortController();
      const { signal } = abortCtrl;
      try {
        const r = await fetch('/api/genome/search?q=' + encodeURIComponent(q), { signal });
        if (!r.ok) { items = []; lastFetchedQ = q; render(); return; }
        const d = await r.json();
        items = d.items || [];
        lastFetchedQ = q;
        active = items.length ? 0 : -1;
        render();
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.warn('[genome] search fetch failed:', e);
        items = []; lastFetchedQ = q; render();
      }
    }

    input.addEventListener('input', (e) => {
      clearTimeout(timer);
      const q = (e.target.value || '').trim();
      if (!q) {
        if (abortCtrl) abortCtrl.abort();
        items = []; lastFetchedQ = ''; render();
        return;
      }
      timer = setTimeout(() => fetchSuggest(q), 120);
    });
    input.addEventListener('focus', reopenSuggest);
    // Input may already be focused after picking a result; focus won't fire
    // again on the next click, so reopen on click as well.
    input.addEventListener('click', reopenSuggest);
    input.addEventListener('keydown', (e) => {
      if (list.style.display === 'none') {
        if (e.key === 'ArrowDown' && items.length) {
          if (active < 0) active = 0;
          render();
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { if (active >= 0) pick(active); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); }
    });
    document.addEventListener('click', (e) => {
      if (!list.contains(e.target) && e.target !== input) close();
    });
  }

  // ---------------------------------------------------------------------
  // detail panel
  // ---------------------------------------------------------------------
  function clearDetail() {
    state.selectedGeneId = null;
    state.selectedTxId = null;
    state.selectedExonRange = null;
    const body = document.getElementById('g-detail-body');
    body.innerHTML = `<div class="empty" data-i18n="gn.detail.empty">${esc(I18n ? I18n.t('gn.detail.empty') : '')}</div>`;
    document.getElementById('g-dna-wrap').style.display = 'none';
  }

  // The igv popover map carries fields like "name", "gene_id", "transcript_id",
  // "biotype", "type", coords, plus our custom "gene_name", "gene_biotype".
  // igv.js v3 capitalizes the first letter of each property name (e.g.
  // "gene_id" -> "Gene_id"), so we normalize the keys to lower case before
  // looking them up.
  //
  // With the BED12 source we own, the only useful identifier in the popover
  // is the `name` field, which we write as "ENSSSCT... (GENE_NAME)" or just
  // "ENSSSCT...". We parse the Ensembl transcript ID (and the optional gene
  // name in parens) out of that string.
  const _ENSEMBL_TX_RE = /^(ENS[A-Z]*T\d+(?:\.\d+)?)/;
  const _ENSEMBL_GENE_RE = /^(ENS[A-Z]*G\d+(?:\.\d+)?)/;
  function extractIds(map) {
    const lower = {};
    for (const k of Object.keys(map || {})) {
      const v = map[k];
      if (v == null) continue;
      lower[String(k).toLowerCase().replace(/\s+/g, '_')] = v;
    }
    const num = (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : NaN;
    };
    let geneId = String(lower['gene_id'] || lower['gene'] || '');
    let txId = String(lower['transcript_id'] || lower['transcript'] || '');
    let geneName = String(lower['gene_name'] || '');
    const rawName = String(lower['name'] || '');
    if (rawName) {
      // BED label looks like "ENSSSCT00000027607 (ALDH1A1)" - try transcript first
      if (!txId) {
        const mt = rawName.match(_ENSEMBL_TX_RE);
        if (mt) txId = mt[1];
      }
      if (!geneId) {
        const mg = rawName.match(_ENSEMBL_GENE_RE);
        if (mg) geneId = mg[1];
      }
      if (!geneName) {
        const paren = rawName.match(/\(([^)]+)\)\s*$/);
        if (paren) geneName = paren[1];
      }
    }
    return {
      gene_id: geneId,
      transcript_id: txId,
      gene_name: geneName,
      type: String(lower['type'] || ''),
      name: rawName,
      start: num(lower['start']),
      end: num(lower['end']),
      _raw: lower,
    };
  }

  async function handleFeatureClick(map) {
    const ids = extractIds(map);
    console.debug('[genome] click map:', map, 'ids:', ids);

    // 0a) clicking a PERV track feature — name is a PERV sequence id like "RF3-51.114M"
    if (ids.name && _pervDataMap && _pervDataMap.has(ids.name)) {
      showPervDetail(ids.name);
      return;
    }
    // Also handle the case where igv capitalizes "Name"
    if (ids._raw) {
      const rawName = String(ids._raw['name'] || ids._raw['Name'] || '');
      if (rawName && _pervDataMap && _pervDataMap.has(rawName)) {
        showPervDetail(rawName);
        return;
      }
    }

    // 0b) clicking a Homologous Sequences track feature
    if (ids.name && _homoSeqMap && _homoSeqMap.has(ids.name)) {
      showHomologousSeqDetail(_homoSeqMap.get(ids.name));
      return;
    }
    if (ids._raw) {
      const rawName = String(ids._raw['name'] || ids._raw['Name'] || '');
      if (rawName && _homoSeqMap && _homoSeqMap.has(rawName)) {
        showHomologousSeqDetail(_homoSeqMap.get(rawName));
        return;
      }
    }

    // 0c) clicking a Homologous Loci track feature
    if (ids.name && _homoLocusMap && _homoLocusMap.has(ids.name)) {
      showHomologousLocusDetail(_homoLocusMap.get(ids.name));
      return;
    }
    if (ids._raw) {
      const rawName = String(ids._raw['name'] || ids._raw['Name'] || '');
      if (rawName && _homoLocusMap && _homoLocusMap.has(rawName)) {
        showHomologousLocusDetail(_homoLocusMap.get(rawName));
        return;
      }
    }

    // exon coordinate hint (igv passes 0-based; convert to 1-based by +1)
    let exonRange = null;
    if (Number.isFinite(ids.start) && Number.isFinite(ids.end)) {
      exonRange = { start: ids.start + 1, end: ids.end };
    }

    // 1) clicking a transcript row (BED12 track, name = "ENSSSCT...")
    if (ids.transcript_id) {
      try {
        const r = await fetch(`/api/genome/transcript/${encodeURIComponent(ids.transcript_id)}`);
        if (r.ok) {
          const d = await r.json();
          if (d.gene_id) {
            state.viewMode = 'transcript';
            await showGeneDetail(d.gene_id, ids.transcript_id, exonRange);
            return;
          }
        }
      } catch (e) { /* fall through */ }
    }
    // 2) clicking a gene row (gene track, name = "ENSSSCG..." OR a symbol)
    if (ids.gene_id) {
      state.viewMode = 'gene';
      await showGeneDetail(ids.gene_id, null, null);
      return;
    }
    // 3) clicking a gene whose label is a plain symbol (e.g. "ALDH1A1")
    if (ids.name && !/^ENS[A-Z]*[GT]\d+/.test(ids.name)) {
      try {
        const q = ids.name.replace(/_/g, ' ');
        const r = await fetch(`/api/genome/search?q=${encodeURIComponent(q)}&limit=5`);
        if (r.ok) {
          const d = await r.json();
          const gene = (d.items || []).find((it) => it.type !== 'transcript' && (
            (it.gene_name || '').toLowerCase() === q.toLowerCase()
          ));
          if (gene && gene.gene_id) {
            state.viewMode = 'gene';
            await showGeneDetail(gene.gene_id, null, null);
            return;
          }
        }
      } catch (e) { /* fall through */ }
    }
    // 4) fallback: dump the raw popover map so the panel isn't empty
    renderRawMap(map);
  }

  async function showGeneDetail(geneId, focusTxId, exonRange) {
    state.selectedGeneId = geneId;
    state.selectedTxId = focusTxId || null;
    state.selectedExonRange = exonRange || null;
    const body = document.getElementById('g-detail-body');
    body.innerHTML = `<div class="empty">${esc(I18n.t('gn.detail.loading'))}</div>`;

    let pack = state.geneCache.get(geneId);
    if (!pack) {
      try {
        const r = await fetch(`/api/genome/gene/${encodeURIComponent(geneId)}`);
        if (!r.ok) {
          body.innerHTML = `<div class="empty">${esc(I18n.t('gn.detail.fail'))}: ${r.status}</div>`;
          return;
        }
        pack = await r.json();
        state.geneCache.set(geneId, pack);
      } catch (e) {
        body.innerHTML = `<div class="empty">${esc(I18n.t('gn.detail.fail'))}: ${esc(e.message || e)}</div>`;
        return;
      }
    }
    renderGeneDetail(pack);
  }

  function renderGeneDetail(pack) {
    const g = pack.gene;
    const txs = pack.transcripts || [];
    if (!state.selectedTxId && txs.length) state.selectedTxId = txs[0].transcript_id;

    // Compute one shared coordinate scale for all transcripts mini-maps,
    // so users can visually compare alternative splicing.
    const lo = g.start;
    const hi = g.end;
    const span = Math.max(1, hi - lo);

    // Selected transcript object (used for the header + GTF feature table).
    const selTx = txs.find((t) => t.transcript_id === state.selectedTxId) || txs[0];

    const txHtml = txs.map((t) => renderTxRow(t, lo, span, selTx ? selTx.transcript_id : null)).join('');
    const featureBreakdown = selTx ? renderFeatureBreakdown(selTx, g.chrom) : '';

    const isTxView = state.viewMode === 'transcript' && selTx;
    const header = isTxView ? renderTxHeader(g, selTx) : renderGeneHeader(g, txs);

    const body = document.getElementById('g-detail-body');
    body.innerHTML = header + featureBreakdown +
      `<h4 class="section">${esc(I18n.t('gn.detail.transcripts'))} <span style="color:var(--muted);font-weight:600;">(${txs.length})</span></h4>` +
      `<div class="tx-list">${txHtml}</div>`;

    // Wire up tx-row clicks: clicking a transcript card switches the
    // header to transcript view (so users see transcript-centric stats
    // instead of staring at the gene summary all the time).
    body.querySelectorAll('.tx-row').forEach((row) => {
      row.addEventListener('click', () => {
        const tid = row.dataset.tx;
        state.selectedTxId = tid;
        state.selectedExonRange = null;
        state.viewMode = 'transcript';
        renderGeneDetail(pack);
      });
    });
    // Resolve which CDS/UTR/exon sub-segment sits under a given pointer
    // position within an .exon-wrap hit box, by converting clientX back
    // into a genomic coordinate rather than requiring the mouse to land
    // inside that segment's (possibly sub-pixel) own DOM box.
    function locateSeg(wrap, clientX) {
      const row = wrap.closest('.tx-row');
      const t = row && txs.find((tx) => tx.transcript_id === row.dataset.tx);
      if (!t) return null;
      const eStart = Number(wrap.dataset.start);
      const eEnd = Number(wrap.dataset.end);
      const e = (t.exons || []).find((x) => x.start === eStart && x.end === eEnd);
      if (!e) return null;
      const rect = wrap.getBoundingClientRect();
      const frac = rect.width ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
      const coord = Math.round(eStart + frac * (eEnd - eStart));
      const segs = splitExonSegments(t, e);
      return { e, seg: segAtCoord(segs, coord), rank: Number(wrap.dataset.rank), of: Number(wrap.dataset.of) };
    }

    body.querySelectorAll('.tx-row .tx-mini .exon-wrap').forEach((wrap) => {
      wrap.addEventListener('mousemove', (ev) => {
        const hit = locateSeg(wrap, ev.clientX);
        if (!hit) return;
        wrap.dataset.tip = segTipText(hit.e, hit.seg, hit.rank, hit.of);
        if (window.PervTip) window.PervTip.refresh();
      });
      wrap.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const row = wrap.closest('.tx-row');
        if (!row) return;
        state.selectedTxId = row.dataset.tx;
        state.selectedExonRange = {
          start: Number(wrap.dataset.start),
          end: Number(wrap.dataset.end),
        };
        state.viewMode = 'transcript';
        renderGeneDetail(pack);
      });
    });
    const ftw = body.querySelector('.ftable-wrap');
    if (ftw) ftw.addEventListener('toggle', () => { state.showFeatureTable = ftw.open; });

    const backBtn = document.getElementById('d-back-gene');
    if (backBtn) backBtn.addEventListener('click', () => {
      state.viewMode = 'gene';
      state.selectedExonRange = null;
      renderGeneDetail(pack);
    });
    const zoomTxBtn = document.getElementById('d-zoom-tx');
    if (zoomTxBtn && selTx) zoomTxBtn.addEventListener('click', () => {
      const pad = Math.max(200, Math.round((selTx.end - selTx.start) * 0.1));
      gotoLocus(g.chrom, Math.max(1, selTx.start - pad), selTx.end + pad);
    });
    const zb = document.getElementById('d-zoom-gene');
    if (zb) zb.addEventListener('click', () => {
      const pad = Math.max(200, Math.round((g.end - g.start) * 0.1));
      gotoLocus(g.chrom, Math.max(1, g.start - pad), g.end + pad);
    });
    const eb = document.getElementById('d-export-gtf');
    if (eb) eb.addEventListener('click', () => {
      const url = isTxView
        ? `/api/genome/region/gtf?transcript_id=${encodeURIComponent(selTx.transcript_id)}`
        : `/api/genome/region/gtf?gene_id=${encodeURIComponent(g.gene_id)}`;
      window.open(url, '_blank');
    });

    showDnaFoot();
  }

  // Header shown when viewMode === 'gene'.
  function renderGeneHeader(g, txs) {
    return `
      <div class="gene-summary">
        <div class="badge-row">
          <span class="kind-badge kind-gene">${esc(I18n.t('gn.detail.kind.gene'))}</span>
        </div>
        <div class="name">
          ${esc(g.gene_name || g.gene_id)}
        </div>
        <div class="type-row">
          <span class="pill">${esc(g.gene_biotype || 'gene')}</span>
          <span class="pill" style="background:rgba(245,158,11,.15);color:#b45309;">${esc(g.strand)}</span>
        </div>
        <div class="gid">${esc(g.gene_id)}</div>
        <div class="meta">
          <span>${I18n.t('gn.detail.location')}: <b>${esc(g.chrom)}:${fmtInt(g.start)}-${fmtInt(g.end)}</b></span>
          <span>${I18n.t('gn.detail.gene_len')}: <b>${fmtBp(g.length)}</b></span>
          <span>${I18n.t('gn.detail.tx_count')}: <b>${txs.length}</b></span>
          <span>${I18n.t('gn.detail.protein_tx')}: <b>${txs.filter(t => t.transcript_biotype === 'protein_coding').length}</b></span>
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn small" id="d-zoom-gene">${esc(I18n.t('gn.detail.zoom_gene'))}</button>
          <button class="btn small ghost" id="d-export-gtf">${esc(I18n.t('gn.tool.export.gtf'))}</button>
        </div>
      </div>`;
  }

  // Header shown when viewMode === 'transcript' (after clicking a tx-row
  // or an isoform in the IGV transcripts track). Switches the focus from
  // "the gene" to "this specific isoform".
  function renderTxHeader(g, t) {
    const txLen = t.length || 0;
    const cdsLen = t.cds_length || 0;
    const txEnd = (t.end != null ? t.end : g.end);
    const txStart = (t.start != null ? t.start : g.start);
    const span = Math.max(1, txEnd - txStart + 1);
    const biotype = t.transcript_biotype || 'transcript';
    return `
      <div class="gene-summary tx-summary">
        <div class="badge-row">
          <span class="kind-badge kind-tx">${esc(I18n.t('gn.detail.kind.tx'))}</span>
          <button class="btn small ghost back" id="d-back-gene" type="button" data-i18n-tip="gn.detail.back_gene_tip">
            ← ${esc(I18n.t('gn.detail.back_gene'))} <b>${esc(g.gene_name || g.gene_id)}</b>
          </button>
        </div>
        <div class="name">
          ${esc(t.transcript_id)}
        </div>
        <div class="type-row">
          <span class="pill ${esc(biotypeClass(biotype))}">${esc(biotype)}</span>
          <span class="pill" style="background:rgba(245,158,11,.15);color:#b45309;">${esc(t.strand || g.strand)}</span>
        </div>
        <div class="gid">${esc(I18n.t('gn.detail.parent_gene'))}: <b>${esc(g.gene_name || g.gene_id)}</b> · ${esc(g.gene_id)}</div>
        <div class="meta">
          <span>${I18n.t('gn.detail.location')}: <b>${esc(g.chrom)}:${fmtInt(txStart)}-${fmtInt(txEnd)}</b></span>
          <span>${I18n.t('gn.detail.tx_span')}: <b>${fmtBp(span)}</b></span>
          <span>${I18n.t('gn.detail.exon_count')}: <b>${t.exon_count || 0}</b></span>
          <span>${I18n.t('gn.detail.tx_len')}: <b>${fmtInt(txLen)} bp</b></span>
          ${cdsLen ? `<span>${I18n.t('gn.detail.cds_len')}: <b>${fmtInt(cdsLen)} bp</b></span>` : ''}
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn small" id="d-zoom-tx">${esc(I18n.t('gn.detail.zoom_tx'))}</button>
          <button class="btn small ghost" id="d-export-gtf" data-i18n-tip="gn.detail.export_gtf_tx_tip">${esc(I18n.t('gn.tool.export.gtf'))}</button>
        </div>
      </div>`;
  }

  // Split a single exon into UTR / CDS sub-segments using the transcript's
  // real cds/utrs coordinates (instead of just checking whether the exon
  // as a whole overlaps the CDS envelope). This keeps the mini-map
  // consistent with the GTF feature breakdown table above it: an exon
  // that mixes UTR and CDS (very common on the first/last coding exon)
  // is drawn with both colors in their true proportions, not painted
  // entirely as CDS.
  function splitExonSegments(t, e) {
    if (!t.cds || !t.cds.length) {
      // Non-coding transcript (or exon with no CDS at all): render as a
      // single neutral "exonic" block, distinct from real UTR so it's
      // not mistaken for the UTR of a protein-coding transcript.
      return [{ start: e.start, end: e.end, kind: 'noncoding' }];
    }
    // Overall CDS envelope, used below to classify UTR gaps (and any
    // UTR pieces missing an explicit type) as 5' or 3' by their position
    // relative to translation start/end, honoring strand.
    const cdsLo = Math.min(...t.cds.map((c) => c.start));
    const cdsHi = Math.max(...t.cds.map((c) => c.end));
    const utrKind = (start, end) => {
      const before = end < cdsLo;
      const after = start > cdsHi;
      if (t.strand === '-') return before ? 'three_prime_utr' : after ? 'five_prime_utr' : 'utr';
      return before ? 'five_prime_utr' : after ? 'three_prime_utr' : 'utr';
    };
    const pieces = [];
    (t.cds || []).forEach((c) => {
      if (c.end >= e.start && c.start <= e.end) {
        pieces.push({ start: Math.max(c.start, e.start), end: Math.min(c.end, e.end), kind: 'cds' });
      }
    });
    (t.utrs || []).forEach((u) => {
      if (u.end >= e.start && u.start <= e.end) {
        const start = Math.max(u.start, e.start);
        const end = Math.min(u.end, e.end);
        pieces.push({ start, end, kind: 'utr', utrType: u.type || utrKind(start, end) });
      }
    });
    pieces.sort((a, b) => a.start - b.start);
    if (!pieces.length) return [{ start: e.start, end: e.end, kind: 'utr', utrType: utrKind(e.start, e.end) }];
    // Fill any uncovered gaps (data-quality fallback, e.g. missing UTR
    // records) as UTR so the exon stays fully covered visually.
    const filled = [];
    let cursor = e.start;
    pieces.forEach((p) => {
      if (p.start > cursor) filled.push({ start: cursor, end: p.start - 1, kind: 'utr', utrType: utrKind(cursor, p.start - 1) });
      filled.push(p);
      cursor = Math.max(cursor, p.end + 1);
    });
    if (cursor <= e.end) filled.push({ start: cursor, end: e.end, kind: 'utr', utrType: utrKind(cursor, e.end) });
    return filled;
  }

  // Tooltip text for a single UTR/CDS segment within an exon (shared by the
  // initial render and the mousemove-driven coordinate lookup below).
  function segTipText(e, s, rank, total) {
    const kindLabel = s.kind === 'cds' ? 'CDS'
      : s.utrType === 'five_prime_utr' ? "5' UTR"
      : s.utrType === 'three_prime_utr' ? "3' UTR"
      : s.kind === 'utr' ? 'UTR' : 'exon';
    return `${kindLabel} ${s.start}-${s.end} (${fmtInt(s.end - s.start + 1)} bp) · exon ${rank}/${total} (${e.start}-${e.end})`;
  }

  // segs fully tile [e.start, e.end], so any in-range coordinate lands in
  // exactly one of them; the clamp is just a defensive fallback.
  function segAtCoord(segs, coord) {
    return segs.find((s) => coord >= s.start && coord <= s.end)
      || (coord < segs[0].start ? segs[0] : segs[segs.length - 1]);
  }

  function renderTxRow(t, lo, span, activeTxId) {
    const active = t.transcript_id === activeTxId;
    // selected exon coords
    const sel = state.selectedExonRange;
    // Stable exon rank (1-based, in transcription order) for tooltips,
    // matching the numbering used in the GTF feature-breakdown table.
    const orderedExons = t.strand === '-'
      ? t.exons.slice().sort((a, b) => b.end - a.end)
      : t.exons.slice().sort((a, b) => a.start - b.start);
    // Each exon gets one "hit box" sized to its own (much larger) footprint,
    // so clicking/hovering no longer requires pixel-precise aim at a tiny
    // CDS/UTR sliver - the actual sub-segment under the cursor is resolved
    // by mapping clientX back to a genomic coordinate (see wiring below).
    // The colored .seg divs inside are purely visual and ignore pointer
    // events.
    const blocks = t.exons.map((e) => {
      const isSelected = active && sel && e.start === sel.start && e.end === sel.end;
      const rank = orderedExons.findIndex((x) => x.start === e.start && x.end === e.end) + 1;
      const segs = splitExonSegments(t, e);
      const exonSpan = Math.max(1, e.end - e.start + 1);
      const left = ((e.start - lo) / span) * 100;
      const width = Math.max(0.35, (exonSpan / span) * 100);
      const segMarkup = segs.map((s) => {
        const segLeft = ((s.start - e.start) / exonSpan) * 100;
        const segWidth = Math.max(0, ((s.end - s.start + 1) / exonSpan) * 100);
        return `<div class="seg ${s.kind}" style="left:${segLeft.toFixed(3)}%;width:${segWidth.toFixed(3)}%;"></div>`;
      }).join('');
      const initialTip = esc(segTipText(e, segs[Math.floor(segs.length / 2)], rank, orderedExons.length));
      return `<div class="exon-wrap${isSelected ? ' selected' : ''}"
                  data-start="${e.start}" data-end="${e.end}" data-rank="${rank}" data-of="${orderedExons.length}"
                  style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;"
                  data-tip="${initialTip}">${segMarkup}</div>`;
    }).join('');

    // start_codon / stop_codon markers (small triangles on the mini-map)
    const codonMarks = []
      .concat((t.start_codons || []).map((c) => ({ ...c, kind: 'start' })))
      .concat((t.stop_codons || []).map((c) => ({ ...c, kind: 'stop' })))
      .map((c) => {
        const left = ((c.start - lo) / span) * 100;
        const cls = c.kind === 'start' ? 'codon-mark start' : 'codon-mark stop';
        const tip = `${c.kind === 'start' ? 'start_codon' : 'stop_codon'} ${c.start}-${c.end}`;
        return `<div class="${cls}" style="left:${left.toFixed(3)}%;" data-tip="${esc(tip)}"></div>`;
      })
      .join('');

    const biotype = t.transcript_biotype || 'transcript';
    const cdsStat = t.cds_length
      ? `<span><b>${fmtInt(t.cds_length)}</b> ${esc(I18n.t('gn.detail.stat.cds_bp'))}</span>`
      : '<span>—</span>';
    return `
      <div class="tx-row ${active ? 'active' : ''}" data-tx="${esc(t.transcript_id)}">
        <div class="tx-head">
          <span class="tx-id">${esc(t.transcript_id)}</span>
          <span class="tx-biotype ${esc(biotypeClass(biotype))}">${esc(biotype)}</span>
        </div>
        <div class="tx-stats">
          <span><b>${t.exon_count}</b> ${esc(I18n.t('gn.detail.stat.exons'))}</span>
          <span><b>${fmtInt(t.length)}</b> ${esc(I18n.t('gn.detail.stat.transcript_bp'))}</span>
          ${cdsStat}
          <span>${esc(t.strand)}</span>
        </div>
        <div class="tx-mini" data-tip="exon structure on shared gene scale">
          <div class="intron"></div>
          ${blocks}
          ${codonMarks}
        </div>
      </div>`;
  }

  // Render the GTF column-3 feature breakdown table for the selected
  // transcript: each row is a single (type, start-end, length) entry.
  function renderFeatureBreakdown(t, chrom) {
    const items = [];
    items.push({ type: 'transcript', start: t.start, end: t.end });
    (t.exons || []).forEach((e, i) => {
      const ordered = t.strand === '-'
        ? t.exons.slice().sort((a, b) => b.end - a.end)
        : t.exons.slice().sort((a, b) => a.start - b.start);
      const idx = ordered.findIndex((x) => x.start === e.start && x.end === e.end);
      items.push({ type: 'exon', start: e.start, end: e.end, rank: idx + 1, of: ordered.length });
    });
    (t.utrs || []).forEach((u) => items.push({ type: u.type, start: u.start, end: u.end }));
    (t.cds || []).forEach((c) => items.push({ type: 'CDS', start: c.start, end: c.end, phase: c.phase }));
    (t.start_codons || []).forEach((c) => items.push({ type: 'start_codon', start: c.start, end: c.end }));
    (t.stop_codons || []).forEach((c) => items.push({ type: 'stop_codon', start: c.start, end: c.end }));
    items.sort((a, b) => a.start - b.start || a.end - b.end);

    const colorOf = FEATURE_COLORS;
    const labelOf = (it) => {
      if (it.type === 'exon' && it.rank) return `exon ${it.rank}/${it.of}`;
      if (it.type === 'five_prime_utr') return "5' UTR";
      if (it.type === 'three_prime_utr') return "3' UTR";
      return it.type;
    };

    const rows = items.map((it) => {
      const len = it.end - it.start + 1;
      const color = colorOf[it.type] || '#94a3b8';
      return `<tr>
        <td><span class="ftype-pill" style="--c:${color}">${esc(labelOf(it))}</span></td>
        <td class="mono">${esc(chrom)}:${fmtInt(it.start)}-${fmtInt(it.end)}</td>
        <td class="mono">${fmtInt(len)} bp</td>
      </tr>`;
    }).join('');

    return `
      <details class="ftable-wrap" ${state.showFeatureTable ? 'open' : ''}>
        <summary>${esc(I18n.t('gn.detail.features'))} <span class="muted">(${items.length})</span></summary>
        <div class="ftable-scroll">
          <table class="ftable">
            <colgroup>
              <col class="ftype-col"><col class="frange-col"><col class="flen-col">
            </colgroup>
            <thead><tr>
              <th>${esc(I18n.t('gn.detail.ftype'))}</th>
              <th>${esc(I18n.t('gn.detail.frange'))}</th>
              <th>${esc(I18n.t('gn.detail.flen'))}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </details>`;
  }

  function renderRawMap(map) {
    const body = document.getElementById('g-detail-body');
    if (!map || !Object.keys(map).length) { clearDetail(); return; }
    const order = ['name', 'type', 'gene_name', 'gene_id', 'transcript_id', 'biotype', 'gene_biotype', 'start', 'end', 'strand', 'length'];
    const seen = new Set();
    const rows = [];
    for (const k of order) {
      if (map[k] != null && !seen.has(k)) {
        rows.push(`<div style="margin:4px 0;"><b>${esc(k)}</b>: ${esc(String(map[k]))}</div>`);
        seen.add(k);
      }
    }
    for (const k of Object.keys(map)) {
      if (!seen.has(k) && map[k] != null) {
        rows.push(`<div style="margin:4px 0;"><b>${esc(k)}</b>: ${esc(String(map[k]))}</div>`);
      }
    }
    body.innerHTML = `<div class="gene-summary"><div class="name">${esc(map.name || 'Feature')}</div></div>` + rows.join('');
  }

  // ---------------------------------------------------------------------
  // DNA viewer (current region in the IGV viewport)
  // ---------------------------------------------------------------------
  let _dnaBound = false;
  let _dnaDebounceTimer = null;
  let _dnaAbortCtrl = null;

  function loadDnaFootSequence() {
    clearTimeout(_dnaDebounceTimer);
    _dnaDebounceTimer = setTimeout(() => _doLoadDnaFootSequence(), 300);
  }

  async function _doLoadDnaFootSequence() {
    const wrap = document.getElementById('g-dna-wrap');
    const det = wrap && wrap.querySelector('details');
    const target = document.getElementById('g-dna');
    if (!wrap || wrap.style.display === 'none' || !det || !det.open || !target || !state.chrom) return;

    const span = state.end - state.start + 1;
    if (span > 100000) {
      target.textContent = 'Region > 100 kb. Zoom in or use the DNA export button.';
      return;
    }
    if (_dnaAbortCtrl) _dnaAbortCtrl.abort();
    _dnaAbortCtrl = new AbortController();
    target.textContent = 'Loading ...';
    try {
      const r = await fetch(
        `/api/genome/sequence?chrom=${encodeURIComponent(state.chrom)}&start=${state.start}&end=${state.end}`,
        { signal: _dnaAbortCtrl.signal }
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        target.textContent = 'Error: ' + (e.error || r.status);
        return;
      }
      const d = await r.json();
      const wrapped = (window.SeqUtils && SeqUtils.fastaWrap) ? SeqUtils.fastaWrap(d.sequence, 60) : d.sequence;
      target.textContent = `>${d.chrom}:${d.start}-${d.end}\n` + wrapped;
    } catch (e) {
      if (e.name === 'AbortError') return;
      target.textContent = 'Error: ' + (e.message || e);
    }
  }

  function bindDnaFoot() {
    if (_dnaBound) return;
    const wrap = document.getElementById('g-dna-wrap');
    const det = wrap && wrap.querySelector('details');
    if (!det) return;
    det.addEventListener('toggle', () => {
      if (det.open) loadDnaFootSequence();
    });
    _dnaBound = true;
  }

  function showDnaFoot() {
    const wrap = document.getElementById('g-dna-wrap');
    if (!wrap) return;
    wrap.style.display = '';
    bindDnaFoot();
    const det = wrap.querySelector('details');
    if (det && det.open) loadDnaFootSequence();
  }

  // ---------------------------------------------------------------------
  // exports + toolbar
  // ---------------------------------------------------------------------
  async function exportDna() {
    const url = `/api/genome/region/dna?chrom=${encodeURIComponent(state.chrom)}&start=${state.start}&end=${state.end}`;
    window.open(url, '_blank');
  }
  async function exportGtf() {
    const url = `/api/genome/region/gtf?chrom=${encodeURIComponent(state.chrom)}&start=${state.start}&end=${state.end}`;
    window.open(url, '_blank');
  }

  function findAnnotationTrack() {
    if (!browser) return null;
    const tvs = browser.trackViews || [];
    for (const tv of tvs) {
      const t = tv && tv.track;
      if (!t) continue;
      if (t.id === 'ensembl-transcripts' || t.name === 'Transcripts') return t;
    }
    return null;
  }

  function findGeneTrack() {
    if (!browser) return null;
    const tvs = browser.trackViews || [];
    for (const tv of tvs) {
      const t = tv && tv.track;
      if (!t) continue;
      if (t.id === 'ensembl-genes' || t.name === 'Genes') return t;
    }
    return null;
  }

  // Height per gene display mode (px)
  const GENE_MODE_HEIGHT = { EXPANDED: 80, SQUISHED: 50, COLLAPSED: 24 };

  async function setDisplayMode(mode) {
    if (!['EXPANDED', 'SQUISHED', 'COLLAPSED'].includes(mode)) return;
    state.displayMode = mode;
    document.querySelectorAll('#g-displaymode button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    const tr = findAnnotationTrack();
    if (!tr) return;
    const target = MODE_HEIGHT[mode] || 320;
    try {
      tr.displayMode = mode;
      tr.height = target;
      if (tr.trackView && typeof tr.trackView.setTrackHeight === 'function') {
        tr.trackView.setTrackHeight(target);
      }
      if (typeof tr.repaintViews === 'function') {
        tr.repaintViews();
      } else if (tr.trackView && typeof tr.trackView.repaintViews === 'function') {
        tr.trackView.repaintViews();
      }
    } catch (e) {
      console.warn('[genome] setDisplayMode failed', e);
    }
  }

  async function setGeneDisplayMode(mode) {
    if (!['EXPANDED', 'SQUISHED', 'COLLAPSED'].includes(mode)) return;
    state.geneDisplayMode = mode;
    document.querySelectorAll('#g-gene-displaymode button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    const tr = findGeneTrack();
    if (!tr) return;
    const target = GENE_MODE_HEIGHT[mode] || 50;
    try {
      tr.displayMode = mode;
      tr.height = target;
      if (tr.trackView && typeof tr.trackView.setTrackHeight === 'function') {
        tr.trackView.setTrackHeight(target);
      }
      if (typeof tr.repaintViews === 'function') {
        tr.repaintViews();
      } else if (tr.trackView && typeof tr.trackView.repaintViews === 'function') {
        tr.trackView.repaintViews();
      }
    } catch (e) {
      console.warn('[genome] setGeneDisplayMode failed', e);
    }
  }

  function bindToolbar() {
    async function goToRegion() {
      const s = parseInt(document.getElementById('g-start').value, 10);
      const e = parseInt(document.getElementById('g-end').value, 10);
      if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
        await gotoLocus(state.chrom, s, e);
      }
    }

    document.getElementById('g-go').addEventListener('click', goToRegion);
    ['g-start', 'g-end'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          goToRegion();
        }
      });
      el.addEventListener('dblclick', () => el.select());
    });
    document.getElementById('g-export-dna').addEventListener('click', exportDna);
    document.getElementById('g-export-gtf').addEventListener('click', exportGtf);

    // ── Reset built-in tracks ────────────────────────────────────────────────
    const resetTracksBtn = document.getElementById('g-reset-tracks');
    if (resetTracksBtn) {
      resetTracksBtn.addEventListener('click', async () => {
        if (!browser) return;

        // Canonical definitions of all built-in tracks (mirrors createBrowser config)
        const BUILTIN_TRACKS = [
          {
            id: 'ensembl-genes',
            name: 'Genes',
            type: 'annotation', format: 'bed',
            url: '/genome/data/genome.genes.bed',
            indexed: false, height: 80, displayMode: state.geneDisplayMode || 'COLLAPSED',
            expandedRowHeight: 28, squishedRowHeight: 14, fontSize: 10,
            color: '#555555', altColor: '#555555', visibilityWindow: -1,
          },
          {
            id: 'ensembl-transcripts',
            name: 'Transcripts',
            type: 'annotation', format: 'bed',
            url: '/genome/data/genome.bed',
            indexed: false, height: 150, displayMode: state.displayMode || 'EXPANDED',
            expandedRowHeight: 28, squishedRowHeight: 14, maxRows: 500, fontSize: 10,
            color: '#a07800', altColor: '#a07800', visibilityWindow: -1,
          },
          {
            id: 'perv-sequences',
            name: 'PERV',
            type: 'annotation', format: 'bed',
            url: '/genome/data/perv.bed',
            indexed: false, height: 50, displayMode: 'EXPANDED',
            expandedRowHeight: 22, color: '#e05c2b', altColor: '#e05c2b', visibilityWindow: -1,
          },
          {
            id: 'homologous-sequences',
            name: 'Homologous Seq',
            type: 'annotation', format: 'bed',
            url: '/genome/data/homologous_seq.bed',
            indexed: false, height: 100, displayMode: 'EXPANDED',
            expandedRowHeight: 28, squishedRowHeight: 14, fontSize: 10,
            color: '#4a90e2', altColor: '#4a90e2', visibilityWindow: 300000000,
          },
          {
            id: 'homologous-loci',
            name: 'Homologous Loci',
            type: 'annotation', format: 'bed',
            url: '/genome/data/homologous_locus.bed',
            indexed: false, height: 50, displayMode: 'EXPANDED',
            expandedRowHeight: 28, squishedRowHeight: 14, fontSize: 10,
            color: '#9b59b6', altColor: '#9b59b6', visibilityWindow: 300000000,
          },
        ];

        // Detect which built-in tracks are currently missing
        const existingIds = new Set(
          (browser.trackViews || [])
            .map(tv => tv && tv.track && (tv.track.id || tv.track.name))
            .filter(Boolean)
        );
        const existingNames = new Set(
          (browser.trackViews || [])
            .map(tv => tv && tv.track && tv.track.name)
            .filter(Boolean)
        );

        const missing = BUILTIN_TRACKS.filter(
          t => !existingIds.has(t.id) && !existingNames.has(t.name)
        );

        if (missing.length === 0) {
          const msg = I18n.t('gn.tool.reset_tracks.none');
          resetTracksBtn.textContent = '✓ ' + msg;
          setTimeout(() => { resetTracksBtn.textContent = I18n.t('gn.tool.reset_tracks'); }, 2000);
          return;
        }

        resetTracksBtn.disabled = true;
        resetTracksBtn.textContent = '…';
        try {
          for (const trackDef of missing) {
            const order = BUILTIN_TRACK_ORDER[trackDef.id];
            const payload = order != null ? { ...trackDef, order } : trackDef;
            await browser.loadTrack(payload);
          }
          syncBuiltinTrackOrders();
          try { suppressFrozenSpinners(); } catch (_) {}
          if (window.__pervMultiomics && window.__pervMultiomics.syncMoTrackOrder) {
            window.__pervMultiomics.syncMoTrackOrder();
          }
          resetTracksBtn.textContent = '✓ ' + I18n.t('gn.tool.reset_tracks.done');
        } catch (e) {
          console.error('[reset-tracks]', e);
          resetTracksBtn.textContent = I18n.t('gn.tool.reset_tracks');
        } finally {
          resetTracksBtn.disabled = false;
          setTimeout(() => { resetTracksBtn.textContent = I18n.t('gn.tool.reset_tracks'); }, 2500);
        }
      });
    }
    const clearBtn = document.getElementById('g-detail-clear');
    if (clearBtn) clearBtn.addEventListener('click', clearDetail);
    document.querySelectorAll('#g-displaymode button').forEach((btn) => {
      btn.addEventListener('click', () => setDisplayMode(btn.dataset.mode));
    });
    document.querySelectorAll('#g-gene-displaymode button').forEach((btn) => {
      btn.addEventListener('click', () => setGeneDisplayMode(btn.dataset.mode));
    });
    const colorTrack = document.getElementById('g-color-track');
    const colorPlus = document.getElementById('g-color-plus');
    const colorMinus = document.getElementById('g-color-minus');
    const colorLink = document.getElementById('g-color-link');
    const colorReset = document.getElementById('g-color-reset');
    if (colorTrack && colorPlus && colorMinus && colorLink) {
      colorTrack.addEventListener('change', () => syncColorControlsFromTrack());
      colorLink.addEventListener('change', () => applyStrandColors());
      colorPlus.addEventListener('input', () => applyStrandColors());
      colorMinus.addEventListener('input', () => applyStrandColors());
    }
    if (colorReset) colorReset.addEventListener('click', () => resetStrandColor());
  }

  // ---------------------------------------------------------------------------
  // PERV panel
  // ---------------------------------------------------------------------------
  let _pervDataMap = null;  // Map<name, seqObj> — loaded once
  let _lastSelectedPervEl = null;

  // ---------------------------------------------------------------------------
  // Homologous panel caches
  // ---------------------------------------------------------------------------
  let _homoSeqMap = null;    // Map<q_name, seqObj>
  let _homoLocusMap = null;  // Map<locus_id, locusObj>
  let _homoAllSeqs = null;   // full 876-item array
  let _homoAllLoci = null;   // full loci array
  let _genomeInfo = {};      // Map abbr → {full_name, assembly}
  let _lastSelectedSeqEl = null;
  let _lastSelectedLocusEl = null;

  const DOMAIN_COLORS = {
    GAG: '#7c3aed', AP: '#a16207', RT: '#0369a1',
    RNaseH: '#047857', INT: '#b45309', ENV: '#be123c',
  };
  const ORF_COLORS = {
    LTR: '#64748b', GAG: '#7c3aed', POL: '#0369a1', ENV: '#be123c',
  };

  function _fmtCoord(n) {
    // Use 'en-US' explicitly to avoid locale-dependent spacing (e.g. "2, 389, 980" in zh-CN)
    return Number(n).toLocaleString('en-US');
  }

  async function initPervPanel() {
    const toggle = document.getElementById('perv-panel-toggle');
    const body = document.getElementById('perv-panel-body');
    const loadingEl = document.getElementById('perv-loading');
    const arrowEl = document.getElementById('perv-arrow');
    const badge = document.getElementById('perv-count-badge');
    if (!toggle || !body) return;

    let expanded = false;

    // Fetch data once
    let seqs = [];
    try {
      const r = await fetch('/api/genome/perv/list');
      if (r.ok) {
        const d = await r.json();
        seqs = d.sequences || [];
      }
    } catch (e) {
      console.warn('[perv] fetch failed:', e);
    }

    // Build lookup map
    _pervDataMap = new Map(seqs.map((s) => [s.name, s]));
    if (badge) badge.textContent = seqs.length;

    // Render list
    function renderList() {
      _lastSelectedPervEl = null;
      if (!seqs.length) {
        body.innerHTML = '<div class="perv-empty">No data</div>';
        return;
      }
      body.innerHTML = seqs.map((s) => {
        const hasDomain = s.domains && s.domains.length > 0;
        const hasOrf = s.orfs && s.orfs.length > 0;
        const strandBadge = s.strand === '+'
          ? '<span class="perv-strand perv-strand-plus">+</span>'
          : '<span class="perv-strand perv-strand-minus">−</span>';
        const annBadges = [
          hasDomain ? '<span class="perv-ann-badge perv-ann-domain">Domain</span>' : '',
          hasOrf ? '<span class="perv-ann-badge perv-ann-orf">ORF</span>' : '',
        ].join('');
        return `<div class="perv-seq-item" data-name="${esc(s.name)}">
          <span class="perv-seq-name">${esc(s.name)}</span>
          ${strandBadge}
          <span class="perv-seq-loc">${esc(s.chrom)}:${_fmtCoord(s.start)}‑${_fmtCoord(s.end)}</span>
          <span class="perv-seq-badges">${annBadges}</span>
        </div>`;
      }).join('');
      let _pervNavToken = null;
      body.querySelectorAll('.perv-seq-item').forEach((el) => {
        el.addEventListener('click', () => {
          const name = el.dataset.name;
          const seq = _pervDataMap.get(name);
          if (!seq) return;
          if (_pervNavToken) _pervNavToken.cancelled = true;
          const token = { cancelled: false };
          _pervNavToken = token;
          if (_lastSelectedPervEl) _lastSelectedPervEl.classList.remove('selected');
          el.classList.add('selected');
          _lastSelectedPervEl = el;
          showPervDetail(name);
          const pad = Math.max(500, Math.round((seq.end - seq.start + 1) * 0.1));
          const navStart = Math.max(1, seq.start - pad);
          const navEnd = seq.end + pad;
          gotoLocus(seq.chrom, navStart, navEnd)
            .catch((e) => { if (!token.cancelled) console.warn('[perv] nav failed', e); });
        });
      });
    }

    // Toggle open/close
    function openPanel() {
      expanded = true;
      body.style.display = 'block';
      body.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.querySelector('.perv-panel-icon').innerHTML = '&#9650;';
      if (arrowEl) arrowEl.innerHTML = '&#9650;';
      if (loadingEl && seqs.length) loadingEl.style.display = 'none';
      if (!body.querySelector('.perv-seq-item') && !body.querySelector('.perv-empty')) {
        renderList();
      }
    }

    function closePanel() {
      expanded = false;
      body.style.display = 'none';
      body.setAttribute('aria-hidden', 'true');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.querySelector('.perv-panel-icon').innerHTML = '&#9664;';
      if (arrowEl) arrowEl.innerHTML = '&#9660;';
    }

    toggle.addEventListener('click', () => { expanded ? closePanel() : openPanel(); });
    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expanded ? closePanel() : openPanel(); }
    });
  }

  function showPervDetail(name) {
    const seq = _pervDataMap && _pervDataMap.get(name);
    const body = document.getElementById('g-detail-body');
    if (!body) return;

    // Reset gene/transcript state so normal gene detail doesn't interfere
    state.selectedGeneId = null;
    state.selectedTxId = null;

    if (!seq) {
      body.innerHTML = `<div class="empty">${esc(name)}</div>`;
      return;
    }

    const strandSymbol = seq.strand === '+' ? '+' : '−';
    const len = seq.end - seq.start + 1;

    let domainHtml = '';
    if (seq.domains && seq.domains.length) {
      // d.start / d.end are 0-based BED coords; display as 1-based (start+1, end unchanged)
      const rows = seq.domains.map((d) => {
        const color = DOMAIN_COLORS[d.name] || '#475569';
        return `<tr>
          <td><span class="perv-feat-dot" style="background:${color}"></span>${esc(d.name)}</td>
          <td class="mono">${_fmtCoord(d.start + 1)}</td>
          <td class="mono">${_fmtCoord(d.end)}</td>
          <td class="mono">${_fmtCoord(d.length)} bp</td>
        </tr>`;
      }).join('');
      domainHtml = `
        <table class="perv-annot-table">
          <thead><tr><th>Domain</th><th>Start (1-based)</th><th>End</th><th>Length</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    let orfHtml = '';
    if (seq.orfs && seq.orfs.length) {
      // o.start / o.end are 0-based BED coords; display as 1-based (start+1, end unchanged)
      const rows = seq.orfs.map((o) => {
        const color = ORF_COLORS[o.name] || '#475569';
        return `<tr>
          <td><span class="perv-feat-dot" style="background:${color}"></span>${esc(o.name)}</td>
          <td class="mono">${_fmtCoord(o.start + 1)}</td>
          <td class="mono">${_fmtCoord(o.end)}</td>
          <td class="mono">${_fmtCoord(o.length)} bp</td>
        </tr>`;
      }).join('');
      orfHtml = `
        <table class="perv-annot-table">
          <thead><tr><th>Feature</th><th>Start (1-based)</th><th>End</th><th>Length</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    const noAnnot = !domainHtml && !orfHtml
      ? `<div class="perv-no-annot">${esc(I18n.t('gn.detail.perv_no_annot'))}</div>`
      : '';

    // ERV type comes from the Excel annotation (erv_type field) injected by the backend.
    // Fall back to name-based detection if not available.
    const ervType = seq.erv_type || '';
    const pervNameType = /PERV[-_]?([ABC])/i.exec(seq.name)?.[1]
      ? 'PERV-' + /PERV[-_]?([ABC])/i.exec(seq.name)[1].toUpperCase()
      : '';

    body.innerHTML = `
      <div class="gene-summary perv-summary">
        <div class="badge-row">
          <span class="kind-badge kind-perv">PERV</span>
          ${ervType ? `<span class="pill perv-erv-type-pill" data-erv-type="${esc(ervType)}">${esc(ervType)}</span>` : ''}
          ${pervNameType ? `<span class="pill" style="background:rgba(99,102,241,.1);color:#4f46e5;font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;">${esc(pervNameType)}</span>` : ''}
        </div>
        <div class="name perv-name">
          ${esc(seq.name)}
          <span class="pill">${strandSymbol} strand</span>
        </div>
        <div class="gid">${esc(seq.chrom)}:${_fmtCoord(seq.start)}–${_fmtCoord(seq.end)}</div>
        <div class="meta">
          <span>${esc(I18n.t('gn.detail.perv_location'))}: <b>${esc(seq.chrom)}</b></span>
          <span>${esc(I18n.t('gn.detail.perv_len'))}: <b>${_fmtCoord(len)} bp</b></span>
          <span>Start (1-based): <b>${_fmtCoord(seq.start)}</b></span>
          <span>End: <b>${_fmtCoord(seq.end)}</b></span>
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn small" id="d-zoom-perv">${esc(I18n.t('gn.detail.zoom_perv'))}</button>
        </div>
      </div>
      ${domainHtml ? `<h4 class="section">${esc(I18n.t('gn.detail.perv_domains'))}</h4>${domainHtml}` : ''}
      ${orfHtml ? `<h4 class="section">${esc(I18n.t('gn.detail.perv_orfs'))}</h4>${orfHtml}` : ''}
      ${noAnnot}
    `;

    // bind zoom button
    const zoomPervBtn = document.getElementById('d-zoom-perv');
    if (zoomPervBtn) zoomPervBtn.addEventListener('click', () => {
      const pad = Math.max(500, Math.round(len * 0.1));
      gotoLocus(seq.chrom, Math.max(1, seq.start - pad), seq.end + pad);
    });

    // show the DNA footer too
    showDnaFoot();
  }

  // ---------------------------------------------------------------------------
  // Homologous drawer
  // ---------------------------------------------------------------------------

  function initHomologousDrawer() {
    const toggleBtn = document.getElementById('g-homologous-toggle');
    const mask      = document.getElementById('g-homo-mask');
    const drawer    = document.getElementById('g-homo-drawer');
    const closeBtn  = document.getElementById('g-homo-close');
    if (!toggleBtn || !mask || !drawer) return;

    let loaded = false;
    let loading = false;

    // ── open / close (same modal pattern as Tracks drawer) ─────────────────
    function openDrawer() {
      drawer.setAttribute('aria-hidden', 'false');
      drawer.classList.add('open');
      toggleBtn.classList.add('active');
      if (mask) { mask.classList.add('open'); mask.setAttribute('aria-hidden', 'false'); }
    }
    function closeDrawer() {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
      toggleBtn.classList.remove('active');
      if (mask) { mask.classList.remove('open'); mask.setAttribute('aria-hidden', 'true'); }
    }

    toggleBtn.addEventListener('click', () => {
      drawer.classList.contains('open') ? closeDrawer() : openDrawer();
    });
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (mask) mask.addEventListener('click', closeDrawer);

    // ── tab switching ─────────────────────────────────────────────────────
    const tabSeq   = document.getElementById('homo-tab-seq');
    const tabLocus = document.getElementById('homo-tab-locus');
    const seqView   = document.getElementById('homo-seq-view');
    const locusView = document.getElementById('homo-locus-view');

    function showTab(which) {
      const isSeq = (which === 'seq');
      tabSeq.classList.toggle('active', isSeq);
      tabLocus.classList.toggle('active', !isSeq);
      tabSeq.setAttribute('aria-selected', String(isSeq));
      tabLocus.setAttribute('aria-selected', String(!isSeq));
      if (seqView)   seqView.hidden   = !isSeq;
      if (locusView) locusView.hidden =  isSeq;
    }
    if (tabSeq)   tabSeq.addEventListener('click',   () => showTab('seq'));
    if (tabLocus) tabLocus.addEventListener('click', () => showTab('locus'));

    // ── data loading (called immediately on init; can be retried) ─────────
    async function loadHomologousData() {
      if (loading) return;
      loading = true;
      try {
        const [rs, rl, rg] = await Promise.all([
          fetch('/api/genome/homologous/list'),
          fetch('/api/genome/homologous/loci'),
          fetch('/api/genome/genome_info'),
        ]);
        if (!rs.ok || !rl.ok) throw new Error('fetch failed');
        const ds = await rs.json();
        const dl = await rl.json();
        _genomeInfo = rg.ok ? await rg.json() : {};
        _homoAllSeqs  = ds.sequences || [];
        _homoAllLoci  = dl.loci || [];
        _homoSeqMap   = new Map(_homoAllSeqs.map((s) => [s.q_name, s]));
        _homoLocusMap = new Map(_homoAllLoci.map((l) => [l.locus_id, l]));
        loaded = true;
        buildSeqFilters();
        renderSeqList();
        renderLocusList();
      } catch (e) {
        console.warn('[homo] load failed:', e);
        loading = false;  // allow retry on next open
        const seqList = document.getElementById('homo-seq-list');
        if (seqList) seqList.innerHTML = '<div class="homo-empty">Failed to load data. Please refresh.</div>';
      }
    }

    // Kick off background load immediately so IGV track clicks work even
    // before the user opens the drawer.
    loadHomologousData();

    // ── sequence filter UI ────────────────────────────────────────────────
    const selSpecies = document.getElementById('homo-filter-species');
    const selChr     = document.getElementById('homo-filter-chr');
    const selGroup   = document.getElementById('homo-filter-group');
    const selLocus   = document.getElementById('homo-filter-locus');
    const searchSeq  = document.getElementById('homo-seq-search');
    const seqCountEl = document.getElementById('homo-seq-count');

    function buildSeqFilters() {
      const species = [...new Set(_homoAllSeqs.map((s) => s.species))].sort();
      const chrs    = [...new Set(_homoAllSeqs.map((s) => s.chrom))].sort((a, b) => {
        const n = (s) => parseInt(s.replace('chr', '')) || (s.includes('X') ? 90 : s.includes('Y') ? 91 : 99);
        return n(a) - n(b);
      });
      const groups  = [...new Set(_homoAllSeqs.map((s) => s.group))].sort();
      const loci    = [...new Set(_homoAllSeqs.map((s) => s.locus_id))].sort((a, b) => {
        const n = (id) => parseInt(id.replace('locus_', '')) || 0;
        return n(a) - n(b);
      });

      function fillSelect(el, vals, allLabel) {
        if (!el) return;
        // Rebuild from scratch to avoid detached-option value-loss in some browsers
        el.innerHTML = '';
        const all = document.createElement('option');
        all.value = ''; all.textContent = allLabel || el.title || 'All';
        el.appendChild(all);
        vals.forEach((v) => {
          const o = document.createElement('option');
          o.value = v;
          // For the species select, append the full name if available
          if (el === selSpecies && _genomeInfo[v]) {
            const info = _genomeInfo[v];
            const label = info.full_name && info.full_name !== v
              ? `${v} — ${info.full_name}`
              : v;
            o.textContent = label;
          } else {
            o.textContent = v;
          }
          el.appendChild(o);
        });
        el.value = '';  // explicitly reset to "All"
        if (window.PervSelect) PervSelect.refresh(el);
      }
      fillSelect(selSpecies, species, I18n ? I18n.t('gn.homo.filter.all_species') : 'All Species');
      fillSelect(selChr,     chrs,    I18n ? I18n.t('gn.homo.filter.all_chr')     : 'All Chr');
      fillSelect(selGroup,   groups,  I18n ? I18n.t('gn.homo.filter.all_group')   : 'All Groups');
      fillSelect(selLocus,   loci,    I18n ? I18n.t('gn.homo.filter.all_locus')   : 'All Loci');
    }

    function getFilteredSeqs() {
      if (!_homoAllSeqs) return [];
      const sp  = selSpecies ? selSpecies.value : '';
      const chr = selChr     ? selChr.value     : '';
      const grp = selGroup   ? selGroup.value   : '';
      const loc = selLocus   ? selLocus.value   : '';
      const q   = searchSeq  ? searchSeq.value.trim().toLowerCase() : '';
      return _homoAllSeqs.filter((s) =>
        (!sp  || s.species  === sp)  &&
        (!chr || s.chrom    === chr) &&
        (!grp || s.group    === grp) &&
        (!loc || s.locus_id === loc) &&
        (!q   || s.q_name.toLowerCase().includes(q))
      );
    }

    function renderSeqList() {
      const seqList = document.getElementById('homo-seq-list');
      if (!seqList) return;
      _lastSelectedSeqEl = null;
      const filtered = getFilteredSeqs();
      if (seqCountEl) seqCountEl.textContent = `${filtered.length} / ${(_homoAllSeqs||[]).length}`;
      if (!filtered.length) {
        seqList.innerHTML = '<div class="homo-empty">No sequences match the filter.</div>';
        return;
      }
      seqList.innerHTML = filtered.map((s) => {
        const strandBadge = s.strand === '+'
          ? '<span class="homo-strand homo-strand-plus">+</span>'
          : '<span class="homo-strand homo-strand-minus">−</span>';
        const len = s.end - s.start + 1;
        const ervBadge = s.erv_type
          ? `<span class="homo-badge homo-badge-erv" data-erv-type="${esc(s.erv_type)}">${esc(s.erv_type)}</span>`
          : '';
        return `<div class="homo-seq-item" data-qname="${esc(s.q_name)}">
          <div class="homo-item-name">${esc(s.q_name)} ${strandBadge}</div>
          <div class="homo-item-meta">
            <span class="homo-badge homo-badge-species" data-tip="${esc((_genomeInfo[s.species] || {}).full_name || s.species)}${(_genomeInfo[s.species] || {}).assembly ? ' (' + (_genomeInfo[s.species] || {}).assembly + ')' : ''}">${esc(s.species)}</span>
            <span class="homo-badge homo-badge-chr">${esc(s.chrom)}</span>
            <span class="homo-badge homo-badge-group">${esc(s.group)}</span>
            ${ervBadge}
          </div>
          <div class="homo-item-loc">
            <span class="loc-locus">${esc(s.locus_id)}</span>
            <span class="loc-range">${_fmtCoord(s.start)} – ${_fmtCoord(s.end)}</span>
            <span style="color:#94a3b8;font-size:10px;">${_fmtCoord(len)} bp</span>
          </div>
        </div>`;
      }).join('');

      seqList.querySelectorAll('.homo-seq-item').forEach((el) => {
        el.addEventListener('click', () => {
          const seq = _homoSeqMap && _homoSeqMap.get(el.dataset.qname);
          if (!seq) return;
          if (_lastSelectedSeqEl) _lastSelectedSeqEl.classList.remove('selected');
          el.classList.add('selected');
          _lastSelectedSeqEl = el;
          _detailFromTab = 'seq';
          const pad = Math.max(500, Math.round((seq.end - seq.start + 1) * 0.1));
          gotoLocus(seq.chrom, Math.max(1, seq.start - pad), seq.end + pad)
            .catch((e) => console.warn('[homo] nav failed', e));
          showHomologousSeqDetail(seq);
        });
      });
    }

    function resetSeqFilters() {
      if (searchSeq) searchSeq.value = '';
      if (selSpecies) selSpecies.value = '';
      if (selChr) selChr.value = '';
      if (selGroup) selGroup.value = '';
      if (selLocus) selLocus.value = '';
      if (window.PervSelect) {
        [selSpecies, selChr, selGroup, selLocus].forEach((el) => PervSelect.refresh(el));
      }
      renderSeqList();
    }

    function resetLocusFilters() {
      if (searchLocus) searchLocus.value = '';
      renderLocusList();
    }

    if (selSpecies) selSpecies.addEventListener('change', renderSeqList);
    if (selChr)     selChr.addEventListener('change', renderSeqList);
    if (selGroup)   selGroup.addEventListener('change', renderSeqList);
    if (selLocus)   selLocus.addEventListener('change', renderSeqList);
    if (searchSeq)  searchSeq.addEventListener('input', renderSeqList);
    document.getElementById('homo-seq-reset')?.addEventListener('click', resetSeqFilters);

    // ── locus list ────────────────────────────────────────────────────────
    const searchLocus  = document.getElementById('homo-locus-search');
    const locusCountEl = document.getElementById('homo-locus-count');

    function renderLocusList() {
      const locusList = document.getElementById('homo-locus-list');
      if (!locusList || !_homoAllLoci) return;
      _lastSelectedLocusEl = null;
      const q = searchLocus ? searchLocus.value.trim().toLowerCase() : '';
      const filtered = q
        ? _homoAllLoci.filter((l) => l.locus_id.toLowerCase().includes(q))
        : _homoAllLoci;
      if (locusCountEl) locusCountEl.textContent = `${filtered.length} / ${_homoAllLoci.length}`;
      if (!filtered.length) {
        locusList.innerHTML = '<div class="homo-empty">No loci match the search.</div>';
        return;
      }
      locusList.innerHTML = filtered.map((l) => {
        const strandBadge = l.strand === '+'
          ? '<span class="homo-strand homo-strand-plus">+</span>'
          : '<span class="homo-strand homo-strand-minus">−</span>';
        const len = l.end - l.start + 1;
        return `<div class="homo-locus-item" data-lid="${esc(l.locus_id)}">
          <div class="homo-item-name">
            ${esc(l.locus_id)} ${strandBadge}
            <span class="homo-locus-count-badge">${l.count}</span>
          </div>
          <div class="homo-item-loc">
            <span class="loc-locus">${esc(l.chrom)}</span>
            <span class="loc-range">${_fmtCoord(l.start)} – ${_fmtCoord(l.end)}</span>
            <span style="color:#94a3b8;font-size:10px;">${_fmtCoord(len)} bp</span>
          </div>
        </div>`;
      }).join('');

      locusList.querySelectorAll('.homo-locus-item').forEach((el) => {
        el.addEventListener('click', () => {
          const locus = _homoLocusMap && _homoLocusMap.get(el.dataset.lid);
          if (!locus) return;
          if (_lastSelectedLocusEl) _lastSelectedLocusEl.classList.remove('selected');
          el.classList.add('selected');
          _lastSelectedLocusEl = el;
          _detailFromTab = 'locus';
          const pad = Math.max(1000, Math.round((locus.end - locus.start + 1) * 0.1));
          gotoLocus(locus.chrom, Math.max(1, locus.start - pad), locus.end + pad)
            .catch((e) => console.warn('[homo] nav failed', e));
          showHomologousLocusDetail(locus);
        });
      });
    }

    if (searchLocus) searchLocus.addEventListener('input', renderLocusList);
    document.getElementById('homo-locus-reset')?.addEventListener('click', resetLocusFilters);

    document.addEventListener('i18nchange', () => {
      if (!loaded) return;
      const saved = {
        species: selSpecies ? selSpecies.value : '',
        chr:     selChr     ? selChr.value     : '',
        group:   selGroup   ? selGroup.value   : '',
        locus:   selLocus   ? selLocus.value   : '',
      };
      buildSeqFilters();
      if (selSpecies) selSpecies.value = saved.species;
      if (selChr)     selChr.value     = saved.chr;
      if (selGroup)   selGroup.value   = saved.group;
      if (selLocus)   selLocus.value   = saved.locus;
      renderSeqList();
      renderLocusList();
    });

    // ── in-drawer detail panel ────────────────────────────────────────────────
    const detailView = document.getElementById('homo-detail-view');
    const detailBody = document.getElementById('homo-detail-body');
    const backBtn    = document.getElementById('homo-detail-back');

    // Track which list-view tab was active so Back button restores it
    let _detailFromTab = 'seq';

    function showDrawerDetail(html, fromTab, renderCharts) {
      _detailFromTab = fromTab || 'seq';
      // Dispose old ECharts instances
      if (window.echarts && detailBody) {
        detailBody.querySelectorAll('.homo-chart').forEach((el) => {
          const inst = window.echarts.getInstanceByDom(el);
          if (inst) inst.dispose();
        });
      }
      if (detailBody) detailBody.innerHTML = html;
      // Hide list views, show detail
      const sv = document.getElementById('homo-seq-view');
      const lv = document.getElementById('homo-locus-view');
      if (sv) sv.hidden = true;
      if (lv) lv.hidden = true;
      if (detailView) detailView.removeAttribute('hidden');
      // Open drawer if closed
      if (!drawer.classList.contains('open')) openDrawer();
      // Render charts after DOM paints
      if (typeof renderCharts === 'function') requestAnimationFrame(renderCharts);
    }

    function returnToList() {
      if (detailView) { detailView.setAttribute('hidden', ''); }
      const sv = document.getElementById('homo-seq-view');
      const lv = document.getElementById('homo-locus-view');
      if (_detailFromTab === 'locus') {
        if (sv) sv.hidden = true;
        if (lv) lv.hidden = false;
        showTab('locus');
      } else {
        if (sv) sv.hidden = false;
        if (lv) lv.hidden = true;
        showTab('seq');
      }
    }

    if (backBtn) backBtn.addEventListener('click', returnToList);
  }

  // ── Homologous detail renderers (used by drawer AND IGV-track clicks) ───────
  //   When the homo drawer is open, detail is shown inside it.
  //   When called from an IGV-track click (drawer may be closed), the drawer
  //   is opened first so the user sees the detail.

  function showHomologousSeqDetail(seq) {
    if (!seq) return;

    const drawer    = document.getElementById('g-homo-drawer');
    const detailView = document.getElementById('homo-detail-view');
    const detailBody = document.getElementById('homo-detail-body');

    // Prefer in-drawer detail panel when available
    if (drawer && detailBody) {
      const strandSymbol = seq.strand === '+' ? '+' : '−';
      const len = (seq.start != null && seq.end != null) ? seq.end - seq.start + 1 : '—';
      const html = `
        <div class="perv-detail-header">
          <div class="perv-detail-name">${esc(seq.q_name)}</div>
          <div class="perv-detail-badge" style="background:#4a90e2;">Homologous</div>
        </div>
        <div class="perv-detail-section">
          <div class="perv-detail-heading">Genomic Location</div>
          <table class="perv-region-table">
            <tr><td>Chromosome</td><td class="mono">${esc(seq.chrom)}</td></tr>
            <tr><td>Start (1-based)</td><td class="mono">${_fmtCoord(seq.start)}</td></tr>
            <tr><td>End</td><td class="mono">${_fmtCoord(seq.end)}</td></tr>
            <tr><td>Strand</td><td class="mono">${strandSymbol}</td></tr>
            <tr><td>Length</td><td class="mono">${typeof len === 'number' ? _fmtCoord(len) + ' bp' : len}</td></tr>
          </table>
        </div>
        <div class="perv-detail-section">
          <div class="perv-detail-heading">Metadata</div>
          <table class="perv-region-table">
            <tr><td>${esc(I18n.t('gn.homo.detail.breed'))}</td><td class="mono">${esc(seq.species)}${(_genomeInfo[seq.species] && _genomeInfo[seq.species].full_name && _genomeInfo[seq.species].full_name !== seq.species) ? `<br/><span style="color:#64748b;font-size:11px;">${esc(_genomeInfo[seq.species].full_name)}</span>` : ''}</td></tr>
            ${(_genomeInfo[seq.species] && _genomeInfo[seq.species].assembly) ? `<tr><td>${esc(I18n.t('gn.homo.detail.assembly'))}</td><td class="mono" style="font-size:11px;color:#64748b;">${esc(_genomeInfo[seq.species].assembly)}</td></tr>` : ''}
            <tr><td>Group</td><td class="mono">${esc(seq.group)}</td></tr>
            <tr><td>Locus ID</td><td class="mono">${esc(seq.locus_id)}</td></tr>
            <tr><td>Locus range</td><td class="mono">${esc(seq.chrom)}:${_fmtCoord(seq.locus_start)}–${_fmtCoord(seq.locus_end)}</td></tr>
          </table>
        </div>
      `;
      // Use showDrawerDetail if available (drawer already initialised), else inject directly
      const sv = document.getElementById('homo-seq-view');
      const lv = document.getElementById('homo-locus-view');
      if (window.echarts && detailBody) {
        detailBody.querySelectorAll('.homo-chart').forEach((el) => {
          const inst = window.echarts.getInstanceByDom(el);
          if (inst) inst.dispose();
        });
      }
      detailBody.innerHTML = html;
      if (sv) sv.hidden = true;
      if (lv) lv.hidden = true;
      if (detailView) { detailView.removeAttribute("hidden"); }
      if (!drawer.classList.contains('open')) {
        drawer.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        const tb = document.getElementById('g-homologous-toggle');
        if (tb) tb.classList.add('active');
        const mk = document.getElementById('g-homo-mask');
        if (mk) { mk.classList.add('open'); mk.setAttribute('aria-hidden', 'false'); }
      }
      return;
    }

    // Fallback: gene detail panel
    const body = document.getElementById('g-detail-body');
    if (!body) return;
    state.selectedGeneId = null;
    state.selectedTxId   = null;
    const strandSymbol = seq.strand === '+' ? '+' : '−';
    const len = (seq.start != null && seq.end != null) ? seq.end - seq.start + 1 : '—';
    body.innerHTML = `
      <div class="perv-detail-header">
        <div class="perv-detail-name">${esc(seq.q_name)}</div>
        <div class="perv-detail-badge" style="background:#4a90e2;">Homologous</div>
      </div>
      <div class="perv-detail-section">
        <div class="perv-detail-heading">Genomic Location</div>
        <table class="perv-region-table">
          <tr><td>Chromosome</td><td class="mono">${esc(seq.chrom)}</td></tr>
          <tr><td>Start</td><td class="mono">${_fmtCoord(seq.start)}</td></tr>
          <tr><td>End</td><td class="mono">${_fmtCoord(seq.end)}</td></tr>
          <tr><td>Strand</td><td class="mono">${strandSymbol}</td></tr>
          <tr><td>Length</td><td class="mono">${typeof len === 'number' ? _fmtCoord(len) + ' bp' : len}</td></tr>
        </table>
      </div>`;
  }

  function showHomologousLocusDetail(locus) {
    if (!locus) return;

    const drawer     = document.getElementById('g-homo-drawer');
    const detailView = document.getElementById('homo-detail-view');
    const detailBody = document.getElementById('homo-detail-body');

    const strandSymbol = locus.strand === '+' ? '+' : '−';
    const len = (locus.start != null && locus.end != null) ? locus.end - locus.start + 1 : '—';
    const groupDist   = locus.group_dist   || {};
    const speciesDist = locus.species_dist || {};
    const speciesCount = Object.keys(speciesDist).length;
    const barHeight = Math.max(160, speciesCount * 22 + 44);
    const pieId = `homo-pie-${locus.locus_id}-${Date.now()}`;
    const barId = `homo-bar-${locus.locus_id}-${Date.now()}`;

    const html = `
      <div class="perv-detail-header">
        <div class="perv-detail-name">${esc(locus.locus_id)}</div>
        <div class="perv-detail-badge" style="background:#9b59b6;">Locus</div>
      </div>
      <div class="perv-detail-section">
        <div class="perv-detail-heading">Genomic Location</div>
        <table class="perv-region-table">
          <tr><td>Chromosome</td><td class="mono">${esc(locus.chrom)}</td></tr>
          <tr><td>Start (1-based)</td><td class="mono">${_fmtCoord(locus.start)}</td></tr>
          <tr><td>End</td><td class="mono">${_fmtCoord(locus.end)}</td></tr>
          <tr><td>Strand</td><td class="mono">${strandSymbol}</td></tr>
          <tr><td>Length</td><td class="mono">${typeof len === 'number' ? _fmtCoord(len) + ' bp' : len}</td></tr>
          <tr><td>Sequences</td><td class="mono"><strong>${locus.count}</strong></td></tr>
        </table>
      </div>
      <div class="perv-detail-section">
        <div class="perv-detail-heading">Group Distribution</div>
        <div id="${pieId}" class="homo-chart homo-chart-pie"></div>
      </div>
      <div class="perv-detail-section">
        <div class="perv-detail-heading">${esc(I18n.t('gn.homo.chart.breed_dist'))}</div>
        <div id="${barId}" class="homo-chart" style="height:${barHeight}px;"></div>
      </div>
    `;

    function renderCharts() {
      const echarts = window.echarts;
      if (!echarts) return;
      const pieEl = document.getElementById(pieId);
      if (pieEl) {
        echarts.init(pieEl, null, { renderer: 'canvas' }).setOption({
          ...(window.ChartAnim && window.ChartAnim.BAR_ANIM),
          tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
          legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 } },
          series: [{
            type: 'pie',
            ...(window.ChartAnim && window.ChartAnim.PIE_SERIES),
            radius: ['35%', '65%'],
            center: ['50%', '45%'],
            label: { formatter: '{b}\n{d}%', fontSize: 11 },
            data: Object.entries(groupDist).map(([name, value]) => ({
              name,
              value,
              itemStyle: window.ChartAnim
                ? window.ChartAnim.withSliceBorder()
                : { borderColor: '#fff', borderWidth: 2 },
            })),
          }],
        });
      }
      const barEl = document.getElementById(barId);
      if (barEl) {
        const sorted = Object.entries(speciesDist).sort((a, b) => b[1] - a[1]);
        const yLabels = sorted.map((d) => {
          const info = _genomeInfo[d[0]];
          return info && info.full_name && info.full_name !== d[0]
            ? `${d[0]} (${info.full_name})`
            : d[0];
        }).reverse();
        const dataVals = sorted.map((d) => d[1]);
        const maxV = dataVals.length ? Math.max.apply(null, dataVals) : 0;
        // 数值轴多留一段上限，让柱条不要横贯整块绘图区；计数全为 1 时尤其明显
        const xMax = maxV + Math.max(0.5, maxV * 0.5);
        echarts.init(barEl, null, { renderer: 'canvas' }).setOption({
          ...(window.ChartAnim && window.ChartAnim.BAR_ANIM),
          tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'shadow' },
            formatter(params) {
              const abbr = sorted[sorted.length - 1 - params[0].dataIndex][0];
              const info = _genomeInfo[abbr];
              const asmLine = info && info.assembly
                ? `<br/><span style="color:#94a3b8;font-size:11px;">${info.assembly}</span>`
                : '';
              const name = info && info.full_name ? info.full_name : abbr;
              return `<strong>${name}</strong> (${abbr})<br/>Count: ${params[0].value}${asmLine}`;
            },
          },
          grid: {
            left: 4,
            right: 8,
            top: 8,
            bottom: 24,
            containLabel: true,
          },
          xAxis: {
            type: 'value',
            min: 0,
            max: xMax,
            minInterval: 1,
            splitLine: { lineStyle: { color: '#e2e8f0' } },
          },
          yAxis: {
            type: 'category',
            data: yLabels,
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
              fontSize: 10,
              lineHeight: 14,
              color: '#475569',
              width: 200,
              overflow: 'break',
            },
          },
          series: [{
            type: 'bar',
            ...(window.ChartAnim && window.ChartAnim.BAR_ANIM),
            data: sorted.map((d) => d[1]).reverse(),
            itemStyle: { color: '#9b59b6' },
            barCategoryGap: '18%',
            label: { show: true, position: 'right', fontSize: 10, color: '#64748b' },
          }],
        });
      }
    }

    if (drawer && detailBody) {
      if (window.echarts && detailBody) {
        detailBody.querySelectorAll('.homo-chart').forEach((el) => {
          const inst = window.echarts.getInstanceByDom(el);
          if (inst) inst.dispose();
        });
      }
      detailBody.innerHTML = html;
      const sv = document.getElementById('homo-seq-view');
      const lv = document.getElementById('homo-locus-view');
      if (sv) sv.hidden = true;
      if (lv) lv.hidden = true;
      if (detailView) { detailView.removeAttribute("hidden"); }
      if (!drawer.classList.contains('open')) {
        drawer.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        const tb = document.getElementById('g-homologous-toggle');
        if (tb) tb.classList.add('active');
        const mk = document.getElementById('g-homo-mask');
        if (mk) { mk.classList.add('open'); mk.setAttribute('aria-hidden', 'false'); }
      }
      requestAnimationFrame(renderCharts);
      return;
    }

    // Fallback: gene detail panel
    const body = document.getElementById('g-detail-body');
    if (!body) return;
    state.selectedGeneId = null;
    state.selectedTxId   = null;
    if (window.echarts) {
      body.querySelectorAll('.homo-chart').forEach((el) => {
        const inst = window.echarts.getInstanceByDom(el);
        if (inst) inst.dispose();
      });
    }
    body.innerHTML = html;
    requestAnimationFrame(renderCharts);
  }

  // ---------------------------------------------------------------------
  // Deep-link fast path
  // ---------------------------------------------------------------------
  // Homepage "Try" pills and shared links land here as `?perv=`, `?homo_locus=`,
  // `?homo_seq=`, `?loc=`, `?chrom=&start=&end=` or `?q=`. Historically these
  // params were only read at the very end of page init (after chromosomes,
  // IGV, and the PERV panel had all finished loading in series), so the
  // "jump to the target region" work — the whole point of clicking the
  // pill — was the last thing to happen. We now parse the params
  // synchronously on load and, for id-based lookups, kick off the tiny
  // `/api/download/resolve_region` lookup immediately so it runs *in
  // parallel* with chromosome/IGV/PERV-panel loading instead of waiting for
  // all of it (or a 15s polling fallback) to resolve.
  function parseDeepLinkParams() {
    const params = new URLSearchParams(location.search);
    const loc = params.get('loc');
    const homoLocus = params.get('homo_locus');
    const homoSeq = params.get('homo_seq');
    const perv = params.get('perv');
    const chrom = params.get('chrom');
    const start = params.get('start');
    const end = params.get('end');
    const q = params.get('q');
    if (loc) {
      const parsed = parseLocusParam(loc);
      if (parsed) return { kind: 'loc', chrom: parsed.chrom, start: parsed.start, end: parsed.end };
    } else if (chrom && start != null && end != null) {
      return { kind: 'range', chrom, start: parseInt(start, 10), end: parseInt(end, 10) };
    } else if (perv) {
      return { kind: 'perv', id: perv };
    } else if (homoSeq) {
      return { kind: 'homo_seq', id: homoSeq };
    } else if (homoLocus) {
      return { kind: 'homo_locus', id: homoLocus };
    } else if (q) {
      return { kind: 'q', id: q };
    }
    return null;
  }

  const DEEP_LINK_RESOLVE_TYPE = { perv: 'perv', homo_seq: 'homo_seq', homo_locus: 'homo_locus' };

  function prefetchDeepLinkRegion(deepLink) {
    const apiType = deepLink && DEEP_LINK_RESOLVE_TYPE[deepLink.kind];
    if (!apiType) return null;
    return fetch('/api/download/resolve_region?type=' + apiType + '&id=' + encodeURIComponent(deepLink.id))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  // Best-effort initial-viewport coordinates for initIgv(). For 'loc'/'range'
  // this is instant (already in the URL); for id-based lookups we wait on
  // the prefetch above, but only briefly — if the API hasn't answered yet
  // IGV just falls back to its normal default view and the eventual
  // consumeUrlParams() navigation still runs a bit later.
  async function resolveInitialLocus(deepLink, prefetchPromise) {
    if (!deepLink) return null;
    if (deepLink.kind === 'loc' || deepLink.kind === 'range') {
      return { chrom: deepLink.chrom, start: deepLink.start, end: deepLink.end };
    }
    if (!prefetchPromise) return null;
    try {
      const raced = await Promise.race([
        prefetchPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 800)),
      ]);
      if (!raced) return null;
      const len = raced.length != null ? raced.length : (raced.end - raced.start + 1);
      const pad = Math.max(500, Math.round(len * 0.1));
      return { chrom: raced.chrom, start: Math.max(1, raced.start - pad), end: raced.end + pad };
    } catch (_) {
      return null;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!document.getElementById('igv-container')) return;
    // Parse + prefetch as the very first thing, before any awaited work,
    // so the resolve_region lookup (when relevant) overlaps with everything
    // below instead of starting only after it.
    const deepLink = parseDeepLinkParams();
    const deepLinkPromise = prefetchDeepLinkRegion(deepLink);
    // Kick off the homologous-drawer data load (list/loci/genome_info) as
    // early as possible too — in parallel with chromosomes/IGV init instead
    // of only after initPervPanel() had already finished. This is what
    // `locus_1` / `homo_seq` deep links were mainly waiting on previously:
    // they wouldn't even *start* loading until the PERV panel's own fetch
    // had completed, then still had to run a 100ms-interval poll (up to
    // 15s) for the map to populate.
    initHomologousDrawer();

    await loadChromosomes();
    bindToolbar();
    bindSearch();
    bindDnaFoot();
    const initialLocus = await resolveInitialLocus(deepLink, deepLinkPromise);
    await initIgv(initialLocus);
    syncColorControlsFromTrack();
    await initPervPanel();
    await consumeUrlParams(deepLinkPromise);
    // Keep i18n labels in sync when language switches.
    document.addEventListener('i18nchange', () => {
      // Re-render the detail panel if a gene is currently selected
      if (state.selectedGeneId && state.geneCache.has(state.selectedGeneId)) {
        renderGeneDetail(state.geneCache.get(state.selectedGeneId));
      } else {
        clearDetail();
      }
    });
  });

  function parseLocusParam(loc) {
    const m = /^([^:]+):(\d+)-(\d+)$/.exec(String(loc || '').trim());
    if (!m) return null;
    return { chrom: m[1], start: parseInt(m[2], 10), end: parseInt(m[3], 10) };
  }

  function stripGenomeDeepLinkParams() {
    try {
      const params = new URLSearchParams(location.search);
      let changed = false;
      ['loc', 'perv', 'homo_seq', 'homo_locus', 'q', 'chrom', 'start', 'end'].forEach((key) => {
        if (params.has(key)) {
          params.delete(key);
          changed = true;
        }
      });
      if (!changed) return;
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (_) {}
  }

  async function focusPervByName(name, prefetchPromise) {
    const seq = _pervDataMap && _pervDataMap.get(name);
    if (seq) {
      const pad = Math.round((seq.end - seq.start + 1) * 0.1);
      await gotoLocus(seq.chrom, Math.max(1, seq.start - pad), seq.end + pad);
      showPervDetail(name);
      const panelBody = document.getElementById('perv-panel-body');
      const toggle = document.getElementById('perv-panel-toggle');
      if (toggle && panelBody && panelBody.style.display === 'none') toggle.click();
      const el = panelBody && panelBody.querySelector(
        `.perv-seq-item[data-name="${CSS.escape(name)}"]`
      );
      if (el) {
        if (_lastSelectedPervEl) _lastSelectedPervEl.classList.remove('selected');
        el.classList.add('selected');
        _lastSelectedPervEl = el;
      }
      return;
    }
    try {
      // Reuse the resolve_region request kicked off at page load (in
      // parallel with chromosome/IGV/PERV-panel init) instead of firing a
      // fresh one now and waiting for it from a cold start.
      const d = prefetchPromise
        ? await prefetchPromise
        : await fetch('/api/download/resolve_region?type=perv&id=' + encodeURIComponent(name))
            .then((r) => (r.ok ? r.json() : null));
      if (!d) return;
      const pad = Math.round(d.length * 0.1);
      await gotoLocus(d.chrom, Math.max(1, d.start - pad), d.end + pad);
      showPervDetail(d.name);
    } catch (e) {
      console.warn('[genome] perv deep link failed', e);
    }
  }

  async function searchAndNavigate(q) {
    const input = document.getElementById('g-search');
    if (input) input.value = q;
    try {
      const r = await fetch('/api/genome/search?q=' + encodeURIComponent(q));
      if (!r.ok) return;
      const d = await r.json();
      const items = d.items || [];
      if (!items.length) return;
      const it = items[0];
      const isTx = it.type === 'transcript';
      const pad = Math.max(500, Math.round((it.end - it.start) * 0.2));
      await gotoLocus(it.chrom, Math.max(1, it.start - pad), it.end + pad);
      if (isTx && it.gene_id) {
        state.viewMode = 'transcript';
        await showGeneDetail(it.gene_id, it.transcript_id, null);
      } else if (it.gene_id) {
        state.viewMode = 'gene';
        await showGeneDetail(it.gene_id, null, null);
      }
    } catch (e) {
      console.warn('[genome] search deep link failed', e);
    }
  }

  async function waitForHomoLocus(locusId, prefetchPromise) {
    // Fast path: full list already loaded (kicked off in parallel with IGV
    // init now, instead of only after the PERV panel finished).
    if (_homoLocusMap && _homoLocusMap.has(locusId)) {
      return _homoLocusMap.get(locusId);
    }
    // Reuse the resolve_region lookup already in flight since page load
    // rather than starting a fresh one after up to 15s of polling.
    if (prefetchPromise) {
      try {
        const d = await prefetchPromise;
        if (d) {
          return {
            locus_id: locusId,
            chrom: d.chrom,
            start: d.start,
            end: d.end,
            strand: '+',
            count: 0,
            species_dist: {},
            group_dist: {},
          };
        }
      } catch (e) {
        console.warn('[genome] homo locus resolve failed', e);
      }
    }
    // Last resort: short poll in case the full list finishes a moment later
    // (or the prefetch above wasn't available/failed for some reason).
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (_homoLocusMap && _homoLocusMap.has(locusId)) {
        return _homoLocusMap.get(locusId);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      const r = await fetch(
        '/api/download/resolve_region?type=homo_locus&id=' + encodeURIComponent(locusId)
      );
      if (!r.ok) return null;
      const d = await r.json();
      return {
        locus_id: locusId,
        chrom: d.chrom,
        start: d.start,
        end: d.end,
        strand: '+',
        count: 0,
        species_dist: {},
        group_dist: {},
      };
    } catch (e) {
      console.warn('[genome] homo locus resolve failed', e);
      return null;
    }
  }

  async function waitForHomoSeq(qname, prefetchPromise) {
    // Fast path: the full homologous list is usually already loaded by now
    // because loadHomologousData() is kicked off in parallel with IGV init
    // (see the DOMContentLoaded handler) rather than after it.
    if (_homoSeqMap && _homoSeqMap.has(qname)) {
      return _homoSeqMap.get(qname);
    }
    // Next fastest: the single-item resolve_region lookup that was already
    // in flight since page load, instead of polling from a cold start.
    if (prefetchPromise) {
      const d = await prefetchPromise;
      if (d) {
        return { q_name: qname, chrom: d.chrom, start: d.start, end: d.end };
      }
    }
    // Last resort: short poll in case the full list finishes a moment later.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (_homoSeqMap && _homoSeqMap.has(qname)) {
        return _homoSeqMap.get(qname);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  async function focusHomoSeqByName(qname, prefetchPromise) {
    const seq = await waitForHomoSeq(qname, prefetchPromise);
    if (!seq || seq.start == null || seq.end == null) return;
    const pad = Math.max(500, Math.round((seq.end - seq.start + 1) * 0.1));
    await gotoLocus(seq.chrom, Math.max(1, seq.start - pad), seq.end + pad);
    _detailFromTab = 'seq';
    showHomologousSeqDetail(seq);  // opens the homologous drawer + detail panel
    const seqList = document.getElementById('homo-seq-list');
    if (seqList) {
      if (_lastSelectedSeqEl) _lastSelectedSeqEl.classList.remove('selected');
      const match = seqList.querySelector(`.homo-seq-item[data-qname="${CSS.escape(qname)}"]`);
      if (match) { match.classList.add('selected'); _lastSelectedSeqEl = match; }
    }
  }

  async function focusHomoLocusById(locusId, prefetchPromise) {
    const locus = await waitForHomoLocus(locusId, prefetchPromise);
    if (!locus || locus.start == null || locus.end == null) return;
    const pad = Math.max(1000, Math.round((locus.end - locus.start + 1) * 0.1));
    await gotoLocus(locus.chrom, Math.max(1, locus.start - pad), locus.end + pad);
    showHomologousLocusDetail(locus);
    const locusList = document.getElementById('homo-locus-list');
    if (locusList) {
      if (_lastSelectedLocusEl) _lastSelectedLocusEl.classList.remove('selected');
      const match = locusList.querySelector(`.homo-locus-item[data-lid="${CSS.escape(locusId)}"]`);
      if (match) { match.classList.add('selected'); _lastSelectedLocusEl = match; }
    }
  }

  async function consumeUrlParams(prefetchPromise) {
    if (!browser) return;
    const params = new URLSearchParams(location.search);
    const loc = params.get('loc');
    const perv = params.get('perv');
    const homoSeq = params.get('homo_seq');
    const homoLocus = params.get('homo_locus');
    const q = params.get('q');
    const chrom = params.get('chrom');
    const start = params.get('start');
    const end = params.get('end');

    let handled = false;
    if (loc) {
      const parsed = parseLocusParam(loc);
      if (parsed) {
        await gotoLocus(parsed.chrom, parsed.start, parsed.end);
        handled = true;
      }
    } else if (chrom && start != null && end != null) {
      await gotoLocus(chrom, parseInt(start, 10), parseInt(end, 10));
      handled = true;
    } else if (perv) {
      await focusPervByName(perv, prefetchPromise);
      handled = true;
    } else if (homoSeq) {
      await focusHomoSeqByName(homoSeq, prefetchPromise);
      handled = true;
    } else if (homoLocus) {
      await focusHomoLocusById(homoLocus, prefetchPromise);
      handled = true;
    } else if (q) {
      await searchAndNavigate(q);
      handled = true;
    }
    if (handled) stripGenomeDeepLinkParams();
  }
})();
