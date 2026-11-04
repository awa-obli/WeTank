'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const physics = require('./physics');

// ---------- 常量配置 ----------
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const COLS = 12;
const ROWS = 8;
const CELL = 80;
const WALL_THICK = 10;
const WORLD_W = COLS * CELL; // 960
const WORLD_H = ROWS * CELL; // 640

const TANK_RADIUS = 15;
const TANK_SPEED = 100;       // 前进 px/s
const TANK_REVERSE_SPEED = 100; // 后退 px/s
const TANK_ROT_SPEED = 4.0;   // rad/s

const BULLET_RADIUS = 4;
const BULLET_SPEED = 150;
const BULLET_LIFETIME = 10; // 子弹存活时间(秒)，超过后自动消失，不再按反弹次数限制
const MAX_BULLETS_PER_PLAYER = 5;
const SHOOT_COOLDOWN = 0.25;
const BULLET_OWNER_GRACE = 0.1; // 出生后一小段时间内不会打到自己

const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const ROUND_RESTART_DELAY = 3000; // ms

// 子弹每帧的位移(BULLET_SPEED*DT ≈ 10.7px)可能大于墙体厚度(WALL_THICK=10px)。
// 现在墙体碰撞用的是"圆扫掠"连续检测（见 physics.js），沿子步的整段位移求
// 最早接触点，本身就不会跨过墙体；这里的子步主要用于让子弹与坦克的命中判定
// 保持细粒度，并限制单次解算的位移上限。
const BULLET_MAX_STEP = 3; // 每个子步最大位移(px)，需明显小于 WALL_THICK
const BULLET_SUBSTEPS = Math.max(1, Math.ceil((BULLET_SPEED * DT) / BULLET_MAX_STEP));
const BULLET_SUB_DT = DT / BULLET_SUBSTEPS;
const WIN_SCORE = 5;

const PLAYER_COLORS = ['#E63946', '#3A86FF', '#FFD60A', '#06D6A0'];
const MAX_PLAYERS = 4;

// ---------- 道具系统 ----------
const ITEM_TYPES = ['shield', 'speed', 'triple', 'homing', 'invisible'];
const ITEM_SPAWN_INTERVAL = 15; // 秒，场上无论有多少道具，每隔这么久固定刷新一个新的
const ITEM_RADIUS = 14; // 拾取判定半径（视觉半径同用这个）
const SPEED_BOOST_DURATION = 6; // 秒
const SPEED_BOOST_MULT = 1.5; // 移动 & 转向速度倍率
const TRIPLE_SPREAD_RAD = (12 * Math.PI) / 180; // 三连发扇形半张角
const HOMING_TURN_RATE = 3; // rad/s，追踪弹每秒最多能修正的转向角速度
const INVISIBLE_DURATION = 8; // 秒，隐身持续时间

const SPAWN_CELLS = [
  { r: 0, c: 0 },
  { r: ROWS - 1, c: COLS - 1 },
  { r: 0, c: COLS - 1 },
  { r: ROWS - 1, c: 0 },
];

// ---------- 房间存储 ----------
/** @type {Map<string, Room>} */
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

// 在网格里随机挑一个格子的中心点作为道具生成位置。
// 墙体都生成在格子的边界上（见 generateMaze），格子中心永远是空地，不用再做碰撞检测。
// 尽量避开已经放了道具的格子，避免两个道具重叠在同一个点；
// 格子数量有限，找不到空位时就放弃这次尝试，等下一轮 15 秒再刷。
function pickRandomItemCell(occupiedCells) {
  const maxTries = 20;
  for (let i = 0; i < maxTries; i++) {
    const r = Math.floor(Math.random() * ROWS);
    const c = Math.floor(Math.random() * COLS);
    const key = `${r},${c}`;
    if (!occupiedCells.has(key)) {
      return { r, c, x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 };
    }
  }
  return null;
}

