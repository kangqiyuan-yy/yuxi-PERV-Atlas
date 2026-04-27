// Home page: multi-omics atlas widget.
// Row 1: pig.svg (50%) + tissue 3×4 / cell-line 1×4 selectors (50%).
// Row 2: global ECharts overview OR inline tissue matrix (carousel / pin).
// Click pins tissue — matrix shown inline, no modal; hover does not change view.
(function () {
  'use strict';

  const fmtNum = (n) => Number(n || 0).toLocaleString();
  const CAROUSEL_MS = 4500;
  const TRANSITION_MS = 380;
  const BAR_SIZE = 14; // fixed bar thickness (px) for all omics bar charts
  const PERIOD_RANK = { S: 0, P21: 1, P50: 2, P100: 3, P180: 4 };

  function t(key, fallback) {
    if (window.I18n && typeof window.I18n.t === 'function') {
      const v = window.I18n.t(key);
      if (v && v !== key) return v;
    }
    return fallback !== undefined ? fallback : key;
  }
  function tissueLabel(id) { return t(`omics.tissue.${id}`, id); }
  function periodLabel(id) { return t(`omics.period.${id}`, id); }

  const colors = () => window.OmicsColors || {
    colorForAssay: (n) => '#6366f1',
    colorForPeriod: (n) => '#6366f1',
    colorForTissue: (n) => '#6366f1',
  };

  let summaryData = null;
  let chartInstances = [];
  let resizeTimer = null;
  let transitionTimer = null;
  let carouselTimer = null;

  let viewMode = 'overview';       // 'carousel' | 'overview'
  let carouselQueue = [];
  let carouselIdx = 0;
  let pinnedTissue = null;

  const TISSUE_ORDER = [
    'Brain', 'Muscle', 'Lung', 'Spleen',
    'Heart', 'Adipose', 'Liver', 'SInt',
    'Kidney', 'LInt', 'Testis',
  ];

  function applyCardColors(el, tissueId) {
    const oc = window.OmicsColors;
    if (oc && typeof oc.applyTissueCardColors === 'function') {
      oc.applyTissueCardColors(el, tissueId);
    }
  }

  // ── init ────────────────────────────────────────────────────
  async function init() {
    try {
      const r = await fetch('/api/multiomics/summary');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      summaryData = await r.json();
    } catch (err) {
      console.warn('[home_omics] failed to load summary:', err);
      const section = document.getElementById('omics-atlas');
      if (section) section.style.display = 'none';
      return;
    }

    carouselQueue = buildCarouselQueue();
    renderTotals();
    renderTissues();
    renderCellLines();
    applyLayoutBounds();
    bindCardInteractions();
    bindCapsuleToggle();
    initCharts();
    bindI18n();
    window.addEventListener('resize', onResize);
  }

  function buildCarouselQueue() {
    const tissues = TISSUE_ORDER.filter((tx) => {
      const td = summaryData.tissues && summaryData.tissues[tx];
      return td && td.total_files > 0;
    });
    const cells = (summaryData.cell_lines || []).filter((c) => {
      const td = summaryData.tissues && summaryData.tissues[c];
      return td && td.total_files > 0;
    });
    return [...tissues, ...cells];
  }

  function periodKey(p) {
    return (PERIOD_RANK[p] != null ? PERIOD_RANK[p] : 99);
  }
  function sortPeriods(list) {
    return [...list].sort((a, b) => periodKey(a) - periodKey(b) || a.localeCompare(b));
  }
  function sortByCountDesc(entries) {
    return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // ── KPI strip ───────────────────────────────────────────────
  function renderTotals() {
    const tot = summaryData.totals || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('omics-n-files',   fmtNum(tot.total_files));
    set('omics-n-samples', fmtNum(tot.samples));
    set('omics-n-stages',  (tot.periods || []).length);
    set('omics-n-tissues', (tot.tissues || []).length);
    set('omics-n-assays',  (tot.assays  || []).length);
    set('card4-files',     fmtNum(tot.total_files));
    set('card4-tissues',   (tot.tissues || []).length);
    set('card4-assays',    (tot.assays  || []).length);
  }

  function densityOf(tissue) {
    const td = summaryData.tissues && summaryData.tissues[tissue];
    if (!td) return 0;
    const total = (summaryData.totals && summaryData.totals.assays || []).length || 1;
    return Math.min(1, (td.assays || []).length / total);
  }

  // ── row-1 cards ─────────────────────────────────────────────
  function renderTissues() {
    const wrap = document.getElementById('omics-tissues');
    if (!wrap) return;
    wrap.innerHTML = '';

    TISSUE_ORDER.forEach((tissue) => {
      const td = summaryData.tissues && summaryData.tissues[tissue];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'omics-tissue-card';
      btn.dataset.tissue = tissue;
      btn.style.setProperty('--density', densityOf(tissue).toFixed(3));
      applyCardColors(btn, tissue);

      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = tissueLabel(tissue);
      btn.appendChild(nameEl);

      const meta = document.createElement('span');
      meta.className = 'meta';
      const fileCount = (td && td.total_files) || 0;
      const assayCount = ((td && td.assays) || []).length;
      meta.textContent = `${fmtNum(fileCount)} · ${assayCount}`;
      btn.appendChild(meta);

      if (!td || fileCount === 0) {
        btn.classList.add('empty');
        btn.disabled = true;
      }
      wrap.appendChild(btn);
    });
  }

  function renderCellLines() {
    const wrap = document.getElementById('omics-cells');
    if (!wrap) return;
    wrap.innerHTML = '';
    const list = summaryData.cell_lines || [];
    if (list.length === 0) {
      const w = document.getElementById('omics-cells-wrap');
      if (w) w.style.display = 'none';
      return;
    }
    list.forEach((name) => {
      const td = summaryData.tissues && summaryData.tissues[name];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'omics-tissue-card cell-line';
      btn.dataset.tissue = name;
      btn.style.setProperty('--density', densityOf(name).toFixed(3));
      applyCardColors(btn, name);

      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = tissueLabel(name);
      btn.appendChild(nameEl);

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${fmtNum((td && td.total_files) || 0)} · ${((td && td.assays) || []).length}`;
      btn.appendChild(meta);

      wrap.appendChild(btn);
    });
  }

  function updateCardHighlight(tissue, isPinned) {
    document.querySelectorAll('.omics-tissue-card').forEach((c) => {
      const on = c.dataset.tissue === tissue;
      c.classList.toggle('is-active', on);
      c.classList.toggle('is-pinned', on && isPinned);
    });
  }

  function clearCardHighlight() {
    document.querySelectorAll('.omics-tissue-card').forEach((c) => {
      c.classList.remove('is-active', 'is-pinned');
    });
  }

  function bindCardInteractions() {
    document.querySelectorAll('.omics-tissue-card').forEach((card) => {
      const tissue = card.dataset.tissue;
      if (!tissue || card.disabled) return;

      card.addEventListener('click', () => {
        pinnedTissue = tissue;
        stopCarousel();
        syncCharts(true);
      });
    });
  }

  function bindCapsuleToggle() {
    const capsule = document.getElementById('omics-mode-capsule');
    if (!capsule) return;
    capsule.querySelectorAll('.capsule-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode === viewMode) return;
        pinnedTissue = null;
        setViewMode(mode, true);
      });
    });
  }

  function setViewMode(mode, animate) {
    viewMode = mode;
    const capsule = document.getElementById('omics-mode-capsule');
    if (capsule) {
      capsule.querySelectorAll('.capsule-item').forEach((btn) => {
        const active = btn.dataset.mode === mode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }
    if (mode === 'overview') {
      stopCarousel();
      clearCardHighlight();
      pinnedTissue = null;
      syncCharts(animate);
    } else {
      pinnedTissue = null;
      carouselIdx = 0;
      syncCharts(animate);
      startCarousel();
    }
  }

  function getActiveTissue() {
    if (pinnedTissue) return pinnedTissue;
    if (viewMode === 'carousel') return carouselQueue[carouselIdx] || null;
    return null;
  }

  function startCarousel() {
    stopCarousel();
    if (viewMode !== 'carousel' || carouselQueue.length === 0) return;
    if (pinnedTissue) return;
    carouselTimer = setInterval(advanceCarousel, CAROUSEL_MS);
  }

  function stopCarousel() {
    if (carouselTimer) {
      clearInterval(carouselTimer);
      carouselTimer = null;
    }
  }

  function advanceCarousel() {
    if (viewMode !== 'carousel' || pinnedTissue) return;
    carouselIdx = (carouselIdx + 1) % carouselQueue.length;
    syncCharts(true);
  }

  function updateChartsTitle(text, tissue, animate) {
    const title = document.getElementById('omics-charts-title');
    const sub = document.getElementById('omics-tissue-sub');
    if (sub) {
      if (tissue) {
        const td = summaryData.tissues && summaryData.tissues[tissue];
        const subtitleKey = td && td.is_cell_line
          ? 'home.omics.modal.subtitle_cell'
          : 'home.omics.modal.subtitle_tissue';
        sub.textContent = t(subtitleKey, '');
        sub.hidden = false;
        sub.style.color = colors().colorForTissue(tissue);
      } else {
        sub.textContent = '';
        sub.hidden = true;
        sub.style.color = '';
      }
    }
    if (!title) return;
    if (!animate) {
      title.textContent = text;
      return;
    }
    title.classList.add('is-changing');
    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => {
      title.textContent = text;
      title.classList.remove('is-changing');
    }, TRANSITION_MS * 0.45);
  }

  function syncCharts(animate) {
    const tissue = getActiveTissue();

    // Global overview only when capsule is on Overview AND no tissue is focused.
    if (viewMode === 'overview' && !tissue) {
      setChartsBodyMode('global');
      updateChartsTitle(t('home.omics.charts.title', 'Multi-omics overview'), null, animate);
      clearCardHighlight();
      renderGlobalCharts(animate);
      return;
    }

    if (tissue) {
      setChartsBodyMode('tissue');
      updateChartsTitle(tissueLabel(tissue), tissue, animate);
      updateCardHighlight(tissue, tissue === pinnedTissue);
      renderTissueCharts(tissue, animate);
      return;
    }

    setChartsBodyMode('global');
    updateChartsTitle(t('home.omics.charts.title', 'Multi-omics overview'), null, animate);
    renderGlobalCharts(animate);
  }

  function setChartsBodyMode(mode) {
    const row = document.getElementById('omics-charts-row');
    const body = document.getElementById('omics-charts-body');
    if (row) {
      row.classList.toggle('omics-row2--tissue', mode === 'tissue');
      row.classList.toggle('omics-row2--global', mode === 'global');
    }
    if (body) {
      body.classList.toggle('omics-charts-body--tissue', mode === 'tissue');
      body.classList.toggle('omics-charts-body--global', mode === 'global');
    }
  }

  /** Reserve stable height/width from the largest tissue matrix to avoid carousel layout jump. */
  function applyLayoutBounds() {
    const body = document.getElementById('omics-charts-body');
    if (!body || !summaryData) return;

    let maxPeriods = 0;
    let maxAssays = 0;
    Object.values(summaryData.tissues || {}).forEach((td) => {
      maxPeriods = Math.max(maxPeriods, (td.periods || []).length);
      maxAssays = Math.max(maxAssays, (td.assays || []).length);
    });

    const matrixMinH = 38 + (maxPeriods + 1) * 34;
    body.style.setProperty('--omics-matrix-min-h', `${matrixMinH}px`);
    body.style.setProperty('--omics-matrix-min-w', `${Math.max(640, 120 + maxAssays * 72)}px`);
  }

  // ── data aggregation ────────────────────────────────────────
  function aggregateGlobal() {
    const byPeriod = {};
    const byTissue = {};
    const byAssay = {};
    Object.entries(summaryData.tissues || {}).forEach(([tissue, td]) => {
      byTissue[tissue] = td.total_files || 0;
      Object.entries(td.period_summary || {}).forEach(([p, pe]) => {
        byPeriod[p] = (byPeriod[p] || 0) + (pe.count || 0);
      });
      Object.entries(td.assay_summary || {}).forEach(([a, ae]) => {
        byAssay[a] = (byAssay[a] || 0) + (ae.count || 0);
      });
    });
    return { byPeriod, byTissue, byAssay };
  }

  // ── ECharts helpers ─────────────────────────────────────────
  function disposeCharts() {
    chartInstances.forEach((c) => { try { c.dispose(); } catch (_) { /* noop */ } });
    chartInstances = [];
  }

  function initChartEl(el) {
    if (!window.echarts || !el) return null;
    const inst = window.echarts.init(el, null, { renderer: 'canvas' });
    chartInstances.push(inst);
    return inst;
  }

  /** Apply options after layout so entry animation & slice borders render correctly. */
  function mountChart(el, getOption) {
    const inst = initChartEl(el);
    if (!inst) return null;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try { inst.resize(); } catch (_) { /* noop */ }
        inst.setOption(getOption());
      });
    });
    return inst;
  }

  function pieSeriesAnim() {
    const CA = window.ChartAnim;
    if (CA && CA.PIE_SERIES) return Object.assign({}, CA.PIE_SERIES);
    return {
      animation: true,
      animationDuration: 1100,
      animationDurationUpdate: 750,
      animationEasing: 'cubicOut',
      animationEasingUpdate: 'cubicInOut',
      animationType: 'expansion',
      clockwise: true,
      startAngle: 90,
      animationDelay: (idx) => idx * 65,
      itemStyle: { borderColor: '#ffffff', borderWidth: 2 },
    };
  }

  function barSeriesAnim() {
    const CA = window.ChartAnim;
    if (CA && CA.BAR_ANIM) return Object.assign({}, CA.BAR_ANIM);
    return {
      animation: true,
      animationDuration: 1000,
      animationDurationUpdate: 650,
      animationEasing: 'cubicOut',
      animationEasingUpdate: 'cubicInOut',
    };
  }

  function entriesToPieData(entries, colorFn, labelFn) {
    const CA = window.ChartAnim;
    return entries.map(([name, value]) => {
      const label = labelFn ? labelFn(name) : name;
      const color = colorFn(name);
      if (CA && CA.pieDataItem) return CA.pieDataItem(label, value, color);
      return { name: label, value, itemStyle: { color, borderColor: '#fff', borderWidth: 2 } };
    });
  }

  function pieOption(data, title, opts) {
    const o = opts || {};
    const many = o.compact || data.length > 6;
    return {
      animation: true,
      animationDuration: 1100,
      animationDurationUpdate: 750,
      animationEasing: 'cubicOut',
      animationEasingUpdate: 'cubicInOut',
      title: title ? {
        text: title,
        left: many ? '28%' : 'center',
        top: 0,
        textStyle: { fontSize: 11, fontWeight: 600, color: '#64748b' },
      } : undefined,
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: many ? {
        type: 'scroll',
        orient: 'vertical',
        right: 4,
        top: 'middle',
        height: '78%',
        textStyle: { fontSize: 10, color: '#475569' },
        pageIconSize: 10,
        pageTextStyle: { fontSize: 10 },
      } : {
        type: 'scroll',
        bottom: 0,
        left: 'center',
        textStyle: { fontSize: 10 },
      },
      series: [Object.assign({}, pieSeriesAnim(), {
        type: 'pie',
        radius: many ? ['36%', '56%'] : ['38%', '60%'],
        center: many ? ['32%', '52%'] : ['50%', '48%'],
        avoidLabelOverlap: true,
        label: {
          show: !many,
          fontSize: 9,
          formatter: '{b}\n{d}%',
        },
        labelLine: { show: !many, length: 8, length2: 6 },
        emphasis: {
          scale: true,
          scaleSize: 6,
          label: { show: true, fontSize: 10, fontWeight: 600 },
        },
        data,
      })],
    };
  }

  function barOption(entries, colorFn, labelFn, title, horizontal, preserveOrder) {
    const sorted = preserveOrder ? [...entries] : sortByCountDesc([...entries]);
    const labels = sorted.map(([n]) => (labelFn ? labelFn(n) : n));
    const values = sorted.map(([, v]) => v);
    const barColors = sorted.map(([n]) => colorFn(n));

    const barAnim = barSeriesAnim();

    if (horizontal) {
      const yLabels = [...labels].reverse();
      const dataVals = [...values].reverse();
      const colorsRev = [...barColors].reverse();
      const maxV = dataVals.length ? Math.max(...dataVals) : 0;
      return Object.assign({}, barAnim, {
        title: title ? {
          text: title,
          left: 'center',
          top: 0,
          textStyle: { fontSize: 11, fontWeight: 600, color: '#64748b' },
        } : undefined,
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 4, right: 14, top: title ? 26 : 8, bottom: 8, containLabel: true },
        xAxis: {
          type: 'value',
          min: 0,
          max: maxV + Math.max(0.5, maxV * 0.35),
          minInterval: 1,
          splitLine: { lineStyle: { color: '#e2e8f0' } },
        },
        yAxis: {
          type: 'category',
          data: yLabels,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { fontSize: 10, color: '#475569', width: 90, overflow: 'truncate' },
        },
        series: [Object.assign({}, barAnim, {
          type: 'bar',
          data: dataVals.map((v, i) => ({
            value: v,
            itemStyle: { color: colorsRev[i], borderRadius: [0, 4, 4, 0] },
          })),
          barWidth: BAR_SIZE,
          barMaxWidth: BAR_SIZE,
          barCategoryGap: '35%',
          label: { show: true, position: 'right', fontSize: 10, color: '#64748b' },
        })],
      });
    }

    return Object.assign({}, barAnim, {
      title: title ? {
        text: title,
        left: 'center',
        top: 0,
        textStyle: { fontSize: 11, fontWeight: 600, color: '#64748b' },
      } : undefined,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 8, right: 8, top: title ? 28 : 10, bottom: 48, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { fontSize: 10, rotate: labels.length > 6 ? 35 : 0, color: '#475569' },
      },
      yAxis: {
        type: 'value',
        min: 0,
        minInterval: 1,
        splitLine: { lineStyle: { color: '#e2e8f0' } },
      },
      series: [Object.assign({}, barAnim, {
        type: 'bar',
        data: values.map((v, i) => ({
          value: v,
          itemStyle: { color: barColors[i], borderRadius: [4, 4, 0, 0] },
        })),
        barWidth: BAR_SIZE,
        barMaxWidth: BAR_SIZE,
        barCategoryGap: '35%',
        label: { show: true, position: 'top', fontSize: 10, color: '#64748b' },
      })],
    });
  }

  function buildPanelHtml(dimKey, pieId, barId) {
    const dimLabel = t(`home.omics.charts.${dimKey}`, dimKey);
    return `
      <div class="omics-chart-panel" data-dim="${dimKey}">
        <h4 class="omics-chart-dim-title">${dimLabel}</h4>
        <div class="omics-chart-pie" id="${pieId}"></div>
        <div class="omics-chart-bar" id="${barId}"></div>
      </div>`;
  }

  function renderPanels(config, animate, onComplete) {
    const grid = document.getElementById('omics-charts-grid');
    const panel = document.getElementById('omics-tissue-panel');
    const body = document.getElementById('omics-charts-body');
    if (!grid) return;
    if (panel && !onComplete) panel.hidden = true;
    grid.hidden = false;

    const doRender = () => {
      disposeCharts();
      grid.innerHTML = '';
      grid.classList.remove('is-fading');
      if (body) body.classList.remove('is-fading');
      grid.classList.toggle('omics-charts-grid--detail', config.length === 2);

      const uid = Date.now();
      config.forEach((cfg, idx) => {
        const pieId = `omics-pie-${uid}-${idx}`;
        const barId = `omics-bar-${uid}-${idx}`;
        grid.insertAdjacentHTML('beforeend', buildPanelHtml(cfg.key, pieId, barId));

        const pieEl = document.getElementById(pieId);
        const barEl = document.getElementById(barId);
        const pieData = entriesToPieData(cfg.entries, cfg.colorFn, cfg.labelFn);
        const pieTitle = t('home.omics.charts.pie', 'Distribution');
        const barTitle = t('home.omics.charts.bar', 'File counts');
        mountChart(pieEl, () => pieOption(pieData, pieTitle, { compact: cfg.compactPie }));
        mountChart(barEl, () => barOption(
          cfg.entries, cfg.colorFn, cfg.labelFn, barTitle,
          cfg.horizontal !== false, cfg.preserveOrder === true,
        ));
      });
      requestAnimationFrame(() => requestAnimationFrame(resizeCharts));
      if (typeof onComplete === 'function') onComplete();
    };

    if (!animate) {
      doRender();
      return;
    }
    grid.classList.add('is-fading');
    if (body && onComplete) body.classList.add('is-fading');
    setTimeout(doRender, TRANSITION_MS);
  }

  function initCharts() {
    setViewMode('overview', false);
  }

  function renderGlobalCharts(animate) {
    const { byPeriod, byTissue, byAssay } = aggregateGlobal();
    const c = colors();

    renderPanels([
      {
        key: 'period',
        entries: sortPeriods(Object.keys(byPeriod)).map((p) => [p, byPeriod[p]]),
        colorFn: (n) => c.colorForPeriod(n),
        labelFn: periodLabel,
        preserveOrder: true,
      },
      {
        key: 'tissue',
        entries: sortByCountDesc(Object.entries(byTissue).filter(([, v]) => v > 0)),
        colorFn: (n) => c.colorForTissue(n),
        labelFn: tissueLabel,
        compactPie: true,
      },
      {
        key: 'assay',
        entries: sortByCountDesc(Object.entries(byAssay)),
        colorFn: (n) => c.colorForAssay(n),
        compactPie: true,
      },
    ], animate);
  }

  function renderTissueMatrixFooter(tissue) {
    const panel = document.getElementById('omics-tissue-panel');
    const td = summaryData.tissues && summaryData.tissues[tissue];
    if (!panel || !td) return;

    panel.hidden = false;
    panel.classList.remove('is-fading');

    const metaWrap = document.getElementById('omics-tissue-meta');
    if (metaWrap) {
      metaWrap.innerHTML = '';
      const addMeta = (labelKey, val) => {
        const item = document.createElement('div');
        item.className = 'meta-item';
        item.innerHTML = `<b>${val}</b> <span>${t(labelKey, labelKey)}</span>`;
        metaWrap.appendChild(item);
      };
      addMeta('home.omics.modal.total',   fmtNum(td.total_files));
      addMeta('home.omics.modal.periods', (td.periods || []).length);
      addMeta('home.omics.modal.assays',  (td.assays  || []).length);
    }

    renderMatrix(td, 'omics-inline-matrix');
  }

  function renderTissueCharts(tissue, animate) {
    const td = summaryData.tissues && summaryData.tissues[tissue];
    if (!td) return;

    const c = colors();
    const periodEntries = sortPeriods(Object.keys(td.period_summary || {}))
      .map((p) => [p, (td.period_summary[p] || {}).count || 0])
      .filter(([, v]) => v > 0);
    const assayEntries = sortByCountDesc(
      Object.entries(td.assay_summary || {}).map(([a, ae]) => [a, ae.count || 0]),
    );

    const panel = document.getElementById('omics-tissue-panel');
    const panelVisible = panel && !panel.hidden;
    const chartConfig = [
      {
        key: 'period',
        entries: periodEntries,
        colorFn: (n) => c.colorForPeriod(n),
        labelFn: periodLabel,
        preserveOrder: true,
      },
      {
        key: 'assay',
        entries: assayEntries,
        colorFn: (n) => c.colorForAssay(n),
        compactPie: true,
      },
    ];

    const finish = () => renderTissueMatrixFooter(tissue);

    // Carousel tissue→tissue: keep panel mounted, only swap chart/matrix content.
    if (panelVisible) {
      renderPanels(chartConfig, animate, finish);
      return;
    }

    if (!animate) {
      renderPanels(chartConfig, false, finish);
      return;
    }

    renderPanels(chartConfig, true, finish);
  }

  function resizeCharts() {
    chartInstances.forEach((c) => { try { c.resize(); } catch (_) { /* noop */ } });
  }

  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeCharts, 120);
  }

  // ── matrix (inline in row 2) ────────────────────────────────
  function renderMatrix(td, wrapId) {
    const wrap = document.getElementById(wrapId || 'omics-inline-matrix');
    if (!wrap) return;
    wrap.innerHTML = '';
    const periods = sortPeriods(td.periods || []);
    const assays  = td.assays  || [];
    if (periods.length === 0 || assays.length === 0) {
      wrap.textContent = '—';
      return;
    }
    let maxC = 0;
    periods.forEach((p) => {
      const row = (td.matrix || {})[p] || {};
      assays.forEach((a) => { if ((row[a] || 0) > maxC) maxC = row[a]; });
    });

    const table = document.createElement('table');
    table.className = 'omics-matrix';

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    const corner = document.createElement('th');
    corner.textContent = t('home.omics.modal.col_period', 'Stage \\ Assay');
    trh.appendChild(corner);
    assays.forEach((a) => {
      const th = document.createElement('th');
      th.textContent = a;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    periods.forEach((p) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = periodLabel(p);
      tr.appendChild(th);
      const row = (td.matrix || {})[p] || {};
      assays.forEach((a) => {
        const c = row[a] || 0;
        const td_ = document.createElement('td');
        td_.className = 'cell' + (c === 0 ? ' zero' : '');
        td_.textContent = c === 0 ? '—' : fmtNum(c);
        if (c > 0 && maxC > 0) {
          td_.style.setProperty('--d', (c / maxC).toFixed(3));
        }
        tr.appendChild(td_);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ── i18n ────────────────────────────────────────────────────
  function bindI18n() {
    document.addEventListener('i18nchange', () => {
      renderTissues();
      renderCellLines();
      bindCardInteractions();
      syncCharts(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
