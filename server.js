'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const physics = require('./physics');
const { pickSpawnCells } = require('./spawn');

// ---------- 常量配置 ----------
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const CELL = 80;
const WALL_THICK = 10;

// ---------- 地图尺寸 ----------
// 房间级设置：房主在大厅里选择，开局时按当前档位生成迷宫。
// 三档统一保持 3:2 的宽高比（720×480 / 960×640 / 1200×800），
// 客户端画布随 worldW/worldH 自适应缩放时宽高比不会跳变。
const MAP_PRESETS = {
  small: { cols: 9, rows: 6 },
  medium: { cols: 12, rows: 8 },
  large: { cols: 15, rows: 10 },
};
const DEFAULT_MAP_SIZE = 'medium';

const TANK_RADIUS = 15;
const TANK_SPEED = 100;       // 前进 px/s
const TANK_REVERSE_SPEED = 100; // 后退 px/s
const TANK_ROT_SPEED = 4.0;   // rad/s

const BULLET_RADIUS = 4;
const BULLET_SPEED = 150;
const BULLET_LIFETIME = 10; // 子弹存活时间(秒)，超过后自动消失，不再按反弹次数限制
const SHOOT_COOLDOWN = 0.25;
const BULLET_OWNER_GRACE = 0.1; // 出生后一小段时间内不会打到自己

// ---------- 弹药机制 ----------
// 弹药是个人资源：每回合开局满 5 发，单发消耗 1 发，每 5 秒自动补 1 发，上限 5 发。
// 弹药数量只私发给本人（tick 里的 ammo 消息），公共 state 里不带，别人看不到。
// 有了弹药之后，"同屏存活子弹数"不再是必要的限制（否则会出现有弹却打不出去），
// 旧版 MAX_BULLETS_PER_PLAYER 上限已移除。
const AMMO_MAX = 5;
const AMMO_REGEN_INTERVAL = 5; // 秒，每补 1 发所需的装填时间
const AMMO_COST_NORMAL = 1;
const AMMO_COST_TRIPLE = 3; // 三连发一次打出 3 颗子弹，按 3 发弹药结算

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

// ---------- 血量机制 ----------
// 房间级设置：每回合开局把所有人血量补满，每发子弹固定造成 1 点伤害。
// 房主在大厅里可以自由设置 1–20 点；1 点即等同于旧版的一击必杀。
const DEFAULT_MAX_HP = 3;
const MIN_MAX_HP = 1;
const MAX_MAX_HP = 20;
const BULLET_DAMAGE = 1;
// 维修包道具：拾取后回 1 点，不超过房间的血量上限；满血时仍然会拾取，但回血为 0、道具消失。
const REPAIR_HEAL = 1;

// 色板长度必须 >= MAX_PLAYERS，否则房间没满就可能出现两人同色。
const PLAYER_COLORS = ['#E63946', '#3A86FF', '#FFD60A', '#06D6A0', '#FF8A3D', '#C77DFF', '#FF5DA2'];
const MAX_PLAYERS = 7;
// 房间名只用于列表展示，限制长度并清理控制字符即可；重名允许，房间码才是唯一标识。
const MAX_ROOM_NAME = 20;

// 出生保护：每回合开局给所有玩家 3 秒无敌，期间子弹被吸收、不掉血；
// 一旦开火立即解除（避免"守在别人出生点旁边、靠无敌白嫖击杀"）。
const SPAWN_PROTECT_TIME = 3;

// 重生动画：每回合开局所有人先在地图上"凝聚" 0.75 秒，这期间坦克还没有实体——
// 不响应输入、不参与碰撞/拾取/受击，出生保护的 3 秒也要等动画播完才开始倒计时。
const SPAWN_MATERIALIZE_TIME = 0.75;

// ---------- 道具系统 ----------
// repair 是血量机制配套的回血道具（维修包），其余 5 种是原有的增益道具。
const ITEM_TYPES = ['shield', 'speed', 'triple', 'homing', 'invisible', 'repair'];
const ITEM_SPAWN_INTERVAL = 15; // 秒，场上无论有多少道具，每隔这么久固定刷新一个新的
const ITEM_RADIUS = 14; // 拾取判定半径（视觉半径同用这个）
const SPEED_BOOST_DURATION = 6; // 秒
const SPEED_BOOST_MULT = 1.5; // 移动 & 转向速度倍率
const TRIPLE_SPREAD_RAD = (12 * Math.PI) / 180; // 三连发扇形半张角
const HOMING_TURN_RATE = 3; // rad/s，追踪弹每秒最多能修正的转向角速度
const INVISIBLE_DURATION = 8; // 秒，隐身持续时间

// 出生点不再固定四角：每回合由 spawn.js 在全图格心里随机抽取互不重复的位置，
// 具体规则（只要求不同格、随机朝向）见 startRound 与 spawn.js 的注释。

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

