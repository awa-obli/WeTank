'use strict';

// 收集模式的确定性单元测试（不监听网络端口，直接驱动 Room）：
//   1. 常量 / 默认值：模式名称、默认收集目标、初始 2 颗、自动刷新 10 秒、上限 5 颗；
//   2. 开局钻石：数量、格心、图内、互不重叠、避开玩家；
//   3. 每 10 秒自动补 1 颗，达到 5 颗后不再自动增加；
//   4. 拾取钻石 +1，state / item_pickup 同步，击杀不直接加分；
//   5. 阵亡掉落已收集钻石的一半（向下取整），掉落在死亡点附近且不压墙；
//   6. 掉落可以让场上钻石超过 5 颗，自动刷新会暂停；
//   7. 达到收集目标广播 match_end，不广播 round_end；
//   8. 非收集模式没有钻石，也不会触发掉落。

const test = require('node:test');
const assert = require('node:assert/strict');
const physics = require('../physics');
const {
  Room,
  CELL,
  TANK_RADIUS,
  DIAMOND_RADIUS,
  BRAWL_RESPAWN_DELAY,
  DEFAULT_MODE,
  MODES,
  DEFAULT_COLLECT_TARGET,
  MIN_COLLECT_TARGET,
  MAX_COLLECT_TARGET,
  COLLECT_INITIAL_DIAMONDS,
  COLLECT_DIAMONDS_ON_FIELD,
  COLLECT_DIAMOND_INTERVAL,
  AMMO_MAX,
} = require('../server');

const TICK = 1 / 30;
const SPAWN_TICKS = Math.round(COLLECT_DIAMOND_INTERVAL / TICK); // 10 秒 = 300 tick
const RESPAWN_TICKS = Math.round(BRAWL_RESPAWN_DELAY / TICK); // 10 秒 = 300 tick

function makeWs() {
  const messages = [];
  return {
    readyState: 1, // WebSocket.OPEN
    messages,
    send(data) {
      messages.push(JSON.parse(data));
    },
  };
}

function makePlayer(id, ws) {
  return {
    id,
    name: id,
    ws,
    color: '#ffffff',
    team: null,
    score: 0,
    x: 0,
    y: 0,
    angle: 0,
    alive: true,
    hp: 5,
    cooldown: 0,
    input: { forward: false, backward: false, left: false, right: false, shoot: false },
    shield: false,
    speedBoostRemaining: 0,
    tripleReady: false,
    homingReady: false,
    laserReady: false,
    invisibleRemaining: 0,
    spawnProtectRemaining: 0,
    spawnAnimRemaining: 0,
    ammo: AMMO_MAX,
    ammoReloadAcc: 0,
    respawnRemaining: 0,
  };
}

function makeRoom(playerCount = 2, mode = 'collect') {
  const room = new Room('TEST');
  room.mode = mode;
  room.state = 'playing';
  const sockets = [];
  for (let i = 0; i < playerCount; i++) {
    const ws = makeWs();
    sockets.push(ws);
    const p = makePlayer(`p${i + 1}`, ws);
    room.players.set(p.id, p);
  }
  room.startRound();
  room.stopTicking(); // 测试里手动 tick，不让真实定时器参与
  // 跳过开局的 0.75 秒凝聚动画和出生保护，聚焦钻石规则本身。
  for (const p of room.players.values()) {
    p.spawnAnimRemaining = 0;
    p.spawnProtectRemaining = 0;
  }
  return { room, sockets };
}

function lastState(socket) {
  return socket.messages.filter((m) => m.type === 'state').pop();
}

function diamondAt(room, x, y) {
  const d = {
    id: room.nextDiamondId++,
    x,
    y,
    cellR: Math.max(0, Math.min(room.rows - 1, Math.floor(y / CELL))),
    cellC: Math.max(0, Math.min(room.cols - 1, Math.floor(x / CELL))),
  };
  room.diamonds.push(d);
  return d;
}

// 在 target 左侧放一颗朝它飞、下一次 tick 必定命中的子弹（age 跳过自伤豁免）。
function shootAt(room, shooter, target) {
  room.bullets.push({
    id: room.nextBulletId++,
    owner: shooter.id,
    team: shooter.team || null,
    x: target.x - 18,
    y: target.y,
    vx: 150,
    vy: 0,
    bounces: 0,
    age: 0.2,
    homing: false,
  });
}

function killOnce(room, shooter, target) {
  target.spawnProtectRemaining = 0;
  target.hp = 1;
  shootAt(room, shooter, target);
  room.tick();
}

