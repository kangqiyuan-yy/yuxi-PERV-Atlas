// Shared ECharts pie / bar animation & slice styling.
(function (global) {
  'use strict';

  const SLICE_BORDER = { borderColor: '#ffffff', borderWidth: 2 };

  function withSliceBorder(itemStyle) {
    return Object.assign({}, SLICE_BORDER, itemStyle || {});
  }

  function pieDataItem(name, value, color) {
    return {
      name,
      value,
      itemStyle: withSliceBorder(color != null ? { color } : undefined),
    };
  }

  /** Pie: white slice gaps + clockwise sector expansion. */
  const PIE_SERIES = {
    animation: true,
    animationDuration: 1100,
    animationDurationUpdate: 750,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicInOut',
    animationType: 'expansion',
    clockwise: true,
    startAngle: 90,
    animationDelay: (idx) => idx * 65,
    itemStyle: Object.assign({}, SLICE_BORDER),
  };

  /** Bar: grow from axis baseline (no stagger). */
  const BAR_ANIM = {
    animation: true,
    animationDuration: 1000,
    animationDurationUpdate: 650,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicInOut',
  };

  global.ChartAnim = {
    SLICE_BORDER,
    withSliceBorder,
    pieDataItem,
    PIE_SERIES,
    BAR_ANIM,
  };
}(window));