// ---------- 迷宫生成 ----------
// wallsV[r][c] = 第 c 列和第 c+1 列之间(在第 r 行)是否有墙, c: 0..COLS-2
// wallsH[r][c] = 第 r 行和第 r+1 行之间(在第 c 列)是否有墙, r: 0..ROWS-2
function generateMaze() {
  const wallsV = Array.from({ length: ROWS }, () => Array(COLS - 1).fill(true));
  const wallsH = Array.from({ length: ROWS - 1 }, () => Array(COLS).fill(true));
  const visited = Array.from({ length: ROWS }, () => Array(COLS).fill(false));

  function neighbors(r, c) {
    const list = [];
    if (r > 0) list.push([r - 1, c, 'H', r - 1, c]);
    if (r < ROWS - 1) list.push([r + 1, c, 'H', r, c]);
    if (c > 0) list.push([r, c - 1, 'V', r, c - 1]);
    if (c < COLS - 1) list.push([r, c + 1, 'V', r, c]);
    return list;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // 随机深度优先(迭代栈)生成完美迷宫
  const stack = [[0, 0]];
  visited[0][0] = true;
  while (stack.length > 0) {
    const [r, c] = stack[stack.length - 1];
    const opts = shuffle(neighbors(r, c)).filter(([nr, nc]) => !visited[nr][nc]);
    if (opts.length === 0) {
      stack.pop();
      continue;
    }
    const [nr, nc, orient, wr, wc] = opts[0];
    if (orient === 'H') wallsH[wr][wc] = false;
    else wallsV[wr][wc] = false;
    visited[nr][nc] = true;
    stack.push([nr, nc]);
  }

  // 打通一些额外的墙，制造环路，避免纯树形死胡同太多
  const extraRemovals = Math.floor(COLS * ROWS * 0.12);
  for (let i = 0; i < extraRemovals; i++) {
    if (Math.random() < 0.5) {
      const r = Math.floor(Math.random() * ROWS);
      const c = Math.floor(Math.random() * (COLS - 1));
      wallsV[r][c] = false;
    } else {
      const r = Math.floor(Math.random() * (ROWS - 1));
      const c = Math.floor(Math.random() * COLS);
      wallsH[r][c] = false;
    }
  }

  // 保证出生角落附近至少有一点开阔空间（去掉出生格相邻的一条墙，防止被困死）
  for (const { r, c } of SPAWN_CELLS) {
    if (c < COLS - 1) wallsV[r][c] = false;
    else if (c > 0) wallsV[r][c - 1] = false;
  }

  // 转换为矩形墙体列表，用于碰撞检测
  const rects = [];
  const OVERLAP = WALL_THICK / 2;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      if (wallsV[r][c]) {
        rects.push({
          cx: (c + 1) * CELL,
          cy: r * CELL + CELL / 2,
          hw: WALL_THICK / 2,
          hh: CELL / 2 + OVERLAP,
        });
      }
    }
  }
  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS; c++) {
      if (wallsH[r][c]) {
        rects.push({
          cx: c * CELL + CELL / 2,
          cy: (r + 1) * CELL,
          hw: CELL / 2 + OVERLAP,
          hh: WALL_THICK / 2,
        });
      }
    }
  }

  // 外边界
  rects.push({ cx: WORLD_W / 2, cy: 0, hw: WORLD_W / 2 + WALL_THICK, hh: WALL_THICK / 2 });
  rects.push({ cx: WORLD_W / 2, cy: WORLD_H, hw: WORLD_W / 2 + WALL_THICK, hh: WALL_THICK / 2 });
  rects.push({ cx: 0, cy: WORLD_H / 2, hw: WALL_THICK / 2, hh: WORLD_H / 2 + WALL_THICK });
  rects.push({ cx: WORLD_W, cy: WORLD_H / 2, hw: WALL_THICK / 2, hh: WORLD_H / 2 + WALL_THICK });

  return { rects, wallsV, wallsH };
}

