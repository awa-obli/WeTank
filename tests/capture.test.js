'use strict';

// 占点模式的确定性单元测试（不监听网络端口，直接驱动 Room）：
//   1. 默认值 / 常量：10 秒占领、无人 10 秒衰减、换人 5 秒清进度、默认占领目标 3；
//   2. 开局生成据点：圆心完全随机、整个圆在世界内、出生点不在圈内；
//   3. 单人站圈进度按 CAPTURE_TIME 匀速上涨，state 同步 owner/progress；
//   4. 圈内 >=2 人且原 owner 在圈内时进度冻结；owner 离开后圈内多人也不能冻结；
//   5. 圈内没人时进度按 10 秒衰减到 0；
//   6. 换人/owner 离开后旧进度按 5 秒清退，归零后下一 tick 才轮到新玩家；
//   7. 占满一次得 1 分并随机换点，换点后进度清零；
//   8. 达到 captureTarget 后广播 match_end，不再换点；
//   9. 阵亡 / 凝聚动画中 / 观战者不参与占点；出生保护不解除也能占点；
//  10. 复活不会重置据点，且复活点避开当前据点圈。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Room,
  TANK_RADIUS,
  BRAWL_RESPAWN_DELAY,
  DEFAULT_MODE,
  MODES,
  AMMO_MAX,
  CAPTURE_RADIUS,
  CAPTURE_TIME,
  DECAY_EMPTY_TIME,
  DECAY_NEUTRALIZE_TIME,
  DEFAULT_CAPTURE_TARGET,
  MIN_CAPTURE_TARGET,
  MAX_CAPTURE_TARGET,
} = require('../server');

const TICK = 1 / 30;
const CAPTURE_TICKS = Math.round(CAPTURE_TIME / TICK); // 10 秒 = 300 tick
const DECAY_EMPTY_TICKS = Math.round(DECAY_EMPTY_TIME / TICK); // 10 秒 = 300 tick
const DECAY_NEUTRALIZE_TICKS = Math.round(DECAY_NEUTRALIZE_TIME / TICK); // 5 秒 = 150 tick

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
    invisibleRemaining: 0,
    spawnProtectRemaining: 0,
    spawnAnimRemaining: 0,
    ammo: AMMO_MAX,
    ammoReloadAcc: 0,
    respawnRemaining: 0,
  };
}

function makeRoom(playerCount = 2, { keepPoint = false } = {}) {
  const room = new Room('TEST');
  room.mode = 'capture';
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
  for (const p of room.players.values()) {
    p.spawnAnimRemaining = 0;
    p.spawnProtectRemaining = 0;
  }
  if (!keepPoint) {
    // 固定一个测试据点，避免依赖随机位置；玩家位置在用例里手动摆放。
    room.point = {
      id: 1000,
      x: 400,
      y: 300,
      radius: CAPTURE_RADIUS,
      progress: 0,
      ownerId: null,
      ownerColor: null,
      status: 'idle',
    };
  }
  return { room, sockets };
}

function placeAt(room, p, dx, dy) {
  p.x = room.point.x + dx;
  p.y = room.point.y + dy;
}

function placeFar(room, p) {
  p.x = 10;
  p.y = 10;
}

function lastState(socket) {
  return socket.messages.filter((m) => m.type === 'state').pop();
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

test('占点模式：常量、默认占领目标、默认模式仍是大乱斗', () => {
  const room = new Room('TEST');
  assert.equal(DEFAULT_MODE, 'brawl');
  assert.equal(MODES.capture.name, '占点模式');
  assert.equal(CAPTURE_RADIUS, 80);
  assert.equal(CAPTURE_TIME, 10);
  assert.equal(DECAY_EMPTY_TIME, 10);
  assert.equal(DECAY_NEUTRALIZE_TIME, 5);
  assert.equal(DEFAULT_CAPTURE_TARGET, 3);
  assert.equal(MIN_CAPTURE_TARGET, 1);
  assert.equal(MAX_CAPTURE_TARGET, 10);
  assert.equal(room.captureTarget, DEFAULT_CAPTURE_TARGET);
  assert.equal(room.point, null);
});

test('开局生成据点：圆心完全随机、整个圆在世界内、出生点不在圈内', () => {
  const { room } = makeRoom(3, { keepPoint: true });
  try {
    const p = room.point;
    assert.ok(p, '占点模式开局必须有据点');
    assert.ok(p.id >= 1);
    assert.equal(p.progress, 0);
    assert.equal(p.status, 'idle');
    assert.equal(p.ownerId, null);
    assert.equal(p.radius, CAPTURE_RADIUS);
    // 完全随机：允许小数坐标，不再要求格心
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), '据点坐标应为有限数');
    // 整个圆都在世界内
    assert.ok(p.x >= p.radius && p.x <= room.worldW - p.radius, '圆心离左右边界至少一个半径');
    assert.ok(p.y >= p.radius && p.y <= room.worldH - p.radius, '圆心离上下边界至少一个半径');
    // 出生点避开圈（spawn.js 的 avoidZones 生效）
    for (const player of room.players.values()) {
      const d2 = dist2(player.x, player.y, p.x, p.y);
      assert.ok(d2 > p.radius * p.radius, `玩家 ${player.id} 出生在据点圈内`);
    }
  } finally {
    room.stopTicking();
  }
});

