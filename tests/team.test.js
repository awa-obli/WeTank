'use strict';

// 团队模式的确定性单元测试（不监听网络端口，直接驱动 Room）：
//   1. 默认模式仍是大乱斗，团队模式常量 / 队伍配置存在；
//   2. 自动分队人少优先、人数差不超过 1；手动换队、重新分队；
//   3. 跨队击杀同时累加个人击杀与团队击杀，自杀不计；
//   4. 关闭友伤：队友子弹穿过队友；追踪弹只锁敌人；
//   5. 达到目标广播 match_end（winnerTeam），同 tick 双达标判平局；
//   6. 击杀者中途离场后，余弹命中仍给原队伍记团队分；
//   7. 两队没有都分到人时不能开局；对局中某队清空能被识别；
//   8. 团队模式沿用大乱斗的 10 秒复活，复活后队伍不变。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Room,
  MODES,
  TEAMS,
  TEAM_KEYS,
  BRAWL_RESPAWN_DELAY,
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
    team: null,
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

function makeRoom(playerCount = 4) {
  const room = new Room('TEST');
  room.mode = 'team';
  room.state = 'playing';
  const sockets = [];
  for (let i = 0; i < playerCount; i++) {
    const ws = makeWs();
    sockets.push(ws);
    const p = makePlayer(`p${i + 1}`, ws);
    room.players.set(p.id, p);
  }
  // 交替分到红/蓝：p1 红、p2 蓝、p3 红、p4 蓝……
  room.ensureTeams();
  room.startRound();
  room.stopTicking(); // 测试里手动 tick，不让真实定时器参与
  for (const p of room.players.values()) p.spawnAnimRemaining = 0;
  return { room, sockets };
}

// 在 target 左侧放一颗朝它飞、下一次 tick 必定命中的子弹；team 跟射手走，
// 这样即使射手随后离场，团队分归属仍然可验证。
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

function lastState(socket) {
  return socket.messages.filter((m) => m.type === 'state').pop();
}

function killOnce(room, shooter, target) {
  target.spawnProtectRemaining = 0;
  target.shield = false;
  target.hp = 1;
  shootAt(room, shooter, target);
  room.tick();
}

test('团队模式：默认模式仍是大乱斗，队伍配置齐全', () => {
  const room = new Room('TEST');
  assert.equal(room.mode, 'brawl');
  assert.deepEqual(room.teamKills, { red: 0, blue: 0 });
  assert.equal(MODES.team.name, '团队模式');
  assert.deepEqual(TEAM_KEYS, ['red', 'blue']);
  assert.equal(TEAMS.red.name, '红队');
  assert.equal(TEAMS.blue.name, '蓝队');
});

test('自动分队：人少优先，10 人时人数差不超过 1', () => {
  const room = new Room('TEST');
  room.mode = 'team';
  const players = [];
  for (let i = 0; i < 10; i++) {
    const p = makePlayer(`p${i + 1}`, makeWs());
    room.players.set(p.id, p);
    players.push(p);
  }
  room.ensureTeams();

  const counts = room.teamCounts();
  assert.equal(counts.red + counts.blue, 10);
  assert.ok(Math.abs(counts.red - counts.blue) <= 1, `人数差过大: ${counts.red}/${counts.blue}`);
  assert.equal(counts.red, 5, '人数相同时优先红队，10 人应为 5 红 5 蓝');
  assert.equal(counts.blue, 5);
  assert.ok(players.every((p) => p.team === 'red' || p.team === 'blue'));
});

test('手动换队与重新分队：人数始终合法且差不超过 1', () => {
  const room = new Room('TEST');
  room.mode = 'team';
  for (let i = 0; i < 5; i++) {
    const p = makePlayer(`p${i + 1}`, makeWs());
    room.players.set(p.id, p);
  }
  room.ensureTeams();
  const p = [...room.players.values()][0];
  const before = p.team;

  assert.equal(room.setPlayerTeam(p, before === 'red' ? 'blue' : 'red'), true);
  assert.notEqual(p.team, before);
  assert.equal(room.setPlayerTeam(p, 'nope'), false, '非法队伍应被拒绝');
  assert.notEqual(p.team, 'nope');

  room.shuffleTeams();
  const counts = room.teamCounts();
  assert.equal(counts.red + counts.blue, 5);
  assert.ok(Math.abs(counts.red - counts.blue) <= 1);
  assert.ok([...room.players.values()].every((x) => x.team === 'red' || x.team === 'blue'));
});

