// Section 2: 139-sequence browser.
(function () {
  const REGION_COLORS = {
    LTR: '#94a3b8',
    GAG: '#2563eb',
    POL: '#10b981',
    ENV: '#f59e0b',
    AP: '#0ea5e9',
    RT: '#8b5cf6',
    RNaseH: '#ec4899',
    INT: '#22c55e',
  };
  function colorFor(name) {
    return REGION_COLORS[name] || '#64748b';
  }

  const state = {
    ids: [],
    currentId: null,
    mode: 'orf',
    seqMode: 'dna',
    regions: [],
    seqLength: 0,
    selectedRegion: null,
    fullDna: null,
    lastFasta: '',
    lastFilename: '',
  };

  let trackChart = null;
  let abbrBreedChart = null;

  async function loadAbbrChart() {
    const el = document.getElementById('chart-abbr-browser');
    if (!el || !window.AbbrBreedChart) return;
    try {
      const res = await fetch('/api/sequences/pass/stats');
      if (!res.ok) return;
      const data = await res.json();
      abbrBreedChart = window.AbbrBreedChart.render(abbrBreedChart || el, data.abbr_counts || []);
    } catch (err) {
      console.warn('[browser] abbr chart failed:', err);
    }
  }

  // ---------- ID list ----------
  function groupTagHtml(group) {
    if (group === 'Eastern') return '<span class="tag east">Eastern</span>';
    if (group === 'Western') return '<span class="tag west">Western</span>';
    if (group === 'Wild') return '<span class="tag wild">Wild</span>';
    return group ? `<span class="tag">${SeqUtils.escapeHtml(group)}</span>` : '<span class="id-col-empty">—</span>';
  }

  function ervTypeTagHtml(ervType) {
    if ((ervType || '').startsWith('γ')) return '<span class="tag gamma">γ.ERV</span>';
    if ((ervType || '').startsWith('β')) return '<span class="tag beta">β.ERV</span>';
    return '<span class="id-col-empty">—</span>';
  }

  function getIdFilters() {
    return {
      q: (document.getElementById('id-search')?.value || '').toLowerCase(),
      group: document.getElementById('id-filter-group')?.value || '',
      sample: document.getElementById('id-filter-sample')?.value || '',
    };
  }

  function populateSampleFilter() {
    const sel = document.getElementById('id-filter-sample');
    if (!sel) return;
    const prev = sel.value;
    const samples = [...new Set(state.ids.map((it) => it.sample).filter(Boolean))].sort();
    const allLabel = window.I18n ? window.I18n.t('br.filter.all_samples') : 'All samples';
    sel.innerHTML =
      `<option value="">${SeqUtils.escapeHtml(allLabel)}</option>` +
      samples
        .map((s) => {
          const row = state.ids.find((it) => it.sample === s);
          const name = row?.sample_name || s;
          const label = name && name !== s ? `${s} — ${name}` : s;
          return `<option value="${SeqUtils.escapeHtml(s)}">${SeqUtils.escapeHtml(label)}</option>`;
        })
        .join('');
    if (prev && samples.includes(prev)) sel.value = prev;
    if (window.PervSelect) PervSelect.refresh(sel);
  }

  async function loadIds() {
    const res = await fetch('/api/sequences/pass');
    const data = await res.json();
    state.ids = data.items;
    populateSampleFilter();
    renderIdList();
  }

  function renderIdList() {
    const tbody = document.getElementById('id-list-tbody');
    if (!tbody) {
      console.error('[browser] #id-list-tbody not found — template may be stale, reload the page');
      return;
    }
    const { q, group, sample } = getIdFilters();
    const filtered = state.ids.filter((it) => {
      if (q && !it.id.toLowerCase().includes(q)) return false;
      if (group && it.group !== group) return false;
      if (sample && it.sample !== sample) return false;
      return true;
    });
    tbody.innerHTML = filtered
      .map(
        (it) =>
          `<tr data-id="${SeqUtils.escapeHtml(it.id)}"${
            it.id === state.currentId ? ' class="active"' : ''
          }>` +
          `<td class="id-col-id"><span class="id-text">${SeqUtils.escapeHtml(it.id)}</span></td>` +
          `<td class="id-col-group">${groupTagHtml(it.group)}</td>` +
          `<td class="id-col-type">${ervTypeTagHtml(it.erv_type)}</td>` +
          `<td class="id-col-len">${it.length} bp</td>` +
          `</tr>`
      )
      .join('');
    tbody.querySelectorAll('tr').forEach((row) => {
      row.addEventListener('click', () => selectId(row.dataset.id));
    });
  }

  // ---------- selection / regions ----------
  async function selectId(sid) {
    state.currentId = sid;
    state.fullDna = null;
    const wrap = document.getElementById('highlight-wrap');
    if (wrap) {
      wrap.open = false;
      document.getElementById('full-seq').innerHTML = '';
    }
    document
      .querySelectorAll('#id-list-tbody tr')
      .forEach((row) => row.classList.toggle('active', row.dataset.id === sid));
    await loadRegions();
  }

  async function loadRegions() {
    if (!state.currentId) return;
    const url = `/api/sequences/${encodeURIComponent(state.currentId)}/regions?kind=${state.mode}`;
    const res = await fetch(url);
    const data = await res.json();
    state.regions = data.regions;
    state.seqLength = data.length;
    renderTrack();
    populateRegionSelect();
    if (state.regions.length) {
      const first =
        state.seqMode === 'protein' && state.mode === 'orf'
          ? state.regions.find((r) => r.name !== 'LTR') || state.regions[0]
          : state.regions[0];
      selectRegion(first);
    } else {
      hideSeqDisplay();
    }
  }

  // ---------- track ----------
  function ensureTrack() {
    if (!trackChart) {
      trackChart = echarts.init(document.getElementById('track'));
      window.addEventListener('resize', () => trackChart && trackChart.resize());
      trackChart.on('click', (params) => {
        if (params.componentType === 'series' && params.data && params.data.region) {
          selectRegion(params.data.region);
        }
      });
    }
    return trackChart;
  }

  function renderTrack() {
    const c = ensureTrack();
    const items = state.regions.map((r) => ({
      name: r.name,
      value: [r.start, r.end - r.start, r.end, r.strand, r.name],
      region: r,
      itemStyle: { color: colorFor(r.name), borderRadius: 4 },
    }));

    const option = {
      grid: { left: 10, right: 30, top: 24, bottom: 50 },
      tooltip: {
        trigger: 'item',
        formatter: function (p) {
          if (!p.data || !p.data.region) return '';
          const r = p.data.region;
          return `<b>${SeqUtils.escapeHtml(r.name)}</b><br/>${r.start} – ${r.end} bp<br/>strand: ${r.strand}<br/>length: ${r.end - r.start} bp`;
        },
      },
      xAxis: {
        type: 'value',
        min: 0,
        max: state.seqLength,
        name: 'bp',
        nameLocation: 'middle',
        nameGap: 28,
        axisLine: { onZero: false },
      },
      yAxis: {
        type: 'category',
        data: [state.currentId || ''],
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { show: false },
      },
      series: [
        {
          type: 'custom',
          renderItem: function (params, api) {
            const start = api.value(0);
            const len = api.value(1);
            const end = start + len;
            const startCoord = api.coord([start, 0]);
            const endCoord = api.coord([end, 0]);
            const height = 22;
            return {
              type: 'rect',
              shape: {
                x: startCoord[0],
                y: startCoord[1] - height / 2,
                width: Math.max(2, endCoord[0] - startCoord[0]),
                height: height,
              },
              style: api.style({
                fill: api.visual('color'),
                stroke: '#fff',
                lineWidth: 1,
              }),
            };
          },
          encode: { x: [0, 2], y: 4 },
          data: items,
          z: 10,
        },
        {
          type: 'custom',
          renderItem: function (params, api) {
            const start = api.value(0);
            const end = api.value(2);
            const name = api.value(4);
            const mid = (start + end) / 2;
            const c = api.coord([mid, 0]);
            return {
              type: 'text',
              style: {
                text: name,
                x: c[0],
                y: c[1],
                fontSize: 11,
                fill: '#ffffff',
                textAlign: 'center',
                textVerticalAlign: 'middle',
              },
              silent: true,
            };
          },
          data: items.map((it) => ({ value: it.value })),
          z: 11,
        },
      ],
    };
    c.setOption(option, true);
    renderLegend();
  }

  function renderLegend() {
    const present = Array.from(new Set(state.regions.map((r) => r.name)));
    const el = document.getElementById('track-legend');
    el.innerHTML =
      `<span>${SeqUtils.escapeHtml(window.I18n.t('br.legend'))}</span>` +
      present
        .map(
          (n) =>
            `<span><span class="dot" style="background:${colorFor(n)}"></span>${SeqUtils.escapeHtml(n)}</span>`
        )
        .join('');
  }

  function populateRegionSelect() {
    const sel = document.getElementById('region-select');
    let options = state.regions;
    if (state.seqMode === 'protein' && state.mode === 'orf') {
      options = options.filter((r) => r.name !== 'LTR');
    }
    sel.innerHTML = options
      .map(
        (r, i) =>
          `<option value="${i}">${SeqUtils.escapeHtml(r.name)} | ${r.start}–${r.end} (${r.strand})</option>`
      )
      .join('');
    sel.onchange = () => {
      const r = options[Number(sel.value)];
      if (r) selectRegion(r);
    };
    if (state.selectedRegion) {
      const idx = options.findIndex(
        (r) =>
          r.name === state.selectedRegion.name &&
          r.start === state.selectedRegion.start &&
          r.end === state.selectedRegion.end
      );
      if (idx >= 0) sel.value = String(idx);
    }
    if (window.PervSelect) PervSelect.refresh(sel);
  }

  // ---------- region selection / sequence display ----------
  async function selectRegion(r) {
    state.selectedRegion = r;
    populateRegionSelect();
    if (state.seqMode === 'protein' && state.mode === 'orf' && r.name === 'LTR') {
      // find first non-LTR
      const alt = state.regions.find((x) => x.name !== 'LTR');
      if (alt) {
        state.selectedRegion = alt;
        r = alt;
      } else {
        showProteinWarn();
        return;
      }
    }
    if (state.seqMode === 'dna') await loadDna(r);
    else await loadProtein(r);
  }

  function hideSeqDisplay() {
    document.getElementById('seq-empty').style.display = '';
    document.getElementById('seq-display').style.display = 'none';
  }

  function showSeqDisplay() {
    document.getElementById('seq-empty').style.display = 'none';
    document.getElementById('seq-display').style.display = '';
    document.getElementById('protein-warn').style.display = 'none';
  }

  function showProteinWarn() {
    document.getElementById('seq-empty').style.display = 'none';
    document.getElementById('seq-display').style.display = '';
    document.getElementById('fasta').textContent = '';
    document.getElementById('seq-title').textContent = '';
    document.getElementById('seq-meta').textContent = '';
    document.getElementById('protein-warn').style.display = '';
    document.getElementById('highlight-wrap').style.display = 'none';
  }

  async function loadDna(r) {
    const params = new URLSearchParams({
      start: r.start, end: r.end, strand: r.strand, name: r.name,
    });
    const res = await fetch(
      `/api/sequences/${encodeURIComponent(state.currentId)}/dna?` + params.toString()
    );
    const data = await res.json();
    showSeqDisplay();
    document.getElementById('seq-title').textContent =
      `${data.id} | ${r.start}-${r.end} | ${r.name}`;
    document.getElementById('seq-meta').textContent =
      `${window.I18n.t('br.seq.dna')} · strand ${r.strand} · ${data.length} bp`;
    document.getElementById('fasta').textContent = data.fasta.trim();
    state.lastFasta = data.fasta;
    state.lastFilename = `${data.id}_${r.name}_${r.start}-${r.end}.dna.fa`;
    await renderHighlight(r);
  }

  async function loadProtein(r) {
    if (state.mode === 'orf' && r.name === 'LTR') {
      showProteinWarn();
      return;
    }
    const params = new URLSearchParams({
      start: r.start, end: r.end, strand: r.strand, name: r.name,
    });
    const res = await fetch(
      `/api/sequences/${encodeURIComponent(state.currentId)}/protein?` + params.toString()
    );
    const data = await res.json();
    showSeqDisplay();
    document.getElementById('seq-title').textContent =
      `${data.id} | ${r.start}-${r.end} | ${r.name}`;
    document.getElementById('seq-meta').textContent =
      `${window.I18n.t('br.seq.protein')} · strand ${r.strand} · ${data.length} aa`;
    document.getElementById('fasta').textContent = data.fasta.trim();
    state.lastFasta = data.fasta;
    state.lastFilename = `${data.id}_${r.name}_${r.start}-${r.end}.protein.fa`;
    document.getElementById('highlight-wrap').style.display = 'none';
  }

  async function ensureFullDna() {
    if (state.fullDna && state.fullDna.id === state.currentId) return state.fullDna.seq;
    const params = new URLSearchParams({
      start: 0, end: state.seqLength, strand: '+', name: 'full',
    });
    const res = await fetch(
      `/api/sequences/${encodeURIComponent(state.currentId)}/dna?` + params.toString()
    );
    const data = await res.json();
    state.fullDna = { id: state.currentId, seq: data.dna };
    return data.dna;
  }

  function scrollHighlightInPanel(container, mark, region) {
    if (region && region.start === 0) {
      container.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    const top = container.scrollTop + (markRect.top - containerRect.top) - 8;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  async function paintHighlight(r) {
    const target = document.getElementById('full-seq');
    const seq = await ensureFullDna();
    const wrapped = SeqUtils.fastaWrap(seq, 60);
    const before = SeqUtils.escapeHtml(wrapped.slice(0, raw2wrap(r.start)));
    const middle = SeqUtils.escapeHtml(wrapped.slice(raw2wrap(r.start), raw2wrap(r.end)));
    const after = SeqUtils.escapeHtml(wrapped.slice(raw2wrap(r.end)));
    target.innerHTML = before + '<mark>' + middle + '</mark>' + after;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const mark = target.querySelector('mark');
        if (mark) scrollHighlightInPanel(target, mark, r);
      });
    });
  }

  async function renderHighlight(r) {
    const wrap = document.getElementById('highlight-wrap');
    const target = document.getElementById('full-seq');
    wrap.style.display = '';

    if (!wrap.open) {
      target.innerHTML = '';
      return;
    }

    await paintHighlight(r);
  }

  function raw2wrap(idx) {
    // wrapped seq adds one '\n' after every 60 chars: position becomes idx + floor(idx/60).
    return idx + Math.floor(idx / 60);
  }

  function resetIdFilters() {
    document.getElementById('id-search').value = '';
    document.getElementById('id-filter-group').value = '';
    document.getElementById('id-filter-sample').value = '';
    if (window.PervSelect) {
      PervSelect.refresh(document.getElementById('id-filter-group'));
      PervSelect.refresh(document.getElementById('id-filter-sample'));
    }
    renderIdList();
  }

  // ---------- toolbar ----------
  function bindToolbar() {
    document.querySelectorAll('#mode-group button').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#mode-group button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        state.mode = b.dataset.mode;
        state.selectedRegion = null;
        if (state.currentId) loadRegions();
      });
    });
    document.querySelectorAll('#seq-group button').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#seq-group button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        state.seqMode = b.dataset.seq;
        if (state.selectedRegion) selectRegion(state.selectedRegion);
        else populateRegionSelect();
      });
    });
    document.getElementById('btn-copy').addEventListener('click', async () => {
      if (!state.lastFasta) return;
      const ok = await SeqUtils.copyToClipboard(state.lastFasta);
      if (ok) {
        const btn = document.getElementById('btn-copy');
        const orig = btn.textContent;
        btn.textContent = window.I18n.t('br.copied');
        setTimeout(() => (btn.textContent = orig), 1200);
      }
    });
    document.getElementById('btn-download').addEventListener('click', () => {
      if (!state.lastFasta) return;
      SeqUtils.downloadText(state.lastFilename || 'sequence.fa', state.lastFasta, 'text/plain');
    });
    document.getElementById('btn-all-dna').addEventListener('click', async () => {
      if (!state.currentId) return;
      const res = await fetch(
        `/api/sequences/${encodeURIComponent(state.currentId)}/all-dna?kind=${state.mode}`
      );
      const data = await res.json();
      SeqUtils.downloadText(
        `${state.currentId}_${state.mode}_all_dna.fa`,
        data.fasta || '',
        'text/plain'
      );
    });
    document.getElementById('btn-all-protein').addEventListener('click', async () => {
      if (!state.currentId) return;
      const res = await fetch(
        `/api/sequences/${encodeURIComponent(state.currentId)}/all-protein?kind=${state.mode}`
      );
      const data = await res.json();
      SeqUtils.downloadText(
        `${state.currentId}_${state.mode}_all_proteins.fa`,
        data.fasta || '',
        'text/plain'
      );
    });
    document.getElementById('id-search').addEventListener('input', () => renderIdList());
    document.getElementById('id-filter-group').addEventListener('change', () => renderIdList());
    document.getElementById('id-filter-sample').addEventListener('change', () => renderIdList());
    document.getElementById('id-reset').addEventListener('click', resetIdFilters);

    const highlightWrap = document.getElementById('highlight-wrap');
    highlightWrap.addEventListener('toggle', () => {
      if (highlightWrap.open && state.selectedRegion && state.seqMode === 'dna') {
        paintHighlight(state.selectedRegion);
      }
    });
  }

  async function consumeIdParam() {
    const id = new URLSearchParams(location.search).get('id');
    if (id) {
      if (state.ids.some((it) => it.id === id)) {
        await selectId(id);
      } else {
        const search = document.getElementById('id-search');
        if (search) {
          search.value = id;
          renderIdList();
        }
      }
      try {
        history.replaceState(null, '', location.pathname);
      } catch (_) {}
      return;
    }
    if (state.ids.length) {
      await selectId(state.ids[0].id);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindToolbar();
    loadAbbrChart();
    loadIds().then(() => consumeIdParam());
  });
  window.addEventListener('resize', () => {
    if (abbrBreedChart) abbrBreedChart.resize();
  });
  document.addEventListener('i18nchange', () => {
    populateSampleFilter();
    renderIdList();
    if (state.regions.length) renderLegend();
    if (state.selectedRegion) {
      // refresh meta string to reflect language
      if (state.seqMode === 'dna') loadDna(state.selectedRegion);
      else loadProtein(state.selectedRegion);
    }
  });
})();
