'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const physics = require('./physics');
const { pickSpawnCells, pickRespawnCell } = require('./spawn');
const { generateMap } = require('./maps');
const {
  LASER_LENGTH,
  LASER_MAX_BOUNCES,
  LASER_HALF_WIDTH,
  LASER_DAMAGE,
  LASER_MUZZLE_OFFSET,
  traceLaserPath,
  collectLaserHits,
} = require('./laser');
const {
  CAPTURE_RADIUS,
  CAPTURE_TIME,
  DECAY_EMPTY_TIME,
  DECAY_NEUTRALIZE_TIME,
  createCapturePoint,
  stepCapture,
  isInside,
} = require('./capture');

// ---------- 常量配置 ----------
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const CELL = 80;
const WALL_THICK = 10;

// ---------- 地图尺寸 ----------
// 房间级设置：房主在大厅里选择，开局时按当前类型/档位生成地图。
// 三档统一保持 3:2 的宽高比（720×480 / 960×640 / 1200×800），
// 客户端画布随 worldW/worldH 自适应缩放时宽高比不会跳变。
const MAP_PRESETS = {
  small: { cols: 9, rows: 6 },
  medium: { cols: 12, rows: 8 },
  large: { cols: 15, rows: 10 },
};
const DEFAULT_MAP_SIZE = 'medium';

// ---------- 地图类型 ----------
// 地图类型和地图大小是两个独立设置：类型决定布局，大小决定网格尺寸。
// maze 是原有默认值，保证老客户端/旧房间行为不变；random 每回合从其余四种里随机抽一种。
const MAP_TYPES = {
  maze: { key: 'maze', name: '迷宫' },
  open: { key: 'open', name: '空旷' },
  symmetric: { key: 'symmetric', name: '对称' },
  scatter: { key: 'scatter', name: '散块' },
  random: { key: 'random', name: '随机' },
};
const DEFAULT_MAP_TYPE = 'maze';

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
const AMMO_COST_TRIPLE = 1; // 三连发一次打出 3 颗子弹，但只按 1 发弹药结算
// 弹药箱道具：拾取后直接补满（封顶 AMMO_MAX）。满弹时仍会拾取、道具消失，实际补充 0，
// 与维修包"满血也捡"的规则保持一致。
const AMMO_REFILL = AMMO_MAX;

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

// ---------- 游戏模式 ----------
// brawl（大乱斗）是默认模式：单局连续死斗，阵亡 10 秒后在随机位置复活，
// 先达到房间设置的击杀目标者获胜；team（团队模式）同样复活，但按红蓝两队累计击杀，
// 先达到目标的队伍获胜；capture（占点模式）也沿用复活节奏，目标改为占据场上唯一的据点：
// 单人站圈 10 秒占领一次得 1 分，据点随后随机换位，先达到房间设置的占领目标者获胜；
// collect（收集模式）同样阵亡复活，目标是收集地图上的钻石，先达到收集目标者获胜；
// classic（经典模式）保留原玩法：淘汰制回合计分。
const MODES = {
  brawl: { key: 'brawl', name: '大乱斗模式' },
  team: { key: 'team', name: '团队模式' },
  capture: { key: 'capture', name: '占点模式' },
  collect: { key: 'collect', name: '收集模式' },
  classic: { key: 'classic', name: '经典模式' },
};
const DEFAULT_MODE = 'brawl';

// 团队模式的固定队伍配置。服务端只下发队伍 key，名称和颜色由客户端按同一份配置渲染；
// 红/蓝两色沿用原有色板，保证坦克、HUD、结算文案视觉一致。
const TEAMS = {
  red: { key: 'red', name: '红队', color: '#E63946' },
  blue: { key: 'blue', name: '蓝队', color: '#3A86FF' },
};
const TEAM_KEYS = ['red', 'blue'];

function otherTeam(team) {
  return team === 'red' ? 'blue' : 'red';
}

// 大乱斗、占点模式、收集模式、团队模式都是"连续复活、按目标定胜负"，只有经典模式没有复活机制。
function hasRespawn(mode) {
  return mode === 'brawl' || mode === 'capture' || mode === 'collect' || mode === 'team';
}

// 大乱斗 / 团队模式：复活等待时长（秒，固定）与击杀目标（房间级设置，房主可改）。
// 团队模式复用一个 killTarget，只是它的含义从"个人击杀"变成"队伍总击杀"。
const BRAWL_RESPAWN_DELAY = 10;
const DEFAULT_KILL_TARGET = 10;
const MIN_KILL_TARGET = 5;
const MAX_KILL_TARGET = 30;

// 占点模式：占领目标（房间级设置，房主可改，默认 3 次）。
// 占点一次得 1 分，达到目标即结束整场；据点被占领后随机换位。
const DEFAULT_CAPTURE_TARGET = 3;
const MIN_CAPTURE_TARGET = 1;
const MAX_CAPTURE_TARGET = 10;

// 经典模式：胜利所需回合数（房间级设置，房主可改，默认即原来的 5 回合）
const DEFAULT_WIN_SCORE = 5;
const MIN_WIN_SCORE = 1;
const MAX_WIN_SCORE = 10;

// ---------- 收集模式：钻石 ----------
// 开局在场上放 2 颗钻石，之后每 10 秒自动补 1 颗，自动刷新上限 5 颗。
// 阵亡会掉落已收集钻石的一半（向下取整），掉落的钻石不受自动刷新上限限制——
// 它们会额外落在死亡位置附近，之后自动刷新会暂停，直到场上数量降回 5 颗以下。
// 收集目标默认 10 颗，房主可在 5–30 颗之间调整。
const DEFAULT_COLLECT_TARGET = 10;
const MIN_COLLECT_TARGET = 5;
const MAX_COLLECT_TARGET = 30;
const COLLECT_INITIAL_DIAMONDS = 2;
const COLLECT_DIAMONDS_ON_FIELD = 5;
const COLLECT_DIAMOND_INTERVAL = 10; // 秒
const DIAMOND_RADIUS = 14; // 拾取判定与绘制半径

// ---------- 血量机制 ----------
// 房间级设置：每回合开局把所有人血量补满，每发子弹固定造成 1 点伤害。
// 房主在大厅里可以自由设置 1–10 点，默认 5 点；1 点即等同于旧版的一击必杀。
const DEFAULT_MAX_HP = 5;
const MIN_MAX_HP = 1;
const MAX_MAX_HP = 10;
const BULLET_DAMAGE = 1;
// 维修包道具：拾取后回 1 点，不超过房间的血量上限；满血时仍然会拾取，但回血为 0、道具消失。
const REPAIR_HEAL = 1;

// 色板长度必须 >= MAX_PLAYERS，否则房间没满就可能出现两人同色。
// 第 10 位用中性灰而不是白色：白色留给据点圆环、名字文字等"中立"元素，
// 否则白车开在白圈里会互相吃掉轮廓。
const PLAYER_COLORS = [
  '#E63946', '#3A86FF', '#FFD60A', '#06D6A0', '#FF8A3D',
  '#C77DFF', '#FF5DA2', '#00C2FF', '#A8E10C', '#A9A9A9',
];
const MAX_PLAYERS = 10;
// 房间名只用于列表展示，限制长度并清理控制字符即可；重名允许，房间码才是唯一标识。
const MAX_ROOM_NAME = 20;

// 出生保护：每回合开局给所有玩家 3 秒无敌，期间子弹被吸收、不掉血；
// 一旦开火立即解除（避免"守在别人出生点旁边、靠无敌白嫖击杀"）。
const SPAWN_PROTECT_TIME = 3;

// 重生动画：每回合开局所有人先在地图上"凝聚" 0.75 秒，这期间坦克还没有实体——
// 不响应输入、不参与碰撞/拾取/受击，出生保护的 3 秒也要等动画播完才开始倒计时。
const SPAWN_MATERIALIZE_TIME = 0.75;