test('单人站圈：进度上涨，state 同步 owner / progress / status', () => {
  const { room, sockets } = makeRoom(2);
  const [a, b] = [...room.players.values()];
  placeAt(room, a, 0, 0);
  placeFar(room, b);
  room.tick();

  assert.equal(room.point.ownerId, a.id);
  assert.equal(room.point.ownerColor, a.color);
  assert.equal(room.point.status, 'capturing');
  assert.ok(Math.abs(room.point.progress - 1 / CAPTURE_TICKS) < 1e-6, `进度应为一帧的增量，实际 ${room.point.progress}`);
  assert.equal(a.score, 0, '没占满之前不得分');

  const state = lastState(sockets[0]);
  assert.ok(state.point, 'state 必须带据点');
  assert.equal(state.point.ownerId, a.id);
  assert.equal(state.point.status, 'capturing');
  assert.ok(state.point.progress > 0);
});

test('争夺：圈内 >=2 人且原 owner 在圈内时进度冻结，走掉一个后恢复', () => {
  const { room } = makeRoom(2);
  const [a, b] = [...room.players.values()];
  placeAt(room, a, -20, 0);
  placeFar(room, b);
  for (let i = 0; i < 60; i++) room.tick(); // 2 秒
  const before = room.point.progress;
  assert.ok(before > 0);

  placeAt(room, b, 20, 0); // 两人都在圈内，间距 40 > 30，不会互相推挤
  for (let i = 0; i < 60; i++) room.tick();
  assert.equal(room.point.status, 'contested');
  assert.ok(Math.abs(room.point.progress - before) < 1e-9, '争夺时进度必须完全冻结');

  placeFar(room, b);
  for (let i = 0; i < 30; i++) room.tick();
  assert.equal(room.point.status, 'capturing');
  assert.ok(room.point.progress > before, '对手离开后应继续上涨');
});

test('无人圈内：进度按 10 秒逐渐衰减到 0', () => {
  const { room } = makeRoom(2);
  const [a, b] = [...room.players.values()];
  room.point.progress = 1;
  room.point.ownerId = a.id;
  room.point.ownerColor = a.color;
  room.point.status = 'decaying';
  placeFar(room, a);
  placeFar(room, b);

  for (let i = 0; i < DECAY_EMPTY_TICKS - 1; i++) room.tick();
  assert.ok(room.point.progress > 0, '10 秒未到不应清零');
  assert.equal(room.point.ownerId, a.id, '衰减期间保留 owner 颜色');

  room.tick(); // 第 300 tick
  assert.equal(room.point.progress, 0);
  assert.equal(room.point.ownerId, null);
  assert.equal(room.point.ownerColor, null);
  assert.equal(room.point.status, 'idle');
});

test('换人：旧进度按 5 秒清空，归零后下一 tick 才开始新进度', () => {
  const { room } = makeRoom(2);
  const [a, b] = [...room.players.values()];
  room.point.progress = 1;
  room.point.ownerId = a.id;
  room.point.ownerColor = a.color;
  placeFar(room, a);
  placeAt(room, b, 0, 0);

  for (let i = 0; i < 30; i++) room.tick(); // 1 秒，清掉 1/5
  assert.equal(room.point.ownerId, a.id, '旧进度没清完前 owner 仍是 a');
  assert.equal(room.point.status, 'neutralizing');
  assert.ok(room.point.progress >= 0.8 - 1e-6 && room.point.progress < 1);

  // 0~30 已经跑过，继续跑到第 149 tick：仍未清零
  for (let i = 30; i < DECAY_NEUTRALIZE_TICKS - 1; i++) room.tick();
  assert.ok(room.point.progress > 0, '5 秒未到不应清零');
  assert.equal(room.point.ownerId, a.id);

  room.tick(); // 第 150 tick：清零
  assert.equal(room.point.progress, 0);
  assert.equal(room.point.ownerId, null, '清零后才允许换 owner');

  room.tick();
  assert.equal(room.point.ownerId, b.id, '下一 tick 才开始给 b 涨');
  assert.equal(room.point.status, 'capturing');
  assert.ok(room.point.progress > 0);
});

