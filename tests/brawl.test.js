'use strict';

// 大乱斗模式的确定性单元测试（不监听网络端口，直接驱动 Room）：
//   1. 默认模式是大乱斗，默认击杀目标 / 复活时长 / 经典模式胜利回合数正确；
//   2. 击杀后击杀者 +1，阵亡者进入 10 秒复活倒计时，state 里同步 score / respawn；
//   3. 10 秒后在格心复活，血量、弹药、增益、输入全部重置，并重新带出生保护；
//   4. 大乱斗里阵亡不会触发经典模式的淘汰/观察期；
//   5. 跳弹打死自己不计击杀；已经阵亡的击杀者生前打出的子弹仍然算击杀；
//   6. 达到击杀目标立即结束整场比赛（match_end，不广播 round_end）；
//   7. 经典模式没有复活机制，击杀也不直接加分。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Room,
  CELL,
  TANK_RADIUS,
  SPAWN_PROTECT_TIME,
  SPAWN_MATERIALIZE_TIME,
  BRAWL_RESPAWN_DELAY,
  DEFAULT_MODE,
  DEFAULT_KILL_TARGET,
  DEFAULT_WIN_SCORE,
  AMMO_MAX,
} = require('../server');

const TICK = 1 / 30;
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
    score: 0,
    x: 0,
    y: 0,
    angle: 0,
    alive: true,
    hp: 3,
    cooldown: 0,
    input: { forward: false, backward: false, left: false, right: false, shoot: false },
    shield: false,
    speedBoostRemaining: 0,
    tripleReady: false,
    homingReady: false,
    invisibleRemaining: 0,
    spawnProtectRemaining: 0,
    spawnAnimRemaining: 0,
    ammo: AMMO_MAX,
    ammoReloadAcc: 0,
    respawnRemaining: 0,
  };
}

function makeRoom(playerCount = 2) {
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
  room.stopTicking(); // 测试里手动 tick，不让真实定时器参与
  // 跳过开局的 0.75 秒凝聚动画；出生保护仍保留，需要挨打的用例单独清零。
  for (const p of room.players.values()) p.spawnAnimRemaining = 0;
  return { room, sockets };
}

// 在 target 左侧放一颗朝它飞、下一次 tick 必定命中的子弹（age 跳过自伤豁免）。
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

function lastState(socket) {
  return socket.messages.filter((m) => m.type === 'state').pop();
}

function killOnce(room, shooter, target) {
  target.spawnProtectRemaining = 0;
  target.hp = 1;
  shootAt(room, shooter, target);
  room.tick();
}

test('默认模式是大乱斗，默认设置正确', () => {
  const room = new Room('TEST');
  assert.equal(DEFAULT_MODE, 'brawl');
  assert.equal(room.mode, 'brawl');
  assert.equal(room.killTarget, DEFAULT_KILL_TARGET);
  assert.equal(room.killTarget, 10);
  assert.equal(room.winScore, DEFAULT_WIN_SCORE);
  assert.equal(room.winScore, 5);
  assert.equal(BRAWL_RESPAWN_DELAY, 10);
});

test('击杀：击杀者 +1，阵亡者进入 10 秒复活倒计时，state 同步 score/respawn', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    killOnce(room, a, b);

    assert.equal(b.alive, false, '血量归零应阵亡');
    assert.equal(a.score, 1, '击杀者击杀数应 +1');
    assert.equal(b.score, 0, '被击杀者不加分');
    assert.equal(b.respawnRemaining, BRAWL_RESPAWN_DELAY, '阵亡瞬间应进入满 10 秒倒计时');

    const state = lastState(sockets[0]);
    const victim = state.tanks.find((t) => t.id === b.id);
    const killer = state.tanks.find((t) => t.id === a.id);
    assert.equal(victim.respawn, 10, 'state 应同步复活倒计时');
    assert.equal(killer.score, 1, 'state 应实时同步击杀数');
  } finally {
    room.stopTicking();
  }
});

