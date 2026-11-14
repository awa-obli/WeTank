'use strict';

// 暗黑模式开关的端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 新房间默认关闭暗黑模式；只有房主、只有大厅可改；
//   2. 开启后 joined / room_update / state / match_end / room_list 都带 darkMode；
//   3. 暗黑模式与团队对抗、具体游戏模式互相独立，互不清除；
//   4. game_start 的 maze 带 rects（客户端视线遮挡数据），state 带 darkMode；
//   5. 对局中不能改暗黑模式；
//   6. 整场结束回到大厅后，房主仍可关闭暗黑模式。

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

// 清掉已收到的旧消息，避免 waitForMsg 命中上一轮同类型的 room_update 而误判。
function flush(client) {
  client.messages.length = 0;
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
  send(client, { type: 'create_room', name, roomName: `${name}的暗黑房` });
  const joined = await waitForMsg(client, (m) => m.type === 'joined', 'joined(房主)');
  return { client, joined };
}

async function joinRoom(name, code) {
  const client = await connect();
  send(client, { type: 'join_room', name, code });
  const joined = await waitForMsg(client, (m) => m.type === 'joined', `joined(${name})`);
  return { client, joined };
}

async function main() {
  const observer = await connect();
  await waitForMsg(observer, (m) => m.type === 'room_list', '初始 room_list');

  // ---------- 建房与默认值 ----------
  const host = await createRoom('房主');
  check(host.joined.mode === 'brawl', `新房默认仍是大乱斗（实际 ${host.joined.mode}）`);
  check(host.joined.darkMode === false, '新房默认关闭暗黑模式');
  check(host.joined.teamMode === false, '暗黑模式默认值不影响团队对抗默认值');

  const listDefault = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === host.joined.code && r.darkMode === false),
    'room_list(默认关闭暗黑)'
  );
  check(
    listDefault.rooms.find((r) => r.code === host.joined.code).darkMode === false,
    '房间列表默认带 darkMode=false'
  );

  const g1 = await joinRoom('队员A', host.joined.code);

  // ---------- 只有房主能改 ----------
  send(g1.client, { type: 'set_dark_mode', enabled: true });
  let err = await waitForMsg(g1.client, (m) => m.type === 'error', 'error(非房主暗黑)');
  check(/房主/.test(err.message), `非房主不能改暗黑模式：${err.message}`);

  // ---------- 开启暗黑 ----------
  send(host.client, { type: 'set_dark_mode', enabled: true });
  let update = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.darkMode === true,
    'room_update(开启暗黑)'
  );
  check(update.mode === 'brawl', '开启暗黑不改变游戏模式');
  check(update.teamMode === false, '开启暗黑不开启团队对抗');
  check(update.players.every((p) => p.team === null), '开启暗黑不会给玩家分队');

  const g2 = await joinRoom('队员B', host.joined.code);
  check(g2.joined.darkMode === true, '后加入的玩家同步暗黑开关');
  check(g2.joined.teamMode === false, '后加入的玩家仍保持团队对抗关闭');

  const listDark = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === host.joined.code && r.darkMode === true),
    'room_list(暗黑开启)'
  );
  check(
    listDark.rooms.find((r) => r.code === host.joined.code).darkMode === true,
    '房间列表带暗黑模式标记'
  );

  // ---------- 与团队对抗互不影响 ----------
  flush(host.client);
  send(host.client, { type: 'set_team_mode', enabled: true });
  update = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.teamMode === true,
    'room_update(开启团队)'
  );
  check(update.darkMode === true, '开启团队对抗后暗黑模式保持开启');

  flush(host.client);
  send(host.client, { type: 'set_team_mode', enabled: false });
  update = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.teamMode === false,
    'room_update(关闭团队)'
  );
  check(update.darkMode === true, '关闭团队对抗后暗黑模式保持开启');

  // ---------- 与具体模式互不影响 ----------
  flush(host.client);
  send(host.client, { type: 'set_mode', mode: 'collect' });
  update = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.mode === 'collect',
    'room_update(切收集)'
  );
  check(update.darkMode === true, '切换游戏模式后暗黑模式保持开启');

  flush(host.client);
  send(host.client, { type: 'set_mode', mode: 'brawl' });
  update = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.mode === 'brawl',
    'room_update(切回大乱斗)'
  );
  check(update.darkMode === true, '切回大乱斗后暗黑模式保持开启');

  // ---------- 开局：game_start / state 带暗黑与视线遮挡数据 ----------
  flush(host.client);
  send(host.client, { type: 'start_game' });
  const start = await waitForMsg(host.client, (m) => m.type === 'game_start', 'game_start(暗黑)');
  check(start.darkMode === true, 'game_start 带暗黑模式开关');
  check(
    start.maze && Array.isArray(start.maze.rects) && start.maze.rects.length > 0,
    'game_start 的 maze 带墙体矩形 rects（供视线遮挡）'
  );
  const firstRect = start.maze && start.maze.rects ? start.maze.rects[0] : null;
  check(
    firstRect
      && Number.isFinite(firstRect.cx) && Number.isFinite(firstRect.cy)
      && Number.isFinite(firstRect.hw) && Number.isFinite(firstRect.hh),
    'rects 里是 {cx, cy, hw, hh} 形式的墙体矩形'
  );

  const state = await waitForMsg(host.client, (m) => m.type === 'state', 'state(暗黑)');
  check(state.darkMode === true, 'state 带暗黑模式开关');
  check(state.teamMode === false, 'state 里团队对抗仍是关闭');

  // ---------- 对局中不能改 ----------
  send(host.client, { type: 'set_dark_mode', enabled: false });
  err = await waitForMsg(host.client, (m) => m.type === 'error', 'error(对局中改暗黑)');
  check(/游戏进行中/.test(err.message), `对局中禁止修改暗黑模式：${err.message}`);

  send(g1.client, { type: 'set_dark_mode', enabled: false });
  err = await waitForMsg(g1.client, (m) => m.type === 'error', 'error(对局中非房主改暗黑)');
  check(/房主/.test(err.message), `对局中非房主也不能改暗黑模式：${err.message}`);

  // ---------- 人数不足结束整场：match_end 保留开关 ----------
  // 3 人里关掉 2 人，服务端会按人数不足结束整场。
  g1.client.ws.close();
  g2.client.ws.close();
  const end = await waitForMsg(host.client, (m) => m.type === 'match_end', 'match_end(人数不足)');
  check(end.reason === 'not_enough_players', `人数不足结束整场（实际 ${end.reason}）`);
  check(end.darkMode === true, 'match_end 保留暗黑模式开关');

  // ---------- 回到大厅后可以关闭 ----------
  // 收到 match_end 时服务端已经回到 lobby（endMatch 先改 state 再广播），直接发开关请求即可。
  flush(host.client);
  send(host.client, { type: 'set_dark_mode', enabled: false });
  update = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.darkMode === false,
    'room_update(关闭暗黑)'
  );
  check(update.darkMode === false, '回到大厅后可以关闭暗黑模式');
  check(update.mode === 'brawl', '关闭暗黑不影响游戏模式');

  for (const c of [host, observer]) {
    try {
      if (c.client) c.client.ws.close();
      else c.ws.close();
    } catch (e) {
      // 已关闭的连接忽略
    }
  }
  await sleep(80);

  if (failures.length) {
    console.error('DARK ROOM FAIL:', failures.join('; '));
    process.exit(1);
  }
  console.log('DARK ROOM OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('DARK ROOM ERROR:', e);
  process.exit(1);
});
