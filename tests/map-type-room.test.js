'use strict';

// 地图类型设置的端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 新房默认地图类型是 maze，新加入的玩家同样能看到
//   2. 非房主修改被拒绝，且不会产生 room_update 广播
//   3. 非法类型（包括 'constructor' 这种原型链 key）被拒绝
//   4. 房主修改后所有玩家同步；类型和大小互不影响
//   5. 开局广播的 mapType / mapLayout / 墙体数据与所选类型一致
//   6. 对局进行中不允许修改地图类型
//   7. random 开局会落到一个具体布局
const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://127.0.0.1:8080';
const CONCRETE_TYPES = ['maze', 'open', 'symmetric', 'scatter'];

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
  // ---------- 场景一：默认值 + 权限 + 类型切换 + 与大小独立 ----------
  const host = await createRoom('房主');
  check(host.joined.mapType === 'maze', `新房默认地图类型是 maze（实际 ${host.joined.mapType}）`);

  const guest = await joinRoom('队员', host.joined.code);
  check(guest.joined.mapType === 'maze', '新加入的玩家收到当前地图类型');
  await waitForMsg(host.client, (m) => m.type === 'room_update' && m.players.length === 2, 'room_update(2人)');

  // 非房主修改
  send(guest.client, { type: 'set_map_type', mapType: 'open' });
  const denied = await waitForMsg(guest.client, (m) => m.type === 'error', 'error(非房主)');
  check(/房主/.test(denied.message), `非房主修改被拒绝：${denied.message}`);

  await sleep(300);
  const leakedUpdate = host.client.messages.find((m) => m.type === 'room_update' && m.mapType === 'open');
  check(!leakedUpdate, '非房主修改没有产生 room_update 广播');

  // 非法类型
  send(host.client, { type: 'set_map_type', mapType: 'huge' });
  const invalid = await waitForMsg(host.client, (m) => m.type === 'error', 'error(非法类型)');
  check(/无效/.test(invalid.message), `非法类型被拒绝：${invalid.message}`);

  // 原型链上的 key 也不能绕过类型校验
  send(host.client, { type: 'set_map_type', mapType: 'constructor' });
  const protoKey = await waitForMsg(host.client, (m) => m.type === 'error', 'error(原型链 key)');
  check(/无效/.test(protoKey.message), `原型链 key 被拒绝：${protoKey.message}`);

  // 房主改成 open，双方都要收到更新
  send(host.client, { type: 'set_map_type', mapType: 'open' });
  const updateHost = await waitForMsg(host.client, (m) => m.type === 'room_update' && m.mapType === 'open', 'room_update(open, 房主)');
  const updateGuest = await waitForMsg(guest.client, (m) => m.type === 'room_update' && m.mapType === 'open', 'room_update(open, 队员)');
  check(updateHost.mapType === 'open' && updateGuest.mapType === 'open', '房主切换类型后所有玩家同步');

  // 类型和大小互不影响：改成 large 后，类型仍然是 open
  send(host.client, { type: 'set_map_size', size: 'large' });
  const sizeUpdate = await waitForMsg(host.client, (m) => m.type === 'room_update' && m.mapSize === 'large', 'room_update(large)');
  check(sizeUpdate.mapType === 'open', `改地图大小不影响类型（实际 ${sizeUpdate.mapType}）`);

  // 开局：large + open
  send(host.client, { type: 'start_game' });
  const start = await waitForMsg(host.client, (m) => m.type === 'game_start', 'game_start(large/open)');
  check(start.mapType === 'open', `game_start 带地图类型 open（实际 ${start.mapType}）`);
  check(start.mapLayout === 'open', `game_start 带具体布局 open（实际 ${start.mapLayout}）`);
  check(start.worldW === 1200 && start.worldH === 800, `large 世界尺寸 1200×800（实际 ${start.worldW}×${start.worldH}）`);
  const noVerticalWalls = start.maze.wallsV.every((row) => row.every((w) => w === false));
  const noHorizontalWalls = start.maze.wallsH.every((row) => row.every((w) => w === false));
  check(noVerticalWalls && noHorizontalWalls, '空旷图开局没有任何内墙');

  // 对局中不允许修改
  send(host.client, { type: 'set_map_type', mapType: 'scatter' });
  const midGame = await waitForMsg(host.client, (m) => m.type === 'error', 'error(游戏中)');
  check(/进行中/.test(midGame.message), `对局中修改被拒绝：${midGame.message}`);

  guest.client.ws.close();
  host.client.ws.close();
  await sleep(200);

  // ---------- 场景二：散块 / 对称 / 随机 ----------
  const host2 = await createRoom('房主2');
  const guest2 = await joinRoom('队员2', host2.joined.code);
  await waitForMsg(host2.client, (m) => m.type === 'room_update' && m.players.length === 2, 'room_update(2人, 场景二)');

  send(host2.client, { type: 'set_map_type', mapType: 'scatter' });
  await waitForMsg(host2.client, (m) => m.type === 'room_update' && m.mapType === 'scatter', 'room_update(scatter)');
  send(host2.client, { type: 'start_game' });
  const scatterStart = await waitForMsg(host2.client, (m) => m.type === 'game_start', 'game_start(scatter)');
  const scatterWalls = scatterStart.maze.wallsV.flat().filter(Boolean).length
    + scatterStart.maze.wallsH.flat().filter(Boolean).length;
  check(scatterStart.mapType === 'scatter' && scatterStart.mapLayout === 'scatter', '散块图开局类型正确');
  check(scatterWalls > 0, `散块图确实有短墙（${scatterWalls} 条）`);

  guest2.client.ws.close();
  host2.client.ws.close();
  await sleep(200);

  // 随机：房间设置保持 random，但开局必须落到一个具体布局
  const host3 = await createRoom('房主3');
  const guest3 = await joinRoom('队员3', host3.joined.code);
  await waitForMsg(host3.client, (m) => m.type === 'room_update' && m.players.length === 2, 'room_update(2人, 随机)');
  send(host3.client, { type: 'set_map_type', mapType: 'random' });
  await waitForMsg(host3.client, (m) => m.type === 'room_update' && m.mapType === 'random', 'room_update(random)');
  send(host3.client, { type: 'start_game' });
  const randomStart = await waitForMsg(host3.client, (m) => m.type === 'game_start', 'game_start(random)');
  check(randomStart.mapType === 'random', `random 房间设置的 mapType 保持 random（实际 ${randomStart.mapType}）`);
  check(CONCRETE_TYPES.includes(randomStart.mapLayout), `random 开局落到具体布局（实际 ${randomStart.mapLayout}）`);

  guest3.client.ws.close();
  host3.client.ws.close();
  await sleep(200);

  if (failures.length > 0) {
    console.error(`\nMAP TYPE FAIL (${failures.length}):`);
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log('\nMAP TYPE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('MAP TYPE ERROR:', e);
  process.exit(1);
});
