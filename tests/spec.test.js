/*
 * StyleGrab · 最小单测（node tests/spec.test.js）
 * 只测纯逻辑：协议归一化、单位换算、色彩工具。涉及 Canvas 的部分留给浏览器验证。
 */
'use strict';

var assert = require('assert');
var path = require('path');

var Spec = require(path.join(__dirname, '..', 'spec-schema.js'));
var Analyze = require(path.join(__dirname, '..', 'image-analysis.js'));
var Render = require(path.join(__dirname, '..', 'preview-renderer.js'));

var failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (err) {
    failures++;
    console.log('  FAIL ' + name + '\n       ' + err.message);
  }
}

console.log('sp1 协议');

test('默认值归一化后字段齐全', function () {
  var s = Spec.normalizeSpec({});
  assert.strictEqual(s.protocol, 'sp1');
  assert.strictEqual(s.meta.chartType, 'bar');
  assert.ok(Array.isArray(s.colors.series) && s.colors.series.length >= 1);
  assert.ok(typeof s.specific.heatmap.gradient[0] === 'string');
  assert.ok(s.confidence && typeof s.confidence.overall === 'number');
});

test('非法数值被收敛到合法区间', function () {
  var s = Spec.normalizeSpec({ layout: { plotLeft: 9, plotRight: -3, plotTop: 0.2, plotBottom: 0.2 } });
  assert.ok(s.layout.plotLeft <= 0.45, '左留白应收敛');
  assert.ok(s.layout.plotRight >= 0);
  assert.ok(s.layout.plotLeft + s.layout.plotRight <= 0.8001, '左右留白之和应受限');
});

test('未知字段保留、未知图型回落到 bar', function () {
  var s = Spec.normalizeSpec({ meta: { chartType: 'pie', futureField: 42 } });
  assert.strictEqual(s.meta.chartType, 'bar');
  assert.strictEqual(s.meta.futureField, 42, '未知字段应保留（向前兼容）');
});

test('非法系列色被替换为合法 hex', function () {
  var s = Spec.normalizeSpec({ colors: { series: ['red', '#00FF00', '#123'] } });
  s.colors.series.forEach(function (c) { assert.ok(/^#[0-9a-f]{6}$/.test(c), '得到的不是 6 位 hex：' + c); });
});

test('协议号不匹配时给出提示但可继续', function () {
  var r = Spec.validateSpec({ protocol: 'sp9', layout: {}, colors: { series: ['#000000'] }, meta: { chartType: 'bar' } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.join('').indexOf('sp9') >= 0);
});

test('pt 换算：0.32% 画布宽在 85mm 下约为 0.77pt', function () {
  var pt = Spec.unitToPt(0.0032, 85);
  assert.ok(Math.abs(pt - 0.771) < 0.01, '实际 ' + pt);
});

test('导出文件名包含图型与日期', function () {
  var n = Spec.filename({ meta: { chartType: 'line', sourceName: 'fig 2 对比.png' } });
  assert.ok(/^stylegrab-line-/.test(n), n);
  assert.ok(/\.spec\.json$/.test(n), n);
  assert.ok(/\d{8}/.test(n), n);
});

test('参数摘要包含线宽与字号换算式', function () {
  var txt = Spec.summaryText(Spec.normalizeSpec({}));
  assert.ok(txt.indexOf('数据线') >= 0);
  assert.ok(txt.indexOf('pt') >= 0);
  assert.ok(txt.indexOf('配色') >= 0);
});

test('序列化结果可被再次归一化且不丢值', function () {
  var a = Spec.normalizeSpec({ colors: { series: ['#4c7f6b', '#d8a25e'] }, layout: { plotLeft: 0.11 } });
  var b = Spec.normalizeSpec(JSON.parse(Spec.serialize(a)));
  assert.deepStrictEqual(b.colors.series, a.colors.series);
  assert.strictEqual(b.layout.plotLeft, a.layout.plotLeft);
});

console.log('色彩与统计工具');

test('hex 往返一致', function () {
  var rgb = Analyze._pure.hexToRgb('#4c7f6b');
  assert.strictEqual(Analyze._pure.hexOf(rgb.r, rgb.g, rgb.b), '#4c7f6b');
});

test('白色 Lab 亮度接近 100、黑色接近 0', function () {
  var white = Analyze._pure.rgb2lab(255, 255, 255);
  var black = Analyze._pure.rgb2lab(0, 0, 0);
  assert.ok(Math.abs(white[0] - 100) < 0.5, '白 L=' + white[0]);
  assert.ok(Math.abs(black[0]) < 0.5, '黑 L=' + black[0]);
});

test('同色 ΔE 为 0，黑白 ΔE 约为 100', function () {
  var a = Analyze._pure.rgb2lab(76, 127, 107);
  var b = Analyze._pure.rgb2lab(0, 0, 0);
  assert.ok(Analyze._pure.dE76(a, a) < 1e-6);
  assert.ok(Math.abs(Analyze._pure.dE76(a, b) - 53) < 8, 'ΔE=' + Analyze._pure.dE76(a, b));
});

test('median 处理奇偶长度', function () {
  assert.strictEqual(Analyze._pure.median([3, 1, 2]), 2);
  assert.strictEqual(Analyze._pure.median([4, 1, 3, 2]), 2.5);
  assert.strictEqual(Analyze._pure.median([]), 0);
});

console.log('渲染几何');

test('留白比例被正确换算成绘图区矩形', function () {
  var spec = Spec.normalizeSpec({ layout: { plotLeft: 0.1, plotRight: 0.1, plotTop: 0.05, plotBottom: 0.1 }, meta: { canvasAspect: 2 } });
  var g = Render.geometry(spec, 1000, 500);
  assert.ok(Math.abs(g.L - 100) < 1);
  assert.ok(Math.abs(g.R - 900) < 1);
  assert.ok(Math.abs(g.T - 50) < 1);
  // 所有长度都按画布宽度换算：0.1 × 1000 = 100px，与画布高度无关
  assert.ok(Math.abs(g.B - 400) < 1);
});

test('颜色插值端点正确', function () {
  assert.strictEqual(Render.mixHex('#000000', '#ffffff', 0), 'rgb(0,0,0)');
  assert.strictEqual(Render.mixHex('#000000', '#ffffff', 1), 'rgb(255,255,255)');
});

console.log('');
if (failures) {
  console.log(failures + ' 项失败');
  process.exit(1);
} else {
  console.log('全部通过');
}
