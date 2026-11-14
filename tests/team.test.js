'use strict';

// 团队对抗开关的确定性单元测试（不监听网络端口，直接驱动 Room）：
//   1. 默认关闭；团队对抗不再是独立模式，四个模式都能开；
//   2. 开关自动分队、关闭清队；换队/重新分队只在开启时可用；
//   3. 大乱斗：跨队击杀累计团队分，友伤关闭，目标达成/双达标平局；
//   4. 占点：同队多人合力推进同一份进度，敌我同圈冻结，换队清退；
//   5. 收集：钻石计入团队总分，阵亡掉一半并扣团队分；
//   6. 经典：淘汰对方全队赢回合，双方全灭平局，队伍胜场达标结束整场；
//   7. 开局要求红蓝两队都有人；关闭开关后恢复普通个人模式。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Room,
  MODES,
  TEAMS,
  TEAM_KEYS,
  BRAWL_RESPAWN_DELAY,
  AMMO_MAX,
  CAPTURE_RADIUS,
  CAPTURE_TIME,
  DECAY_NEUTRALIZE_TIME,
} = require('../server');

const TICK = 1 / 30;
const RESPAWN_TICKS = Math.round(BRAWL_RESPAWN_DELAY / TICK); // 10 秒 = 300 tick
const CAPTURE_TICKS = Math.round(CAPTURE_TIME / TICK); // 10 秒 = 300 tick
const NEUTRALIZE_TICKS = Math.round(DECAY_NEUTRALIZE_TIME / TICK); // 5 秒 = 150 tick

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

// teamMode=true 时按红蓝交替分队：p1 红、p2 蓝、p3 红、p4 蓝……
function makeRoom(playerCount = 4, mode = 'brawl', { teamMode = true } = {}) {
  const room = new Room('TEST');
  room.mode = mode;
  room.teamMode = teamMode;
  room.state = 'playing';
  const sockets = [];
  for (let i = 0; i < playerCount; i++) {
    const ws = makeWs();
    sockets.push(ws);
    const p = makePlayer(`p${i + 1}`, ws);
    room.players.set(p.id, p);
  }
  if (teamMode) room.ensureTeams();
  room.startRound();
  room.stopTicking(); // 测试里手动 tick，不让真实定时器参与
  for (const p of room.players.values()) {
    p.spawnAnimRemaining = 0;
    p.spawnProtectRemaining = 0;
  }
  return { room, sockets };
}

// 在 target 左侧放一颗朝它飞、下一次 tick 必定命中的子弹；team 跟射手走。
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
  target.shield = false;
  target.hp = 1;
  shootAt(room, shooter, target);
  room.tick();
}

function lastState(socket) {
  return socket.messages.filter((m) => m.type === 'state').pop();
}

test('默认关闭团队对抗，团队模式已从模式列表移除', () => {
  const room = new Room('TEST');
  assert.equal(room.mode, 'brawl');
  assert.equal(room.teamMode, false);
  assert.deepEqual(Object.keys(MODES).sort(), ['brawl', 'capture', 'classic', 'collect']);
  assert.deepEqual(TEAM_KEYS, ['red', 'blue']);
  assert.equal(TEAMS.red.name, '红队');
  assert.deepEqual(room.teamKills, { red: 0, blue: 0 });
  assert.deepEqual(room.teamCaptures, { red: 0, blue: 0 });
  assert.deepEqual(room.teamDiamonds, { red: 0, blue: 0 });
  assert.deepEqual(room.teamWins, { red: 0, blue: 0 });
});

test('开关：开启自动分队、关闭清空队伍；换队/重新分队只在开启时可用', () => {
  const room = new Room('TEST');
  const players = [];
  for (let i = 0; i < 10; i++) {
    const p = makePlayer(`p${i + 1}`, makeWs());
    room.players.set(p.id, p);
    players.push(p);
  }

  assert.equal(room.setTeamMode(true), true);
  const counts = room.teamCounts();
  assert.equal(counts.red + counts.blue, 10);
  assert.equal(counts.red, 5, '人数相同时优先红队，10 人应为 5 红 5 蓝');
  assert.equal(counts.blue, 5);
  assert.ok(players.every((p) => p.team === 'red' || p.team === 'blue'));

  const p = players[0];
  const before = p.team;
  assert.equal(room.setPlayerTeam(p, before === 'red' ? 'blue' : 'red'), true);
  assert.notEqual(p.team, before);
  assert.equal(room.setPlayerTeam(p, 'nope'), false, '非法队伍应被拒绝');
  room.shuffleTeams();
  const shuffled = room.teamCounts();
  assert.equal(shuffled.red + shuffled.blue, 10);
  assert.ok(Math.abs(shuffled.red - shuffled.blue) <= 1);

  assert.equal(room.setTeamMode(false), true);
  assert.ok(players.every((x) => x.team === null), '关闭后应清空所有队伍');
  assert.equal(room.setPlayerTeam(p, 'red'), false, '关闭时不能换队');
  room.shuffleTeams();
  assert.ok(players.every((x) => x.team === null), '关闭时重新分队不应生效');
});

