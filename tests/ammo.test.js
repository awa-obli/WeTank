'use strict';

// 弹药机制的确定性单元测试（不监听端口，直接驱动 Room）：
//   1. 开局满弹、常量与规则一致；
//   2. 开火消耗 1 发，并广播私有 ammo 消息；
//   3. 0 弹时开火无效：不出弹、不解除出生保护；
//   4. 每 5 秒自动补 1 发，上限 5 发，满弹不囤积进度；
//   5. 阵亡后停止回复；
//   6. 三连发一次打出 3 颗子弹，只消耗 1 发弹药；0 弹时打不出去且道具保持就绪；
//   7. 弹药只私发给本人，公共 state 里不带弹药字段；
//   8. 新回合重新满弹；
//   9. 弹药箱：拾取后补满、满弹仍会拾取、补充量只私发本人。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Room,
  AMMO_MAX,
  AMMO_REGEN_INTERVAL,
  AMMO_REFILL,
  ITEM_TYPES,
} = require('../server');

const DT = 1 / 30;

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
    ammo: AMMO_MAX,
    ammoReloadAcc: 0,
  };
}

function makeRoom(playerCount) {
  const room = new Room('TEST');
  // 弹药机制本身两模式通用，但这里沿用经典模式跑，避免阵亡后复活干扰用例。
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
  room.stopTicking(); // 测试里手动 tick，不让真实定时器参与
  // 这里关注的是实体出现之后的弹药机制，直接跳过开局的 1 秒重生动画
  for (const p of room.players.values()) p.spawnAnimRemaining = 0;
  return { room, sockets };
}

function lastAmmoMsg(socket) {
  return socket.messages.filter((m) => m.type === 'ammo').pop();
}

// 让玩家立刻可开火：测试只关心弹药，不关心冷却
function readyToShoot(p) {
  p.cooldown = 0;
  p.input.shoot = true;
}

test('弹药常量与开局满弹', () => {
  assert.equal(AMMO_MAX, 5);
  assert.equal(AMMO_REGEN_INTERVAL, 5);

  const { room } = makeRoom(3);
  try {
    for (const p of room.players.values()) {
      assert.equal(p.ammo, AMMO_MAX, `${p.id} 开局弹药异常: ${p.ammo}`);
      assert.equal(p.ammoReloadAcc, 0, `${p.id} 开局装填进度应为 0`);
    }
  } finally {
    room.stopTicking();
  }
});

test('开火消耗 1 发，并收到只属于自己的 ammo 消息', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    readyToShoot(a);
    room.tick();

    assert.equal(a.ammo, AMMO_MAX - 1, `开火后弹药异常: ${a.ammo}`);
    assert.equal(b.ammo, AMMO_MAX, '没开火的人不应掉弹药');
    assert.equal(room.bullets.length, 1, '应打出一发子弹');
    assert.equal(a.spawnProtectRemaining, 0, '真正开火才解除出生保护');

    const ammoA = lastAmmoMsg(sockets[0]);
    assert.ok(ammoA, '应收到 ammo 消息');
    assert.equal(ammoA.ammo, AMMO_MAX - 1);
    assert.equal(ammoA.max, AMMO_MAX);
    assert.equal(lastAmmoMsg(sockets[1]).ammo, AMMO_MAX, '另一个人只应看到自己的弹药');
  } finally {
    room.stopTicking();
  }
});

test('0 弹时开火无效：不出子弹、不解除出生保护', () => {
  const { room } = makeRoom(2);
  try {
    const [a] = [...room.players.values()];
    a.ammo = 0;
    a.ammoReloadAcc = 0;
    readyToShoot(a);
    const beforeBulletId = room.nextBulletId;

    room.tick();

    assert.equal(room.nextBulletId, beforeBulletId, '空弹不应产生子弹');
    assert.equal(a.ammo, 0);
    assert.ok(a.spawnProtectRemaining > 2.9, '空弹扣扳机不应提前解除出生保护');
  } finally {
    room.stopTicking();
  }
});

test('每 5 秒自动补 1 发（第 150 tick 准时到账）', () => {
  const { room } = makeRoom(2);
  try {
    const [a] = [...room.players.values()];
    a.ammo = 3;
    a.ammoReloadAcc = 0;

    for (let i = 0; i < 149; i++) room.tick(); // 4.9667 秒
    assert.equal(a.ammo, 3, '不满 5 秒不应补弹');

    room.tick(); // 第 150 tick = 5 秒
    assert.equal(a.ammo, 4, '满 5 秒应补 1 发');
    assert.ok(a.ammoReloadAcc < 0.05, `补弹后进度应清零: ${a.ammoReloadAcc}`);
  } finally {
    room.stopTicking();
  }
});