test('收集模式常量与默认值', () => {
  const room = new Room('TEST');
  assert.equal(DEFAULT_MODE, 'brawl');
  assert.equal(MODES.brawl.name, '大乱斗模式');
  assert.equal(MODES.collect.name, '收集模式');
  assert.equal(DEFAULT_COLLECT_TARGET, 10);
  assert.equal(MIN_COLLECT_TARGET, 1);
  assert.equal(MAX_COLLECT_TARGET, 30);
  assert.equal(COLLECT_INITIAL_DIAMONDS, 2);
  assert.equal(COLLECT_DIAMONDS_ON_FIELD, 5);
  assert.equal(COLLECT_DIAMOND_INTERVAL, 10);
  assert.equal(room.collectTarget, DEFAULT_COLLECT_TARGET);
  assert.deepEqual(room.diamonds, []);
});

test('收集模式开局：2 颗钻石、格心、图内、互不重叠且避开玩家', () => {
  const { room, sockets } = makeRoom(3);
  try {
    assert.equal(room.diamonds.length, COLLECT_INITIAL_DIAMONDS);
    const keys = new Set();
    for (const d of room.diamonds) {
      assert.ok(d.id >= 1);
      assert.equal((d.x - CELL / 2) % CELL, 0, `钻石 x 不是格心: ${d.x}`);
      assert.equal((d.y - CELL / 2) % CELL, 0, `钻石 y 不是格心: ${d.y}`);
      assert.ok(d.x >= DIAMOND_RADIUS && d.x <= room.worldW - DIAMOND_RADIUS);
      assert.ok(d.y >= DIAMOND_RADIUS && d.y <= room.worldH - DIAMOND_RADIUS);
      keys.add(`${d.cellR},${d.cellC}`);
    }
    assert.equal(keys.size, room.diamonds.length, '钻石不应刷在同一格');
    for (const p of room.players.values()) {
      for (const d of room.diamonds) {
        assert.ok(
          Math.hypot(p.x - d.x, p.y - d.y) > TANK_RADIUS + DIAMOND_RADIUS,
          `钻石不应刷在玩家 ${p.id} 的拾取范围内`
        );
      }
    }
    const start = sockets[0].messages.find((m) => m.type === 'game_start');
    assert.ok(start, '应广播 game_start');
    assert.equal(start.collectTarget, room.collectTarget);
    assert.equal(start.diamonds.length, COLLECT_INITIAL_DIAMONDS, 'game_start 应带开局钻石');
  } finally {
    room.stopTicking();
  }
});

test('收集模式每 10 秒自动补 1 颗，达到 5 颗后停止', () => {
  const { room } = makeRoom(2);
  try {
    assert.equal(room.diamonds.length, 2);
    assert.equal(room.diamondSpawnAcc, 0);

    // 只验证刷新节奏，不让玩家捡走钻石：把两名玩家都设为阵亡等待复活，
    // 但复活倒计时为 0，updateRespawns 不会把他们放回场上。
    for (const p of room.players.values()) {
      p.alive = false;
      p.respawnRemaining = 0;
    }

    for (let i = 0; i < SPAWN_TICKS - 1; i++) room.tick();
    assert.equal(room.diamonds.length, 2, '10 秒未到不应自动刷新');

    room.tick(); // 第 300 tick = 10 秒
    assert.equal(room.diamonds.length, 3, '满 10 秒应补 1 颗');

    // 直接补到 5 颗，再跑 10 秒验证上限
    room.diamonds = [];
    for (let i = 0; i < COLLECT_DIAMONDS_ON_FIELD; i++) diamondAt(room, CELL / 2 + i * CELL * 2, CELL / 2);
    room.diamondSpawnAcc = 0;
    for (let i = 0; i < SPAWN_TICKS; i++) room.tick();
    assert.equal(room.diamonds.length, COLLECT_DIAMONDS_ON_FIELD, '自动刷新不应超过 5 颗');
  } finally {
    room.stopTicking();
  }
});

test('拾取钻石：本人 +1，state / item_pickup 同步，其他人不受影响', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    room.diamonds = [];
    diamondAt(room, a.x, a.y);
    room.diamondSpawnAcc = 0;
    room.tick();

    assert.equal(a.score, 1, '拾取者应 +1');
    assert.equal(b.score, 0, '其他人不应加分');
    assert.equal(room.diamonds.length, 0, '钻石应被拾取');

    const pickup = sockets[0].messages.filter((m) => m.type === 'item_pickup').pop();
    assert.ok(pickup, '应广播 item_pickup');
    assert.equal(pickup.pickups[0].type, 'diamond');
    assert.equal(pickup.pickups[0].playerId, a.id);
    assert.equal(pickup.pickups[0].score, 1);

    const state = lastState(sockets[0]);
    assert.equal(state.tanks.find((t) => t.id === a.id).score, 1, 'state 应同步钻石数');
    assert.equal(state.diamonds.length, 0);
  } finally {
    room.stopTicking();
  }
});

