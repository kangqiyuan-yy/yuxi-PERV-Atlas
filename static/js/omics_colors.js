// Multi-omics colors — single source for tissue/cell cards, pie charts, and bar charts.
(function (global) {
  'use strict';

  const ASSAY_COLORS = {
    ATAC: '#8dd3c7',
    H3K27ac: '#bf812d',
    H3K9ac: '#bc80bd',
    Pol2: '#a65628',
    H3K4me1: '#bebada',
    H3K4me3: '#fb8072',
    H3K36me3: '#80b1d3',
    H3K27me3: '#fdb462',
    H3K9me3: '#b3de69',
    RNA: '#fccde5',
    RNA_Rep1: '#fccde5',
    RNA_Rep2: '#fccde5',
    WGBS: '#d9d9d9',
    WGBS_Rep1: '#d9d9d9',
    WGBS_Rep2: '#d9d9d9',
    CTCF: '#cab2d6',
  };

  const PERIOD_COLORS = {
    S: '#6366f1',
    P21: '#8b5cf6',
    P50: '#ec4899',
    P100: '#f59e0b',
    P180: '#10b981',
  };

  /** Accent colors — used by cards (--accent) and ECharts pie/bar slices. */
  const TISSUE_COLORS = {
    Brain: '#ec4899',
    Lung: '#a78bfa',
    Heart: '#ef4444',
    Liver: '#d97706',
    Kidney: '#65a30d',
    Muscle: '#fb923c',
    Spleen: '#a855f7',
    Adipose: '#f59e0b',
    SInt: '#db2777',
    LInt: '#3b82f6',
    Testis: '#22c55e',
    PIEC: '#2dd4bf',
    PK15: '#818cf8',
    ST: '#fbbf24',
  };

  /** Soft background tints for cards (--accent-soft). */
  const TISSUE_SOFT_COLORS = {
    Brain: '#fdebf3',
    Lung: '#f2e7f6',
    Heart: '#fee6da',
    Liver: '#fef4db',
    Kidney: '#eaf3d3',
    Muscle: '#ffe0d8',
    Spleen: '#f2e7f6',
    Adipose: '#fef4db',
    SInt: '#fdebf3',
    LInt: '#e0ebf8',
    Testis: '#e4f4e4',
    PIEC: '#ccfbf1',
    PK15: '#eef2ff',
    ST: '#fef9c3',
  };

  const FALLBACK_PALETTE = [
    '#6366f1', '#ec4899', '#f59e0b', '#10b981',
    '#3b82f6', '#a855f7', '#ef4444', '#14b8a6', '#94a3b8',
  ];

  function colorForAssay(name) {
    if (ASSAY_COLORS[name]) return ASSAY_COLORS[name];
    let h = 0;
    const s = String(name);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
  }

  function colorForPeriod(name) {
    return PERIOD_COLORS[name] || colorForAssay(name);
  }

  function colorForTissue(name) {
    return TISSUE_COLORS[name] || colorForAssay(name);
  }

  function softColorForTissue(name) {
    return TISSUE_SOFT_COLORS[name] || '#f1f5f9';
  }

  /** Apply card CSS variables from the same palette as charts. */
  function applyTissueCardColors(el, name) {
    if (!el) return;
    el.style.setProperty('--accent', colorForTissue(name));
    el.style.setProperty('--accent-soft', softColorForTissue(name));
  }

  global.OmicsColors = {
    ASSAY_COLORS,
    PERIOD_COLORS,
    TISSUE_COLORS,
    TISSUE_SOFT_COLORS,
    colorForAssay,
    colorForPeriod,
    colorForTissue,
    softColorForTissue,
    applyTissueCardColors,
  };
}(typeof window !== 'undefined' ? window : globalThis));
