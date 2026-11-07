'use strict';

// 团队模式设置的端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 房主可切到团队模式，房主自动分到红队，新玩家自动补到人少的一队；
//   2. 房间列表带团队模式徽章；
//   3. 非房主不能换队 / 重新分队；
//   4. 全部玩家在同一队时不能开局；
//   5. 房主可手动换队、重新分队，人数差不超过 1；
//   6. 团队模式复用击杀目标设置，非法值被拒绝；不能设置经典胜利分数；
//   7. 开局 game_start / state 带队伍和团队总击杀；
//   8. 对局中不能换队 / 重新分队 / 改模式；
//   9. 对局中某一队全部离开时结束整场，reason=not_enough_players。

const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://127.0.0.1:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const ws = new WebSocket(URL);
  const messages = [];
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw));
    } catch (e) {
      // 忽略非 JSON 消息
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, messages };
}

function send(client, obj) {
  client.ws.send(JSON.stringify(obj));
}

function waitForMsg(client, predicate, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const idx = client.messages.findIndex(predicate);
      if (idx !== -1) {
        clearInterval(timer);
        const [msg] = client.messages.splice(idx, 1);
        resolve(msg);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`等待 ${label} 超时`));
      }
    }, 15);
  });
}

const failures = [];
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
}

async function createRoom(name) {
  const client = await connect();
  send(client, { type: 'create_room', name, roomName: `${name}的团队房` });
  const joined = await waitForMsg(client, (m) => m.type === 'joined', 'joined(房主)');
  return { client, joined };
}

async function joinRoom(name, code) {
  const client = await connect();
  send(client, { type: 'join_room', name, code });
  const joined = await waitForMsg(client, (m) => m.type === 'joined', `joined(${name})`);
  return { client, joined };
}

function countTeams(playerList) {
  let red = 0;
  let blue = 0;
  for (const p of playerList) {
    if (p.team === 'red') red += 1;
    else if (p.team === 'blue') blue += 1;
  }
  return { red, blue };
}