test('收集模式击杀不直接加分；阵亡掉落一半（向下取整）并进入 10 秒复活', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    room.diamonds = [];
    a.score = 5; // 奇数：掉落 2 颗，保留 3 颗
    b.score = 0;

    killOnce(room, b, a);

    assert.equal(a.alive, false);
    assert.equal(a.score, 3, '5 颗应掉落 2 颗，保留 3 颗');
    assert.equal(b.score, 0, '收集模式击杀不直接加分');
    assert.equal(a.respawnRemaining, BRAWL_RESPAWN_DELAY, '阵亡应进入 10 秒复活');
    assert.equal(room.diamonds.length, 2, '应掉落 2 颗钻石');

    for (const d of room.diamonds) {
      assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y));
      for (const rect of room.maze.rects) {
        assert.ok(!physics.circleRectOverlap(d.x, d.y, DIAMOND_RADIUS, rect), '掉落钻石不应压在墙上');
      }
      assert.ok(Math.hypot(d.x - a.x, d.y - a.y) <= 60, '掉落钻石应在死亡点附近');
    }

    const drop = sockets[0].messages.find((m) => m.type === 'diamond_drop');
    assert.ok(drop, '应广播 diamond_drop');
    assert.equal(drop.playerId, a.id);
    assert.equal(drop.count, 2);
    assert.equal(drop.score, 3);
  } finally {
    room.stopTicking();
  }
});

test('只有 1 颗钻石时阵亡不掉落（向下取整）', () => {
  const { room } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    room.diamonds = [];
    a.score = 1;
    killOnce(room, b, a);
    assert.equal(a.score, 1);
    assert.equal(room.diamonds.length, 0);
  } finally {
    room.stopTicking();
  }
});

test('收集模式阵亡 10 秒后复活，并重新带出生保护', () => {
  const { room } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    room.diamonds = [];
    killOnce(room, b, a);
    assert.equal(a.alive, false);

    for (let i = 0; i < RESPAWN_TICKS - 1; i++) room.tick();
    assert.equal(a.alive, false, '10 秒未到不应复活');

    room.tick(); // 第 300 tick
    assert.equal(a.alive, true, '10 秒到点应复活');
    assert.equal(a.hp, room.maxHp, '复活应满血');
    assert.equal(a.respawnRemaining, 0);
    assert.ok(a.spawnAnimRemaining > 0, '复活应带凝聚动画');
  } finally {
    room.stopTicking();
  }
});

test('掉落可以让场上钻石超过 5 颗，自动刷新暂停到数量降回上限以下', () => {
  const { room } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    room.diamonds = [];
    // 先摆满 5 颗，再让 a 带 4 颗死亡：掉落 2 颗后场上 7 颗。
    // b 也先设为阵亡等待复活（倒计时 0，不会真的复活），避免它在测试中顺手捡走假钻石；
    // 子弹即使由已阵亡的 b 打出，仍然可以正常命中 a。
    for (let i = 0; i < COLLECT_DIAMONDS_ON_FIELD; i++) {
      diamondAt(room, CELL / 2 + i * CELL * 2, room.worldH - CELL / 2);
    }
    // a 挪到左上角格心，确保它不会在死亡前踩到下面那排假钻石。
    a.x = CELL / 2;
    a.y = CELL / 2;
    b.alive = false;
    b.respawnRemaining = 0;
    a.score = 4;
    killOnce(room, b, a);
    assert.equal(room.diamonds.length, COLLECT_DIAMONDS_ON_FIELD + 2);

    // 避免 a 复活后顺手捡走钻石：只验证自动刷新是否暂停。
    room.diamondSpawnAcc = 0;
    for (let i = 0; i < SPAWN_TICKS; i++) room.tick();
    assert.equal(
      room.diamonds.length,
      COLLECT_DIAMONDS_ON_FIELD + 2,
      '场上数量高于上限时自动刷新应暂停'
    );
  } finally {
    room.stopTicking();
  }
});

test('达到收集目标：广播 match_end，不广播 round_end', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    room.collectTarget = 1;
    room.diamonds = [];
    diamondAt(room, a.x, a.y);
    room.tick();

    assert.equal(a.score, 1);
    const matchEnd = sockets[0].messages.find((m) => m.type === 'match_end');
    assert.ok(matchEnd, '达到收集目标应广播 match_end');
    assert.equal(matchEnd.winnerId, a.id);
    assert.equal(matchEnd.mode, 'collect');
    assert.equal(matchEnd.collectTarget, 1);
    assert.equal(matchEnd.scores.find((s) => s.id === a.id).score, 1);
    assert.equal(room.state, 'lobby');
    assert.equal(sockets[0].messages.filter((m) => m.type === 'round_end').length, 0);
  } finally {
    room.stopTicking();
  }
});

test('非收集模式没有钻石，也不会触发阵亡掉落', () => {
  const { room } = makeRoom(2, 'brawl');
  try {
    const [a, b] = [...room.players.values()];
    room.diamonds = [];
    a.score = 5;
    killOnce(room, b, a);

    assert.equal(room.diamonds.length, 0, '大乱斗不应生成钻石');
    assert.equal(a.score, 5, '非收集模式阵亡不应扣钻石');
    assert.equal(room.stateMessage().diamonds.length, 0);
  } finally {
    room.stopTicking();
  }
});
