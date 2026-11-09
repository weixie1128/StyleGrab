/*
 * StyleGrab · image-analysis.js
 * 把一张参考图拆成 sp1 参数：白边裁剪 → 归一化 → 绘图区检测 → 配色聚类 → 线条/文字/刻度测量
 *
 * 设计原则：
 *  1. 一切长度先按像素量，再除以画布宽度换成「占画布宽度的比例」，与图片分辨率无关
 *  2. 不依赖任何第三方库（不用 OpenCV），只用 Canvas 像素 + 连通域 + 投影
 *  3. 测不准就降 confidence，绝不编造精确值
 */
(function (global) {
  'use strict';

  var ANALYSIS_W = 1200;      // 分析用归一化宽度
  var HIRES_MAX = 2400;       // 原始图先缩到这个宽度再找白边

  // ---------------- 色彩工具 ----------------
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function luminance(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

  function hexOf(r, g, b) {
    function h(v) { return Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0'); }
    return '#' + h(r) + h(g) + h(b);
  }

  function hexToRgb(hex) {
    var s = String(hex || '').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    if (!isFinite(n)) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function srgb2lin(c) {
    c = c / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function rgb2lab(r, g, b) {
    var R = srgb2lin(r), G = srgb2lin(g), B = srgb2lin(b);
    var X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
    var Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1.00000;
    var Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
    function f(t) { return t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116); }
    var fx = f(X), fy = f(Y), fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function dE76(a, b) {
    var dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt(dl * dl + da * da + db * db);
  }

  function chroma(lab) { return Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]); }

  // ---------------- 图片载入 ----------------
  function loadImageFromFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('这张图片无法解码，请换 PNG / JPG')); };
      img.src = url;
    });
  }

  function loadImageFromUrl(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';   // 对方不给 CORS 头时，后面读像素会失败
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('外链图片加载失败；若对方服务器不允许跨域，请先下载再拖进来')); };
      img.src = url;
    });
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  // 把图片画进工作画布（限制最大宽度，避免超大图卡死）
  function toWorkCanvas(img) {
    var sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
    var scale = Math.min(1, HIRES_MAX / sw);
    var c = makeCanvas(sw * scale, sh * scale);
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function readData(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  // ---------------- 背景 / 掩膜 / 内容框 ----------------
  function estimateBackground(px, W, H) {
    var ring = [];
    function push(x, y) {
      var i = (y * W + x) * 4;
      ring.push([px[i], px[i + 1], px[i + 2]]);
    }
    for (var x = 0; x < W; x += Math.max(1, Math.floor(W / 200))) { push(x, 0); push(x, H - 1); }
    for (var y = 0; y < H; y += Math.max(1, Math.floor(H / 200))) { push(0, y); push(W - 1, y); }
    var rs = ring.map(function (p) { return p[0]; }).sort(function (a, b) { return a - b; });
    var gs = ring.map(function (p) { return p[1]; }).sort(function (a, b) { return a - b; });
    var bs = ring.map(function (p) { return p[2]; }).sort(function (a, b) { return a - b; });
    var m = Math.floor(ring.length / 2);
    var r = rs[m], g = gs[m], b = bs[m];
    return { r: r, g: g, b: b, hex: hexOf(r, g, b), lum: luminance(r, g, b), lab: rgb2lab(r, g, b) };
  }

  function buildMask(px, W, H, bg, thr) {
    var mask = new Uint8Array(W * H);
    var n = W * H;
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      var dr = px[j] - bg.r, dg = px[j + 1] - bg.g, db = px[j + 2] - bg.b;
      // 用「相对背景的 RGB 距离」判定墨迹：白底彩线、深底浅线都能命中
      if (dr * dr + dg * dg + db * db > thr * thr) mask[i] = 1;
    }
    return mask;
  }

  // 忽略孤立噪点：只统计墨迹数达到阈值的行/列
  function contentBox(mask, W, H) {
    var rowCount = new Int32Array(H), colCount = new Int32Array(W);
    for (var y = 0; y < H; y++) {
      var off = y * W;
      for (var x = 0; x < W; x++) if (mask[off + x]) { rowCount[y]++; colCount[x]++; }
    }
    var minRow = Math.max(2, Math.round(W * 0.004));
    var minCol = Math.max(2, Math.round(H * 0.004));
    var y0 = 0, y1 = H - 1, x0 = 0, x1 = W - 1;
    while (y0 < H && rowCount[y0] < minRow) y0++;
    while (y1 > y0 && rowCount[y1] < minRow) y1--;
    while (x0 < W && colCount[x0] < minCol) x0++;
    while (x1 > x0 && colCount[x1] < minCol) x1--;
    if (x1 <= x0 || y1 <= y0) return null;
    return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // 从原图按内容框裁出并归一化到 ANALYSIS_W
  function normalizeByBox(work, box) {
    var w = Math.min(ANALYSIS_W, Math.max(60, box.w));
    var h = Math.round(w * box.h / box.w);
    var c = makeCanvas(w, h);
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(work, box.x0, box.y0, box.w, box.h, 0, 0, w, h);
    return c;
  }

  // 手动内缩（相对当前归一化画布），用于修正自动裁剪不准的情况
  function cropByInset(canvas, inset) {
    var W = canvas.width, H = canvas.height;
    var l = clamp(inset.left || 0, 0, 0.4) * W;
    var r = clamp(inset.right || 0, 0, 0.4) * W;
    var t = clamp(inset.top || 0, 0, 0.4) * H;
    var b = clamp(inset.bottom || 0, 0, 0.4) * H;
    var w = W - l - r, h = H - t - b;
    if (w < 40 || h < 40) return canvas;
    var c = makeCanvas(w, h);
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(canvas, l, t, w, h, 0, 0, c.width, c.height);
    return c;
  }

  // ---------------- 投影与轴检测 ----------------
  function rowRuns(mask, W, H, y) {
    var off = y * W, best = 0, cur = 0, end = 0, bestEnd = 0;
    for (var x = 0; x < W; x++) {
      if (mask[off + x]) { cur++; if (cur > best) { best = cur; bestEnd = x; } }
      else cur = 0;
    }
    return { len: best, end: bestEnd, start: bestEnd - best + 1 };
  }

  function colRuns(mask, W, H, x) {
    var best = 0, cur = 0, end = 0;
    for (var y = 0; y < H; y++) {
      if (mask[y * W + x]) { cur++; if (cur > best) { best = cur; end = y; } }
      else cur = 0;
    }
    return { len: best, end: end, start: end - best + 1 };
  }

  function findAxes(mask, W, H, box) {
    var res = { bottom: null, left: null, top: null, right: null };
    var y, x, r, best;

    best = { len: 0 };
    for (y = 0; y < H; y++) {
      r = rowRuns(mask, W, H, y);
      if (r.len > W * 0.42 && (r.len > best.len + 2 || (Math.abs(r.len - best.len) <= 2 && y > best.y))) {
        best = { len: r.len, y: y, start: r.start, end: r.end };
      }
    }
    if (best.len) res.bottom = best;

    best = { len: 0 };
    for (x = 0; x < W; x++) {
      r = colRuns(mask, W, H, x);
      if (r.len > H * 0.32 && (r.len > best.len + 2 || (Math.abs(r.len - best.len) <= 2 && x < best.x))) {
        best = { len: r.len, x: x, start: r.start, end: r.end };
      }
    }
    if (best.len) res.left = best;

    // 上/右外框：只在与绘图区对齐的范围内找
    if (res.bottom && res.left) {
      var spanW = res.bottom.end - res.left.x;
      var spanH = res.bottom.y - res.left.start;
      best = { len: 0 };
      for (y = 0; y < Math.max(4, res.bottom.y * 0.6); y++) {
        r = rowRuns(mask, W, H, y);
        if (r.len > spanW * 0.7 && r.len > best.len) best = { len: r.len, y: y };
      }
      if (best.len) res.top = best;
      best = { len: 0 };
      for (x = Math.max(4, Math.floor(W * 0.5)); x < W; x++) {
        r = colRuns(mask, W, H, x);
        if (r.len > spanH * 0.7 && r.len > best.len) best = { len: r.len, x: x };
      }
      if (best.len) res.right = best;
    }
    return res;
  }

  // ---------------- k-means 配色 ----------------
  function kmeans(samples, k, iters) {
    if (!samples.length) return [];
    var centroids = [];
    // k-means++ 初始化（确定性：每次选离已有中心最远的点，避免随机导致结果不稳定）
    centroids.push(samples[0].slice());
    while (centroids.length < k) {
      var bestI = 0, bestD = -1;
      for (var i = 0; i < samples.length; i += 1) {
        var dmin = Infinity;
        for (var c = 0; c < centroids.length; c++) {
          var d = dE76(samples[i], centroids[c]);
          if (d < dmin) dmin = d;
        }
        if (dmin > bestD) { bestD = dmin; bestI = i; }
      }
      centroids.push(samples[bestI].slice());
      if (bestD <= 0) break;
    }
    var assign = new Int32Array(samples.length);
    for (var it = 0; it < iters; it++) {
      for (var s = 0; s < samples.length; s++) {
        var bi = 0, bd = Infinity;
        for (var j = 0; j < centroids.length; j++) {
          var dd = dE76(samples[s], centroids[j]);
          if (dd < bd) { bd = dd; bi = j; }
        }
        assign[s] = bi;
      }
      var sums = centroids.map(function () { return [0, 0, 0, 0]; });
      for (var t = 0; t < samples.length; t++) {
        var a = assign[t];
        sums[a][0] += samples[t][0]; sums[a][1] += samples[t][1];
        sums[a][2] += samples[t][2]; sums[a][3] += 1;
      }
      for (var q = 0; q < centroids.length; q++) {
        if (sums[q][3] > 0) {
          centroids[q] = [sums[q][0] / sums[q][3], sums[q][1] / sums[q][3], sums[q][2] / sums[q][3]];
        }
      }
    }
    var counts = new Int32Array(centroids.length);
    for (var u = 0; u < samples.length; u++) counts[assign[u]]++;
    return centroids.map(function (c, i) { return { lab: c, count: counts[i] }; });
  }

  function extractPalette(px, mask, W, H, bg) {
    var samples = [];
    var step = Math.max(1, Math.floor(Math.sqrt(W * H / 26000)));
    for (var y = 0; y < H; y += step) {
      var off = y * W;
      for (var x = 0; x < W; x += step) {
        if (!mask[off + x]) continue;
        var i = (off + x) * 4;
        samples.push(rgb2lab(px[i], px[i + 1], px[i + 2]));
      }
    }
    if (!samples.length) return [];
    var clusters = kmeans(samples, 8, 10).filter(function (c) {
      return c.count >= Math.max(8, samples.length * 0.004);
    });
    // 把 Lab 中心折回 RGB 与 hex，便于展示
    clusters.forEach(function (c) {
      var rgb = labToRgb(c.lab);
      c.rgb = rgb;
      c.hex = hexOf(rgb.r, rgb.g, rgb.b);
      c.lum = luminance(rgb.r, rgb.g, rgb.b);
      c.chroma = chroma(c.lab);
      c.areaRatio = c.count / samples.length;
    });
    clusters.sort(function (a, b) { return b.count - a.count; });
    return clusters;
  }

  function labToRgb(lab) {
    var L = lab[0], A = lab[1], B = lab[2];
    var fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200;
    function finv(t) { var t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; }
    var X = 0.95047 * finv(fx), Y = 1.0 * finv(fy), Z = 1.08883 * finv(fz);
    var R = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314;
    var G = X * -0.9692660 + Y * 1.8760108 + Z * 0.0415560;
    var Bc = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252;
    function g(c) {
      c = c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
      return clamp(Math.round(c * 255), 0, 255);
    }
    return { r: g(R), g: g(G), b: g(Bc) };
  }

  function assignRoles(clusters, bg) {
    var roles = { text: '#222222', axis: '#222222', grid: '#dddddd', series: [], bg: bg.hex, gridAlpha: 1 };
    if (!clusters.length) return roles;
    var ink = clusters.filter(function (c) { return dE76(c.lab, bg.lab) > 8; });
    if (!ink.length) ink = clusters;
    // 文字/轴线：最暗的一组
    var sortedByLum = ink.slice().sort(function (a, b) { return a.lum - b.lum; });
    var textC = sortedByLum[0];
    roles.text = textC.hex;
    roles.axis = textC.hex;
    // 网格：必须是低彩度（近灰）、比文字浅、且占比较大（网格线覆盖绘图区）
    var gridC = ink.filter(function (c) {
      return c !== textC && c.chroma < 8 && c.lum > textC.lum + 40 && c.areaRatio > 0.02;
    }).sort(function (a, b) { return b.count - a.count; })[0];
    if (gridC) roles.grid = gridC.hex;
    // 系列色：排除文字与网格，按彩度优先、面积次之
    var used = ink.filter(function (c) { return c !== textC && c !== gridC; });
    used.sort(function (a, b) {
      var ca = a.chroma * 0.5 + a.areaRatio * 260, cb = b.chroma * 0.5 + b.areaRatio * 260;
      return cb - ca;
    });
    var picked = [];
    used.forEach(function (c) {
      if (c.chroma < 6 && picked.length >= 1) return;         // 黑白图只取一个
      if (picked.some(function (p) { return dE76(p.lab, c.lab) < 10; })) return;
      if (picked.length < 12) picked.push(c);
    });
    roles.series = picked.map(function (c) { return c.hex; });
    if (!roles.series.length) roles.series = [roles.text];
    return roles;
  }

  // ---------------- 连通域 ----------------
  function components(mask, W, H, minArea) {
    var seen = new Uint8Array(W * H);
    var stack = new Int32Array(W * H);
    var out = [];
    for (var i = 0; i < W * H; i++) {
      if (!mask[i] || seen[i]) continue;
      var sp = 0;
      stack[sp++] = i;
      seen[i] = 1;
      var area = 0, minX = W, maxX = 0, minY = H, maxY = 0, sx = 0, sy = 0, per = 0;
      while (sp) {
        var p = stack[--sp];
        var x = p % W, y = (p - x) / W;
        area++; sx += x; sy += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        // 四邻域
        if (x > 0) { var l = p - 1; if (mask[l]) { if (!seen[l]) { seen[l] = 1; stack[sp++] = l; } } else per++; }
        else per++;
        if (x < W - 1) { var r = p + 1; if (mask[r]) { if (!seen[r]) { seen[r] = 1; stack[sp++] = r; } } else per++; }
        else per++;
        if (y > 0) { var t = p - W; if (mask[t]) { if (!seen[t]) { seen[t] = 1; stack[sp++] = t; } } else per++; }
        else per++;
        if (y < H - 1) { var b = p + W; if (mask[b]) { if (!seen[b]) { seen[b] = 1; stack[sp++] = b; } } else per++; }
        else per++;
      }
      if (area >= minArea) {
        out.push({
          area: area, per: per,
          x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1,
          cx: sx / area, cy: sy / area,
          aspect: (maxX - minX + 1) / (maxY - minY + 1)
        });
      }
    }
    return out;
  }

  function colorMask(px, W, H, hex, tol) {
    var t = hexToRgb(hex);
    var base = rgb2lab(t.r, t.g, t.b);
    var m = new Uint8Array(W * H);
    for (var i = 0, j = 0; i < W * H; i++, j += 4) {
      if (dE76(rgb2lab(px[j], px[j + 1], px[j + 2]), base) < tol) m[i] = 1;
    }
    return m;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // ---------------- 图型推断 ----------------
  function inferType(ctx) {
    var px = ctx.px, W = ctx.W, H = ctx.H, rect = ctx.rect, mask = ctx.mask;
    var hints = [];

    // 热图：绘图区几乎被填满，且颜色种类多
    var fill = 0, inside = 0;
    for (var y = Math.round(rect.y); y < rect.y + rect.h; y += 2) {
      for (var x = Math.round(rect.x); x < rect.x + rect.w; x += 2) {
        inside++;
        if (mask[y * W + x]) fill++;
      }
    }
    var fillRatio = inside ? fill / inside : 0;
    if (fillRatio > 0.62 && ctx.clusters.length >= 5) return { type: 'heatmap', conf: 0.62, hint: '绘图区填充率 ' + (fillRatio * 100).toFixed(0) + '%' };

    // 箱线：中等大小的矩形块，成列排列
    var boxes = ctx.componentsAll.filter(function (c) {
      return c.w > W * 0.02 && c.w < W * 0.2 && c.h > H * 0.03 && c.h < H * 0.8 && c.aspect > 0.35 && c.aspect < 3 && c.area > 300;
    });
    if (boxes.length >= 3 && boxes.length <= 12) {
      var ys = boxes.map(function (b) { return b.cy; }).sort(function (a, b) { return a - b; });
      var spread = (ys[ys.length - 1] - ys[0]) / H;
      if (spread < 0.4) return { type: 'box', conf: 0.6, hint: '检出 ' + boxes.length + ' 个箱体候选' };
    }

    // 散点：小而圆的连通域多
    var round = ctx.markerComps.filter(function (c) { return c.area < W * H * 0.0012; });
    if (round.length >= 18) return { type: 'scatter', conf: 0.66, hint: '圆形标记候选 ' + round.length + ' 个' };

    // 柱状：从底部起有较长的竖直实心行程
    var barCols = 0, runCols = 0;
    for (var xx = Math.round(rect.x) + 1; xx < rect.x + rect.w - 1; xx += 2) {
      runCols++;
      var run = 0, bestRun = 0;
      for (var yy = Math.round(rect.y + rect.h) - 2; yy > rect.y; yy--) {
        if (mask[yy * W + xx]) { run++; if (run > bestRun) bestRun = run; } else run = 0;
      }
      if (bestRun > rect.h * 0.25) barCols++;
    }
    if (runCols && barCols / runCols > 0.12) return { type: 'bar', conf: 0.64, hint: '竖直实心列占 ' + Math.round(barCols / runCols * 100) + '%' };

    // 折线：横向连续分布的细线
    if (hints.length === 0 && ctx.lineWidthPx > 0) return { type: 'line', conf: 0.6, hint: '测到连续细线' };

    return { type: 'line', conf: 0.45, hint: '未命中明确特征，按折线处理' };
  }

  // ---------------- 主分析 ----------------
  function analyzeCanvas(canvas) {
    var data = readData(canvas);
    var px = data.data, W = canvas.width, H = canvas.height;
    var bg = estimateBackground(px, W, H);
    var mask = buildMask(px, W, H, bg, 26);
    var box = contentBox(mask, W, H) || { x0: 0, y0: 0, x1: W - 1, y1: H - 1, w: W, h: H };

    var axes = findAxes(mask, W, H, box);
    var hasBottom = !!axes.bottom, hasLeft = !!axes.left;

    var plotLeft = hasLeft ? axes.left.x : box.x0 + W * 0.1;
    var plotBottom = hasBottom ? axes.bottom.y : box.y1 - H * 0.1;
    var plotRight = hasBottom ? Math.max(axes.bottom.end, plotLeft + W * 0.2) : box.x1;
    if (axes.right && axes.right.x > plotLeft + W * 0.3) plotRight = axes.right.x;

    var clusters = extractPalette(px, mask, W, H, bg);
    var roles = assignRoles(clusters, bg);

    // 各系列色的掩膜与连通域
    var seriesStats = [];
    var allComps = [];
    var markerComps = [];
    var lineWidths = [];
    var markerRadii = [];
    var limitY = Math.round(plotBottom);

    roles.series.forEach(function (hex) {
      var cm = colorMask(px, W, H, hex, 16);
      // 只保留绘图区内的像素，避免坐标文字干扰
      for (var y = 0; y < H; y++) {
        var off = y * W;
        if (y < plotBottom - 2 && y > 0) {
          for (var x = 0; x < W; x++) {
            if (x < plotLeft + 2 || x > plotRight) cm[off + x] = 0;
          }
        }
      }
      var comps = components(cm, W, H, 14);
      var area = 0, per = 0;
      comps.forEach(function (c) { area += c.area; per += c.per; });
      var meanWidth = per > 0 ? (2 * area / per) : 0;
      var circles = comps.filter(function (c) {
        var r = Math.max(c.w, c.h) / 2;
        var circ = c.area / (Math.PI * r * r + 1e-6);
        return circ > 0.55 && c.area < W * H * 0.002 && c.w < W * 0.06;
      });
      var isMarker = circles.length >= 4 && circles.length > comps.length * 0.4;
      var radius = 0;
      if (circles.length) {
        radius = median(circles.map(function (c) { return Math.sqrt(c.area / Math.PI); }));
      }
      seriesStats.push({ hex: hex, comps: comps.length, meanWidth: meanWidth, isMarker: isMarker, radius: radius });
      if (!isMarker && meanWidth > 0.4 && meanWidth < W * 0.02) lineWidths.push(meanWidth);
      if (radius > 0.6) markerRadii.push(radius);
      allComps = allComps.concat(comps);
      markerComps = markerComps.concat(circles);
    });

    var lineWidthPx = median(lineWidths);
    var markerRadiusPx = median(markerRadii);

    // 绘图区顶部：优先上外框，否则取绘图区列内最高的系列墨迹
    var plotTop;
    if (axes.top) plotTop = axes.top.y;
    else {
      var highest = plotBottom;
      var sm = roles.series.length ? colorMask(px, W, H, roles.series[0], 20) : null;
      if (sm) {
        for (var yy = Math.round(plotBottom) - 2; yy > 0; yy--) {
          var found = false;
          for (var xx2 = Math.round(plotLeft) + 2; xx2 < plotRight; xx2++) {
            if (sm[yy * W + xx2]) { found = true; break; }
          }
          if (found) { highest = yy; break; }
        }
      }
      plotTop = Math.min(highest, plotBottom - H * 0.15);
      plotTop = Math.max(plotTop, box.y0 + 2);
    }

    var rect = { x: plotLeft, y: plotTop, w: Math.max(10, plotRight - plotLeft), h: Math.max(10, plotBottom - plotTop) };

    var ctx = {
      px: px, W: W, H: H, mask: mask, rect: rect, clusters: clusters,
      componentsAll: allComps, markerComps: markerComps, lineWidthPx: lineWidthPx
    };
    var typeInfo = inferType(ctx);

    // ---- 文字尺寸 ----
    var textComps = allComps.filter(function (c) { return c.h >= 4 && c.h <= H * 0.12 && c.w <= W * 0.35; });
    var below = textComps.filter(function (c) { return c.cy > plotBottom + 1 && c.cy < H; });
    var above = textComps.filter(function (c) { return c.cy < plotTop - 1; });
    var leftSide = textComps.filter(function (c) { return c.cx < plotLeft - 1; });

    var tickCandidates = below.filter(function (c) { return c.h <= H * 0.06; }).concat(leftSide.filter(function (c) { return c.h <= H * 0.06; }));
    var tickH = median(tickCandidates.map(function (c) { return c.h; }));
    var axisTitleH = median(below.filter(function (c) { return c.cy > plotBottom + H * 0.06 && c.h > tickH * 1.05; }).map(function (c) { return c.h; }));
    var titleH = median(above.map(function (c) { return c.h; }));

    function sizeFromHeight(h) { return h > 0 ? clamp(h / 0.72 / W, 0.008, 0.08) : 0; }

    // ---- 刻度 ----
    var tickLen = 0, xCount = 0, yCount = 0, tickDir = 'out';
    if (hasBottom) {
      var inBand = 0, outBand = 0, runs = 0, prev = false;
      var maxDepth = Math.max(3, Math.round(H * 0.02));
      for (var bx = Math.round(plotLeft) + 1; bx < plotRight - 1; bx++) {
        var belowInk = 0, aboveInk = 0;
        for (var d = 1; d <= maxDepth; d++) {
          if (plotBottom + d < H && mask[(plotBottom + d) * W + bx]) belowInk = d;
          if (plotBottom - d > 0 && mask[(plotBottom - d) * W + bx]) aboveInk = d;
        }
        outBand = Math.max(outBand, belowInk);
        inBand = Math.max(inBand, aboveInk);
        var on = belowInk > 1 || aboveInk > 1;
        if (on && !prev) runs++;
        prev = on;
      }
      xCount = runs;
      tickLen = Math.max(outBand, inBand);
      tickDir = inBand > outBand ? 'in' : 'out';
    }
    if (hasLeft) {
      var runs2 = 0, prev2 = false, maxDepth2 = Math.max(3, Math.round(W * 0.015)), len2 = 0;
      for (var by = Math.round(plotTop) + 1; by < plotBottom - 1; by++) {
        var lInk = 0, rInk = 0;
        for (var d2 = 1; d2 <= maxDepth2; d2++) {
          if (plotLeft - d2 > 0 && mask[by * W + (plotLeft - d2)]) lInk = d2;
          if (plotLeft + d2 < W && mask[by * W + (plotLeft + d2)]) rInk = d2;
        }
        len2 = Math.max(len2, lInk, rInk);
        var on2 = lInk > 1 || rInk > 1;
        if (on2 && !prev2) runs2++;
        prev2 = on2;
      }
      yCount = runs2;
      if (!tickLen) tickLen = len2;
    }

    // ---- 网格 ----
    var gridMask = colorMask(px, W, H, roles.grid, 14);
    var hRows = 0, vCols = 0;
    for (var gy = Math.round(rect.y) + 1; gy < rect.y + rect.h - 1; gy += 2) {
      var c1 = 0;
      for (var gx = Math.round(rect.x) + 1; gx < rect.x + rect.w - 1; gx += 2) if (gridMask[gy * W + gx]) c1++;
      if (c1 / (rect.w / 2) > 0.45) hRows++;
    }
    for (var gx2 = Math.round(rect.x) + 1; gx2 < rect.x + rect.w - 1; gx2 += 2) {
      var c2 = 0;
      for (var gy2 = Math.round(rect.y) + 1; gy2 < rect.y + rect.h - 1; gy2 += 2) if (gridMask[gy2 * W + gx2]) c2++;
      if (c2 / (rect.h / 2) > 0.45) vCols++;
    }
    var gridMode = hRows > 2 && vCols > 2 ? 'both' : hRows > 2 ? 'h' : vCols > 2 ? 'v' : 'none';

    // ---- 零线 ----
    var zeroLine = false;
    var axisMask = colorMask(px, W, H, roles.axis, 14);
    for (var zy = Math.round(rect.y) + 1; zy < rect.y + rect.h - 1; zy++) {
      var zc = 0;
      for (var zx = Math.round(rect.x) + 1; zx < rect.x + rect.w - 1; zx++) if (axisMask[zy * W + zx]) zc++;
      if (zc / rect.w > 0.8) { zeroLine = true; break; }
    }

    // ---- 图例 ----
    var legend = detectLegend(px, W, H, rect, roles, allComps);

    // ---- 组装 spec ----
    var S = global.StyleGrabSpec || (typeof require === 'function' ? require('./spec-schema.js') : null);
    var spec = S.blankSpec();
    spec.meta.sourceWidth = W;
    spec.meta.sourceHeight = H;
    spec.meta.canvasAspect = W / H;
    spec.meta.chartType = typeInfo.type;

    spec.layout.plotLeft = clamp(plotLeft / W, 0, 0.45);
    spec.layout.plotRight = clamp((W - plotRight) / W, 0, 0.45);
    spec.layout.plotTop = clamp(plotTop / H * (H / W), 0, 0.45);   // 统一换算成「画布宽度比例」
    spec.layout.plotBottom = clamp((H - plotBottom) / H * (H / W), 0, 0.55);

    spec.colors.background = bg.hex;
    spec.colors.text = roles.text;
    spec.colors.axis = roles.axis;
    spec.colors.grid = roles.grid;
    spec.colors.series = roles.series;

    if (lineWidthPx > 0) spec.strokes.series = clamp(lineWidthPx / W, 0.0006, 0.02);
    var axisW = measureStroke(px, W, H, roles.axis, rect);
    if (axisW > 0) spec.strokes.axis = clamp(axisW / W, 0.0006, 0.02);
    spec.strokes.grid = clamp(spec.strokes.axis * 0.55, 0.0004, 0.01);
    spec.strokes.markerEdge = clamp(spec.strokes.series * 0.4, 0.0003, 0.01);

    spec.markers.radius = markerRadiusPx > 0 ? clamp(markerRadiusPx / W, 0.001, 0.03) : clamp(spec.strokes.series * 1.8, 0.002, 0.02);

    if (tickH > 0) spec.text.tickLabel = sizeFromHeight(tickH);
    if (axisTitleH > 0) spec.text.axisTitle = sizeFromHeight(axisTitleH);
    else spec.text.axisTitle = clamp(spec.text.tickLabel * 1.25, 0.01, 0.06);
    if (titleH > 0) spec.text.title = sizeFromHeight(titleH);
    else spec.text.title = clamp(spec.text.axisTitle * 1.2, 0.012, 0.06);
    spec.text.legend = clamp(spec.text.tickLabel * 1.05, 0.01, 0.06);

    spec.ticks.direction = tickDir;
    if (tickLen > 0) spec.ticks.length = clamp(tickLen / W, 0.001, 0.03);
    spec.ticks.xCount = xCount > 1 ? Math.min(40, xCount) : 6;
    spec.ticks.yCount = yCount > 1 ? Math.min(40, yCount) : 5;

    spec.grid.mode = gridMode;
    spec.frame.border = !!(axes.top && axes.right);
    spec.frame.zeroLine = zeroLine;
    spec.legend = legend;

    // 图型专属参数
    if (typeInfo.type === 'bar') {
      var barInfo = estimateBarWidth(mask, W, H, rect);
      if (barInfo.width > 0) {
        spec.specific.bar.widthRatio = clamp(barInfo.width / W * 3.2, 0.15, 0.95);
        // 柱子间距：<=1px 视为无间距
        spec.specific.bar.gap = barInfo.gap <= 1 ? 0 : clamp(barInfo.gap / W, 0, 0.02);
      }
      // 柱子描边：无边框则 stroke.markerEdge = 0
      if (!hasBarBorder(px, W, H, rect, mask)) {
        spec.strokes.markerEdge = 0;
        spec.specific.bar.edgeWidth = 0;
      }
    }
    if (typeInfo.type === 'heatmap') {
      spec.specific.heatmap.gradient = buildGradient(px, W, H, rect);
    }

    // 分辨率因子（高分辨率图可信度更高）
    var resFactor = clamp(W / 1200, 0.4, 1);
    var conf = {}, low = [];

    // ---- 显著性字母大小 ----（绘图区内上部、高度接近刻度字号的小连通域）
    var letterH = 0;
    if (tickH > 0) {
      var letterComps = allComps.filter(function (c) {
        return c.cy > rect.y && c.cy < rect.y + rect.h * 0.7 &&
               c.h >= tickH * 0.5 && c.h <= tickH * 1.6 &&
               c.w >= tickH * 0.3 && c.w <= tickH * 2.2 &&
               c.area < W * H * 0.0015;
      });
      if (letterComps.length >= 2) {
        letterH = median(letterComps.map(function (c) { return c.h; }));
      }
    }
    if (letterH > 0) {
      spec.letters.size = clamp(letterH / 0.72 / W, 0.006, 0.05);
      spec.letters.weight = 'bold';
      mark('letters', 0.6 * resFactor);
    }

    // ---- 误差棒帽宽 ----（轴线色掩膜里的短水平线段）
    var capW = 0;
    var axisM = colorMask(px, W, H, roles.axis, 14);
    var minRun = Math.max(2, Math.round(lineWidthPx * 1.5));
    var maxRun = Math.round(W * 0.04);
    var capRuns = [];
    for (var cy = Math.round(rect.y) + 1; cy < rect.y + rect.h - 1; cy++) {
      var run = 0;
      for (var cx = Math.round(rect.x) + 1; cx < rect.x + rect.w - 1; cx++) {
        if (axisM[cy * W + cx]) { run++; }
        else {
          if (run >= minRun && run <= maxRun) capRuns.push(run);
          run = 0;
        }
      }
      if (run >= minRun && run <= maxRun) capRuns.push(run);
    }
    if (capRuns.length >= 4) capW = median(capRuns);
    if (capW > 0) spec.specific.errorbar.capWidth = clamp(capW / W, 0.002, 0.04);

    // ---- 折线标记填充（空心/实心）----
    if (markerComps.length >= 3) {
      var hollow = 0, solid = 0;
      markerComps.forEach(function (c) {
        var mcx = Math.round(c.cx), mcy = Math.round(c.cy);
        if (mcx > 0 && mcx < W - 1 && mcy > 0 && mcy < H - 1) {
          var idx = (mcy * W + mcx) * 4;
          var dr = px[idx] - bg.r, dg = px[idx + 1] - bg.g, db = px[idx + 2] - bg.b;
          if (dr * dr + dg * dg + db * db < 600) hollow++; else solid++;
        }
      });
      spec.specific.line.markerFill = hollow >= solid ? 'white' : 'series';
    }

    // ---- 置信度 ----
    function mark(key, v) {
      conf[key] = clamp(v, 0.1, 0.98);
      if (conf[key] < 0.6) low.push(labelOf(key));
    }
    mark('layout', hasBottom && hasLeft ? 0.86 : 0.45);
    mark('colors', clusters.length >= 4 ? 0.85 : clusters.length >= 2 ? 0.66 : 0.4);
    mark('strokes', lineWidthPx > 0 && lineWidths.length >= 2 ? 0.82 * resFactor : lineWidthPx > 0 ? 0.62 * resFactor : 0.35);
    mark('text', tickH > 0 ? 0.78 * resFactor : 0.4);
    mark('ticks', xCount > 1 ? 0.76 : 0.38);
    mark('grid', gridMode === 'none' ? 0.6 : 0.8);
    mark('legend', legend.detected ? 0.72 : 0.5);
    mark('chartType', typeInfo.conf);
    spec.confidence.items = conf;
    spec.confidence.low = low;
    var vals = Object.keys(conf).map(function (k) { return conf[k]; });
    spec.confidence.overall = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;

    return {
      spec: spec,
      stats: {
        analysisWidth: W, analysisHeight: H,
        axesFound: hasBottom && hasLeft,
        axisLines: { left: hasLeft ? axes.left.x : null, bottom: hasBottom ? axes.bottom.y : null, top: axes.top ? axes.top.y : null, right: axes.right ? axes.right.x : null },
        plotRect: rect,
        clusters: clusters.length,
        seriesMeasured: seriesStats.length,
        lineWidthPx: lineWidthPx,
        markerRadiusPx: markerRadiusPx,
        typeHint: typeInfo.hint,
        typeConf: typeInfo.conf,
        low: low
      }
    };
  }

  function labelOf(key) {
    return ({
      layout: '版式比例', colors: '配色', strokes: '线宽', text: '字号',
      ticks: '刻度', grid: '网格', legend: '图例', chartType: '图型判断'
    })[key] || key;
  }

  function measureStroke(px, W, H, hex, rect) {
    // 只在轴线位置（左边缘列 + 底部边缘行）检测，避免柱子/文字干扰
    // 容差收紧到 8，进一步减少抗锯齿半透明边缘
    var m = colorMask(px, W, H, hex, 8);
    var vRuns = [], hRuns = [];
    var edgeCols = 4; // 检测左边缘 4 列
    var edgeRows = 4; // 检测底部 4 行
    // Y 轴：左边缘若干列的垂直段长度
    for (var dx = 0; dx < edgeCols; dx++) {
      var x = Math.round(rect.x) - dx;
      if (x < 0 || x >= W) continue;
      var run = 0;
      for (var y = Math.round(rect.y); y < rect.y + rect.h; y++) {
        if (m[y * W + x]) run++;
        else { if (run > 0) { vRuns.push(run); run = 0; } }
      }
      if (run > 0) vRuns.push(run);
    }
    // X 轴：底部边缘若干行的水平段长度
    for (var dy = 0; dy < edgeRows; dy++) {
      var yy = Math.round(rect.y + rect.h) - 1 + dy;
      if (yy < 0 || yy >= H) continue;
      var run2 = 0, off = yy * W;
      for (var xx = Math.round(rect.x); xx < rect.x + rect.w; xx++) {
        if (m[off + xx]) run2++;
        else { if (run2 > 0) { hRuns.push(run2); run2 = 0; } }
      }
      if (run2 > 0) hRuns.push(run2);
    }
    // 抗锯齿只会让线变粗不会变细，取最小段长最接近真实线宽
    var fv = vRuns.filter(function (l) { return l >= 1 && l <= 8; });
    var fh = hRuns.filter(function (l) { return l >= 1 && l <= 8; });
    var mv = fv.length ? Math.min.apply(null, fv) : 0;
    var mh = fh.length ? Math.min.apply(null, fh) : 0;
    return Math.min(mv, mh) || mv || mh;
  }

  function estimateBarWidth(mask, W, H, rect) {
    var widths = [];
    for (var x = Math.round(rect.x) + 1; x < rect.x + rect.w - 1; x++) {
      var run = 0, best = 0;
      for (var y = Math.round(rect.y + rect.h) - 2; y > rect.y; y--) {
        if (mask[y * W + x]) { run++; if (run > best) best = run; } else run = 0;
      }
      if (best > rect.h * 0.3) widths.push(x);
    }
    if (widths.length < 3) return { width: 0, gap: 0 };
    // 连续列分成若干段
    var segs = [], gaps = [], start = widths[0], prev = widths[0];
    for (var i = 1; i < widths.length; i++) {
      if (widths[i] - prev > 2) {
        segs.push(prev - start + 1);
        gaps.push(widths[i] - prev - 1);
        start = widths[i];
      }
      prev = widths[i];
    }
    segs.push(prev - start + 1);
    var validSegs = segs.filter(function (s) { return s > 3; });
    var w = validSegs.length ? median(validSegs) : 0;
    var g = gaps.length ? median(gaps) : 0;
    return { width: w, gap: g };
  }

  // 检测柱子是否有描边：比较柱体边缘与内部的亮度差
  function hasBarBorder(px, W, H, rect, mask) {
    var midY = Math.round(rect.y + rect.h * 0.5);
    var edges = [], interiors = [];
    for (var x = Math.round(rect.x) + 2; x < rect.x + rect.w - 2; x++) {
      if (mask[midY * W + x]) {
        var leftEdge = !mask[midY * W + (x - 1)];
        var rightEdge = !mask[midY * W + (x + 1)];
        var idx = (midY * W + x) * 4;
        var lum = luminance(px[idx], px[idx + 1], px[idx + 2]);
        if (leftEdge || rightEdge) edges.push(lum);
        else interiors.push(lum);
      }
    }
    if (edges.length < 5 || interiors.length < 10) return false;
    var edgeLum = median(edges), intLum = median(interiors);
    return Math.abs(edgeLum - intLum) > 18;
  }

  function buildGradient(px, W, H, rect) {
    var list = [];
    for (var y = Math.round(rect.y) + 2; y < rect.y + rect.h - 2; y += Math.max(1, Math.round(rect.h / 24))) {
      for (var x = Math.round(rect.x) + 2; x < rect.x + rect.w - 2; x += Math.max(1, Math.round(rect.w / 24))) {
        var i = (y * W + x) * 4;
        list.push({ lab: rgb2lab(px[i], px[i + 1], px[i + 2]), hex: hexOf(px[i], px[i + 1], px[i + 2]), lum: luminance(px[i], px[i + 1], px[i + 2]) });
      }
    }
    if (!list.length) return ['#f4f9f7', '#2c6b5d'];
    list.sort(function (a, b) { return a.lum - b.lum; });
    return [list[0].hex, list[list.length - 1].hex];
  }

  function detectLegend(px, W, H, rect, roles, comps) {
    var out = { visible: false, position: 'top-right', frame: false, columns: 1, detected: false };
    // 搜索区域：绘图区上方及周围（图例常在图上方）
    var searchX0 = Math.max(0, rect.x - W * 0.02);
    var searchX1 = Math.min(W, rect.x + rect.w + W * 0.02);
    var searchY0 = Math.max(0, rect.y - H * 0.18);
    var searchY1 = Math.min(H, rect.y + rect.h + H * 0.05);
    // 找小方形色块（图例标记通常是方形/矩形，面积小）
    var swatches = comps.filter(function (c) {
      return c.area > 15 && c.area < 900 && c.aspect > 0.4 && c.aspect < 2.5 &&
             c.cx > searchX0 && c.cx < searchX1 && c.cy > searchY0 && c.cy < searchY1 &&
             c.w > 3 && c.h > 3;
    });
    if (swatches.length < 2) return out;
    // 取最接近某个系列色的色块
    var seriesLab = roles.series.map(function (h) { var rgb = hexToRgb(h); return rgb2lab(rgb.r, rgb.g, rgb.b); });
    var colored = swatches.filter(function (c) {
      var idx = (Math.round(c.cy) * W + Math.round(c.cx)) * 4;
      var cl = rgb2lab(px[idx], px[idx + 1], px[idx + 2]);
      return seriesLab.some(function (sl) { return dE76(cl, sl) < 25; });
    });
    if (colored.length < 2) return out;
    var xs = colored.map(function (c) { return c.cx; }), ys = colored.map(function (c) { return c.cy; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    if (maxX - minX > rect.w * 0.8 || maxY - minY > rect.h * 0.5) return out;
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    var right = cx > rect.x + rect.w / 2, bottom = cy > rect.y + rect.h / 2;
    out.visible = true;
    out.detected = true;
    out.position = (bottom ? 'bottom' : 'top') + '-' + (right ? 'right' : 'left');
    out.columns = Math.max(1, Math.min(4, Math.round((maxX - minX) / Math.max(8, (maxY - minY) / Math.max(1, colored.length / 2)))));
    return out;
  }

  // 对外入口：图片 → 工作画布 + 结果
  function prepare(img) {
    var work = toWorkCanvas(img);
    var data = readData(work);
    var bg = estimateBackground(data.data, work.width, work.height);
    var mask = buildMask(data.data, work.width, work.height, bg, 26);
    var box = contentBox(mask, work.width, work.height);
    if (!box) box = { x0: 0, y0: 0, x1: work.width - 1, y1: work.height - 1, w: work.width, h: work.height };
    var normalized = normalizeByBox(work, box);
    return { work: work, normalized: normalized, cropBox: box };
  }

  var api = {
    ANALYSIS_W: ANALYSIS_W,
    prepare: prepare,
    analyzeCanvas: analyzeCanvas,
    cropByInset: cropByInset,
    loadImageFromFile: loadImageFromFile,
    loadImageFromUrl: loadImageFromUrl,
    thumbnail: function (canvas, maxW, quality) {
      var w = Math.min(maxW || 480, canvas.width);
      var h = Math.round(w * canvas.height / canvas.width);
      var c = makeCanvas(w, h);
      var ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(canvas, 0, 0, w, h);
      return c.toDataURL('image/jpeg', quality || 0.72);
    },
    // 便于 Node 单测的纯函数
    _pure: { luminance: luminance, rgb2lab: rgb2lab, dE76: dE76, hexOf: hexOf, hexToRgb: hexToRgb, median: median, clamp: clamp, makeCanvas: makeCanvas }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.StyleGrabAnalyze = api;
})(typeof window !== 'undefined' ? window : globalThis);
