'use strict';

// 血量机制的确定性单元测试（不监听网络端口，直接驱动 Room）：
//   1. 新房间默认血量、允许范围与默认值一致；
//   2. 每回合开局按房间设置补满血量；
//   3. 每发子弹固定 1 点伤害，未归零时只掉血、不淘汰，并广播 damage；
//   4. 血量归零才阵亡，血量钳制在 0；
//   5. 道具护盾完全挡下一发，不掉血；
//   6. 维修包回 1 点且不超过上限，满血时不会被拾取；
//   7. 新回合开始所有人重新满血。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Room,
  DEFAULT_MAX_HP,
  MIN_MAX_HP,
  MAX_MAX_HP,
  BULLET_DAMAGE,
  REPAIR_HEAL,
  ITEM_TYPES,
} = require('../server');

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
  // 这里关注的是实体出现之后的血量机制，直接跳过开局的 1 秒重生动画
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

function damageMessages(socket) {
  return socket.messages.filter((m) => m.type === 'damage');
}

test('默认血量与允许范围', () => {
  const room = new Room('TEST');
  assert.equal(room.maxHp, DEFAULT_MAX_HP);
  assert.equal(DEFAULT_MAX_HP, 3);
  assert.ok(MIN_MAX_HP >= 1, `最小血量异常: ${MIN_MAX_HP}`);
  assert.ok(MAX_MAX_HP >= DEFAULT_MAX_HP, `最大血量异常: ${MAX_MAX_HP}`);
  assert.equal(BULLET_DAMAGE, 1);
  assert.equal(REPAIR_HEAL, 1);
  assert.ok(ITEM_TYPES.includes('repair'), '道具池里应该有维修包');
});

test('开局按房间设置给所有人补满血量', () => {
  const { room } = makeRoom(3);
  try {
    room.maxHp = 7;
    room.startRound();
    room.stopTicking();
    for (const p of room.players.values()) {
      assert.equal(p.hp, 7, `${p.id} 开局血量异常: ${p.hp}`);
      assert.equal(p.alive, true);
    }
  } finally {
    room.stopTicking();
  }
});

test('每发子弹 1 点伤害：未归零只掉血、不淘汰，并广播 damage', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    b.spawnProtectRemaining = 0;
    shootAt(room, a, b);
    room.tick();

    assert.equal(b.hp, DEFAULT_MAX_HP - 1, `中弹后血量异常: ${b.hp}`);
    assert.equal(b.alive, true, '还有血时不应被淘汰');
    assert.equal(room.bullets.length, 0, '命中后子弹应消失');

    const damages = damageMessages(sockets[0]);
    assert.equal(damages.length, 1, '应广播一次 damage');
    assert.equal(damages[0].hits.length, 1);
    const hit = damages[0].hits[0];
    assert.equal(hit.playerId, b.id);
    assert.equal(hit.by, a.id);
    assert.equal(hit.hp, DEFAULT_MAX_HP - 1);
    assert.equal(hit.dead, false);
    assert.equal(typeof hit.x, 'number');
    assert.equal(typeof hit.y, 'number');
  } finally {
    room.stopTicking();
  }
});

test('血量归零才阵亡，血量钳制在 0', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    b.spawnProtectRemaining = 0;
    for (let i = 0; i < DEFAULT_MAX_HP; i++) {
      shootAt(room, a, b);
      room.tick();
    }

    assert.equal(b.hp, 0, `阵亡后血量异常: ${b.hp}`);
    assert.equal(b.alive, false, '血量归零应阵亡');

    const hits = damageMessages(sockets[0]).flatMap((m) => m.hits);
    assert.equal(hits.length, DEFAULT_MAX_HP, '每次命中都应有 damage 广播');
    assert.equal(hits[hits.length - 1].dead, true, '最后一次命中应标记 dead');
  } finally {
    room.stopTicking();
  }
});