// 正式参战玩家的完整初始状态；建房、加入大厅、观战者转正都复用同一份字段。
function makePlayer(id, name, ws, room) {
  return {
    id, name, ws, color: room.assignColor(),
    score: 0, x: 0, y: 0, angle: 0, alive: true, hp: room.maxHp, cooldown: 0,
    input: { forward: false, backward: false, left: false, right: false, shoot: false },
    shield: false, speedBoostRemaining: 0, tripleReady: false, homingReady: false, invisibleRemaining: 0,
    spawnProtectRemaining: 0, spawnAnimRemaining: 0,
    ammo: AMMO_MAX, ammoReloadAcc: 0,
  };
}

// 在网格里随机挑一个格子的中心点作为道具生成位置。
// 墙体都生成在格子的边界上（见 generateMaze），格子中心永远是空地，不用再做碰撞检测。
// 尽量避开已经放了道具的格子，避免两个道具重叠在同一个点；
// 格子数量有限，找不到空位时就放弃这次尝试，等下一轮 15 秒再刷。
function pickRandomItemCell(occupiedCells, cols, rows) {
  const maxTries = 20;
  for (let i = 0; i < maxTries; i++) {
    const r = Math.floor(Math.random() * rows);
    const c = Math.floor(Math.random() * cols);
    const key = `${r},${c}`;
    if (!occupiedCells.has(key)) {
      return { r, c, x: c * CELL + CELL / 2, y: r * CELL + CELL / 2 };
    }
  }
  return null;
}

