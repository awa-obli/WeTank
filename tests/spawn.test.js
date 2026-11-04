'use strict';

// 随机出生点的单元测试（node --test 直接跑，不依赖服务端）：
//   1. 三种地图档位下都能给 7 人找到位置，且互不重复；
//   2. 所有出生点都落在格子中心，且在网格范围内；
//   3. 换种子/多跑若干次，出生点确实在变（不是每次都一样）；
//   4. count 超过格子总数时封顶，不会返回不存在的格子。

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickSpawnCells } = require('../spawn');

const CELL = 80;
const PRESETS = {
  small: { cols: 9, rows: 6 },
  medium: { cols: 12, rows: 8 },
  large: { cols: 15, rows: 10 },
};
const MAX_PLAYERS = 7;

// mulberry32：足够小的确定性 PRNG，让"随机"测试可复现
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

function assertValidSpawns(spots, cols, rows, count) {
  assert.equal(spots.length, count);
  const seen = new Set();
  for (const s of spots) {
    assert.ok(Number.isInteger(s.r) && s.r >= 0 && s.r < rows, `行号越界: ${s.r}`);
    assert.ok(Number.isInteger(s.c) && s.c >= 0 && s.c < cols, `列号越界: ${s.c}`);
    const key = `${s.r},${s.c}`;
    assert.ok(!seen.has(key), `出生格重复: ${key}`);
    seen.add(key);
    assert.equal(s.x, s.c * CELL + CELL / 2, 'x 必须是格心');
    assert.equal(s.y, s.r * CELL + CELL / 2, 'y 必须是格心');
    assert.ok(s.x > 0 && s.x < cols * CELL, 'x 必须在地图内');
    assert.ok(s.y > 0 && s.y < rows * CELL, 'y 必须在地图内');
  }
}

for (const [name, preset] of Object.entries(PRESETS)) {
  test(`${name} 地图：7 人出生点互不重复且都在格心`, () => {
    const rng = makeRng(1234);
    // 多跑几十次，覆盖不同的洗牌结果
    for (let round = 0; round < 200; round++) {
      const spots = pickSpawnCells({ ...preset, cell: CELL, count: MAX_PLAYERS, rand: rng });
      assertValidSpawns(spots, preset.cols, preset.rows, MAX_PLAYERS);
    }
  });
}

test('出生点确实随机：不同种子会得到不同的位置集合', () => {
  const signature = (seed) => {
    const spots = pickSpawnCells({
      cols: 12, rows: 8, cell: CELL, count: MAX_PLAYERS, rand: makeRng(seed),
    });
    return spots.map((s) => `${s.r},${s.c}`).join('|');
  };
  const sigs = new Set();
  for (let seed = 1; seed <= 50; seed++) sigs.add(signature(seed));
  assert.ok(sigs.size > 40, `50 个种子只产生了 ${sigs.size} 种出生布局，随机性不足`);
});

test('同一种子可复现（测试与调试依赖这一点）', () => {
  const pick = (seed) => pickSpawnCells({
    cols: 9, rows: 6, cell: CELL, count: MAX_PLAYERS, rand: makeRng(seed),
  });
  assert.deepEqual(pick(42), pick(42));
});

test('2 人/5 人局也能拿到对应数量', () => {
  for (const count of [1, 2, 5]) {
    const spots = pickSpawnCells({ ...PRESETS.small, cell: CELL, count, rand: makeRng(7) });
    assertValidSpawns(spots, PRESETS.small.cols, PRESETS.small.rows, count);
  }
});

test('count 超过格子总数时按格子总数封顶', () => {
  const preset = { cols: 3, rows: 2 };
  const spots = pickSpawnCells({ ...preset, cell: CELL, count: 100, rand: makeRng(1) });
  assert.equal(spots.length, 6);
  assertValidSpawns(spots, 3, 2, 6);

  const none = pickSpawnCells({ ...preset, cell: CELL, count: 0, rand: makeRng(1) });
  assert.equal(none.length, 0);
});
