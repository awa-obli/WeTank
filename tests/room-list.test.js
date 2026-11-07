'use strict';

// 房间列表的端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 建房必须带房间名，空房间名会被拒绝且不会产生房间；
//   2. room_list 包含房间名、房间码、当前人数、状态；
//   3. 列表不携带地图档位 / 初始血量等房间内设置；
//   4. 有人加入、离开、开局、最后一人退出时，列表实时更新。
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

// 轮询消息队列，取走第一条满足条件的消息（取走后不再重复匹配）。
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

async function main() {
  const observer = await connect();
  await waitForMsg(observer, (m) => m.type === 'room_list', '初始 room_list');

  // ---------- 空房间名被拒绝 ----------
  const invalid = await connect();
  send(invalid, { type: 'create_room', name: '无房间名' });
  const err = await waitForMsg(invalid, (m) => m.type === 'error', 'error(空房间名)');
  check(/房间名/.test(err.message), `空房间名被拒绝：${err.message}`);
  invalid.ws.close();

  // ---------- 建房：列表包含房间名 / 房间码 / 人数 ----------
  const host = await connect();
  send(host, { type: 'create_room', name: '房主', roomName: '周末欢乐局' });
  const joined = await waitForMsg(host, (m) => m.type === 'joined', 'joined(房主)');
  check(joined.roomName === '周末欢乐局', `joined 带房间名（实际 ${joined.roomName}）`);

  const one = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === joined.code),
    'room_list(1人)'
  );
  const room = one.rooms.find((r) => r.code === joined.code);
  check(room.name === '周末欢乐局', `列表显示房间名（实际 ${room.name}）`);
  check(room.playerCount === 1 && room.maxPlayers === 10, `列表显示人数（实际 ${room.playerCount}/${room.maxPlayers}）`);
  check(room.state === 'lobby', `列表显示等待状态（实际 ${room.state}）`);
  check(!Object.prototype.hasOwnProperty.call(room, 'mapSize') && !Object.prototype.hasOwnProperty.call(room, 'maxHp'),
    '列表不携带地图档位 / 初始血量');

  // ---------- 加入后人数更新 ----------
  const guest = await connect();
  send(guest, { type: 'join_room', name: '队员', code: joined.code });
  await waitForMsg(guest, (m) => m.type === 'joined', 'joined(队员)');
  const two = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === joined.code && r.playerCount === 2),
    'room_list(2人)'
  );
  check(two.rooms.find((r) => r.code === joined.code).playerCount === 2, '加入后列表人数变为 2');

  // ---------- 开局后状态变为 playing ----------
  send(host, { type: 'start_game' });
  await waitForMsg(host, (m) => m.type === 'game_start', 'game_start');
  const playing = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === joined.code && r.state === 'playing'),
    'room_list(游戏中)'
  );
  check(playing.rooms.find((r) => r.code === joined.code).state === 'playing', '开局后列表状态变为游戏中');

  // ---------- 离开后人数减少；最后一人离开后房间消失 ----------
  guest.ws.close();
  const backToOne = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === joined.code && r.playerCount === 1),
    'room_list(回到1人)'
  );
  check(backToOne.rooms.find((r) => r.code === joined.code).playerCount === 1, '离开后列表人数变为 1');

  host.ws.close();
  const empty = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && !m.rooms.some((r) => r.code === joined.code),
    'room_list(房间消失)'
  );
  check(!empty.rooms.some((r) => r.code === joined.code), '最后一人离开后房间从列表消失');

  observer.ws.close();
  await sleep(50);

  if (failures.length) {
    console.error('ROOM LIST FAIL:', failures.join('; '));
    process.exit(1);
  }
  console.log('ROOM LIST OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('ROOM LIST ERROR:', e);
  process.exit(1);
});