test('跨队击杀：个人分 +1、团队分 +1，state 同步 team / teamKills', () => {
  const { room, sockets } = makeRoom(4);
  try {
    const [a, b] = [...room.players.values()];
    assert.equal(a.team, 'red');
    assert.equal(b.team, 'blue');
    killOnce(room, a, b);

    assert.equal(b.alive, false);
    assert.equal(b.respawnRemaining, BRAWL_RESPAWN_DELAY);
    assert.equal(a.score, 1, '个人击杀数应 +1');
    assert.equal(room.teamKills.red, 1, '红队团队分应 +1');
    assert.equal(room.teamKills.blue, 0);

    const state = lastState(sockets[0]);
    assert.ok(state, '应广播 state');
    assert.equal(state.teamKills.red, 1);
    assert.equal(state.teamKills.blue, 0);
    assert.equal(state.tanks.find((t) => t.id === a.id).team, 'red');
    assert.equal(state.tanks.find((t) => t.id === b.id).team, 'blue');
  } finally {
    room.stopTicking();
  }
});

test('关闭友伤：队友子弹穿过队友，不伤害、不消耗护盾', () => {
  const { room, sockets } = makeRoom(4);
  try {
    const [a, , c] = [...room.players.values()]; // a 红，c 红
    assert.equal(a.team, c.team);
    c.spawnProtectRemaining = 0;
    c.shield = false;
    c.hp = 1;

    shootAt(room, a, c);
    room.tick();

    assert.equal(c.alive, true, '队友不应被友军子弹击杀');
    assert.equal(c.hp, 1, '队友不应掉血');
    assert.equal(room.teamKills.red, 0, '友军命中不应产生团队分');
    assert.ok(
      room.bullets.some((b) => b.owner === a.id),
      '子弹应穿过队友继续飞行，而不是被吸收'
    );
    assert.equal(
      sockets[0].messages.filter((m) => m.type === 'damage').length,
      0,
      '不应广播友军伤害'
    );
  } finally {
    room.stopTicking();
  }
});

test('追踪弹只锁定敌人：队友更近也不拐向队友', () => {
  const { room } = makeRoom(4);
  try {
    // 去掉墙体干扰，只验证追踪目标选择。
    room.maze.rects = [];
    room.bullets = [];
    const [a, d, c, b] = [...room.players.values()]; // a/c 红，b/d 蓝
    a.x = 100; a.y = 100; a.angle = 0;
    c.x = 150; c.y = 100; c.angle = 0; // 队友更近（50px）
    b.x = 100; b.y = 300; b.angle = 0; // 敌人较远（200px）
    // 另一个蓝队敌人放在远处，避免它的随机出生点比 b 更近、抢走追踪目标，
    // 让这条用例只验证"队友更近也不追队友"。
    d.x = 900; d.y = 600; d.angle = 0;

    const cHp = c.hp;
    room.bullets.push({
      id: room.nextBulletId++,
      owner: a.id,
      team: a.team,
      x: 120,
      y: 100,
      vx: 150,
      vy: 0,
      bounces: 0,
      age: 0,
      homing: true,
    });
    room.tick();

    const bullet = room.bullets.find((x) => x.owner === a.id);
    assert.ok(bullet, '追踪弹应仍在场');
    assert.ok(bullet.vy > 0, '追踪弹应向下方的敌人转向，而不是水平追队友');
    assert.equal(c.hp, cHp, '队友不应被追踪弹命中');
  } finally {
    room.stopTicking();
  }
});

test('达到击杀目标：广播 match_end 带 winnerTeam，不广播 round_end', () => {
  const { room, sockets } = makeRoom(4);
  try {
    room.killTarget = 1;
    const [a, b] = [...room.players.values()];
    killOnce(room, a, b);

    const matchEnd = sockets[0].messages.find((m) => m.type === 'match_end');
    assert.ok(matchEnd, '达到团队目标应广播 match_end');
    assert.equal(matchEnd.winnerTeam, 'red');
    assert.equal(matchEnd.winnerId, null);
    assert.equal(matchEnd.mode, 'team');
    assert.equal(matchEnd.teamKills.red, 1);
    assert.equal(matchEnd.teamKills.blue, 0);
    assert.equal(room.state, 'lobby');
    assert.equal(
      sockets[0].messages.filter((m) => m.type === 'round_end').length,
      0,
      '团队模式不广播 round_end'
    );
  } finally {
    room.stopTicking();
  }
});