test('弹药上限 5 发，满弹时进度归零、不囤积', () => {
  const { room } = makeRoom(2);
  try {
    const [a] = [...room.players.values()];
    a.ammo = AMMO_MAX;
    a.ammoReloadAcc = 0;

    for (let i = 0; i < 300; i++) room.tick(); // 10 秒
    assert.equal(a.ammo, AMMO_MAX, '弹药不应超过上限');
    assert.equal(a.ammoReloadAcc, 0, '满弹时不应囤积装填进度');

    // 满弹挂机后开一枪：进度从 0 重新算，下一发要等满 5 秒
    readyToShoot(a);
    room.tick();
    assert.equal(a.ammo, AMMO_MAX - 1);
    assert.equal(a.ammoReloadAcc, 0, '开枪不应继承满弹时的"白送"进度');
    a.input.shoot = false;

    for (let i = 0; i < 149; i++) room.tick();
    assert.equal(a.ammo, AMMO_MAX - 1, '开枪后不满 5 秒不应补弹');
    room.tick();
    assert.equal(a.ammo, AMMO_MAX, '满 5 秒后应补回 1 发');
  } finally {
    room.stopTicking();
  }
});

test('阵亡后停止回复弹药', () => {
  const { room } = makeRoom(3);
  try {
    const [a, b, c] = [...room.players.values()];
    a.spawnProtectRemaining = 0;
    b.spawnProtectRemaining = 0;
    c.alive = false;
    c.ammo = 2;
    c.ammoReloadAcc = 0;

    for (let i = 0; i < 150; i++) room.tick();
    assert.equal(c.ammo, 2, '阵亡后不应继续补弹');
    assert.equal(a.ammo, AMMO_MAX, '存活玩家满弹时保持上限');
  } finally {
    room.stopTicking();
  }
});

test('三连发一次打出 3 颗子弹，只消耗 1 发弹药；0 弹时打不出去、道具保持就绪', () => {
  const { room } = makeRoom(2);
  try {
    const [a] = [...room.players.values()];
    a.spawnProtectRemaining = 0;

    // 5 发满弹 + 三连发：一次打 3 颗子弹，只扣 1 发
    a.ammo = 5;
    a.tripleReady = true;
    readyToShoot(a);
    const beforeTripleId = room.nextBulletId;
    room.tick();

    assert.equal(a.ammo, 4, `三连发后弹药应为 4: ${a.ammo}`);
    assert.equal(room.nextBulletId - beforeTripleId, 3, '三连发应打出 3 颗子弹');
    assert.equal(a.tripleReady, false, '三连发道具应被消耗');

    // 只有 1 发时也能打出三连发，打完变 0
    a.ammo = 1;
    a.tripleReady = true;
    readyToShoot(a);
    const beforeLastId = room.nextBulletId;
    room.tick();

    assert.equal(a.ammo, 0, '1 发弹药应足够打出三连发');
    assert.equal(room.nextBulletId - beforeLastId, 3);
    assert.equal(a.tripleReady, false);

    // 0 弹时整发打不出去，道具保持就绪
    a.ammo = 0;
    a.tripleReady = true;
    readyToShoot(a);
    const beforeBlockedId = room.nextBulletId;
    room.tick();

    assert.equal(room.nextBulletId, beforeBlockedId, '0 弹时不应出弹');
    assert.equal(a.ammo, 0, '打不出去时不应扣弹药');
    assert.equal(a.tripleReady, true, '三连发道具应保持就绪，等装填够了再用');
  } finally {
    room.stopTicking();
  }
});

test('弹药只私发给本人，公共 state 里不带弹药字段', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    a.ammo = 2;
    b.ammo = 4;
    a.ammoReloadAcc = 2.5;
    room.tick();

    assert.equal(lastAmmoMsg(sockets[0]).ammo, 2, 'A 只应看到自己的 2 发');
    assert.equal(lastAmmoMsg(sockets[1]).ammo, 4, 'B 只应看到自己的 4 发');
    // 装填进度：2.5s + 1 tick 后约 0.51
    assert.ok(Math.abs(lastAmmoMsg(sockets[0]).reload - 0.51) < 0.02,
      `装填进度异常: ${lastAmmoMsg(sockets[0]).reload}`);

    const state = sockets[0].messages.filter((m) => m.type === 'state').pop();
    assert.ok(state, '应有 state 广播');
    for (const t of state.tanks) {
      assert.ok(!Object.prototype.hasOwnProperty.call(t, 'ammo'), `state 不应携带 ${t.id} 的弹药`);
      assert.ok(!Object.prototype.hasOwnProperty.call(t, 'ammoReloadAcc'), 'state 不应携带装填进度');
    }
  } finally {
    room.stopTicking();
  }
});

