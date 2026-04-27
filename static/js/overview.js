// Section 1: stats charts + searchable table.
(function () {
  const charts = {};
  let stats = null;

  function cssColor(varName, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return v || fallback;
  }

  function readPalette() {
    return {
      gamma: cssColor('--ov-gamma', '#2563eb'),
      beta: cssColor('--ov-beta', '#f59e0b'),
      east: cssColor('--ov-east', '#10b981'),
      west: cssColor('--ov-west', '#ef4444'),
      wild: cssColor('--ov-wild', '#64748b'),
      bar: '#6366f1',
      identity: '#0ea5e9',
      insertion: '#8b5cf6',
      kimura: '#14b8a6',
    };
  }

  let PALETTE = readPalette();

  function initChart(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const c = echarts.init(el);
    charts[id] = c;
    window.addEventListener('resize', () => c.resize());
    return c;
  }

  function fmtPct(part, total) {
    if (!total) return '';
    return ((part / total) * 100).toFixed(1) + '%';
  }

  function pieSeriesExtra() {
    return (window.ChartAnim && window.ChartAnim.PIE_SERIES) || {};
  }

  function barAnimExtra() {
    return (window.ChartAnim && window.ChartAnim.BAR_ANIM) || {};
  }

  function sliceBorder(color) {
    const CA = window.ChartAnim;
    if (CA && CA.withSliceBorder) return CA.withSliceBorder(color ? { color } : undefined);
    return Object.assign({ borderColor: '#fff', borderWidth: 2 }, color ? { color } : {});
  }

  function renderType(stats) {
    const c = charts['chart-type'] || initChart('chart-type');
    const counts = stats.type_counts || {};
    const data = Object.keys(counts).map((k) => ({
      name: k,
      value: counts[k],
      itemStyle: sliceBorder(k.startsWith('γ') ? PALETTE.gamma : PALETTE.beta),
    }));
    c.setOption({
      ...barAnimExtra(),
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 2 },
      series: [
        {
          type: 'pie',
          ...pieSeriesExtra(),
          radius: ['45%', '70%'],
          center: ['50%', '42%'],
          avoidLabelOverlap: true,
          label: {
            show: true,
            position: 'outside',
            formatter: '{b} {d}%',
            fontSize: 11,
            width: 110,
            overflow: 'truncate',
          },
          labelLine: {
            show: true,
            length: 10,
            length2: 8,
            maxSurfaceAngle: 80,
          },
          labelLayout: {
            hideOverlap: true,
            moveOverlap: 'shiftY',
          },
          data,
        },
      ],
    });
  }

  function renderGroup(stats) {
    const c = charts['chart-group'] || initChart('chart-group');
    const counts = stats.group_counts || {};
    const data = Object.keys(counts).map((k) => ({
      name: k,
      value: counts[k],
      itemStyle: sliceBorder(
        k === 'Eastern' ? PALETTE.east
          : k === 'Western' ? PALETTE.west
          : k === 'Wild' ? PALETTE.wild
          : '#94a3b8',
      ),
    }));
    c.setOption({
      ...barAnimExtra(),
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 2 },
      series: [
        {
          type: 'pie',
          ...pieSeriesExtra(),
          radius: ['45%', '70%'],
          center: ['50%', '42%'],
          avoidLabelOverlap: true,
          label: {
            show: true,
            position: 'outside',
            formatter: '{b} {d}%',
            fontSize: 11,
            width: 110,
            overflow: 'truncate',
          },
          labelLine: {
            show: true,
            length: 10,
            length2: 8,
            maxSurfaceAngle: 80,
          },
          labelLayout: {
            hideOverlap: true,
            moveOverlap: 'shiftY',
          },
          data,
        },
      ],
    });
  }

  function renderAbbr(stats) {
    const c = charts['chart-abbr'] || initChart('chart-abbr');
    if (window.AbbrBreedChart) {
      window.AbbrBreedChart.render(c, stats.abbr_counts || []);
    }
  }

  function histToBars(h) {
    if (!h || !h.edges || h.edges.length < 2) return { x: [], y: [] };
    const x = [];
    for (let i = 0; i < h.edges.length - 1; i++) {
      const a = h.edges[i];
      const b = h.edges[i + 1];
      x.push(formatTick(a) + '–' + formatTick(b));
    }
    return { x, y: h.counts };
  }

  function formatTick(v) {
    if (v == null) return '';
    const abs = Math.abs(v);
    if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    if (Number.isInteger(v)) return String(v);
    if (abs < 1) return v.toFixed(3);
    return v.toFixed(2);
  }

  function renderHist(id, h, color) {
    const c = charts[id] || initChart(id);
    const data = histToBars(h);
    c.setOption({
      ...barAnimExtra(),
      grid: { left: 48, right: 16, top: 16, bottom: 60 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: {
        type: 'category',
        data: data.x,
        axisTick: { alignWithLabel: true },
        axisLabel: {
          rotate: 40,
          fontSize: 10,
          align: 'right',
          margin: 8,
        },
      },
      yAxis: { type: 'value', min: 0 },
      series: [
        {
          type: 'bar',
          ...barAnimExtra(),
          data: data.y,
          itemStyle: { color, borderRadius: [3, 3, 0, 0] },
        },
      ],
    });
  }

  async function loadStats() {
    const res = await fetch('/api/overview/stats');
    stats = await res.json();
    document.getElementById('kpi-total').textContent = stats.total;
    const g = stats.type_counts['γ.ERV'] || 0;
    const b = stats.type_counts['β.ERV'] || 0;
    document.getElementById('kpi-gamma').textContent = g;
    document.getElementById('kpi-beta').textContent = b;
    document.getElementById('kpi-gamma-pct').textContent = fmtPct(g, stats.total);
    document.getElementById('kpi-beta-pct').textContent = fmtPct(b, stats.total);
    document.getElementById('kpi-groups').textContent = Object.keys(stats.group_counts).length;
    renderType(stats);
    renderGroup(stats);
    renderAbbr(stats);
    renderHist('chart-identity', stats.identity_hist, PALETTE.identity);
    renderHist('chart-insertion', stats.insertion_hist, PALETTE.insertion);
    renderHist('chart-kimura', stats.kimura_hist, PALETTE.kimura);
    populateAbbrFilter();
  }

  // ---------- table ----------
  const state = { page: 1, size: 25, q: '', type: '', group: '', abbr: '' };

  function populateAbbrFilter() {
    const sel = document.getElementById('t-abbr');
    if (!sel || !stats) return;
    const current = state.abbr;
    const allLabel = window.I18n ? window.I18n.t('ov.table.abbr') : 'All Abbretiation';
    const items = (stats.abbr_counts || [])
      .filter((a) => a.count > 0 && a.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.setAttribute('data-i18n', 'ov.table.abbr');
    allOpt.textContent = allLabel;
    sel.appendChild(allOpt);
    items.forEach((item) => {
      const name = item.name;
      const full = item.full_name || name;
      const label = full && full !== name ? `${name} — ${full}` : name;
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = label;
      sel.appendChild(opt);
    });
    sel.value = items.some((item) => item.name === current) ? current : '';
    state.abbr = sel.value;
    if (window.PervSelect) PervSelect.refresh(sel);
    if (window.I18n && typeof window.I18n.apply === 'function') window.I18n.apply();
  }

  function rowHtml(r) {
    const typeTag = (r['ERV.type'] || '').startsWith('γ')
      ? '<span class="tag gamma">γ.ERV</span>'
      : (r['ERV.type'] || '').startsWith('β')
      ? '<span class="tag beta">β.ERV</span>'
      : '';
    const grpTag =
      r.Group === 'Eastern'
        ? '<span class="tag east">Eastern</span>'
        : r.Group === 'Western'
        ? '<span class="tag west">Western</span>'
        : r.Group === 'Wild'
        ? '<span class="tag wild">Wild</span>'
        : escape(r.Group || '');
    return (
      '<tr>' +
      '<td>' + escape(r['Sequence.ID']) + '</td>' +
      '<td>' + typeTag + '</td>' +
      '<td>' + grpTag + '</td>' +
      '<td>' + escape(r.Abbretiation || '') + '</td>' +
      '<td>' + escape(r.Category || '') + '</td>' +
      '<td>' + escape(r.TE_type || '') + '</td>' +
      '<td>' + (r.Identity == null ? '' : Number(r.Identity).toFixed(4)) + '</td>' +
      '<td>' + (r.Insertion_Time == null ? '' : r.Insertion_Time) + '</td>' +
      '<td>' + (r['Kimura.distance'] == null ? '' : Number(r['Kimura.distance']).toFixed(4)) + '</td>' +
      '<td>' + escape(r.Motif || '') + '</td>' +
      '<td>' + escape(r.TSD || '') + '</td>' +
      '</tr>'
    );
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m]);
  }

  async function loadTable() {
    const params = new URLSearchParams({
      q: state.q, type: state.type, group: state.group, abbr: state.abbr,
      page: state.page, size: state.size,
    });
    const res = await fetch('/api/overview/table?' + params.toString());
    const data = await res.json();
    const tb = document.querySelector('#meta-table tbody');
    if (!data.rows.length) {
      tb.innerHTML = '<tr><td colspan="11" class="empty-hint" data-i18n="ov.table.empty">No matching records</td></tr>';
      window.I18n.apply();
    } else {
      tb.innerHTML = data.rows.map(rowHtml).join('');
    }
    const totalPages = Math.max(1, Math.ceil(data.total / data.size));
    document.getElementById('p-info').textContent = `${data.page} / ${totalPages}`;
    document.getElementById('p-prev').disabled = data.page <= 1;
    document.getElementById('p-next').disabled = data.page >= totalPages;
    const totalEl = document.getElementById('t-total');
    totalEl.textContent =
      window.I18n.t('ov.table.total') + ' ' + data.total + ' ' + window.I18n.t('ov.table.records');
  }

  function resetFilters() {
    state.q = '';
    state.type = '';
    state.group = '';
    state.abbr = '';
    state.page = 1;
    document.getElementById('t-q').value = '';
    document.getElementById('t-type').value = '';
    document.getElementById('t-group').value = '';
    document.getElementById('t-abbr').value = '';
    if (window.PervSelect) {
      PervSelect.refresh(document.getElementById('t-type'));
      PervSelect.refresh(document.getElementById('t-group'));
      PervSelect.refresh(document.getElementById('t-abbr'));
    }
    loadTable();
  }

  function bindTable() {
    let timer;
    const debounce = (fn, ms = 250) => () => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
    const trigger = () => { state.page = 1; loadTable(); };
    document.getElementById('t-q').addEventListener('input', (e) => {
      state.q = e.target.value;
      debounce(trigger)();
    });
    document.getElementById('t-type').addEventListener('change', (e) => {
      state.type = e.target.value; trigger();
    });
    document.getElementById('t-group').addEventListener('change', (e) => {
      state.group = e.target.value; trigger();
    });
    document.getElementById('t-abbr').addEventListener('change', (e) => {
      state.abbr = e.target.value; trigger();
    });
    document.getElementById('t-reset').addEventListener('click', resetFilters);
    document.getElementById('p-prev').addEventListener('click', () => {
      if (state.page > 1) { state.page--; loadTable(); }
    });
    document.getElementById('p-next').addEventListener('click', () => {
      state.page++; loadTable();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    PALETTE = readPalette();
    // Deep-link: ?q=<term> pre-fills the table search (e.g. from BLAST hits).
    const qParam = new URLSearchParams(location.search).get('q');
    if (qParam) {
      state.q = qParam;
      const qInput = document.getElementById('t-q');
      if (qInput) qInput.value = qParam;
    }
    loadStats();
    bindTable();
    loadTable();
  });
  document.addEventListener('i18nchange', () => {
    if (stats) {
      populateAbbrFilter();
      loadTable();
    }
  });
})();
