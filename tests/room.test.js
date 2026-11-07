'use strict';

// 房间逻辑的确定性单元测试（不监听网络端口，直接驱动 Room）：
//   1. 7 人开局时出生格互不重复、都在格心、朝向在 [0, 2π)；
//   2. 出生保护期间子弹被吸收：不掉血、不消耗道具护盾，并广播 spawn_block；
//   3. 保护到期后，同样的子弹能正常击杀目标；
//   4. 开火会立即解除出生保护；
//   5. 出生保护按 tick 正常倒计时；
//   6. 结算消息：round_end 带 final 标记，advanceAfterRound 按冠军/人数决定去向；
//   7. 重生动画：开局 1 秒内坦克没有实体，保护倒计时冻结，动画结束后才恢复正常。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Room,
  SPAWN_PROTECT_TIME,
  SPAWN_MATERIALIZE_TIME,
  CELL,
} = require('../server');

const TICK = 1 / 30;
const MATERIALIZE_TICKS = Math.round(SPAWN_MATERIALIZE_TIME / TICK); // 1 秒 = 30 tick

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
    spawnAnimRemaining: 0,
  };
}

function makeRoom(playerCount, keepSpawnAnim = false) {
  const room = new Room('TEST');
  // 本文件测的是经典模式的回合计分/淘汰逻辑；大乱斗已改为默认模式，这里显式指定。
  room.mode = 'classic';
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
  // 多数用例关心的是"实体已经出现之后"的机制，这里直接跳过 1 秒重生动画；
  // 专门验证重生动画的用例传 keepSpawnAnim = true，保留 startRound 设置的真实初值。
  if (!keepSpawnAnim) {
    for (const p of room.players.values()) p.spawnAnimRemaining = 0;
  }
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

// endRound 内部用真实 setTimeout 排下一阶段，这里把 3 秒定时器替换成 mock，
// 只验证立即广播出去的 round_end；后续去向由 advanceAfterRound 的测试直接覆盖。
test('round_end 带 final：普通回合为 false，产生 5 分冠军时为 true', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const normal = makeRoom(2);
  try {
    const [a] = [...normal.room.players.values()];
    normal.room.endRound(a);
    const msg = normal.sockets[0].messages.filter((m) => m.type === 'round_end').pop();
    assert.equal(msg.winnerId, a.id);
    assert.equal(msg.final, false, '没人到 5 分时不应标记为最终回合');
  } finally {
    normal.room.stopTicking();
  }

  const deciding = makeRoom(2);
  try {
    const [a] = [...deciding.room.players.values()];
    a.score = 4;
    deciding.room.endRound(a);
    const msg = deciding.sockets[0].messages.filter((m) => m.type === 'round_end').pop();
    assert.equal(msg.winnerId, a.id);
    assert.equal(msg.final, true, '本局产生 5 分冠军时应标记为最终回合');
    assert.equal(msg.scores.find((s) => s.id === a.id).score, 5);
  } finally {
    deciding.room.stopTicking();
  }
});

test('advanceAfterRound：冠军产生时广播 match_end 回大厅', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a] = [...room.players.values()];
    a.score = 5;
    room.advanceAfterRound({ id: a.id });

    const msg = sockets[0].messages.find((m) => m.type === 'match_end');
    assert.ok(msg, '冠军产生后应广播 match_end');
    assert.equal(msg.winnerId, a.id);
    assert.equal(room.state, 'lobby');
  } finally {
    room.stopTicking();
  }
});

test('advanceAfterRound：人数不足时广播 match_end，不把客户端晾在结算遮罩上', () => {
  const { room } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    room.players.delete(b.id); // 模拟结算展示期间对手退出
    room.advanceAfterRound(null);

    const msg = a.ws.messages.find((m) => m.type === 'match_end');
    assert.ok(msg, '人数不足时也应广播 match_end');
    assert.equal(msg.reason, 'not_enough_players');
    assert.equal(room.state, 'lobby');
  } finally {
    room.stopTicking();
  }
});

