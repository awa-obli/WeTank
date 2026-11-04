'use strict';

// 初始血量设置的端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 新房间默认 3 点，新加入的玩家同样能看到；
//   2. 非房主修改被拒绝，且不产生 room_update 广播；
//   3. 非法值（0、21、小数、布尔、null、非数字字符串）被拒绝；
//   4. 房主改成 1 / 20 / 8 后所有玩家同步；
//   5. 开局 game_start 带 maxHp，state 里每辆坦克都是满血；
//   6. 对局进行中不允许修改初始血量。
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
      // 忽略非 JSON 消息（不会出现，防御性处理）
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

// 轮询客户端收到的消息队列，取走第一条满足条件的消息（取走后不再重复匹配）。
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
  send(client, { type: 'create_room', name });
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
  const host = await createRoom('房主');
  check(host.joined.maxHp === 3, `新房默认初始血量是 3（实际 ${host.joined.maxHp}）`);

  const guest = await joinRoom('队员', host.joined.code);
  check(guest.joined.maxHp === 3, '新加入的玩家收到当前初始血量');
  // 先消费掉"有人加入"触发的 room_update，避免干扰后面的权限断言
  await waitForMsg(host.client, (m) => m.type === 'room_update' && m.players.length === 2, 'room_update(2人)');

  // ---------- 非房主修改 ----------
  send(guest.client, { type: 'set_hp', hp: 8 });
  const denied = await waitForMsg(guest.client, (m) => m.type === 'error', 'error(非房主)');
  check(/房主/.test(denied.message), `非房主修改血量被拒绝：${denied.message}`);

  await sleep(300);
  const leakedUpdate = host.client.messages.find((m) => m.type === 'room_update' && m.maxHp === 8);
  check(!leakedUpdate, '非房主修改没有产生 room_update 广播');

  // ---------- 非法值 ----------
  const invalids = [
    [0, '0'],
    [21, '21'],
    [3.5, '小数 3.5'],
    [true, '布尔 true'],
    [null, 'null'],
    ['abc', '非数字字符串'],
    ['', '空字符串'],
  ];
  for (const [value, label] of invalids) {
    send(host.client, { type: 'set_hp', hp: value });
    const err = await waitForMsg(host.client, (m) => m.type === 'error', `error(非法值 ${label})`);
    check(/1–20/.test(err.message), `非法血量（${label}）被拒绝：${err.message}`);
  }

  // ---------- 合法边界与同步 ----------
  for (const value of [1, 20, 8]) {
    send(host.client, { type: 'set_hp', hp: value });
    const updatedHost = await waitForMsg(host.client, (m) => m.type === 'room_update' && m.maxHp === value, `room_update(${value}, 房主)`);
    const updatedGuest = await waitForMsg(guest.client, (m) => m.type === 'room_update' && m.maxHp === value, `room_update(${value}, 队员)`);
    check(updatedHost.maxHp === value && updatedGuest.maxHp === value, `房主改成 ${value} 点后所有玩家同步`);
  }

  // ---------- 开局：game_start 带 maxHp，state 里全员满血 ----------
  send(host.client, { type: 'start_game' });
  const start = await waitForMsg(host.client, (m) => m.type === 'game_start', 'game_start');
  check(start.maxHp === 8, `game_start 里的初始血量是 8（实际 ${start.maxHp}）`);

  const state = await waitForMsg(
    host.client,
    (m) => m.type === 'state' && m.tanks.length === 2 && m.tanks.every((t) => t.hp === 8),
    'state(全员满血 8)'
  );
  check(state.tanks.every((t) => t.hp === 8 && t.alive), `开局 2 辆坦克血量都是 8/8（${state.tanks.map((t) => t.hp).join('/')}）`);

  // ---------- 对局中不允许修改 ----------
  send(host.client, { type: 'set_hp', hp: 5 });
  const midGame = await waitForMsg(host.client, (m) => m.type === 'error', 'error(游戏中)');
  check(/进行中/.test(midGame.message), `对局中修改血量被拒绝：${midGame.message}`);

  guest.client.ws.close();
  host.client.ws.close();
  await sleep(200);

  if (failures.length > 0) {
    console.error(`\nHP FAIL (${failures.length}):`);
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log('\nHP OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('HP ERROR:', e);
  process.exit(1);
});
