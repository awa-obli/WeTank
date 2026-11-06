'use strict';

// 7 人房间的端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 7 名玩家可以依次加入，第 8 人被拒绝且提示"最多7人"；
//   2. 7 人开局后 state 里有 7 辆坦克，出生格互不重复；
//   3. 出生保护：开局时接近 3 秒，开火会立即清零，未开火的玩家约 3 秒后归零。

const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://127.0.0.1:8080';
// 与服务端 SPAWN_PROTECT_TIME 保持一致（这里不 require server.js，避免测试连带的模块初始化）
const SPAWN_PROTECT_TIME = 3;
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

async function main() {
  const host = await connect();
  send(host, { type: 'create_room', name: '房主', roomName: '容量测试房' });
  const joined = await waitForMsg(host, (m) => m.type === 'joined', 'joined(房主)');
  const code = joined.code;

  const clients = [{ ...host, playerId: joined.playerId }];
  for (let i = 2; i <= 7; i++) {
    const c = await connect();
    send(c, { type: 'join_room', name: `队员${i}`, code });
    const j = await waitForMsg(c, (m) => m.type === 'joined', `joined(队员${i})`);
    clients.push({ ...c, playerId: j.playerId });
  }
  await waitForMsg(host, (m) => m.type === 'room_update' && m.players.length === 7, 'room_update(7人)');
  check(true, '7 名玩家可以依次加入');

  // ---------- 第 8 人被拒绝 ----------
  const extra = await connect();
  send(extra, { type: 'join_room', name: '第八人', code });
  const err = await waitForMsg(extra, (m) => m.type === 'error', 'error(满房)');
  check(/最多\s*7\s*人/.test(err.message), `第 8 人被拒绝：${err.message}`);
  extra.ws.close();

  // ---------- 开局 ----------
  const startedAt = Date.now();
  const states = [];
  host.ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'state') states.push(m);
    } catch (e) {
      // 忽略解析失败的消息
    }
  });

  send(host, { type: 'start_game' });
  const start = await waitForMsg(host, (m) => m.type === 'game_start', 'game_start');
  check(start.players.length === 7, `开局广播包含 7 名玩家（实际 ${start.players.length}）`);

  async function waitForState(predicate, label, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = states.find(predicate);
      if (found) return found;
      await sleep(15);
    }
    throw new Error(`等待 ${label} 超时`);
  }

  const cell = start.maze.cell;
  const first = await waitForState((m) => m.tanks.length === 7, 'state(7 辆坦克)');
  const cells = first.tanks.map((t) => `${Math.floor(t.x / cell)},${Math.floor(t.y / cell)}`);
  check(new Set(cells).size === 7, `7 人出生格互不重复（${new Set(cells).size}/7）`);
  check(
    first.tanks.every((t) => t.spawnProtect > SPAWN_PROTECT_TIME - 1 && t.spawnProtect <= SPAWN_PROTECT_TIME),
    `开局全员带出生保护（约 ${SPAWN_PROTECT_TIME} 秒）`
  );

  // ---------- 开火立即解除自己的保护，别人不受影响 ----------
  const shooter = clients[1];
  const bystander = clients[2];
  send(shooter, {
    type: 'input',
    keys: { forward: false, backward: false, left: false, right: false, shoot: true },
  });
  const fired = await waitForState((m) => {
    const s = m.tanks.find((t) => t.id === shooter.playerId);
    const o = m.tanks.find((t) => t.id === bystander.playerId);
    return s && o && s.spawnProtect === 0 && o.spawnProtect > 0;
  }, 'state(开火解除保护)', 2000);
  check(!!fired, '开火后自己的出生保护立即归零，其他人仍在保护期');
  send(shooter, {
    type: 'input',
    keys: { forward: false, backward: false, left: false, right: false, shoot: false },
  });

  // ---------- 约 3 秒后全员保护自然结束 ----------
  const elapsed = Date.now() - startedAt;
  await sleep(Math.max(0, SPAWN_PROTECT_TIME * 1000 + 600 - elapsed));
  const expired = await waitForState(
    (m) => m.tanks.length === 7 && m.tanks.every((t) => t.spawnProtect === 0),
    'state(保护全部过期)',
    3000
  );
  check(!!expired, `约 ${SPAWN_PROTECT_TIME} 秒后所有人的出生保护都归零`);

  for (const c of clients) c.ws.close();
  await sleep(200);

  if (failures.length > 0) {
    console.error(`\nCAPACITY FAIL (${failures.length}):`);
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log('\nCAPACITY OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('CAPACITY ERROR:', e);
  process.exit(1);
});
