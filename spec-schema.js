/*
 * StyleGrab · spec-schema.js
 * sp1 协议定义：默认值、归一化、校验、序列化、单位换算、人读摘要
 *
 * 单位约定（整个 sp1 只有一种长度单位）：
 *   所有长度都是「占画布宽度的比例」（u）。例如 strokes.series = 0.0032
 *   表示数据线宽度 = 画布宽度 × 0.32%。点数换算：pt = u × 目标宽度(mm) × 2.8346
 * 这样同一份 spec 套到 85mm 单栏和 170mm 双栏上都不会走形。
 */
(function (global) {
  'use strict';

  var PROTOCOL = 'sp1';
  var BUILDER = { name: 'StyleGrab', version: '0.1.7' };

  // 六类单 panel 图型
  var CHART_TYPES = ['bar', 'line', 'scatter', 'box', 'heatmap', 'errorbar'];

  var DEFAULT_SPEC = {
    protocol: PROTOCOL,
    generator: BUILDER,
    createdAt: null,

    meta: {
      sourceName: '',
      sourceWidth: 0,
      sourceHeight: 0,
      canvasAspect: 1.4,      // 宽 / 高
      chartType: 'bar',
      inset: { left: 0, top: 0, right: 0, bottom: 0 } // 相对参考图的内容内缩，用于手动修正裁剪
    },

    // 四边留白，均为「画布宽度」的比例
    layout: { plotLeft: 0.13, plotRight: 0.05, plotTop: 0.10, plotBottom: 0.16 },

    colors: {
      background: '#ffffff',
      axis: '#222222',
      text: '#222222',
      grid: '#dddddd',
      series: ['#3a8778'],
      seriesRole: 'area'      // area = 按面积排序；order = 按出现顺序
    },

    // 线宽类，全部为画布宽度比例
    strokes: {
      axis: 0.0018,
      series: 0.0032,
      markerEdge: 0.0012,
      errorbar: 0.0022,
      grid: 0.0009,
      refLine: 0.0014
    },

    // 字号为「字高」占画布宽度的比例；渲染时按 1em ≈ 1.32 × 字高 换算
    text: {
      title: 0.034,
      axisTitle: 0.027,
      tickLabel: 0.021,
      legend: 0.023,
      family: 'sans',         // sans | serif | condensed
      weight: 'normal'        // normal | medium | bold
    },

    ticks: { direction: 'out', length: 0.006, xCount: 6, yCount: 5 },

    grid: { mode: 'none', style: 'solid', alpha: 0.6 },   // mode: none | h | v | both

    legend: { visible: false, position: 'top-right', frame: false, columns: 1 },

    frame: { border: false, zeroLine: false },

    markers: { shape: 'circle', radius: 0.006, fillAlpha: 1 },

    // 显著性字母（柱/箱线图上方的 a/b/c 或 A/B/C）
    letters: { visible: true, size: 0.012, weight: 'bold' },

    specific: {
      bar: { widthRatio: 0.62, edgeWidth: 0.001, gap: 0 },
      line: { smooth: false, markerFill: 'white', lineMode: 'straight', lineOffset: 0 },
      scatter: { radius: 0.005, fillAlpha: 0.9 },
      box: { whisker: 1.5, capWidth: 0.022 },
      heatmap: { gradient: ['#f4f9f7', '#2c6b5d'], cellGap: 0.008 },
      errorbar: { capWidth: 0.012 }
    },

    // 每项参数的可信度 0~1；low 列表里的是「测不准」的项，UI 会标灰
    confidence: { overall: 0, items: {}, low: [] },

    thumbnail: ''             // 480px 宽 JPEG 的 base64，便于主站导入后叠加校验
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function blankSpec() {
    var s = clone(DEFAULT_SPEC);
    s.createdAt = new Date().toISOString();
    s.confidence = { overall: 0, items: {}, low: [] };
    return s;
  }

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  // 深度合并：以默认值为底，未知字段保留（向前兼容），数值做范围收敛
  function normalizeSpec(input) {
    var out = clone(DEFAULT_SPEC);
    if (!isObj(input)) return out;
    out.protocol = PROTOCOL;
    out.generator = isObj(input.generator) ? input.generator : BUILDER;
    out.createdAt = input.createdAt || null;
    mergeInto(out, input);
    clampAll(out);
    if (!Array.isArray(out.colors.series) || !out.colors.series.length) out.colors.series = ['#3a8778'];
    out.colors.series = out.colors.series.slice(0, 12).map(function (c) {
      return /^#[0-9a-f]{6}$/i.test(String(c)) ? String(c).toLowerCase() : '#888888';
    });
    if (!Array.isArray(out.specific.heatmap.gradient) || out.specific.heatmap.gradient.length < 2) {
      out.specific.heatmap.gradient = ['#f4f9f7', '#2c6b5d'];
    }
    if (CHART_TYPES.indexOf(out.meta.chartType) < 0) out.meta.chartType = 'bar';
    return out;
  }

  function mergeInto(target, src) {
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (isObj(v) && isObj(target[k])) mergeInto(target[k], v);
      else if (v !== undefined && v !== null) target[k] = isObj(v) ? clone(v) : v;
    });
  }

  function clampNum(v, lo, hi, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function clampAll(s) {
    s.meta.canvasAspect = clampNum(s.meta.canvasAspect, 0.4, 4, 1.4);
    ['left', 'top', 'right', 'bottom'].forEach(function (k) {
      s.meta.inset[k] = clampNum(s.meta.inset[k], 0, 0.4, 0);
    });
    // 四边留白交集护栏：绘图区至少占 20%
    s.layout.plotLeft = clampNum(s.layout.plotLeft, 0, 0.45, 0.13);
    s.layout.plotRight = clampNum(s.layout.plotRight, 0, 0.45, 0.05);
    s.layout.plotTop = clampNum(s.layout.plotTop, 0, 0.45, 0.10);
    s.layout.plotBottom = clampNum(s.layout.plotBottom, 0, 0.55, 0.16);
    if (s.layout.plotLeft + s.layout.plotRight > 0.8) {
      var hSum = s.layout.plotLeft + s.layout.plotRight;
      s.layout.plotLeft *= 0.8 / hSum; s.layout.plotRight *= 0.8 / hSum;
    }
    if (s.layout.plotTop + s.layout.plotBottom > 0.85) {
      var vSum = s.layout.plotTop + s.layout.plotBottom;
      s.layout.plotTop *= 0.85 / vSum; s.layout.plotBottom *= 0.85 / vSum;
    }
    Object.keys(s.strokes).forEach(function (k) {
      s.strokes[k] = clampNum(s.strokes[k], 0, 0.03, DEFAULT_SPEC.strokes[k]);
    });
    ['title', 'axisTitle', 'tickLabel', 'legend'].forEach(function (k) {
      s.text[k] = clampNum(s.text[k], 0.008, 0.08, DEFAULT_SPEC.text[k]);
    });
    if (['sans', 'serif', 'condensed'].indexOf(s.text.family) < 0) s.text.family = 'sans';
    if (['normal', 'medium', 'bold'].indexOf(s.text.weight) < 0) s.text.weight = 'normal';
    s.ticks.length = clampNum(s.ticks.length, 0, 0.03, 0.006);
    s.ticks.xCount = Math.round(clampNum(s.ticks.xCount, 0, 40, 6));
    s.ticks.yCount = Math.round(clampNum(s.ticks.yCount, 0, 40, 5));
    if (s.ticks.direction !== 'in') s.ticks.direction = 'out';
    if (['none', 'h', 'v', 'both'].indexOf(s.grid.mode) < 0) s.grid.mode = 'none';
    if (s.grid.style !== 'dash') s.grid.style = 'solid';
    s.grid.alpha = clampNum(s.grid.alpha, 0, 1, 0.6);
    s.markers.radius = clampNum(s.markers.radius, 0, 0.04, 0.006);
    s.markers.fillAlpha = clampNum(s.markers.fillAlpha, 0.05, 1, 1);
    s.letters.visible = s.letters.visible !== false;
    s.letters.size = clampNum(s.letters.size, 0.006, 0.05, 0.012);
    if (['normal', 'medium', 'bold'].indexOf(s.letters.weight) < 0) s.letters.weight = 'bold';
    if (['white', 'series'].indexOf(s.specific.line.markerFill) < 0) s.specific.line.markerFill = 'white';
    if (['straight', 'smooth'].indexOf(s.specific.line.lineMode) < 0) s.specific.line.lineMode = 'straight';
    Object.keys(s.specific).forEach(function (g) {
      if (!isObj(s.specific[g])) return;
      Object.keys(s.specific[g]).forEach(function (k) {
        var v = s.specific[g][k];
        if (typeof v === 'number') s.specific[g][k] = clampNum(v, 0, 1, v);
      });
    });
    s.specific.bar.widthRatio = clampNum(s.specific.bar.widthRatio, 0.1, 1, 0.62);
    s.specific.scatter.fillAlpha = clampNum(s.specific.scatter.fillAlpha, 0.05, 1, 0.9);
    s.specific.heatmap.cellGap = clampNum(s.specific.heatmap.cellGap, 0, 0.05, 0.008);
    s.confidence.overall = clampNum(s.confidence.overall, 0, 1, 0);
  }

  function validateSpec(input) {
    var issues = [];
    if (!isObj(input)) return { ok: false, issues: ['文件内容不是 JSON 对象'] };
    if (input.protocol !== PROTOCOL) {
      issues.push('协议号是 ' + String(input.protocol || '（缺失）') + '，本版只接受 ' + PROTOCOL + '（未知字段会被忽略，但请确认来源）');
    }
    if (!isObj(input.layout)) issues.push('缺少 layout，已用默认版式');
    if (!isObj(input.colors) || !Array.isArray(input.colors.series)) issues.push('缺少 colors.series，已用默认配色');
    if (CHART_TYPES.indexOf(input?.meta?.chartType) < 0) issues.push('图型未识别，按柱状图处理');
    return { ok: issues.length === 0, issues: issues };
  }

  function serialize(spec) { return JSON.stringify(normalizeSpec(spec), null, 2); }

  function filename(spec) {
    var s = normalizeSpec(spec);
    var d = new Date();
    var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    var base = String(s.meta.sourceName || 'style').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 40);
    return 'stylegrab-' + s.meta.chartType + '-' + (base || 'style') + '-' + stamp + '.spec.json';
  }

  // 单位 → 物理尺寸
  function unitToPt(u, targetWidthMm) { return u * targetWidthMm * 2.834645669; }
  function unitToPx(u, targetWidthPx) { return u * targetWidthPx; }

  // 人读参数摘要（可复制到 Excel / Origin 手工填）
  function summaryText(spec) {
    var s = normalizeSpec(spec);
    var W = 85, W2 = 170;
    function mm(u) { return (u * W).toFixed(2); }
    function pt(u) { return unitToPt(u, W).toFixed(2); }
    var L = [];
    L.push('StyleGrab 样式参数（sp1）');
    L.push('图型：' + s.meta.chartType + '　画布宽高比：' + s.meta.canvasAspect.toFixed(2) + ' : 1');
    L.push('');
    L.push('【画布与版式】（占画布宽度的百分比）');
    L.push('左留白 ' + (s.layout.plotLeft * 100).toFixed(1) + '%　右留白 ' + (s.layout.plotRight * 100).toFixed(1) + '%');
    L.push('上留白 ' + (s.layout.plotTop * 100).toFixed(1) + '%　下留白 ' + (s.layout.plotBottom * 100).toFixed(1) + '%');
    L.push('');
    L.push('【线条】85mm 单栏下：轴线 ' + pt(s.strokes.axis) + ' pt（' + mm(s.strokes.axis) + ' mm）　数据线 ' + pt(s.strokes.series) + ' pt（' + mm(s.strokes.series) + ' mm）');
    L.push('误差棒 ' + pt(s.strokes.errorbar) + ' pt　网格线 ' + pt(s.strokes.grid) + ' pt　标记描边 ' + pt(s.strokes.markerEdge) + ' pt');
    L.push('');
    L.push('【文字】标题 ' + pt(s.text.title) + ' pt　轴标题 ' + pt(s.text.axisTitle) + ' pt　刻度 ' + pt(s.text.tickLabel) + ' pt　图例 ' + pt(s.text.legend) + ' pt');
    L.push('字族 ' + s.text.family + '　字重 ' + s.text.weight);
    if (W2 !== W) L.push('（170mm 双栏：上述 pt 值 × 2）');
    L.push('');
    L.push('【配色】背景 ' + s.colors.background + '　文字 ' + s.colors.text + '　轴线 ' + s.colors.axis + '　网格 ' + s.colors.grid);
    L.push('系列色（' + s.colors.series.length + '）：' + s.colors.series.join(' '));
    L.push('');
    L.push('【刻度与网格】刻度朝' + (s.ticks.direction === 'in' ? '内' : '外') + '，长度 ' + pt(s.ticks.length) + ' pt，X ' + s.ticks.xCount + ' 个 / Y ' + s.ticks.yCount + ' 个');
    L.push('网格：' + ({ none: '无', h: '仅横线', v: '仅竖线', both: '双向' })[s.grid.mode] + '（' + (s.grid.style === 'dash' ? '虚线' : '实线') + '，透明度 ' + s.grid.alpha.toFixed(2) + '）');
    L.push('外框：' + (s.frame.border ? '有' : '无') + '　零线：' + (s.frame.zeroLine ? '有' : '无') + '　图例：' + (s.legend.visible ? s.legend.position : '无'));
    L.push('');
    L.push('【可信度】整体 ' + Math.round(s.confidence.overall * 100) + '%');
    if (s.confidence.low && s.confidence.low.length) L.push('测不准的项：' + s.confidence.low.join('、'));
    return L.join('\n');
  }

  var api = {
    PROTOCOL: PROTOCOL,
    BUILDER: BUILDER,
    CHART_TYPES: CHART_TYPES,
    DEFAULT_SPEC: DEFAULT_SPEC,
    clone: clone,
    blankSpec: blankSpec,
    normalizeSpec: normalizeSpec,
    validateSpec: validateSpec,
    serialize: serialize,
    filename: filename,
    unitToPt: unitToPt,
    unitToPx: unitToPx,
    summaryText: summaryText
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.StyleGrabSpec = api;
})(typeof window !== 'undefined' ? window : globalThis);