// ---------- 碰撞辅助 ----------
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ---------- 房间类 ----------
class Room {
  constructor(code) {
    this.code = code;
    this.hostId = null;
    this.players = new Map(); // id -> player
    this.state = 'lobby'; // lobby | playing | round_pending | round_over
    this.maze = null;
    this.bullets = [];
    this.tickHandle = null;
    this.nextBulletId = 1;
    this.pendingWinnerId = null; // 只剩最后一人存活时，先记下这个人是谁，等 5 秒观察期结束再真正判定
    this.pendingTimeout = null;  // 5 秒观察期的定时器句柄
    this.joinCounter = 0; // 按加入顺序递增，用来给没填昵称的玩家生成"玩家 N"这样的默认名
    this.items = []; // 场上道具：{ id, type, x, y }
    this.nextItemId = 1;
    this.itemSpawnAcc = 0; // 距离上次刷新道具经过的秒数，累计到 ITEM_SPAWN_INTERVAL 就刷一个
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    }
  }

  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score,
      connected: true,
    }));
  }

  assignColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[0];
  }

  startMatch() {
    for (const p of this.players.values()) p.score = 0;
    this.state = 'playing';
    this.startRound();
  }

  startRound() {
    this.maze = generateMaze();
    this.bullets = [];
    this.items = [];
    this.itemSpawnAcc = 0;
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
    this.pendingWinnerId = null;
    const ids = [...this.players.keys()];
    ids.forEach((id, i) => {
      const p = this.players.get(id);
      const cell = SPAWN_CELLS[i % SPAWN_CELLS.length];
      p.x = cell.c * CELL + CELL / 2;
      p.y = cell.r * CELL + CELL / 2;
      p.angle = Math.atan2(WORLD_H / 2 - p.y, WORLD_W / 2 - p.x);
      p.alive = true;
      p.cooldown = 0;
      p.input = { forward: false, backward: false, left: false, right: false, shoot: false };
      p.shield = false;
      p.speedBoostRemaining = 0;
      p.tripleReady = false;
      p.homingReady = false;
      p.invisibleRemaining = 0;
    });

    this.broadcast({
      type: 'game_start',
      maze: { wallsV: this.maze.wallsV, wallsH: this.maze.wallsH, cell: CELL, cols: COLS, rows: ROWS, wallThick: WALL_THICK },
      players: this.playerList(),
      worldW: WORLD_W,
      worldH: WORLD_H,
    });

    if (!this.tickHandle) {
      this.tickHandle = setInterval(() => this.tick(), 1000 / TICK_RATE);
    }
  }

  tick() {
    if (this.state !== 'playing' && this.state !== 'round_pending') return;
    const alivePlayers = [...this.players.values()].filter((p) => p.alive);

    // --- 坦克移动 ---
    for (const p of alivePlayers) {
      const input = p.input;

      // 加速道具：剩余时间在这里统一倒计时，倒计时期间移动/转向速度按倍率放大
      if (p.speedBoostRemaining > 0) {
        p.speedBoostRemaining = Math.max(0, p.speedBoostRemaining - DT);
      }
      const speedMult = p.speedBoostRemaining > 0 ? SPEED_BOOST_MULT : 1;

      // 隐身道具：剩余时间倒计时，只影响其他玩家客户端的渲染（服务端逻辑不受影响）
      if (p.invisibleRemaining > 0) {
        p.invisibleRemaining = Math.max(0, p.invisibleRemaining - DT);
      }

      let rot = 0;
      if (input.left) rot -= TANK_ROT_SPEED * speedMult * DT;
      if (input.right) rot += TANK_ROT_SPEED * speedMult * DT;
      p.angle += rot;

      let speed = 0;
      if (input.forward) speed = TANK_SPEED * speedMult;
      else if (input.backward) speed = -TANK_REVERSE_SPEED * speedMult;

      if (speed !== 0) {
        const dx = Math.cos(p.angle) * speed * DT;
        const dy = Math.sin(p.angle) * speed * DT;
        this.moveTankAxis(p, dx, 0);
        this.moveTankAxis(p, 0, dy);
      }

      // 射击
      p.cooldown = Math.max(0, p.cooldown - DT);
      const aliveBulletCount = this.bullets.filter((b) => b.owner === p.id).length;
      if (input.shoot && p.cooldown <= 0 && aliveBulletCount < MAX_BULLETS_PER_PLAYER) {
        // 三连发道具：拾取后下一次射击打出扇形三发子弹，用一次就消耗掉；
        // 不是"充能次数"，触发一次后立即回落为普通单发。
        const useTriple = p.tripleReady;
        const useHoming = p.homingReady;
        const angles = useTriple
          ? [p.angle - TRIPLE_SPREAD_RAD, p.angle, p.angle + TRIPLE_SPREAD_RAD]
          : [p.angle];
        for (const shotAngle of angles) {
          const bx = p.x + Math.cos(shotAngle) * (TANK_RADIUS + BULLET_RADIUS + 2);
          const by = p.y + Math.sin(shotAngle) * (TANK_RADIUS + BULLET_RADIUS + 2);
          this.bullets.push({
            id: this.nextBulletId++,
            owner: p.id,
            x: bx,
            y: by,
            vx: Math.cos(shotAngle) * BULLET_SPEED,
            vy: Math.sin(shotAngle) * BULLET_SPEED,
            bounces: 0,
            age: 0,
            homing: useHoming,
          });
        }
        if (useTriple) p.tripleReady = false;
        if (useHoming) p.homingReady = false;
        p.cooldown = SHOOT_COOLDOWN;
      }
    }

    // 坦克各自移动完之后，再统一处理坦克间的重叠：谁都不允许穿过谁，
    // 而是互相往对方相反方向各推开重叠量的一半，做出"推挤"的手感。
    this.resolveTankCollisions(alivePlayers);

    // --- 道具刷新 ---
    // 不管场上现在有几个道具、也不管是不是处于残局观察期，每隔 ITEM_SPAWN_INTERVAL 秒
    // 都固定刷新一个新道具，全局节奏统一，不做数量上限。
    this.itemSpawnAcc += DT;
    if (this.itemSpawnAcc >= ITEM_SPAWN_INTERVAL) {
      this.itemSpawnAcc -= ITEM_SPAWN_INTERVAL;
      const occupied = new Set(this.items.map((it) => `${it.cellR},${it.cellC}`));
      const cell = pickRandomItemCell(occupied);
      if (cell) {
        this.items.push({
          id: this.nextItemId++,
          type: ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)],
          x: cell.x,
          y: cell.y,
          cellR: cell.r,
          cellC: cell.c,
        });
      }
    }

    // --- 道具拾取 ---
    // 碰撞即拾取即生效，不做背包；同一帧可以同时拾到多个道具。
    // 护盾和三连发存在不同的字段里，天然可以同时生效、互不覆盖；
    // 三连发是布尔态"是否就绪"，重复拾取不会叠加效果，再次拾取只是保持就绪。
    const pickups = [];
    if (this.items.length > 0) {
      const remainingItems = [];
      for (const it of this.items) {
        let takenBy = null;
        for (const p of alivePlayers) {
          const dx = p.x - it.x;
          const dy = p.y - it.y;
          if (dx * dx + dy * dy < (TANK_RADIUS + ITEM_RADIUS) * (TANK_RADIUS + ITEM_RADIUS)) {
            takenBy = p;
            break;
          }
        }
        if (takenBy) {
          if (it.type === 'shield') takenBy.shield = true;
          else if (it.type === 'speed') takenBy.speedBoostRemaining = SPEED_BOOST_DURATION;
          else if (it.type === 'triple') { takenBy.tripleReady = true; takenBy.homingReady = false; }
          else if (it.type === 'homing') { takenBy.homingReady = true; takenBy.tripleReady = false; }
          else if (it.type === 'invisible') takenBy.invisibleRemaining = INVISIBLE_DURATION;
          pickups.push({ playerId: takenBy.id, type: it.type, x: it.x, y: it.y });
        } else {
          remainingItems.push(it);
        }
      }
      this.items = remainingItems;
    }
    if (pickups.length > 0) {
      this.broadcast({ type: 'item_pickup', pickups });
    }

    // --- 子弹移动与碰撞 ---
    // 每个子步调用 physics.stepBullet：它沿子步位移做"圆扫掠"连续检测，
    // 只取最早接触点、按矩形面的法线反射（法线只可能是四个面之一，
    // 旋转后的墙也适用），并且能在一次调用里处理连续多次反弹。子步本身保证坦克命中判定的粒度。
    const survivingBullets = [];
    for (const b of this.bullets) {
      b.age += DT;

      // 追踪弹：每帧朝当前最近的存活敌方坦克小幅修正飞行方向（限速转向，
      // 不是瞬间锁死），速度大小保持不变，所以拐弯躲开是甩得掉的。
      if (b.homing) {
        let target = null;
        let bestDist2 = Infinity;
        for (const p of alivePlayers) {
          if (p.id === b.owner) continue;
          const ddx = p.x - b.x;
          const ddy = p.y - b.y;
          const dist2 = ddx * ddx + ddy * ddy;
          if (dist2 < bestDist2) {
            bestDist2 = dist2;
            target = p;
          }
        }
        if (target) {
          const curAngle = Math.atan2(b.vy, b.vx);
          const desiredAngle = Math.atan2(target.y - b.y, target.x - b.x);
          let diff = desiredAngle - curAngle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const maxTurn = HOMING_TURN_RATE * DT;
          diff = Math.max(-maxTurn, Math.min(maxTurn, diff));
          const newAngle = curAngle + diff;
          const speed = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(newAngle) * speed;
          b.vy = Math.sin(newAngle) * speed;
        }
      }

      // 存活时间到了就自动消失，不再看反弹了多少次
      let dead = b.age >= BULLET_LIFETIME;

      for (let s = 0; s < BULLET_SUBSTEPS && !dead; s++) {
        const step = physics.stepBullet(b, BULLET_RADIUS, BULLET_SUB_DT, this.maze.rects);
        if (step.stuck) {
          // 子弹卡死在墙体几何里（正常飞行不会出现，多见于极端出生位置），
          // 直接移除，避免它从墙里穿出去。
          dead = true;
          break;
        }

        for (const p of alivePlayers) {
          if (b.owner === p.id && b.age < BULLET_OWNER_GRACE) continue;
          const ddx = b.x - p.x;
          const ddy = b.y - p.y;
          if (ddx * ddx + ddy * ddy < (BULLET_RADIUS + TANK_RADIUS) * (BULLET_RADIUS + TANK_RADIUS)) {
            if (p.shield) {
              // 护盾挡下这一发：护盾消耗掉，子弹消失，但坦克本身不算阵亡
              p.shield = false;
            } else {
              p.alive = false;
              p.lastHitBy = b.owner;
            }
            dead = true;
            break;
          }
        }
      }

      if (!dead) survivingBullets.push(b);
    }
    this.bullets = survivingBullets;

    // --- 广播状态 ---
    this.broadcast({
      type: 'state',
      tanks: [...this.players.values()].map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        angle: p.angle,
        alive: p.alive,
        color: p.color,
        name: p.name,
        shield: p.shield,
        speedBoost: p.speedBoostRemaining > 0,
        tripleReady: p.tripleReady,
        homingReady: p.homingReady,
        invisible: p.invisibleRemaining > 0,
      })),
      bullets: this.bullets.map((b) => ({ id: b.id, x: b.x, y: b.y, owner: b.owner, homing: b.homing })),
      items: this.items.map((it) => ({ id: it.id, type: it.type, x: it.x, y: it.y })),
    });

    // --- 回合结束判断 ---
    // 只剩 1 人（或恰好 0 人，双方同归于尽）存活时不立即结束回合，而是进入 5 秒观察期：
    // 一方面给死亡爆炸特效留出播放时间，另一方面场上可能还有飞行中的子弹，
    // 如果这 5 秒内"最后一人"也被打死了，就直接判定平局（不给任何人加分），
    // 而不是提前一步就宣布他获胜。
    const total = this.players.size;
    const stillAlive = [...this.players.values()].filter((p) => p.alive);

    if (this.state === 'playing' && total >= 2 && stillAlive.length <= 1) {
      this.state = 'round_pending';
      this.pendingWinnerId = stillAlive.length === 1 ? stillAlive[0].id : null;
      this.pendingTimeout = setTimeout(() => {
        this.pendingTimeout = null;
        if (this.state !== 'round_pending') return; // 已经因为平局提前结束了
        const winner = this.pendingWinnerId ? this.players.get(this.pendingWinnerId) : null;
        this.endRound(winner || null);
      }, 5000);
    } else if (this.state === 'round_pending' && this.pendingWinnerId) {
      const w = this.players.get(this.pendingWinnerId);
      if (!w || !w.alive) {
        // 观察期内，原本"存活的最后一人"也阵亡了：把待定结果改成平局，
        // 但不重开计时器——沿用进入观察期时就已经开始的那个 5 秒倒计时，
        // 时间到了之后 pendingWinnerId 已经是 null，自然就会按平局结算。
        this.pendingWinnerId = null;
      }
    }
  }

  moveTankAxis(p, dx, dy) {
    const nx = p.x + dx;
    const ny = p.y + dy;
    for (const rect of this.maze.rects) {
      if (physics.circleRectOverlap(nx, ny, TANK_RADIUS, rect)) {
        return; // 该轴方向被阻挡，放弃这次移动
      }
    }
    p.x = clamp(nx, TANK_RADIUS, WORLD_W - TANK_RADIUS);
    p.y = clamp(ny, TANK_RADIUS, WORLD_H - TANK_RADIUS);
  }

  // 坦克间的推挤碰撞：两两检测圆形重叠，重叠时沿两车圆心连线方向各退半步。
  // 复用 moveTankAxis 逐轴移动，这样推挤时依然会被墙体挡住，不会把对方顶进墙里；
  // 多组坦克同时挤在一起时单次求解不够，所以跑几轮迭代让重叠量收敛得更干净。
  resolveTankCollisions(alivePlayers) {
    const minDist = TANK_RADIUS * 2;
    const iterations = 3;
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < alivePlayers.length; i++) {
        for (let j = i + 1; j < alivePlayers.length; j++) {
          const a = alivePlayers[i];
          const b = alivePlayers[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.hypot(dx, dy);
          if (dist >= minDist) continue;
          if (dist < 0.0001) {
            // 极端情况下两车中心完全重合，随便指定一个方向把它们分开，避免除以 0
            dx = 1;
            dy = 0;
            dist = 1;
          }
          const overlap = minDist - dist;
          const nx = dx / dist;
          const ny = dy / dist;
          const pushX = (nx * overlap) / 2;
          const pushY = (ny * overlap) / 2;
          this.moveTankAxis(a, -pushX, 0);
          this.moveTankAxis(a, 0, -pushY);
          this.moveTankAxis(b, pushX, 0);
          this.moveTankAxis(b, 0, pushY);
        }
      }
    }
  }

  endRound(winner) {
    this.state = 'round_over';
    if (winner) winner.score += 1;

    const scores = this.playerList();
    this.broadcast({ type: 'round_end', winnerId: winner ? winner.id : null, scores });

    const champion = scores.find((s) => s.score >= WIN_SCORE);
    setTimeout(() => {
      if (!rooms.has(this.code)) return; // 房间已销毁
      if (champion) {
        this.state = 'lobby';
        this.broadcast({ type: 'match_end', winnerId: champion.id, scores: this.playerList() });
      } else if (this.players.size >= 2) {
        this.state = 'playing';
        this.startRound();
      } else {
        this.state = 'lobby';
      }
    }, ROUND_RESTART_DELAY);
  }

  stopTicking() {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
  }
}