// ---------- 道具系统 ----------
// repair 是血量机制配套的回血道具（维修包），laser 是一次性的反弹射线，
// ammo 是弹药箱：拾取后直接补满弹药；其余 5 种是原有的增益道具。
const ITEM_TYPES = ['shield', 'speed', 'triple', 'homing', 'invisible', 'repair', 'laser', 'ammo'];
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
    // 团队模式下的队伍 key（red / blue）；大乱斗和经典模式保持 null。
    team: null,
    score: 0, x: 0, y: 0, angle: 0, alive: true, hp: room.maxHp, cooldown: 0,
    input: { forward: false, backward: false, left: false, right: false, shoot: false },
    shield: false, speedBoostRemaining: 0, tripleReady: false, homingReady: false, laserReady: false, invisibleRemaining: 0,
    spawnProtectRemaining: 0, spawnAnimRemaining: 0,
    ammo: AMMO_MAX, ammoReloadAcc: 0, ammoPickupGain: 0,
    // 大乱斗专用：阵亡后的复活倒计时（秒），0 表示活着或不在等待复活。
    respawnRemaining: 0,
  };
}

// 在网格里随机挑一个格子的中心点作为道具生成位置。
// 墙体都生成在格子的边界上（见 maps.js），格子中心永远是空地，不用再做碰撞检测。
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