// ---------- 迷宫生成 ----------
// wallsV[r][c] = 第 c 列和第 c+1 列之间(在第 r 行)是否有墙, c: 0..cols-2
// wallsH[r][c] = 第 r 行和第 r+1 行之间(在第 c 列)是否有墙, r: 0..rows-2
// 行列数由本局房间选择的地图档位决定，世界尺寸也随之变化。
function generateMaze(cols, rows) {
  const worldW = cols * CELL;
  const worldH = rows * CELL;
  const wallsV = Array.from({ length: rows }, () => Array(cols - 1).fill(true));
  const wallsH = Array.from({ length: rows - 1 }, () => Array(cols).fill(true));
  const visited = Array.from({ length: rows }, () => Array(cols).fill(false));

  function neighbors(r, c) {
    const list = [];
    if (r > 0) list.push([r - 1, c, 'H', r - 1, c]);
    if (r < rows - 1) list.push([r + 1, c, 'H', r, c]);
    if (c > 0) list.push([r, c - 1, 'V', r, c - 1]);
    if (c < cols - 1) list.push([r, c + 1, 'V', r, c]);
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
  const extraRemovals = Math.floor(cols * rows * 0.12);
  for (let i = 0; i < extraRemovals; i++) {
    if (Math.random() < 0.5) {
      const r = Math.floor(Math.random() * rows);
      const c = Math.floor(Math.random() * (cols - 1));
      wallsV[r][c] = false;
    } else {
      const r = Math.floor(Math.random() * (rows - 1));
      const c = Math.floor(Math.random() * cols);
      wallsH[r][c] = false;
    }
  }

  // 转换为矩形墙体列表，用于碰撞检测
  const rects = [];
  const OVERLAP = WALL_THICK / 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
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
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
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
  rects.push({ cx: worldW / 2, cy: 0, hw: worldW / 2 + WALL_THICK, hh: WALL_THICK / 2 });
  rects.push({ cx: worldW / 2, cy: worldH, hw: worldW / 2 + WALL_THICK, hh: WALL_THICK / 2 });
  rects.push({ cx: 0, cy: worldH / 2, hw: WALL_THICK / 2, hh: worldH / 2 + WALL_THICK });
  rects.push({ cx: worldW, cy: worldH / 2, hw: WALL_THICK / 2, hh: worldH / 2 + WALL_THICK });

  return { rects, wallsV, wallsH };
}

// ---------- 碰撞辅助 ----------
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ---------- 房间类 ----------
class Room {
  constructor(code, name = '') {
    this.code = code;
    this.name = name;
    this.createdAt = Date.now(); // 房间列表按创建时间排序，避免人数变化时行序来回跳
    this.hostId = null;
    this.players = new Map(); // id -> player（正式参战玩家）
    this.spectators = new Map(); // id -> { id, name, ws }（观战者，不参与对局）
    this.state = 'lobby'; // lobby | playing | round_pending | round_over
    this.maze = null;
    this.bullets = [];
    this.tickHandle = null;
    this.nextBulletId = 1;
    this.pendingWinnerId = null; // 只剩最后一人存活时，先记下这个人是谁，等 5 秒观察期结束再真正判定
    this.pendingTimeout = null;  // 5 秒观察期的定时器句柄
    this.roundEndTimeout = null; // 回合结算后等待进入下一阶段的定时器
    this.joinCounter = 0; // 按加入顺序递增，用来给没填昵称的玩家生成"玩家 N"这样的默认名
    this.items = []; // 场上道具：{ id, type, x, y }
    this.nextItemId = 1;
    this.itemSpawnAcc = 0; // 距离上次刷新道具经过的秒数，累计到 ITEM_SPAWN_INTERVAL 就刷一个
    // 地图大小与初始血量都是房间级设置：房主在大厅里改，每回合开始时按它生成迷宫/补满血量。
    this.mapSize = DEFAULT_MAP_SIZE;
    this.maxHp = DEFAULT_MAX_HP;
    const preset = MAP_PRESETS[this.mapSize];
    this.cols = preset.cols;
    this.rows = preset.rows;
    this.worldW = preset.cols * CELL;
    this.worldH = preset.rows * CELL;
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    }
    // 观战者也要看到完整对局，才能实时观战；他们不在 players 里，不会被判定/计分。
    for (const s of this.spectators.values()) {
      if (s.ws.readyState === WebSocket.OPEN) s.ws.send(data);
    }
  }

  // 大厅状态统一从这里广播，房主变更、玩家进出、地图大小改动都走同一条消息，
  // 避免以后新增房间设置时漏掉某个调用点导致客户端不同步。
  broadcastRoom() {
    this.broadcast({
      type: 'room_update',
      roomName: this.name,
      hostId: this.hostId,
      players: this.playerList(),
      spectators: this.spectatorList(),
      mapSize: this.mapSize,
      maxHp: this.maxHp,
    });
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

  spectatorList() {
    return [...this.spectators.values()].map((s) => ({ id: s.id, name: s.name }));
  }

  memberCount() {
    return this.players.size + this.spectators.size;
  }

  assignColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    const free = PLAYER_COLORS.filter((c) => !used.has(c));
    return free.length ? free[0] : '#F2FBF9'; // 色板用完只是兜底，正常情况下 7 人以内不会走到这里
  }

  startMatch() {
    for (const p of this.players.values()) p.score = 0;
    this.state = 'playing';
    this.startRound();
    broadcastRoomList(); // 房间列表里的状态从"等待中"变成"游戏中"
  }

  // 开局广播也用于中途加入的观战者补发快照：extra 里可以带 spectating: true。
  gameStartMessage(extra = {}) {
    return {
      type: 'game_start',
      maze: { wallsV: this.maze.wallsV, wallsH: this.maze.wallsH, cell: CELL, cols: this.cols, rows: this.rows, wallThick: WALL_THICK },
      players: this.playerList(),
      spectators: this.spectatorList(),
      worldW: this.worldW,
      worldH: this.worldH,
      mapSize: this.mapSize,
      maxHp: this.maxHp,
      // 重生动画总时长（秒）：客户端用它把每帧的剩余时间换算成缩放/透明度进度。
      spawnMaterialize: SPAWN_MATERIALIZE_TIME,
      ...extra,
    };
  }

  // 公共对局状态；中途加入的观战者也会收到一份同样的快照。
  stateMessage() {
    return {
      type: 'state',
      tanks: [...this.players.values()].map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        angle: p.angle,
        alive: p.alive,
        hp: p.hp,
        color: p.color,
        name: p.name,
        shield: p.shield,
        speedBoost: p.speedBoostRemaining > 0,
        tripleReady: p.tripleReady,
        homingReady: p.homingReady,
        invisible: p.invisibleRemaining > 0,
        // 出生保护剩余秒数（保留 1 位小数）：客户端用它画光环进度弧，
        // 0 表示没有保护；和道具护盾的 shield 字段完全独立。
        spawnProtect: Math.round(p.spawnProtectRemaining * 10) / 10,
        // 重生动画剩余秒数（保留 2 位小数）：>0 表示坦克还在凝聚、没有实体，
        // 客户端据此画"放大 + 半透明"的出生动画；0 表示已经正常出现。
        spawnAnim: Math.round(p.spawnAnimRemaining * 100) / 100,
      })),
      bullets: this.bullets.map((b) => ({ id: b.id, x: b.x, y: b.y, owner: b.owner, homing: b.homing })),
      items: this.items.map((it) => ({ id: it.id, type: it.type, x: it.x, y: it.y })),
      spectators: this.spectatorList(),
    };
  }

  startRound() {
    // 每回合都按房间当前的地图大小重新生成，尺寸在世界坐标里是"真"的，
    // 坦克碰撞、子弹反弹、边界 clamp 全部直接用这套尺寸，客户端只负责按 worldW/worldH 缩放显示。
    const preset = MAP_PRESETS[this.mapSize];
    this.cols = preset.cols;
    this.rows = preset.rows;
    this.worldW = preset.cols * CELL;
    this.worldH = preset.rows * CELL;
    this.maze = generateMaze(this.cols, this.rows);
    this.bullets = [];
    this.items = [];
    this.itemSpawnAcc = 0;
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
    this.pendingWinnerId = null;
    // 出生点每回合重新随机，范围覆盖整张地图的所有格心（见 spawn.js）。
    // 当前规则只要求不和其他玩家落在同一格，7 人以内任意人数都放得下；
    // 朝向也是完全随机，出生后往哪边开由玩家自己决定。
    const spawns = pickSpawnCells({
      cols: this.cols,
      rows: this.rows,
      cell: CELL,
      count: this.players.size,
    });
    [...this.players.values()].forEach((p, i) => {
      const spot = spawns[i];
      p.x = spot.x;
      p.y = spot.y;
      p.angle = Math.random() * Math.PI * 2;
      p.alive = true;
      p.hp = this.maxHp; // 每回合开局满血，回合内只会因中弹/维修包变化
      p.cooldown = 0;
      p.input = { forward: false, backward: false, left: false, right: false, shoot: false };
      p.shield = false;
      p.speedBoostRemaining = 0;
      p.tripleReady = false;
      p.homingReady = false;
      p.invisibleRemaining = 0;
      // 弹药和血量一样每回合重置：开局满弹，装填进度清零
      p.ammo = AMMO_MAX;
      p.ammoReloadAcc = 0;
      // 每回合开局都重新给满 3 秒出生保护，开火会提前结束（见 tick 的射击分支）。
      // 保护倒计时先冻结，等 0.75 秒重生动画播完、坦克真正出现后才开始走。
      p.spawnProtectRemaining = SPAWN_PROTECT_TIME;
      p.spawnAnimRemaining = SPAWN_MATERIALIZE_TIME;
    });

    this.broadcast(this.gameStartMessage());

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

      // 重生动画：刚开局的 0.75 秒里坦克还没有实体，不响应输入，出生保护的倒计时也冻结。
      // 动画播完的这一帧把保护重置为满值，从下一帧开始正常计时。
      if (p.spawnAnimRemaining > 0) {
        p.spawnAnimRemaining = Math.max(0, p.spawnAnimRemaining - DT);
        if (p.spawnAnimRemaining < 1e-6) {
          p.spawnAnimRemaining = 0;
          p.spawnProtectRemaining = SPAWN_PROTECT_TIME;
        }
        continue;
      }

      // 出生保护：只按时间递减；开火会立即清零（见下面的射击分支），所以无敌可能在 3 秒前结束
      if (p.spawnProtectRemaining > 0) {
        p.spawnProtectRemaining = Math.max(0, p.spawnProtectRemaining - DT);
      }

      // 加速道具：剩余时间在这里统一倒计时，倒计时期间移动/转向速度按倍率放大
      if (p.speedBoostRemaining > 0) {
        p.speedBoostRemaining = Math.max(0, p.speedBoostRemaining - DT);
      }
      const speedMult = p.speedBoostRemaining > 0 ? SPEED_BOOST_MULT : 1;

      // 隐身道具：剩余时间倒计时，只影响其他玩家客户端的渲染（服务端逻辑不受影响）
      if (p.invisibleRemaining > 0) {
        p.invisibleRemaining = Math.max(0, p.invisibleRemaining - DT);
      }

      // 弹药自动装填：只在正常对局中、且弹药未满时计时，每满 5 秒补 1 发。
      // 满弹时进度归零（不囤积），这样打空后的第一发永远要等满 5 秒，
      // 不会出现"满弹挂机很久、开一枪立刻又回满"的爆发优势。
      // 阵亡后不在 alivePlayers 里，自然停止回复；残局观察期（round_pending）也冻结进度。
      if (this.state === 'playing') {
        if (p.ammo < AMMO_MAX) {
          p.ammoReloadAcc += DT;
          // 30Hz 下 5 秒 = 150 个 DT，浮点累加会得到 4.999999999999992，
          // 用极小容差兜住，保证正好第 150 个 tick 就补弹，而不是拖到 151 个。
          if (p.ammoReloadAcc >= AMMO_REGEN_INTERVAL - 1e-6) {
            p.ammoReloadAcc -= AMMO_REGEN_INTERVAL;
            p.ammo += 1;
            if (p.ammo >= AMMO_MAX) {
              p.ammo = AMMO_MAX;
              p.ammoReloadAcc = 0;
            }
          }
        } else {
          p.ammoReloadAcc = 0;
        }
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

      // 射击：冷却结束 + 弹药足够才打得出去。
      // 普通单发花 1 发；三连发一次打出 3 颗子弹、按 3 发弹药结算，
      // 弹药不足 3 发时整发打不出去（三连发道具保持就绪，等装填够了再用），
      // 避免"手里有 1 发却被迫打一发单发、把三连发道具浪费掉"的歧义。
      p.cooldown = Math.max(0, p.cooldown - DT);
      // 三连发道具：拾取后下一次射击打出扇形三发子弹，用一次就消耗掉；
      // 不是"充能次数"，触发一次后立即回落为普通单发。
      const useTriple = p.tripleReady;
      const useHoming = p.homingReady;
      const ammoCost = useTriple ? AMMO_COST_TRIPLE : AMMO_COST_NORMAL;
      if (input.shoot && p.cooldown <= 0 && p.ammo >= ammoCost) {
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
        p.ammo -= ammoCost;
        if (useTriple) p.tripleReady = false;
        if (useHoming) p.homingReady = false;
        p.cooldown = SHOOT_COOLDOWN;
        // 开火即解除出生保护：这一发打出去的同时无敌消失，不给"贴脸无敌期白嫖"留空间
        p.spawnProtectRemaining = 0;
      }
    }

    // 坦克各自移动完之后，再统一处理坦克间的重叠：谁都不允许穿过谁，
    // 而是互相往对方相反方向各推开重叠量的一半，做出"推挤"的手感。
    // 重生动画中的坦克没有实体，不参与推挤、拾取、索敌和受击，下面统一用 solidPlayers。
    const solidPlayers = alivePlayers.filter((p) => p.spawnAnimRemaining <= 0);
    this.resolveTankCollisions(solidPlayers);

    // --- 道具刷新 ---
    // 不管场上现在有几个道具、也不管是不是处于残局观察期，每隔 ITEM_SPAWN_INTERVAL 秒
    // 都固定刷新一个新道具，全局节奏统一，不做数量上限。
    this.itemSpawnAcc += DT;
    if (this.itemSpawnAcc >= ITEM_SPAWN_INTERVAL) {
      this.itemSpawnAcc -= ITEM_SPAWN_INTERVAL;
      const occupied = new Set(this.items.map((it) => `${it.cellR},${it.cellC}`));
      const cell = pickRandomItemCell(occupied, this.cols, this.rows);
      if (cell) {
        // 1 点血模式下一发就淘汰，血量不是 0 就是满的，维修包永远回不了血，
        // 直接从刷新池里去掉，避免地图上出现没有意义的道具。
        const pool = this.maxHp > 1 ? ITEM_TYPES : ITEM_TYPES.filter((t) => t !== 'repair');
        this.items.push({
          id: this.nextItemId++,
          type: pool[Math.floor(Math.random() * pool.length)],
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
        for (const p of solidPlayers) {
          const dx = p.x - it.x;
          const dy = p.y - it.y;
          if (dx * dx + dy * dy < (TANK_RADIUS + ITEM_RADIUS) * (TANK_RADIUS + ITEM_RADIUS)) {
            takenBy = p;
            break;
          }
        }
        if (takenBy) {
          const hpBefore = takenBy.hp;
          if (it.type === 'shield') takenBy.shield = true;
          else if (it.type === 'speed') takenBy.speedBoostRemaining = SPEED_BOOST_DURATION;
          else if (it.type === 'triple') { takenBy.tripleReady = true; takenBy.homingReady = false; }
          else if (it.type === 'homing') { takenBy.homingReady = true; takenBy.tripleReady = false; }
          else if (it.type === 'invisible') takenBy.invisibleRemaining = INVISIBLE_DURATION;
          else if (it.type === 'repair') takenBy.hp = Math.min(this.maxHp, takenBy.hp + REPAIR_HEAL);
          // heal 是这次拾取实际回复的血量：满血捡维修包时为 0，客户端据此决定要不要飘 +1
          pickups.push({ playerId: takenBy.id, type: it.type, x: it.x, y: it.y, heal: takenBy.hp - hpBefore });
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
    const spawnBlocks = []; // 本帧被出生保护挡下的子弹位置，循环结束后统一广播
    const damageHits = [];  // 本帧真正造成伤害的命中，循环结束后统一广播给客户端做反馈
    for (const b of this.bullets) {
      b.age += DT;

      // 追踪弹：每帧朝当前最近的存活敌方坦克小幅修正飞行方向（限速转向，
      // 不是瞬间锁死），速度大小保持不变，所以拐弯躲开是甩得掉的。
      if (b.homing) {
        let target = null;
        let bestDist2 = Infinity;
        for (const p of solidPlayers) {
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

        for (const p of solidPlayers) {
          if (b.owner === p.id && b.age < BULLET_OWNER_GRACE) continue;
          const ddx = b.x - p.x;
          const ddy = b.y - p.y;
          if (ddx * ddx + ddy * ddy < (BULLET_RADIUS + TANK_RADIUS) * (BULLET_RADIUS + TANK_RADIUS)) {
            if (p.spawnProtectRemaining > 0) {
              // 出生保护：子弹被吸收（不穿透），也不消耗道具护盾；
              // 记下命中位置，稍后广播给客户端播放格挡火花。
              spawnBlocks.push({ x: b.x, y: b.y, ownerId: p.id });
              dead = true;
              break;
            }
            if (p.shield) {
              // 护盾挡下这一发：整发伤害被免疫，护盾消耗掉，子弹消失，但坦克本身不掉血
              p.shield = false;
            } else {
              // 固定 1 点伤害：血量归零才真正阵亡，否则继续以残血留在场上。
              // 命中信息记下来，稍后广播，客户端据此播放受击火花、掉血数字和车身闪白。
              p.hp = Math.max(0, p.hp - BULLET_DAMAGE);
              if (p.hp <= 0) {
                p.alive = false;
                p.lastHitBy = b.owner;
              }
              damageHits.push({
                playerId: p.id,
                by: b.owner,
                x: b.x,
                y: b.y,
                hp: p.hp,
                dead: !p.alive,
              });
            }
            dead = true;
            break;
          }
        }
      }

      if (!dead) survivingBullets.push(b);
    }
    this.bullets = survivingBullets;

    if (spawnBlocks.length > 0) {
      this.broadcast({ type: 'spawn_block', blocks: spawnBlocks });
    }
    if (damageHits.length > 0) {
      this.broadcast({ type: 'damage', hits: damageHits });
    }

    // --- 私发弹药 ---
    // 弹药是个人资源，绝不放进公共 state：每个玩家只收到自己那一份，
    // "只能看到自己的弹药"是协议层面的保证，而不是靠客户端自觉隐藏。
    // 放在 state 之前发送，客户端处理 state 触发重绘时拿到的就是最新弹药。
    for (const p of this.players.values()) {
      if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
      p.ws.send(JSON.stringify({
        type: 'ammo',
        ammo: p.ammo,
        max: AMMO_MAX,
        reload: p.ammo < AMMO_MAX
          ? Math.round((p.ammoReloadAcc / AMMO_REGEN_INTERVAL) * 100) / 100
          : 0,
      }));
    }

    // --- 广播状态 ---
    this.broadcast(this.stateMessage());

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
    p.x = clamp(nx, TANK_RADIUS, this.worldW - TANK_RADIUS);
    p.y = clamp(ny, TANK_RADIUS, this.worldH - TANK_RADIUS);
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
    const champion = scores.find((s) => s.score >= WIN_SCORE);
    // final 表示这局结束后整场比赛就结束了：冠军已产生，或人数已经不够再开一局。
    // 客户端拿它区分结算文案，避免决胜回合先显示"下一回合即将开始"、3 秒后又跳成"即将返回房间"。
    this.broadcast({
      type: 'round_end',
      winnerId: winner ? winner.id : null,
      scores,
      spectators: this.spectatorList(),
      final: Boolean(champion) || this.players.size < 2,
    });
    broadcastRoomList(); // 回合结算期间不算"等待中"，列表状态同步更新

    this.roundEndTimeout = setTimeout(() => {
      this.roundEndTimeout = null;
      if (!rooms.has(this.code)) return; // 房间已销毁
      this.advanceAfterRound(champion);
    }, ROUND_RESTART_DELAY);
  }

  // 整场比赛结束：清掉定时器、回到大厅，并把等待中的观战者转正。
  promoteSpectators() {
    if (this.spectators.size === 0) return;
    for (const s of this.spectators.values()) {
      const p = makePlayer(s.id, s.name, s.ws, this);
      this.players.set(p.id, p);
    }
    this.spectators.clear();
    if (!this.hostId || !this.players.has(this.hostId)) {
      this.hostId = [...this.players.keys()][0] || null;
    }
  }

  // 人数不足、最后一名正式玩家离开等情况下提前结束整场比赛。
  finishMatch(reason) {
    this.stopTicking();
    this.state = 'lobby';
    this.promoteSpectators();
    this.broadcast({
      type: 'match_end',
      winnerId: null,
      scores: this.playerList(),
      hostId: this.hostId,
      spectators: [],
      reason,
    });
    this.broadcastRoom();
  }

  // 结算展示结束后的去向：产生冠军、或人数不足都回大厅，否则开下一局。
  advanceAfterRound(champion) {
    if (champion) {
      this.stopTicking();
      this.state = 'lobby';
      this.promoteSpectators();
      this.broadcast({
        type: 'match_end',
        winnerId: champion.id,
        scores: this.playerList(),
        hostId: this.hostId,
        spectators: [],
      });
      this.broadcastRoom();
    } else if (this.players.size >= 2) {
      this.state = 'playing';
      this.startRound();
    } else {
      // 有人在结算展示期间退出、人数不够开下一局：也必须广播 match_end，
      // 否则剩下的玩家会一直停在"下一回合即将开始…"的遮罩上，等不到任何后续消息。
      this.finishMatch('not_enough_players');
    }
    // 回到大厅或开下一局都会影响房间列表里的状态与人数，统一在分支结束后同步一次。
    broadcastRoomList();
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
    if (this.roundEndTimeout) {
      clearTimeout(this.roundEndTimeout);
      this.roundEndTimeout = null;
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
    // 页面/脚本/样式都是每次请求现读磁盘，开发期改动频繁；禁止浏览器缓存，
    // 避免玩家刷新后仍在跑旧版 client.js / style.css（血量颜色等修复不生效）。
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// ---------- 房间列表 ----------
// 房间列表只暴露"选房间"需要的信息；地图档位、初始血量等游戏设置属于房间内部状态，
// 不进列表、也不随列表同步，避免把列表变成第二份需要保持一致的游戏配置。
function roomSummary(room) {
  const host = room.hostId ? room.players.get(room.hostId) : null;
  return {
    code: room.code,
    name: room.name,
    // 列表里的"人数"包含正式玩家和观战者，与 7 人上限保持一致。
    playerCount: room.memberCount(),
    maxPlayers: MAX_PLAYERS,
    state: room.state,
    hostName: host ? host.name : '',
  };
}

function roomListPayload() {
  return [...rooms.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(roomSummary);
}

function sendRoomList(ws) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'room_list', rooms: roomListPayload() }));
}

// 只推给"当前不在任何房间里"的连接；进入房间后 _roomCode 有值，就不再收列表广播。
function broadcastRoomList() {
  const data = JSON.stringify({ type: 'room_list', rooms: roomListPayload() });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && !ws._roomCode) ws.send(data);
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let playerId = null;

  ws._roomCode = null;
  // 连上就推一份，客户端点"开始游戏"后不用等自己的 list_rooms 请求往返。
  sendRoomList(ws);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'list_rooms') {
      sendRoomList(ws);
      return;
    }

    if (msg.type === 'create_room') {
      if (currentRoom) {
        ws.send(JSON.stringify({ type: 'error', message: '你已经在房间里了，请先离开当前房间' }));
        return;
      }
      const roomName = sanitizeRoomName(msg.roomName);
      if (!roomName) {
        ws.send(JSON.stringify({ type: 'error', message: '请先填写房间名' }));
        return;
      }
      const code = makeRoomCode();
      const room = new Room(code, roomName);
      rooms.set(code, room);
      room.joinCounter += 1;
      const name = sanitizeName(msg.name, room.joinCounter);
      playerId = makeId();
      const player = makePlayer(playerId, name, ws, room);
      room.players.set(playerId, player);
      room.hostId = playerId;
      currentRoom = room;
      ws._roomCode = code;
      ws.send(JSON.stringify({
        type: 'joined', code, roomName: room.name, playerId, hostId: room.hostId,
        spectating: false, players: room.playerList(), spectators: [],
        mapSize: room.mapSize, maxHp: room.maxHp,
      }));
      broadcastRoomList();
      return;
    }

    if (msg.type === 'join_room') {
      if (currentRoom) {
        ws.send(JSON.stringify({ type: 'error', message: '你已经在房间里了，请先离开当前房间' }));
        return;
      }
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: '房间不存在，请检查房间码' }));
        return;
      }
      if (room.memberCount() >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', message: `房间已满（最多${MAX_PLAYERS}人）` }));
        return;
      }

      room.joinCounter += 1;
      const name = sanitizeName(msg.name, room.joinCounter);

      // 游戏中加入：先进入观战席，不占出生点、不计分；整场比赛结束后统一转正。
      if (room.state !== 'lobby') {
        playerId = makeId();
        room.spectators.set(playerId, { id: playerId, name, ws });
        currentRoom = room;
        ws._roomCode = code;
        ws.send(JSON.stringify({
          type: 'joined', code, roomName: room.name, playerId, hostId: room.hostId,
          spectating: true, players: room.playerList(), spectators: room.spectatorList(),
          mapSize: room.mapSize, maxHp: room.maxHp,
        }));
        // 补发当前迷宫和状态，观战者不用等下一帧也能立即看到完整对局。
        ws.send(JSON.stringify(room.gameStartMessage({ spectating: true })));
        ws.send(JSON.stringify(room.stateMessage()));
        room.broadcastRoom();
        broadcastRoomList();
        return;
      }

      playerId = makeId();
      const player = makePlayer(playerId, name, ws, room);
      room.players.set(playerId, player);
      currentRoom = room;
      ws._roomCode = code;
      ws.send(JSON.stringify({
        type: 'joined', code, roomName: room.name, playerId, hostId: room.hostId,
        spectating: false, players: room.playerList(), spectators: room.spectatorList(),
        mapSize: room.mapSize, maxHp: room.maxHp,
      }));
      room.broadcastRoom();
      broadcastRoomList();
      return;
    }

    if (!currentRoom || !playerId) return;

    if (msg.type === 'set_map_size') {
      // 地图大小是房主专属设置，且只在大厅（尚未开局）时可改：
      // 对局中改尺寸会让已经按旧尺寸生成的迷宫/出生点/子弹坐标对不上，必须拒绝。
      if (currentRoom.hostId !== playerId) {
        ws.send(JSON.stringify({ type: 'error', message: '只有房主可以修改地图大小' }));
        return;
      }
      if (currentRoom.state !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: '游戏进行中不能修改地图大小' }));
        return;
      }
      const size = String(msg.size || '');
      // 用 hasOwnProperty 而不是直接取值，避免 'constructor' 之类的原型链 key 被当成合法档位
      if (!Object.prototype.hasOwnProperty.call(MAP_PRESETS, size)) {
        ws.send(JSON.stringify({ type: 'error', message: '无效的地图大小' }));
        return;
      }
      if (currentRoom.mapSize !== size) {
        currentRoom.mapSize = size;
        currentRoom.broadcastRoom();
      }
      return;
    }

    if (msg.type === 'set_hp') {
      // 初始血量同样是房主专属、且只在大厅可改：对局中改会让已经打掉的血量和上限对不上。
      if (currentRoom.hostId !== playerId) {
        ws.send(JSON.stringify({ type: 'error', message: '只有房主可以修改初始血量' }));
        return;
      }
      if (currentRoom.state !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: '游戏进行中不能修改初始血量' }));
        return;
      }
      const raw = msg.hp;
      // 只接受数字或字符串：null/true/false 等如果直接走 Number() 会被悄悄转成 0/1，
      // 必须在类型这一层就拒绝，后面的整数区间校验才有意义。
      const validType = typeof raw === 'number' || typeof raw === 'string';
      const hp = validType && String(raw).trim() !== '' ? Number(raw) : NaN;
      if (!Number.isInteger(hp) || hp < MIN_MAX_HP || hp > MAX_MAX_HP) {
        ws.send(JSON.stringify({ type: 'error', message: `初始血量必须是 ${MIN_MAX_HP}–${MAX_MAX_HP} 之间的整数` }));
        return;
      }
      if (currentRoom.maxHp !== hp) {
        currentRoom.maxHp = hp;
        currentRoom.broadcastRoom();
      }
      return;
    }

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
    ws._roomCode = null;
    const wasPlayer = room.players.delete(playerId);
    const wasSpectator = room.spectators.delete(playerId);
    if (!wasPlayer && !wasSpectator) {
      currentRoom = null;
      playerId = null;
      return;
    }

    if (wasPlayer) {
      if (room.hostId === playerId && room.players.size > 0) {
        room.hostId = [...room.players.keys()][0];
      }
      if (room.players.size === 0) {
        // 最后一名正式玩家离开：如果还有观战者，房间保留并让他们转正；否则销毁房间。
        if (room.spectators.size > 0) {
          room.finishMatch('not_enough_players');
        } else {
          room.stopTicking();
          rooms.delete(room.code);
        }
      } else if (room.state !== 'lobby' && room.players.size < 2) {
        // 人数不够继续比赛：提前结束整场，观战者一并转正回大厅。
        room.finishMatch('not_enough_players');
      } else {
        room.broadcastRoom();
      }
    } else {
      // 观战者离开只影响名单，不影响对局。
      if (room.players.size === 0) {
        if (room.spectators.size === 0) {
          room.stopTicking();
          rooms.delete(room.code);
        } else {
          room.finishMatch('not_enough_players');
        }
      } else {
        room.broadcastRoom();
      }
    }

    broadcastRoomList();
    currentRoom = null;
    playerId = null;
  }
});

