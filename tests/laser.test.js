'use strict';

// 激光道具的确定性单元测试（不监听端口，直接驱动 Room / 纯几何函数）：
//   1. 道具池包含 laser；拾取后进入 laserReady，并清掉三连发/追踪弹；
//   2. 开火消耗 1 发弹药、不产生实体子弹；
//   3. 弹药不足时整发打不出去，道具保持就绪；
//   4. 固定总长度：无墙时终点距离 = LASER_LENGTH；有墙时按面法线镜面反射；
//   5. 穿透：路径上的每个敌人各掉 1 点血，同一条激光来回穿过同一敌人只掉一次；
//   6. 反弹回来可以打到自己（直射第一段不会误伤）；团队模式穿过队友；
//   7. 护盾抵消本次伤害后射线继续；出生保护吸收本次伤害后射线继续；
//   8. 击杀归属/计分沿用子弹逻辑；state 里同步 laserReady；
//   9. 激光预览只私发给本人，路径与实际发射一致，开火后清空；
//   10. 新回合/复活重置 laserReady。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Room,
  ITEM_TYPES,
  AMMO_MAX,
  TANK_RADIUS,
  LASER_LENGTH,
} = require('../server');
const {
  LASER_HALF_WIDTH,
  traceLaserPath,
  collectLaserHits,
} = require('../laser');

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

// 默认造一个无内墙的空地房间；具体位置由各用例自己摆。
function makeRoom(playerCount = 3, mode = 'brawl') {
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
  room.maze.rects = [];
  room.items = [];
  for (const p of room.players.values()) {
    // 跳过开局的凝聚动画和出生保护，直接进入可受击状态
    p.spawnAnimRemaining = 0;
    p.spawnProtectRemaining = 0;
    p.hp = room.maxHp;
    p.ammo = AMMO_MAX;
    p.cooldown = 0;
  }
  return { room, sockets };
}

function place(p, x, y, angle = 0) {
  p.x = x;
  p.y = y;
  p.angle = angle;
}

function messagesOf(socket, type) {
  return socket.messages.filter((m) => m.type === type);
}

function lastState(socket) {
  return messagesOf(socket, 'state').pop();
}

function readyToFireLaser(p) {
  p.laserReady = true;
  p.cooldown = 0;
  p.input.shoot = true;
}

test('道具池包含 laser，常量与导出可用', () => {
  assert.ok(ITEM_TYPES.includes('laser'), '道具池里应该有激光');
  assert.equal(LASER_LENGTH, 480);
  assert.equal(LASER_HALF_WIDTH, 2);
});

test('射线无墙时走满固定长度；有墙时按面法线镜面反射', () => {
  const straight = traceLaserPath(100, 100, 0, [], { length: 480 });
  assert.equal(straight.bounces, 0);
  assert.equal(straight.points.length, 2);
  assert.equal(straight.points[1].x, 580);
  assert.equal(straight.points[1].y, 100);

  const wall = { cx: 300, cy: 100, hw: 5, hh: 100, angle: 0 };
  const bounced = traceLaserPath(100, 100, 0, [wall], { length: 480 });
  assert.equal(bounced.bounces, 1, '应该恰好反弹一次');
  assert.equal(bounced.points.length, 3);
  // 从 100 向右走到墙面附近（约 294.5），再反射回来，总路程仍是 480
  assert.ok(bounced.points[1].x < 300 && bounced.points[1].x > 290);
  assert.ok(bounced.points[2].x < bounced.points[1].x, '反射后应该朝左走');
  const total = bounced.points.slice(1).reduce((sum, pt, i) => (
    sum + Math.hypot(pt.x - bounced.points[i].x, pt.y - bounced.points[i].y)
  ), 0);
  assert.ok(Math.abs(total - 480) < 0.2, `总路程应接近 480，实际 ${total}`);
});

