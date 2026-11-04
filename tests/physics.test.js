'use strict';

// 通用反弹机制的单元测试：直接跑 `node --test tests/` 即可，无额外依赖。
// 重点覆盖：
//   1. 轴对齐墙面：法线与反射方向；
//   2. 墙端点/角点：路径完全在碰撞区域外时不接触；擦到角点时也只按
//      "最先跨过的那个面"反射，法线永远只有面法线（±X / ±Y）；
//   3. 任意角度（旋转）墙面：法线正确、反射角守恒；
//   4. 高速子弹不穿墙；
//   5. 出生/陷入墙内能被推回正确的一侧；
//   6. 随机迷宫里的长时间飞行：不穿墙、速度大小守恒、不卡死。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  circleRectOverlap,
  circleRectPenetration,
  sweepCircleVsRect,
  reflectVelocity,
  resolveBulletPenetration,
  stepBullet,
} = require('../physics');

const R = 4;

function close(actual, expected, eps = 1e-6, msg = '') {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg} expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`
  );
}

function speed(vx, vy) {
  return Math.hypot(vx, vy);
}

// 局部坐标 -> 世界坐标（含平移），测试旋转墙时用
function makeFrame(cx, cy, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    point(lx, ly) {
      return { x: cx + lx * c - ly * s, y: cy + lx * s + ly * c };
    },
    dir(lx, ly) {
      return { x: lx * c - ly * s, y: lx * s + ly * c };
    },
  };
}

test('圆-矩形重叠检测与旧的轴对齐实现完全一致（坦克移动依赖它）', () => {
  const rand = mulberry32(99);
  const rects = [];
  for (let i = 0; i < 40; i++) {
    rects.push({ cx: rand() * 400, cy: rand() * 300, hw: 3 + rand() * 40, hh: 3 + rand() * 40 });
  }
  for (let i = 0; i < 5000; i++) {
    const rect = rects[i % rects.length];
    const x = rect.cx + (rand() * 2 - 1) * 120;
    const y = rect.cy + (rand() * 2 - 1) * 120;
    const radius = 15;

    const got = circleRectOverlap(x, y, radius, rect);
    const qx = Math.max(rect.cx - rect.hw, Math.min(rect.cx + rect.hw, x));
    const qy = Math.max(rect.cy - rect.hh, Math.min(rect.cy + rect.hh, y));
    const dx = x - qx;
    const dy = y - qy;
    const want = dx * dx + dy * dy < radius * radius;

    assert.equal(got !== null, want, `第 ${i} 组重叠判定不一致`);
    if (got) {
      close(got.dx, dx, 1e-9);
      close(got.dy, dy, 1e-9);
    }
  }
});

test('竖直墙面：法线为 -X，反射后 vx 反向、速度大小不变', () => {
  const rect = { cx: 100, cy: 100, hw: 5, hh: 50 };
  const hit = sweepCircleVsRect(50, 100, 100, 0, R, rect);
  assert.ok(hit, '应该命中墙面');
  close(hit.t, 0.41, 1e-9);
  close(hit.x, 91, 1e-9);
  close(hit.y, 100, 1e-9);
  close(hit.nx, -1, 1e-9);
  close(hit.ny, 0, 1e-9);

  const r = reflectVelocity(100, 0, hit.nx, hit.ny);
  close(r.vx, -100, 1e-9);
  close(r.vy, 0, 1e-9);
});

test('墙端点旁边飞过：不产生碰撞', () => {
  // 墙的 y 范围是 50..150；子弹沿 y=40 横向飞过，离墙顶还有 10px > 半径 4
  const rect = { cx: 100, cy: 100, hw: 5, hh: 50 };
  const hit = sweepCircleVsRect(0, 40, 200, 0, R, rect);
  assert.equal(hit, null);
});

test('端点误判回归：擦到墙角时按"更迎面"的面反射（法线仍是面法线）', () => {
  const rect = { cx: 100, cy: 100, hw: 5, hh: 50 };
  // 从墙的左下方斜着飞向 (95,150) 这个角
  const hit = sweepCircleVsRect(80, 140, 100, 100, R, rect);
  assert.ok(hit, '应该接触到角点');

  // 真实圆-矩形接触点落在角点的圆角上（不是外扩直角矩形的 x=91）
  close(hit.t, 0.1117712, 1e-6);
  close(hit.x, 91.177124, 1e-6);
  close(hit.y, 151.177124, 1e-6);
  // 左面和下面共享这个角点；速度更迎面的是左面
  close(hit.nx, -1, 1e-9);
  close(hit.ny, 0, 1e-9);

  const r = reflectVelocity(100, 100, hit.nx, hit.ny);
  close(r.vx, -100, 1e-9);
  close(r.vy, 100, 1e-9);
  close(speed(r.vx, r.vy), speed(100, 100), 1e-9, '反射后速度大小应不变');
});

test('斜着掠过墙角：接触时刻按真实圆角计算，不会提前到外扩直角边', () => {
  // 墙 x∈[95,105], y∈[50,150]；子弹从左侧沿 y=48 飞过，离墙顶只有 2px
  const rect = { cx: 100, cy: 100, hw: 5, hh: 50 };
  const hit = sweepCircleVsRect(0, 48, 200, 0, R, rect);
  assert.ok(hit);

  // 外扩直角模型会在 x=91 就判定接触；真实圆角要等到 x = 95 - sqrt(16-4)
  const expectedX = 95 - Math.sqrt(16 - 4);
  close(hit.x, expectedX, 1e-9);
  close(hit.y, 48, 1e-9);
  close(hit.t, expectedX / 200, 1e-9);
  close(hit.nx, -1, 1e-9);
  close(hit.ny, 0, 1e-9);
});

test('任意角度平面：30° 斜墙的法线与反射角都正确', () => {
  const angle = Math.PI / 6;
  const rect = { cx: 0, cy: 0, hw: 6, hh: 80, angle };
  const frame = makeFrame(0, 0, angle);

  // 局部坐标下从 (-50,10) 以 (100,60) 飞向 -x 面
  const start = frame.point(-50, 10);
  const dir = frame.dir(100, 60);
  const hit = sweepCircleVsRect(start.x, start.y, dir.x, dir.y, R, rect);
  assert.ok(hit, '应该命中斜墙');

  // 斜墙 -x 面的世界法线 = 局部 (-1,0) 旋转到世界
  close(hit.nx, -Math.cos(angle), 1e-9);
  close(hit.ny, -Math.sin(angle), 1e-9);

  const v = dir; // 位移方向就是速度方向
  const r = reflectVelocity(v.x, v.y, hit.nx, hit.ny);
  const inLen = speed(v.x, v.y);
  const outLen = speed(r.vx, r.vy);

  close(outLen, inLen, 1e-9, '镜面反射必须保持速度大小');
  const inDot = v.x * hit.nx + v.y * hit.ny;
  const outDot = r.vx * hit.nx + r.vy * hit.ny;
  close(outDot, -inDot, 1e-9, '法向分量应等大反向');

  // 速度变化量必须严格平行于法线（反射的充要条件）
  const changeX = r.vx - v.x;
  const changeY = r.vy - v.y;
  close(changeX * hit.ny - changeY * hit.nx, 0, 1e-9, 'v\' - v 应平行于法线');
});

test('任意朝向平面（随机 300 组）：法线正确且镜面反射守恒', () => {
  const rand = mulberry32(777);
  for (let i = 0; i < 300; i++) {
    const angle = (rand() - 0.5) * Math.PI * 2;
    const hw = 3 + rand() * 30;
    const hh = 20 + rand() * 100;
    const rect = { cx: (rand() - 0.5) * 200, cy: (rand() - 0.5) * 200, hw, hh, angle };
    const frame = makeFrame(rect.cx, rect.cy, angle);

    // 从局部 -x 面正前方飞向墙面，y 保持在面范围内，确保一定是面接触
    const ly = (rand() * 2 - 1) * (hh - 8);
    const start = frame.point(-hw - 40, ly);
    const dir = frame.dir(80 + rand() * 60, 0);

    const hit = sweepCircleVsRect(start.x, start.y, dir.x, dir.y, R, rect);
    assert.ok(hit, `第 ${i} 组旋转墙应被命中`);
    close(hit.nx, -Math.cos(angle), 1e-9, `第 ${i} 组法线 x`);
    close(hit.ny, -Math.sin(angle), 1e-9, `第 ${i} 组法线 y`);

    const r = reflectVelocity(dir.x, dir.y, hit.nx, hit.ny);
    close(speed(r.vx, r.vy), speed(dir.x, dir.y), 1e-9, `第 ${i} 组速度大小`);
    close(
      r.vx * hit.nx + r.vy * hit.ny,
      -(dir.x * hit.nx + dir.y * hit.ny),
      1e-9,
      `第 ${i} 组法向分量`
    );
  }
});

test('旋转墙端点外侧飞过：不产生碰撞', () => {
  const angle = Math.PI / 4;
  const rect = { cx: 0, cy: 0, hw: 4, hh: 50, angle };
  const frame = makeFrame(0, 0, angle);
  // 局部 y=70 已在墙端(50)之外 20px，远大于半径，整段飞过都不该接触
  const start = frame.point(-100, 70);
  const dir = frame.dir(200, 0);
  assert.equal(sweepCircleVsRect(start.x, start.y, dir.x, dir.y, R, rect), null);
});

test('凹角内一次子步连弹两次：两个分量都反向、速度不衰减', () => {
  // 右墙 + 下墙围出一个朝左上的凹角，角点在 (15,15)
  const rectV = { cx: 20, cy: 100, hw: 5, hh: 200 };
  const rectH = { cx: 100, cy: 20, hw: 200, hh: 5 };
  const bullet = { x: 0, y: 0, vx: 100, vy: 100, bounces: 0 };

  const result = stepBullet(bullet, R, 0.2, [rectV, rectH]);
  assert.equal(result.stuck, false);
  assert.ok(bullet.bounces >= 2, `应该至少反弹两次，实际 ${bullet.bounces}`);
  assert.ok(bullet.vx < 0 && bullet.vy < 0, '两个速度分量都应反向');
  close(speed(bullet.vx, bullet.vy), speed(100, 100), 1e-6, '连续反弹后速度不应衰减');
});

test('正撞角点：按最先到达的面反射，不产生斜向法线', () => {
  const rect = { cx: 0, cy: 0, hw: 20, hh: 20 };
  const hit = sweepCircleVsRect(100, 100, -80, -80, R, rect);
  assert.ok(hit, '应该命中角点');

  close(hit.t, 0.9646447, 1e-6);
  close(hit.x, 22.828427, 1e-6);
  close(hit.y, 22.828427, 1e-6);
  // 右面与下面在角点并列、迎面程度相同，取先检查的右面
  close(hit.nx, 1, 1e-9);
  close(hit.ny, 0, 1e-9);

  const r = reflectVelocity(-80, -80, hit.nx, hit.ny);
  close(r.vx, 80, 1e-9);
  close(r.vy, -80, 1e-9);
  close(speed(r.vx, r.vy), speed(-80, -80), 1e-9);
});

test('斜向撞角（旋转墙）：法线只可能是四个面法线之一', () => {
  const angle = Math.PI / 5;
  const rect = { cx: 30, cy: -20, hw: 25, hh: 60, angle };
  const rand = mulberry32(4242);
  const frame = makeFrame(rect.cx, rect.cy, angle);
  const faceNormals = [frame.dir(1, 0), frame.dir(-1, 0), frame.dir(0, 1), frame.dir(0, -1)];
  const corners = [
    [25, 60],
    [25, -60],
    [-25, 60],
    [-25, -60],
  ];

  for (let i = 0; i < 400; i++) {
    const c = corners[i % 4];
    const theta = rand() * Math.PI * 2;
    const away = frame.dir(Math.cos(theta), Math.sin(theta));
    const cornerWorld = frame.point(c[0], c[1]);
    const start = { x: cornerWorld.x + away.x * 300, y: cornerWorld.y + away.y * 300 };
    const to = frame.dir(-Math.cos(theta), -Math.sin(theta));

    const hit = sweepCircleVsRect(start.x, start.y, to.x * 300, to.y * 300, R, rect);
    assert.ok(hit, `第 ${i} 次朝角点飞应该进入碰撞区域`);

    const isFaceNormal = faceNormals.some(
      (f) => Math.abs(f.x - hit.nx) < 1e-9 && Math.abs(f.y - hit.ny) < 1e-9
    );
    assert.ok(isFaceNormal, `第 ${i} 次返回了非面法线: (${hit.nx}, ${hit.ny})`);
  }
});

test('高速子弹扫掠不会穿墙', () => {
  const rect = { cx: 0, cy: 0, hw: 5, hh: 100 };
  const bullet = { x: -100, y: 0, vx: 5000, vy: 0, bounces: 0 };
  const result = stepBullet(bullet, R, 1, [rect]);
  assert.equal(result.stuck, false);
  assert.equal(bullet.bounces, 1);
  assert.ok(bullet.vx < 0, '应被弹回左侧');
  assert.ok(bullet.x < -8.9, `不应穿到墙右侧，实际 x=${bullet.x}`);
});

test('出生在墙里的子弹从"来向"一侧弹回，不会被顶到另一侧', () => {
  const rect = { cx: 0, cy: 0, hw: 5, hh: 50 };
  const bullet = { x: 2, y: 0, vx: 100, vy: 0, bounces: 0 };
  const result = stepBullet(bullet, R, 1 / 30, [rect]);
  assert.equal(result.stuck, false);
  assert.ok(bullet.vx < 0, '撞墙后应反向');
  assert.ok(bullet.x < -8.9, `应回到左侧，实际 x=${bullet.x}`);
});

test('已经嵌进墙面的子弹被推出来并反射', () => {
  const rect = { cx: 100, cy: 100, hw: 5, hh: 50 };
  const bullet = { x: 92, y: 100, vx: 100, vy: 0, bounces: 0 };
  assert.ok(circleRectPenetration(bullet.x, bullet.y, R, rect) !== null);
  const stuck = resolveBulletPenetration(bullet, R, [rect]);
  assert.equal(stuck, false);
  close(bullet.x, 90.99, 1e-6);
  assert.ok(bullet.vx < 0);
});

// ---------- 随机迷宫里的长时间仿真 ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 复刻服务端 generateMaze 的碰撞几何：墙体都生成在格子边界上，
// 末端各外扩 WALL_THICK/2，外圈再加四条边界墙。
function buildApproxMaze(rand) {
  const COLS = 12;
  const ROWS = 8;
  const CELL = 80;
  const THICK = 10;
  const OVER = THICK / 2;
  const rects = [];

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      if (rand() < 0.38) {
        rects.push({ cx: (c + 1) * CELL, cy: r * CELL + CELL / 2, hw: THICK / 2, hh: CELL / 2 + OVER });
      }
    }
  }
  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS; c++) {
      if (rand() < 0.38) {
        rects.push({ cx: c * CELL + CELL / 2, cy: (r + 1) * CELL, hw: CELL / 2 + OVER, hh: THICK / 2 });
      }
    }
  }
  const W = COLS * CELL;
  const H = ROWS * CELL;
  rects.push({ cx: W / 2, cy: 0, hw: W / 2 + THICK, hh: THICK / 2 });
  rects.push({ cx: W / 2, cy: H, hw: W / 2 + THICK, hh: THICK / 2 });
  rects.push({ cx: 0, cy: H / 2, hw: THICK / 2, hh: H / 2 + THICK });
  rects.push({ cx: W, cy: H / 2, hw: THICK / 2, hh: H / 2 + THICK });
  return { rects, COLS, ROWS, CELL, W, H };
}

test('随机迷宫 300 步仿真：不穿墙、不卡死、速度守恒', () => {
  const rand = mulberry32(20261104);
  const maze = buildApproxMaze(rand);
  const DT = 1 / 30;
  const SPEED = 150;
  let totalBounces = 0;
  let bullets = 0;

  for (let n = 0; n < 60; n++) {
    // 从空格子中心出生（迷宫墙都在格子边界上，格心一定是空地）
    const cellR = Math.floor(rand() * maze.ROWS);
    const cellC = Math.floor(rand() * maze.COLS);
    const angle = rand() * Math.PI * 2;
    const bullet = {
      x: cellC * maze.CELL + maze.CELL / 2,
      y: cellR * maze.CELL + maze.CELL / 2,
      vx: Math.cos(angle) * SPEED,
      vy: Math.sin(angle) * SPEED,
      bounces: 0,
    };

    for (let step = 0; step < 300; step++) {
      const result = stepBullet(bullet, R, DT, maze.rects);
      assert.equal(result.stuck, false, `第 ${n} 发子弹第 ${step} 步卡死`);
      close(speed(bullet.vx, bullet.vy), SPEED, 1e-6, `第 ${n} 发第 ${step} 步速度大小改变`);

      for (const rect of maze.rects) {
        const pen = circleRectPenetration(bullet.x, bullet.y, R, rect, bullet.vx, bullet.vy);
        assert.equal(
          pen,
          null,
          `第 ${n} 发子弹第 ${step} 步嵌进墙里：(${bullet.x}, ${bullet.y}) 深度 ${pen && pen.depth}`
        );
      }
    }

    totalBounces += bullet.bounces;
    bullets++;
  }

  assert.equal(bullets, 60);
  assert.ok(totalBounces > 50, `随机仿真里应该发生足够多的反弹，实际 ${totalBounces} 次`);
});
