/*
 * StyleGrab · app.js
 * 交互层：取图 → 归一化 → 测量 → 参数面板 → 预览/叠加/差异 → 导出 .spec.json
 */
(function () {
  'use strict';

  var S = window.StyleGrabSpec;
  var A = window.StyleGrabAnalyze;
  var R = window.StyleGrabRender;

  var CANVAS_W = 1000;
  var state = {
    img: null,
    prepared: null,
    refCanvas: null,      // 归一化后的参考图（未内缩）
    analysisCanvas: null, // 实际用于分析的画布
    spec: null,
    stats: null,
    inset: { left: 0, top: 0, right: 0, bottom: 0 },
    view: 'ref',
    blend: 0.5,
    forcedType: null,    // null = 自动识别；用户在面板改图型后固定为该值
    pickMode: null,
    previewCanvas: null,
    score: null
  };

  // ---------------- 小工具 ----------------
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }
  function setPath(obj, path, val) {
    var keys = path.split('.');
    var last = keys.pop();
    var cur = keys.reduce(function (o, k) { if (o[k] == null) o[k] = {}; return o[k]; }, obj);
    cur[last] = val;
  }
  function toast(msg, bad) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast'; }, 2600);
  }
  function status(msg) {
    var s = $('#statusText');
    if (s) s.textContent = msg;
  }
  function fmtPct(u, d) { return (u * 100).toFixed(d === undefined ? 1 : d); }
  function toPt(u) { return S.unitToPt(u, 85); }          // 以 85mm 单栏为基准展示
  function fromPt(pt) { return pt / (85 * 2.834645669); }

  // ---------------- 分析主流程 ----------------
  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件（PNG / JPG / WebP）', true); return; }
    status('正在读取图片…');
    A.loadImageFromFile(file).then(function (img) {
      state.img = img;
      state.name = file.name;
      state.inset = { left: 0, top: 0, right: 0, bottom: 0 };
      var prep = A.prepare(img);
      state.prepared = prep;
      state.refCanvas = prep.normalized;
      reanalyze(true);
    }).catch(function (err) {
      toast(err.message || '图片读取失败', true);
      status('等待图片');
    });
  }

  function loadUrl(url) {
    if (!url) return;
    status('正在加载外链图片…');
    A.loadImageFromUrl(url).then(function (img) {
      state.img = img;
      state.name = '链接图片';
      state.inset = { left: 0, top: 0, right: 0, bottom: 0 };
      var prep = A.prepare(img);
      state.prepared = prep;
      state.refCanvas = prep.normalized;
      reanalyze(true);
    }).catch(function (err) {
      toast(err.message || '外链加载失败', true);
      status('等待图片');
    });
  }

  function reanalyze(fresh) {
    if (!state.refCanvas) return;
    status('正在分析…');
    $('#dropzone').hidden = true;
    $('#workspace').hidden = false;
    try {
      var canvas = A.cropByInset(state.refCanvas, state.inset);
      state.analysisCanvas = canvas;
      var res = A.analyzeCanvas(canvas, { forcedType: state.forcedType });
      state.spec = S.normalizeSpec(res.spec);
      state.stats = res.stats;
      state.spec.thumbnail = A.thumbnail(canvas, 480, 0.72);
      if (fresh) state.originalSpec = S.clone(state.spec);
      buildPanel();
      refreshPreview(true);
      status('分析完成 · 分析宽度 ' + res.stats.analysisWidth + 'px · 检出轴 ' + (res.stats.axesFound ? '是' : '否') + ' · 配色簇 ' + res.stats.clusters);
    } catch (err) {
      console.error(err);
      toast('分析失败：' + (err.message || err), true);
      status('分析失败');
    }
  }

  // ---------------- 预览与度量 ----------------
  function ensurePreviewCanvas() {
    var aspect = state.spec.meta.canvasAspect || (state.refCanvas.width / state.refCanvas.height);
    var w = CANVAS_W, h = Math.max(120, Math.round(w / aspect));
    if (!state.previewCanvas) state.previewCanvas = document.createElement('canvas');
    state.previewCanvas.width = w;
    state.previewCanvas.height = h;
    return state.previewCanvas;
  }

  function refreshPreview(resetBlend) {
    if (!state.spec || !state.refCanvas) return;
    var pv = ensurePreviewCanvas();
    var geo = R.render(pv, state.spec, {
      title: '图名称（示意）',
      xLabel: '横轴标题',
      yLabel: '纵轴标题'
    });
    state.geo = geo;

    // 参考图缩放到同样尺寸
    var ref = document.createElement('canvas');
    ref.width = pv.width; ref.height = pv.height;
    var rctx = ref.getContext('2d');
    rctx.fillStyle = '#fff';
    rctx.fillRect(0, 0, ref.width, ref.height);
    rctx.imageSmoothingQuality = 'high';
    rctx.drawImage(state.analysisCanvas, 0, 0, ref.width, ref.height);
    state.refSized = ref;

    state.score = R.compare(ref, pv);
    updateMetrics();
    drawView();
    if (resetBlend) state.blend = 0.5;
  }

  function updateMetrics() {
    if (!state.score) return;
    var s = state.score;
    $('#scoreValue').textContent = s.score.toFixed(1);
    $('#scoreRing').style.setProperty('--p', (s.score / 100).toFixed(3));
    $('#metricDetail').textContent = '亮度差 ' + (s.mae * 100).toFixed(1) + '% · 结构差 ' + (s.edgeDiff * 100).toFixed(1) + '%';
    var hint = $('#specHint');
    if (hint && state.stats) {
      hint.textContent = '图型判断：' + state.stats.typeHint + '　线宽测得 ' + (state.stats.lineWidthPx ? state.stats.lineWidthPx.toFixed(1) + 'px' : '未测到');
    }
  }

  function drawView() {
    var canvas = $('#stageCanvas');
    if (!canvas || !state.spec) return;
    var ref = state.refSized;
    canvas.width = ref.width;
    canvas.height = ref.height;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(ref, 0, 0);
  }

  // ---------------- 参数面板 ----------------
  var GROUPS = [
    {
      conf: 'layout', title: '画布与版式',
      items: [
        { path: 'meta.canvasAspect', label: '宽高比', type: 'num', step: 0.01, min: 0.4, max: 4, suffix: ': 1' },
        { path: 'meta.chartType', label: '图型', type: 'select', options: [['bar', '柱状'], ['line', '折线'], ['scatter', '散点'], ['box', '箱线'], ['heatmap', '热图']] },
        { path: 'layout.plotLeft', label: '左留白', type: 'pct' },
        { path: 'layout.plotRight', label: '右留白', type: 'pct' },
        { path: 'layout.plotTop', label: '上留白', type: 'pct' },
        { path: 'layout.plotBottom', label: '下留白', type: 'pct' }
      ]
    },
    {
      conf: 'strokes', title: '线条',
      items: [
        { path: 'strokes.axis', label: '轴线', type: 'pt' },
        { path: 'strokes.series', label: '数据线', type: 'pt' },
        { path: 'strokes.markerEdge', label: '标记描边', type: 'pt' },
        { path: 'strokes.errorbar', label: '误差棒', type: 'pt' },
        { path: 'strokes.grid', label: '网格线', type: 'pt' }
      ]
    },
    {
      conf: 'text', title: '文字',
      items: [
        { path: 'text.title', label: '标题', type: 'pt' },
        { path: 'text.axisTitle', label: '轴标题', type: 'pt' },
        { path: 'text.tickLabel', label: '刻度标签', type: 'pt' },
        { path: 'text.legend', label: '图例', type: 'pt' },
        { path: 'text.family', label: '字族', type: 'select', options: [['sans', '无衬线'], ['serif', '衬线'], ['condensed', '窄体']] },
        { path: 'text.weight', label: '字重', type: 'select', options: [['normal', '常规'], ['medium', '中等'], ['bold', '加粗']] }
      ]
    },
    {
      conf: 'ticks', title: '刻度与网格',
      items: [
        { path: 'ticks.direction', label: '刻度方向', type: 'select', options: [['out', '朝外'], ['in', '朝内']] },
        { path: 'ticks.length', label: '刻度长度', type: 'pt' },
        { path: 'ticks.xCount', label: 'X 刻度数', type: 'num', step: 1, min: 0, max: 40 },
        { path: 'ticks.yCount', label: 'Y 刻度数', type: 'num', step: 1, min: 0, max: 40 },
        { path: 'grid.mode', label: '网格', type: 'select', options: [['none', '无'], ['h', '仅横线'], ['v', '仅竖线'], ['both', '双向']] },
        { path: 'grid.style', label: '网格线型', type: 'select', options: [['solid', '实线'], ['dash', '虚线']] },
        { path: 'grid.alpha', label: '网格透明度', type: 'num', step: 0.05, min: 0, max: 1 },
        { path: 'frame.border', label: '外框', type: 'check' },
        { path: 'frame.zeroLine', label: '零线', type: 'check' }
      ]
    },
    {
      conf: 'legend', title: '图例与标记',
      items: [
        { path: 'legend.visible', label: '显示图例', type: 'check' },
        { path: 'legend.position', label: '图例位置', type: 'select', options: [['top-right', '右上'], ['top-left', '左上'], ['bottom-right', '右下'], ['bottom-left', '左下']] },
        { path: 'legend.frame', label: '图例边框', type: 'check' },
        { path: 'markers.radius', label: '标记半径', type: 'pt2' },
        { path: 'markers.fillAlpha', label: '标记不透明度', type: 'num', step: 0.05, min: 0, max: 1 }
      ]
    }
  ];

  var TYPE_FIELDS = {
    bar: [
      { path: 'specific.bar.widthRatio', label: '整组宽占比', type: 'num', step: 0.02, min: 0.1, max: 1 },
      { path: 'specific.bar.gap', label: '组内柱间距', type: 'num', step: 0.001, min: 0, max: 0.05 },
      { path: 'specific.bar.edgeWidth', label: '柱边框', type: 'pt' },
      { path: 'specific.errorbar.capWidth', label: '误差棒帽宽', type: 'pt2' }
    ],
    line: [
      { path: 'specific.line.lineMode', label: '连线方式', type: 'select', options: [['straight', '折线'], ['smooth', '平滑曲线']] },
      { path: 'specific.line.lineOffset', label: '线宽偏移', type: 'num', step: 0.1, min: -2, max: 2 },
      { path: 'markers.shape', label: '标记形状', type: 'select', options: [['circle', '圆'], ['square', '方'], ['triangle', '三角'], ['diamond', '菱形']] }
    ],
    scatter: [
      { path: 'specific.scatter.radius', label: '点半径', type: 'pt2' },
      { path: 'specific.scatter.fillAlpha', label: '点不透明度', type: 'num', step: 0.05, min: 0, max: 1 },
      { path: 'markers.shape', label: '点形状', type: 'select', options: [['circle', '圆'], ['square', '方'], ['triangle', '三角'], ['diamond', '菱形']] }
    ],
    box: [
      { path: 'specific.box.capWidth', label: '须帽宽度', type: 'pt2' },
      { path: 'specific.box.whisker', label: '须长度系数', type: 'num', step: 0.1, min: 0.5, max: 3 }
    ],
    heatmap: [
      { path: 'specific.heatmap.cellGap', label: '单元格间隙', type: 'pt2' }
    ],
    errorbar: [
      { path: 'specific.errorbar.capWidth', label: '误差棒帽宽', type: 'pt2' }
    ]
  };

  function confOf(groupKey) {
    if (!state.spec) return null;
    var c = state.spec.confidence.items[groupKey];
    return typeof c === 'number' ? c : null;
  }

  // 每项参数的测量依据（按路径匹配，越具体的规则放前面）
  var EV_RULES = [
    [/^meta\.chartType/, '用户在上传前指定的图型，分析全程按它执行'],
    [/^meta\.canvasAspect/, '输入画布的宽高比'],
    [/^layout\./, '墨迹外接框相对画布边界的留白比例'],
    [/^colors\.axis/, '轴线区域出现最多的深色'],
    [/^colors\.text/, '文字连通域的主色'],
    [/^colors\.grid/, '绘图区内低对比度等距线条的颜色'],
    [/^colors\.background/, '画布中出现次数最多的颜色'],
    [/^colors\./, '绘图区颜色聚类，取面积占比最高的主色'],
    [/^strokes\.axis/, '沿轴线位置逐列扫描，取连续同色段的最小宽度（抗锯齿只会变宽，最小值最准）'],
    [/^strokes\.errorbar/, '误差棒竖直段的宽度'],
    [/^strokes\.markerEdge/, '柱/标记边缘是否比填充明显更暗；没有深色描边则记 0'],
    [/^strokes\./, '沿线位置扫描，取连续同色段的最小宽度'],
    [/^text\.title/, '标题文字连通域高度 ÷ 0.72 换算字号'],
    [/^text\./, '该类文字连通域高度 ÷ 0.72 换算字号'],
    [/^ticks\./, '刻度线的可见长度'],
    [/^grid\./, '绘图区内等距低对比线条的分布'],
    [/^legend\./, '搜索绘图区上方区域的方形色块，按系列色匹配'],
    [/^frame\./, '判断四条边灰线是否闭合'],
    [/^markers\./, '小连通域的尺寸与长宽比'],
    [/^letters\./, '柱体上方字母连通域的高度与笔画粗细'],
    [/^specific\.bar\.gap/, '逐个间隙采样：整列为背景色才算真间隙，柱色过渡视为紧贴'],
    [/^specific\.bar\.widthRatio/, '组首列到组末列宽度 ÷ 相邻组首列间距（整组宽 / 类间距）'],
    [/^specific\.bar\.edgeWidth/, '柱边缘是否比填充明显更暗；是则记为描边，否则无边框'],
    [/^specific\.errorbar/, '误差棒端帽的水平宽度'],
    [/^specific\.line/, '折线拐点、平滑度与标记填充'],
    [/^specific\./, '该图型对应的专属测量']
  ];
  function evidenceFor(path) {
    for (var i = 0; i < EV_RULES.length; i++) if (EV_RULES[i][0].test(path)) return EV_RULES[i][1];
    return '';
  }

  function buildPanel() {
    var host = $('#specPanel');
    host.innerHTML = '';
    if (!state.spec) {
      host.appendChild(el('p', 'panel-empty', '还没有数据。先在左侧拖入一张参考图。'));
      return;
    }
    GROUPS.forEach(function (g) { host.appendChild(buildGroup(g)); });

    // 配色组单独渲染（需要增删系列色）
    host.appendChild(buildColorGroup());

    // 图型专属参数
    var type = state.spec.meta.chartType;
    var tf = TYPE_FIELDS[type];
    if (tf && tf.length) {
      host.appendChild(buildGroup({ conf: 'chartType', title: '图型参数（' + type + '）', items: tf }));
    }
  }

  function buildGroup(g) {
    var box = el('section', 'pgroup');
    var head = el('div', 'pgroup-head');
    head.appendChild(el('h3', null, g.title));
    var c = confOf(g.conf);
    if (c !== null) {
      var dot = el('span', 'conf' + (c < 0.6 ? ' low' : ''), Math.round(c * 100) + '%');
      dot.title = c < 0.6 ? '这一组参数测得不准，建议手工核对' : '这一组参数的可信度';
      head.appendChild(dot);
    }
    box.appendChild(head);

    var grid = el('div', 'pgroup-body');
    g.items.forEach(function (it) { grid.appendChild(buildField(it)); });
    box.appendChild(grid);
    // 测量依据：逐项说明这个值是怎么量出来的
    var det = el('details', 'pgroup-ev');
    det.appendChild(el('summary', null, '测量依据'));
    g.items.forEach(function (it) {
      var e = evidenceFor(it.path);
      if (e) det.appendChild(el('p', 'ev', it.label + '：' + e));
    });
    box.appendChild(det);
    return box;
  }

  function buildField(it) {
    var row = el('label', 'pfield');
    row.appendChild(el('span', 'pfield-label', it.label));
    var val = getPath(state.spec, it.path);

    if (it.type === 'check') {
      var box = el('input');
      box.type = 'checkbox';
      box.checked = !!val;
      box.addEventListener('change', function () {
        setPath(state.spec, it.path, box.checked);
        onFieldChange(it.path);
      });
      row.appendChild(box);
      row.classList.add('inline');
      return row;
    }

    if (it.type === 'select') {
      var sel = document.createElement('select');
      it.options.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        if (String(val) === o[0]) op.selected = true;
        sel.appendChild(op);
      });
      sel.addEventListener('change', function () {
        setPath(state.spec, it.path, sel.value);
        if (it.path === 'meta.chartType') { state.forcedType = sel.value; reanalyze(true); return; }
        onFieldChange(it.path);
      });
      row.appendChild(sel);
      row.classList.add('inline');
      return row;
    }

    var input = el('input');
    input.type = 'number';
    if (it.type === 'pct') {
      input.step = 0.1; input.min = 0; input.max = 55;
      input.value = fmtPct(val, 1);
      input.dataset.kind = 'pct';
    } else if (it.type === 'pt' || it.type === 'pt2') {
      input.step = 0.05; input.min = 0; input.max = 12;
      input.value = toPt(val).toFixed(2);
      input.dataset.kind = 'pt';
    } else {
      input.step = it.step || 1; input.min = it.min; input.max = it.max;
      input.value = typeof val === 'number' ? (Number.isInteger(val) ? val : val.toFixed(2)) : val;
      input.dataset.kind = 'num';
    }
    var hint = el('em', 'pfield-hint', it.type === 'pt' || it.type === 'pt2' ? fmtPct(val, 2) + '% 画布宽' : (it.type === 'pct' ? '占画布宽' : (it.suffix || '')));
    input.addEventListener('change', function () {
      var n = parseFloat(input.value);
      if (!isFinite(n)) { buildPanel(); return; }
      var target;
      if (it.type === 'pct') target = n / 100;
      else if (it.type === 'pt' || it.type === 'pt2') target = fromPt(n);
      else target = n;
      setPath(state.spec, it.path, target);
      onFieldChange(it.path);
      if (it.type === 'pt' || it.type === 'pt2') hint.textContent = fmtPct(getPath(state.spec, it.path), 2) + '% 画布宽';
    });
    row.appendChild(input);
    row.appendChild(hint);
    return row;
  }

  function buildColorGroup() {
    var box = el('section', 'pgroup');
    var head = el('div', 'pgroup-head');
    head.appendChild(el('h3', null, '配色'));
    var c = confOf('colors');
    if (c !== null) head.appendChild(el('span', 'conf' + (c < 0.6 ? ' low' : ''), Math.round(c * 100) + '%'));
    box.appendChild(head);

    var body = el('div', 'pgroup-body colors-body');

    [['colors.background', '背景'], ['colors.text', '文字'], ['colors.axis', '轴线'], ['colors.grid', '网格']].forEach(function (pair) {
      var row = el('label', 'pfield inline');
      row.appendChild(el('span', 'pfield-label', pair[1]));
      var inp = document.createElement('input');
      inp.type = 'color';
      inp.value = getPath(state.spec, pair[0]) || '#000000';
      inp.addEventListener('input', function () {
        setPath(state.spec, pair[0], inp.value);
        onFieldChange(pair[0]);
      });
      row.appendChild(inp);
      body.appendChild(row);
    });

    var seriesWrap = el('div', 'series-block');
    seriesWrap.appendChild(el('span', 'pfield-label', '系列色（按面积排序）'));
    var pickTip = el('div', 'pick-hint', '点击「取色」后在左侧参考图上点一下即可吸取该位置颜色');
    if (state.pickMode !== null) pickTip.classList.add('active');
    seriesWrap.appendChild(pickTip);
    var list = el('div', 'series-list');
    state.spec.colors.series.forEach(function (hex, i) {
      var item = el('div', 'series-item');
      if (state.pickMode === i) item.classList.add('picking');
      var inp = document.createElement('input');
      inp.type = 'color';
      inp.value = hex;
      inp.addEventListener('input', function () {
        state.spec.colors.series[i] = inp.value;
        onFieldChange('colors.series');
      });
      item.appendChild(inp);
      var idx = el('code', null, String(i + 1));
      item.appendChild(idx);
      var pick = el('button', 'mini pick' + (state.pickMode === i ? ' on' : ''), '取色');
      pick.type = 'button';
      pick.title = '从参考图吸取颜色';
      pick.addEventListener('click', function () {
        state.pickMode = (state.pickMode === i) ? null : i;
        buildPanel();
        var canvas = $('#stageCanvas');
        if (canvas) canvas.style.cursor = state.pickMode !== null ? 'crosshair' : '';
        status(state.pickMode !== null ? '取色模式：在参考图上点击吸取第 ' + (i + 1) + ' 个系列色' : '');
      });
      item.appendChild(pick);
      if (state.spec.colors.series.length > 1) {
        var del = el('button', 'mini', '×');
        del.type = 'button';
        del.title = '移除这个系列色';
        del.addEventListener('click', function () {
          state.spec.colors.series.splice(i, 1);
          state.pickMode = null;
          buildPanel(); onFieldChange('colors.series');
        });
        item.appendChild(del);
      }
      list.appendChild(item);
    });
    seriesWrap.appendChild(list);
    var add = el('button', 'mini add', '+ 添加系列色');
    add.type = 'button';
    add.addEventListener('click', function () {
      if (state.spec.colors.series.length >= 12) { toast('最多 12 个系列色'); return; }
      state.spec.colors.series.push('#8a8a8a');
      buildPanel(); onFieldChange('colors.series');
    });
    seriesWrap.appendChild(add);
    body.appendChild(seriesWrap);
    box.appendChild(body);
    return box;
  }

  function onFieldChange(path) {
    state.spec = S.normalizeSpec(state.spec);
    if (path === 'meta.chartType') buildPanel();
    refreshPreview(false);
    status('参数已更新 · 结构相似度 ' + (state.score ? state.score.score.toFixed(1) : '—'));
  }

  // ---------------- 自动校正 ----------------
  function autoTune() {
    if (!state.spec) return;
    var base = S.clone(state.spec);
    var best = { score: -1, spec: null, s: 1, t: 1 };
    var pv = ensurePreviewCanvas();
    var strokes = ['series', 'axis', 'markerEdge', 'errorbar', 'grid'];
    var texts = ['title', 'axisTitle', 'tickLabel', 'legend'];
    var sList = [0.8, 0.9, 1, 1.1, 1.25];
    var tList = [0.85, 1, 1.15];
    sList.forEach(function (sm) {
      tList.forEach(function (tm) {
        var trial = S.clone(base);
        strokes.forEach(function (k) { trial.strokes[k] *= sm; });
        texts.forEach(function (k) { trial.text[k] *= tm; });
        trial = S.normalizeSpec(trial);
        R.render(pv, trial, { title: '图名称（示意）', xLabel: '横轴标题', yLabel: '纵轴标题' });
        var sc = R.compare(state.refSized, pv).score;
        if (sc > best.score) best = { score: sc, spec: trial, s: sm, t: tm };
      });
    });
    if (!best.spec) { toast('自动校正未取得更好结果'); return; }
    state.spec = best.spec;
    buildPanel();
    refreshPreview(false);
    toast('自动校正完成 · 结构相似度 ' + best.score.toFixed(1) + '（线宽 ×' + best.s + '，字号 ×' + best.t + '）');
  }

  // ---------------- 导出 ----------------
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 400);
  }

  function exportSpec() {
    if (!state.spec) return;
    state.spec = S.normalizeSpec(state.spec);
    download(S.filename(state.spec), S.serialize(state.spec), 'application/json;charset=utf-8');
    toast('已导出 ' + S.filename(state.spec));
  }

  function copySummary() {
    if (!state.spec) return;
    var txt = S.summaryText(state.spec);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('参数摘要已复制'); })
        .catch(function () { fallbackCopy(txt); });
    } else fallbackCopy(txt);
  }

  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('参数摘要已复制'); }
    catch (e) { toast('复制失败，请手动选择文本', true); }
    ta.remove();
  }

  function resetToOriginal() {
    if (!state.originalSpec) return;
    state.spec = S.clone(state.originalSpec);
    buildPanel();
    refreshPreview(false);
    toast('已还原到自动测量结果');
  }

  // ---------------- 事件绑定 ----------------
  function bind() {
    var fileInput = $('#fileInput');
    $('#pickFile').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
      fileInput.value = '';
    });

    var zone = $('#dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('over'); });
    });
    zone.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    $('#urlGo').addEventListener('click', function () {
      var u = $('#urlInput').value.trim();
      if (u) loadUrl(u);
    });
    $('#urlInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('#urlGo').click(); }
    });

    // 支持直接粘贴截图
    document.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile();
          if (f) { loadFile(f); e.preventDefault(); return; }
        }
      }
    });

    // 图型由参数面板的下拉决定；改动后按新图型重新抓取

    // 从参考图取色
    var stageCanvas = $('#stageCanvas');
    if (stageCanvas) {
      stageCanvas.addEventListener('click', function (e) {
        if (state.pickMode === null || !state.refSized) return;
        var rect = stageCanvas.getBoundingClientRect();
        var scaleX = stageCanvas.width / rect.width;
        var scaleY = stageCanvas.height / rect.height;
        var x = Math.round((e.clientX - rect.left) * scaleX);
        var y = Math.round((e.clientY - rect.top) * scaleY);
        var ctx = stageCanvas.getContext('2d');
        var pixel = ctx.getImageData(x, y, 1, 1).data;
        var hex = '#' + [pixel[0], pixel[1], pixel[2]].map(function (v) {
          return v.toString(16).padStart(2, '0');
        }).join('');
        state.spec.colors.series[state.pickMode] = hex;
        var idx = state.pickMode;
        state.pickMode = null;
        stageCanvas.style.cursor = '';
        buildPanel();
        onFieldChange('colors.series');
        status('已吸取第 ' + (idx + 1) + ' 个系列色：' + hex.toUpperCase());
      });
    }

    $('#applyCrop').addEventListener('click', function () {
      state.inset = {
        left: Math.max(0, Math.min(40, parseFloat($('#cropLeft').value) || 0)) / 100,
        top: Math.max(0, Math.min(40, parseFloat($('#cropTop').value) || 0)) / 100,
        right: Math.max(0, Math.min(40, parseFloat($('#cropRight').value) || 0)) / 100,
        bottom: Math.max(0, Math.min(40, parseFloat($('#cropBottom').value) || 0)) / 100
      };
      reanalyze(false);
    });

    $('#reanalyze').addEventListener('click', function () { reanalyze(false); });
    $('#autoTune').addEventListener('click', autoTune);
    $('#resetSpec').addEventListener('click', resetToOriginal);
    $('#exportSpec').addEventListener('click', exportSpec);
    $('#copySummary').addEventListener('click', copySummary);
    $('#changeImage').addEventListener('click', function () {
      $('#workspace').hidden = true;
      $('#dropzone').hidden = false;
      status('等待图片');
    });
  }

  document.addEventListener('DOMContentLoaded', bind);
})();