test('命中收集：第一段不误伤射手，队友穿透，按距离排序', () => {
  // 起点 112 是炮口，射手在 100（起点身后 12px，仍在判定圈内）：
  // 第一段朝右飞，不应该在刚出膛时判定自伤。
  const points = [{ x: 112, y: 100 }, { x: 500, y: 100 }];
  const tanks = [
    { id: 'self', x: 100, y: 100, alive: true, spawnAnimRemaining: 0, team: 'red' },
    { id: 'mate', x: 220, y: 100, alive: true, spawnAnimRemaining: 0, team: 'red' },
    { id: 'enemy1', x: 300, y: 100, alive: true, spawnAnimRemaining: 0, team: 'blue' },
    { id: 'enemy2', x: 420, y: 100, alive: true, spawnAnimRemaining: 0, team: 'blue' },
    { id: 'off', x: 300, y: 200, alive: true, spawnAnimRemaining: 0, team: 'blue' },
  ];
  const hits = collectLaserHits(points, tanks, {
    ownerId: 'self',
    ownerTeam: 'red',
    teamMode: true,
    hitRadius: TANK_RADIUS + LASER_HALF_WIDTH,
  });
  assert.deepEqual(hits.map((h) => h.playerId), ['enemy1', 'enemy2']);
  assert.ok(hits[0].dist < hits[1].dist);
});

test('命中收集：反弹后的路径可以命中射手自己', () => {
  // 炮口 112 → 墙面 294.45 → 反射回 8.95，第二段会穿过站在 100 的射手。
  const points = [{ x: 112, y: 100 }, { x: 294.45, y: 100 }, { x: 8.95, y: 100 }];
  const tanks = [
    { id: 'self', x: 100, y: 100, alive: true, spawnAnimRemaining: 0, team: 'red' },
  ];
  const hits = collectLaserHits(points, tanks, {
    ownerId: 'self',
    ownerTeam: 'red',
    teamMode: true,
    hitRadius: TANK_RADIUS + LASER_HALF_WIDTH,
  });
  assert.deepEqual(hits.map((h) => h.playerId), ['self']);
});

test('拾取激光：laserReady 生效，三连发/追踪弹被清掉', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a] = [...room.players.values()];
    place(a, 100, 100);
    a.tripleReady = true;
    a.homingReady = true;
    room.items = [{ id: 1, type: 'laser', x: a.x, y: a.y, cellR: 0, cellC: 0 }];

    room.tick();

    assert.equal(a.laserReady, true);
    assert.equal(a.tripleReady, false);
    assert.equal(a.homingReady, false);
    assert.equal(room.items.length, 0, '道具应被拾取');
    const pickup = messagesOf(sockets[0], 'item_pickup').pop();
    assert.ok(pickup && pickup.pickups.some((p) => p.type === 'laser'), '应广播激光拾取');
    assert.equal(lastState(sockets[0]).tanks.find((t) => t.id === a.id).laserReady, true);
  } finally {
    room.stopTicking();
  }
});

test('开火：消耗 1 发弹药、不产生实体子弹，命中路径上的所有敌人各 1 点', () => {
  const { room, sockets } = makeRoom(3);
  try {
    const [a, b, c] = [...room.players.values()];
    place(a, 100, 100);
    place(b, 300, 100);
    place(c, 400, 100);
    a.ammo = 3;
    readyToFireLaser(a);

    room.tick();

    assert.equal(a.ammo, 2, '激光应按普通射击消耗 1 发弹药');
    assert.equal(a.laserReady, false, '道具应被消耗');
    assert.equal(room.bullets.length, 0, '激光不应产生实体子弹');
    assert.equal(room.nextBulletId, 1, '不应分配子弹 id');
    assert.equal(b.hp, room.maxHp - 1);
    assert.equal(c.hp, room.maxHp - 1);
    assert.equal(a.hp, room.maxHp, '直射空地不会打到自己');

    const laser = messagesOf(sockets[0], 'laser').pop();
    assert.ok(laser, '应广播 laser 光束事件');
    assert.equal(laser.ownerId, a.id);
    assert.equal(laser.hits.length, 2);
    assert.ok(laser.points.length >= 2);
    // 起点在炮口前方，而不是坦克圆心
    assert.ok(laser.points[0].x > a.x);

    const damage = messagesOf(sockets[0], 'damage').pop();
    assert.ok(damage && damage.hits.length === 2);
    assert.deepEqual(damage.hits.map((h) => h.playerId).sort(), [b.id, c.id].sort());
  } finally {
    room.stopTicking();
  }
});