test('开局：团队对抗要求红蓝两队都有人', () => {
  const room = new Room('TEST');
  try {
    room.teamMode = true;
    const a = makePlayer('a', makeWs());
    const b = makePlayer('b', makeWs());
    room.players.set(a.id, a);
    room.players.set(b.id, b);
    room.setPlayerTeam(a, 'red');
    room.setPlayerTeam(b, 'red');
    assert.equal(room.startMatch(), false, '只有一队时不能开局');
    assert.equal(room.state, 'lobby');

    room.setPlayerTeam(b, 'blue');
    assert.equal(room.startMatch(), true);
    assert.equal(room.state, 'playing');
  } finally {
    room.stopTicking();
  }
});

test('大乱斗团队：跨队击杀累计团队分，state 同步 team / teamKills', () => {
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
    assert.ok(state);
    assert.equal(state.teamMode, true);
    assert.equal(state.teamKills.red, 1);
    assert.equal(state.tanks.find((t) => t.id === a.id).team, 'red');
  } finally {
    room.stopTicking();
  }
});

test('大乱斗团队：达到团队击杀目标广播 match_end(winnerTeam)', () => {
  const { room, sockets } = makeRoom(4);
  try {
    room.killTarget = 1;
    const [a, b] = [...room.players.values()];
    killOnce(room, a, b);

    const matchEnd = sockets[0].messages.find((m) => m.type === 'match_end');
    assert.ok(matchEnd, '达到团队目标应广播 match_end');
    assert.equal(matchEnd.winnerTeam, 'red');
    assert.equal(matchEnd.winnerId, null);
    assert.equal(matchEnd.teamMode, true);
    assert.equal(matchEnd.mode, 'brawl');
    assert.equal(matchEnd.teamKills.red, 1);
    assert.equal(room.state, 'lobby');
    assert.equal(
      sockets[0].messages.filter((m) => m.type === 'round_end').length,
      0,
      '大乱斗团队对抗不广播 round_end'
    );
  } finally {
    room.stopTicking();
  }
});

test('大乱斗团队：同一 tick 两队同时达标且分数相同判平局', () => {
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
    assert.ok(matchEnd);
    assert.equal(matchEnd.winnerTeam, null);
    assert.equal(matchEnd.reason, 'draw');
    assert.equal(matchEnd.teamKills.red, 1);
    assert.equal(matchEnd.teamKills.blue, 1);
  } finally {
    room.stopTicking();
  }
});

