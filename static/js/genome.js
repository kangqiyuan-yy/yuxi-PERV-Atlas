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
    colorTrackId: 'ensembl-transcripts',
    strandColorLinked: {
      'ensembl-genes': true,
      'ensembl-transcripts': true,
    },
  };

  // Static heights per display mode. We previously auto-scaled by feature
  // count and called browser.layoutChange() inside the locuschange handler,
  // but that re-entered locuschange in some igv.js builds and froze the
  // page after the first navigation. A fixed height per mode is simpler
  // and lets igv.js handle internal scrolling for very dense regions.
  const MODE_HEIGHT = { EXPANDED: 150, SQUISHED: 100, COLLAPSED: 50 };

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
      li.addEventListener('click', () => {
        const name = li.dataset.name;
        if (!name) return;
        const c = chromosomes.find((x) => x.name === name);
        state.chrom = name;
        state.start = 1;
        state.end = c ? Math.min(200000, c.length) : 200000;
        reflectInputs();
        setLocusDisplay();
        closeChromPicker();
      });
    });
    const labelEl = document.getElementById('g-chrom-label');
    if (labelEl) labelEl.textContent = chromLabel(state.chrom);
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
        fTimer = setTimeout(() => renderChromPicker(v), 80);
      });
      filter.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeChromPicker();
        else if (e.key === 'Enter') {
          // pick the first visible option
          const first = document.querySelector('#g-chrom-list li[data-name]');
          if (first) first.click();
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
  async function initIgv() {
    const container = document.getElementById('igv-container');
    if (!container || browser) return;
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
        color: '#b8860b',
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
        altColor: '#b03a0d',
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
        altColor: '#1e5fa8',
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
        altColor: '#6c3483',
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
    };
    try {
      browser = await igv.createBrowser(container, config);
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
    setTimeout(() => _markAndStickyFrozenTracks(), 80);

    // igv.js v3 uses Shadow DOM — inject <style> immediately into shadow root.
    // A <style> tag in the shadow root persists for all future label elements.
    _injectLabelStyleIntoShadow();

    // Keep strand altColor synced with the main color.
    // IGV's "Set track color" menu can update `track.color` but leave
    // `track.altColor` unchanged, which makes only part of a strand-aware
    // track appear recolored. We force both to the same value so users get
    // true whole-track recoloring.
    syncTrackColors();
    if (colorSyncTimer) window.clearInterval(colorSyncTimer);
    colorSyncTimer = window.setInterval(syncTrackColors, 600);
    syncColorControlsFromTrack();
    browser.on('locuschange', (referenceFrameList) => {
      try {
        if (!referenceFrameList || !referenceFrameList.length) return;
        const f = referenceFrameList[0];
        state.chrom = f.chr;
        state.start = Math.max(1, Math.round(f.start) + 1);
        state.end = Math.round(f.end);
        reflectInputs();
        setLocusDisplay();
        syncTrackColors();
        _markAndStickyFrozenTracks();
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
        background: rgba(37,99,235,0.08) !important;
        border: 1px solid rgba(37,99,235,0.25) !important;
        border-radius: 6px !important;
        color: #1e40af !important;
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
    let timer;

    function close() { list.style.display = 'none'; active = -1; }

    function render() {
      if (!items.length) { list.innerHTML = ''; list.style.display = 'none'; return; }
      list.innerHTML = items.map((it, i) => {
        const isTx = it.type === 'transcript';
        const pillCls = isTx ? 'pill tx' : 'pill';
        const pillTxt = isTx ? 'TX' : 'GENE';
        const primary = isTx
          ? esc(it.transcript_id)
          : esc(it.gene_name || it.gene_id);
        const secondary = isTx
          ? `${esc(it.gene_name || it.gene_id || '')} · ${esc(it.transcript_biotype || it.gene_biotype || '')}`
          : `${esc(it.gene_id || '')} · ${esc(it.gene_biotype || '')}`;
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
      try {
        if (!q) { items = []; render(); return; }
        const r = await fetch('/api/genome/search?q=' + encodeURIComponent(q));
        if (!r.ok) { items = []; render(); return; }
        const d = await r.json();
        items = d.items || [];
        active = items.length ? 0 : -1;
        render();
      } catch (e) {
        console.warn('[genome] search fetch failed:', e);
        items = []; render();
      }
    }

    input.addEventListener('input', (e) => {
      clearTimeout(timer);
      const q = (e.target.value || '').trim();
      timer = setTimeout(() => fetchSuggest(q), 200);
    });
    input.addEventListener('keydown', (e) => {
      if (list.style.display === 'none') return;
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

    // Selected transcript object & exon callout
    const selTx = txs.find((t) => t.transcript_id === state.selectedTxId) || txs[0];
    let calloutHtml = '';
    if (selTx) {
      let exonInfo = null;
      if (state.selectedExonRange) {
        const ex = selTx.exons.find((e) =>
          e.start === state.selectedExonRange.start && e.end === state.selectedExonRange.end);
        if (ex) {
          const ordered = selTx.strand === '-'
            ? selTx.exons.slice().sort((a, b) => b.end - a.end)
            : selTx.exons.slice().sort((a, b) => a.start - b.start);
          const idx = ordered.findIndex((e) => e.start === ex.start && e.end === ex.end);
          exonInfo = {
            n: idx + 1,
            of: ordered.length,
            length: ex.end - ex.start + 1,
            range: `${g.chrom}:${ex.start}-${ex.end}`,
          };
        }
      }
      if (exonInfo) {
        calloutHtml = `
          <div class="exon-callout">
            <div><span class="big">${I18n.t('gn.detail.exon').replace('{n}', exonInfo.n).replace('{of}', exonInfo.of)}</span></div>
            <div class="small">${I18n.t('gn.detail.length')}: <b>${fmtInt(exonInfo.length)} bp</b> · ${esc(exonInfo.range)} · ${selTx.strand}</div>
          </div>`;
      }
    }

    const txHtml = txs.map((t) => renderTxRow(t, lo, span, selTx ? selTx.transcript_id : null)).join('');
    const featureBreakdown = selTx ? renderFeatureBreakdown(selTx, g.chrom) : '';

    const isTxView = state.viewMode === 'transcript' && selTx;
    const header = isTxView ? renderTxHeader(g, selTx) : renderGeneHeader(g, txs);

    const body = document.getElementById('g-detail-body');
    body.innerHTML = header + calloutHtml + featureBreakdown +
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
    body.querySelectorAll('.tx-row .tx-mini .exon').forEach((blk) => {
      blk.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const row = blk.closest('.tx-row');
        if (!row) return;
        state.selectedTxId = row.dataset.tx;
        state.selectedExonRange = {
          start: Number(blk.dataset.start),
          end: Number(blk.dataset.end),
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
      const url = `/api/genome/region/gtf?chrom=${encodeURIComponent(g.chrom)}&start=${g.start}&end=${g.end}`;
      window.open(url, '_blank');
    });

    document.getElementById('g-dna-wrap').style.display = '';
    bindDnaFoot();
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
          <button class="btn small ghost back" id="d-back-gene" type="button" title="${esc(I18n.t('gn.detail.back_gene_tip'))}">
            ← ${esc(I18n.t('gn.detail.back_gene'))} <b>${esc(g.gene_name || g.gene_id)}</b>
          </button>
        </div>
        <div class="name">
          ${esc(t.transcript_id)}
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
          <button class="btn small ghost" id="d-export-gtf">${esc(I18n.t('gn.tool.export.gtf'))}</button>
        </div>
      </div>`;
  }

  function renderTxRow(t, lo, span, activeTxId) {
    const active = t.transcript_id === activeTxId;
    const cdsMin = t.cds_min || null;
    const cdsMax = t.cds_max || null;
    // selected exon coords
    const sel = state.selectedExonRange;
    const blocks = t.exons.map((e) => {
      const left = ((e.start - lo) / span) * 100;
      const width = Math.max(0.4, ((e.end - e.start + 1) / span) * 100);
      let cls = 'exon';
      const isCoding = cdsMin != null && e.end >= cdsMin && e.start <= cdsMax;
      if (!isCoding) cls += ' utr';
      else if (e.start >= cdsMin && e.end <= cdsMax) cls += ' cds';
      else cls += ' cds'; // partial overlap also styled like CDS for simplicity
      const isSelected = active && sel && e.start === sel.start && e.end === sel.end;
      if (isSelected) cls += ' selected';
      return `<div class="${cls}" data-start="${e.start}" data-end="${e.end}"
                  style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;"
                  title="exon ${e.start}-${e.end} (${fmtInt(e.end - e.start + 1)} bp)"></div>`;
    }).join('');

    // start_codon / stop_codon markers (small triangles on the mini-map)
    const codonMarks = []
      .concat((t.start_codons || []).map((c) => ({ ...c, kind: 'start' })))
      .concat((t.stop_codons || []).map((c) => ({ ...c, kind: 'stop' })))
      .map((c) => {
        const left = ((c.start - lo) / span) * 100;
        const cls = c.kind === 'start' ? 'codon-mark start' : 'codon-mark stop';
        const tip = `${c.kind === 'start' ? 'start_codon' : 'stop_codon'} ${c.start}-${c.end}`;
        return `<div class="${cls}" style="left:${left.toFixed(3)}%;" title="${esc(tip)}"></div>`;
      })
      .join('');

    const biotype = t.transcript_biotype || 'transcript';
    const cdsStr = t.cds_length ? `${fmtInt(t.cds_length)} bp CDS` : '—';
    return `
      <div class="tx-row ${active ? 'active' : ''}" data-tx="${esc(t.transcript_id)}">
        <div class="tx-head">
          <span class="tx-id">${esc(t.transcript_id)}</span>
          <span class="tx-biotype ${esc(biotypeClass(biotype))}">${esc(biotype)}</span>
        </div>
        <div class="tx-stats">
          <span><b>${t.exon_count}</b> exons</span>
          <span><b>${fmtInt(t.length)}</b> bp tx</span>
          <span>${cdsStr}</span>
          <span>${esc(t.strand)}</span>
        </div>
        <div class="tx-mini" title="exon structure on shared gene scale">
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

    const colorOf = {
      transcript: '#0f172a',
      exon: '#d97706',
      CDS: '#2563eb',
      five_prime_utr: '#0ea5e9',
      three_prime_utr: '#0ea5e9',
      start_codon: '#16a34a',
      stop_codon: '#dc2626',
    };
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
        <table class="ftable">
          <thead><tr>
            <th>${esc(I18n.t('gn.detail.ftype'))}</th>
            <th>${esc(I18n.t('gn.detail.frange'))}</th>
            <th>${esc(I18n.t('gn.detail.flen'))}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
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
  function bindDnaFoot() {
    if (_dnaBound) return;
    const wrap = document.getElementById('g-dna-wrap');
    const det = wrap && wrap.querySelector('details');
    if (!det) return;
    det.addEventListener('toggle', async () => {
      if (!det.open) return;
      const target = document.getElementById('g-dna');
      const span = state.end - state.start + 1;
      if (span > 100000) {
        target.textContent = 'Region > 100 kb. Zoom in or use the DNA export button.';
        return;
      }
      target.textContent = 'Loading ...';
      try {
        const r = await fetch(`/api/genome/sequence?chrom=${encodeURIComponent(state.chrom)}&start=${state.start}&end=${state.end}`);
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          target.textContent = 'Error: ' + (e.error || r.status);
          return;
        }
        const d = await r.json();
        const wrapped = (window.SeqUtils && SeqUtils.fastaWrap) ? SeqUtils.fastaWrap(d.sequence) : d.sequence;
        target.textContent = `>${d.chrom}:${d.start}-${d.end}\n` + wrapped;
      } catch (e) {
        target.textContent = 'Error: ' + (e.message || e);
      }
    });
    _dnaBound = true;
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
    document.getElementById('g-go').addEventListener('click', async () => {
      const s = parseInt(document.getElementById('g-start').value, 10);
      const e = parseInt(document.getElementById('g-end').value, 10);
      if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
        await gotoLocus(state.chrom, s, e);
      }
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
            color: '#b8860b', altColor: '#a07800', visibilityWindow: -1,
          },
          {
            id: 'perv-sequences',
            name: 'PERV',
            type: 'annotation', format: 'bed',
            url: '/genome/data/perv.bed',
            indexed: false, height: 50, displayMode: 'EXPANDED',
            expandedRowHeight: 22, color: '#e05c2b', altColor: '#b03a0d', visibilityWindow: -1,
          },
          {
            id: 'homologous-sequences',
            name: 'Homologous Seq',
            type: 'annotation', format: 'bed',
            url: '/genome/data/homologous_seq.bed',
            indexed: false, height: 100, displayMode: 'EXPANDED',
            expandedRowHeight: 28, squishedRowHeight: 14, fontSize: 10,
            color: '#4a90e2', altColor: '#1e5fa8', visibilityWindow: 300000000,
          },
          {
            id: 'homologous-loci',
            name: 'Homologous Loci',
            type: 'annotation', format: 'bed',
            url: '/genome/data/homologous_locus.bed',
            indexed: false, height: 50, displayMode: 'EXPANDED',
            expandedRowHeight: 28, squishedRowHeight: 14, fontSize: 10,
            color: '#9b59b6', altColor: '#6c3483', visibilityWindow: 300000000,
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
            await browser.loadTrack(trackDef);
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
    if (colorTrack && colorPlus && colorMinus && colorLink) {
      colorTrack.addEventListener('change', () => syncColorControlsFromTrack());
      colorLink.addEventListener('change', () => applyStrandColors());
      colorPlus.addEventListener('input', () => applyStrandColors());
      colorMinus.addEventListener('input', () => applyStrandColors());
    }
  }

  // ---------------------------------------------------------------------------
  // PERV panel
  // ---------------------------------------------------------------------------
  let _pervDataMap = null;  // Map<name, seqObj> — loaded once

  // ---------------------------------------------------------------------------
  // Homologous panel caches
  // ---------------------------------------------------------------------------
  let _homoSeqMap = null;    // Map<q_name, seqObj>
  let _homoLocusMap = null;  // Map<locus_id, locusObj>
  let _homoAllSeqs = null;   // full 876-item array
  let _homoAllLoci = null;   // full loci array
  let _genomeInfo = {};      // Map abbr → {full_name, assembly}

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
        return `<div class="perv-seq-item" data-name="${esc(s.name)}" title="${esc(s.chrom)}:${_fmtCoord(s.start)}-${_fmtCoord(s.end)}">
          <span class="perv-seq-name">${esc(s.name)}</span>
          ${strandBadge}
          <span class="perv-seq-loc">${esc(s.chrom)}:${_fmtCoord(s.start)}‑${_fmtCoord(s.end)}</span>
          <span class="perv-seq-badges">${annBadges}</span>
        </div>`;
      }).join('');
      body.querySelectorAll('.perv-seq-item').forEach((el) => {
        el.addEventListener('click', () => {
          const name = el.dataset.name;
          const seq = _pervDataMap.get(name);
          if (!seq) return;
          const pad = Math.round((seq.end - seq.start + 1) * 0.1);
          // IGV uses 0-based coordinates for navigation: seq.start is 1-based
          const navStart = Math.max(1, seq.start - pad);
          const navEnd = seq.end + pad;
          gotoLocus(seq.chrom, navStart, navEnd).catch((e) =>
            console.warn('[perv] nav failed', e));
          showPervDetail(name);
          // Highlight selected
          body.querySelectorAll('.perv-seq-item').forEach((x) => x.classList.remove('selected'));
          el.classList.add('selected');
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
    const dnaWrap = document.getElementById('g-dna-wrap');
    if (dnaWrap) dnaWrap.style.display = 'block';
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
            <span class="homo-badge homo-badge-species" title="${esc((_genomeInfo[s.species] || {}).full_name || s.species)}${(_genomeInfo[s.species] || {}).assembly ? ' (' + (_genomeInfo[s.species] || {}).assembly + ')' : ''}">${esc(s.species)}</span>
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
          seqList.querySelectorAll('.homo-seq-item').forEach((x) => x.classList.remove('selected'));
          el.classList.add('selected');
          _detailFromTab = 'seq';
          showHomologousSeqDetail(seq);  // shows in drawer detail panel
          const pad = Math.max(500, Math.round((seq.end - seq.start + 1) * 0.1));
          gotoLocus(seq.chrom, Math.max(1, seq.start - pad), seq.end + pad)
            .catch((e) => console.warn('[homo] nav failed', e));
        });
      });
    }

    if (selSpecies) selSpecies.addEventListener('change', renderSeqList);
    if (selChr)     selChr.addEventListener('change', renderSeqList);
    if (selGroup)   selGroup.addEventListener('change', renderSeqList);
    if (selLocus)   selLocus.addEventListener('change', renderSeqList);
    if (searchSeq)  searchSeq.addEventListener('input', renderSeqList);

    // ── locus list ────────────────────────────────────────────────────────
    const searchLocus  = document.getElementById('homo-locus-search');
    const locusCountEl = document.getElementById('homo-locus-count');

    function renderLocusList() {
      const locusList = document.getElementById('homo-locus-list');
      if (!locusList || !_homoAllLoci) return;
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
          locusList.querySelectorAll('.homo-locus-item').forEach((x) => x.classList.remove('selected'));
          el.classList.add('selected');
          _detailFromTab = 'locus';
          showHomologousLocusDetail(locus);  // shows in drawer detail panel
          const pad = Math.max(1000, Math.round((locus.end - locus.start + 1) * 0.1));
          gotoLocus(locus.chrom, Math.max(1, locus.start - pad), locus.end + pad)
            .catch((e) => console.warn('[homo] nav failed', e));
        });
      });
    }

    if (searchLocus) searchLocus.addEventListener('input', renderLocusList);

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

  document.addEventListener('DOMContentLoaded', async () => {
    if (!document.getElementById('igv-container')) return;
    await loadChromosomes();
    bindToolbar();
    bindSearch();
    await initIgv();
    syncColorControlsFromTrack();
    initPervPanel();
    initHomologousDrawer();
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
})();
