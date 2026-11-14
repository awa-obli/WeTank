'use strict';

// 小地图几何的单元测试：直接跑 `node tests/minimap.test.js` 即可，无额外依赖。
// 重点覆盖：
//   1. 三档 3:2 地图都能等比塞进小地图并居中，四周留出内边距；
//   2. 小地图比例不是 3:2 时只按较小的一边缩放，地图不变形；
//   3. 世界 → 小地图的坐标映射：四角、中心、墙体矩形；
//   4. 视野多边形映射后点数不变、非法顶点被跳过；
//   5. 非法尺寸有安全回退，不会返回 NaN / 负的可用区域。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeLayout,
  worldToMini,
  toMiniPolygon,
  rectToMini,
} = require('../public/minimap');

// 与 index.html 里 <canvas id="minimap" width="480" height="320"> 保持一致
const MINI_W = 480;
const MINI_H = 320;
const PAD = 6;

const MAPS = [
  { name: '小图', w: 720, h: 480 },
  { name: '中图', w: 960, h: 640 },
  { name: '大图', w: 1200, h: 800 },
];

function close(actual, expected, msg = '', eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg} expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`
  );
}

test('三档 3:2 地图：整图等比放进小地图并居中', () => {
  for (const map of MAPS) {
    const layout = computeLayout(map.w, map.h, MINI_W, MINI_H, PAD);
    // 3:2 的小地图里，高度先到上限（480×320 只有 308 的可用高），宽度留白更多
    close(layout.h, MINI_H - PAD * 2, `${map.name} 高 `);
    close(layout.w, layout.h * (map.w / map.h), `${map.name} 保持世界宽高比 `);
    assert.ok(layout.w <= MINI_W - PAD * 2 + 1e-9, `${map.name} 宽度不超出可用区域`);
    // 垂直方向正好是 pad，水平方向居中（可能比 pad 大）
    close(layout.y, PAD, `${map.name} 上边距 `);
    close(layout.x, (MINI_W - layout.w) / 2, `${map.name} 水平居中 `);
    assert.ok(layout.x >= PAD - 1e-9, `${map.name} 左边距不小于 pad`);
    assert.ok(layout.x + layout.w <= MINI_W - PAD + 1e-9, `${map.name} 右边距不小于 pad`);
    // 小地图始终在地图画布内
    assert.ok(layout.y >= 0 && layout.y + layout.h <= MINI_H);
  }
});

test('小地图比例不是 3:2 时：按较小的一边缩放，地图不变形', () => {
  const layout = computeLayout(1200, 800, 300, 300, 5);
  // 可用 290×290：宽度先到上限，高度按世界宽高比缩到 193.33…
  close(layout.w, 290, '宽 ');
  close(layout.h, (290 * 800) / 1200, '高 ');
  close(layout.x, 5, '左边距 ');
  close(layout.y, (300 - layout.h) / 2, '垂直居中 ');
});

test('世界坐标 → 小地图坐标：四角映射到地图矩形四角，中心映射到画布中心', () => {
  const layout = computeLayout(1200, 800, MINI_W, MINI_H, PAD);
  const topLeft = worldToMini(layout, 0, 0);
  const bottomRight = worldToMini(layout, 1200, 800);
  close(topLeft.x, layout.x, '左上 x ');
  close(topLeft.y, layout.y, '左上 y ');
  close(bottomRight.x, layout.x + layout.w, '右下 x ');
  close(bottomRight.y, layout.y + layout.h, '右下 y ');

  // 三档地图都居中：世界中心一定落在画布正中
  for (const map of MAPS) {
    const l = computeLayout(map.w, map.h, MINI_W, MINI_H, PAD);
    const center = worldToMini(l, map.w / 2, map.h / 2);
    close(center.x, MINI_W / 2, `${map.name} 中心 x `);
    close(center.y, MINI_H / 2, `${map.name} 中心 y `);
  }
});

test('墙体矩形 → 小地图矩形', () => {
  const layout = computeLayout(720, 480, MINI_W, MINI_H, PAD);
  const box = rectToMini(layout, { cx: 360, cy: 240, hw: 5, hh: 5 });
  assert.ok(box);
  close(box.x, layout.x + (360 - 5) * layout.scale, 'x ');
  close(box.y, layout.y + (240 - 5) * layout.scale, 'y ');
  close(box.w, 10 * layout.scale, 'w ');
  close(box.h, 10 * layout.scale, 'h ');

  // 外围边框矩形：中心在世界边界外，映射结果允许超出地图矩形，由调用方裁剪
  const border = rectToMini(layout, { cx: 360, cy: 0, hw: 370, hh: 5 });
  assert.ok(border.x < layout.x && border.x + border.w > layout.x + layout.w);
});

test('视野多边形映射：点数不变，顶点按 layout 映射', () => {
  const layout = computeLayout(1200, 800, MINI_W, MINI_H, PAD);
  const worldPoly = [
    { x: 0, y: 0 },
    { x: 1200, y: 0 },
    { x: 1200, y: 800 },
    { x: 0, y: 800 },
  ];
  const miniPoly = toMiniPolygon(layout, worldPoly);
  assert.equal(miniPoly.length, 4);
  miniPoly.forEach((p, i) => {
    close(p.x, layout.x + worldPoly[i].x * layout.scale, `顶点 ${i} x `);
    close(p.y, layout.y + worldPoly[i].y * layout.scale, `顶点 ${i} y `);
  });
  // 映射后仍然是同一个矩形
  close(miniPoly[0].x, layout.x);
  close(miniPoly[2].x, layout.x + layout.w);
  close(miniPoly[2].y, layout.y + layout.h);
});

test('非法顶点被跳过，非法入参返回空数组', () => {
  const layout = computeLayout(1200, 800, MINI_W, MINI_H, PAD);
  const miniPoly = toMiniPolygon(layout, [
    { x: 10, y: 10 },
    null,
    { x: NaN, y: 10 },
    { x: '20', y: 20 },
    { x: 30, y: 30 },
  ]);
  assert.equal(miniPoly.length, 2);
  assert.deepEqual(toMiniPolygon(layout, null), []);
  assert.deepEqual(toMiniPolygon(layout, undefined), []);
  assert.deepEqual(toMiniPolygon(null, [{ x: 1, y: 1 }]), []);
});

test('非法尺寸有安全回退，所有返回值都是有限数', () => {
  const layout = computeLayout(NaN, 0, MINI_W, MINI_H, PAD);
  for (const key of ['scale', 'x', 'y', 'w', 'h']) {
    assert.ok(Number.isFinite(layout[key]), `${key} 应为有限数`);
  }
  assert.ok(layout.scale > 0 && layout.w > 0 && layout.h > 0);
  // 非法点按 (0, 0) 处理
  assert.deepEqual(worldToMini(layout, NaN, undefined), { x: layout.x, y: layout.y });
  // 非法墙体
  assert.equal(rectToMini(layout, null), null);
  assert.equal(rectToMini(layout, { cx: 0, cy: 0, hw: -1, hh: 1 }), null);
  assert.equal(rectToMini(layout, { cx: Infinity, cy: 0, hw: 1, hh: 1 }), null);
});

test('内边距过大时自动收窄，可用区域始终为正', () => {
  const layout = computeLayout(720, 480, 100, 100, 80);
  assert.ok(layout.w > 0 && layout.h > 0);
  assert.ok(layout.x >= 0 && layout.y >= 0);
  assert.ok(layout.x + layout.w <= 100 && layout.y + layout.h <= 100);
});

test('小地图尺寸非法时返回零尺寸布局，不会吐出 NaN', () => {
  const layout = computeLayout(720, 480, 0, 0, 6);
  assert.deepEqual(layout, { scale: 0, x: 0, y: 0, w: 0, h: 0 });
  const point = worldToMini(layout, 100, 100);
  assert.deepEqual(point, { x: 0, y: 0 });
});