test('原占领者不在圈内时，圈内多人也不能替他冻结进度', () => {
  const { room } = makeRoom(3);
  const [a, b, c] = [...room.players.values()];
  room.point.progress = 0.5;
  room.point.ownerId = a.id;
  room.point.ownerColor = a.color;
  placeFar(room, a);
  placeAt(room, b, -20, 0);
  placeAt(room, c, 20, 0);

  // a 已经离开/阵亡，b+c 两个人在圈内：进度必须继续按 5 秒衰减，而不是冻结。
  for (let i = 0; i < 30; i++) room.tick(); // 1 秒
  assert.equal(room.point.status, 'neutralizing', 'owner 不在圈内时多人也不能冻结进度');
  assert.equal(room.point.ownerId, a.id, '旧 owner 颜色保留到进度清零');
  assert.ok(room.point.progress > 0 && room.point.progress < 0.5);

  // 0.5 按 5 秒清完需要 2.5 秒，再跑 2 秒足够清零
  for (let i = 0; i < 60; i++) room.tick();
  assert.equal(room.point.progress, 0);
  assert.equal(room.point.ownerId, null);
  assert.equal(room.point.status, 'contested', '清零后两人仍在圈内，互相牵制');

  // 走掉一个，剩下的人从 0 开始占领
  placeFar(room, c);
  room.tick();
  assert.equal(room.point.ownerId, b.id);
  assert.equal(room.point.status, 'capturing');
  assert.ok(room.point.progress > 0);
});

test('占满一次：得 1 分并随机换点，进度清零、比赛继续', () => {
  const { room, sockets } = makeRoom(2);
  const [a, b] = [...room.players.values()];
  room.captureTarget = 3;
  placeAt(room, a, 0, 0);
  placeFar(room, b);
  for (let i = 0; i < CAPTURE_TICKS - 1; i++) room.tick();
  assert.equal(a.score, 0);

  const oldPoint = { ...room.point };
  room.tick(); // 第 300 tick：占满

  assert.equal(a.score, 1, '占领一次得 1 分');
  assert.equal(room.state, 'playing', '没到目标应继续比赛');
  assert.notEqual(room.point.id, oldPoint.id, '占领后必须换一个新据点');
  assert.equal(room.point.progress, 0);
  assert.equal(room.point.ownerId, null);
  assert.equal(room.point.status, 'idle');
  // 换点完全随机：只要求新据点仍整个圆在图内，不再要求避开玩家
  assert.ok(room.point.x >= room.point.radius && room.point.x <= room.worldW - room.point.radius);
  assert.ok(room.point.y >= room.point.radius && room.point.y <= room.worldH - room.point.radius);

  const captured = sockets[0].messages.find((m) => m.type === 'point_captured');
  assert.ok(captured, '应广播 point_captured');
  assert.equal(captured.playerId, a.id);
  assert.equal(captured.score, 1);
  assert.equal(captured.target, 3);
  assert.equal(captured.x, oldPoint.x);
  assert.equal(captured.y, oldPoint.y);
  assert.ok(!sockets[0].messages.some((m) => m.type === 'match_end'), '没到目标不应结束整场');
});

test('达到占领目标：广播 match_end，不再换点', () => {
  const { room, sockets } = makeRoom(2);
  const [a, b] = [...room.players.values()];
  room.captureTarget = 2;
  a.score = 1; // 模拟已经占过一次
  placeAt(room, a, 0, 0);
  placeFar(room, b);
  const oldId = room.point.id;

  for (let i = 0; i < CAPTURE_TICKS; i++) room.tick();

  assert.equal(a.score, 2);
  const matchEnd = sockets[0].messages.find((m) => m.type === 'match_end');
  assert.ok(matchEnd, '达到占领目标应广播 match_end');
  assert.equal(matchEnd.winnerId, a.id);
  assert.equal(matchEnd.mode, 'capture');
  assert.equal(matchEnd.captureTarget, 2);
  assert.equal(room.state, 'lobby');
  assert.equal(room.point.id, oldId, '比赛结束后不再换点');
  assert.ok(!sockets[0].messages.some((m) => m.type === 'round_end'), '占点模式不广播 round_end');
});

test('阵亡 / 凝聚中不参与占点；出生保护不解除也能占点', () => {
  const { room } = makeRoom(3);
  const [a, b, c] = [...room.players.values()];
  placeAt(room, a, 0, 0);
  placeAt(room, b, 10, 0);
  placeAt(room, c, -10, 0);
  b.alive = false; // 阵亡等待复活
  c.spawnAnimRemaining = 0.5; // 凝聚动画中，没有实体
  a.spawnProtectRemaining = 3; // 需求确认：进圈不解除出生保护

  for (let i = 0; i < 10; i++) room.tick();
  assert.equal(room.point.ownerId, a.id);
  assert.equal(room.point.status, 'capturing');
  assert.ok(room.point.progress > 0);
  assert.equal(room.point.ownerId, a.id, '出生保护期内仍能正常占点');
});

test('复活不重置据点，且复活点避开当前据点圈', () => {
  const { room } = makeRoom(2);
  const [a, b] = [...room.players.values()];
  room.point.progress = 0.4;
  room.point.ownerId = a.id;
  room.point.ownerColor = a.color;
  room.point.status = 'capturing';
  b.alive = false;
  b.hp = 0;
  b.respawnRemaining = BRAWL_RESPAWN_DELAY;

  room.respawnPlayer(b);
  assert.equal(room.point.progress, 0.4, '复活不应重置据点进度');
  assert.equal(room.point.ownerId, a.id);
  assert.equal(b.alive, true);
  const d2 = dist2(b.x, b.y, room.point.x, room.point.y);
  assert.ok(d2 >= (room.point.radius + TANK_RADIUS) ** 2, '复活点不应落在据点圈内');
});