test('团队对抗关闭友伤与追踪：子弹穿过队友、只追敌人', () => {
  const { room } = makeRoom(4);
  try {
    room.maze.rects = [];
    room.bullets = [];
    const [a, b, c, d] = [...room.players.values()]; // a/c 红，b/d 蓝
    a.x = 100; a.y = 100; a.angle = 0;
    c.x = 150; c.y = 100; a.angle = 0; // 队友更近（50px）
    b.x = 100; b.y = 300; b.angle = 0; // 敌人较远（200px）
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

test('团队对抗对四个模式都关闭友伤', () => {
  for (const mode of ['brawl', 'capture', 'collect', 'classic']) {
    const { room } = makeRoom(4, mode);
    try {
      const [a, , c] = [...room.players.values()]; // a 红，c 红
      c.hp = 1;
      shootAt(room, a, c);
      room.tick();
      assert.equal(c.alive, true, `${mode}：队友不应被友军子弹击杀`);
      assert.equal(c.hp, 1, `${mode}：队友不应掉血`);

      // 对照：普通模式下同样的友军子弹会正常造成伤害。
      room.teamMode = false;
      for (const p of room.players.values()) p.team = null;
      room.bullets = [];
      c.hp = 1;
      shootAt(room, a, c);
      room.tick();
      assert.equal(c.alive, false, `${mode}：关闭团队对抗后恢复友伤`);
    } finally {
      room.stopTicking();
    }
  }
});

test('占点团队：同队多人合力推进，敌我同圈冻结，换队后按 5 秒清退', () => {
  const { room } = makeRoom(4, 'capture');
  try {
    const [a, b, c] = [...room.players.values()]; // a/c 红，b 蓝
    room.point = {
      id: 1000,
      x: 400,
      y: 300,
      radius: CAPTURE_RADIUS,
      progress: 0,
      ownerId: null,
      ownerTeam: null,
      ownerColor: null,
      status: 'idle',
    };
    // a、c 两个红队同时进圈：不再像单人模式那样互相冻结。
    a.x = 390; a.y = 300;
    c.x = 410; c.y = 300;
    b.x = 10; b.y = 10;
    room.tick();
    assert.equal(room.point.ownerTeam, 'red');
    assert.equal(room.point.ownerColor, TEAMS.red.color);
    assert.equal(room.point.status, 'capturing');
    assert.ok(Math.abs(room.point.progress - 1 / CAPTURE_TICKS) < 1e-6);

    // 蓝队进圈：两队都在，进度冻结。
    b.x = 400; b.y = 310;
    for (let i = 0; i < 30; i++) room.tick();
    const frozen = room.point.progress;
    assert.equal(room.point.status, 'contested');
    for (let i = 0; i < 30; i++) room.tick();
    assert.equal(room.point.progress, frozen, '争夺时进度应冻结');

    // 红队全部离开、蓝队留在圈内：红队进度按 5 秒清退，清零后蓝队开始占。
    a.x = 10; a.y = 10;
    c.x = 20; c.y = 20;
    room.tick();
    assert.equal(room.point.status, 'neutralizing');
    let guard = 0;
    while (room.point.progress > 0 && guard < NEUTRALIZE_TICKS + 10) {
      room.tick();
      guard += 1;
    }
    assert.equal(room.point.progress, 0);
    room.tick();
    assert.equal(room.point.ownerTeam, 'blue');
    assert.equal(room.point.status, 'capturing');
    assert.ok(room.point.progress > 0);

    // 占满：团队占领分 +1，圈内蓝队成员个人分 +1。
    for (let i = 0; i < CAPTURE_TICKS + 2; i++) room.tick();
    assert.equal(room.teamCaptures.blue, 1);
    assert.equal(b.score, 1, '参与占领的蓝队成员个人分应 +1');
    assert.equal(a.score, 0);
    assert.notEqual(room.point.id, 1000, '占领后应换一个新据点');
  } finally {
    room.stopTicking();
  }
});

test('占点团队：达到队伍占领目标广播 match_end(winnerTeam)', () => {
  const { room, sockets } = makeRoom(2, 'capture');
  try {
    room.captureTarget = 1;
    const [a, b] = [...room.players.values()]; // a 红，b 蓝
    room.point = {
      id: 1001,
      x: 400,
      y: 300,
      radius: CAPTURE_RADIUS,
      progress: 0,
      ownerId: null,
      ownerTeam: null,
      ownerColor: null,
      status: 'idle',
    };
    a.x = 400; a.y = 300;
    b.x = 10; b.y = 10;
    for (let i = 0; i < CAPTURE_TICKS + 2; i++) room.tick();

    const matchEnd = sockets[0].messages.find((m) => m.type === 'match_end');
    assert.ok(matchEnd, '达到团队占领目标应结束整场');
    assert.equal(matchEnd.winnerTeam, 'red');
    assert.equal(matchEnd.teamMode, true);
    assert.equal(matchEnd.mode, 'capture');
    assert.equal(matchEnd.teamCaptures.red, 1);
  } finally {
    room.stopTicking();
  }
});

test('收集团队：钻石计入团队总分，阵亡掉一半并扣团队分', () => {
  const { room } = makeRoom(4, 'collect');
  try {
    const [a, b, c] = [...room.players.values()]; // a/c 红，b 蓝
    room.diamonds = [];

    // 两个红队成员各捡一颗：个人分与团队分都增加。
    room.diamonds.push({ id: 1, x: a.x, y: a.y, cellR: 0, cellC: 0 });
    room.tick();
    assert.equal(a.score, 1);
    assert.equal(room.teamDiamonds.red, 1);

    room.diamonds.push({ id: 2, x: c.x, y: c.y, cellR: 0, cellC: 0 });
    room.tick();
    assert.equal(c.score, 1);
    assert.equal(room.teamDiamonds.red, 2);

    // 让 a 携带 3 颗后阵亡：掉 1 颗，个人分和团队分同步 -1，钻石回到场上。
    a.score = 3;
    room.teamDiamonds.red = 3;
    const beforeDiamonds = room.diamonds.length;
    killOnce(room, b, a);
    assert.equal(a.score, 2, '个人携带掉一半（向下取整）');
    assert.equal(room.teamDiamonds.red, 2, '团队总分同步扣减');
    assert.equal(room.diamonds.length, beforeDiamonds + 1, '掉落的钻石应回到场上');
  } finally {
    room.stopTicking();
  }
});

test('收集团队：达到队伍收集目标广播 match_end(winnerTeam)', () => {
  const { room, sockets } = makeRoom(2, 'collect');
  try {
    room.collectTarget = 1;
    const [a, b] = [...room.players.values()];
    room.diamonds = [{ id: 1, x: a.x, y: a.y, cellR: 0, cellC: 0 }];
    b.x = 10; b.y = 10;
    room.tick();

    const matchEnd = sockets[0].messages.find((m) => m.type === 'match_end');
    assert.ok(matchEnd);
    assert.equal(matchEnd.winnerTeam, 'red');
    assert.equal(matchEnd.mode, 'collect');
    assert.equal(matchEnd.teamDiamonds.red, 1);
  } finally {
    room.stopTicking();
  }
});

test('经典团队：淘汰对方全队进入观察期，观察结束由队伍赢下回合', () => {
  const { room } = makeRoom(4, 'classic');
  try {
    const [a, b, c, d] = [...room.players.values()]; // a/c 红，b/d 蓝
    killOnce(room, a, b);
    assert.notEqual(room.state, 'round_pending', '蓝队还有人时回合继续');
    killOnce(room, c, d);

    assert.equal(room.state, 'round_pending');
    assert.equal(room.pendingWinnerTeam, 'red');
    assert.equal(room.teamWins.red, 0, '观察期结束前不加分');

    room.endTeamRound(room.pendingWinnerTeam);
    assert.equal(room.teamWins.red, 1);
    assert.equal(a.score, 1);
    assert.equal(c.score, 1);
    assert.equal(b.score, 0);
    assert.equal(room.state, 'round_over');

    const roundEnd = room.players.get(a.id).ws.messages.find((m) => m.type === 'round_end');
    assert.ok(roundEnd);
    assert.equal(roundEnd.winnerTeam, 'red');
    assert.equal(roundEnd.winnerId, null);
    assert.equal(roundEnd.teamMode, true);
  } finally {
    room.stopTicking();
  }
});

test('经典团队：观察期内领先方也全灭则平局，不加队伍胜场', () => {
  const { room } = makeRoom(4, 'classic');
  try {
    const [a, b, c, d] = [...room.players.values()]; // a/c 红，b/d 蓝
    killOnce(room, a, b);
    killOnce(room, c, d);
    assert.equal(room.state, 'round_pending');
    assert.equal(room.pendingWinnerTeam, 'red');

    // 观察期内红队最后两人同归于尽：应改成平局。
    a.alive = false;
    c.alive = false;
    room.tick();
    assert.equal(room.pendingWinnerTeam, null);

    room.endTeamRound(room.pendingWinnerTeam);
    assert.equal(room.teamWins.red, 0);
    assert.equal(room.teamWins.blue, 0);
  } finally {
    room.stopTicking();
  }
});

test('经典团队：队伍胜场达到目标后整场结束（match_end 带 winnerTeam）', () => {
  const { room, sockets } = makeRoom(4, 'classic');
  try {
    room.winScore = 1;
    room.endTeamRound('red');
    const roundEnd = sockets[0].messages.filter((m) => m.type === 'round_end').pop();
    assert.ok(roundEnd);
    assert.equal(roundEnd.final, true, '队伍胜场达标应标记为最终回合');
    assert.equal(roundEnd.teamWins.red, 1);

    // 结算展示结束后进入整场结算（真实房间会由 3 秒定时器触发）。
    room.advanceAfterRound(null, { winnerTeam: 'red', matchOver: true });
    const matchEnd = sockets[0].messages.find((m) => m.type === 'match_end');
    assert.ok(matchEnd, '队伍胜场达到目标应结束整场');
    assert.equal(matchEnd.winnerTeam, 'red');
    assert.equal(matchEnd.winnerId, null);
    assert.equal(matchEnd.teamMode, true);
    assert.equal(matchEnd.mode, 'classic');
    assert.equal(matchEnd.teamWins.red, 1);
    assert.equal(room.state, 'lobby');
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
    room.players.delete(a.id);
    room.tick();

    assert.equal(b.alive, false, '余弹应正常击杀目标');
    assert.equal(room.teamKills.red, 1, '离场者的余弹仍应给红队记分');
  } finally {
    room.stopTicking();
  }
});

test('对局中某一队全部离开：teamDepleted 返回 true', () => {
  const { room } = makeRoom(4);
  try {
    assert.equal(room.teamDepleted(), false);
    for (const p of [...room.players.values()]) {
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

test('团队对抗沿用 10 秒复活，复活后队伍不变', () => {
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