function sanitizeName(name, fallbackNumber) {
  const n = String(name || '').trim().slice(0, 12);
  return n.length ? n : `玩家 ${fallbackNumber}`;
}

function sanitizeRoomName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001F\u007F]/g, '') // 去掉换行等控制字符，防止列表排版被破坏
    .trim()
    .slice(0, MAX_ROOM_NAME);
}

// 直接 `node server.js` 时才真正监听端口；被测试 require 时只导出 Room 等符号，
// 这样 tests/room.test.js 可以不起网络、直接驱动房间逻辑做确定性测试。
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`坦克大战服务器已启动: http://localhost:${PORT}`);
    console.log('局域网内其他人可通过 http://<你的局域网IP>:' + PORT + ' 访问加入');
  });
}

module.exports = {
  Room,
  MAX_PLAYERS,
  MAX_ROOM_NAME,
  PLAYER_COLORS,
  SPAWN_PROTECT_TIME,
  SPAWN_MATERIALIZE_TIME,
  MAP_PRESETS,
  CELL,
  TANK_RADIUS,
  BULLET_RADIUS,
  AMMO_MAX,
  AMMO_REGEN_INTERVAL,
  DEFAULT_MAX_HP,
  MIN_MAX_HP,
  MAX_MAX_HP,
  BULLET_DAMAGE,
  REPAIR_HEAL,
  ITEM_TYPES,
};