async function main() {
  const observer = await connect();
  await waitForMsg(observer, (m) => m.type === 'room_list', '初始 room_list');

  // ---------- 建队与自动分队 ----------
  const host = await createRoom('房主');
  check(host.joined.mode === 'brawl', `新房默认仍是大乱斗（实际 ${host.joined.mode}）`);

  send(host.client, { type: 'set_mode', mode: 'team' });
  const modeUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.mode === 'team',
    'room_update(切团队)'
  );
  check(modeUpdate.players[0].team === 'red', '切到团队模式后房主自动分到红队');
  check(modeUpdate.killTarget === 10, `团队模式复用默认击杀目标 10（实际 ${modeUpdate.killTarget}）`);

  const g1 = await joinRoom('队员A', host.joined.code);
  const g2 = await joinRoom('队员B', host.joined.code);
  check(g1.joined.mode === 'team' && g2.joined.mode === 'team', '新玩家同步团队模式');
  check(g1.joined.players.length === 2, `队员A加入时名单为 2 人（实际 ${g1.joined.players.length}）`);
  check(g2.joined.players.length === 3, `队员B加入时名单为 3 人（实际 ${g2.joined.players.length}）`);

  const update3 = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.players.length === 3,
    'room_update(3人)'
  );
  const teams = new Map(update3.players.map((p) => [p.id, p.team]));
  check([...teams.values()].every((t) => t === 'red' || t === 'blue'), '自动分队后所有玩家都有队伍');
  check(new Set(teams.values()).size === 2, '自动分队后红蓝两队都有人');
  const counts3 = countTeams(update3.players);
  check(Math.abs(counts3.red - counts3.blue) <= 1, `自动分队人数差不超过 1（实际 ${counts3.red}/${counts3.blue}）`);

  const listWithTeam = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === host.joined.code && r.mode === 'team'),
    'room_list(团队模式)'
  );
  check(
    listWithTeam.rooms.find((r) => r.code === host.joined.code).mode === 'team',
    '房间列表显示团队模式'
  );

  // ---------- 非房主限制 ----------
  send(g1.client, { type: 'set_player_team', targetId: host.joined.playerId, team: 'blue' });
  let err = await waitForMsg(g1.client, (m) => m.type === 'error', 'error(非房主换队)');
  check(/房主/.test(err.message), `非房主换队被拒绝：${err.message}`);

  send(g1.client, { type: 'shuffle_teams' });
  err = await waitForMsg(g1.client, (m) => m.type === 'error', 'error(非房主分队)');
  check(/房主/.test(err.message), `非房主重新分队被拒绝：${err.message}`);

  // ---------- 全部放红队：禁止开局 ----------
  for (const [id, team] of teams) {
    if (team === 'red') continue;
    send(host.client, { type: 'set_player_team', targetId: id, team: 'red' });
    await waitForMsg(
      host.client,
      (m) => m.type === 'room_update' && m.players.find((p) => p.id === id)?.team === 'red',
      `room_update(换红 ${id})`
    );
  }
  send(host.client, { type: 'start_game' });
  err = await waitForMsg(host.client, (m) => m.type === 'error', 'error(一队为空)');
  check(/两队/.test(err.message), `某队为空时拒绝开局：${err.message}`);

  // ---------- 手动换队 / 重新分队 ----------
  const g2Id = g2.joined.playerId;
  send(host.client, { type: 'set_player_team', targetId: g2Id, team: 'blue' });
  await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.players.find((p) => p.id === g2Id)?.team === 'blue',
    'room_update(换蓝)'
  );

  send(host.client, { type: 'shuffle_teams' });
  const shuffled = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update'
      && m.players.length === 3
      && new Set(m.players.map((p) => p.team)).size === 2,
    'room_update(重新分队)'
  );
  check(shuffled.players.every((p) => p.team === 'red' || p.team === 'blue'), '重新分队后所有人都有队伍');
  const shuffledCounts = countTeams(shuffled.players);
  check(
    Math.abs(shuffledCounts.red - shuffledCounts.blue) <= 1,
    `重新分队人数差不超过 1（实际 ${shuffledCounts.red}/${shuffledCounts.blue}）`
  );

  // 固定成"房主 + 队员A 红、队员B 蓝"，确保后面关闭蓝队时不会关掉房主连接。
  const currentTeams = new Map(shuffled.players.map((p) => [p.id, p.team]));
  const desiredTeams = [
    { id: host.joined.playerId, team: 'red', label: '房主' },
    { id: g1.joined.playerId, team: 'red', label: '队员A' },
    { id: g2Id, team: 'blue', label: '队员B' },
  ];
  for (const { id, team, label } of desiredTeams) {
    if (currentTeams.get(id) === team) continue;
    send(host.client, { type: 'set_player_team', targetId: id, team });
    await waitForMsg(
      host.client,
      (m) => m.type === 'room_update' && m.players.find((p) => p.id === id)?.team === team,
      `room_update(${label}固定${team === 'red' ? '红' : '蓝'}队)`
    );
    currentTeams.set(id, team);
  }

  // ---------- 击杀目标 ----------
  send(host.client, { type: 'set_kill_target', kills: 7 });
  const killUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.killTarget === 7,
    'room_update(击杀目标7)'
  );
  check(killUpdate.killTarget === 7, '团队模式可把击杀目标改成 7');

  for (const [value, label] of [[4, '4'], [31, '31'], [5.5, '小数'], [true, '布尔'], [null, 'null'], ['abc', '非数字']]) {
    send(host.client, { type: 'set_kill_target', kills: value });
    const bad = await waitForMsg(host.client, (m) => m.type === 'error', `error(击杀目标 ${label})`);
    check(/击杀目标/.test(bad.message), `非法击杀目标 ${label} 被拒绝`);
  }

  send(host.client, { type: 'set_win_score', score: 3 });
  const wrongWin = await waitForMsg(host.client, (m) => m.type === 'error', 'error(团队改胜利分数)');
  check(/经典模式/.test(wrongWin.message), `团队模式拒绝修改胜利分数：${wrongWin.message}`);

  // ---------- 开局 ----------
  send(host.client, { type: 'start_game' });
  const start = await waitForMsg(host.client, (m) => m.type === 'game_start', 'game_start(团队)');
  check(start.mode === 'team', `game_start 带团队模式（实际 ${start.mode}）`);
  check(start.killTarget === 7, `game_start 带击杀目标（实际 ${start.killTarget}）`);
  check(
    start.teamKills && start.teamKills.red === 0 && start.teamKills.blue === 0,
    'game_start 团队总击杀从 0 开始'
  );
  check(
    start.players.length === 3 && new Set(start.players.map((p) => p.team)).size === 2,
    'game_start 名单带红蓝两队'
  );

  const state = await waitForMsg(host.client, (m) => m.type === 'state', 'state(团队)');
  check(
    state.tanks.length === 3 && state.tanks.every((t) => t.team === 'red' || t.team === 'blue'),
    'state 每辆坦克都带队伍'
  );
  check(
    state.teamKills && state.teamKills.red === 0 && state.teamKills.blue === 0,
    'state 带团队总击杀'
  );

  // ---------- 对局中限制 ----------
  send(host.client, { type: 'set_player_team', targetId: g2Id, team: 'red' });
  err = await waitForMsg(host.client, (m) => m.type === 'error', 'error(对局中换队)');
  check(/游戏进行中/.test(err.message), `对局中禁止换队：${err.message}`);

  send(host.client, { type: 'shuffle_teams' });
  err = await waitForMsg(host.client, (m) => m.type === 'error', 'error(对局中分队)');
  check(/游戏进行中/.test(err.message), `对局中禁止重新分队：${err.message}`);

  send(host.client, { type: 'set_mode', mode: 'classic' });
  err = await waitForMsg(host.client, (m) => m.type === 'error', 'error(对局中改模式)');
  check(/游戏进行中/.test(err.message), `对局中禁止修改模式：${err.message}`);

  // ---------- 一队清空：整场结束 ----------
  const bluePlayer = start.players.find((p) => p.team === 'blue');
  check(Boolean(bluePlayer), '开局名单里能找到蓝队玩家');
  const blueClient = [host, g1, g2].find((c) => c.joined.playerId === bluePlayer.id);
  check(blueClient === g2, '蓝队玩家是队员B（不会误关房主连接）');

  blueClient.client.ws.close();
  const end = await waitForMsg(host.client, (m) => m.type === 'match_end', 'match_end(一队清空)');
  check(end.reason === 'not_enough_players', `一队清空按人数不足结束（实际 ${end.reason}）`);
  check(end.winnerTeam === null, '一队清空不产生获胜队伍');
  check(end.mode === 'team', 'match_end 保留团队模式');
  check(
    end.teamKills && typeof end.teamKills.red === 'number' && typeof end.teamKills.blue === 'number',
    'match_end 带团队总击杀'
  );

  for (const c of [host, g1, g2]) {
    try {
      if (c.client.ws.readyState === WebSocket.OPEN) c.client.ws.close();
    } catch (e) {
      // 已关闭的连接忽略
    }
  }
  observer.ws.close();
  await sleep(80);

  if (failures.length) {
    console.error('TEAM ROOM FAIL:', failures.join('; '));
    process.exit(1);
  }
  console.log('TEAM ROOM OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('TEAM ROOM ERROR:', e);
  process.exit(1);
});