test('advanceAfterRound：人数够且无冠军时开下一回合', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const before = sockets[0].messages.filter((m) => m.type === 'game_start').length;
    room.advanceAfterRound(null);

    assert.equal(room.state, 'playing');
    const after = sockets[0].messages.filter((m) => m.type === 'game_start').length;
    assert.equal(after, before + 1, '应广播新一回合的 game_start');
  } finally {
    room.stopTicking();
  }
});

test('重生动画：开局 1 秒内保护倒计时冻结，动画结束后才开始计时', () => {
  const { room } = makeRoom(2, true);
  try {
    const [a] = [...room.players.values()];
    assert.equal(a.spawnAnimRemaining, SPAWN_MATERIALIZE_TIME, '开局应进入重生动画');
    assert.equal(a.spawnProtectRemaining, SPAWN_PROTECT_TIME, '保护初值仍是满 3 秒');

    room.tick();
    assert.ok(a.spawnAnimRemaining > 0, '第一帧动画还没播完');
    assert.equal(a.spawnProtectRemaining, SPAWN_PROTECT_TIME, '动画期间保护不倒数');

    // 1 秒 = 30 个 tick：第 30 帧动画结束，并在这帧把保护重置为满值（上面已经跑过 1 帧）
    for (let i = 1; i < MATERIALIZE_TICKS; i++) room.tick();
    assert.equal(a.spawnAnimRemaining, 0, `${MATERIALIZE_TICKS} 帧后动画应该结束`);
    assert.equal(a.spawnProtectRemaining, SPAWN_PROTECT_TIME, '动画结束的瞬间保护仍是满值');

    for (let i = 0; i < 30; i++) room.tick(); // 再跑 1 秒
    assert.ok(
      Math.abs(a.spawnProtectRemaining - (SPAWN_PROTECT_TIME - 1)) < 0.05,
      `动画结束后保护才开始倒数，1 秒后应剩 ${SPAWN_PROTECT_TIME - 1} 秒，实际 ${a.spawnProtectRemaining}`
    );
  } finally {
    room.stopTicking();
  }
});

test('重生动画期间坦克没有实体：不移动、不开火、不吃道具、子弹穿透', () => {
  const { room } = makeRoom(2, true);
  try {
    const [a, b] = [...room.players.values()];
    const hp0 = a.hp;
    const x0 = a.x;

    a.input.forward = true;
    a.input.shoot = true;
    // 在 a 脚下放一个护盾，验证动画期间不会被拾取
    room.items.push({ id: room.nextItemId++, type: 'shield', x: a.x, y: a.y, cellR: 0, cellC: 0 });
    // b 朝 a 打一发，验证子弹会直接穿过还没有实体的 a
    shootAt(room, b, a);

    room.tick();

    assert.equal(a.x, x0, '动画期间不应响应移动输入');
    assert.equal(a.hp, hp0, '动画期间不应被子弹击中');
    assert.equal(a.shield, false, '动画期间不应拾取道具');
    assert.equal(room.items.length, 1, '道具应留在原地');
    assert.equal(room.bullets.length, 1, '子弹不应被挡住或吸收');
    assert.ok(
      !room.bullets.some((bullet) => bullet.owner === a.id),
      '动画期间不能开火'
    );
  } finally {
    room.stopTicking();
  }
});

test('重生动画结束后坦克恢复实体：能移动、能开火', () => {
  const { room } = makeRoom(2, true);
  try {
    const [a] = [...room.players.values()];
    for (let i = 0; i < MATERIALIZE_TICKS; i++) room.tick(); // 播完 1 秒动画

    const x0 = a.x;
    a.input.forward = true;
    room.tick();
    assert.notEqual(a.x, x0, '动画结束后应能移动');

    a.input.forward = false;
    a.input.shoot = true;
    room.tick();
    assert.ok(
      room.bullets.some((bullet) => bullet.owner === a.id),
      '动画结束后应能开火'
    );
  } finally {
    room.stopTicking();
  }
});

