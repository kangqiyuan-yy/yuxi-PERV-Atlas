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

  // ---------- ID list ----------
  async function loadIds() {
    const res = await fetch('/api/sequences/pass');
    const data = await res.json();
    state.ids = data.items;
    renderIdList('');
  }

  function renderIdList(filter) {
    const ul = document.getElementById('id-list-ul');
    const q = (filter || '').toLowerCase();
    const filtered = q
      ? state.ids.filter((it) => it.id.toLowerCase().includes(q))
      : state.ids;
    ul.innerHTML = filtered
      .map(
        (it) =>
          `<li data-id="${SeqUtils.escapeHtml(it.id)}"${
            it.id === state.currentId ? ' class="active"' : ''
          }><span>${SeqUtils.escapeHtml(it.id)}</span><span class="len">${
            it.length
          } bp</span></li>`
      )
      .join('');
    ul.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => selectId(li.dataset.id));
    });
  }

  // ---------- selection / regions ----------
  async function selectId(sid) {
    state.currentId = sid;
    state.fullDna = null;
    document
      .querySelectorAll('#id-list-ul li')
      .forEach((li) => li.classList.toggle('active', li.dataset.id === sid));
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

  async function renderHighlight(r) {
    const wrap = document.getElementById('highlight-wrap');
    wrap.style.display = '';
    wrap.open = false;
    const target = document.getElementById('full-seq');
    target.innerHTML = '';
    let opened = false;
    wrap.addEventListener('toggle', async function once() {
      if (opened) return;
      opened = true;
      const seq = await ensureFullDna();
      const wrapped = SeqUtils.fastaWrap(seq, 60);
      // map highlight indices on raw seq -> wrapped positions
      const before = SeqUtils.escapeHtml(wrapped.slice(0, raw2wrap(r.start)));
      const middle = SeqUtils.escapeHtml(wrapped.slice(raw2wrap(r.start), raw2wrap(r.end)));
      const after = SeqUtils.escapeHtml(wrapped.slice(raw2wrap(r.end)));
      target.innerHTML = before + '<mark>' + middle + '</mark>' + after;
    }, { once: true });
  }

  function raw2wrap(idx) {
    // wrapped seq adds one '\n' after every 60 chars: position becomes idx + floor(idx/60).
    return idx + Math.floor(idx / 60);
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
    document.getElementById('id-search').addEventListener('input', (e) =>
      renderIdList(e.target.value)
    );
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindToolbar();
    loadIds();
  });
  document.addEventListener('i18nchange', () => {
    if (state.regions.length) renderLegend();
    if (state.selectedRegion) {
      // refresh meta string to reflect language
      if (state.seqMode === 'dna') loadDna(state.selectedRegion);
      else loadProtein(state.selectedRegion);
    }
  });
})();