test('阵亡 10 秒后在格心复活，并重置血量/弹药/增益/输入', () => {
  const { room } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    // 给 b 挂满各种状态，验证复活时会被清空
    b.spawnProtectRemaining = 0;
    b.hp = 1;
    b.tripleReady = true;
    b.homingReady = true;
    b.speedBoostRemaining = 3;
    b.invisibleRemaining = 4;
    b.ammo = 0;
    b.ammoReloadAcc = 2;
    b.input.forward = true;
    b.input.shoot = true;
    shootAt(room, a, b);
    room.tick();
    assert.equal(b.alive, false);

    // 护盾必须在挨这一发之前是关的，否则会挡掉伤害；死亡后再挂上，验证复活会清空它。
    b.shield = true;

    // 差一个 tick 到 10 秒时仍应处于阵亡状态
    for (let i = 0; i < RESPAWN_TICKS - 1; i++) room.tick();
    assert.equal(b.alive, false, '10 秒未到不应复活');
    assert.ok(b.respawnRemaining > 0 && b.respawnRemaining <= TICK + 1e-6, '剩余时间应接近 0');

    room.tick(); // 第 300 tick：复活
    assert.equal(b.alive, true, '10 秒到点应复活');
    assert.equal(b.hp, room.maxHp, '复活应满血');
    assert.equal(b.ammo, AMMO_MAX, '复活应满弹');
    assert.equal(b.ammoReloadAcc, 0, '复活应清空装填进度');
    assert.equal(b.shield, false);
    assert.equal(b.tripleReady, false);
    assert.equal(b.homingReady, false);
    assert.equal(b.speedBoostRemaining, 0);
    assert.equal(b.invisibleRemaining, 0);
    assert.deepEqual(b.input, { forward: false, backward: false, left: false, right: false, shoot: false });
    assert.equal(b.respawnRemaining, 0);
    assert.equal(b.spawnProtectRemaining, SPAWN_PROTECT_TIME, '复活应重新带出生保护');
    assert.ok(b.spawnAnimRemaining > 0 && b.spawnAnimRemaining <= SPAWN_MATERIALIZE_TIME, '复活应带凝聚动画');

    // 复活点必须是格心，并且避开仍然存活的 a（至少 2 倍坦克半径）
    assert.equal((b.x - CELL / 2) % CELL, 0, `复活 x 不是格心: ${b.x}`);
    assert.equal((b.y - CELL / 2) % CELL, 0, `复活 y 不是格心: ${b.y}`);
    assert.ok(Math.hypot(b.x - a.x, b.y - a.y) >= TANK_RADIUS * 2, '复活点不应贴脸存活坦克');
  } finally {
    room.stopTicking();
  }
});

test('大乱斗阵亡不会触发经典模式的淘汰/观察期', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    killOnce(room, a, b);

    // 跑 6 秒：经典模式此时早已进入 round_pending，大乱斗必须继续 playing。
    for (let i = 0; i < 180; i++) room.tick();
    assert.equal(room.state, 'playing', '大乱斗不应因只剩一人而进入残局观察期');
    assert.ok(!sockets[0].messages.some((m) => m.type === 'round_end'), '大乱斗不应广播 round_end');
    assert.equal(b.alive, false, '6 秒时仍在 10 秒复活等待期内');
    assert.ok(b.respawnRemaining > 0, '复活倒计时应仍在进行');
  } finally {
    room.stopTicking();
  }
});

test('跳弹打死自己不计击杀', () => {
  const { room } = makeRoom(2);
  try {
    const [, b] = [...room.players.values()];
    b.spawnProtectRemaining = 0;
    b.hp = 1;
    shootAt(room, b, b);
    room.tick();

    assert.equal(b.alive, false, '自己打死自己仍然会阵亡');
    assert.equal(b.score, 0, '自杀不应增加击杀数');
    assert.equal(b.respawnRemaining, BRAWL_RESPAWN_DELAY, '自杀同样进入复活倒计时');
  } finally {
    room.stopTicking();
  }
});

test('已经阵亡的击杀者，生前打出的子弹命中仍算击杀', () => {
  const { room } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    // b 先处于阵亡等待复活状态，但场上留着一颗 b 打出的子弹
    b.alive = false;
    b.hp = 0;
    b.respawnRemaining = BRAWL_RESPAWN_DELAY;
    a.spawnProtectRemaining = 0;
    a.hp = 1;
    shootAt(room, b, a);
    room.tick();

    assert.equal(a.alive, false, '子弹应正常击杀 a');
    assert.equal(b.score, 1, '阵亡者的子弹命中也应记到击杀者头上');
  } finally {
    room.stopTicking();
  }
});

test('达到击杀目标：广播 match_end，不广播 round_end', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    room.killTarget = 1;
    killOnce(room, a, b);

    const matchEnd = sockets[0].messages.find((m) => m.type === 'match_end');
    assert.ok(matchEnd, '达到击杀目标应广播 match_end');
    assert.equal(matchEnd.winnerId, a.id);
    assert.equal(matchEnd.mode, 'brawl');
    assert.equal(matchEnd.killTarget, 1);
    assert.equal(matchEnd.scores.find((s) => s.id === a.id).score, 1);
    assert.equal(room.state, 'lobby', '整场比赛结束应回到大厅');
    assert.equal(sockets[0].messages.filter((m) => m.type === 'round_end').length, 0, '大乱斗不广播 round_end');
  } finally {
    room.stopTicking();
  }
});

test('经典模式：击杀不直接加分、阵亡后不会复活', () => {
  const { room } = makeRoom(2);
  try {
    room.mode = 'classic';
    room.winScore = 5;
    const [a, b] = [...room.players.values()];
    killOnce(room, a, b);

    assert.equal(b.alive, false);
    assert.equal(a.score, 0, '经典模式的分数是回合胜场，击杀不直接加分');
    assert.equal(b.respawnRemaining, 0, '经典模式不应进入复活倒计时');

    // 即使跑 10 秒也不会复活；第 5 秒起服务端会进入残局观察期（这里把定时器清掉避免真实计时）
    for (let i = 0; i < RESPAWN_TICKS; i++) room.tick();
    assert.equal(b.alive, false, '经典模式阵亡不应复活');
    assert.equal(room.state, 'round_pending', '经典模式只剩一人应进入 5 秒观察期');
  } finally {
    room.stopTicking();
  }
});
