'use strict';

// 占点模式的端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 默认仍是大乱斗；可切到占点模式，默认占领目标 3、占点时长 12 秒；
//   2. 非房主 / 非占点模式 / 非法值不能改占领目标；占点模式下不能改击杀目标或经典胜利分数；
//   3. 开局 game_start 带据点（圆心在格心、整个圆在世界内、半径 60、进度 0）；
//   4. state 带据点，且所有玩家出生点都不在据点圈内；
//   5. 房间列表显示占点模式徽章；
//   6. 对局中不能改模式 / 占领目标；
//   7. 中途加入的观战者能收到带据点的 game_start / state 快照。

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
  send(client, { type: 'create_room', name, roomName: `${name}的占点房` });
  const joined = await waitForMsg(client, (m) => m.type === 'joined', 'joined(房主)');
  return { client, joined };
}

async function joinRoom(name, code) {
  const client = await connect();
  send(client, { type: 'join_room', name, code });
  const joined = await waitForMsg(client, (m) => m.type === 'joined', `joined(${name})`);
  return { client, joined };
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

async function main() {
  const observer = await connect();
  await waitForMsg(observer, (m) => m.type === 'room_list', '初始 room_list');

  // ---------- 默认值与模式切换 ----------
  const host = await createRoom('房主');
  check(host.joined.mode === 'brawl', `新房默认仍是大乱斗（实际 ${host.joined.mode}）`);
  check(host.joined.captureTarget === 3, `默认占领目标 3（实际 ${host.joined.captureTarget}）`);
  check(host.joined.captureTime === 12, `默认占点时长 12 秒（实际 ${host.joined.captureTime}）`);

  // 还不是占点模式时不能设置占领目标
  send(host.client, { type: 'set_capture_target', target: 5 });
  const wrongModeTarget = await waitForMsg(host.client, (m) => m.type === 'error', 'error(大乱斗改占领目标)');
  check(/占点模式/.test(wrongModeTarget.message), `非占点模式拒绝改占领目标：${wrongModeTarget.message}`);

  send(host.client, { type: 'set_mode', mode: 'capture' });
  const modeUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.mode === 'capture',
    'room_update(切占点)'
  );
  check(modeUpdate.captureTarget === 3, `切到占点后占领目标仍为 3（实际 ${modeUpdate.captureTarget}）`);

  const guest = await joinRoom('队员', host.joined.code);
  check(guest.joined.mode === 'capture', '新玩家同步占点模式');
  check(guest.joined.captureTarget === 3, '新玩家同步占领目标');
  check(guest.joined.captureTime === 12, '新玩家同步占点时长');
  await waitForMsg(host.client, (m) => m.type === 'room_update' && m.players.length === 2, 'room_update(2人)');

  // ---------- 权限与参数校验 ----------
  send(guest.client, { type: 'set_capture_target', target: 5 });
  const notHost = await waitForMsg(guest.client, (m) => m.type === 'error', 'error(非房主改占领目标)');
  check(/房主/.test(notHost.message), `非房主修改占领目标被拒绝：${notHost.message}`);

  for (const [bad, label] of [[0, '0'], [11, '11'], [2.5, '2.5'], ['abc', 'abc']]) {
    send(host.client, { type: 'set_capture_target', target: bad });
    const err = await waitForMsg(host.client, (m) => m.type === 'error', `error(占领目标 ${label})`);
    check(/占领目标/.test(err.message), `非法占领目标 ${label} 被拒绝：${err.message}`);
  }

  send(host.client, { type: 'set_capture_target', target: 5 });
  const targetUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.captureTarget === 5,
    'room_update(占领目标 5)'
  );
  check(targetUpdate.captureTarget === 5, '房主可把占领目标改成 5');
  await waitForMsg(guest.client, (m) => m.type === 'room_update' && m.captureTarget === 5, 'room_update(目标同步)');
  check(true, '占领目标同步给所有玩家');

  send(host.client, { type: 'set_kill_target', kills: 10 });
  const wrongKills = await waitForMsg(host.client, (m) => m.type === 'error', 'error(占点改击杀目标)');
  check(/大乱斗/.test(wrongKills.message), `占点模式拒绝修改击杀目标：${wrongKills.message}`);

  send(host.client, { type: 'set_win_score', score: 5 });
  const wrongWin = await waitForMsg(host.client, (m) => m.type === 'error', 'error(占点改经典分数)');
  check(/经典模式/.test(wrongWin.message), `占点模式拒绝修改经典胜利分数：${wrongWin.message}`);

  // ---------- 开局据点 ----------
  send(host.client, { type: 'start_game' });
  const start = await waitForMsg(host.client, (m) => m.type === 'game_start', 'game_start');
  check(start.mode === 'capture', `game_start 带占点模式（实际 ${start.mode}）`);
  check(start.captureTarget === 5, `game_start 带占领目标 5（实际 ${start.captureTarget}）`);
  check(start.captureTime === 12, `game_start 带占点时长 12（实际 ${start.captureTime}）`);
  check(!!start.point, 'game_start 带据点');
  const point = start.point;
  check(point && point.progress === 0, `开局据点进度为 0（实际 ${point && point.progress}）`);
  check(point && point.radius === 80, `据点半径 80（实际 ${point && point.radius}）`);
  check(
    point && Number.isFinite(point.x) && Number.isFinite(point.y),
    `据点圆心为有限坐标（实际 ${point && point.x},${point && point.y}）`
  );
  check(
    point && point.x >= point.radius && point.x <= start.worldW - point.radius
      && point.y >= point.radius && point.y <= start.worldH - point.radius,
    '整个据点圆在世界范围内'
  );

  const state = await waitForMsg(host.client, (m) => m.type === 'state' && m.point, 'state(带据点)');
  check(!!state.point, 'state 带据点');
  check(state.point.id === point.id, 'state 据点 id 与 game_start 一致');
  const insideSpawn = state.tanks.filter((t) => dist2(t.x, t.y, point.x, point.y) <= point.radius * point.radius);
  check(insideSpawn.length === 0, `所有玩家出生点都不在据点圈内（实际 ${insideSpawn.length} 个在圈内）`);

  // 房间列表徽章
  send(observer, { type: 'list_rooms' });
  const list = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === host.joined.code && r.mode === 'capture'),
    'room_list(占点模式徽章)'
  );
  check(true, '房间列表带占点模式徽章');
  const summary = list.rooms.find((r) => r.code === host.joined.code);
  check(summary.mode === 'capture', `列表 mode 为 capture（实际 ${summary.mode}）`);

  // 对局中禁止改模式 / 占领目标
  send(host.client, { type: 'set_mode', mode: 'brawl' });
  const inGameMode = await waitForMsg(host.client, (m) => m.type === 'error', 'error(对局中改模式)');
  check(/游戏进行中/.test(inGameMode.message), `对局中禁止修改模式：${inGameMode.message}`);

  send(host.client, { type: 'set_capture_target', target: 4 });
  const inGameTarget = await waitForMsg(host.client, (m) => m.type === 'error', 'error(对局中改占领目标)');
  check(/游戏进行中/.test(inGameTarget.message), `对局中禁止修改占领目标：${inGameTarget.message}`);

  // ---------- 中途观战 ----------
  const spec = await joinRoom('观战者', host.joined.code);
  check(spec.joined.spectating === true, '对局中加入的玩家进入观战席');
  check(spec.joined.mode === 'capture', '观战者同步占点模式');
  const specStart = await waitForMsg(spec.client, (m) => m.type === 'game_start', 'game_start(观战快照)');
  check(specStart.spectating === true, '观战快照带 spectating 标记');
  check(!!specStart.point, '观战快照带据点');
  const specState = await waitForMsg(spec.client, (m) => m.type === 'state' && m.point, 'state(观战据点)');
  check(!!specState.point, '观战 state 带据点');

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
  console.log('\n全部占点模式 E2E 检查通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
