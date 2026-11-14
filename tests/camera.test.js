'use strict';

// 视野跟随相机的单元测试：直接跑 `node tests/camera.test.js` 即可，无额外依赖。
// 重点覆盖：
//   1. 默认视口固定为 720×480（= 9×6 格，和最小档地图同尺寸）；
//   2. 视口以坦克为中心；碰到地图边界夹紧；地图不比视口大时整图居中；
//   3. 目标坐标缺失/非法时有安全回退；
//   4. 世界坐标视口 → 画布像素的变换：铺满画布、居中裁切、不留空白边。

const test = require('node:test');
const assert = require('node:assert/strict');
const { VIEW_W, VIEW_H, computeView, computeTransform, fullView, lerpView, easeInOutCubic } = require('../public/camera');

function close(actual, expected, msg = '', eps = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg} expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`
  );
}

// 三档地图的原始世界尺寸（与服务端 MAP_PRESETS 一致）
const SMALL = { w: 720, h: 480 };
const MEDIUM = { w: 960, h: 640 };
const LARGE = { w: 1200, h: 800 };

test('默认视口是 720×480（9×6 格，与最小地图同尺寸）', () => {
  assert.equal(VIEW_W, 720);
  assert.equal(VIEW_H, 480);
  const view = computeView(360, 240, LARGE.w, LARGE.h);
  assert.equal(view.w, VIEW_W);
  assert.equal(view.h, VIEW_H);
});

test('地图比视口大时，视口以坦克为中心', () => {
  const view = computeView(600, 400, LARGE.w, LARGE.h);
  close(view.x, 600 - VIEW_W / 2, 'x ');
  close(view.y, 400 - VIEW_H / 2, 'y ');
  assert.equal(view.x, 240);
  assert.equal(view.y, 160);
});

test('视口碰到地图边界时夹紧，不会露出地图外', () => {
  // 左上角：视口贴住 (0, 0)
  assert.deepEqual(computeView(0, 0, LARGE.w, LARGE.h), { x: 0, y: 0, w: VIEW_W, h: VIEW_H });
  // 右下角：视口贴住地图右下角
  assert.deepEqual(computeView(LARGE.w, LARGE.h, LARGE.w, LARGE.h), {
    x: LARGE.w - VIEW_W,
    y: LARGE.h - VIEW_H,
    w: VIEW_W,
    h: VIEW_H,
  });
  // 夹紧后视口永远完整落在地图内
  for (const [tx, ty] of [[-500, -500], [0, 800], [1200, 0], [9999, 9999]]) {
    const view = computeView(tx, ty, LARGE.w, LARGE.h);
    assert.ok(view.x >= 0 && view.x + view.w <= LARGE.w, `x 越界: ${view.x}`);
    assert.ok(view.y >= 0 && view.y + view.h <= LARGE.h, `y 越界: ${view.y}`);
  }
});

test('中图：视口只在 240×160 的范围内移动', () => {
  const center = computeView(MEDIUM.w / 2, MEDIUM.h / 2, MEDIUM.w, MEDIUM.h);
  close(center.x, (MEDIUM.w - VIEW_W) / 2, 'x ');
  close(center.y, (MEDIUM.h - VIEW_H) / 2, 'y ');
  assert.equal(center.x, 120);
  assert.equal(center.y, 80);
});

test('小图（地图不大于视口）：整图居中，视口不动', () => {
  const view = computeView(360, 240, SMALL.w, SMALL.h);
  assert.deepEqual(view, { x: 0, y: 0, w: VIEW_W, h: VIEW_H });
  // 即使目标跑到地图外，小图也应该保持整图居中
  assert.deepEqual(computeView(-999, 999, SMALL.w, SMALL.h), { x: 0, y: 0, w: VIEW_W, h: VIEW_H });
  // 比视口更小的地图：两侧露出地图外（调用方负责铺底），视口坐标是负数
  assert.deepEqual(computeView(100, 100, 600, 400), { x: -60, y: -40, w: VIEW_W, h: VIEW_H });
});

test('目标坐标缺失/非法时按地图中心处理', () => {
  const expected = computeView(LARGE.w / 2, LARGE.h / 2, LARGE.w, LARGE.h);
  assert.deepEqual(computeView(NaN, undefined, LARGE.w, LARGE.h), expected);
  assert.deepEqual(computeView(Infinity, null, LARGE.w, LARGE.h), expected);
});

test('变换：视口左上角映射到画布 (0,0)，右下角映射到 (canvasW, canvasH)', () => {
  const view = computeView(600, 400, LARGE.w, LARGE.h); // {240, 160, 720, 480}
  const { scale, tx, ty } = computeTransform(view, 1200, 800);
  close(scale, 1200 / 720, 'scale ');
  close(view.x * scale + tx, 0, '左上 x ');
  close(view.y * scale + ty, 0, '左上 y ');
  close((view.x + view.w) * scale + tx, 1200, '右下 x ');
  close((view.y + view.h) * scale + ty, 800, '右下 y ');
});

test('变换：视口没有被地图边界夹紧时，坦克落在画布中心', () => {
  for (const world of [MEDIUM, LARGE]) {
    const cx = world.w / 2;
    const cy = world.h / 2;
    const view = computeView(cx, cy, world.w, world.h);
    const { scale, tx, ty } = computeTransform(view, world.w, world.h);
    close(cx * scale + tx, world.w / 2, '画布中心 x ');
    close(cy * scale + ty, world.h / 2, '画布中心 y ');
  }
});

test('变换：任意世界点按 (p - 视口左上角) × scale 映射到画布', () => {
  // 视口 {x:0, y:260, w:720, h:480}，画布 1200×800 时 scale = 5/3，没有裁切偏移
  const view = computeView(200, 500, LARGE.w, LARGE.h);
  assert.equal(view.x, 0);
  assert.equal(view.y, 260);
  const { scale, tx, ty } = computeTransform(view, LARGE.w, LARGE.h);
  close(scale, 5 / 3, 'scale ');
  close(333 * scale + tx, 555, 'x ');
  close(444 * scale + ty, (444 - 260) * (5 / 3), 'y ');
});

test('非 3:2 画布按覆盖式缩放：居中裁切、不留空白边', () => {
  const view = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };
  const { scale, tx, ty } = computeTransform(view, 900, 800);
  close(scale, 800 / 480, 'scale 取较大一侧 ');
  // 视口中心仍然映射到画布中心
  close((view.x + view.w / 2) * scale + tx, 450, '中心 x ');
  close((view.y + view.h / 2) * scale + ty, 400, '中心 y ');
  // 铺满画布：左右各被裁掉等量的一截
  assert.ok(view.x * scale + tx < 0 && (view.x + view.w) * scale + tx > 900);
  close(view.x * scale + tx, -(VIEW_W * scale - 900) / 2, '左右裁切对称 ');
});

test('全图视口就是整个世界', () => {
  assert.deepEqual(fullView(1200, 800), { x: 0, y: 0, w: 1200, h: 800 });
  // 全图视口经变换后正好 1:1 铺满同尺寸的画布
  const t = computeTransform(fullView(1200, 800), 1200, 800);
  close(t.scale, 1);
  close(t.tx, 0);
  close(t.ty, 0);
});

test('视口插值：端点精确、越界夹紧', () => {
  const a = { x: 240, y: 160, w: 720, h: 480 };
  const b = { x: 0, y: 0, w: 1200, h: 800 };
  assert.deepEqual(lerpView(a, b, 0), a);
  assert.deepEqual(lerpView(a, b, 1), b);
  assert.deepEqual(lerpView(a, b, -5), a);
  assert.deepEqual(lerpView(a, b, 5), b);
  assert.deepEqual(lerpView(a, b, 0.5), { x: 120, y: 80, w: 960, h: 640 });
});

test('阵亡拉远过渡：视口始终保持 3:2、始终落在地图内', () => {
  for (const world of [MEDIUM, LARGE]) {
    for (const [tx, ty] of [[world.w / 2, world.h / 2], [10, 10], [world.w - 10, world.h - 10]]) {
      const from = computeView(tx, ty, world.w, world.h); // 跟随视口
      const to = fullView(world.w, world.h);
      for (const p of [0, 0.25, 0.5, 0.75, 1]) {
        const view = lerpView(from, to, p);
        close(view.w / view.h, 1.5, `t=${p} 保持 3:2 `);
        assert.ok(view.x >= -1e-9 && view.y >= -1e-9, `t=${p} 左上角不越界`);
        assert.ok(view.x + view.w <= world.w + 1e-9, `t=${p} 右下角不越界`);
        assert.ok(view.y + view.h <= world.h + 1e-9, `t=${p} 右下角不越界`);
      }
    }
  }
});

test('缓入缓出：0→0、1→1、中点对称、单调递增', () => {
  close(easeInOutCubic(0), 0);
  close(easeInOutCubic(1), 1);
  close(easeInOutCubic(0.5), 0.5);
  close(easeInOutCubic(-1), 0);
  close(easeInOutCubic(2), 1);
  for (const t of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9]) {
    close(easeInOutCubic(t) + easeInOutCubic(1 - t), 1, `t=${t} 前后对称 `, 1e-12);
  }
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const v = easeInOutCubic(t);
    assert.ok(v >= prev - 1e-12, `t=${t} 应单调`);
    prev = v;
  }
});
