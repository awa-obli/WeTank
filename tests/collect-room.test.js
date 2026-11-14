'use strict';

// 收集模式的 WebSocket 端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 默认仍是大乱斗，默认收集目标 10；
//   2. 可切到收集模式；非房主 / 非收集模式 / 非法值（含小于 5）不能改收集目标；
//   3. 收集模式下不能改击杀目标、占领目标、经典胜利分数；
//   4. 开局 game_start / state 带收集目标和开局 2 颗钻石；
//   5. 房间列表显示收集模式徽章；
//   6. 对局中不能改模式 / 收集目标；
//   7. 中途加入的观战者能收到带钻石的 game_start / state 快照。

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
  send(client, { type: 'create_room', name, roomName: `${name}的收集房` });
  const joined = await waitForMsg(client, (m) => m.type === 'joined', 'joined(房主)');
  return { client, joined };
}

async function joinRoom(name, code) {
  const client = await connect();
  send(client, { type: 'join_room', name, code });
  const joined = await waitForMsg(client, (m) => m.type === 'joined', `joined(${name})`);
  return { client, joined };
}

function diamondsValid(list) {
  return Array.isArray(list)
    && list.length === 2
    && list.every((d) => Number.isFinite(d.x) && Number.isFinite(d.y));
}

async function main() {
  const observer = await connect();
  await waitForMsg(observer, (m) => m.type === 'room_list', '初始 room_list');

  // ---------- 默认值与模式切换 ----------
  const host = await createRoom('房主');
  check(host.joined.mode === 'brawl', `新房默认仍是大乱斗（实际 ${host.joined.mode}）`);
  check(host.joined.collectTarget === 10, `默认收集目标 10（实际 ${host.joined.collectTarget}）`);

  // 还不是收集模式时不能设置收集目标
  send(host.client, { type: 'set_collect_target', target: 5 });
  const wrongMode = await waitForMsg(host.client, (m) => m.type === 'error', 'error(大乱斗改收集目标)');
  check(/收集模式/.test(wrongMode.message), `非收集模式拒绝改收集目标：${wrongMode.message}`);

  send(host.client, { type: 'set_mode', mode: 'collect' });
  const modeUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.mode === 'collect',
    'room_update(切收集)'
  );
  check(modeUpdate.collectTarget === 10, `切到收集后默认目标仍为 10（实际 ${modeUpdate.collectTarget}）`);

  const guest = await joinRoom('队员', host.joined.code);
  check(guest.joined.mode === 'collect', '新玩家同步收集模式');
  check(guest.joined.collectTarget === 10, '新玩家同步收集目标');
  await waitForMsg(host.client, (m) => m.type === 'room_update' && m.players.length === 2, 'room_update(2人)');

  // ---------- 权限与参数校验 ----------
  send(guest.client, { type: 'set_collect_target', target: 5 });
  const notHost = await waitForMsg(guest.client, (m) => m.type === 'error', 'error(非房主改收集目标)');
  check(/房主/.test(notHost.message), `非房主修改收集目标被拒绝：${notHost.message}`);

  for (const [bad, label] of [[0, '0'], [4, '4'], [31, '31'], [2.5, '2.5'], ['abc', 'abc']]) {
    send(host.client, { type: 'set_collect_target', target: bad });
    const err = await waitForMsg(host.client, (m) => m.type === 'error', `error(收集目标 ${label})`);
    check(/收集目标/.test(err.message), `非法收集目标 ${label} 被拒绝：${err.message}`);
  }

  send(host.client, { type: 'set_collect_target', target: 5 });
  const targetUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.collectTarget === 5,
    'room_update(收集目标 5)'
  );
  check(targetUpdate.collectTarget === 5, '房主可把收集目标改成 5');
  await waitForMsg(guest.client, (m) => m.type === 'room_update' && m.collectTarget === 5, 'room_update(目标同步)');
  check(true, '收集目标同步给所有玩家');

  send(host.client, { type: 'set_kill_target', kills: 10 });
  const wrongKills = await waitForMsg(host.client, (m) => m.type === 'error', 'error(收集改击杀目标)');
  check(/大乱斗/.test(wrongKills.message), `收集模式拒绝修改击杀目标：${wrongKills.message}`);

  send(host.client, { type: 'set_capture_target', target: 3 });
  const wrongCapture = await waitForMsg(host.client, (m) => m.type === 'error', 'error(收集改占领目标)');
  check(/占点模式/.test(wrongCapture.message), `收集模式拒绝修改占领目标：${wrongCapture.message}`);

  send(host.client, { type: 'set_win_score', score: 5 });
  const wrongWin = await waitForMsg(host.client, (m) => m.type === 'error', 'error(收集改经典分数)');
  check(/经典模式/.test(wrongWin.message), `收集模式拒绝修改经典胜利分数：${wrongWin.message}`);

  // ---------- 开局 ----------
  send(host.client, { type: 'start_game' });
  const start = await waitForMsg(host.client, (m) => m.type === 'game_start', 'game_start');
  check(start.mode === 'collect', `game_start 带收集模式（实际 ${start.mode}）`);
  check(start.collectTarget === 5, `game_start 带收集目标 5（实际 ${start.collectTarget}）`);
  check(diamondsValid(start.diamonds), `game_start 带开局 2 颗钻石（实际 ${JSON.stringify(start.diamonds)}）`);

  const state = await waitForMsg(host.client, (m) => m.type === 'state' && Array.isArray(m.diamonds), 'state(带钻石)');
  check(diamondsValid(state.diamonds), `state 带钻石（实际 ${JSON.stringify(state.diamonds)}）`);

  // 房间列表徽章
  send(observer, { type: 'list_rooms' });
  const list = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === host.joined.code && r.mode === 'collect'),
    'room_list(收集模式徽章)'
  );
  check(true, '房间列表带收集模式徽章');
  const summary = list.rooms.find((r) => r.code === host.joined.code);
  check(summary.mode === 'collect', `列表 mode 为 collect（实际 ${summary.mode}）`);

  // 对局中禁止改模式 / 收集目标
  send(host.client, { type: 'set_mode', mode: 'brawl' });
  const inGameMode = await waitForMsg(host.client, (m) => m.type === 'error', 'error(对局中改模式)');
  check(/游戏进行中/.test(inGameMode.message), `对局中禁止修改模式：${inGameMode.message}`);

  send(host.client, { type: 'set_collect_target', target: 5 });
  const inGameTarget = await waitForMsg(host.client, (m) => m.type === 'error', 'error(对局中改收集目标)');
  check(/游戏进行中/.test(inGameTarget.message), `对局中禁止修改收集目标：${inGameTarget.message}`);

  // ---------- 中途观战 ----------
  const spec = await joinRoom('观战者', host.joined.code);
  check(spec.joined.spectating === true, '对局中加入的玩家进入观战席');
  check(spec.joined.mode === 'collect', '观战者同步收集模式');
  const specStart = await waitForMsg(spec.client, (m) => m.type === 'game_start', 'game_start(观战快照)');
  check(specStart.spectating === true, '观战快照带 spectating 标记');
  check(diamondsValid(specStart.diamonds), '观战快照带钻石');
  const specState = await waitForMsg(spec.client, (m) => m.type === 'state' && Array.isArray(m.diamonds), 'state(观战钻石)');
  check(diamondsValid(specState.diamonds), '观战 state 带钻石');

  // 清理
  for (const c of [spec.client, guest.client, host.client, observer]) {
    try { c.ws.close(); } catch (e) { /* 忽略 */ }
  }
  await sleep(100);

  if (failures.length > 0) {
    console.error(`\n${failures.length} 个检查失败:`);
    failures.forEach((f) => console.error(` - ${f}`));
    process.exit(1);
  }
  console.log('\n全部收集模式 E2E 检查通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