// ---------- HTTP 静态文件服务 ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let currentRoom = null;
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'create_room') {
      const code = makeRoomCode();
      const room = new Room(code);
      rooms.set(code, room);
      room.joinCounter += 1;
      const name = sanitizeName(msg.name, room.joinCounter);
      playerId = makeId();
      const player = {
        id: playerId, name, ws, color: room.assignColor(),
        score: 0, x: 0, y: 0, angle: 0, alive: true, cooldown: 0,
        input: { forward: false, backward: false, left: false, right: false, shoot: false },
        shield: false, speedBoostRemaining: 0, tripleReady: false, homingReady: false, invisibleRemaining: 0,
      };
      room.players.set(playerId, player);
      room.hostId = playerId;
      currentRoom = room;
      ws.send(JSON.stringify({ type: 'joined', code, playerId, hostId: room.hostId, players: room.playerList() }));
      return;
    }

    if (msg.type === 'join_room') {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: '房间不存在，请检查房间码' }));
        return;
      }
      if (room.players.size >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', message: '房间已满（最多4人）' }));
        return;
      }
      if (room.state === 'playing' || room.state === 'round_pending') {
        ws.send(JSON.stringify({ type: 'error', message: '该房间正在游戏中，请等待本局结束' }));
        return;
      }
      room.joinCounter += 1;
      const name = sanitizeName(msg.name, room.joinCounter);
      playerId = makeId();
      const player = {
        id: playerId, name, ws, color: room.assignColor(),
        score: 0, x: 0, y: 0, angle: 0, alive: true, cooldown: 0,
        input: { forward: false, backward: false, left: false, right: false, shoot: false },
        shield: false, speedBoostRemaining: 0, tripleReady: false, homingReady: false, invisibleRemaining: 0,
      };
      room.players.set(playerId, player);
      currentRoom = room;
      ws.send(JSON.stringify({ type: 'joined', code, playerId, hostId: room.hostId, players: room.playerList() }));
      room.broadcast({ type: 'room_update', hostId: room.hostId, players: room.playerList() });
      return;
    }

    if (!currentRoom || !playerId) return;

    if (msg.type === 'start_game') {
      if (currentRoom.hostId !== playerId) return;
      if (currentRoom.players.size < 2) {
        ws.send(JSON.stringify({ type: 'error', message: '至少需要2名玩家才能开始' }));
        return;
      }
      currentRoom.startMatch();
      return;
    }

    if (msg.type === 'input') {
      const p = currentRoom.players.get(playerId);
      if (!p || !msg.keys) return;
      p.input = {
        forward: !!msg.keys.forward,
        backward: !!msg.keys.backward,
        left: !!msg.keys.left,
        right: !!msg.keys.right,
        shoot: !!msg.keys.shoot,
      };
      return;
    }

    if (msg.type === 'leave_room') {
      handleLeave();
      return;
    }
  });

  ws.on('close', handleLeave);

  function handleLeave() {
    if (!currentRoom || !playerId) return;
    const room = currentRoom;
    room.players.delete(playerId);

    if (room.players.size === 0) {
      room.stopTicking();
      rooms.delete(room.code);
    } else {
      if (room.hostId === playerId) {
        room.hostId = [...room.players.keys()][0];
      }
      room.broadcast({ type: 'room_update', hostId: room.hostId, players: room.playerList() });
      if ((room.state === 'playing' || room.state === 'round_pending') && room.players.size < 2) {
        room.stopTicking();
        room.state = 'lobby';
        room.broadcast({ type: 'match_end', winnerId: null, scores: room.playerList(), reason: 'not_enough_players' });
      }
    }
    currentRoom = null;
    playerId = null;
  }
});

function sanitizeName(name, fallbackNumber) {
  const n = String(name || '').trim().slice(0, 12);
  return n.length ? n : `玩家 ${fallbackNumber}`;
}

server.listen(PORT, HOST, () => {
  console.log(`坦克大战服务器已启动: http://localhost:${PORT}`);
  console.log('局域网内其他人可通过 http://<你的局域网IP>:' + PORT + ' 访问加入');
});