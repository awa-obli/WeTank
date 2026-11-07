'use strict';

// 地图类型生成器的单元测试（node --test 直接跑，不依赖服务端）：
//   1. 每种类型都能生成维度正确的墙数组；
//   2. 所有格心都不会落在墙体里（出生点/道具点都在格心）；
//   3. 所有格子互相连通（不会围出封闭房间）；
//   4. 空旷图没有任何内墙；对称图左右镜像；散块图有墙但不贴边；
//   5. 随机类型每次都会落到一个具体类型，并覆盖全部四种；
//   6. 同一种子可复现，非法类型会报错。

const test = require('node:test');
const assert = require('node:assert/strict');
const physics = require('../physics');
const {
  MAP_TYPE_KEYS,
  CONCRETE_MAP_TYPES,
  generateMap,
} = require('../maps');

const CELL = 80;
const WALL_THICK = 10;
const TANK_RADIUS = 15;
const PRESETS = {
  small: { cols: 9, rows: 6 },
  medium: { cols: 12, rows: 8 },
  large: { cols: 15, rows: 10 },
};

function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function build(type, cols, rows, seed) {
  return generateMap(type, {
    cols,
    rows,
    cell: CELL,
    wallThick: WALL_THICK,
    rand: makeRng(seed),
  });
}

function assertWallDims(map, cols, rows, label) {
  assert.equal(map.wallsV.length, rows, `${label}: wallsV 行数`);
  for (const row of map.wallsV) assert.equal(row.length, cols - 1, `${label}: wallsV 列数`);
  assert.equal(map.wallsH.length, rows - 1, `${label}: wallsH 行数`);
  for (const row of map.wallsH) assert.equal(row.length, cols, `${label}: wallsH 列数`);
}

function assertCellCentersClear(map, cols, rows, label) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * CELL + CELL / 2;
      const y = r * CELL + CELL / 2;
      for (const rect of map.rects) {
        assert.ok(
          !physics.circleRectOverlap(x, y, TANK_RADIUS, rect),
          `${label}: 格心 (${r},${c}) 落在墙体里`
        );
      }
    }
  }
}

function assertConnected(map, cols, rows, label) {
  const { wallsV, wallsH } = map;
  const seen = Array.from({ length: rows }, () => Array(cols).fill(false));
  const stack = [[0, 0]];
  seen[0][0] = true;
  let count = 0;
  while (stack.length > 0) {
    const [r, c] = stack.pop();
    count += 1;
    // 右
    if (c + 1 < cols && !wallsV[r][c] && !seen[r][c + 1]) {
      seen[r][c + 1] = true;
      stack.push([r, c + 1]);
    }
    // 左
    if (c > 0 && !wallsV[r][c - 1] && !seen[r][c - 1]) {
      seen[r][c - 1] = true;
      stack.push([r, c - 1]);
    }
    // 下
    if (r + 1 < rows && !wallsH[r][c] && !seen[r + 1][c]) {
      seen[r + 1][c] = true;
      stack.push([r + 1, c]);
    }
    // 上
    if (r > 0 && !wallsH[r - 1][c] && !seen[r - 1][c]) {
      seen[r - 1][c] = true;
      stack.push([r - 1, c]);
    }
  }
  assert.equal(count, cols * rows, `${label}: 有 ${cols * rows - count} 个格子无法到达`);
}

function assertSymmetric(map, cols, label) {
  for (let r = 0; r < map.wallsV.length; r++) {
    for (let c = 0; c < map.wallsV[r].length; c++) {
      assert.equal(
        map.wallsV[r][c],
        map.wallsV[r][cols - 2 - c],
        `${label}: 竖墙 (${r},${c}) 没有左右镜像`
      );
    }
  }
  for (let r = 0; r < map.wallsH.length; r++) {
    for (let c = 0; c < map.wallsH[r].length; c++) {
      assert.equal(
        map.wallsH[r][c],
        map.wallsH[r][cols - 1 - c],
        `${label}: 横墙 (${r},${c}) 没有左右镜像`
      );
    }
  }
}

