'use strict';

// 团队对抗开关的端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 团队模式已移除；团队对抗是独立开关，只有房主、只有大厅可改；
//   2. 开启自动分队，新玩家补到人少一队；关闭清空队伍；
//   3. 房间列表带 teamMode；换队/重新分队只在开启时可用；
//   4. 切换游戏模式不会清掉团队对抗与队伍；
//   5. 全部玩家在同一队时不能开局；
//   6. 开启团队对抗后可以进入任意模式：game_start / state 带 teamMode、团队统计和队伍归属；
//   7. 对局中不能改开关/换队/重新分队；
//   8. 一队全部离开时结束整场，reason=not_enough_players。

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

  // ---------- 建房与开关 ----------
  const host = await createRoom('房主');
  check(host.joined.mode === 'brawl', `新房默认仍是大乱斗（实际 ${host.joined.mode}）`);
  check(host.joined.teamMode === false, '新房默认关闭团队对抗');

  // 团队模式已从模式列表移除：旧客户端再发 team 应被拒绝。
  send(host.client, { type: 'set_mode', mode: 'team' });
  let err = await waitForMsg(host.client, (m) => m.type === 'error', 'error(旧团队模式)');
  check(/无效的游戏模式/.test(err.message), `旧 team 模式被拒绝：${err.message}`);

  send(host.client, { type: 'set_team_mode', enabled: true });
  const modeUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.teamMode === true,
    'room_update(开启团队)'
  );
  check(modeUpdate.players.length === 1 && modeUpdate.players[0].team === 'red', '开启后房主自动分到红队');
  check(modeUpdate.mode === 'brawl', '团队对抗不改变当前游戏模式');

  const g1 = await joinRoom('队员A', host.joined.code);
  const g2 = await joinRoom('队员B', host.joined.code);
  check(g1.joined.teamMode === true && g2.joined.teamMode === true, '新玩家同步团队对抗开关');
  check(g1.joined.mode === 'brawl' && g2.joined.mode === 'brawl', '新玩家仍是当前游戏模式');
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
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === host.joined.code && r.teamMode === true),
    'room_list(团队对抗)'
  );
  check(
    listWithTeam.rooms.find((r) => r.code === host.joined.code).teamMode === true,
    '房间列表带团队对抗标记'
  );

  // ---------- 关闭开关：清空队伍 ----------
  send(host.client, { type: 'set_team_mode', enabled: false });
  const offUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.teamMode === false,
    'room_update(关闭团队)'
  );
  check(offUpdate.players.every((p) => p.team === null), '关闭团队对抗后清空所有队伍');

  send(host.client, { type: 'set_team_mode', enabled: true });
  await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.teamMode === true && m.players.every((p) => p.team),
    'room_update(重新开启团队)'
  );

  // ---------- 非房主限制 ----------
  send(g1.client, { type: 'set_team_mode', enabled: false });
  err = await waitForMsg(g1.client, (m) => m.type === 'error', 'error(非房主开关)');
  check(/房主/.test(err.message), `非房主不能改团队对抗：${err.message}`);

  send(g1.client, { type: 'set_player_team', targetId: host.joined.playerId, team: 'blue' });
  err = await waitForMsg(g1.client, (m) => m.type === 'error', 'error(非房主换队)');
  check(/房主/.test(err.message), `非房主换队被拒绝：${err.message}`);

  send(g1.client, { type: 'shuffle_teams' });
  err = await waitForMsg(g1.client, (m) => m.type === 'error', 'error(非房主分队)');
  check(/房主/.test(err.message), `非房主重新分队被拒绝：${err.message}`);

  // ---------- 全部放红队：禁止开局 ----------
  const current = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.players.length === 3,
    'room_update(当前名单)'
  );
  for (const p of current.players) {
    if (p.team === 'red') continue;
    send(host.client, { type: 'set_player_team', targetId: p.id, team: 'red' });
    await waitForMsg(
      host.client,
      (m) => m.type === 'room_update' && m.players.find((x) => x.id === p.id)?.team === 'red',
      `room_update(换红 ${p.id})`
    );
  }
  send(host.client, { type: 'start_game' });
  err = await waitForMsg(host.client, (m) => m.type === 'error', 'error(一队为空)');
  check(/两队/.test(err.message), `某队为空时拒绝开局：${err.message}`);

  // ---------- 换队 / 重新分队 ----------
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

  // ---------- 切换游戏模式：团队开关与队伍保留 ----------
  send(host.client, { type: 'set_mode', mode: 'capture' });
  const captureUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.mode === 'capture',
    'room_update(切占点)'
  );
  check(captureUpdate.teamMode === true, '切换模式后团队对抗开关保持开启');
  check(
    captureUpdate.players.every((p) => p.team === 'red' || p.team === 'blue'),
    '切换模式后队伍保留'
  );
  check(captureUpdate.captureTarget === 3, `占点默认目标 3（实际 ${captureUpdate.captureTarget}）`);

  send(host.client, { type: 'set_capture_target', target: 4 });
  const captureTargetUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.captureTarget === 4,
    'room_update(占领目标4)'
  );
  check(captureTargetUpdate.captureTarget === 4, '团队对抗下仍可设置占领目标');

  send(host.client, { type: 'set_kill_target', kills: 7 });
  err = await waitForMsg(host.client, (m) => m.type === 'error', 'error(占点改击杀目标)');
  check(/大乱斗/.test(err.message), `占点模式拒绝修改击杀目标：${err.message}`);

  // ---------- 开局：占点 + 团队对抗 ----------
  send(host.client, { type: 'start_game' });
  const start = await waitForMsg(host.client, (m) => m.type === 'game_start', 'game_start(团队占点)');
  check(start.mode === 'capture', `game_start 带占点模式（实际 ${start.mode}）`);
  check(start.teamMode === true, 'game_start 带团队对抗开关');
  check(start.captureTarget === 4, `game_start 带占领目标（实际 ${start.captureTarget}）`);
  check(
    start.teamCaptures && start.teamCaptures.red === 0 && start.teamCaptures.blue === 0,
    'game_start 团队占领分从 0 开始'
  );
  check(
    start.players.length === 3 && new Set(start.players.map((p) => p.team)).size === 2,
    'game_start 名单带红蓝两队'
  );
  check(start.point && start.point.ownerTeam === null, '团队占点开局据点无归属');

  const state = await waitForMsg(host.client, (m) => m.type === 'state', 'state(团队占点)');
  check(
    state.tanks.length === 3 && state.tanks.every((t) => t.team === 'red' || t.team === 'blue'),
    'state 每辆坦克都带队伍'
  );
  check(state.teamMode === true, 'state 带团队对抗开关');
  check(
    state.teamCaptures && typeof state.teamCaptures.red === 'number',
    'state 带团队占领分'
  );

  // ---------- 对局中限制 ----------
  send(host.client, { type: 'set_team_mode', enabled: false });
  err = await waitForMsg(host.client, (m) => m.type === 'error', 'error(对局中改开关)');
  check(/游戏进行中/.test(err.message), `对局中禁止修改团队对抗：${err.message}`);

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
  check(end.mode === 'capture', 'match_end 保留占点模式');
  check(end.teamMode === true, 'match_end 保留团队对抗开关');
  check(
    end.teamCaptures && typeof end.teamCaptures.red === 'number',
    'match_end 带团队占领分'
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