test('激光预览：只私发给本人，路径与实际发射一致，开火后清空', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    place(a, 100, 100);
    place(b, 300, 100);
    a.laserReady = true;
    a.ammo = 5;

    room.tick(); // 只瞄准、不开火

    const previewMsg = messagesOf(sockets[0], 'ammo').pop();
    assert.ok(Array.isArray(previewMsg.laserPreview), '本人应收到激光预览');
    assert.ok(previewMsg.laserPreview.length >= 2);
    assert.ok(Math.abs(previewMsg.laserPreview[0].x - (a.x + 12)) < 0.1, '预览应从炮口出发');
    assert.equal(messagesOf(sockets[1], 'ammo').pop().laserPreview, null, '其他玩家不应收到别人的预览');

    // 同一位置/朝向下开火，实际路径应该和预览完全一致
    a.input.shoot = true;
    room.tick();
    const laser = messagesOf(sockets[0], 'laser').pop();
    assert.deepEqual(laser.points, previewMsg.laserPreview, '预览路径应与实际发射路径一致');
    assert.equal(messagesOf(sockets[0], 'ammo').pop().laserPreview, null, '开火后预览应清空');
  } finally {
    room.stopTicking();
  }
});

test('弹药不足时激光打不出去，道具保持就绪', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    place(a, 100, 100);
    place(b, 300, 100);
    a.ammo = 0;
    readyToFireLaser(a);

    room.tick();

    assert.equal(a.ammo, 0);
    assert.equal(a.laserReady, true, '弹药不足时道具应保持就绪');
    assert.equal(messagesOf(sockets[0], 'laser').length, 0);
    assert.equal(b.hp, room.maxHp);

    // 补 1 发后同一帧就能打出去
    a.ammo = 1;
    room.tick();
    assert.equal(a.ammo, 0);
    assert.equal(a.laserReady, false);
    assert.equal(messagesOf(sockets[0], 'laser').length, 1);
  } finally {
    room.stopTicking();
  }
});

test('同一条激光来回穿过同一敌人，只掉 1 点血；终点长度仍固定', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    place(a, 100, 100);
    place(b, 300, 100);
    // 右侧一面竖墙，让射线打中 b 后反射回来再次穿过 b
    room.maze.rects = [{ cx: 400, cy: 100, hw: 5, hh: 200, angle: 0 }];
    a.ammo = 5;
    readyToFireLaser(a);

    room.tick();

    assert.equal(b.hp, room.maxHp - 1, '同一敌人一条激光只应掉一次血');
    assert.equal(b.alive, true);
    const laser = messagesOf(sockets[0], 'laser').pop();
    assert.ok(laser.points.length === 3, `应有一次反弹，实际点数 ${laser.points.length}`);
    const total = laser.points.slice(1).reduce((sum, pt, i) => (
      sum + Math.hypot(pt.x - laser.points[i].x, pt.y - laser.points[i].y)
    ), 0);
    assert.ok(Math.abs(total - LASER_LENGTH) < 0.2, `总路程应接近 ${LASER_LENGTH}，实际 ${total}`);
  } finally {
    room.stopTicking();
  }
});

test('射线反弹回来可以打到自己', () => {
  const { room, sockets } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    place(a, 200, 100);
    place(b, 600, 300); // 不在射线上
    // 正前方一面竖墙：射线打墙后原路返回，会穿过站在 200 的射手自己
    room.maze.rects = [{ cx: 300, cy: 100, hw: 5, hh: 200, angle: 0 }];
    a.ammo = 5;
    readyToFireLaser(a);

    room.tick();

    assert.equal(a.hp, room.maxHp - 1, '反弹回来应该打到自己');
    assert.equal(a.alive, true);
    assert.equal(b.hp, room.maxHp, '不在路径上的玩家不应掉血');
    const damage = messagesOf(sockets[0], 'damage').pop();
    assert.ok(damage && damage.hits.some((h) => h.playerId === a.id && h.by === a.id));
    const laser = messagesOf(sockets[0], 'laser').pop();
    assert.ok(laser.hits.some((h) => h.playerId === a.id), '激光事件里也应包含自己');
  } finally {
    room.stopTicking();
  }
});