test('道具护盾完全挡下一发，不掉血也不产生 damage 广播', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    b.spawnProtectRemaining = 0;
    b.shield = true;
    shootAt(room, a, b);
    room.tick();

    assert.equal(b.hp, DEFAULT_MAX_HP, '护盾应挡掉整发伤害');
    assert.equal(b.shield, false, '护盾应被消耗');
    assert.equal(b.alive, true);
    assert.equal(damageMessages(sockets[0]).length, 0, '护盾挡下时不应广播 damage');
  } finally {
    room.stopTicking();
  }
});

test('维修包回 1 点且不超过上限，满血时仍会拾取但回血为 0', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a] = [...room.players.values()];
    a.hp = room.maxHp - 1;

    const item = { id: 1, type: 'repair', x: a.x, y: a.y, cellR: 0, cellC: 0 };
    room.items.push(item);
    room.itemSpawnAcc = 0; // 避免这一次 tick 额外刷新道具干扰断言
    room.tick();

    assert.equal(a.hp, room.maxHp, `维修包应回血到上限: ${a.hp}`);
    assert.equal(room.items.length, 0, '维修包应被拾取');
    const pickups = sockets[0].messages.filter((m) => m.type === 'item_pickup');
    assert.equal(pickups.length, 1);
    assert.equal(pickups[0].pickups[0].type, 'repair');
    assert.equal(pickups[0].pickups[0].heal, 1, '残血拾取应实际回复 1 点');

    // 满血时同一位置放一个维修包：依然会被拾取并消失，只是回血为 0
    a.hp = room.maxHp;
    room.items.push({ id: 2, type: 'repair', x: a.x, y: a.y, cellR: 0, cellC: 0 });
    room.tick();
    assert.equal(room.items.length, 0, '满血时维修包仍应被拾取');
    assert.equal(a.hp, room.maxHp, '满血拾取不应超过上限');
    const fullHpPickups = sockets[0].messages.filter((m) => m.type === 'item_pickup');
    assert.equal(fullHpPickups.length, 2, '满血拾取也应广播 item_pickup');
    assert.equal(fullHpPickups[1].pickups[0].heal, 0, '满血拾取的回血量应为 0');
  } finally {
    room.stopTicking();
  }
});

test('1 点血模式下不会刷新无意义的维修包', () => {
  const { room, sockets } = makeRoom(2);
  try {
    room.maxHp = 1;
    room.itemSpawnAcc = 15; // 强制触发一次道具刷新
    room.tick();

    // 道具可能正好刷在坦克脚下被当场捡走，所以把"场上剩余"和"本帧拾取"一起看
    const pickedTypes = sockets[0].messages
      .filter((m) => m.type === 'item_pickup')
      .flatMap((m) => m.pickups.map((p) => p.type));
    const types = room.items.map((it) => it.type).concat(pickedTypes);
    assert.equal(types.length, 1, '应刷新出一个道具');
    assert.notEqual(types[0], 'repair', '1 点血模式不应刷新维修包');
  } finally {
    room.stopTicking();
  }
});

test('新回合开始所有人重新满血', () => {
  const { room } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    room.maxHp = 5;
    a.hp = 1;
    b.hp = 0;
    b.alive = false;

    room.startRound();
    room.stopTicking();

    for (const p of [a, b]) {
      assert.equal(p.hp, 5, `${p.id} 新回合血量异常: ${p.hp}`);
      assert.equal(p.alive, true, `${p.id} 新回合应复活`);
    }
  } finally {
    room.stopTicking();
  }
});

test('state 广播里带每辆坦克的当前血量', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    b.hp = 1;
    room.tick();

    const state = sockets[0].messages.filter((m) => m.type === 'state').pop();
    assert.ok(state, '应有 state 广播');
    const bState = state.tanks.find((t) => t.id === b.id);
    assert.equal(bState.hp, 1, `state 里的血量异常: ${bState.hp}`);
    assert.equal(state.tanks.find((t) => t.id === a.id).hp, DEFAULT_MAX_HP);
  } finally {
    room.stopTicking();
  }
});
