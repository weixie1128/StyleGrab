/*
 * StyleGrab · preview-renderer.js
 * 最小渲染器：只负责"按 sp1 样式把 6 类单 panel 图画出来"，用于闭环校验。
 * 不需要交互、不需要导出，只保证比例/线宽/字号严格按 spec 单位还原。
 */
(function (global) {
  'use strict';

  var FONT_STACK = {
    sans: '"Helvetica Neue", Helvetica, Arial, "Noto Sans SC", "Microsoft YaHei", sans-serif',
    serif: 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif',
    condensed: '"Arial Narrow", "Helvetica Neue", Arial, sans-serif'
  };
  var WEIGHT = { normal: 400, medium: 500, bold: 700 };

  function hexToRgb(hex) {
    var s = String(hex || '#000').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    if (!isFinite(n)) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function hexA(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }
  function mixHex(a, b, t) {
    var A = hexToRgb(a), B = hexToRgb(b);
    function m(x, y) { return Math.round(x + (y - x) * t); }
    return 'rgb(' + m(A.r, B.r) + ',' + m(A.g, B.g) + ',' + m(A.b, B.b) + ')';
  }

  // 固定随机源，保证同一 spec 每次渲染完全一致
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function geometry(spec, W, H) {
    var L = W * spec.layout.plotLeft;
    var R = W * (1 - spec.layout.plotRight);
    var T = W * spec.layout.plotTop;
    var B = H - W * spec.layout.plotBottom;
    if (B - T < H * 0.25) B = T + H * 0.4;
    if (R - L < W * 0.2) R = L + W * 0.3;
    return { L: L, R: R, T: T, B: B, w: R - L, h: B - T };
  }

  function fontOf(spec, sizeU, W) {
    var px = Math.max(4, (sizeU * W) / 0.72);
    return (WEIGHT[spec.text.weight] || 400) + ' ' + px.toFixed(1) + 'px ' + (FONT_STACK[spec.text.family] || FONT_STACK.sans);
  }

  function drawAxes(ctx, spec, W, H, g) {
    var axisW = Math.max(0.6, spec.strokes.axis * W);
    ctx.save();
    ctx.strokeStyle = spec.colors.axis;
    ctx.lineWidth = axisW;
    ctx.lineCap = 'butt';

    // 网格（在轴之前画，避免压住轴线）
    if (spec.grid.mode !== 'none') {
      ctx.save();
      ctx.strokeStyle = hexA(spec.colors.grid, spec.grid.alpha);
      ctx.lineWidth = Math.max(0.4, spec.strokes.grid * W);
      if (spec.grid.style === 'dash') ctx.setLineDash([Math.max(2, W * 0.006), Math.max(2, W * 0.005)]);
      var nx = Math.max(2, spec.ticks.xCount), ny = Math.max(2, spec.ticks.yCount);
      if (spec.grid.mode === 'h' || spec.grid.mode === 'both') {
        for (var i = 0; i <= ny; i++) {
          var y = g.B - (g.h * i) / ny;
          ctx.beginPath(); ctx.moveTo(g.L, y); ctx.lineTo(g.R, y); ctx.stroke();
        }
      }
      if (spec.grid.mode === 'v' || spec.grid.mode === 'both') {
        for (var j = 0; j <= nx; j++) {
          var x = g.L + (g.w * j) / nx;
          ctx.beginPath(); ctx.moveTo(x, g.B); ctx.lineTo(x, g.T); ctx.stroke();
        }
      }
      ctx.restore();
    }

    // 左轴 + 下轴
    ctx.beginPath();
    ctx.moveTo(g.L, g.T); ctx.lineTo(g.L, g.B); ctx.lineTo(g.R, g.B);
    ctx.stroke();

    // 外框
    if (spec.frame.border) {
      ctx.beginPath();
      ctx.moveTo(g.R, g.B); ctx.lineTo(g.R, g.T); ctx.lineTo(g.L, g.T);
      ctx.stroke();
    }

    // 零线
    if (spec.frame.zeroLine) {
      ctx.save();
      ctx.strokeStyle = hexA(spec.colors.axis, 0.55);
      ctx.lineWidth = Math.max(0.5, spec.strokes.refLine * W);
      ctx.beginPath();
      var mid = (g.T + g.B) / 2;
      ctx.moveTo(g.L, mid); ctx.lineTo(g.R, mid); ctx.stroke();
      ctx.restore();
    }

    // 刻度 + 刻度标签
    var tickLen = Math.max(1, spec.ticks.length * W);
    var inward = spec.ticks.direction === 'in';
    var dir = inward ? 1 : -1;
    ctx.strokeStyle = spec.colors.axis;
    ctx.lineWidth = Math.max(0.5, axisW * 0.9);
    ctx.fillStyle = spec.colors.text;
    ctx.font = fontOf(spec, spec.text.tickLabel, W);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    var nx2 = Math.max(2, spec.ticks.xCount), ny2 = Math.max(2, spec.ticks.yCount);
    for (var k = 0; k <= nx2; k++) {
      var xx = g.L + (g.w * k) / nx2;
      ctx.beginPath();
      ctx.moveTo(xx, g.B); ctx.lineTo(xx, g.B - dir * tickLen);
      ctx.stroke();
      ctx.fillText(k === 0 ? '0' : (k / nx2).toFixed(1), xx, g.B + (inward ? tickLen + 2 : 3));
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var m = 0; m <= ny2; m++) {
      var yy = g.B - (g.h * m) / ny2;
      ctx.beginPath();
      ctx.moveTo(g.L, yy); ctx.lineTo(g.L - dir * tickLen, yy);
      ctx.stroke();
      ctx.fillText(m === 0 ? '0' : (m / ny2).toFixed(1), g.L - (inward ? -tickLen - 3 : tickLen + 3), yy);
    }
    ctx.restore();
  }

  function drawTitles(ctx, spec, W, H, g, titleText, xText, yText) {
    ctx.save();
    ctx.fillStyle = spec.colors.text;
    // 标题
    if (spec.text.title > 0) {
      ctx.font = fontOf(spec, spec.text.title, W);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(titleText, (g.L + g.R) / 2, W * 0.022);
    }
    // X 轴标题
    ctx.font = fontOf(spec, spec.text.axisTitle, W);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(xText, (g.L + g.R) / 2, Math.min(H - W * 0.008, g.B + W * spec.layout.plotBottom * 0.62));
    // Y 轴标题（旋转）
    ctx.save();
    ctx.translate(W * spec.layout.plotLeft * 0.18, (g.T + g.B) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(yText, 0, 0);
    ctx.restore();
    ctx.restore();
  }

  function drawLegend(ctx, spec, W, H, g, labels) {
    if (!spec.legend.visible || !labels.length) return;
    var sw = W * 0.016, gap = W * 0.008;
    ctx.save();
    ctx.font = fontOf(spec, spec.text.legend, W);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    var maxW = 0;
    labels.forEach(function (t) { maxW = Math.max(maxW, ctx.measureText(t).width); });
    var itemH = W * spec.text.legend * 1.9;
    var boxW = sw + gap + maxW + W * 0.02;
    var boxH = itemH * labels.length + W * 0.012;
    var x = /right/.test(spec.legend.position) ? g.R - boxW - W * 0.008 : g.L + W * 0.008;
    var y = /bottom/.test(spec.legend.position) ? g.B - boxH - W * 0.008 : g.T + W * 0.008;
    if (spec.legend.frame) {
      ctx.strokeStyle = hexA(spec.colors.axis, 0.35);
      ctx.lineWidth = Math.max(0.5, spec.strokes.axis * W * 0.7);
      ctx.strokeRect(x, y, boxW, boxH);
    }
    labels.forEach(function (t, i) {
      var cy = y + W * 0.006 + itemH * (i + 0.5);
      ctx.fillStyle = spec.colors.series[i % spec.colors.series.length];
      ctx.fillRect(x + W * 0.008, cy - sw / 2, sw, sw * 0.62);
      ctx.fillStyle = spec.colors.text;
      ctx.fillText(t, x + W * 0.008 + sw + gap, cy);
    });
    ctx.restore();
  }

  function synthetic(spec) {
    var n = Math.max(1, Math.min(6, spec.colors.series.length));
    var rand = rng(20261109);
    var series = [];
    for (var s = 0; s < n; s++) {
      var arr = [];
      for (var i = 0; i < 6; i++) arr.push(0.28 + 0.55 * rand() * (0.7 + s * 0.12));
      series.push(arr);
    }
    return { n: n, series: series };
  }

  function drawData(ctx, spec, W, H, g) {
    var d = synthetic(spec);
    var colors = spec.colors.series;
    var type = spec.meta.chartType;
    var lineW = Math.max(1, spec.strokes.series * W);
    var mr = Math.max(1.5, spec.markers.radius * W);

    function col(i) { return colors[i % colors.length]; }
    function px(i, n) { return g.L + (g.w * (i + 0.5)) / n; }
    function py(v) { return g.B - g.h * v; }

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (type === 'bar' || type === 'errorbar') {
      var groups = 5;
      var slot = g.w / groups;
      var totalW = slot * spec.specific.bar.widthRatio;
      var bw = totalW / d.n;
      for (var gi = 0; gi < groups; gi++) {
        for (var si = 0; si < d.n; si++) {
          var v = d.series[si][gi % d.series[si].length];
          var x = g.L + gi * slot + (slot - totalW) / 2 + si * bw;
          var y = py(v), hgt = g.B - y;
          ctx.fillStyle = col(si);
          ctx.globalAlpha = spec.specific.scatter.fillAlpha > 0 ? 1 : 1;
          ctx.fillRect(x, y, Math.max(1, bw - 1), hgt);
          if (spec.specific.bar.edgeWidth > 0) {
            ctx.strokeStyle = hexA('#000000', 0.25);
            ctx.lineWidth = Math.max(0.5, spec.specific.bar.edgeWidth * W);
            ctx.strokeRect(x, y, Math.max(1, bw - 1), hgt);
          }
          if (type === 'errorbar') {
            var err = g.h * 0.06;
            var cx = x + bw / 2;
            var capW = spec.specific.errorbar.capWidth * W;
            ctx.strokeStyle = spec.colors.axis;
            ctx.lineWidth = Math.max(0.8, spec.strokes.errorbar * W);
            ctx.beginPath();
            ctx.moveTo(cx, y - err); ctx.lineTo(cx, y);
            ctx.moveTo(cx - capW / 2, y - err); ctx.lineTo(cx + capW / 2, y - err);
            ctx.stroke();
          }
        }
      }
    } else if (type === 'line') {
      for (var li = 0; li < d.n; li++) {
        ctx.strokeStyle = col(li);
        ctx.lineWidth = lineW;
        ctx.beginPath();
        d.series[li].forEach(function (v, i) {
          var x = px(i, d.series[li].length), y = py(v);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        if (mr > 1.5) {
          d.series[li].forEach(function (v, i) {
            var x = px(i, d.series[li].length), y = py(v);
            ctx.beginPath();
            ctx.arc(x, y, mr, 0, Math.PI * 2);
            ctx.fillStyle = col(li);
            ctx.globalAlpha = spec.markers.fillAlpha;
            ctx.fill();
            ctx.globalAlpha = 1;
            if (spec.strokes.markerEdge > 0) {
              ctx.strokeStyle = hexA('#ffffff', 0.9);
              ctx.lineWidth = Math.max(0.4, spec.strokes.markerEdge * W);
              ctx.stroke();
            }
          });
        }
      }
    } else if (type === 'scatter') {
      var rand = rng(77);
      for (var sc = 0; sc < d.n; sc++) {
        ctx.fillStyle = col(sc);
        ctx.globalAlpha = spec.specific.scatter.fillAlpha;
        for (var pi = 0; pi < 34; pi++) {
          var rx = g.L + rand() * g.w;
          var ry = g.B - rand() * g.h * 0.9;
          ctx.beginPath();
          ctx.arc(rx, ry, Math.max(1.2, spec.specific.scatter.radius * W), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    } else if (type === 'box') {
      var boxes = 5, step = g.w / boxes, half = step * 0.26;
      for (var bi = 0; bi < boxes; bi++) {
        var cx2 = g.L + step * (bi + 0.5);
        var base = 0.45 + 0.12 * ((bi % 3) - 1);
        var q1 = base - 0.09, q3 = base + 0.09, lo = base - 0.2, hi = base + 0.22;
        ctx.strokeStyle = col(0);
        ctx.lineWidth = Math.max(0.8, spec.strokes.series * W);
        ctx.beginPath();
        ctx.rect(cx2 - half, py(q3), half * 2, py(q1) - py(q3));
        ctx.moveTo(cx2, py(q3)); ctx.lineTo(cx2, py(hi));
        ctx.moveTo(cx2, py(q1)); ctx.lineTo(cx2, py(lo));
        var cap = spec.specific.box.capWidth * W;
        ctx.moveTo(cx2 - cap / 2, py(hi)); ctx.lineTo(cx2 + cap / 2, py(hi));
        ctx.moveTo(cx2 - cap / 2, py(lo)); ctx.lineTo(cx2 + cap / 2, py(lo));
        ctx.moveTo(cx2 - half, py(base)); ctx.lineTo(cx2 + half, py(base));
        ctx.stroke();
      }
    } else if (type === 'heatmap') {
      var rows = 6, cols = 8;
      var gap = spec.specific.heatmap.cellGap * W;
      var cw = g.w / cols, ch = g.h / rows;
      var grad = spec.specific.heatmap.gradient || ['#f4f9f7', '#2c6b5d'];
      var rr = rng(31);
      for (var ri = 0; ri < rows; ri++) {
        for (var ci = 0; ci < cols; ci++) {
          var t = Math.abs(Math.sin(ri * 1.7 + ci * 0.9)) * 0.8 + rr() * 0.2;
          ctx.fillStyle = mixHex(grad[0], grad[1], Math.min(1, t));
          ctx.fillRect(g.L + ci * cw + gap / 2, g.T + ri * ch + gap / 2, Math.max(1, cw - gap), Math.max(1, ch - gap));
        }
      }
    }
    ctx.restore();
  }

  // 主入口
  function render(canvas, spec, opts) {
    opts = opts || {};
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = spec.colors.background;
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'high';

    var g = geometry(spec, W, H);
    drawAxes(ctx, spec, W, H, g);
    drawData(ctx, spec, W, H, g);
    drawTitles(ctx, spec, W, H, g, opts.title || 'Figure title', opts.xLabel || 'Independent variable', opts.yLabel || 'Dependent variable');
    var labels = [];
    for (var i = 0; i < Math.min(6, spec.colors.series.length); i++) labels.push('Series ' + (i + 1));
    drawLegend(ctx, spec, W, H, g, labels);
    return { geometry: g };
  }

  // 灰度数组（用于差异度量）
  function grayOf(canvas, w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    var d = ctx.getImageData(0, 0, w, h).data;
    var out = new Float32Array(w * h);
    for (var i = 0, j = 0; i < w * h; i++, j += 4) {
      out[i] = (d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722) / 255;
    }
    return out;
  }

  function edgeOf(gray, w, h) {
    var e = new Float32Array(w * h);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        var gx = gray[i + 1] - gray[i - 1];
        var gy = gray[i + w] - gray[i - w];
        e[i] = Math.min(1, Math.sqrt(gx * gx + gy * gy));
      }
    }
    return e;
  }

  // 参考图 vs 预览：返回 0~100 的结构相似度与分量
  function compare(refCanvas, previewCanvas) {
    var w = 128, h = Math.max(32, Math.round(128 * refCanvas.height / refCanvas.width));
    var a = grayOf(refCanvas, w, h), b = grayOf(previewCanvas, w, h);
    var mae = 0;
    for (var i = 0; i < a.length; i++) mae += Math.abs(a[i] - b[i]);
    mae /= a.length;
    var ea = edgeOf(a, w, h), eb = edgeOf(b, w, h);
    var ed = 0;
    for (var j = 0; j < ea.length; j++) ed += Math.abs(ea[j] - eb[j]);
    ed /= ea.length;
    var lumScore = 100 * (1 - Math.min(1, mae / 0.32));
    var edgeScore = 100 * (1 - Math.min(1, ed / 0.12));
    var score = Math.max(0, Math.min(100, lumScore * 0.55 + edgeScore * 0.45));
    return { score: score, lumScore: lumScore, edgeScore: edgeScore, mae: mae, edgeDiff: ed };
  }

  // 差异热图：亮度差 → 冷蓝到暖红
  function diffHeatmap(refCanvas, previewCanvas, out) {
    var w = Math.min(480, out.width), h = Math.round(w * refCanvas.height / refCanvas.width);
    var a = grayOf(refCanvas, w, h), b = grayOf(previewCanvas, w, h);
    var tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    var tctx = tmp.getContext('2d');
    var img = tctx.createImageData(w, h);
    for (var i = 0; i < w * h; i++) {
      var d = Math.abs(a[i] - b[i]);
      var t = Math.min(1, d / 0.5);
      var r = Math.round(t < 0.5 ? 40 + t * 2 * 160 : 200 + (t - 0.5) * 2 * 55);
      var gcol = Math.round(t < 0.5 ? 90 + t * 2 * 120 : 210 - (t - 0.5) * 2 * 150);
      var bl = Math.round(t < 0.5 ? 200 - t * 2 * 60 : 140 - (t - 0.5) * 2 * 140);
      img.data[i * 4] = r; img.data[i * 4 + 1] = gcol; img.data[i * 4 + 2] = bl; img.data[i * 4 + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    var octx = out.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(tmp, 0, 0, out.width, out.height);
  }

  var api = { render: render, compare: compare, diffHeatmap: diffHeatmap, geometry: geometry, mixHex: mixHex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.StyleGrabRender = api;
})(typeof window !== 'undefined' ? window : globalThis);