// ---------- 地图生成 ----------
// 具体的迷宫 / 空旷 / 对称 / 散块布局和碰撞矩形都在 maps.js 里生成，
// 这里只负责按房间设置选类型，并把结果存进 maze。wallsV/wallsH 的坐标约定见 maps.js。

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
    // 收集模式专用：场上钻石 { id, x, y, cellR, cellC }，以及自动刷新计时。
    // 钻石与普通道具分开存：它们不计入道具池，也不会被道具刷新逻辑当成占位。
    this.diamonds = [];
    this.nextDiamondId = 1;
    this.diamondSpawnAcc = 0;
    // 地图类型/大小与初始血量都是房间级设置：房主在大厅里改，每回合开始时按它生成地图/补满血量。
    // mapLayout 记录本回合实际使用的布局：mapType 为 random 时它和 mapType 不同。
    this.mapType = DEFAULT_MAP_TYPE;
    this.mapLayout = null;
    this.mapSize = DEFAULT_MAP_SIZE;
    this.maxHp = DEFAULT_MAX_HP;
    // 游戏模式与各模式的胜利目标同样是房间级设置，只在大厅可改：
    //   brawl   → killTarget（击杀数）
    //   capture → captureTarget（占领次数）
    //   collect → collectTarget（收集钻石数）
    //   classic → winScore（回合胜场数）
    this.mode = DEFAULT_MODE;
    this.killTarget = DEFAULT_KILL_TARGET;
    this.captureTarget = DEFAULT_CAPTURE_TARGET;
    this.collectTarget = DEFAULT_COLLECT_TARGET;
    this.winScore = DEFAULT_WIN_SCORE;
    // 占点模式当前据点：{ id, x, y, radius, progress, ownerId, ownerColor, status }。
    // 只有 capture 模式在 startRound 时生成；其他模式保持 null。
    this.point = null;
    this.nextPointId = 1;
    // 团队模式专用：每队累计击杀数。个人击杀仍记在 p.score，团队分是独立的房间级统计，
    // 这样中途有人离开时，他此前为队伍拿到的分不会跟着消失。
    this.teamKills = { red: 0, blue: 0 };
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
      mapType: this.mapType,
      mapSize: this.mapSize,
      maxHp: this.maxHp,
      mode: this.mode,
      killTarget: this.killTarget,
      captureTarget: this.captureTarget,
      collectTarget: this.collectTarget,
      winScore: this.winScore,
      captureTime: CAPTURE_TIME,
    });
  }

  playerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      // 团队模式：red / blue；其他模式为 null，客户端据此决定是否显示队伍徽章。
      team: p.team || null,
      score: p.score,
      connected: true,
    }));
  }

  spectatorList() {
    return [...this.spectators.values()].map((s) => ({ id: s.id, name: s.name }));
  }

  // 据点的公开快照：x/y/radius 只在换点时变化，progress/owner/status 每帧都可能变。
  // 非占点模式没有据点，统一返回 null，客户端只需判空。
  pointMessage() {
    if (!this.point) return null;
    const p = this.point;
    return {
      id: p.id,
      x: p.x,
      y: p.y,
      radius: p.radius,
      progress: Math.round(p.progress * 1000) / 1000,
      ownerId: p.ownerId,
      ownerColor: p.ownerColor,
      status: p.status,
    };
  }

  // 钻石的公开快照：收集模式之外统一为空数组，客户端无需判断模式。
  diamondList() {
    return this.diamonds.map((d) => ({ id: d.id, x: d.x, y: d.y }));
  }

  memberCount() {
    return this.players.size + this.spectators.size;
  }

  assignColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    const free = PLAYER_COLORS.filter((c) => !used.has(c));
    return free.length ? free[0] : '#A9A9A9'; // 色板用完只是兜底，正常情况下 10 人以内不会走到这里
  }

  // ---------- 团队模式：分队 ----------
  // team 只保存队伍 key，名称/颜色由客户端按同一份 TEAM 配置渲染。
  teamCount(team) {
    let n = 0;
    for (const p of this.players.values()) {
      if (p.team === team) n += 1;
    }
    return n;
  }

  teamCounts() {
    return { red: this.teamCount('red'), blue: this.teamCount('blue') };
  }

  // 新玩家自动补到人少的一队；人数相同时优先红队，保证连续加入时两队人数差不超过 1。
  assignTeam(p) {
    const counts = this.teamCounts();
    p.team = counts.red <= counts.blue ? 'red' : 'blue';
  }

  setPlayerTeam(p, team) {
    if (!p || !Object.prototype.hasOwnProperty.call(TEAMS, team)) return false;
    p.team = team;
    return true;
  }

  // 切到团队模式、观战者转正等场景下补齐没有队伍的人；已有的分队不会被覆盖。
  ensureTeams() {
    if (this.mode !== 'team') return;
    for (const p of this.players.values()) {
      if (!Object.prototype.hasOwnProperty.call(TEAMS, p.team || '')) this.assignTeam(p);
    }
  }

  // 重新分队：洗牌后按红蓝交替分配，人数差最多 1；起始队伍随机，
  // 避免每次洗牌都是红队多一人。
  shuffleTeams() {
    const ids = [...this.players.keys()];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const start = Math.random() < 0.5 ? 'red' : 'blue';
    ids.forEach((id, i) => {
      const p = this.players.get(id);
      if (p) p.team = i % 2 === 0 ? start : otherTeam(start);
    });
  }

  resetTeamKills() {
    this.teamKills = { red: 0, blue: 0 };
  }

  // 对局中某一队的人全部离开：即使总人数仍然 >= 2，也无法继续团队对抗。
  teamDepleted() {
    return this.mode === 'team' && this.state !== 'lobby'
      && (this.teamCount('red') === 0 || this.teamCount('blue') === 0);
  }

  startMatch() {
    // 团队模式开赛前再兜底一次分队，并拒绝"某一队没人"的开局。
    if (this.mode === 'team') {
      this.ensureTeams();
      const counts = this.teamCounts();
      if (counts.red === 0 || counts.blue === 0) return false;
    }
    for (const p of this.players.values()) p.score = 0;
    this.resetTeamKills();
    this.state = 'playing';
    this.startRound();
    broadcastRoomList(); // 房间列表里的状态从"等待中"变成"游戏中"
    return true;
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
      mapType: this.mapType,
      // random 时这里才是本回合真正抽中的布局；其他类型与 mapType 相同。
      mapLayout: this.mapLayout,
      mapSize: this.mapSize,
      maxHp: this.maxHp,
      mode: this.mode,
      killTarget: this.killTarget,
      captureTarget: this.captureTarget,
      collectTarget: this.collectTarget,
      winScore: this.winScore,
      // 占点模式：CAPTURE_TIME 用于大厅/开局公告文案，point 是本局当前的据点。
      captureTime: CAPTURE_TIME,
      point: this.pointMessage(),
      // 收集模式的钻石：开局快照 / 观战补发都带上，客户端不用等第一帧 state。
      diamonds: this.diamondList(),
      // 团队模式开局清零；非团队模式也带一个全 0 的对象，客户端可以无脑读取。
      teamKills: { ...this.teamKills },
      respawnDelay: BRAWL_RESPAWN_DELAY,
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
        // 团队模式：red / blue；其他模式为 null。
        team: p.team || null,
        name: p.name,
        // 大乱斗 / 团队模式里 score 就是个人击杀数；经典模式里是回合胜场数。
        // 这两种模式没有 round_end 可以带分数，所以必须在每帧 state 里实时同步。
        score: p.score,
        shield: p.shield,
        speedBoost: p.speedBoostRemaining > 0,
        tripleReady: p.tripleReady,
        homingReady: p.homingReady,
        laserReady: p.laserReady,
        invisible: p.invisibleRemaining > 0,
        // 出生保护剩余秒数（保留 1 位小数）：客户端用它画光环进度弧，
        // 0 表示没有保护；和道具护盾的 shield 字段完全独立。
        spawnProtect: Math.round(p.spawnProtectRemaining * 10) / 10,
        // 重生动画剩余秒数（保留 2 位小数）：>0 表示坦克还在凝聚、没有实体，
        // 客户端据此画"放大 + 半透明"的出生动画；0 表示已经正常出现。
        spawnAnim: Math.round(p.spawnAnimRemaining * 100) / 100,
        // 大乱斗阵亡后的复活倒计时（秒，保留 1 位小数），0 表示活着或不在等待复活；
        // 经典模式没有复活机制，这里恒为 0。
        respawn: Math.round(p.respawnRemaining * 10) / 10,
      })),
      bullets: this.bullets.map((b) => ({ id: b.id, x: b.x, y: b.y, owner: b.owner, homing: b.homing })),
      items: this.items.map((it) => ({ id: it.id, type: it.type, x: it.x, y: it.y })),
      // 收集模式的钻石；其他模式为空数组。
      diamonds: this.diamondList(),
      // 占点模式的据点：进度、占领者、争夺/衰减状态；其他模式恒为 null。
      point: this.pointMessage(),
      // 团队总击杀：和每帧 state 一起下发，客户端 HUD 只在这个值变化时重建。
      teamKills: { ...this.teamKills },
      spectators: this.spectatorList(),
    };
  }

  startRound() {
    // 每回合都按房间当前的地图类型/大小重新生成，尺寸在世界坐标里是"真"的，
    // 坦克碰撞、子弹反弹、边界 clamp 全部直接用这套尺寸，客户端只负责按 worldW/worldH 缩放显示。
    const preset = MAP_PRESETS[this.mapSize];
    this.cols = preset.cols;
    this.rows = preset.rows;
    this.worldW = preset.cols * CELL;
    this.worldH = preset.rows * CELL;
    const map = generateMap(this.mapType, {
      cols: this.cols,
      rows: this.rows,
      cell: CELL,
      wallThick: WALL_THICK,
    });
    this.mapLayout = map.type;
    this.maze = { wallsV: map.wallsV, wallsH: map.wallsH, rects: map.rects };
    this.bullets = [];
    this.items = [];
    this.itemSpawnAcc = 0;
    // 收集模式：每局重新摆 2 颗钻石，并清空上一局的自动刷新计时。
    this.diamonds = [];
    this.diamondSpawnAcc = 0;
    // 占点模式每局重新生成一个据点；其他模式没有据点。
    // 据点允许跨墙，圆心完全随机，只保留一个半径的边距让整个圆留在图内。
    this.point = null;
    if (this.mode === 'capture') this.point = this.createNewPoint();
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
    this.pendingWinnerId = null;
    // 出生点每回合重新随机，范围覆盖整张地图的所有格心（见 spawn.js）。
    // 占点模式额外避开据点圈：否则一出生就站在圈里，白拿占领进度。
    const avoidZones = this.point
      ? [{ x: this.point.x, y: this.point.y, r: this.point.radius + TANK_RADIUS + 4 }]
      : [];
    const spawns = pickSpawnCells({
      cols: this.cols,
      rows: this.rows,
      cell: CELL,
      count: this.players.size,
      avoidZones,
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
      p.laserReady = false;
      p.invisibleRemaining = 0;
      // 弹药和血量一样每回合重置：开局满弹，装填进度清零
      p.ammo = AMMO_MAX;
      p.ammoReloadAcc = 0;
      p.ammoPickupGain = 0;
      // 每回合开局都重新给满 3 秒出生保护，开火会提前结束（见 tick 的射击分支）。
      // 保护倒计时先冻结，等 0.75 秒重生动画播完、坦克真正出现后才开始走。
      p.spawnProtectRemaining = SPAWN_PROTECT_TIME;
      p.spawnAnimRemaining = SPAWN_MATERIALIZE_TIME;
      // 开局重新站上出生点，清掉上一场可能残留的复活倒计时。
      p.respawnRemaining = 0;
    });

    // 收集模式：开局先摆 2 颗钻石。此时玩家位置已确定，生成时会避开坦克所在格。
    if (this.mode === 'collect') {
      for (let i = 0; i < COLLECT_INITIAL_DIAMONDS; i++) this.spawnDiamond();
    }

    this.broadcast(this.gameStartMessage());

    if (!this.tickHandle) {
      this.tickHandle = setInterval(() => this.tick(), 1000 / TICK_RATE);
    }
  }

  // 生成一个新据点（id 递增，客户端据此判断"换点了"）。
  // 位置完全随机：不对齐格心、不避开存活坦克，只保留一个半径的边距让整个圆留在图内。
  createNewPoint() {
    const point = createCapturePoint({
      cols: this.cols,
      rows: this.rows,
      cell: CELL,
      radius: CAPTURE_RADIUS,
    });
    point.id = this.nextPointId++;
    return point;
  }

  // ---------- 收集模式：钻石 ----------
  // 自动刷新：在随机空格心放一颗；没有空位时返回 null。
  // 生成时避开普通道具、已有钻石和所有存活坦克所在格，避免一刷出来就被脚下的人白捡。
  spawnDiamond() {
    if (this.mode !== 'collect') return null;
    const occupied = new Set();
    for (const it of this.items) occupied.add(`${it.cellR},${it.cellC}`);
    for (const d of this.diamonds) occupied.add(`${d.cellR},${d.cellC}`);
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const c = clamp(Math.floor(p.x / CELL), 0, this.cols - 1);
      const r = clamp(Math.floor(p.y / CELL), 0, this.rows - 1);
      occupied.add(`${r},${c}`);
    }
    const cell = pickRandomItemCell(occupied, this.cols, this.rows);
    if (!cell) return null;
    const diamond = {
      id: this.nextDiamondId++,
      x: cell.x,
      y: cell.y,
      cellR: cell.r,
      cellC: cell.c,
    };
    this.diamonds.push(diamond);
    return diamond;
  }

  // 死亡掉落用：在死亡点附近找一个不压墙、不贴边界的位置。
  // 坦克死亡位置本身一定是空地，所以随机偏移都失败时直接退回死亡点。
  isDiamondSpotClear(x, y) {
    if (x < DIAMOND_RADIUS || x > this.worldW - DIAMOND_RADIUS
      || y < DIAMOND_RADIUS || y > this.worldH - DIAMOND_RADIUS) return false;
    for (const rect of this.maze.rects) {
      if (physics.circleRectOverlap(x, y, DIAMOND_RADIUS, rect)) return false;
    }
    return true;
  }

  // index / total 用来把同一名玩家掉落的几颗钻石沿圆周分散开，避免全部叠在一个点。
  spawnDiamondNear(x, y, index = 0, total = 1) {
    const baseAngle = (Math.PI * 2 * index) / Math.max(1, total);
    let sx = x;
    let sy = y;
    for (let i = 0; i < 10; i++) {
      const angle = baseAngle + (i / 10) * Math.PI * 2 + Math.random() * 0.45;
      const dist = 18 + Math.random() * 22;
      const nx = x + Math.cos(angle) * dist;
      const ny = y + Math.sin(angle) * dist;
      const tooClose = this.diamonds.some((d) => {
        const dx = d.x - nx;
        const dy = d.y - ny;
        return dx * dx + dy * dy < (DIAMOND_RADIUS * 2) * (DIAMOND_RADIUS * 2);
      }) || this.items.some((it) => {
        const dx = it.x - nx;
        const dy = it.y - ny;
        return dx * dx + dy * dy < (DIAMOND_RADIUS + ITEM_RADIUS) * (DIAMOND_RADIUS + ITEM_RADIUS);
      });
      if (!tooClose && this.isDiamondSpotClear(nx, ny)) {
        sx = nx;
        sy = ny;
        break;
      }
    }
    const diamond = {
      id: this.nextDiamondId++,
      x: sx,
      y: sy,
      cellR: clamp(Math.floor(sx / CELL), 0, this.cols - 1),
      cellC: clamp(Math.floor(sy / CELL), 0, this.rows - 1),
    };
    this.diamonds.push(diamond);
    return diamond;
  }

  // 阵亡掉落：已收集钻石的一半（向下取整，1 颗时不掉落），落在死亡点附近。
  // 掉落数量不受自动刷新上限限制；自动刷新会在场上数量降回 5 颗以下后继续。
  dropDiamonds(p) {
    if (this.mode !== 'collect' || !p || p.score <= 0) return 0;
    const count = Math.floor(p.score / 2);
    if (count <= 0) return 0;
    p.score -= count;
    for (let i = 0; i < count; i++) this.spawnDiamondNear(p.x, p.y, i, count);
    // 让客户端在死亡位置飘一个 "-N 钻石"，并和随后到达的 state 保持同一份分数。
    this.broadcast({
      type: 'diamond_drop',
      playerId: p.id,
      count,
      score: p.score,
      x: p.x,
      y: p.y,
    });
    return count;
  }

  // 每 10 秒自动补 1 颗，最多补到 5 颗。到上限后计时照常走，但不会生成。
  updateDiamondSpawns() {
    if (this.mode !== 'collect' || this.state !== 'playing') return;
    this.diamondSpawnAcc += DT;
    while (this.diamondSpawnAcc >= COLLECT_DIAMOND_INTERVAL - 1e-6) {
      this.diamondSpawnAcc -= COLLECT_DIAMOND_INTERVAL;
      if (this.diamonds.length < COLLECT_DIAMONDS_ON_FIELD) this.spawnDiamond();
    }
  }

  tick() {
    if (this.state !== 'playing' && this.state !== 'round_pending') return;
    // 大乱斗 / 团队模式：先推进阵亡玩家的复活倒计时，到点的人在这一帧重新上场；
    // 随后再统一计算存活名单，复活者会带着出生动画进入下面的移动/碰撞逻辑。
    if (hasRespawn(this.mode) && this.state === 'playing') this.updateRespawns();
    // 收集模式：每 10 秒自动补 1 颗钻石（上限 5 颗），与复活计时互不影响。
    if (this.mode === 'collect' && this.state === 'playing') this.updateDiamondSpawns();
    const alivePlayers = [...this.players.values()].filter((p) => p.alive);
    // 本帧开火产生的激光先记下来，等坦克移动/推挤完成、拿到最终位置后再统一求路径。
    const pendingLasers = [];

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
      // 普通单发、三连发、激光都只消耗 1 发弹药；三连发一次打出 3 颗子弹。
      // 0 弹时整发打不出去（三连发/激光道具保持就绪，等装填够了再用）。
      p.cooldown = Math.max(0, p.cooldown - DT);
      // 三连发道具：拾取后下一次射击打出扇形三发子弹，用一次就消耗掉；
      // 不是"充能次数"，触发一次后立即回落为普通单发。
      const useTriple = p.tripleReady;
      const useHoming = p.homingReady;
      const useLaser = p.laserReady;
      const ammoCost = useTriple ? AMMO_COST_TRIPLE : AMMO_COST_NORMAL;
      if (input.shoot && p.cooldown <= 0 && p.ammo >= ammoCost) {
        if (useLaser) {
          // 激光不是实体子弹：只记录发射参数，本帧稍后统一求路径并结算伤害。
          pendingLasers.push({
            ownerId: p.id,
            team: p.team || null,
            x: p.x + Math.cos(p.angle) * LASER_MUZZLE_OFFSET,
            y: p.y + Math.sin(p.angle) * LASER_MUZZLE_OFFSET,
            angle: p.angle,
          });
        } else {
          const angles = useTriple
            ? [p.angle - TRIPLE_SPREAD_RAD, p.angle, p.angle + TRIPLE_SPREAD_RAD]
            : [p.angle];
          for (const shotAngle of angles) {
            const bx = p.x + Math.cos(shotAngle) * (TANK_RADIUS + BULLET_RADIUS + 2);
            const by = p.y + Math.sin(shotAngle) * (TANK_RADIUS + BULLET_RADIUS + 2);
            this.bullets.push({
              id: this.nextBulletId++,
              owner: p.id,
              // 发射瞬间记录队伍：关闭友伤、以及击杀者中途离场后的团队分归属都依赖它。
              team: p.team || null,
              x: bx,
              y: by,
              vx: Math.cos(shotAngle) * BULLET_SPEED,
              vy: Math.sin(shotAngle) * BULLET_SPEED,
              bounces: 0,
              age: 0,
              homing: useHoming,
            });
          }
        }
        p.ammo -= ammoCost;
        if (useTriple) p.tripleReady = false;
        if (useHoming) p.homingReady = false;
        if (useLaser) p.laserReady = false;
        p.cooldown = SHOOT_COOLDOWN;
        // 开火即解除出生保护：这一发打出去的同时无敌消失，不给"贴脸无敌期白嫖"留空间
        p.spawnProtectRemaining = 0;
      }
    }

    // 坦克各自移动完之后，再统一处理坦克间的重叠：谁都不允许穿过谁，
    // 而是互相往对方相反方向各推开重叠量的一半，做出"推挤"的手感。
    // 重生动画中的坦克没有实体，不参与推挤、拾取、索敌和受击，下面统一用 solidPlayers。
    let solidPlayers = alivePlayers.filter((p) => p.spawnAnimRemaining <= 0);
    this.resolveTankCollisions(solidPlayers);

    // --- 激光结算 ---
    // 激光是瞬发路径伤害：等移动/推挤都完成、位置最终确定后，再求这一帧的折线路径。
    // 路径碰到的每个敌人各掉 1 点血（穿透，不会停在第一个敌人身上）。
    // 伤害/格挡记录和子弹共用同一组数组，本帧末尾统一广播一次。
    const spawnBlocks = []; // 本帧被出生保护挡下的命中位置，循环结束后统一广播
    const damageHits = [];  // 本帧真正造成伤害的命中，循环结束后统一广播给客户端做反馈
    if (pendingLasers.length > 0) {
      for (const shot of pendingLasers) {
        const path = traceLaserPath(shot.x, shot.y, shot.angle, this.maze.rects, {
          length: LASER_LENGTH,
          maxBounces: LASER_MAX_BOUNCES,
        });
        const hits = collectLaserHits(path.points, solidPlayers, {
          ownerId: shot.ownerId,
          ownerTeam: shot.team,
          teamMode: this.mode === 'team',
          hitRadius: TANK_RADIUS + LASER_HALF_WIDTH,
        });
        for (const hit of hits) {
          this.applyHit(hit.player, shot.ownerId, shot.team, hit.x, hit.y, LASER_DAMAGE, damageHits, spawnBlocks);
        }
        // 光束只用于客户端画一次渐隐特效，不进入每帧 state。
        this.broadcast({
          type: 'laser',
          ownerId: shot.ownerId,
          points: path.points,
          hits: hits.map((h) => ({ playerId: h.playerId, x: h.x, y: h.y })),
        });
      }
      // 被激光打死的玩家本帧不再参与拾取（子弹伤害在拾取之后结算，这里保持"先死后拾取"）。
      solidPlayers = solidPlayers.filter((p) => p.alive);
    }

    // --- 道具刷新 ---
    // 不管场上现在有几个道具、也不管是不是处于残局观察期，每隔 ITEM_SPAWN_INTERVAL 秒
    // 都固定刷新一个新道具，全局节奏统一，不做数量上限。
    this.itemSpawnAcc += DT;
    if (this.itemSpawnAcc >= ITEM_SPAWN_INTERVAL) {
      this.itemSpawnAcc -= ITEM_SPAWN_INTERVAL;
      const occupied = new Set(this.items.map((it) => `${it.cellR},${it.cellC}`));
      // 收集模式下道具不要刷在钻石同一格，避免两个可拾取物叠在一起。
      for (const d of this.diamonds) occupied.add(`${d.cellR},${d.cellC}`);
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
    // 护盾/加速/隐身存在不同的字段里，天然可以同时生效、互不覆盖；
    // 三连发/追踪弹/激光都是"下一发"状态，三者互斥，后拾取的会覆盖先前的。
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
          else if (it.type === 'triple') { takenBy.tripleReady = true; takenBy.homingReady = false; takenBy.laserReady = false; }
          else if (it.type === 'homing') { takenBy.homingReady = true; takenBy.tripleReady = false; takenBy.laserReady = false; }
          else if (it.type === 'laser') { takenBy.laserReady = true; takenBy.tripleReady = false; takenBy.homingReady = false; }
          else if (it.type === 'invisible') takenBy.invisibleRemaining = INVISIBLE_DURATION;
          else if (it.type === 'repair') takenBy.hp = Math.min(this.maxHp, takenBy.hp + REPAIR_HEAL);
          else if (it.type === 'ammo') {
            const ammoBefore = takenBy.ammo;
            takenBy.ammo = Math.min(AMMO_MAX, ammoBefore + AMMO_REFILL);
            // 本次实际补充量只私发给本人（见下方 ammo 消息），公共广播不带，避免泄露弹药数
            takenBy.ammoPickupGain += takenBy.ammo - ammoBefore;
            // 补满后装填进度归零：和"满弹不囤积进度"的规则保持一致
            if (takenBy.ammo >= AMMO_MAX) takenBy.ammoReloadAcc = 0;
          }
          // heal 是这次拾取实际回复的血量：满血捡维修包时为 0，客户端据此决定要不要飘 +1
          pickups.push({ playerId: takenBy.id, type: it.type, x: it.x, y: it.y, heal: takenBy.hp - hpBefore });
        } else {
          remainingItems.push(it);
        }
      }
      this.items = remainingItems;
    }

    // --- 钻石拾取 ---
    // 与普通道具一样，碰撞即拾取、立刻加分。放在子弹结算之前：
    // 本帧刚捡到的钻石先计入分数，随后被打死时再按新的分数掉落一半。
    if (this.mode === 'collect' && this.diamonds.length > 0) {
      const remainingDiamonds = [];
      for (const d of this.diamonds) {
        let takenBy = null;
        for (const p of solidPlayers) {
          const dx = p.x - d.x;
          const dy = p.y - d.y;
          if (dx * dx + dy * dy < (TANK_RADIUS + DIAMOND_RADIUS) * (TANK_RADIUS + DIAMOND_RADIUS)) {
            takenBy = p;
            break;
          }
        }
        if (takenBy) {
          takenBy.score += 1;
          pickups.push({
            playerId: takenBy.id,
            type: 'diamond',
            x: d.x,
            y: d.y,
            score: takenBy.score,
          });
        } else {
          remainingDiamonds.push(d);
        }
      }
      this.diamonds = remainingDiamonds;
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
      // 子弹发射时记录过队伍；老测试/旧子弹没有这个字段时按当前 owner 兜底。
      const bulletOwner = this.players.get(b.owner);
      const bulletTeam = b.team || (bulletOwner ? bulletOwner.team : null);

      // 追踪弹：每帧朝当前最近的存活敌方坦克小幅修正飞行方向（限速转向，
      // 不是瞬间锁死），速度大小保持不变，所以拐弯躲开是甩得掉的。
      // 团队模式下只锁敌人，不会转头去追队友。
      if (b.homing) {
        let target = null;
        let bestDist2 = Infinity;
        for (const p of solidPlayers) {
          if (p.id === b.owner) continue;
          if (this.mode === 'team' && bulletTeam && p.team === bulletTeam) continue;
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
          // 同一帧多颗子弹打在同一个人身上时，已经阵亡的目标不再重复结算伤害/击杀。
          if (!p.alive) continue;
          if (b.owner === p.id && b.age < BULLET_OWNER_GRACE) continue;
          // 团队模式关闭友伤：子弹直接穿过队友（自己的跳弹仍然可以命中自己）。
          if (this.mode === 'team' && bulletTeam && p.team === bulletTeam && p.id !== b.owner) continue;
          const ddx = b.x - p.x;
          const ddy = b.y - p.y;
          if (ddx * ddx + ddy * ddy < (BULLET_RADIUS + TANK_RADIUS) * (BULLET_RADIUS + TANK_RADIUS)) {
            // 统一的命中结算：出生保护吸收 / 护盾抵消 / 扣血 + 击杀计分都在 applyHit 里。
            // 子弹无论是否造成伤害都会消失，所以结算完直接置 dead。
            this.applyHit(p, b.owner, bulletTeam, b.x, b.y, BULLET_DAMAGE, damageHits, spawnBlocks);
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

    // --- 占点模式：据点进度 ---
    // 放在子弹结算之后，保证本帧刚被打死的玩家不会继续占点/争夺。
    // 出生保护不影响占点（需求确认：进圈不解除保护，保护期内也正常参与判定）。
    let captureWinner = null;
    if (this.mode === 'capture' && this.point && this.state === 'playing') {
      const occupants = [];
      for (const p of this.players.values()) {
        if (!p.alive || p.spawnAnimRemaining > 0) continue;
        if (isInside(this.point, p.x, p.y)) occupants.push(p);
      }
      if (stepCapture(this.point, occupants, DT)) {
        const owner = this.players.get(this.point.ownerId);
        if (owner) {
          owner.score += 1;
          // 先广播占领完成（带旧据点的位置），客户端据此在旧位置播放特效；
          // 然后再决定是结束整场，还是随机换一个新据点。
          this.broadcast({
            type: 'point_captured',
            playerId: owner.id,
            name: owner.name,
            color: owner.color,
            score: owner.score,
            target: this.captureTarget,
            x: this.point.x,
            y: this.point.y,
            radius: this.point.radius,
          });
          if (owner.score >= this.captureTarget) {
            captureWinner = owner;
          } else {
            // 换点完全随机：可能直接刷在某个存活玩家脚下，不再刻意避开。
            this.point = this.createNewPoint();
          }
        }
      }
    }

    // --- 私发弹药 + 激光预览 ---
    // 弹药是个人资源，绝不放进公共 state：每个玩家只收到自己那一份，
    // "只能看到自己的弹药"是协议层面的保证，而不是靠客户端自觉隐藏。
    // 激光就绪时顺便把这条反弹路径私发给本人，客户端用虚线画在车下；
    // 其他玩家收不到，避免提前暴露瞄准线。
    // 放在 state 之前发送，客户端处理 state 触发重绘时拿到的就是最新数据。
    for (const p of this.players.values()) {
      if (!p.ws || p.ws.readyState !== WebSocket.OPEN) {
        p.ammoPickupGain = 0; // 掉线时没发出去的补充量不保留，避免重连后误报
        continue;
      }
      const msg = {
        type: 'ammo',
        ammo: p.ammo,
        max: AMMO_MAX,
        reload: p.ammo < AMMO_MAX
          ? Math.round((p.ammoReloadAcc / AMMO_REGEN_INTERVAL) * 100) / 100
          : 0,
        // 本帧拾取弹药箱实际补了几发；没拾取时为 0。只发本人，不进入公共 state。
        pickup: p.ammoPickupGain,
        laserPreview: null,
      };
      // 死亡 / 凝聚动画中不显示预览；预览与真正发射使用同一套炮口偏移和反弹参数。
      if (p.laserReady && p.alive && p.spawnAnimRemaining <= 0) {
        const preview = traceLaserPath(
          p.x + Math.cos(p.angle) * LASER_MUZZLE_OFFSET,
          p.y + Math.sin(p.angle) * LASER_MUZZLE_OFFSET,
          p.angle,
          this.maze.rects,
          { length: LASER_LENGTH, maxBounces: LASER_MAX_BOUNCES }
        );
        msg.laserPreview = preview.points;
      }
      p.ws.send(JSON.stringify(msg));
      p.ammoPickupGain = 0;
    }

    // --- 广播状态 ---
    this.broadcast(this.stateMessage());

    // --- 占点模式胜负判断 ---
    // 先让客户端收到"占领者得分 + 旧据点 100%"的最后一帧 state，再广播 match_end。
    if (captureWinner) {
      this.advanceAfterRound(captureWinner);
      return;
    }

    // --- 大乱斗胜负判断 ---
    // 以击杀数为胜利条件：任意玩家达到房间设置的击杀目标就结束整场。
    // 放在 state 广播之后，保证客户端先看到最后一杀的画面和最新击杀数，再收到 match_end。
    if (this.mode === 'brawl') {
      let champion = null;
      for (const p of this.players.values()) {
        if (p.score >= this.killTarget && (!champion || p.score > champion.score)) champion = p;
      }
      if (champion) {
        // 复用整场结束流程：停 tick、回大厅、观战者转正、广播 match_end。
        this.advanceAfterRound(champion);
        return;
      }
    }

    // --- 收集模式胜负判断 ---
    // 以收集到的钻石数为胜利条件：任意玩家达到房间设置的收集目标就结束整场。
    // 同样放在 state 广播之后，保证客户端先看到最后一颗钻石的拾取画面，再收到 match_end。
    if (this.mode === 'collect') {
      let champion = null;
      for (const p of this.players.values()) {
        if (p.score >= this.collectTarget && (!champion || p.score > champion.score)) champion = p;
      }
      if (champion) {
        this.advanceAfterRound(champion);
        return;
      }
    }

    // --- 团队模式胜负判断 ---
    // 任意一队总击杀达到目标即结束整场。同一 tick 两队同时达标时先比总击杀，
    // 完全相同则判平局（返回大厅，不记胜者）。
    if (this.mode === 'team') {
      const reached = TEAM_KEYS.filter((team) => this.teamKills[team] >= this.killTarget);
      if (reached.length > 0) {
        let winnerTeam = null;
        if (reached.length === 1) {
          winnerTeam = reached[0];
        } else {
          const [a, b] = reached;
          if (this.teamKills[a] !== this.teamKills[b]) {
            winnerTeam = this.teamKills[a] > this.teamKills[b] ? a : b;
          }
        }
        this.endTeamMatch(winnerTeam, winnerTeam ? null : 'draw');
        return;
      }
    }

    // --- 经典模式回合结束判断 ---
    // 只剩 1 人（或恰好 0 人，双方同归于尽）存活时不立即结束回合，而是进入 5 秒观察期：
    // 一方面给死亡爆炸特效留出播放时间，另一方面场上可能还有飞行中的子弹，
    // 如果这 5 秒内"最后一人"也被打死了，就直接判定平局（不给任何人加分），
    // 而不是提前一步就宣布他获胜。
    const total = this.players.size;
    const stillAlive = [...this.players.values()].filter((p) => p.alive);

    if (this.mode === 'classic' && this.state === 'playing' && total >= 2 && stillAlive.length <= 1) {
      this.state = 'round_pending';
      this.pendingWinnerId = stillAlive.length === 1 ? stillAlive[0].id : null;
      this.pendingTimeout = setTimeout(() => {
        this.pendingTimeout = null;
        if (this.state !== 'round_pending') return; // 已经因为平局提前结束了
        const winner = this.pendingWinnerId ? this.players.get(this.pendingWinnerId) : null;
        this.endRound(winner || null);
      }, 5000);
    } else if (this.mode === 'classic' && this.state === 'round_pending' && this.pendingWinnerId) {
      const w = this.players.get(this.pendingWinnerId);
      if (!w || !w.alive) {
        // 观察期内，原本"存活的最后一人"也阵亡了：把待定结果改成平局，
        // 但不重开计时器——沿用进入观察期时就已经开始的那个 5 秒倒计时，
        // 时间到了之后 pendingWinnerId 已经是 null，自然就会按平局结算。
        this.pendingWinnerId = null;
      }
    }
  }

  // ---------- 大乱斗 / 团队模式复活 ----------
  // 阵亡玩家的倒计时只在比赛进行中推进；每减去一个 DT 就检查是否到点。
  // 浮点累减会有极小误差，用 1e-6 容差兜住，保证正好 10 秒（300 tick）复活。
  updateRespawns() {
    for (const p of this.players.values()) {
      if (p.alive || p.respawnRemaining <= 0) continue;
      p.respawnRemaining = Math.max(0, p.respawnRemaining - DT);
      if (p.respawnRemaining < 1e-6) {
        p.respawnRemaining = 0;
        this.respawnPlayer(p);
      }
    }
  }

  // 复活 = 一次单人版的"开局重置"：随机格心、随机朝向、满血满弹、清空所有增益，
  // 并重新给 0.75 秒凝聚动画 + 3 秒出生保护（保护在动画播完后才开始倒计时）。
  respawnPlayer(p) {
    const avoid = [...this.players.values()]
      .filter((o) => o !== p && o.alive)
      .map((o) => ({ x: o.x, y: o.y }));
    // 占点模式：复活点不要落在当前据点圈内，避免一复活就开始白拿进度。
    // 收集模式：复活点也不要直接踩在钻石上，否则一落地就白捡。
    const avoidZones = [];
    if (this.point) {
      avoidZones.push({ x: this.point.x, y: this.point.y, r: this.point.radius + TANK_RADIUS + 4 });
    }
    if (this.mode === 'collect') {
      for (const d of this.diamonds) {
        avoidZones.push({ x: d.x, y: d.y, r: TANK_RADIUS + DIAMOND_RADIUS + 4 });
      }
    }
    const spot = pickRespawnCell({
      cols: this.cols,
      rows: this.rows,
      cell: CELL,
      avoid,
      avoidZones,
      minDist: TANK_RADIUS * 2,
    });
    if (spot) {
      p.x = spot.x;
      p.y = spot.y;
    }
    p.angle = Math.random() * Math.PI * 2;
    p.alive = true;
    p.hp = this.maxHp;
    p.cooldown = 0;
    p.input = { forward: false, backward: false, left: false, right: false, shoot: false };
    p.shield = false;
    p.speedBoostRemaining = 0;
    p.tripleReady = false;
    p.homingReady = false;
    p.laserReady = false;
    p.invisibleRemaining = 0;
    p.ammo = AMMO_MAX;
    p.ammoReloadAcc = 0;
    p.ammoPickupGain = 0;
    p.spawnProtectRemaining = SPAWN_PROTECT_TIME;
    p.spawnAnimRemaining = SPAWN_MATERIALIZE_TIME;
    p.respawnRemaining = 0;
  }

  // 统一的命中结算：子弹和激光共用。
  // 返回 true 表示真正扣了血；出生保护/护盾挡下时返回 false。
  // 调用方自己决定命中后弹体是否继续：子弹会消失，激光会穿透继续结算后面的敌人。
  applyHit(target, ownerId, ownerTeam, hitX, hitY, damage, damageHits, spawnBlocks) {
    if (target.spawnProtectRemaining > 0) {
      // 出生保护：这一下被吸收，不掉血、不消耗道具护盾；
      // 记下命中位置，稍后广播给客户端播放格挡火花。
      spawnBlocks.push({ x: hitX, y: hitY, ownerId: target.id });
      return false;
    }
    if (target.shield) {
      // 护盾挡下这一下：伤害被免疫，护盾消耗掉，坦克本身不掉血。
      target.shield = false;
      return false;
    }

    // 固定 1 点伤害：血量归零才真正阵亡，否则继续以残血留在场上。
    // 命中信息记下来，稍后广播，客户端据此播放受击火花、掉血数字和车身闪白。
    const amount = damage == null ? BULLET_DAMAGE : damage;
    target.hp = Math.max(0, target.hp - amount);
    if (target.hp <= 0) {
      target.alive = false;
      target.lastHitBy = ownerId;
      // 收集模式：阵亡掉落已收集钻石的一半。先扣分、再进入复活倒计时，
      // 这样死亡瞬间的 state / diamond_drop 里看到的就是扣完后的分数。
      if (this.mode === 'collect') this.dropDiamonds(target);
      if (hasRespawn(this.mode)) {
        // 大乱斗 / 占点 / 收集 / 团队模式里阵亡不是退场：开始 10 秒复活倒计时，
        // 由 updateRespawns 放回场上。
        target.respawnRemaining = BRAWL_RESPAWN_DELAY;
        // 死亡瞬间清空输入，避免复活时还带着死前按住的方向/开火。
        target.input = { forward: false, backward: false, left: false, right: false, shoot: false };
        // 击杀统计：自己打自己（跳弹命中自己）不计分；
        // 已经阵亡的击杀者生前打出的子弹仍然算他的击杀。
        // 占点模式的 score 是"占领次数"，击杀不直接得分，所以这里只给
        // 大乱斗 / 团队模式累计击杀分。
        if (this.mode === 'brawl' || this.mode === 'team') {
          const killer = this.players.get(ownerId);
          if (killer && killer.id !== target.id) killer.score += 1;
          // 团队总分独立累计：只统计跨队击杀，自杀不计。
          // 击杀者中途离场时用弹体上记录的 team，保证这一分仍归原队伍。
          if (this.mode === 'team') {
            const killerTeam = (killer && killer.team) || ownerTeam || null;
            if (killerTeam && target.team && killerTeam !== target.team) {
              this.teamKills[killerTeam] += 1;
            }
          }
        }
      }
    }
    damageHits.push({
      playerId: target.id,
      by: ownerId,
      x: hitX,
      y: hitY,
      hp: target.hp,
      dead: !target.alive,
    });
    return true;
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
    const champion = scores.find((s) => s.score >= this.winScore);
    // final 表示这局结束后整场比赛就结束了：冠军已产生，或人数已经不够再开一局。
    // 客户端拿它区分结算文案，避免决胜回合先显示"下一回合即将开始"、3 秒后又跳成"即将返回房间"。
    this.broadcast({
      type: 'round_end',
      winnerId: winner ? winner.id : null,
      scores,
      spectators: this.spectatorList(),
      final: Boolean(champion) || this.players.size < 2,
      mode: this.mode,
      winScore: this.winScore,
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
      // 团队模式下转正的人也要立刻分到人少的一队，大厅才能直接显示队伍。
      if (this.mode === 'team') this.assignTeam(p);
    }
    this.spectators.clear();
    if (!this.hostId || !this.players.has(this.hostId)) {
      this.hostId = [...this.players.keys()][0] || null;
    }
  }

  // 团队模式整场结束：目标击杀达成或同 tick 双达标平局。
  // winnerTeam 为 null 且 reason === 'draw' 表示平局；普通胜负时 reason 为 null。
  endTeamMatch(winnerTeam, reason = null) {
    this.stopTicking();
    this.state = 'lobby';
    this.promoteSpectators();
    this.broadcast({
      type: 'match_end',
      winnerId: null,
      winnerTeam,
      teamKills: { ...this.teamKills },
      scores: this.playerList(),
      hostId: this.hostId,
      spectators: [],
      reason,
      mode: this.mode,
      killTarget: this.killTarget,
      captureTarget: this.captureTarget,
      collectTarget: this.collectTarget,
      winScore: this.winScore,
    });
    this.broadcastRoom();
    broadcastRoomList();
  }

  // 人数不足、最后一名正式玩家离开等情况下提前结束整场比赛。
  finishMatch(reason) {
    this.stopTicking();
    this.state = 'lobby';
    this.promoteSpectators();
    this.broadcast({
      type: 'match_end',
      winnerId: null,
      winnerTeam: null,
      teamKills: { ...this.teamKills },
      scores: this.playerList(),
      hostId: this.hostId,
      spectators: [],
      reason,
      mode: this.mode,
      killTarget: this.killTarget,
      captureTarget: this.captureTarget,
      collectTarget: this.collectTarget,
      winScore: this.winScore,
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
        winnerTeam: null,
        teamKills: { ...this.teamKills },
        scores: this.playerList(),
        hostId: this.hostId,
        spectators: [],
        mode: this.mode,
        killTarget: this.killTarget,
        captureTarget: this.captureTarget,
        collectTarget: this.collectTarget,
        winScore: this.winScore,
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
    // 列表里的"人数"包含正式玩家和观战者，与 10 人上限保持一致。
    playerCount: room.memberCount(),
    maxPlayers: MAX_PLAYERS,
    state: room.state,
    hostName: host ? host.name : '',
    // 模式是选房时会关心的公开信息（列表卡片上显示徽章），不属于地图/血量那种房间内部配置。
    mode: room.mode,
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
        mapType: room.mapType, mapSize: room.mapSize, maxHp: room.maxHp,
        mode: room.mode, killTarget: room.killTarget, captureTarget: room.captureTarget,
        collectTarget: room.collectTarget, winScore: room.winScore, captureTime: CAPTURE_TIME,
        respawnDelay: BRAWL_RESPAWN_DELAY,
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
          mapType: room.mapType, mapSize: room.mapSize, maxHp: room.maxHp,
          mode: room.mode, killTarget: room.killTarget, captureTarget: room.captureTarget,
          collectTarget: room.collectTarget, winScore: room.winScore, captureTime: CAPTURE_TIME,
          respawnDelay: BRAWL_RESPAWN_DELAY,
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
      // 团队模式大厅里加入的新玩家直接补到人少的一队；其他模式保持 team=null。
      if (room.mode === 'team') room.assignTeam(player);
      currentRoom = room;
      ws._roomCode = code;
      ws.send(JSON.stringify({
        type: 'joined', code, roomName: room.name, playerId, hostId: room.hostId,
        spectating: false, players: room.playerList(), spectators: room.spectatorList(),
        mapType: room.mapType, mapSize: room.mapSize, maxHp: room.maxHp,
        mode: room.mode, killTarget: room.killTarget, captureTarget: room.captureTarget,
        collectTarget: room.collectTarget, winScore: room.winScore, captureTime: CAPTURE_TIME,
        respawnDelay: BRAWL_RESPAWN_DELAY,
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

    if (msg.type === 'set_map_type') {
      // 地图类型和地图大小一样是房主专属、且只在大厅可改：
      // 对局中换布局会让已经生成的墙体/出生点/子弹坐标对不上。
      if (currentRoom.hostId !== playerId) {
        ws.send(JSON.stringify({ type: 'error', message: '只有房主可以修改地图类型' }));
        return;
      }
      if (currentRoom.state !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: '游戏进行中不能修改地图类型' }));
        return;
      }
      const mapType = String(msg.mapType || '');
      // 同样用 hasOwnProperty 防止 'constructor' 之类的原型链 key 混进来。
      if (!Object.prototype.hasOwnProperty.call(MAP_TYPES, mapType)) {
        ws.send(JSON.stringify({ type: 'error', message: '无效的地图类型' }));
        return;
      }
      if (currentRoom.mapType !== mapType) {
        currentRoom.mapType = mapType;
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

    if (msg.type === 'set_mode') {
      // 模式和地图/血量一样是房主专属、只在大厅可改：开局后再换模式会让进行中的对局语义混乱。
      if (currentRoom.hostId !== playerId) {
        ws.send(JSON.stringify({ type: 'error', message: '只有房主可以修改游戏模式' }));
        return;
      }
      if (currentRoom.state !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: '游戏进行中不能修改游戏模式' }));
        return;
      }
      const mode = String(msg.mode || '');
      if (!Object.prototype.hasOwnProperty.call(MODES, mode)) {
        ws.send(JSON.stringify({ type: 'error', message: '无效的游戏模式' }));
        return;
      }
      if (currentRoom.mode !== mode) {
        currentRoom.mode = mode;
        // 切到团队模式时，把还没有队伍的人自动补到人少的一队。
        if (mode === 'team') currentRoom.ensureTeams();
        currentRoom.broadcastRoom();
      }
      return;
    }

    if (msg.type === 'set_kill_target') {
      if (currentRoom.hostId !== playerId) {
        ws.send(JSON.stringify({ type: 'error', message: '只有房主可以修改击杀目标' }));
        return;
      }
      if (currentRoom.state !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: '游戏进行中不能修改击杀目标' }));
        return;
      }
      if (currentRoom.mode !== 'brawl' && currentRoom.mode !== 'team') {
        ws.send(JSON.stringify({ type: 'error', message: '只有大乱斗模式/团队模式可以设置击杀目标' }));
        return;
      }
      const kills = parseInteger(msg.kills);
      if (!Number.isInteger(kills) || kills < MIN_KILL_TARGET || kills > MAX_KILL_TARGET) {
        ws.send(JSON.stringify({ type: 'error', message: `击杀目标必须是 ${MIN_KILL_TARGET}–${MAX_KILL_TARGET} 之间的整数` }));
        return;
      }
      if (currentRoom.killTarget !== kills) {
        currentRoom.killTarget = kills;
        currentRoom.broadcastRoom();
      }
      return;
    }

    if (msg.type === 'set_capture_target') {
      // 占领目标与击杀目标一样是房主专属、只在大厅可改。
      if (currentRoom.hostId !== playerId) {
        ws.send(JSON.stringify({ type: 'error', message: '只有房主可以修改占领目标' }));
        return;
      }
      if (currentRoom.state !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: '游戏进行中不能修改占领目标' }));
        return;
      }
      if (currentRoom.mode !== 'capture') {
        ws.send(JSON.stringify({ type: 'error', message: '只有占点模式可以设置占领目标' }));
        return;
      }
      const target = parseInteger(msg.target);
      if (!Number.isInteger(target) || target < MIN_CAPTURE_TARGET || target > MAX_CAPTURE_TARGET) {
        ws.send(JSON.stringify({ type: 'error', message: `占领目标必须是 ${MIN_CAPTURE_TARGET}–${MAX_CAPTURE_TARGET} 之间的整数` }));
        return;
      }
      if (currentRoom.captureTarget !== target) {
        currentRoom.captureTarget = target;
        currentRoom.broadcastRoom();
      }
      return;
    }

    if (msg.type === 'set_collect_target') {
      // 收集目标与占领目标一样是房主专属、只在大厅可改。
      if (currentRoom.hostId !== playerId) {
        ws.send(JSON.stringify({ type: 'error', message: '只有房主可以修改收集目标' }));
        return;
      }
      if (currentRoom.state !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: '游戏进行中不能修改收集目标' }));
        return;
      }
      if (currentRoom.mode !== 'collect') {
        ws.send(JSON.stringify({ type: 'error', message: '只有收集模式可以设置收集目标' }));
        return;
      }
      const target = parseInteger(msg.target);
      if (!Number.isInteger(target) || target < MIN_COLLECT_TARGET || target > MAX_COLLECT_TARGET) {
        ws.send(JSON.stringify({ type: 'error', message: `收集目标必须是 ${MIN_COLLECT_TARGET}–${MAX_COLLECT_TARGET} 之间的整数` }));
        return;
      }
      if (currentRoom.collectTarget !== target) {
        currentRoom.collectTarget = target;
        currentRoom.broadcastRoom();
      }
      return;
    }

    if (msg.type === 'set_win_score') {
      if (currentRoom.hostId !== playerId) {
        ws.send(JSON.stringify({ type: 'error', message: '只有房主可以修改胜利分数' }));
        return;
      }
      if (currentRoom.state !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: '游戏进行中不能修改胜利分数' }));
        return;
      }
      if (currentRoom.mode !== 'classic') {
        ws.send(JSON.stringify({ type: 'error', message: '只有经典模式可以设置胜利分数' }));
        return;
      }
      const score = parseInteger(msg.score);
      if (!Number.isInteger(score) || score < MIN_WIN_SCORE || score > MAX_WIN_SCORE) {
        ws.send(JSON.stringify({ type: 'error', message: `胜利分数必须是 ${MIN_WIN_SCORE}–${MAX_WIN_SCORE} 之间的整数` }));
        return;
      }
      if (currentRoom.winScore !== score) {
        currentRoom.winScore = score;
        currentRoom.broadcastRoom();
      }
      return;
    }

    // 团队模式：房主在大厅手动换队。只允许在团队模式下调整，避免其他模式出现无意义的队伍字段。
    if (msg.type === 'set_player_team') {
      if (currentRoom.hostId !== playerId) {
        ws.send(JSON.stringify({ type: 'error', message: '只有房主可以调整队伍' }));
        return;
      }
      if (currentRoom.state !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: '游戏进行中不能调整队伍' }));
        return;
      }
      if (currentRoom.mode !== 'team') {
        ws.send(JSON.stringify({ type: 'error', message: '只有团队模式可以调整队伍' }));
        return;
      }
      const target = currentRoom.players.get(String(msg.targetId || ''));
      if (!target) {
        ws.send(JSON.stringify({ type: 'error', message: '玩家不存在或已离开房间' }));
        return;
      }
      const team = String(msg.team || '');
      if (!Object.prototype.hasOwnProperty.call(TEAMS, team)) {
        ws.send(JSON.stringify({ type: 'error', message: '无效的队伍' }));
        return;
      }
      if (target.team !== team) {
        currentRoom.setPlayerTeam(target, team);
        currentRoom.broadcastRoom();
      }
      return;
    }

    if (msg.type === 'shuffle_teams') {
      if (currentRoom.hostId !== playerId) {
        ws.send(JSON.stringify({ type: 'error', message: '只有房主可以重新分队' }));
        return;
      }
      if (currentRoom.state !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: '游戏进行中不能重新分队' }));
        return;
      }
      if (currentRoom.mode !== 'team') {
        ws.send(JSON.stringify({ type: 'error', message: '只有团队模式可以重新分队' }));
        return;
      }
      currentRoom.shuffleTeams();
      currentRoom.broadcastRoom();
      return;
    }

    if (msg.type === 'start_game') {
      if (currentRoom.hostId !== playerId) return;
      if (currentRoom.players.size < 2) {
        ws.send(JSON.stringify({ type: 'error', message: '至少需要2名玩家才能开始' }));
        return;
      }
      // startMatch 内部会再兜底分队；返回 false 表示两队没有都分到人。
      if (!currentRoom.startMatch()) {
        ws.send(JSON.stringify({ type: 'error', message: '团队模式需要红蓝两队都至少有一名玩家' }));
        return;
      }
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
      } else if (room.teamDepleted()) {
        // 团队模式下总人数还够，但某一队已经没人了，无法继续对抗。
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

// 解析房间设置里的整数：只接受 number / 非空数字字符串。
// null/true/false 等如果直接走 Number() 会被悄悄转成 0/1，必须在类型层就拒绝。
function parseInteger(raw) {
  const validType = typeof raw === 'number' || typeof raw === 'string';
  return validType && String(raw).trim() !== '' ? Number(raw) : NaN;
}

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
  MAP_TYPES,
  DEFAULT_MAP_TYPE,
  MODES,
  DEFAULT_MODE,
  TEAMS,
  TEAM_KEYS,
  BRAWL_RESPAWN_DELAY,
  DEFAULT_KILL_TARGET,
  MIN_KILL_TARGET,
  MAX_KILL_TARGET,
  DEFAULT_CAPTURE_TARGET,
  MIN_CAPTURE_TARGET,
  MAX_CAPTURE_TARGET,
  DEFAULT_COLLECT_TARGET,
  MIN_COLLECT_TARGET,
  MAX_COLLECT_TARGET,
  COLLECT_INITIAL_DIAMONDS,
  COLLECT_DIAMONDS_ON_FIELD,
  COLLECT_DIAMOND_INTERVAL,
  DIAMOND_RADIUS,
  CAPTURE_RADIUS,
  CAPTURE_TIME,
  DECAY_EMPTY_TIME,
  DECAY_NEUTRALIZE_TIME,
  DEFAULT_WIN_SCORE,
  MIN_WIN_SCORE,
  MAX_WIN_SCORE,
  CELL,
  TANK_RADIUS,
  BULLET_RADIUS,
  AMMO_MAX,
  AMMO_REGEN_INTERVAL,
  AMMO_REFILL,
  DEFAULT_MAX_HP,
  MIN_MAX_HP,
  MAX_MAX_HP,
  BULLET_DAMAGE,
  REPAIR_HEAL,
  ITEM_TYPES,
  LASER_LENGTH,
  LASER_MAX_BOUNCES,
  LASER_HALF_WIDTH,
  LASER_DAMAGE,
};
