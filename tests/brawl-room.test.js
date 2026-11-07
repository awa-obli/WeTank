'use strict';

// 游戏模式设置的端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 新建房间默认是「大乱斗」，击杀目标 10、经典胜利分数 5、复活等待 10 秒；
//   2. 房间列表带模式字段，方便选房时显示徽章；
//   3. 非房主 / 非法值修改模式、击杀目标、胜利分数都会被拒绝；
//   4. 房主改模式、改目标后所有玩家同步；
//   5. 开局 game_start 带当前模式与目标；
//   6. 对局进行中不能修改模式与目标。

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
  send(client, { type: 'create_room', name, roomName: `${name}的房间` });
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

  const host = await createRoom('房主');
  check(host.joined.mode === 'brawl', `新房默认是大乱斗（实际 ${host.joined.mode}）`);
  check(host.joined.killTarget === 10, `默认击杀目标是 10（实际 ${host.joined.killTarget}）`);
  check(host.joined.winScore === 5, `默认经典胜利分数是 5（实际 ${host.joined.winScore}）`);
  check(host.joined.respawnDelay === 10, `复活等待是 10 秒（实际 ${host.joined.respawnDelay}）`);

  const listWithRoom = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === host.joined.code),
    'room_list(含模式)'
  );
  const summary = listWithRoom.rooms.find((r) => r.code === host.joined.code);
  check(summary.mode === 'brawl', `房间列表带模式字段（实际 ${summary.mode}）`);

  const guest = await joinRoom('队员', host.joined.code);
  check(guest.joined.mode === 'brawl', '新加入的玩家同步当前模式');
  // 消费掉"有人加入"触发的 room_update，避免干扰后面的同步断言
  await waitForMsg(host.client, (m) => m.type === 'room_update' && m.players.length === 2, 'room_update(2人)');

  // ---------- 非房主修改 ----------
  send(guest.client, { type: 'set_mode', mode: 'classic' });
  const modeDenied = await waitForMsg(guest.client, (m) => m.type === 'error', 'error(非房主改模式)');
  check(/房主/.test(modeDenied.message), `非房主修改模式被拒绝：${modeDenied.message}`);

  send(guest.client, { type: 'set_kill_target', kills: 12 });
  const killsDenied = await waitForMsg(guest.client, (m) => m.type === 'error', 'error(非房主改击杀目标)');
  check(/房主/.test(killsDenied.message), `非房主修改击杀目标被拒绝：${killsDenied.message}`);

  send(guest.client, { type: 'set_win_score', score: 3 });
  const winDenied = await waitForMsg(guest.client, (m) => m.type === 'error', 'error(非房主改胜利分数)');
  check(/房主/.test(winDenied.message), `非房主修改胜利分数被拒绝：${winDenied.message}`);

  // ---------- 房主切换经典模式并设置胜利分数 ----------
  send(host.client, { type: 'set_mode', mode: 'classic' });
  const classicUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.mode === 'classic',
    'room_update(切经典)'
  );
  check(classicUpdate.winScore === 5, '切到经典模式后胜利分数仍是 5');
  await waitForMsg(guest.client, (m) => m.type === 'room_update' && m.mode === 'classic', 'room_update(经典同步)');
  check(true, '经典模式同步给所有玩家');

  // 经典模式下不能设置击杀目标
  send(host.client, { type: 'set_kill_target', kills: 12 });
  const wrongModeKills = await waitForMsg(host.client, (m) => m.type === 'error', 'error(经典改击杀)');
  check(/大乱斗/.test(wrongModeKills.message), `经典模式拒绝修改击杀目标：${wrongModeKills.message}`);

  send(host.client, { type: 'set_win_score', score: 7 });
  const winUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.mode === 'classic' && m.winScore === 7,
    'room_update(胜利分数)'
  );
  check(winUpdate.winScore === 7, '房主可把胜利分数改成 7');
  await waitForMsg(
    guest.client,
    (m) => m.type === 'room_update' && m.winScore === 7,
    'room_update(胜利分数同步)'
  );

  for (const [value, label] of [[0, '0'], [11, '11'], [3.5, '小数'], [true, '布尔'], [null, 'null'], ['abc', '非数字']]) {
    send(host.client, { type: 'set_win_score', score: value });
    const err = await waitForMsg(host.client, (m) => m.type === 'error', `error(胜利分数 ${label})`);
    check(/胜利分数/.test(err.message), `非法胜利分数 ${label} 被拒绝`);
  }

  // ---------- 切回大乱斗并设置击杀目标 ----------
  send(host.client, { type: 'set_mode', mode: 'brawl' });
  await waitForMsg(host.client, (m) => m.type === 'room_update' && m.mode === 'brawl', 'room_update(切大乱斗)');
  check(true, '可以切回大乱斗');

  for (const badMode of ['nope', 'constructor']) {
    send(host.client, { type: 'set_mode', mode: badMode });
    const err = await waitForMsg(host.client, (m) => m.type === 'error', `error(模式 ${badMode})`);
    check(/游戏模式/.test(err.message), `非法模式 ${badMode} 被拒绝`);
  }

  // 大乱斗模式下不能改经典胜利分数
  send(host.client, { type: 'set_win_score', score: 3 });
  const wrongModeWin = await waitForMsg(host.client, (m) => m.type === 'error', 'error(大乱斗改胜利分数)');
  check(/经典模式/.test(wrongModeWin.message), `大乱斗拒绝修改胜利分数：${wrongModeWin.message}`);

  send(host.client, { type: 'set_kill_target', kills: 7 });
  const killsUpdate = await waitForMsg(
    host.client,
    (m) => m.type === 'room_update' && m.mode === 'brawl' && m.killTarget === 7,
    'room_update(击杀目标)'
  );
  check(killsUpdate.killTarget === 7, '房主可把击杀目标改成 7');
  await waitForMsg(guest.client, (m) => m.type === 'room_update' && m.killTarget === 7, 'room_update(击杀目标同步)');

  for (const [value, label] of [[4, '4'], [31, '31'], [5.5, '小数'], [false, '布尔'], [null, 'null'], ['abc', '非数字']]) {
    send(host.client, { type: 'set_kill_target', kills: value });
    const err = await waitForMsg(host.client, (m) => m.type === 'error', `error(击杀目标 ${label})`);
    check(/击杀目标/.test(err.message), `非法击杀目标 ${label} 被拒绝`);
  }

  // ---------- 开局：game_start 带模式与目标 ----------
  send(host.client, { type: 'start_game' });
  const start = await waitForMsg(host.client, (m) => m.type === 'game_start', 'game_start');
  check(start.mode === 'brawl', `game_start 带模式（实际 ${start.mode}）`);
  check(start.killTarget === 7, `game_start 带击杀目标（实际 ${start.killTarget}）`);
  check(start.winScore === 7, `game_start 带经典胜利分数（实际 ${start.winScore}）`);
  check(start.respawnDelay === 10, `game_start 带复活等待（实际 ${start.respawnDelay}）`);

  // ---------- 对局中禁止修改 ----------
  send(host.client, { type: 'set_mode', mode: 'classic' });
  const inGameMode = await waitForMsg(host.client, (m) => m.type === 'error', 'error(对局中改模式)');
  check(/游戏进行中/.test(inGameMode.message), `对局中禁止修改模式：${inGameMode.message}`);

  send(host.client, { type: 'set_kill_target', kills: 8 });
  const inGameKills = await waitForMsg(host.client, (m) => m.type === 'error', 'error(对局中改击杀目标)');
  check(/游戏进行中/.test(inGameKills.message), `对局中禁止修改击杀目标：${inGameKills.message}`);

  await sleep(50);
  host.client.ws.close();
  guest.client.ws.close();
  observer.ws.close();

  if (failures.length) {
    console.error('BRAWL ROOM FAIL:', failures.join('; '));
    process.exit(1);
  }
  console.log('BRAWL ROOM OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('BRAWL ROOM ERROR:', e);
  process.exit(1);
});