test('同一 tick 两队同时达标且总击杀相同：判平局', () => {
  const { room, sockets } = makeRoom(4);
  try {
    room.killTarget = 1;
    const [a, b, c, d] = [...room.players.values()]; // a/c 红，b/d 蓝
    b.spawnProtectRemaining = 0; b.shield = false; b.hp = 1;
    c.spawnProtectRemaining = 0; c.shield = false; c.hp = 1;
    shootAt(room, a, b); // 红队先得 1 分
    shootAt(room, d, c); // 蓝队同一 tick 也得 1 分
    room.tick();

    const matchEnd = sockets[0].messages.find((m) => m.type === 'match_end');
    assert.ok(matchEnd, '双达标应结束整场');
    assert.equal(matchEnd.winnerTeam, null);
    assert.equal(matchEnd.reason, 'draw');
    assert.equal(matchEnd.teamKills.red, 1);
    assert.equal(matchEnd.teamKills.blue, 1);
    assert.equal(room.state, 'lobby');
  } finally {
    room.stopTicking();
  }
});

test('跳弹打死自己：个人分与团队分都不增加', () => {
  const { room } = makeRoom(4);
  try {
    const [a] = [...room.players.values()];
    a.spawnProtectRemaining = 0;
    a.shield = false;
    a.hp = 1;
    shootAt(room, a, a);
    room.tick();

    assert.equal(a.alive, false, '自己打死自己仍然会阵亡');
    assert.equal(a.score, 0, '自杀不应增加个人击杀');
    assert.equal(room.teamKills.red, 0, '自杀不应增加团队分');
  } finally {
    room.stopTicking();
  }
});

test('击杀者中途离场：余弹命中仍给原队伍记团队分', () => {
  const { room } = makeRoom(4);
  try {
    const [a, b] = [...room.players.values()];
    b.spawnProtectRemaining = 0;
    b.shield = false;
    b.hp = 1;
    shootAt(room, a, b);
    // 射手离场，但子弹还在场上；团队分应归子弹上记录的队伍。
    room.players.delete(a.id);
    room.tick();

    assert.equal(b.alive, false, '余弹应正常击杀目标');
    assert.equal(room.teamKills.red, 1, '离场者的余弹仍应给红队记分');
  } finally {
    room.stopTicking();
  }
});

test('两队没有都分到人时不能开局', () => {
  const room = new Room('TEST');
  try {
    room.mode = 'team';
    const a = makePlayer('a', makeWs());
    const b = makePlayer('b', makeWs());
    room.players.set(a.id, a);
    room.players.set(b.id, b);
    room.setPlayerTeam(a, 'red');
    room.setPlayerTeam(b, 'red');

    assert.equal(room.startMatch(), false);
    assert.equal(room.state, 'lobby');
    assert.equal(room.teamKills.red, 0);

    room.setPlayerTeam(b, 'blue');
    assert.equal(room.startMatch(), true);
    assert.equal(room.state, 'playing');
  } finally {
    room.stopTicking();
  }
});

test('对局中某队清空：teamDepleted 返回 true', () => {
  const { room } = makeRoom(4);
  try {
    assert.equal(room.teamDepleted(), false);
    const players = [...room.players.values()];
    // 移除所有蓝队玩家，红队还剩 2 人（总人数 >= 2）
    for (const p of players) {
      if (p.team === 'blue') room.players.delete(p.id);
    }
    assert.equal(room.players.size, 2);
    assert.equal(room.teamDepleted(), true);

    room.state = 'lobby';
    assert.equal(room.teamDepleted(), false, '大厅里不触发清队结束');
  } finally {
    room.stopTicking();
  }
});

test('团队模式沿用 10 秒复活，复活后队伍不变', () => {
  const { room } = makeRoom(2);
  try {
    const [a, b] = [...room.players.values()];
    killOnce(room, a, b);
    assert.equal(b.alive, false);
    assert.equal(b.team, 'blue');

    for (let i = 0; i < RESPAWN_TICKS; i++) room.tick();
    assert.equal(b.alive, true, '10 秒后应复活');
    assert.equal(b.team, 'blue', '复活后应保留原队伍');
    assert.equal(room.teamKills.red, 1, '团队分不会因为复活而回退');
  } finally {
    room.stopTicking();
  }
});
