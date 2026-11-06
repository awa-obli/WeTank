'use strict';

// 观战机制的端到端测试（需要先启动服务端，默认连 ws://127.0.0.1:8080）：
//   1. 游戏中的房间允许加入，但先进入观战席：joined.spectating === true；
//   2. 观战者收到当前迷宫的 game_start 快照和 state，但 state.tanks 里没有他；
//   3. 观战者的 input 不会产生坦克，也不影响对局；
//   4. 观战者离开后，正式玩家的 room_update 不再包含他；
//   5. 房间人数按"正式玩家 + 观战者"计算；
//   6. 整场比赛结束（这里用人数不足触发）时，观战者转正并进入 match_end 名单。
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

async function main() {
  const host = await connect();
  send(host, { type: 'create_room', name: '房主', roomName: '观战测试房' });
  const joinedHost = await waitForMsg(host, (m) => m.type === 'joined', 'joined(房主)');
  const code = joinedHost.code;
  check(joinedHost.spectating === false, '房主是正式玩家');

  const observer = await connect();
  await waitForMsg(observer, (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === code), 'room_list(初始)');

  const guest = await connect();
  send(guest, { type: 'join_room', name: '队员', code });
  await waitForMsg(guest, (m) => m.type === 'joined', 'joined(队员)');
  send(host, { type: 'start_game' });
  await waitForMsg(host, (m) => m.type === 'game_start', 'game_start(正式开局)');

  // ---------- 游戏中加入：观战席 ----------
  const spec = await connect();
  send(spec, { type: 'join_room', name: '观战者', code });
  const joinedSpec = await waitForMsg(spec, (m) => m.type === 'joined', 'joined(观战者)');
  check(joinedSpec.spectating === true, '游戏中的加入者进入观战状态');

  const specStart = await waitForMsg(spec, (m) => m.type === 'game_start', 'game_start(观战快照)');
  check(specStart.spectating === true, '观战快照标记 spectating');
  check(specStart.players.length === 2, `观战快照正式玩家数正确（实际 ${specStart.players.length}）`);
  check(specStart.spectators.some((s) => s.id === joinedSpec.playerId), '观战快照包含观战者自己');
  check(Boolean(specStart.maze && specStart.worldW > 0), '观战快照包含迷宫和世界尺寸');

  const specState = await waitForMsg(spec, (m) => m.type === 'state', 'state(观战快照)');
  check(specState.tanks.length === 2, `观战者收到的 state 只有 2 辆正式坦克（实际 ${specState.tanks.length}）`);
  check(specState.spectators.some((s) => s.id === joinedSpec.playerId), 'state 包含观战者名单');

  await waitForMsg(host, (m) => m.type === 'room_update' && m.spectators && m.spectators.length === 1, 'room_update(观战加入)');
  check(true, '正式玩家收到观战加入的 room_update');

  // 房间列表人数 = 正式玩家 + 观战者
  const listWithSpec = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === code && r.playerCount === 3),
    'room_list(含观战者)'
  );
  check(listWithSpec.rooms.find((r) => r.code === code).playerCount === 3, '房间列表人数包含观战者');

  // ---------- 观战者输入不应产生坦克 ----------
  send(spec, { type: 'input', keys: { forward: true, backward: false, left: false, right: false, shoot: true } });
  await sleep(180);
  const hostStates = host.messages.filter((m) => m.type === 'state');
  const latest = hostStates[hostStates.length - 1];
  check(Boolean(latest), '对局仍在广播 state');
  if (latest) {
    check(latest.tanks.length === 2, `观战者输入后仍是 2 辆坦克（实际 ${latest.tanks.length}）`);
    check(!latest.tanks.some((t) => t.id === joinedSpec.playerId), '观战者没有对应的坦克实体');
  }

  // ---------- 观战者离开：名单及时移除 ----------
  send(spec, { type: 'leave_room' });
  await waitForMsg(
    host,
    (m) => m.type === 'room_update' && m.spectators && m.spectators.length === 0,
    'room_update(观战离开)'
  );
  check(true, '观战者离开后正式玩家的房间名单不再包含他');
  const listAfterLeave = await waitForMsg(
    observer,
    (m) => m.type === 'room_list' && m.rooms.some((r) => r.code === code && r.playerCount === 2),
    'room_list(观战离开)'
  );
  check(listAfterLeave.rooms.find((r) => r.code === code).playerCount === 2, '观战者离开后列表人数恢复为 2');

  // ---------- 整场比赛结束时观战者转正 ----------
  const spec2 = await connect();
  send(spec2, { type: 'join_room', name: '观战者B', code });
  const joinedSpec2 = await waitForMsg(spec2, (m) => m.type === 'joined', 'joined(观战者B)');
  check(joinedSpec2.spectating === true, '第二名观战者同样先进入观战');
  await waitForMsg(spec2, (m) => m.type === 'game_start' && m.spectating === true, 'game_start(观战者B)');
  await waitForMsg(spec2, (m) => m.type === 'state', 'state(观战者B)');

  // 正式玩家只剩 1 人 -> 整场比赛提前结束，观战者 B 转正
  guest.ws.close();
  const matchEnd = await waitForMsg(spec2, (m) => m.type === 'match_end', 'match_end(观战转正)');
  check(matchEnd.spectators.length === 0, '比赛结束时观战席清空');
  check(matchEnd.scores.some((s) => s.id === joinedSpec2.playerId), 'match_end 名单包含转正后的观战者');
  const promotedUpdate = await waitForMsg(
    host,
    (m) => m.type === 'room_update' && m.players.some((p) => p.id === joinedSpec2.playerId) && m.spectators.length === 0,
    'room_update(观战转正)'
  );
  check(promotedUpdate.hostId === joinedHost.playerId, '转正后原房主保持不变');

  host.ws.close();
  spec.ws.close();
  spec2.ws.close();
  observer.ws.close();
  await sleep(80);

  if (failures.length) {
    console.error('SPECTATOR FAIL:', failures.join('; '));
    process.exit(1);
  }
  console.log('SPECTATOR OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('SPECTATOR ERROR:', e);
  process.exit(1);
});