test('地图类型注册表包含迷宫、空旷、对称、散块和随机', () => {
  assert.deepEqual(MAP_TYPE_KEYS, ['maze', 'open', 'symmetric', 'scatter', 'random']);
  assert.deepEqual(CONCRETE_MAP_TYPES, ['maze', 'open', 'symmetric', 'scatter']);
});

for (const [name, preset] of Object.entries(PRESETS)) {
  for (const type of CONCRETE_MAP_TYPES) {
    test(`${name} 地图 / ${type}：墙数组维度、格心安全、全图连通`, () => {
      // 多跑一些种子，覆盖不同的随机布局
      for (let seed = 1; seed <= 30; seed++) {
        const label = `${name}/${type}/seed=${seed}`;
        const map = build(type, preset.cols, preset.rows, seed);
        assert.equal(map.type, type, `${label}: 返回类型`);
        assertWallDims(map, preset.cols, preset.rows, label);
        assertCellCentersClear(map, preset.cols, preset.rows, label);
        assertConnected(map, preset.cols, preset.rows, label);
      }
    });
  }
}

test('空旷地图没有任何内墙，只有 4 条外围碰撞体', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const map = build('open', preset.cols, preset.rows, 7);
    for (const row of map.wallsV) assert.ok(row.every((w) => w === false), `${name}: 有竖向内墙`);
    for (const row of map.wallsH) assert.ok(row.every((w) => w === false), `${name}: 有横向内墙`);
    assert.equal(map.rects.length, 4, `${name}: 碰撞体应该只有外围边界`);
  }
});

test('对称地图左右完全镜像', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    for (let seed = 1; seed <= 30; seed++) {
      const map = build('symmetric', preset.cols, preset.rows, seed);
      assertSymmetric(map, preset.cols, `${name}/symmetric/seed=${seed}`);
    }
  }
});

test('散块地图有短墙，但没有形成封闭区域', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    for (let seed = 1; seed <= 30; seed++) {
      const map = build('scatter', preset.cols, preset.rows, seed);
      const wallCount = map.wallsV.flat().filter(Boolean).length
        + map.wallsH.flat().filter(Boolean).length;
      assert.ok(wallCount > 0, `${name}/scatter/seed=${seed}: 至少应该有一段短墙`);
      // 墙数明显少于迷宫（迷宫墙边数量至少是格数级别），保持“半开阔”
      assert.ok(
        wallCount < preset.cols * preset.rows,
        `${name}/scatter/seed=${seed}: 短墙太多（${wallCount} 条）`
      );
    }
  }
});

test('随机类型会落到具体类型，并且四种都能抽到', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    const map = build('random', PRESETS.medium.cols, PRESETS.medium.rows, seed);
    assert.ok(CONCRETE_MAP_TYPES.includes(map.type), `random 返回了非具体类型: ${map.type}`);
    seen.add(map.type);
  }
  assert.deepEqual([...seen].sort(), [...CONCRETE_MAP_TYPES].sort(), '200 个种子没有覆盖全部四种布局');
});

test('同一种子可复现（测试与调试依赖这一点）', () => {
  for (const type of CONCRETE_MAP_TYPES) {
    const a = build(type, 12, 8, 42);
    const b = build(type, 12, 8, 42);
    assert.deepEqual(a.wallsV, b.wallsV, `${type}: wallsV 不可复现`);
    assert.deepEqual(a.wallsH, b.wallsH, `${type}: wallsH 不可复现`);
    assert.deepEqual(a.rects, b.rects, `${type}: rects 不可复现`);
  }
});

test('非法类型和非法尺寸会报错', () => {
  assert.throws(() => generateMap('huge', { cols: 9, rows: 6 }), /未知的地图类型/);
  assert.throws(() => generateMap('constructor', { cols: 9, rows: 6 }), /未知的地图类型/);
  assert.throws(() => generateMap('open', { cols: 1, rows: 6 }), /行列数/);
});
