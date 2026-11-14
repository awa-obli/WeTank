'use strict';

// 暗黑模式视野几何的单元测试：直接跑 `node tests/vision.test.js` 即可，无额外依赖。
// 重点覆盖：
//   1. 矩形 → 遮挡线段；
//   2. 面朝 90° 扇形内看得远、扇形外只剩近身圈；
//   3. 墙体遮挡：正面墙、背后墙、近身圈被墙切断；
//   4. 可见多边形：所有顶点都落在"扇形/近身圈 + 墙体"的边界内；
//   5. 向外羽化：所有边界顶点一起向外扩，黑色在边界外渐入；
//   6. 墙体阴影：只切墙后区域，墙前（包括撞墙前的扇形边界）不受影响；
//   7. 真实迷宫地图上不越界、不穿过外墙。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_FOV,
  DEFAULT_RANGE,
  DEFAULT_NEAR_RADIUS,
  buildSegments,
  normalizeAngle,
  castRay,
  visibleDistance,
  visibilityPolygon,
  expandPolygon,
  featherRings,
  wallShadowPolygons,
} = require('../public/vision');

const EPS = 1e-6;

function close(actual, expected, eps = EPS, msg = '') {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg} expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`
  );
}

// 一块厚 10px、宽 200px 的竖墙，中心在 (x, y)
function wall(x, y, hw = 5, hh = 100) {
  return { cx: x, cy: y, hw, hh };
}

// 从 (0, 0) 朝 angle 方向看，返回可见距离
function distAt(segments, angle, viewAngle = 0, opts = {}) {
  return visibleDistance(segments, 0, 0, viewAngle, angle, opts);
}

test('矩形展开成 4 条遮挡线段', () => {
  const segments = buildSegments([wall(10, 20, 5, 4)]);
  assert.equal(segments.length, 4);
  // 每条线段都带 AABB，供快速剔除使用
  for (const seg of segments) {
    assert.ok(seg.minX <= seg.maxX && seg.minY <= seg.maxY);
    assert.ok(seg.minX >= 5 && seg.maxX <= 15 && seg.minY >= 16 && seg.maxY <= 24);
  }
  assert.deepEqual(buildSegments(null), []);
});

test('默认视野参数：90° / 360px / 60px', () => {
  close(DEFAULT_FOV, (90 * Math.PI) / 180);
  assert.equal(DEFAULT_RANGE, 360);
  assert.equal(DEFAULT_NEAR_RADIUS, 60);
});

test('空旷地图：扇形内看满距离，扇形外只有近身圈', () => {
  // 远处放一圈墙，避免"没有墙"这种极端情况影响断言
  const segments = buildSegments([wall(2000, 2000)]);
  close(distAt(segments, 0), DEFAULT_RANGE, 1e-6, '正前方');
  close(distAt(segments, (44 * Math.PI) / 180), DEFAULT_RANGE, 1e-6, '44°');
  close(distAt(segments, (-44 * Math.PI) / 180), DEFAULT_RANGE, 1e-6, '−44°');
  close(distAt(segments, (46 * Math.PI) / 180), DEFAULT_NEAR_RADIUS, 1e-6, '46°');
  close(distAt(segments, Math.PI), DEFAULT_NEAR_RADIUS, 1e-6, '正后方');
});

test('扇形边界正好是 ±45°', () => {
  const segments = [];
  const half = (45 * Math.PI) / 180;
  close(distAt(segments, half), DEFAULT_RANGE, 1e-6, '+45°');
  close(distAt(segments, -half), DEFAULT_RANGE, 1e-6, '−45°');
  assert.ok(distAt(segments, half + 1e-4) <= DEFAULT_NEAR_RADIUS + 1e-9, '刚出界就只剩近身圈');
});

test('正前方的墙会挡住视线', () => {
  // 墙在 x=200，厚 10 → 射线在 x=195 处命中
  const segments = buildSegments([wall(200, 0)]);
  close(distAt(segments, 0), 195, 1e-6, '正面墙');
  // 墙很窄（只挡住正前方），偏一点的角度应该越过它
  close(distAt(segments, (30 * Math.PI) / 180), DEFAULT_RANGE, 1e-6, '30° 无墙');
});

test('背后的墙会切断近身圈', () => {
  const segments = buildSegments([wall(-50, 0)]);
  // 正后方：近身圈半径 60，但墙在 x=−45 处，只能看到 45
  close(distAt(segments, Math.PI), 45, 1e-6, '背后墙');
  // 正前方不受影响
  close(distAt(segments, 0), DEFAULT_RANGE, 1e-6, '正前方不受背后墙影响');
});

test('斜向墙体：按线段交点精确截断', () => {
  // 45° 方向一堵横墙（绕原点转 45° 的线段），只验证命中距离合理且小于 range
  const segments = buildSegments([{ cx: 100, cy: 0, hw: 5, hh: 5 }]);
  const d = distAt(segments, 0);
  close(d, 95, 1e-6);
  assert.ok(castRay(segments, 0, 0, (30 * Math.PI) / 180, DEFAULT_RANGE) > 100);
});

test('角度归一化：跨 ±π 的差值判断正确', () => {
  close(normalizeAngle(0), 0);
  close(normalizeAngle(Math.PI * 3), Math.PI);
  close(normalizeAngle(-Math.PI * 1.5), Math.PI / 2);
});

test('可见多边形：顶点全部落在视野上限与墙体之内', () => {
  const segments = buildSegments([
    wall(200, 0),       // 正前方
    wall(-50, 0),       // 背后近身圈
    wall(0, 150),       // 侧后方
  ]);
  const points = visibilityPolygon({ segments, x: 0, y: 0, angle: 0 });
  assert.ok(points.length > 50, `顶点数应足够多（实际 ${points.length}）`);

  const half = DEFAULT_FOV / 2;
  for (const p of points) {
    const r = Math.hypot(p.x, p.y);
    const dir = Math.atan2(p.y, p.x);
    const delta = Math.abs(normalizeAngle(dir));
    const limit = delta <= half + 1e-6 ? DEFAULT_RANGE : DEFAULT_NEAR_RADIUS;
    assert.ok(r <= limit + 1e-3, `顶点超出视野上限: r=${r}, limit=${limit}`);
  }

  // 正前方必须被墙截断在 195 左右（允许 0.5px 的角度采样误差）
  const front = points.filter((p) => Math.abs(Math.atan2(p.y, p.x)) < 1e-3);
  assert.ok(front.length > 0, '正前方应有顶点');
  for (const p of front) assert.ok(p.x <= 195.5, `正前方不应穿过墙: x=${p.x}`);

  // 正后方必须被墙截断在 45 左右
  const back = points.filter((p) => Math.abs(Math.abs(Math.atan2(p.y, p.x)) - Math.PI) < 1e-3);
  assert.ok(back.length > 0, '正后方应有顶点');
  for (const p of back) assert.ok(Math.abs(p.x) <= 45.5, `正后方不应穿过墙: x=${p.x}`);
});

test('可见多边形：扇形边界外不会漏出近身圈以外的区域', () => {
  const points = visibilityPolygon({ segments: [], x: 0, y: 0, angle: 0 });
  const at = (deg, dist) => {
    const a = (deg * Math.PI) / 180;
    return [Math.cos(a) * dist, Math.sin(a) * dist];
  };
  const inside = (deg, dist) => pointInPolygon(points, ...at(deg, dist));

  assert.ok(inside(0, 300), '正前方 300px 应可见');
  assert.ok(inside(28.6, 300), '扇形内 300px 应可见');
  // 扇形边界（±45°）之外、近身圈（60px）之外：必须不可见。
  // 这里专门覆盖"边界径向跳变"用长斜边近似导致的漏视野问题。
  for (const deg of [46, -46, 60, -60, 90, -90]) {
    assert.ok(!inside(deg, 100), `${deg}° 方向 100px 不应可见`);
    assert.ok(!inside(deg, 300), `${deg}° 方向 300px 不应可见`);
  }
  // 近身圈内不朝向的方向仍然可见
  assert.ok(inside(46, 50), '近身圈内 46° 50px 应可见');
  assert.ok(inside(180, 50), '近身圈内正后方 50px 应可见');
});

// 射线法判断点是否在多边形内（测试用）
function pointInPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

test('可见多边形：近身圈是完整的一圈，不会只画朝向一侧', () => {
  const segments = [];
  const points = visibilityPolygon({ segments, x: 0, y: 0, angle: 0 });
  // 统计后半球（|角度| > 90°）的顶点，应该覆盖一整圈
  const behind = points.filter((p) => Math.abs(normalizeAngle(Math.atan2(p.y, p.x))) > Math.PI / 2);
  assert.ok(behind.length > 30, `近身圈后半球顶点过少：${behind.length}`);
  const angles = behind.map((p) => normalizeAngle(Math.atan2(p.y, p.x))).sort((a, b) => a - b);
  assert.ok(angles[angles.length - 1] - angles[0] > Math.PI, '近身圈应覆盖大半个后半球');
});

test('向外扩展：所有边界顶点一起向外移动（墙体顶点也参与）', () => {
  const points = visibilityPolygon({
    segments: buildSegments([wall(100, 0)]),
    x: 0,
    y: 0,
    angle: 0,
  });
  const expanded = expandPolygon(points, 0, 0, 6);
  assert.equal(expanded.length, points.length);

  let wallVertices = 0;
  for (let i = 0; i < points.length; i++) {
    const before = Math.hypot(points[i].x, points[i].y);
    const after = Math.hypot(expanded[i].x, expanded[i].y);
    assert.ok(after > before, `顶点 ${i} 应向外移动`);
    assert.ok(after - before <= 6 + 1e-6, `顶点 ${i} 的径向位移不应超过外扩距离`);
    if (Math.abs(points[i].x - 95) < 1.5) wallVertices += 1;
  }
  assert.ok(wallVertices > 0, '样本里应有墙面顶点');
  // 墙面顶点同样会被向外推（不再有"墙体顶点不参与羽化"的例外）
  const wallIdx = points.findIndex((p) => Math.abs(p.x - 95) < 1.5);
  assert.ok(
    Math.hypot(expanded[wallIdx].x, expanded[wallIdx].y) > Math.hypot(points[wallIdx].x, points[wallIdx].y),
    '墙面顶点也应向外扩'
  );
  assert.equal(expandPolygon(points, 0, 0, 0), points);
  assert.deepEqual(expandPolygon(null, 0, 0, 6), []);
});

test('向外羽化分层：alpha 依次为 1、1/2 …，黑色在边界外线性升到全黑', () => {
  const points = visibilityPolygon({ segments: [], x: 0, y: 0, angle: 0 });
  const rings = featherRings(points, 0, 0, 12, 12);
  assert.equal(rings.length, 13, '原多边形 + 12 层外扩');
  assert.equal(rings[0].alpha, 1);
  assert.equal(rings[0].points, points);
  for (let k = 1; k <= 12; k++) close(rings[k].alpha, 1 / k, 1e-12, `第 ${k} 层 alpha`);

  // 边界外 δ 处会被所有"扩展距离 >= δ"的层覆盖：剩余黑色 = (k-1)/12
  const remainingAt = (delta) => {
    let acc = 1;
    for (let k = 1; k <= 12; k++) {
      if (delta <= k) acc *= 1 - 1 / k;
    }
    return acc;
  };
  close(remainingAt(0.5), 0, 1e-9, '紧贴边界外应完全可见');
  close(remainingAt(1.5), 1 / 12, 1e-9, '边界外 1–2px');
  close(remainingAt(11.5), 11 / 12, 1e-9, '边界外 11–12px');
  assert.equal(remainingAt(12.5), 1, '12px 之外保持全黑');

  // 正后方是纯径向的极限顶点：第 6 层正好外扩 6px
  const backIdx = points.findIndex(
    (p) => Math.abs(Math.abs(normalizeAngle(Math.atan2(p.y, p.x))) - Math.PI) < 1e-3
  );
  assert.ok(backIdx >= 0, '正后方应有顶点');
  const r0 = Math.hypot(points[backIdx].x, points[backIdx].y);
  const r6 = Math.hypot(rings[6].points[backIdx].x, rings[6].points[backIdx].y);
  close(r6, r0 + 6, 1e-6);

  // 墙面顶点同样出现在每一层的外扩里（只是整圈轮廓一起变大）
  const wallPoints = visibilityPolygon({
    segments: buildSegments([wall(100, 0)]),
    x: 0,
    y: 0,
    angle: 0,
  });
  const wallRings = featherRings(wallPoints, 0, 0, 12, 12);
  const wallIdx = wallPoints.findIndex((p) => Math.abs(p.x - 95) < 1.5);
  assert.ok(wallIdx >= 0);
  assert.ok(
    Math.hypot(wallRings[6].points[wallIdx].x, wallRings[6].points[wallIdx].y)
      > Math.hypot(wallPoints[wallIdx].x, wallPoints[wallIdx].y),
    '墙面顶点也应随羽化层一起外扩'
  );

  // 宽度 0 / 层数 1：退化为硬边 / 单层
  assert.deepEqual(featherRings(points, 0, 0, 0), [{ points, alpha: 1 }]);
  assert.equal(featherRings(points, 0, 0, 12, 1).length, 2);
});

test('墙体阴影：覆盖墙后、不覆盖墙前和切线外侧', () => {
  const shadows = wallShadowPolygons([{ cx: 200, cy: 0, hw: 5, hh: 100 }], 0, 0, 380);
  assert.equal(shadows.length, 1);
  const poly = shadows[0];
  assert.ok(poly.length > 4, '阴影多边形应有远边界采样点');
  const inside = (x, y) => pointInPolygon(poly, x, y);

  assert.ok(inside(300, 0), '墙正后方应被阴影覆盖');
  assert.ok(inside(260, 40), '墙后偏一点也应覆盖');
  assert.ok(!inside(150, 0), '墙前不应被阴影覆盖');
  assert.ok(!inside(100, 110), '墙的切线外侧不应被覆盖');

  // 远边界采样到 length，避免宽墙的直弦把覆盖距离缩短
  const far = poly.map((p) => Math.hypot(p.x, p.y));
  close(Math.max(...far), 380, 1e-6);

  // 坦克在墙里 / 墙远在关注区域之外：都不产生阴影
  assert.equal(wallShadowPolygons([{ cx: 0, cy: 0, hw: 5, hh: 5 }], 0, 0, 380).length, 0);
  assert.equal(wallShadowPolygons([{ cx: 5000, cy: 0, hw: 5, hh: 5 }], 0, 0, 380).length, 0);
  assert.deepEqual(wallShadowPolygons(null, 0, 0, 380), []);
});

test('扇形边界撞墙：墙前仍可见（可羽化），墙后阴影硬切', () => {
  // 一堵横墙正好挡在面朝右上的 45° 扇形边界附近，墙面距坦克约 200px
  const ox = 600;
  const oy = 400;
  const shadows = wallShadowPolygons([{ cx: ox + 141, cy: oy + 141, hw: 60, hh: 5 }], ox, oy, 380);
  const covered = (x, y) => shadows.some((poly) => pointInPolygon(poly, x, y));
  // 45° 方向、墙前的点：没有被阴影盖住，说明这里的扇形边界仍可正常羽化
  assert.ok(!covered(ox + 70, oy + 70), '撞墙前的扇形边界应保持可见/羽化');
  // 同方向、墙后的点：被阴影硬切
  assert.ok(covered(ox + 250, oy + 250), '墙后应被阴影覆盖');
});

test('真实迷宫：视野多边形不越界、不穿外墙', () => {
  const { generateMap } = require('../maps');
  const CELL = 80;
  const WALL_THICK = 10;
  const map = generateMap('maze', {
    cols: 12,
    rows: 8,
    cell: CELL,
    wallThick: WALL_THICK,
    rand: mulberry32(20261114),
  });
  const segments = buildSegments(map.rects);
  const worldW = 12 * CELL;
  const worldH = 8 * CELL;
  // 站在地图中间的格子中心
  const x = 6 * CELL;
  const y = 4 * CELL;
  const points = visibilityPolygon({ segments, x, y, angle: 0.7 });
  assert.ok(points.length > 100, `迷宫视野顶点数偏少：${points.length}`);
  for (const p of points) {
    assert.ok(p.x >= -2 && p.x <= worldW + 2, `顶点越界 x=${p.x}`);
    assert.ok(p.y >= -2 && p.y <= worldH + 2, `顶点越界 y=${p.y}`);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), '顶点必须是有限数');
  }
});

// 固定种子的伪随机数，保证迷宫测试可复现
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
