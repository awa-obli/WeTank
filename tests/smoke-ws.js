'use strict';

// 端到端冒烟测试：两个客户端建房/加入/开局，持续开火，
// 确认服务端在新反弹机制下正常出弹、广播状态、不崩溃。
const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://127.0.0.1:8080';

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitFor(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`等待 ${type} 超时`));
    }, timeoutMs);
    function onMsg(raw) {
      const msg = JSON.parse(raw);
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

(async () => {
  const c1 = await connect();
  c1.send(JSON.stringify({ type: 'create_room', name: '冒烟A', roomName: '冒烟测试房' }));
  const joined1 = await waitFor(c1, 'joined');
  const code = joined1.code;

  const c2 = await connect();
  send(c2, { type: 'join_room', name: '冒烟B', code });
  await waitFor(c2, 'joined');

  send(c1, { type: 'start_game' });
  const start = await waitFor(c1, 'game_start');
  const myId = joined1.playerId;

  let maxBullets = 0;
  let states = 0;
  const tracks = new Map(); // bulletId -> {x, y}
  let directionFlips = 0;
  let outOfBounds = 0;

  const onState = (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'state') return;
    states++;
    maxBullets = Math.max(maxBullets, msg.bullets.length);
    for (const b of msg.bullets) {
      const prev = tracks.get(b.id);
      if (prev) {
        const dx1 = b.x - prev.x;
        const dy1 = b.y - prev.y;
        if (prev.dx != null) {
          if (dx1 * prev.dx < 0 && Math.abs(dx1) > 0.5) directionFlips++;
          if (dy1 * prev.dy < 0 && Math.abs(dy1) > 0.5) directionFlips++;
        }
        prev.dx = dx1;
        prev.dy = dy1;
        prev.x = b.x;
        prev.y = b.y;
      } else {
        tracks.set(b.id, { x: b.x, y: b.y, dx: null, dy: null });
      }
      if (b.x < 0 || b.x > start.worldW || b.y < 0 || b.y > start.worldH) outOfBounds++;
    }
  };
  c1.on('message', onState);

  // 一边转一边打，扫过不同角度的墙
  const startAt = Date.now();
  const drive = setInterval(() => {
    const t = Date.now() - startAt;
    send(c1, {
      type: 'input',
      keys: {
        forward: t % 1200 < 600,
        backward: false,
        left: true,
        right: false,
        shoot: true,
      },
    });
  }, 120);

  await new Promise((r) => setTimeout(r, 7000));
  clearInterval(drive);
  send(c1, { type: 'input', keys: { forward: false, backward: false, left: false, right: false, shoot: false } });

  console.log(JSON.stringify({ room: code, myId, states, maxBullets, directionFlips, outOfBounds, bounceTracked: tracks.size }, null, 2));

  c1.close();
  c2.close();

  const failures = [];
  if (states < 60) failures.push(`状态广播太少: ${states}`);
  if (maxBullets < 1) failures.push('整局没有出现过子弹');
  if (directionFlips < 1) failures.push('没有观测到任何方向的反弹反转');
  if (outOfBounds > 0) failures.push(`子弹飞出世界: ${outOfBounds} 次`);

  if (failures.length) {
    console.error('SMOKE FAIL:', failures.join('; '));
    process.exit(1);
  }
  console.log('SMOKE OK');
  process.exit(0);
})().catch((e) => {
  console.error('SMOKE ERROR:', e);
  process.exit(1);
});