test('激光自杀不计分，只进入复活倒计时', () => {
  const { room } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    place(a, 200, 100);
    place(b, 600, 300);
    room.maze.rects = [{ cx: 300, cy: 100, hw: 5, hh: 200, angle: 0 }];
    a.hp = 1;
    a.ammo = 5;
    readyToFireLaser(a);

    room.tick();

    assert.equal(a.alive, false, '1 血时反弹回来应被自己打死');
    assert.equal(a.score, 0, '自杀不应加击杀分');
    assert.equal(a.respawnRemaining, 10, '大乱斗自杀也应进入 10 秒复活倒计时');
    assert.equal(room.teamKills.red, 0);
    assert.equal(room.teamKills.blue, 0);
  } finally {
    room.stopTicking();
  }
});

test('护盾挡下激光伤害并破碎，射线继续命中后面的敌人', () => {
  const { room, sockets } = makeRoom(3);
  try {
    const [a, b, c] = [...room.players.values()];
    place(a, 100, 100);
    place(b, 300, 100);
    place(c, 400, 100);
    b.shield = true;
    a.ammo = 5;
    readyToFireLaser(a);

    room.tick();

    assert.equal(b.hp, room.maxHp, '护盾应完全免疫这次伤害');
    assert.equal(b.shield, false, '护盾应被消耗');
    assert.equal(c.hp, room.maxHp - 1, '射线应继续飞向后面的敌人');
    const damage = messagesOf(sockets[0], 'damage').pop();
    assert.deepEqual(damage.hits.map((h) => h.playerId), [c.id]);
  } finally {
    room.stopTicking();
  }
});

test('出生保护吸收激光伤害，射线继续命中后面的敌人', () => {
  const { room, sockets } = makeRoom(3);
  try {
    const [a, b, c] = [...room.players.values()];
    place(a, 100, 100);
    place(b, 300, 100);
    place(c, 400, 100);
    b.spawnProtectRemaining = 2;
    a.ammo = 5;
    readyToFireLaser(a);

    room.tick();

    assert.equal(b.hp, room.maxHp, '出生保护应吸收伤害');
    assert.equal(c.hp, room.maxHp - 1, '射线应继续飞向后面的敌人');
    const block = messagesOf(sockets[0], 'spawn_block').pop();
    assert.ok(block && block.blocks.some((x) => x.ownerId === b.id), '应有格挡广播');
    const damage = messagesOf(sockets[0], 'damage').pop();
    assert.deepEqual(damage.hits.map((h) => h.playerId), [c.id]);
  } finally {
    room.stopTicking();
  }
});

test('团队模式：激光穿过队友、不造成友伤', () => {
  const { room } = makeRoom(3, 'team');
  try {
    const [a, b, c] = [...room.players.values()];
    a.team = 'red';
    b.team = 'red';
    c.team = 'blue';
    place(a, 100, 100);
    place(b, 300, 100);
    place(c, 400, 100);
    a.ammo = 5;
    readyToFireLaser(a);

    room.tick();

    assert.equal(b.hp, room.maxHp, '队友不应掉血');
    assert.equal(c.hp, room.maxHp - 1, '敌人应掉血');
  } finally {
    room.stopTicking();
  }
});

test('激光击杀：沿用子弹的击杀分与复活倒计时', () => {
  const { room } = makeRoom(3);
  try {
    const [a, b, c] = [...room.players.values()];
    place(a, 100, 100);
    place(b, 300, 100);
    place(c, 100, 500); // 不在这条射线上
    b.hp = 1;
    a.ammo = 5;
    readyToFireLaser(a);

    room.tick();

    assert.equal(b.alive, false);
    assert.equal(b.hp, 0);
    assert.equal(b.respawnRemaining, 10, '大乱斗击杀应开始 10 秒复活倒计时');
    assert.equal(a.score, 1, '击杀者应加 1 分');
    const damage = messagesOf(a.ws, 'damage').pop();
    assert.equal(damage.hits[0].dead, true);
    assert.equal(damage.hits[0].by, a.id);
  } finally {
    room.stopTicking();
  }
});

test('新回合与复活都会清掉 laserReady', () => {
  const { room } = makeRoom(2);
  try {
    const [a] = [...room.players.values()];
    a.laserReady = true;
    room.startRound();
    room.stopTicking();
    assert.equal(a.laserReady, false, '新回合应清空激光就绪');

    a.laserReady = true;
    room.respawnPlayer(a);
    assert.equal(a.laserReady, false, '复活应清空激光就绪');
  } finally {
    room.stopTicking();
  }
});
