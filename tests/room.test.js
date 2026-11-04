'use strict';

// 房间逻辑的确定性单元测试（不监听网络端口，直接驱动 Room）：
//   1. 7 人开局时出生格互不重复、都在格心、朝向在 [0, 2π)；
//   2. 出生保护期间子弹被吸收：不掉血、不消耗道具护盾，并广播 spawn_block；
//   3. 保护到期后，同样的子弹能正常击杀目标；
//   4. 开火会立即解除出生保护；
//   5. 出生保护按 tick 正常倒计时。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Room,
  SPAWN_PROTECT_TIME,
  CELL,
} = require('../server');

const TICK = 1 / 30;

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
    score: 0,
    x: 0,
    y: 0,
    angle: 0,
    alive: true,
    cooldown: 0,
    input: { forward: false, backward: false, left: false, right: false, shoot: false },
    shield: false,
    speedBoostRemaining: 0,
    tripleReady: false,
    homingReady: false,
    invisibleRemaining: 0,
    spawnProtectRemaining: 0,
  };
}

function makeRoom(playerCount) {
  const room = new Room('TEST');
  room.state = 'playing';
  const sockets = [];
  for (let i = 0; i < playerCount; i++) {
    const ws = makeWs();
    sockets.push(ws);
    const p = makePlayer(`p${i + 1}`, ws);
    room.players.set(p.id, p);
  }
  room.startRound();
  room.stopTicking(); // 测试里手动调用 tick()，不让真实定时器参与
  return { room, sockets };
}

// 在 target 左侧放一颗朝它飞、下一次 tick 必定进入命中半径的子弹。
// age 直接给 0.2，跳过 BULLET_OWNER_GRACE 的自伤豁免（目标本来也不是 owner）。
function shootAt(room, shooter, target) {
  room.bullets.push({
    id: room.nextBulletId++,
    owner: shooter.id,
    x: target.x - 18,
    y: target.y,
    vx: 150,
    vy: 0,
    bounces: 0,
    age: 0.2,
    homing: false,
  });
}

test('7 人开局：出生格互不重复、都在格心、朝向随机', () => {
  // 跑多轮，覆盖不同的随机出生布局
  for (let round = 0; round < 30; round++) {
    const { room } = makeRoom(7);
    try {
      const used = new Set();
      for (const p of room.players.values()) {
        assert.ok(p.alive, '开局所有人都应存活');
        assert.equal(p.spawnProtectRemaining, SPAWN_PROTECT_TIME, '开局应带满出生保护');
        assert.ok(p.angle >= 0 && p.angle < Math.PI * 2, `朝向越界: ${p.angle}`);
        assert.equal((p.x - CELL / 2) % CELL, 0, `x 不是格心: ${p.x}`);
        assert.equal((p.y - CELL / 2) % CELL, 0, `y 不是格心: ${p.y}`);

        const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
        assert.ok(!used.has(key), `出生格重复: ${key}`);
        used.add(key);
      }
      assert.equal(used.size, 7);
    } finally {
      room.stopTicking();
    }
  }
});

test('7 人开局：state 广播里带 spawnProtect 且坦克数量正确', () => {
  const { room, sockets } = makeRoom(7);
  try {
    room.tick(); // startRound 只广播 game_start，state 要等第一次 tick 才发
    const state = sockets[0].messages.find((m) => m.type === 'state');
    assert.ok(state, '开局后应有 state 广播');
    assert.equal(state.tanks.length, 7);
    for (const t of state.tanks) {
      assert.ok(t.spawnProtect > SPAWN_PROTECT_TIME - 1 && t.spawnProtect <= SPAWN_PROTECT_TIME,
        `spawnProtect 异常: ${t.spawnProtect}`);
    }
  } finally {
    room.stopTicking();
  }
});

test('出生保护：子弹被吸收，不掉血、不消耗道具护盾，并广播 spawn_block', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    b.shield = true; // 同时带着道具护盾，验证无敌优先、不消耗护盾
    shootAt(room, a, b);
    room.tick();

    assert.equal(b.alive, true, '出生保护期间不应被击杀');
    assert.equal(b.shield, true, '出生保护不应消耗道具护盾');
    assert.equal(room.bullets.length, 0, '子弹应被吸收');

    const blocks = sockets[0].messages.filter((m) => m.type === 'spawn_block');
    assert.equal(blocks.length, 1, '应广播一次 spawn_block');
    assert.equal(blocks[0].blocks.length, 1);
    assert.equal(blocks[0].blocks[0].ownerId, b.id);
  } finally {
    room.stopTicking();
  }
});

test('保护到期后，同样的子弹能正常击杀目标', () => {
  const { room } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    b.spawnProtectRemaining = 0;
    b.shield = false;
    // 血量机制下每发只造成 1 点伤害，这里先把目标压到 1 点血，
    // 验证的重点是"保护结束后命中能正常结算"，而不是一发的伤害量。
    b.hp = 1;
    shootAt(room, a, b);
    room.tick();

    assert.equal(b.alive, false, '保护结束后应被击杀');
    assert.equal(b.hp, 0, '致命命中后血量应归零');
    assert.equal(room.bullets.length, 0);
  } finally {
    room.stopTicking();
  }
});

test('开火立即解除出生保护', () => {
  const { room } = makeRoom(2);
  try {
    const [a] = [...room.players.values()];
    assert.ok(a.spawnProtectRemaining > SPAWN_PROTECT_TIME - 1, '开火前应仍在保护期');
    a.input.shoot = true;
    room.tick();

    assert.equal(a.spawnProtectRemaining, 0, '开火后保护应立即清零');
    assert.ok(room.bullets.length >= 1, '这一发应该真的打出去了');
  } finally {
    room.stopTicking();
  }
});

test('出生保护按时间倒计时（1 秒后约剩总时长 - 1 秒）', () => {
  const { room } = makeRoom(2);
  try {
    const [a] = [...room.players.values()];
    for (let i = 0; i < 30; i++) room.tick(); // 30 tick ≈ 1 秒
    assert.ok(Math.abs(a.spawnProtectRemaining - (SPAWN_PROTECT_TIME - 1)) < 0.11,
      `1 秒后剩余异常: ${a.spawnProtectRemaining}`);
  } finally {
    room.stopTicking();
  }
});
