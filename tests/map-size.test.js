'use strict';

// 地图大小设置的端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 新房默认地图大小是 medium，新加入的玩家同样能看到
//   2. 非房主修改被拒绝，且不会产生 room_update 广播
//   3. 非法档位（包括 'constructor' 这种原型链 key）被拒绝
//   4. 房主修改后所有玩家同步到新档位
//   5. 开局广播的 worldW/worldH 和迷宫行列数与档位一致（large 与 small 两档都验）
//   6. 对局进行中不允许修改地图大小
//   7. 大地图里子弹不会飞出世界边界
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
  // ---------- 场景一：默认档位 + 权限 + 档位切换 ----------
  const host = await createRoom('房主');
  check(host.joined.mapSize === 'medium', `新房默认地图大小是 medium（实际 ${host.joined.mapSize}）`);

  const guest = await joinRoom('队员', host.joined.code);
  check(guest.joined.mapSize === 'medium', '新加入的玩家收到当前地图大小');
  // 先消费掉"有人加入"触发的 room_update，避免干扰后面的权限断言
  await waitForMsg(host.client, (m) => m.type === 'room_update' && m.players.length === 2, 'room_update(2人)');

  // 非房主修改
  send(guest.client, { type: 'set_map_size', size: 'large' });
  const denied = await waitForMsg(guest.client, (m) => m.type === 'error', 'error(非房主)');
  check(/房主/.test(denied.message), `非房主修改被拒绝：${denied.message}`);

  await sleep(300);
  const leakedUpdate = host.client.messages.find((m) => m.type === 'room_update' && m.mapSize === 'large');
  check(!leakedUpdate, '非房主修改没有产生 room_update 广播');

  // 非法档位
  send(host.client, { type: 'set_map_size', size: 'huge' });
  const invalid = await waitForMsg(host.client, (m) => m.type === 'error', 'error(非法档位)');
  check(/无效/.test(invalid.message), `非法档位被拒绝：${invalid.message}`);

  // 原型链上的 key 也不能绕过档位校验
  send(host.client, { type: 'set_map_size', size: 'constructor' });
  const protoKey = await waitForMsg(host.client, (m) => m.type === 'error', 'error(原型链 key)');
  check(/无效/.test(protoKey.message), `原型链 key 被拒绝：${protoKey.message}`);

  // 房主改成 large，双方都要收到更新
  send(host.client, { type: 'set_map_size', size: 'large' });
  const updateHost = await waitForMsg(host.client, (m) => m.type === 'room_update' && m.mapSize === 'large', 'room_update(large, 房主)');
  const updateGuest = await waitForMsg(guest.client, (m) => m.type === 'room_update' && m.mapSize === 'large', 'room_update(large, 队员)');
  check(updateHost.mapSize === 'large' && updateGuest.mapSize === 'large', '房主切换档位后所有玩家同步');

  // 开局：尺寸与迷宫行列数都应该是 large
  send(host.client, { type: 'start_game' });
  const start = await waitForMsg(host.client, (m) => m.type === 'game_start', 'game_start(large)');
  check(start.worldW === 1200 && start.worldH === 800, `large 世界尺寸 1200×800（实际 ${start.worldW}×${start.worldH}）`);
  check(start.maze.cols === 15 && start.maze.rows === 10, `large 迷宫行列数 15×10（实际 ${start.maze.cols}×${start.maze.rows}）`);
  check(start.maze.wallsV.length === 10 && start.maze.wallsV[0].length === 14, 'large wallsV 维度 rows×(cols-1)=10×14');
  check(start.maze.wallsH.length === 9 && start.maze.wallsH[0].length === 15, 'large wallsH 维度 (rows-1)×cols=9×15');

  // 对局中不允许修改
  send(host.client, { type: 'set_map_size', size: 'small' });
  const midGame = await waitForMsg(host.client, (m) => m.type === 'error', 'error(游戏中)');
  check(/进行中/.test(midGame.message), `对局中修改被拒绝：${midGame.message}`);

  // 大地图里持续开火，确认子弹不会越界
  let outOfBounds = 0;
  let maxBullets = 0;
  let states = 0;
  host.client.ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (msg.type !== 'state') return;
    states += 1;
    maxBullets = Math.max(maxBullets, msg.bullets.length);
    for (const b of msg.bullets) {
      if (b.x < 0 || b.x > start.worldW || b.y < 0 || b.y > start.worldH) outOfBounds += 1;
    }
  });

  const startedAt = Date.now();
  const drive = setInterval(() => {
    const t = Date.now() - startedAt;
    send(host.client, {
      type: 'input',
      keys: { forward: t % 1200 < 600, backward: false, left: true, right: false, shoot: true },
    });
  }, 120);
  await sleep(2500);
  clearInterval(drive);
  send(host.client, { type: 'input', keys: { forward: false, backward: false, left: false, right: false, shoot: false } });
  await sleep(150);

  check(states >= 30, `大图对局状态广播正常（${states} 帧）`);
  check(maxBullets >= 1, `大图对局正常出弹（最多同时 ${maxBullets} 发）`);
  check(outOfBounds === 0, `大图子弹没有越界（越界 ${outOfBounds} 次）`);

  guest.client.ws.close();
  host.client.ws.close();
  await sleep(200);

  // ---------- 场景二：小图档位同样生效 ----------
  const host2 = await createRoom('房主2');
  const guest2 = await joinRoom('队员2', host2.joined.code);
  await waitForMsg(host2.client, (m) => m.type === 'room_update' && m.players.length === 2, 'room_update(2人, 小图)');
  send(host2.client, { type: 'set_map_size', size: 'small' });
  await waitForMsg(host2.client, (m) => m.type === 'room_update' && m.mapSize === 'small', 'room_update(small)');
  send(host2.client, { type: 'start_game' });
  const start2 = await waitForMsg(host2.client, (m) => m.type === 'game_start', 'game_start(small)');
  check(start2.worldW === 720 && start2.worldH === 480, `small 世界尺寸 720×480（实际 ${start2.worldW}×${start2.worldH}）`);
  check(start2.maze.cols === 9 && start2.maze.rows === 6, `small 迷宫行列数 9×6（实际 ${start2.maze.cols}×${start2.maze.rows}）`);

  guest2.client.ws.close();
  host2.client.ws.close();
  await sleep(200);

  if (failures.length > 0) {
    console.error(`\nMAP SIZE FAIL (${failures.length}):`);
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log('\nMAP SIZE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('MAP SIZE ERROR:', e);
  process.exit(1);
});