test('新回合重新满弹', () => {
  const { room } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    a.ammo = 1;
    a.ammoReloadAcc = 3;
    b.ammo = 0;

    room.startRound();
    room.stopTicking();

    for (const p of [a, b]) {
      assert.equal(p.ammo, AMMO_MAX, `${p.id} 新回合弹药异常: ${p.ammo}`);
      assert.equal(p.ammoReloadAcc, 0);
    }
  } finally {
    room.stopTicking();
  }
});

test('装填进度：满弹时 ammo 消息里的 reload 为 0', () => {
  const { room, sockets } = makeRoom(2);
  try {
    room.tick();
    assert.equal(lastAmmoMsg(sockets[0]).reload, 0);
  } finally {
    room.stopTicking();
  }
});

test('道具池包含弹药箱，补充常量与上限一致', () => {
  assert.ok(ITEM_TYPES.includes('ammo'), '道具池里应该有弹药箱');
  assert.equal(AMMO_REFILL, AMMO_MAX, '弹药箱应一次补满');
});

test('弹药箱：拾取后补满，补充量只私发本人且公共广播不泄露', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    a.ammo = 2;
    a.ammoReloadAcc = 2.4;
    b.ammo = 4;

    room.items.push({ id: 1, type: 'ammo', x: a.x, y: a.y, cellR: 0, cellC: 0 });
    room.itemSpawnAcc = 0; // 避免这一次 tick 额外刷新道具干扰断言
    room.tick();

    assert.equal(a.ammo, AMMO_MAX, '弹药箱应直接把弹药补满');
    assert.equal(a.ammoReloadAcc, 0, '补满后装填进度应归零');
    assert.equal(room.items.length, 0, '弹药箱应被拾取');

    const pickup = sockets[0].messages.filter((m) => m.type === 'item_pickup').pop();
    assert.ok(pickup, '应广播道具拾取');
    assert.equal(pickup.pickups[0].type, 'ammo');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(pickup.pickups[0], 'pickup'),
      '公共 item_pickup 不应携带补充量'
    );

    const ammoA = lastAmmoMsg(sockets[0]);
    assert.equal(ammoA.ammo, AMMO_MAX, '本人应看到补满后的弹药');
    assert.equal(ammoA.pickup, 3, '本人应收到本次实际补充量 3');

    const ammoB = lastAmmoMsg(sockets[1]);
    assert.equal(ammoB.ammo, 4, '其他人弹药不应变化');
    assert.equal(ammoB.pickup, 0, '其他人不应收到别人的补充量');

    // 4 发时再捡一个：只补 1 发，不超过上限
    room.items.push({ id: 2, type: 'ammo', x: b.x, y: b.y, cellR: 0, cellC: 0 });
    room.tick();
    assert.equal(b.ammo, AMMO_MAX, '4 发时拾取应补到上限');
    assert.equal(lastAmmoMsg(sockets[1]).pickup, 1, '实际只补充了 1 发');
  } finally {
    room.stopTicking();
  }
});

test('弹药箱：满弹时仍会拾取并消失，实际补充为 0', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a] = [...room.players.values()];
    a.ammo = AMMO_MAX;

    room.items.push({ id: 1, type: 'ammo', x: a.x, y: a.y, cellR: 0, cellC: 0 });
    room.itemSpawnAcc = 0;
    room.tick();

    assert.equal(room.items.length, 0, '满弹时弹药箱仍应被拾取');
    assert.equal(a.ammo, AMMO_MAX, '满弹拾取不应超过上限');

    const pickup = sockets[0].messages.filter((m) => m.type === 'item_pickup').pop();
    assert.equal(pickup.pickups[0].type, 'ammo', '满弹拾取也应广播 item_pickup');
    assert.equal(lastAmmoMsg(sockets[0]).pickup, 0, '满弹时实际补充量应为 0');
  } finally {
    room.stopTicking();
  }
});