test('state / game_start 广播带重生动画字段', () => {
  const { room, sockets } = makeRoom(2, true);
  try {
    const start = sockets[0].messages.find((m) => m.type === 'game_start');
    assert.equal(start.spawnMaterialize, SPAWN_MATERIALIZE_TIME, 'game_start 应带动画总时长');

    room.tick();
    let state = sockets[0].messages.filter((m) => m.type === 'state').pop();
    assert.ok(state.tanks.every((t) => t.spawnAnim > 0), '动画期间 spawnAnim 应大于 0');

    for (let i = 1; i < MATERIALIZE_TICKS; i++) room.tick();
    state = sockets[0].messages.filter((m) => m.type === 'state').pop();
    assert.ok(state.tanks.every((t) => t.spawnAnim === 0), '动画结束后 spawnAnim 应归零');
    assert.ok(
      state.tanks.every((t) => t.spawnProtect === SPAWN_PROTECT_TIME),
      '动画结束时保护仍是满 3 秒'
    );
  } finally {
    room.stopTicking();
  }
});


test('state 广播带观战者名单，观战者也能收到对局状态', () => {
  const { room } = makeRoom(2);
  const specWs = makeWs();
  room.spectators.set('s1', { id: 's1', name: '观战者', ws: specWs });
  try {
    room.tick();
    const state = specWs.messages.find((m) => m.type === 'state');
    assert.ok(state, '观战者应收到 state');
    assert.equal(state.tanks.length, 2, '观战者不应出现在坦克列表里');
    assert.deepEqual(state.spectators, [{ id: 's1', name: '观战者' }]);
  } finally {
    room.stopTicking();
  }
});

test('冠军产生时观战者转正并进入 match_end 名单', () => {
  const { room } = makeRoom(2);
  const specWs = makeWs();
  room.spectators.set('s1', { id: 's1', name: '观战者', ws: specWs });
  try {
    const [a] = [...room.players.values()];
    a.score = 5;
    room.advanceAfterRound({ id: a.id });

    assert.equal(room.state, 'lobby');
    assert.equal(room.spectators.size, 0);
    assert.ok(room.players.has('s1'), '观战者应转为正式玩家');
    assert.equal(room.players.get('s1').score, 0);
    assert.equal(room.hostId, a.id, '原房主仍在时房主不变');

    const msg = specWs.messages.find((m) => m.type === 'match_end');
    assert.ok(msg, '转正后的观战者也应收到 match_end');
    assert.ok(msg.scores.some((s) => s.id === 's1'));
    assert.equal(msg.spectators.length, 0);
  } finally {
    room.stopTicking();
  }
});

test('比赛继续时观战者不转正，下一回合仍然观战', () => {
  const { room } = makeRoom(2);
  const specWs = makeWs();
  room.spectators.set('s1', { id: 's1', name: '观战者', ws: specWs });
  try {
    room.advanceAfterRound(null); // 人数够、无冠军 -> 开下一回合
    assert.equal(room.state, 'playing');
    assert.equal(room.spectators.size, 1, '观战者应继续等待整场比赛结束');
    assert.ok(!room.players.has('s1'), '下一回合开始时观战者不应直接参战');

    const start = specWs.messages.find((m) => m.type === 'game_start');
    assert.ok(start, '观战者也应收到下一回合的 game_start');
    assert.ok(start.spectators.some((s) => s.id === 's1'));
  } finally {
    room.stopTicking();
  }
});

test('最后正式玩家离开时观战者转正并接管房主', () => {
  const { room } = makeRoom(2);
  const specWs = makeWs();
  room.spectators.set('s1', { id: 's1', name: '观战者', ws: specWs });
  try {
    room.players.clear();
    room.finishMatch('not_enough_players');

    assert.equal(room.state, 'lobby');
    assert.equal(room.spectators.size, 0);
    assert.ok(room.players.has('s1'));
    assert.equal(room.hostId, 's1', '没有正式玩家时第一个转正者接管房主');

    const msg = specWs.messages.find((m) => m.type === 'match_end');
    assert.ok(msg);
    assert.ok(msg.scores.some((s) => s.id === 's1'));
  } finally {
    room.stopTicking();
  }
});
