(() => {
  'use strict';

  // ---------- 视图切换 ----------
  const views = {
    landing: document.getElementById('view-landing'),
    settings: document.getElementById('view-settings'),
    rooms: document.getElementById('view-rooms'),
    lobby: document.getElementById('view-lobby'),
    game: document.getElementById('view-game'),
  };
  function showView(name) {
    for (const k in views) views[k].classList.toggle('hidden', k !== name);
  }

  // ---------- DOM 元素 ----------
  const nicknameEl = document.getElementById('nickname');
  const btnEnterRooms = document.getElementById('btn-enter-rooms');
  const landingError = document.getElementById('landing-error');
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const btnSettingsBack = document.getElementById('btn-settings-back');
  const controlPicker = document.getElementById('control-picker');
  const controlDescEl = document.getElementById('control-desc');

  const roomsListEl = document.getElementById('rooms-list');
  const roomsEmptyEl = document.getElementById('rooms-empty');
  const roomsCountEl = document.getElementById('rooms-count');
  const roomsErrorEl = document.getElementById('rooms-error');
  const roomsNicknameEl = document.getElementById('rooms-nickname');
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const btnBackHome = document.getElementById('btn-back-home');

  const modalCreate = document.getElementById('modal-create');
  const modalJoin = document.getElementById('modal-join');
  const formCreate = document.getElementById('form-create');
  const createRoomNameEl = document.getElementById('create-room-name');
  const createErrorEl = document.getElementById('create-error');
  const formJoin = document.getElementById('form-join');
  const joinCodeEl = document.getElementById('join-code');
  const joinErrorEl = document.getElementById('join-error');
  const toastEl = document.getElementById('toast');

  const lobbyNameEl = document.getElementById('lobby-name');
  const lobbyCodeEl = document.getElementById('lobby-code');
  const lobbyPlayersEl = document.getElementById('lobby-players');
  const mapPickerEl = document.getElementById('map-picker');
  const mapTypePickerEl = document.getElementById('map-type-picker');
  const hpInputEl = document.getElementById('hp-input');
  const btnHpMinus = document.getElementById('btn-hp-minus');
  const btnHpPlus = document.getElementById('btn-hp-plus');
  const modePickerEl = document.getElementById('mode-picker');
  const modeDescEl = document.getElementById('mode-desc');
  const killTargetGroup = document.getElementById('kill-target-group');
  const killTargetLabelEl = document.getElementById('kill-target-label');
  const killTargetInputEl = document.getElementById('kills-input');
  const btnKillsMinus = document.getElementById('btn-kills-minus');
  const btnKillsPlus = document.getElementById('btn-kills-plus');
  const winScoreGroup = document.getElementById('win-score-group');
  const winScoreInputEl = document.getElementById('win-score-input');
  const btnWinMinus = document.getElementById('btn-win-minus');
  const btnWinPlus = document.getElementById('btn-win-plus');
  const teamGroupEl = document.getElementById('team-group');
  const teamSummaryEl = document.getElementById('team-summary');
  const teamWarningEl = document.getElementById('team-warning');
  const btnShuffleTeams = document.getElementById('btn-shuffle-teams');
  const btnStart = document.getElementById('btn-start');
  const btnLeaveLobby = document.getElementById('btn-leave-lobby');

  const hudScores = document.getElementById('hud-scores');
  const matchIntroEl = document.getElementById('match-intro');
  const matchIntroModeEl = document.getElementById('match-intro-mode');
  const matchIntroGoalEl = document.getElementById('match-intro-goal');
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const spectatorBanner = document.getElementById('spectator-banner');
  const respawnBanner = document.getElementById('respawn-banner');
  const overlayRound = document.getElementById('overlay-round');
  const overlayTitle = document.getElementById('overlay-title');
  const overlaySub = document.getElementById('overlay-sub');

  const joystickZone = document.getElementById('joystick-zone');
  const joystickStick = document.getElementById('joystick-stick');
  const btnMoveToggle = document.getElementById('btn-move-toggle');
  const btnFire = document.getElementById('btn-fire');
  const touchControls = document.getElementById('touch-controls');

  // ---------- 状态 ----------
  let ws = null;
  let myId = null;
  let hostId = null;
  let roomCode = null;
  let roomName = '';
  let players = [];
  let spectators = [];
  let spectating = false; // true 时自己是观战者：没有坦克、不能操作，整场比赛结束后转正
  let roomList = [];
  let toastTimer = null;
  let joinPendingCode = null;
  let joinPendingTimer = null;
  // 开局公告：本场是否还欠一次「模式 + 目标」的展示。
  // 在 joined 时置位、game_start 时消费，保证每场只在第一次进入对局时显示一次。
  let matchIntroPending = false;
  let matchIntroTimer = null;
  let matchIntroHideTimer = null;
  const NICKNAME_KEY = 'tank.nickname';
  // 触屏虚拟按键的控制方式：joystick=摇杆（默认）/ dpad=十字键，只保存在本机
  const CONTROL_MODE_KEY = 'tank.controlMode';
  const CONTROL_MODE_INFO = {
    joystick: '拖动摇杆指向想去的方向，坦克会自动转向；用右侧「移动/静止」切换前进或只转向。',
    dpad: '十字键：◀ ▶ 原地转向，▲ 前进，▼ 后退。上下键直接控制前进/后退，不需要「移动/静止」切换。',
  };
  let controlMode = 'joystick';
  let mapSize = 'medium'; // 房间级设置，以服务端广播为准；只有房主能改（不进入房间列表）
  let mapType = 'maze'; // 房间级设置：maze/open/symmetric/scatter/random，以服务端广播为准
  let maxHp = 5; // 房间级设置：每回合初始血量，以服务端广播为准；只有房主能改
  let mode = 'brawl'; // 房间级设置：brawl=大乱斗（默认）/ team=团队模式 / classic=经典模式
  let killTarget = 10; // 大乱斗 / 团队模式胜利所需击杀数，以服务端广播为准
  let winScore = 5; // 经典模式胜利所需回合数，以服务端广播为准
  let teamKills = { red: 0, blue: 0 }; // 团队模式：红蓝两队总击杀，以 state / match_end 为准
  let myTeam = null; // 自己所在队伍（red / blue），非团队模式或观战时为 null
  let respawnDelay = 10; // 大乱斗复活等待秒数，以服务端广播为准（仅用于文案）
  const MIN_HP = 1;
  const MAX_HP = 10;
  const MIN_KILLS = 5;
  const MAX_KILLS = 30;
  const MIN_WIN_SCORE = 1;
  const MAX_WIN_SCORE = 10;
  let maze = null;
  let worldW = 960, worldH = 640;
  let tanks = [];
  let bullets = [];
  let items = []; // 场上道具：{id, type, x, y}
  let explosions = []; // 死亡爆炸特效：{x, y, color, startTime}
  let trails = []; // 加速拖尾粒子：{x, y, start}
  let spawnBlockFx = []; // 出生保护格挡火花：{x, y, start}
  let prevPos = {}; // id -> 上一帧坐标 {x, y}，用来算加速拖尾的运动方向
  let prevShield = {}; // id -> 上一帧是否有护盾，用来检测"护盾刚被打破"这一瞬间
  const ITEM_COLORS = { shield: '#3A86FF', speed: '#FFD60A', triple: '#E63946', homing: '#B565D8', invisible: '#8FBDB6', repair: '#2ECC71' };
  const ITEM_GLYPHS = { shield: '盾', speed: '速', triple: '三', homing: '追', invisible: '隐', repair: '修' };
  // 与服务端 MAP_PRESETS 一一对应：这里只用 key 发请求、用尺寸做展示文案，
  // 真正的行列数以服务端开局广播的 game_start 为准。
  const MAP_OPTIONS = [
    { key: 'small', name: '小', cols: 9, rows: 6 },
    { key: 'medium', name: '中', cols: 12, rows: 8 },
    { key: 'large', name: '大', cols: 15, rows: 10 },
  ];
  // 与服务端 MAP_TYPES 一一对应：这里只用 key 发请求、用名称/摘要做展示，
  // 真正的墙体和碰撞数据以服务端 game_start 广播的 maze 为准。
  const MAP_TYPE_OPTIONS = [
    { key: 'maze', name: '迷宫', desc: '随机通道' },
    { key: 'open', name: '空旷', desc: '无内墙' },
    { key: 'symmetric', name: '对称', desc: '中心堡垒' },
    { key: 'scatter', name: '散块', desc: '随机短墙' },
    { key: 'random', name: '随机', desc: '每回合抽一种' },
  ];
  // 与服务端 MODES 一一对应。大乱斗是默认模式，团队模式沿用大乱斗的复活节奏，
  // 经典模式保留原有的淘汰制玩法。
  const MODE_OPTIONS = [
    { key: 'brawl', name: '大乱斗', tagline: '10 秒复活 · 击杀定胜负' },
    { key: 'team', name: '团队模式', tagline: '红蓝对抗 · 团队击杀定胜负' },
    { key: 'classic', name: '经典模式', tagline: '一条命 · 回合定胜负' },
  ];
  function modeName(key) {
    const found = MODE_OPTIONS.find((m) => m.key === key);
    return found ? found.name : '大乱斗';
  }

  // 与服务端 TEAMS 一一对应。服务端只下发队伍 key，名称/颜色在客户端统一映射，
  // 坦克、HUD、大厅徽章和结算文案都走这一份配置。
  const TEAM_META = {
    red: { name: '红队', color: '#E63946' },
    blue: { name: '蓝队', color: '#3A86FF' },
  };
  const TEAM_KEYS = ['red', 'blue'];
  function teamName(key) {
    return TEAM_META[key] ? TEAM_META[key].name : '未分队';
  }
  function teamColor(key) {
    return TEAM_META[key] ? TEAM_META[key].color : '#F2FBF9';
  }
  function otherTeamKey(key) {
    return key === 'red' ? 'blue' : 'red';
  }
  function isTeamMode() {
    return mode === 'team';
  }
  // 大乱斗和团队模式都有 10 秒复活；经典模式没有。
  function hasRespawn() {
    return mode === 'brawl' || mode === 'team';
  }
  // 团队模式下坦克/爆炸统一使用队伍色；个人颜色只在非团队模式使用。
  function displayColor(t) {
    if (isTeamMode() && t && TEAM_META[t.team]) return TEAM_META[t.team].color;
    return (t && t.color) || '#F2FBF9';
  }
  const SELF_INVISIBLE_ALPHA = 0.35; // 自己隐身时，自己视角看到的半透明程度
  const TANK_RADIUS = 15; // 仅用于绘制光环/角标的偏移，需与服务端坦克半径保持一致
  const SPAWN_PROTECT_TIME = 3; // 与服务端 SPAWN_PROTECT_TIME 一致，用于把剩余秒数换算成进度弧比例
  const SPAWN_ANIM_SCALE = 5; // 重生动画的起始放大倍数，收缩到正常 1 倍
  const SPAWN_ANIM_ALPHA = 0; // 起始不透明度：0 = 完全透明，随动画淡入到 1
  let spawnAnimTime = 0.75; // 重生动画总时长（秒），开局时以 game_start 广播为准
  const AMMO_MAX = 5; // 与服务端 AMMO_MAX 一致，仅作为 ammo 消息到达前的初始显示值
  // 弹药是个人资源，服务端只私发本人的数量；这里只会存自己这一份，
  // 所以其他坦克身上根本没有弹药数据，界面上也无从显示。
  let myAmmo = AMMO_MAX;
  let myAmmoMax = AMMO_MAX;
  let myAmmoReload = 0; // 当前这一发的装填进度 0..1，满弹时为 0
  let prevAlive = {};  // id -> 上一帧是否存活，用来检测"刚刚死亡"这一瞬间
  let lastHp = {};     // id -> 最近一次收到的血量，用于 HUD 在回合结束/重开时仍显示正确数值
  let hitFlash = {};   // id -> 最近一次受击的时间戳，用来在车身上闪一层白

  // 名字标签贴边时用来把绘制坐标钳制在 canvas 内的内边距
  const LABEL_PAD = 4;
  const LABEL_TOP_PAD = 14; // 需要能容下 13px 字体的整行高度，不然顶部还是会被裁一点
  function clampNum(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}`);
    ws = socket;
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', () => {
      if (ws !== socket) return; // 已经被新连接替换掉的旧 socket，忽略
      ws = null;
      closeAllModals();
      if (views.landing.classList.contains('hidden')) {
        showView('landing');
        showToast('与服务器断开连接，请重新开始');
      } else {
        landingErrorShow('与服务器断开连接，请刷新页面重试');
      }
    });
    return new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
  }

  async function ensureConnected() {
    if (ws && ws.readyState === WebSocket.OPEN) return true;
    try {
      await connect();
      return true;
    } catch (e) {
      ws = null;
      return false;
    }
  }

  function landingErrorShow(msg) { landingError.textContent = msg; }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3200);
  }

  // 房间列表可能很长，点下面的房间失败时只在顶部写一行会看不到，所以同时弹一个轻提示。
  function roomsErrorShow(msg) {
    roomsErrorEl.textContent = msg;
    showToast(msg);
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function nicknameValue() {
    return nicknameEl.value.trim();
  }

  // 昵称保存在本地，下次打开页面自动带出来；主页仍然只有一个「开始游戏」按钮。
  try {
    nicknameEl.value = localStorage.getItem(NICKNAME_KEY) || '';
  } catch (e) {
    // 隐私模式下 localStorage 可能不可用，忽略即可
  }
  nicknameEl.addEventListener('input', () => {
    try {
      localStorage.setItem(NICKNAME_KEY, nicknameEl.value);
    } catch (e) {
      // 忽略存储失败，不影响游戏
    }
  });

  // ---------- 主页 / 房间列表 ----------
  btnEnterRooms.addEventListener('click', async () => {
    landingErrorShow('');
    try {
      localStorage.setItem(NICKNAME_KEY, nicknameEl.value);
    } catch (e) {
      // 忽略存储失败
    }
    const ok = await ensureConnected();
    if (!ok) {
      landingErrorShow('无法连接服务器');
      return;
    }
    roomsErrorEl.textContent = '';
    roomsNicknameEl.textContent = nicknameValue() || '未命名指挥官';
    showView('rooms');
    send({ type: 'list_rooms' });
  });

  btnBackHome.addEventListener('click', () => {
    showView('landing');
  });

  function openModal(modal, focusEl) {
    modal.classList.remove('hidden');
    // 等 hidden 移除、元素可聚焦后再 focus，避免部分浏览器里 focus 落空
    setTimeout(() => focusEl.focus(), 0);
  }

  function closeModal(modal) {
    modal.classList.add('hidden');
  }

  function closeAllModals() {
    closeModal(modalCreate);
    closeModal(modalJoin);
  }

  btnCreateRoom.addEventListener('click', () => {
    createRoomNameEl.value = '';
    createErrorEl.textContent = '';
    openModal(modalCreate, createRoomNameEl);
  });

  createRoomNameEl.addEventListener('input', () => {
    createErrorEl.textContent = '';
  });

  btnJoinRoom.addEventListener('click', () => {
    joinCodeEl.value = '';
    joinErrorEl.textContent = '';
    openModal(modalJoin, joinCodeEl);
  });

  joinCodeEl.addEventListener('input', () => {
    joinCodeEl.value = joinCodeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    joinErrorEl.textContent = '';
  });

  formCreate.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newRoomName = createRoomNameEl.value.trim();
    if (!newRoomName) {
      createErrorEl.textContent = '请先填写房间名';
      createRoomNameEl.focus();
      return;
    }
    createErrorEl.textContent = '';
    if (!(await ensureConnected())) {
      createErrorEl.textContent = '无法连接服务器';
      return;
    }
    send({ type: 'create_room', name: nicknameValue(), roomName: newRoomName });
  });

  formJoin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = joinCodeEl.value.trim().toUpperCase();
    if (code.length !== 4) {
      joinErrorEl.textContent = '请输入 4 位房间码';
      joinCodeEl.focus();
      return;
    }
    joinErrorEl.textContent = '';
    if (!(await ensureConnected())) {
      joinErrorEl.textContent = '无法连接服务器';
      return;
    }
    send({ type: 'join_room', name: nicknameValue(), code });
  });

  modalCreate.querySelector('[data-close]').addEventListener('click', () => closeModal(modalCreate));
  modalJoin.querySelector('[data-close]').addEventListener('click', () => closeModal(modalJoin));
  [modalCreate, modalJoin].forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 设置页用 Esc 返回开始页，比弹窗关闭优先
    if (!views.settings.classList.contains('hidden')) {
      showView('landing');
      return;
    }
    closeAllModals();
  });

  btnStart.addEventListener('click', () => send({ type: 'start_game' }));
  btnShuffleTeams.addEventListener('click', () => {
    if (myId === hostId && isTeamMode()) send({ type: 'shuffle_teams' });
  });
  btnLeaveLobby.addEventListener('click', () => {
    send({ type: 'leave_room' });
    resetAfterLeave();
    roomsErrorEl.textContent = '';
    roomsNicknameEl.textContent = nicknameValue() || '未命名指挥官';
    showView('rooms');
    send({ type: 'list_rooms' });
  });

  // ---------- 消息处理 ----------
  function onMessage(evt) {
    const msg = JSON.parse(evt.data);
    switch (msg.type) {
      case 'room_list':
        roomList = Array.isArray(msg.rooms) ? msg.rooms : [];
        renderRooms();
        break;

      case 'joined':
        joinPendingCode = null;
        clearTimeout(joinPendingTimer);
        myId = msg.playerId;
        hostId = msg.hostId;
        roomCode = msg.code;
        roomName = msg.roomName || '';
        players = msg.players || [];
        spectators = msg.spectators || [];
        spectating = !!msg.spectating;
        // 每次进新房都从零开始，避免上一场大厅残留的团队分/队伍高亮。
        teamKills = { red: 0, blue: 0 };
        myTeam = null;
        // 中途加入的观战者不播开局公告；只有以玩家身份进入下一场时才欠一次展示。
        matchIntroPending = !spectating;
        mapType = msg.mapType || 'maze';
        mapSize = msg.mapSize || 'medium';
        maxHp = msg.maxHp || 5;
        syncModeSettings(msg);
        syncMyTeam();
        lobbyCodeEl.textContent = roomCode;
        lobbyNameEl.textContent = roomName || '未命名房间';
        roomsErrorEl.textContent = '';
        closeAllModals();
        renderLobby();
        // 观战者先停在当前页，等服务端紧接着补发的 game_start 快照再切到对局画面。
        if (!spectating) showView('lobby');
        updateSpectatorUi();
        break;

      case 'error': {
        joinPendingCode = null;
        clearTimeout(joinPendingTimer);
        const message = msg.message || '操作失败';
        if (!modalCreate.classList.contains('hidden')) {
          createErrorEl.textContent = message;
        } else if (!modalJoin.classList.contains('hidden')) {
          joinErrorEl.textContent = message;
        } else if (!views.rooms.classList.contains('hidden')) {
          roomsErrorShow(message);
        } else if (!views.landing.classList.contains('hidden')) {
          landingErrorShow(message);
        } else {
          // 大厅/游戏里没有主页错误行，用轻提示，避免错误信息被隐藏
          showToast(message);
        }
        break;
      }

      case 'room_update':
        hostId = msg.hostId;
        roomName = msg.roomName || roomName;
        players = msg.players || players;
        spectators = Array.isArray(msg.spectators) ? msg.spectators : spectators;
        if (myId) {
          if (players.some((p) => p.id === myId)) spectating = false;
          else if (spectators.some((s) => s.id === myId)) spectating = true;
        }
        mapType = msg.mapType || mapType;
        mapSize = msg.mapSize || mapSize;
        maxHp = msg.maxHp || maxHp;
        syncModeSettings(msg);
        syncMyTeam();
        lobbyNameEl.textContent = roomName || '未命名房间';
        renderLobby();
        // 游戏中玩家进出不一定伴随 state 变化，这里立即按最新名单重建顶部标签。
        if (!views.game.classList.contains('hidden')) {
          renderHud();
          renderHudFromTanks();
          updateSpectatorUi();
        }
        break;

      case 'game_start':
        maze = msg.maze;
        worldW = msg.worldW;
        worldH = msg.worldH;
        mapType = msg.mapType || mapType;
        maxHp = msg.maxHp || maxHp;
        syncModeSettings(msg);
        spawnAnimTime = msg.spawnMaterialize || spawnAnimTime; // 重生动画总时长，与服务端保持一致
        // 画布按世界尺寸调整（CSS 负责等比缩放到容器），这样不同档位的地图
        // 都能用同一套世界坐标绘制，不需要额外换算缩放比。
        canvas.width = worldW;
        canvas.height = worldH;
        players = msg.players || [];
        spectators = msg.spectators || [];
        // 观战快照会显式带 spectating；下一回合的普通 game_start 则通过"自己是否在 players 里"判断。
        spectating = !!msg.spectating || !players.some((p) => p.id === myId);
        syncMyTeam();
        // 消费本场的公告机会：只有以玩家身份进入对局才展示，观战快照不展示。
        const showIntro = matchIntroPending && !spectating;
        matchIntroPending = false;
        explosions = [];
        trails = [];
        spawnBlockFx = [];
        hitSparks = [];
        floatTexts = [];
        hitFlash = {};
        lastHp = {};
        items = [];
        prevAlive = {};
        prevShield = {};
        prevPos = {};
        // 新回合满弹：先按本地默认值重置，服务端第一帧 ammo 消息会立刻覆盖
        myAmmo = AMMO_MAX;
        myAmmoMax = AMMO_MAX;
        myAmmoReload = 0;
        overlayRound.classList.add('hidden');
        respawnBanner.classList.add('hidden');
        resetMoveToggleForRespawn();
        renderHud();
        showView('game');
        updateSpectatorUi();
        if (spectating && isTouchDevice) touchControls.classList.add('hidden');
        // 注意：必须等 showView('game') 之后再播，否则公告条在隐藏的视图里就把过渡走完了。
        if (showIntro) showMatchIntro();
        else hideMatchIntro();
        break;

      case 'ammo':
        // 服务端每 tick 只私发本人的弹药，不触发重绘——
        // 紧接着到达的 state 消息会统一 draw()，那时用的就是这里刚更新的值。
        myAmmo = msg.ammo;
        myAmmoMax = msg.max || AMMO_MAX;
        myAmmoReload = msg.reload || 0;
        break;

      case 'state': {
        const prevSpecIds = spectators.map((s) => s.id).join('|');
        spectators = Array.isArray(msg.spectators) ? msg.spectators : spectators;
        const activeChanged = syncPlayersFromTanks(msg.tanks);
        const scoreChanged = syncScoresFromTanks(msg.tanks);
        const teamChanged = syncTeamKills(msg.teamKills);
        const specChanged = prevSpecIds !== spectators.map((s) => s.id).join('|');
        if (myId) {
          if (players.some((p) => p.id === myId)) spectating = false;
          else if (spectators.some((s) => s.id === myId)) spectating = true;
        }
        syncMyTeam();

        detectDeaths(msg.tanks);
        updateSpeedTrails(msg.tanks);
        tanks = msg.tanks;
        msg.tanks.forEach((t) => { lastHp[t.id] = t.hp; });
        bullets = msg.bullets;
        items = msg.items || [];
        // 名单有进出、个人击杀数或团队总击杀变化时立即重建顶部标签。
        if (activeChanged || specChanged || scoreChanged || teamChanged) renderHud();
        syncSelfState(); // 自己阵亡/观战时收起触屏控件并清空输入
        applyJoystickSteering(); // 用刚收到的最新朝向重新计算该转左还是转右
        renderHudFromTanks();
        updateRespawnBanner();
        updateSpectatorUi();
        draw();
        break;
      }

      case 'spawn_block':
        // 出生保护挡下子弹：在命中点放一圈很快扩散消失的白色火花
        (msg.blocks || []).forEach((b) => spawnBlockFx.push({ x: b.x, y: b.y, start: performance.now() }));
        break;

      case 'damage':
        // 真正掉血：车身闪白 + 命中点火花 + 飘一个 -1
        (msg.hits || []).forEach((h) => {
          hitFlash[h.playerId] = performance.now();
          spawnHitSpark(h.x, h.y);
          spawnFloatText(h.x, h.y - 8, '-1', '#FF6B6B');
        });
        break;

      case 'item_pickup':
        // 维修包回血：在坦克上方飘一个绿色 +1；满血捡包时 heal 为 0，不飘字
        (msg.pickups || []).forEach((p) => {
          if (p.type !== 'repair' || !p.heal) return;
          const tank = tanks.find((t) => t.id === p.playerId);
          if (tank) spawnFloatText(tank.x, tank.y - 30, '+1', '#06D6A0');
        });
        break;

      case 'round_end':
        players = msg.scores || players;
        spectators = Array.isArray(msg.spectators) ? msg.spectators : spectators;
        renderHud();
        // renderHud 会重建 HUD，死状态（删除线/红心）会丢；用最后一帧坦克状态补回来，
        // 让结算展示期间阵亡玩家继续显示红色 + 删除线。
        renderHudFromTanks();
        overlayTitle.textContent = msg.winnerId
          ? `${nameOf(msg.winnerId)} 获胜本回合！`
          : '平局！';
        // 决胜回合 3 秒后会直接广播 match_end 回大厅，这里不能说"下一回合即将开始"。
        overlaySub.textContent = msg.final
          ? '比赛结束，即将返回房间…'
          : '下一回合即将开始…';
        overlayRound.classList.remove('hidden');
        break;

      case 'match_end':
        players = msg.scores || players;
        spectators = Array.isArray(msg.spectators) ? msg.spectators : [];
        if (msg.hostId) hostId = msg.hostId;
        syncModeSettings(msg);
        // 整场比赛结束后服务端会把观战者转正；这里同步切换成正式玩家。
        if (myId) {
          if (players.some((p) => p.id === myId)) spectating = false;
          else if (spectators.some((s) => s.id === myId)) spectating = true;
        }
        syncMyTeam();
        updateSpectatorUi();
        renderHud();
        renderHudFromTanks();
        respawnBanner.classList.add('hidden');
        // 整场结束：收掉可能还在播的开局公告，并给下一场重新记一次展示机会。
        matchIntroPending = true;
        hideMatchIntro();
        if (msg.reason === 'not_enough_players') {
          overlayTitle.textContent = '对手已离开';
          overlaySub.textContent = '即将返回房间…';
        } else if (mode === 'team') {
          // 团队模式：winnerTeam 为 null 表示同 tick 双达标平局。
          if (msg.winnerTeam && TEAM_META[msg.winnerTeam]) {
            overlayTitle.textContent = `🏆 ${teamName(msg.winnerTeam)} 以 ${teamKills[msg.winnerTeam]} 杀赢得整场比赛！`;
          } else {
            overlayTitle.textContent = '平局！';
          }
          overlaySub.textContent = '即将返回房间…';
        } else if (mode === 'brawl') {
          const champion = players.find((p) => p.id === msg.winnerId);
          overlayTitle.textContent = champion
            ? `🏆 ${champion.name} 以 ${champion.score} 杀赢得整场比赛！`
            : `🏆 ${nameOf(msg.winnerId)} 赢得整场比赛！`;
          overlaySub.textContent = '即将返回房间…';
        } else {
          overlayTitle.textContent = `🏆 ${nameOf(msg.winnerId)} 赢得整场比赛！`;
          overlaySub.textContent = '即将返回房间…';
        }
        overlayRound.classList.remove('hidden');
        setTimeout(() => {
          overlayRound.classList.add('hidden');
          renderLobby();
          showView('lobby');
        }, 2500);
        break;
    }
  }

  function nameOf(id) {
    const p = players.find((x) => x.id === id);
    return p ? p.name : '玩家';
  }

  // 房间级模式设置统一从服务端消息同步，避免 joined / room_update / game_start 各写一套。
  // 注意：不能再用"非 classic 即 brawl"的二元判断，否则 team 会被静默改成大乱斗。
  function syncModeSettings(msg) {
    if (msg.mode === 'brawl' || msg.mode === 'team' || msg.mode === 'classic') {
      mode = msg.mode;
    } else {
      mode = 'brawl';
    }
    if (Number.isInteger(msg.killTarget)) killTarget = msg.killTarget;
    if (Number.isInteger(msg.winScore)) winScore = msg.winScore;
    if (Number.isFinite(msg.respawnDelay)) respawnDelay = msg.respawnDelay;
    if (msg.teamKills && typeof msg.teamKills === 'object') syncTeamKills(msg.teamKills);
  }

  // 团队总击杀只在真的变化时返回 true，避免 30Hz 的 state 反复重建 HUD DOM。
  function syncTeamKills(raw) {
    if (!raw || typeof raw !== 'object') return false;
    const next = {
      red: Number.isFinite(raw.red) ? raw.red : 0,
      blue: Number.isFinite(raw.blue) ? raw.blue : 0,
    };
    if (next.red === teamKills.red && next.blue === teamKills.blue) return false;
    teamKills = next;
    return true;
  }

  function syncMyTeam() {
    const me = players.find((p) => p.id === myId);
    myTeam = me && (me.team === 'red' || me.team === 'blue') ? me.team : null;
  }

  // 对比本帧与上一帧的存活状态，一旦发现"从活着变成死亡"就在坦克当前位置生成一次爆炸特效；
  // 同时对比护盾状态，一旦发现"护盾刚被打破"（人还活着）就生成一次小一号的蓝色火花特效
  function detectDeaths(newTanks) {
    newTanks.forEach((t) => {
      if (prevAlive[t.id] && !t.alive) {
        // 团队模式用队伍色，普通模式用个人色。
        spawnExplosion(t.x, t.y, displayColor(t));
      } else if (t.alive && prevShield[t.id] && !t.shield) {
        spawnShieldBreak(t.x, t.y);
      }
      prevAlive[t.id] = t.alive;
      prevShield[t.id] = t.shield;
    });
  }

  // ---------- 房间列表渲染 ----------
  // 列表只展示选房间需要的信息：房间名、房间码、人数、状态、房主，以及开局后的游戏模式。
  // 地图/血量等房间内设置不在这里展示，也不通过 room_list 同步。
  function roomStatus(room) {
    if (room.playerCount >= room.maxPlayers) return { label: '已满', cls: 'full' };
    if (room.state !== 'lobby') return { label: '游戏中', cls: 'playing' };
    return { label: '等待中', cls: 'waiting' };
  }

  // 列表项本身就是按钮：等待中的房间直接加入；游戏中的房间以观战身份进入，整场比赛结束后转正。
  function joinRoomFromList(room) {
    if (joinPendingCode) return; // 上一次加入请求还没回来，避免连点发出多个 join_room
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      roomsErrorShow('与服务器断开连接，请重新开始');
      return;
    }
    if (room.playerCount >= room.maxPlayers) {
      roomsErrorShow(`房间已满（最多${room.maxPlayers}人）`);
      return;
    }
    roomsErrorEl.textContent = '';
    joinPendingCode = room.code;
    clearTimeout(joinPendingTimer);
    joinPendingTimer = setTimeout(() => {
      joinPendingCode = null;
    }, 4000);
    send({ type: 'join_room', name: nicknameValue(), code: room.code });
  }

  function renderRooms() {
    roomsListEl.replaceChildren();
    const hasRooms = roomList.length > 0;
    roomsEmptyEl.classList.toggle('hidden', hasRooms);
    roomsCountEl.textContent = hasRooms
      ? `共 ${roomList.length} 个房间`
      : '暂无房间';

    roomList.forEach((room) => {
      // 用 button 而不是 article：整张卡片可点击、可键盘聚焦，按 Enter/空格也能直接加入。
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'room-card';
      card.dataset.code = room.code;
      const status = roomStatus(room);
      const joinable = room.playerCount < room.maxPlayers;
      card.classList.toggle('room-card-joinable', joinable);
      card.title = !joinable ? '房间已满' : `点击加入「${room.name || '未命名房间'}」`;
      card.addEventListener('click', () => joinRoomFromList(room));

      const main = document.createElement('span');
      main.className = 'room-main';

      const top = document.createElement('span');
      top.className = 'room-top';
      const name = document.createElement('span');
      name.className = 'room-name';
      name.textContent = room.name || '未命名房间';
      const badge = document.createElement('span');
      badge.className = `room-badge ${status.cls}`;
      badge.textContent = status.label;
      top.appendChild(name);
      top.appendChild(badge);

      const meta = document.createElement('span');
      meta.className = 'room-meta';

      const codeLabel = document.createElement('span');
      codeLabel.append('房间码 ');
      const code = document.createElement('span');
      code.className = 'room-code';
      code.textContent = room.code;
      codeLabel.appendChild(code);
      meta.appendChild(codeLabel);

      const count = document.createElement('span');
      count.textContent = `玩家 ${room.playerCount}/${room.maxPlayers}`;
      meta.appendChild(count);

      if (room.hostName) {
        const host = document.createElement('span');
        host.textContent = `房主 ${room.hostName}`;
        meta.appendChild(host);
      }

      // 模式徽章：列表只突出"这个房间打什么模式"，具体目标数值进房后再看。
      if (room.state !== 'lobby') {
        const roomMode = document.createElement('span');
        roomMode.className = 'room-mode';
        roomMode.textContent = modeName(room.mode);
        meta.appendChild(roomMode);
      }

      main.appendChild(top);
      main.appendChild(meta);
      card.appendChild(main);

      if (joinable) {
        const enter = document.createElement('span');
        enter.className = 'room-enter';
        enter.textContent = '加入 →';
        card.appendChild(enter);
      }

      roomsListEl.appendChild(card);
    });
  }

  // 离开房间后回到列表：清掉上一局的本地状态，避免残留的 HUD/画布数据影响下一次进入房间。
  function resetAfterLeave() {
    myId = null;
    hostId = null;
    roomCode = null;
    roomName = '';
    players = [];
    spectators = [];
    spectating = false;
    teamKills = { red: 0, blue: 0 };
    myTeam = null;
    roomList = [];
    maze = null;
    tanks = [];
    bullets = [];
    items = [];
    explosions = [];
    trails = [];
    spawnBlockFx = [];
    hitSparks = [];
    floatTexts = [];
    prevAlive = {};
    prevShield = {};
    prevPos = {};
    hitFlash = {};
    lastHp = {};
    lobbyNameEl.textContent = '----';
    lobbyCodeEl.textContent = '----';
    lobbyPlayersEl.replaceChildren();
    hudScores.replaceChildren();
    hudScores.classList.remove('hud-team-mode');
    matchIntroPending = false;
    hideMatchIntro();
    spectatorBanner.classList.add('hidden');
    respawnBanner.classList.add('hidden');
    overlayRound.classList.add('hidden');
    renderRooms();
  }

  // ---------- 大厅渲染 ----------
  function teamCountsFromPlayers() {
    let red = 0;
    let blue = 0;
    for (const p of players) {
      if (p.team === 'red') red += 1;
      else if (p.team === 'blue') blue += 1;
    }
    return { red, blue };
  }

  function makeLobbyPlayerRow(p) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    // 团队模式下圆点用队伍色，一眼能看出队友/对手；其他模式保留个人色。
    dot.style.background = isTeamMode() ? teamColor(p.team) : p.color;
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = p.name;
    row.appendChild(dot);
    row.appendChild(name);
    if (p.id === hostId) {
      const tag = document.createElement('span');
      tag.className = 'player-tag';
      tag.textContent = '房主';
      row.appendChild(tag);
    }
    if (isTeamMode()) {
      const badge = document.createElement('span');
      badge.className = `player-team-badge ${p.team === 'blue' ? 'blue' : 'red'}`;
      badge.textContent = teamName(p.team);
      row.appendChild(badge);

      // 只有房主能换队；点击后等服务端 room_update 回来再刷新，不做本地乐观更新。
      if (myId === hostId) {
        const targetTeam = p.team === 'blue' ? 'red' : 'blue';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'player-team-btn';
        btn.textContent = `换到${teamName(targetTeam)}`;
        btn.addEventListener('click', () => {
          send({ type: 'set_player_team', targetId: p.id, team: targetTeam });
        });
        row.appendChild(btn);
      }
    }
    return row;
  }

  function renderLobbyPlayers() {
    lobbyPlayersEl.innerHTML = '';
    if (!isTeamMode()) {
      players.forEach((p) => lobbyPlayersEl.appendChild(makeLobbyPlayerRow(p)));
      return;
    }

    // 团队模式按红/蓝分组显示，队伍人数直接写在组标题右侧。
    const groups = TEAM_KEYS.map((key) => ({ key, list: players.filter((p) => p.team === key) }));
    const unassigned = players.filter((p) => !TEAM_META[p.team]);
    if (unassigned.length > 0) groups.push({ key: null, list: unassigned });

    groups.forEach(({ key, list }) => {
      const section = document.createElement('div');
      section.className = 'lobby-team-section';
      const head = document.createElement('div');
      head.className = 'lobby-team-head';
      const label = document.createElement('span');
      label.textContent = key ? teamName(key) : '未分队';
      if (key) label.style.color = teamColor(key);
      const count = document.createElement('span');
      count.className = 'lobby-team-count';
      count.textContent = `${list.length} 人`;
      head.appendChild(label);
      head.appendChild(count);
      section.appendChild(head);
      list.forEach((p) => section.appendChild(makeLobbyPlayerRow(p)));
      lobbyPlayersEl.appendChild(section);
    });
  }

  function renderTeamSetting() {
    teamGroupEl.classList.toggle('hidden', !isTeamMode());
    if (!isTeamMode()) return;

    const counts = teamCountsFromPlayers();
    teamSummaryEl.textContent = `红队 ${counts.red} 人 · 蓝队 ${counts.blue} 人`;
    let warning = '';
    if (counts.red === 0 || counts.blue === 0) warning = '两队都需要至少 1 名玩家才能开始';
    else if (counts.red !== counts.blue) warning = '两队人数不等，仍可开始';
    teamWarningEl.textContent = warning;
    teamWarningEl.classList.toggle('hidden', !warning);
    btnShuffleTeams.disabled = myId !== hostId || players.length < 2;
  }

  function renderLobby() {
    lobbyNameEl.textContent = roomName || '未命名房间';
    lobbyNameEl.title = lobbyNameEl.textContent;
    lobbyCodeEl.textContent = roomCode || '----';
    renderLobbyPlayers();

    const amHost = myId === hostId;
    const counts = teamCountsFromPlayers();
    if (amHost) {
      if (players.length < 2) {
        btnStart.disabled = true;
        btnStart.textContent = '等待玩家加入…';
      } else if (isTeamMode() && (counts.red === 0 || counts.blue === 0)) {
        btnStart.disabled = true;
        btnStart.textContent = '等待两队都有玩家…';
      } else {
        btnStart.disabled = false;
        btnStart.textContent = isTeamMode()
          ? `开始游戏（红 ${counts.red} · 蓝 ${counts.blue}）`
          : `开始游戏（${players.length}人）`;
      }
    } else {
      btnStart.disabled = true;
      btnStart.textContent = '等待房主开始…';
    }

    renderModePicker();
    renderMapTypePicker();
    renderMapPicker();
    renderHpSetting();
    renderKillTargetSetting();
    renderWinScoreSetting();
    renderTeamSetting();
  }

  // 大厅右侧的地图类型选择：房主可点，其他玩家只能看到当前类型（按钮禁用，保持只读）。
  // 和地图大小一样不做本地乐观更新，点击后等服务端 room_update 回来再改高亮。
  function renderMapTypePicker() {
    const amHost = myId === hostId;
    mapTypePickerEl.innerHTML = '';
    MAP_TYPE_OPTIONS.forEach((opt) => {
      const isActive = opt.key === mapType;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-type-option' + (isActive ? ' active' : '');
      btn.dataset.mapType = opt.key;
      btn.disabled = !amHost;
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');

      const name = document.createElement('span');
      name.className = 'map-type-option-name';
      name.textContent = opt.name;

      const desc = document.createElement('span');
      desc.className = 'map-type-option-desc';
      desc.textContent = opt.desc;

      btn.appendChild(name);
      btn.appendChild(desc);
      btn.addEventListener('click', () => {
        if (myId !== hostId || mapType === opt.key) return;
        send({ type: 'set_map_type', mapType: opt.key });
      });
      mapTypePickerEl.appendChild(btn);
    });
  }

  // 大厅右侧的地图大小选择：房主可点，其他玩家只能看到当前档位（按钮禁用，保持只读）。
  // 不做本地乐观更新——点击后等服务端 room_update 回来再改高亮，
  // 这样房主改档位时所有人的显示始终来自同一份权威状态。
  function renderMapPicker() {
    const amHost = myId === hostId;
    mapPickerEl.innerHTML = '';
    MAP_OPTIONS.forEach((opt) => {
      const isActive = opt.key === mapSize;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'map-option' + (isActive ? ' active' : '');
      btn.dataset.size = opt.key;
      btn.disabled = !amHost;
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');

      const name = document.createElement('span');
      name.className = 'map-option-name';
      name.textContent = opt.name;

      const dims = document.createElement('span');
      dims.className = 'map-option-dims';
      dims.textContent = `${opt.cols} × ${opt.rows}`;

      btn.appendChild(name);
      btn.appendChild(dims);
      btn.addEventListener('click', () => {
        if (myId !== hostId || mapSize === opt.key) return;
        send({ type: 'set_map_size', size: opt.key });
      });
      mapPickerEl.appendChild(btn);
    });
  }

  // ---------- 游戏模式 ----------
  // 大厅右侧的模式选择：大乱斗 / 团队模式 / 经典模式。和地图/血量一样只做只读渲染，
  // 点击后等服务端 room_update 回来再改高亮，保证所有人看到同一份权威状态。
  function renderModePicker() {
    const amHost = myId === hostId;
    modePickerEl.innerHTML = '';
    MODE_OPTIONS.forEach((opt) => {
      const isActive = opt.key === mode;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mode-option' + (isActive ? ' active' : '');
      btn.dataset.mode = opt.key;
      btn.disabled = !amHost;
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');

      const name = document.createElement('span');
      name.className = 'mode-option-name';
      name.textContent = opt.name;

      const tagline = document.createElement('span');
      tagline.className = 'mode-option-tagline';
      tagline.textContent = opt.tagline;

      btn.appendChild(name);
      btn.appendChild(tagline);
      btn.addEventListener('click', () => {
        if (myId !== hostId || mode === opt.key) return;
        send({ type: 'set_mode', mode: opt.key });
      });
      modePickerEl.appendChild(btn);
    });

    if (mode === 'brawl') {
      modeDescEl.textContent = `阵亡后 ${respawnDelay} 秒复活，先达到 ${killTarget} 次击杀者获胜。`;
    } else if (mode === 'team') {
      modeDescEl.textContent = `红蓝两队对抗，阵亡后 ${respawnDelay} 秒复活；先达到 ${killTarget} 次团队击杀的队伍获胜，友军伤害关闭。`;
    } else {
      modeDescEl.textContent = `阵亡后本回合出局，先赢 ${winScore} 回合者获胜。`;
    }
    killTargetGroup.classList.toggle('hidden', mode !== 'brawl' && mode !== 'team');
    winScoreGroup.classList.toggle('hidden', mode !== 'classic');
  }

  // ---------- 大乱斗 / 团队模式击杀目标 ----------
  function clampKillTarget(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return killTarget;
    return clampNum(n, MIN_KILLS, MAX_KILLS);
  }

  function renderKillTargetSetting() {
    const amHost = myId === hostId;
    if (document.activeElement !== killTargetInputEl) killTargetInputEl.value = String(killTarget);
    // 团队模式下同一个输入框表示"队伍总击杀目标"，标题跟着模式切换。
    killTargetLabelEl.textContent = isTeamMode() ? '团队击杀目标' : '击杀目标';
    const disabled = !amHost || (mode !== 'brawl' && mode !== 'team');
    killTargetInputEl.disabled = disabled;
    btnKillsMinus.disabled = disabled;
    btnKillsPlus.disabled = disabled;
  }

  function requestKillTarget(value) {
    if (mode !== 'brawl' && mode !== 'team') return;
    const next = clampKillTarget(value);
    killTargetInputEl.value = String(next);
    if (next !== killTarget) send({ type: 'set_kill_target', kills: next });
  }

  killTargetInputEl.addEventListener('change', () => requestKillTarget(killTargetInputEl.value));
  btnKillsMinus.addEventListener('click', () => requestKillTarget(clampKillTarget(killTargetInputEl.value) - 1));
  btnKillsPlus.addEventListener('click', () => requestKillTarget(clampKillTarget(killTargetInputEl.value) + 1));

  // ---------- 经典模式胜利分数 ----------
  function clampWinScore(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return winScore;
    return clampNum(n, MIN_WIN_SCORE, MAX_WIN_SCORE);
  }

  function renderWinScoreSetting() {
    const amHost = myId === hostId;
    if (document.activeElement !== winScoreInputEl) winScoreInputEl.value = String(winScore);
    const disabled = !amHost || mode !== 'classic';
    winScoreInputEl.disabled = disabled;
    btnWinMinus.disabled = disabled;
    btnWinPlus.disabled = disabled;
  }

  function requestWinScore(value) {
    if (mode !== 'classic') return;
    const next = clampWinScore(value);
    winScoreInputEl.value = String(next);
    if (next !== winScore) send({ type: 'set_win_score', score: next });
  }

  winScoreInputEl.addEventListener('change', () => requestWinScore(winScoreInputEl.value));
  btnWinMinus.addEventListener('click', () => requestWinScore(clampWinScore(winScoreInputEl.value) - 1));
  btnWinPlus.addEventListener('click', () => requestWinScore(clampWinScore(winScoreInputEl.value) + 1));

  // ---------- 初始血量设置 ----------
  // 大厅右侧的初始血量：房主可直接输入 1–10 的整数，也可以用两侧的 −/+ 微调；
  // 其他玩家只能看到当前数值（控件禁用）。和地图大小一样不做本地乐观更新：
  // 改完等服务端 room_update 回来，所有人看到的血量上限始终来自同一份权威状态。
  function clampHpValue(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return maxHp;
    return clampNum(n, MIN_HP, MAX_HP);
  }

  function renderHpSetting() {
    const amHost = myId === hostId;
    // 正在输入时不要覆盖用户正在敲的内容；失焦/发送后自然会被服务端值收敛
    if (document.activeElement !== hpInputEl) hpInputEl.value = String(maxHp);
    hpInputEl.disabled = !amHost;
    btnHpMinus.disabled = !amHost;
    btnHpPlus.disabled = !amHost;
  }

  function requestHp(value) {
    const next = clampHpValue(value);
    hpInputEl.value = String(next);
    if (next !== maxHp) send({ type: 'set_hp', hp: next });
  }

  hpInputEl.addEventListener('change', () => requestHp(hpInputEl.value));
  btnHpMinus.addEventListener('click', () => requestHp(clampHpValue(hpInputEl.value) - 1));
  btnHpPlus.addEventListener('click', () => requestHp(clampHpValue(hpInputEl.value) + 1));

  // ---------- HUD ----------
  // 顶部血量的爱心用内联 SVG 画，颜色跟随 .hud-hp 的 currentColor（残血时整组变红）
  const HEART_PATH = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';

  function makeHeartIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'hud-hp-icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', HEART_PATH);
    svg.appendChild(path);
    return svg;
  }

  // 用 state 里的坦克名单兜底同步正式玩家名单：即使某条 room_update 没到，顶部标签也不会残留。
  function syncPlayersFromTanks(currentTanks) {
    if (!Array.isArray(currentTanks)) return false;
    const prevIds = players.map((p) => p.id).join('|');
    const nextIds = currentTanks.map((t) => t.id).join('|');
    if (prevIds === nextIds) return false;
    const oldById = new Map(players.map((p) => [p.id, p]));
    players = currentTanks.map((t) => {
      const old = oldById.get(t.id);
      return {
        id: t.id, name: t.name, color: t.color,
        team: t.team || null,
        score: typeof t.score === 'number' ? t.score : (old ? old.score : 0),
        connected: true,
      };
    });
    return true;
  }

  // 大乱斗没有 round_end 可以携带分数，击杀数只能从每帧 state 同步；
  // 只有真的变化时才要求重建 HUD，避免 30Hz 全量重绘 DOM。
  function syncScoresFromTanks(currentTanks) {
    if (!Array.isArray(currentTanks)) return false;
    let changed = false;
    for (const t of currentTanks) {
      if (typeof t.score !== 'number') continue;
      const p = players.find((x) => x.id === t.id);
      if (p && p.score !== t.score) {
        p.score = t.score;
        changed = true;
      }
    }
    return changed;
  }

  // ---------- 开局公告 ----------
  // 模式与胜负目标只在进入对局时短暂出现一次，不在对局中常驻，避免遮挡地图；
  // 中途加入的观战者不显示（matchIntroPending 在 joined 里就按身份决定是否置位）。
  const MATCH_INTRO_VISIBLE_MS = 2000; // 淡入 0.2s + 停留 1.8s
  const MATCH_INTRO_FADE_OUT_MS = 350; // 与 .match-intro.leaving 的 transition-duration 对齐

  function clearMatchIntroTimers() {
    clearTimeout(matchIntroTimer);
    clearTimeout(matchIntroHideTimer);
    matchIntroTimer = null;
    matchIntroHideTimer = null;
  }

  function showMatchIntro() {
    clearMatchIntroTimers();
    matchIntroEl.classList.remove('hidden', 'leaving');
    // 先让 live region 可见再写文案，读屏才会把这次公告读出来
    matchIntroModeEl.textContent = modeName(mode);
    if (mode === 'brawl') {
      matchIntroGoalEl.textContent = `先达到 ${killTarget} 次击杀`;
    } else if (mode === 'team') {
      matchIntroGoalEl.textContent = `红蓝对抗 · 先达到 ${killTarget} 次团队击杀`;
    } else {
      matchIntroGoalEl.textContent = `先赢 ${winScore} 回合`;
    }
    // 强制回流：从 display:none 切出来的同一帧直接加 .show 不会触发过渡
    void matchIntroEl.offsetWidth;
    matchIntroEl.classList.add('show');
    matchIntroEl.parentElement.classList.add('showing-intro');
    matchIntroTimer = setTimeout(() => {
      matchIntroEl.classList.remove('show');
      matchIntroEl.classList.add('leaving');
      matchIntroHideTimer = setTimeout(() => {
        matchIntroEl.classList.add('hidden');
        matchIntroEl.classList.remove('leaving');
        // 等公告条完全淡出后再让观战横幅回位，避免淡出过程中两者短暂重叠
        matchIntroEl.parentElement.classList.remove('showing-intro');
        matchIntroHideTimer = null;
      }, MATCH_INTRO_FADE_OUT_MS);
      matchIntroTimer = null;
    }, MATCH_INTRO_VISIBLE_MS);
  }

  function hideMatchIntro() {
    clearMatchIntroTimers();
    matchIntroEl.classList.remove('show', 'leaving');
    matchIntroEl.classList.add('hidden');
    matchIntroEl.parentElement.classList.remove('showing-intro');
  }

  // 自己阵亡时在画布上显示复活倒计时；复活、观战、经典模式都自动隐藏。
  function updateRespawnBanner() {
    const self = tanks.find((t) => t.id === myId);
    const showing = hasRespawn() && !spectating && self && !self.alive && self.respawn > 0;
    if (!showing) {
      respawnBanner.classList.add('hidden');
      return;
    }
    respawnBanner.textContent = `${Math.ceil(self.respawn)}s 后复活`;
    respawnBanner.classList.remove('hidden');
  }

  function updateSpectatorUi() {
    spectatorBanner.classList.toggle('hidden', !spectating);
    if (spectating && isTouchDevice) touchControls.classList.add('hidden');
  }

  function makeHudPlayerItem(p) {
    const item = document.createElement('div');
    item.className = 'hud-item';
    item.id = 'hud-' + p.id;
    const dot = document.createElement('span');
    dot.className = 'hud-dot';
    // 团队模式下 HUD 圆点也用队伍色，和坦克车身保持一致。
    dot.style.background = isTeamMode() ? teamColor(p.team) : p.color;
    const label = document.createElement('span');
    label.className = 'hud-label';
    label.textContent = `${p.name} · ${p.score}`;
    const hp = document.createElement('span');
    hp.className = 'hud-hp';
    hp.id = 'hud-hp-' + p.id;
    hp.appendChild(makeHeartIcon());
    const hpText = document.createElement('span');
    hpText.className = 'hud-hp-text';
    // 刚开局还没收到 state 时先按满血显示，收到第一帧后就会被真实血量覆盖
    hpText.textContent = `${lastHp[p.id] ?? maxHp}/${maxHp}`;
    hp.appendChild(hpText);
    item.appendChild(dot);
    item.appendChild(label);
    item.appendChild(hp);
    return item;
  }

  function makeHudSpectatorItem(s) {
    const item = document.createElement('div');
    item.className = 'hud-item hud-item-spectator';
    item.id = 'hud-' + s.id;
    const dot = document.createElement('span');
    dot.className = 'hud-dot hud-dot-spectator';
    const label = document.createElement('span');
    label.className = 'hud-label';
    label.textContent = s.name;
    const tag = document.createElement('span');
    tag.className = 'hud-spectator-tag';
    tag.textContent = '观战';
    item.appendChild(dot);
    item.appendChild(label);
    item.appendChild(tag);
    return item;
  }

  // 团队模式 HUD：红蓝两块面板，标题显示"队伍总击杀 / 目标"，下面挂队员。
  function renderTeamHud() {
    const groups = TEAM_KEYS.map((key) => ({
      key,
      list: players.filter((p) => p.team === key),
    }));
    // 理论上开赛后不会出现未分队的人；兜底显示，避免有人从 HUD 里消失。
    const unassigned = players.filter((p) => !TEAM_META[p.team]);
    if (unassigned.length > 0) groups.push({ key: null, list: unassigned });

    groups.forEach(({ key, list }) => {
      const panel = document.createElement('div');
      panel.className = 'hud-team' + (key ? ` team-${key}` : '');
      if (key) panel.dataset.team = key;

      const head = document.createElement('div');
      head.className = 'hud-team-head';
      // 队伍名和「我方」标签放在同一个左侧分组里，标签才会紧跟在队名后面，
      // 而不是被右侧比分挤到中间。
      const title = document.createElement('span');
      title.className = 'hud-team-title';
      const name = document.createElement('span');
      name.className = 'hud-team-name';
      name.textContent = key ? teamName(key) : '未分队';
      if (key) name.style.color = teamColor(key);
      title.appendChild(name);
      if (key && key === myTeam) {
        const selfTag = document.createElement('span');
        selfTag.className = 'hud-team-self-tag';
        selfTag.textContent = '我方';
        title.appendChild(selfTag);
      }

      const score = document.createElement('span');
      score.className = 'hud-team-score';
      score.textContent = key ? `${teamKills[key] ?? 0} / ${killTarget}` : '';
      head.appendChild(title);
      head.appendChild(score);

      const members = document.createElement('div');
      members.className = 'hud-team-members';
      list.forEach((p) => members.appendChild(makeHudPlayerItem(p)));
      panel.appendChild(head);
      panel.appendChild(members);
      hudScores.appendChild(panel);
    });
  }

  function renderHud() {
    hudScores.innerHTML = '';
    const teamMode = isTeamMode();
    hudScores.classList.toggle('hud-team-mode', teamMode);

    if (teamMode) {
      renderTeamHud();
    } else {
      players.forEach((p) => hudScores.appendChild(makeHudPlayerItem(p)));
    }

    // 观战者仍然出现在顶部，但不显示血量/分数，用虚线和「观战」徽章区分。
    // 团队模式下单独占一行，避免混进某个队伍的成员区。
    if (teamMode && spectators.length > 0) {
      const wrap = document.createElement('div');
      wrap.className = 'hud-spectators';
      spectators.forEach((s) => wrap.appendChild(makeHudSpectatorItem(s)));
      hudScores.appendChild(wrap);
    } else {
      spectators.forEach((s) => hudScores.appendChild(makeHudSpectatorItem(s)));
    }
  }
  function renderHudFromTanks() {
    tanks.forEach((t) => {
      const el = document.getElementById('hud-' + t.id);
      if (el) el.classList.toggle('dead', !t.alive);
      const hpEl = document.getElementById('hud-hp-' + t.id);
      if (hpEl) {
        const hpTextEl = hpEl.querySelector('.hud-hp-text');
        if (hpTextEl) hpTextEl.textContent = `${t.hp}/${maxHp}`;
        // 残血（1/3 及以下）用红色提醒；阵亡后移除红色，恢复成正常绿色。
        // 这里用显式 add/remove 而不是 toggle，保证死亡瞬间一定会清掉 low。
        if (t.alive && t.hp > 0 && t.hp <= maxHp / 3) hpEl.classList.add('low');
        else hpEl.classList.remove('low');
      }
    });
  }

  // ---------- Canvas 绘制 ----------
  function drawMaze() {
    if (!maze) return;
    const { wallsV, wallsH, cell, cols, rows, wallThick } = maze;
    ctx.fillStyle = '#06110F';

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - 1; c++) {
        if (wallsV[r][c]) {
          ctx.fillRect((c + 1) * cell - wallThick / 2, r * cell - wallThick / 2, wallThick, cell + wallThick);
        }
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols; c++) {
        if (wallsH[r][c]) {
          ctx.fillRect(c * cell - wallThick / 2, (r + 1) * cell - wallThick / 2, cell + wallThick, wallThick);
        }
      }
    }
    // 边框
    ctx.strokeStyle = '#06110F';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, worldW - 8, worldH - 8);
  }

  // ---------- 头顶血条 ----------
  const HP_BAR_WIDTH_MAX = 56;

  // 血条颜色随剩余比例变化：绿 → 黄 → 红，残血一眼就能看出来
  function hpColor(ratio) {
    if (ratio > 0.6) return '#06D6A0';
    if (ratio > 0.3) return '#FFD60A';
    return '#E63946';
  }

  // 分段血条：格数 = 房间设置的初始血量（1–10），掉一格就是少 1 点。
  // 格数多时自动收窄格宽，整条宽度封顶 56px，不会比坦克大太多。
  function drawHpBar(t, barY) {
    const total = Math.max(1, maxHp);
    const hp = clampNum(t.hp == null ? total : t.hp, 0, total);
    const gap = total >= 10 ? 1 : 2;
    const barW = Math.min(HP_BAR_WIDTH_MAX, total * 8);
    const segW = (barW - (total - 1) * gap) / total;
    const x0 = clampNum(t.x - barW / 2, LABEL_PAD, canvas.width - barW - LABEL_PAD);
    const y = clampNum(barY, 2, canvas.height - 9);
    const color = hpColor(hp / total);

    ctx.save();
    // 深色背板：无论压在绿色地面、白色名字还是特效上都看得清
    ctx.fillStyle = '#06110F';
    ctx.beginPath();
    ctx.roundRect(x0 - 2, y - 2, barW + 4, 9, 3);
    ctx.fill();

    for (let i = 0; i < total; i++) {
      ctx.fillStyle = i < hp ? color : 'rgba(242, 251, 249, 0.16)';
      ctx.fillRect(x0 + i * (segW + gap), y, segW, 5);
    }
    ctx.restore();
  }

  function drawTank(t, now) {
    const isSelf = t.id === myId;
    // 阵亡后不画任何残影：车体直接消失，只留死亡爆炸特效
    if (!t.alive) return;
    // 别人视角：隐身的坦克完全不画（车身、炮管、护盾光环、名字全部跳过）
    if (t.invisible && !isSelf) return;
    // 重生动画期间：服务端判定这辆坦克还没有实体，所以只画正在凝聚的车身，
    // 名字、血条、护盾环、出生保护环全部等实体出现后再画。
    const spawning = t.spawnAnim > 0;
    // 团队模式统一用队伍色；普通模式保留每名玩家的个人颜色。
    const bodyColor = displayColor(t);

    ctx.save();
    ctx.translate(t.x, t.y);
    // 自己视角：自己隐身时整体变半透明，直观提示"我现在是隐身状态"
    if (t.invisible && isSelf) ctx.globalAlpha *= SELF_INVISIBLE_ALPHA;
    ctx.rotate(t.angle);

    ctx.strokeStyle = '#06110F';
    ctx.lineWidth = 3;

    // 重生动画：从 5 倍大小、完全透明开始，一边收缩一边淡入到正常大小。
    // 用 easeOutCubic 让收缩先快后慢，落定感更自然。
    if (spawning) {
      const p = clampNum(1 - t.spawnAnim / spawnAnimTime, 0, 1);
      const e = 1 - Math.pow(1 - p, 3);
      const s = SPAWN_ANIM_SCALE + (1 - SPAWN_ANIM_SCALE) * e;
      ctx.scale(s, s);
      // 描边宽度要除以缩放倍数，否则放大阶段描边会跟着变粗
      ctx.lineWidth = 3 / s;
      ctx.globalAlpha *= SPAWN_ANIM_ALPHA + (1 - SPAWN_ANIM_ALPHA) * e;
    }

    // 车身（最底层的方形履带车体）
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.roundRect(-15, -15, 30, 30, 6);
    ctx.fill();
    ctx.stroke();

    // 炮管（叠在车身之上，从中心向车头方向伸出；根部会被后画的炮塔圆盘盖住）
    ctx.fillStyle = '#06110F';
    ctx.fillRect(0, -4, 24, 8);

    // 三连发就绪：主炮管两侧各加一根短侧炮管，视觉上变成三管炮，
    // 直观对应"下一发会打出扇形三连发"，用完（tripleReady 变 false）侧炮管立刻消失。
    if (t.alive && t.tripleReady) {
      ctx.fillStyle = ITEM_COLORS.triple;
      ctx.fillRect(2, -11, 16, 5);
      ctx.fillRect(2, 6, 16, 5);
    } else if (t.alive && t.homingReady) {
      // 追踪弹就绪：炮口加一个紫色菱形标记，直观对应"下一发会拐弯追人"，
      // 和三连发互斥，用完（homingReady 变 false）标记立刻消失。
      ctx.save();
      ctx.translate(26, 0);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = ITEM_COLORS.homing;
      ctx.strokeStyle = '#06110F';
      ctx.lineWidth = 2;
      ctx.fillRect(-5, -5, 10, 10);
      ctx.strokeRect(-5, -5, 10, 10);
      ctx.restore();
    }

    // 炮塔圆盘（最上层，压住炮管根部，只露出伸出去的炮管）
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 受击闪白：命中后的一小段时间里在车身上叠一层白色，给出"挨打了"的即时反馈
    const flashStart = hitFlash[t.id];
    if (flashStart !== undefined) {
      const flashT = (now - flashStart) / HIT_FLASH_DURATION;
      if (flashT < 1) {
        ctx.globalAlpha *= 0.65 * (1 - flashT);
        ctx.fillStyle = '#F2FBF9';
        ctx.beginPath();
        ctx.roundRect(-15, -15, 30, 30, 6);
        ctx.fill();
      }
    }

    ctx.restore();

    if (t.alive && !spawning) {
      ctx.save();
      if (t.invisible && isSelf) ctx.globalAlpha *= SELF_INVISIBLE_ALPHA;

      // 护盾：一圈蓝色虚线光环，直观提示"还能再扛一发"
      if (t.shield) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(t.x, t.y, TANK_RADIUS + 7, 0, Math.PI * 2);
        ctx.strokeStyle = ITEM_COLORS.shield;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.restore();
      }

      // 出生无敌：白色细环 + 剩余时间进度弧。和道具护盾（蓝色虚线环）在颜色和
      // 线型上都不同，玩家一眼能分清"刚出生的 3 秒保护"和"捡到的护盾"。
      // spawnProtect 是剩余秒数，进度弧随剩余时间收短。
      if (t.spawnProtect > 0) {
        const remain = Math.min(SPAWN_PROTECT_TIME, Math.max(0, t.spawnProtect));
        const frac = remain / SPAWN_PROTECT_TIME;
        const ringR = TANK_RADIUS + 10;

        ctx.save();
        ctx.beginPath();
        ctx.arc(t.x, t.y, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(242, 251, 249, 0.25)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // 进度弧从 12 点方向顺时针展开，弧长 = 剩余时间比例
        ctx.beginPath();
        ctx.arc(t.x, t.y, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
        ctx.strokeStyle = '#F2FBF9';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.restore();
      }

      ctx.fillStyle = '#F2FBF9';
      ctx.font = '600 13px Inter, sans-serif';
      ctx.textAlign = 'center';
      // 血条紧贴车身上沿，名字再往上一点。坦克可以贴着地图边缘移动，
      // 上方空间不够时（名字会顶出 canvas）就把"血条+名字"整体挪到坦克下方，
      // 两者不会互相压住，也不会被裁掉。
      const belowLabel = t.y - 29 < LABEL_TOP_PAD;
      drawHpBar(t, belowLabel ? t.y + 20 : t.y - 22);

      const textWidth = ctx.measureText(t.name).width;
      const labelX = clampNum(t.x, textWidth / 2 + LABEL_PAD, canvas.width - textWidth / 2 - LABEL_PAD);
      const labelY = clampNum(belowLabel ? t.y + 40 : t.y - 29, LABEL_TOP_PAD, canvas.height - LABEL_PAD);
      ctx.fillText(t.name, labelX, labelY);
      ctx.restore();
    }
  }


  // ---------- 车旁弹药指示器（只有自己看得到） ----------
  // 服务端只把弹药私发给本人，其他坦克没有弹药数据，所以这里只画 myId 这一辆。
  // 位置默认贴在车身右侧；右边放不下就翻到左侧，再 clamp 进画布，避免贴边被裁。
  const AMMO_PIP_W = 4;
  const AMMO_PIP_H = 9;
  const AMMO_PIP_GAP = 2;
  const AMMO_BADGE_PAD_X = 6;
  const AMMO_BADGE_H = 25; // 上内边距 + 弹条高 + 进度条 + 下内边距

  function drawAmmoBadge() {
    const self = tanks.find((t) => t.id === myId);
    if (!self || !self.alive) return;
    if (self.spawnAnim > 0) return; // 重生动画期间还没有实体，角标等实体出现后再显示

    const max = Math.max(1, myAmmoMax);
    const ammo = clampNum(myAmmo, 0, max);
    const empty = ammo <= 0;
    const contentW = max * AMMO_PIP_W + (max - 1) * AMMO_PIP_GAP;
    const badgeW = contentW + AMMO_BADGE_PAD_X * 2;

    let bx = self.x + TANK_RADIUS + 12;
    if (bx + badgeW > canvas.width - LABEL_PAD) {
      bx = self.x - TANK_RADIUS - 12 - badgeW;
    }
    bx = clampNum(bx, LABEL_PAD, canvas.width - badgeW - LABEL_PAD);
    const by = clampNum(self.y - AMMO_BADGE_H / 2, LABEL_PAD, canvas.height - AMMO_BADGE_H - LABEL_PAD);

    ctx.save();
    if (self.invisible) ctx.globalAlpha *= SELF_INVISIBLE_ALPHA; // 自己隐身时角标跟着半透明

    // 空弹只保留静态红边提示，不做闪烁/脉冲动画
    ctx.fillStyle = 'rgba(6, 17, 15, 0.80)';
    ctx.beginPath();
    ctx.roundRect(bx, by, badgeW, AMMO_BADGE_H, 5);
    ctx.fill();
    ctx.strokeStyle = empty ? '#E63946' : 'rgba(242, 251, 249, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 弹条：实心 = 还能打，空心 = 已经打掉
    const pipY = by + 5;
    for (let i = 0; i < max; i++) {
      const px = bx + AMMO_BADGE_PAD_X + i * (AMMO_PIP_W + AMMO_PIP_GAP);
      ctx.fillStyle = i < ammo ? '#FFD60A' : 'rgba(242, 251, 249, 0.14)';
      ctx.beginPath();
      ctx.roundRect(px, pipY, AMMO_PIP_W, AMMO_PIP_H, 1.5);
      ctx.fill();
    }

    // 装填进度：只显示"当前这一发"的进度条，满弹时为空
    const barX = bx + AMMO_BADGE_PAD_X;
    const barW = badgeW - AMMO_BADGE_PAD_X * 2;
    const barY = by + 19;
    ctx.fillStyle = 'rgba(242, 251, 249, 0.14)';
    ctx.fillRect(barX, barY, barW, 2.5);
    if (ammo < max && myAmmoReload > 0) {
      ctx.fillStyle = '#FFD60A';
      ctx.fillRect(barX, barY, barW * clampNum(myAmmoReload, 0, 1), 2.5);
    }
    ctx.restore();
  }

  function drawBullet(b) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = b.homing ? ITEM_COLORS.homing : '#F2FBF9';
    ctx.strokeStyle = '#06110F';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }

  // ---------- 死亡爆炸特效 ----------
  const EXPLOSION_DURATION = 420; // ms，短促干脆，不拖沓
  const EXPLOSION_PARTICLES = 9;

  function spawnExplosion(x, y, color) {
    const particles = [];
    for (let i = 0; i < EXPLOSION_PARTICLES; i++) {
      // 均匀分布一圈角度，再加一点随机抖动，避免看起来太规整
      const angle = (Math.PI * 2 * i) / EXPLOSION_PARTICLES + (Math.random() - 0.5) * 0.5;
      const dist = 22 + Math.random() * 20; // 每个碎片最终飞出的距离(px)
      const size = 3 + Math.random() * 3;
      particles.push({ angle, dist, size });
    }
    explosions.push({ x, y, color, particles, start: performance.now() });
  }

  function drawExplosions(now) {
    explosions = explosions.filter((e) => now - e.start < EXPLOSION_DURATION);
    explosions.forEach((e) => {
      const t = (now - e.start) / EXPLOSION_DURATION; // 0..1
      const ease = 1 - Math.pow(1 - t, 2); // 先快后慢，冲击感更强
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t);

      // 飞散的坦克碎片，用坦克自身颜色 + 统一的深色描边，贴合整体扁平描边风格
      ctx.strokeStyle = '#06110F';
      ctx.lineWidth = 2;
      ctx.fillStyle = e.color;
      e.particles.forEach((p) => {
        const px = e.x + Math.cos(p.angle) * p.dist * ease;
        const py = e.y + Math.sin(p.angle) * p.dist * ease;
        const r = Math.max(0.1, p.size * (1 - t));
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });

      ctx.restore();
    });
  }

  // ---------- 护盾破碎小火花 ----------
  let shieldBreaks = [];
  const SHIELD_BREAK_DURATION = 300; // ms，比死亡爆炸更短促
  const SHIELD_BREAK_PARTICLES = 6;

  function spawnShieldBreak(x, y) {
    const particles = [];
    for (let i = 0; i < SHIELD_BREAK_PARTICLES; i++) {
      const angle = (Math.PI * 2 * i) / SHIELD_BREAK_PARTICLES + (Math.random() - 0.5) * 0.4;
      const dist = 14 + Math.random() * 10;
      particles.push({ angle, dist });
    }
    shieldBreaks.push({ x, y, particles, start: performance.now() });
  }

  function drawShieldBreaks(now) {
    shieldBreaks = shieldBreaks.filter((e) => now - e.start < SHIELD_BREAK_DURATION);
    shieldBreaks.forEach((e) => {
      const t = (now - e.start) / SHIELD_BREAK_DURATION;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = ITEM_COLORS.shield;
      e.particles.forEach((p) => {
        const px = e.x + Math.cos(p.angle) * p.dist * t;
        const py = e.y + Math.sin(p.angle) * p.dist * t;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.1, 2.5 * (1 - t)), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    });
  }

  // ---------- 出生保护格挡火花 ----------
  // 服务端在子弹被 3 秒出生保护吸收时广播 spawn_block（带命中点），
  // 这里画一圈快速扩散淡出的白色圆环，比只让子弹凭空消失更容易看懂。
  const SPAWN_BLOCK_DURATION = 300; // ms

  function drawSpawnBlocks(now) {
    spawnBlockFx = spawnBlockFx.filter((e) => now - e.start < SPAWN_BLOCK_DURATION);
    spawnBlockFx.forEach((e) => {
      const t = (now - e.start) / SPAWN_BLOCK_DURATION; // 0..1
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.beginPath();
      ctx.arc(e.x, e.y, 5 + 14 * t, 0, Math.PI * 2);
      ctx.strokeStyle = '#F2FBF9';
      ctx.lineWidth = 2.5 * (1 - t) + 0.5;
      ctx.stroke();
      ctx.restore();
    });
  }

  // ---------- 受击火花 / 掉血飘字 ----------
  // 服务端把真正掉血的命中点广播成 damage，这里画几颗短促的黄色火花并飘一个 -1；
  // 死亡爆炸仍然由 detectDeaths 负责，两者互不冲突。
  const HIT_FLASH_DURATION = 160; // ms，车身闪白
  const HIT_SPARK_DURATION = 260; // ms
  const HIT_SPARK_PARTICLES = 5;
  let hitSparks = []; // 受击火花：{x, y, particles, start}
  let floatTexts = []; // 飘字：{x, y, text, color, start}

  function spawnHitSpark(x, y) {
    const particles = [];
    for (let i = 0; i < HIT_SPARK_PARTICLES; i++) {
      const angle = (Math.PI * 2 * i) / HIT_SPARK_PARTICLES + (Math.random() - 0.5) * 0.6;
      const dist = 10 + Math.random() * 8;
      particles.push({ angle, dist });
    }
    hitSparks.push({ x, y, particles, start: performance.now() });
  }

  function drawHitSparks(now) {
    hitSparks = hitSparks.filter((e) => now - e.start < HIT_SPARK_DURATION);
    hitSparks.forEach((e) => {
      const t = (now - e.start) / HIT_SPARK_DURATION; // 0..1
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = '#FFD60A';
      e.particles.forEach((p) => {
        const px = e.x + Math.cos(p.angle) * p.dist * t;
        const py = e.y + Math.sin(p.angle) * p.dist * t;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.1, 2.5 * (1 - t)), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    });
  }

  const FLOAT_TEXT_DURATION = 700; // ms

  function spawnFloatText(x, y, text, color) {
    floatTexts.push({ x, y, text, color, start: performance.now() });
  }

  function drawFloatTexts(now) {
    floatTexts = floatTexts.filter((f) => now - f.start < FLOAT_TEXT_DURATION);
    floatTexts.forEach((f) => {
      const t = (now - f.start) / FLOAT_TEXT_DURATION; // 0..1
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = f.color;
      ctx.font = '800 14px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 一边上飘一边淡出
      ctx.fillText(f.text, f.x, f.y - 22 * t);
      ctx.restore();
    });
  }

  // ---------- 加速拖尾特效 ----------
  // 只要坦克处于加速状态且这一帧确实发生了位移，就在"车身移动前的位置"撒一颗
  // 会原地淡出的粒子，坦克跑过去后连续的粒子自然连成一条跟随移动方向的尾迹；
  // 静止不动（比如加速中被墙卡住）时不再产生新粒子，尾迹也就自然收尾变短。
  const TRAIL_DURATION = 380; // ms
  const TRAIL_MIN_MOVE = 0.6; // px，这一帧位移小于此值视为没有移动，不生成粒子

  function updateSpeedTrails(newTanks) {
    newTanks.forEach((t) => {
      const prev = prevPos[t.id];
      if (t.alive && t.speedBoost && prev) {
        const dx = t.x - prev.x;
        const dy = t.y - prev.y;
        const dist = Math.hypot(dx, dy);
        if (dist > TRAIL_MIN_MOVE) {
          // 粒子生成在坦克中心稍微往"来时方向"偏移一点的位置，让尾迹看起来是
          // 从车身后方甩出来的，而不是刚好叠在车身正中心
          const nx = dx / dist, ny = dy / dist;
          trails.push({
            x: t.x - nx * TANK_RADIUS * 0.5,
            y: t.y - ny * TANK_RADIUS * 0.5,
            start: performance.now(),
            ownerId: t.id,
            invisible: !!t.invisible,
          });
        }
      }
      prevPos[t.id] = { x: t.x, y: t.y };
    });
  }

  function drawTrails(now) {
    trails = trails.filter((p) => now - p.start < TRAIL_DURATION);
    trails.forEach((p) => {
      if (p.invisible && p.ownerId !== myId) return; // 别人隐身时，拖尾也要完全隐藏
      const t = (now - p.start) / TRAIL_DURATION; // 0..1
      ctx.save();
      let alpha = Math.max(0, 0.55 * (1 - t));
      if (p.invisible && p.ownerId === myId) alpha *= SELF_INVISIBLE_ALPHA; // 自己视角看自己的拖尾也是半透明
      ctx.globalAlpha = alpha;
      ctx.fillStyle = ITEM_COLORS.speed;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.1, 8 * (1 - t)), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  // ---------- 场上道具 ----------
  const ITEM_ICON_RADIUS = 13;

  function drawItems() {
    items.forEach((it) => {
      const color = ITEM_COLORS[it.type] || '#F2FBF9';
      ctx.save();
      ctx.translate(it.x, it.y);

      ctx.beginPath();
      ctx.arc(0, 0, ITEM_ICON_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.strokeStyle = '#06110F';
      ctx.lineWidth = 2.5;
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#06110F';
      ctx.font = '800 13px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ITEM_GLYPHS[it.type] || '?', 0, 1);
      ctx.restore();
    });
  }

  function draw() {
    const now = performance.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1B4B43';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawMaze();
    drawItems();
    drawTrails(now);
    tanks.forEach((t) => drawTank(t, now));
    bullets.forEach(drawBullet);
    drawAmmoBadge(); // 画在子弹之上，贴边时也不会被飞过的子弹盖住
    drawExplosions(now);
    drawShieldBreaks(now);
    drawSpawnBlocks(now);
    drawHitSparks(now);
    drawFloatTexts(now);
  }

  // ---------- 键盘输入 ----------
  const keyState = { forward: false, backward: false, left: false, right: false, shoot: false };
  let lastSent = null;

  const KEY_MAP = {
    ArrowUp: 'forward', KeyW: 'forward',
    ArrowDown: 'backward', KeyS: 'backward',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    Space: 'shoot',
  };

  function updateInput() {
    if (spectating) return; // 观战者没有坦克，绝不发送输入
    const snapshot = JSON.stringify(keyState);
    if (snapshot !== lastSent) {
      lastSent = snapshot;
      send({ type: 'input', keys: keyState });
    }
  }

  window.addEventListener('keydown', (e) => {
    const key = KEY_MAP[e.code];
    if (!key) return;
    if (views.game.classList.contains('hidden')) return;
    e.preventDefault(); // 观战时也拦住方向键/空格，避免页面滚动
    if (spectating) return;
    keyState[key] = true;
    updateInput();
  });
  window.addEventListener('keyup', (e) => {
    const key = KEY_MAP[e.code];
    if (!key) return;
    keyState[key] = false;
    updateInput();
  });
  window.addEventListener('blur', () => {
    for (const k in keyState) keyState[k] = false;
    updateInput();
  });

  // ---------- 移动端：虚拟摇杆 + 移动切换 + 开火按钮 ----------
  // 用 pointer:coarse 判断是否为触屏设备（比单纯看屏幕宽度更可靠，
  // 能避免把触屏笔记本/平板误判，也能兼容小尺寸横屏手机）。
  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

  // 自己阵亡、或者重生动画还没播完（坦克还没出现）时，收起摇杆/开火/移动切换：
  // 这两种状态下按了也没用，露出来只会误触。阵亡时同时清空本地输入，
  // 免得复活瞬间还带着死前按住的方向。
  //
  // 大乱斗的复活不经过 game_start，所以这里记下自己上一帧是否可操作：
  // 从"阵亡 / 凝聚动画"恢复为可操作时补一次移动切换的复位，
  // 保证复活后按钮总是回到默认的「移动」态，而不是沿用死前的选择。
  let selfWasControllable = true;
  function syncSelfState() {
    if (spectating) {
      // 观战者没有自己的坦克：收起控件、清空可能残留的按键。
      if (isTouchDevice) touchControls.classList.add('hidden');
      joystickVector = null;
      lastUseBackward = false;
      if (resetJoystickDrag) resetJoystickDrag();
      if (resetFireButton) resetFireButton();
      if (resetDpadPointers) resetDpadPointers();
      keyState.forward = false;
      keyState.backward = false;
      keyState.left = false;
      keyState.right = false;
      keyState.shoot = false;
      return;
    }
    const self = tanks.find((t) => t.id === myId);
    const alive = !!self && self.alive;
    // 实体真正出现（存活且重生动画播完）之前都算“还没上场”，控件保持隐藏
    const canAct = alive && !(self.spawnAnim > 0);
    // 重新上场（大乱斗复活 / 回合开局凝聚动画结束）时把移动切换复位为默认移动态
    if (canAct && !selfWasControllable) resetMoveToggleForRespawn();
    selfWasControllable = canAct;
    if (isTouchDevice) touchControls.classList.toggle('hidden', !canAct);
    if (!alive) {
      joystickVector = null;
      lastUseBackward = false;
      if (resetJoystickDrag) resetJoystickDrag(); // 手还按在摇杆上时也要松开，否则复活后摇杆不响应
      if (resetFireButton) resetFireButton(); // 开火键同理
      if (resetDpadPointers) resetDpadPointers(); // 十字键也松开，避免复活后方向键一直按着
      keyState.forward = false;
      keyState.backward = false;
      keyState.left = false;
      keyState.right = false;
      keyState.shoot = false;
      updateInput();
    }
  }

  // 新回合重生时，移动/静止切换恢复为默认的“移动”态，不沿用上一局死前的选择。
  function resetMoveToggleForRespawn() {
    isMoving = true;
    lastUseBackward = false;
    btnMoveToggle.classList.toggle('active', true);
    btnMoveToggle.textContent = '移动';
  }

  // 摇杆代表"希望坦克朝哪个方向走"，而不是直接的"前后/左右"按键：
  // 每次收到服务端的 state（带最新车身朝向 angle）都会重新计算一次。
  //
  // 是否移动由 btn-move-toggle 这颗切换按钮决定（点一下切一次状态），不再看摇杆推动幅度：
  //   isMoving = false（静止态）  只转向、不移动：把车头转向摇杆方向
  //   isMoving = true （移动态）  智能前进/后退：默认前进，只有摇杆方向和"车尾"朝向的夹角
  //                               在 45° 以内(BACKWARD_ENTER_ANGLE)才判定为倒退更合适，
  //                               改为倒退并把车尾转向目标；其余情况都前进、把车头转向目标。
  // 倒退状态一旦进入，要偏出到 135°(BACKWARD_EXIT_ANGLE)才会切回前进——进入和退出用
  // 两个不同阈值（滞回/hysteresis），避免拐弯时夹角在 45° 附近来回穿越导致前进/倒退
  // 每帧闪烁横跳（这种游戏躲子弹全靠身法，抖一下方向可能就是致命的）。
  // 左转/右转始终取夹角更小的那一边，对齐后（夹角进 TURN_DEADZONE 内）就只移动/不再转向修正
  // ——玩家只需要把摇杆推向想去的方向即可。
  //
  // 坐标系说明：摇杆的 dx/dy 是屏幕像素差值（右正、下正），
  // 服务端的 angle 用的正是同一套约定：angle=0 朝右(+x)，
  // input.right 使 angle 增大 == 顺时针（因为 y 轴向下），
  // 所以 Math.atan2(dy, dx) 算出来的目标角度可以直接和 tank.angle 比较，不需要转换。
  // 车尾朝向就是车头朝向 +π，绕车身中心转向时车头车尾同步转动，
  // 所以用"目标方向 - 车尾朝向"算出来的夹角符号，同样是正确的左转/右转依据。
  let joystickVector = null; // {x, y}，归一化到 -1..1；居中/松开时为 null
  let resetJoystickDrag = null; // 由 setupJoystick 赋值：阵亡时强制松开摇杆、释放指针捕获
  let resetFireButton = null; // 由 setupFireButton 赋值：阵亡时强制松开开火键、释放指针捕获
  let resetDpadPointers = null; // 由 setupDpad 赋值：阵亡/切换方式时强制松开所有十字键
  let isMoving = true;       // false=静止(只转向)，true=移动(前进/倒退)；由 btn-move-toggle 切换，默认移动态
  let lastUseBackward = false; // 上一帧是否处于倒退，用于滞回判断；松开摇杆/切静止/坦克未就绪时重置
  const JOY_DEADZONE = 0.25;    // 摇杆推动幅度小于此值时视为居中，不移动、不转向
  const TURN_DEADZONE = 0.12;   // 朝向与目标方向的夹角小于此值(约7°)时视为已对准，停止转向修正
  const BACKWARD_ENTER_ANGLE = Math.PI / 4;       // 45°，还没倒退时，要收紧到此角度内才开始倒退
  const BACKWARD_EXIT_ANGLE = Math.PI * 3 / 4;    // 135°，已经在倒退时，要偏出此角度才切回前进

  function normalizeAngle(a) {
    // 归一化到 (-π, π]
    return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  }

  function applyJoystickSteering() {
    if (!isTouchDevice) return;
    if (controlMode !== 'joystick') return; // 十字键模式下由按键直接控制，不做摇杆的智能转向
    if (!joystickVector) return; // 松开摇杆的情况在 endDrag 里已经单独清过 keyState，这里不用重复处理

    const mag = Math.hypot(joystickVector.x, joystickVector.y);
    if (mag < JOY_DEADZONE) {
      keyState.forward = false;
      keyState.backward = false;
      keyState.left = false;
      keyState.right = false;
      lastUseBackward = false; // 摇杆回中，倒退状态不该带到下一次推杆里
      updateInput();
      return;
    }

    const myTank = tanks.find((t) => t.id === myId);
    if (!myTank || !myTank.alive) {
      // 还没收到过 state，或者自己已经阵亡：先不移动，等下一帧 state 到来再决定
      keyState.forward = false;
      keyState.backward = false;
      keyState.left = false;
      keyState.right = false;
      lastUseBackward = false;
      updateInput();
      return;
    }

    const targetAngle = Math.atan2(joystickVector.y, joystickVector.x);

    if (!isMoving) {
      // 静止态：只把车头转向目标方向，不前进也不后退
      const diff = normalizeAngle(targetAngle - myTank.angle);
      keyState.forward = false;
      keyState.backward = false;
      keyState.left = diff < -TURN_DEADZONE;
      keyState.right = diff > TURN_DEADZONE;
      lastUseBackward = false; // 静止态没有前进/倒退可言，重置滞回状态，避免带入下次移动
      updateInput();
      return;
    }

    const diffFront = normalizeAngle(targetAngle - myTank.angle);
    const diffBack = normalizeAngle(targetAngle - normalizeAngle(myTank.angle + Math.PI));

    // 滞回判断：还没倒退时用 BACKWARD_ENTER_ANGLE(45°)收紧触发条件，
    // 已经在倒退时改用宽得多的 BACKWARD_EXIT_ANGLE(135°)才允许切回前进——
    // 拐弯时夹角在 45° 附近小幅摆动不会再导致来回横跳，必须明显甩出去
    // （偏到接近车头方向）才会真正判定为"该前进了"。
    const useBackward = lastUseBackward
      ? Math.abs(diffBack) <= BACKWARD_EXIT_ANGLE
      : Math.abs(diffBack) <= BACKWARD_ENTER_ANGLE;
    lastUseBackward = useBackward;
    const diff = useBackward ? diffBack : diffFront;

    keyState.forward = !useBackward;
    keyState.backward = useBackward;
    keyState.left = diff < -TURN_DEADZONE;  // 目标在当前参照朝向的逆时针一侧 -> 左转
    keyState.right = diff > TURN_DEADZONE;  // 目标在当前参照朝向的顺时针一侧 -> 右转
    updateInput();
  }

  function setupMoveToggle() {
    // 按钮初始视觉状态要跟 isMoving 的默认值（移动态）对齐，不然会显示"静止"但实际在走
    btnMoveToggle.classList.toggle('active', isMoving);
    btnMoveToggle.textContent = isMoving ? '移动' : '静止';

    // 用 pointerdown 而不是 click：手指按下的瞬间就切换状态，且和摇杆各自独立
    // （摇杆用另一根手指的 pointerId 做 setPointerCapture，互不干扰），
    // 这样才能保证"一根手指按住摇杆拖动的同时，另一根手指点这个按钮"能立刻生效——
    // click 是浏览器在 touchstart/touchend 之后合成的事件，在多点触控同时进行时
    // 不一定会按预期触发，pointerdown 则是每根手指落下就立即派发，更可靠。
    btnMoveToggle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      isMoving = !isMoving;
      btnMoveToggle.classList.toggle('active', isMoving);
      btnMoveToggle.textContent = isMoving ? '移动' : '静止';
      applyJoystickSteering(); // 立即按新状态重新计算一次，不用等下一帧 state
    });
  }

  function setupJoystick() {
    let pointerId = null;
    let centerX = 0, centerY = 0, maxRadius = 1;

    function beginDrag(e) {
      if (pointerId !== null) return; // 已经有手指在控制摇杆，忽略新的触点
      pointerId = e.pointerId;
      const rect = joystickZone.getBoundingClientRect();
      centerX = rect.left + rect.width / 2;
      centerY = rect.top + rect.height / 2;
      maxRadius = rect.width / 2;
      joystickZone.classList.add('active');
      joystickZone.setPointerCapture(pointerId);
      updateFromPoint(e.clientX, e.clientY);
    }

    function updateFromPoint(clientX, clientY) {
      let dx = clientX - centerX;
      let dy = clientY - centerY;
      const dist = Math.hypot(dx, dy);
      if (dist > maxRadius) {
        dx = (dx / dist) * maxRadius;
        dy = (dy / dist) * maxRadius;
      }
      joystickStick.style.transform = `translate(${dx}px, ${dy}px)`;

      joystickVector = { x: dx / maxRadius, y: dy / maxRadius }; // -1..1，右/下为正
      applyJoystickSteering();
    }

    function endDrag(e) {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      joystickZone.classList.remove('active');
      joystickStick.style.transform = 'translate(0, 0)';
      joystickVector = null;
      keyState.forward = false;
      keyState.backward = false;
      keyState.left = false;
      keyState.right = false;
      lastUseBackward = false; // 松开摇杆，滞回状态清零，下次推杆重新从"进入阈值"判断起步
      updateInput();
    }

    joystickZone.addEventListener('pointerdown', (e) => { e.preventDefault(); beginDrag(e); });
    joystickZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;
      e.preventDefault();
      updateFromPoint(e.clientX, e.clientY);
    });
    joystickZone.addEventListener('pointerup', endDrag);
    joystickZone.addEventListener('pointercancel', endDrag);

    // 阵亡时控件会被隐藏，手指如果还按在摇杆上，pointerup 可能永远到不了 endDrag；
    // 这里主动释放指针捕获并清空拖动状态，避免复活后摇杆因为 pointerId 一直占着而不响应。
    resetJoystickDrag = function () {
      if (pointerId !== null) {
        try {
          joystickZone.releasePointerCapture(pointerId);
        } catch (e) {
          // 指针已经不在捕获状态，忽略即可
        }
      }
      pointerId = null;
      joystickZone.classList.remove('active');
      joystickStick.style.transform = 'translate(0, 0)';
    };
  }

  function setupFireButton() {
    let pointerId = null;

    function start(e) {
      e.preventDefault();
      if (pointerId !== null) return;
      pointerId = e.pointerId;
      btnFire.setPointerCapture(pointerId);
      btnFire.classList.add('active');
      keyState.shoot = true;
      updateInput();
    }
    function stop(e) {
      if (pointerId !== null && e.pointerId !== pointerId) return;
      pointerId = null;
      btnFire.classList.remove('active');
      keyState.shoot = false;
      updateInput();
    }

    btnFire.addEventListener('pointerdown', start);
    btnFire.addEventListener('pointerup', stop);
    btnFire.addEventListener('pointercancel', stop);
    btnFire.addEventListener('pointerleave', stop);

    // 和摇杆同理：阵亡时按钮被隐藏，按住的指针可能收不到 pointerup，
    // 主动释放捕获，避免复活后开火键因为 pointerId 一直占着而不响应。
    resetFireButton = function () {
      if (pointerId !== null) {
        try {
          btnFire.releasePointerCapture(pointerId);
        } catch (e) {
          // 指针已经不在捕获状态，忽略即可
        }
      }
      pointerId = null;
      btnFire.classList.remove('active');
    };
  }

  // ---------- 十字键（触屏虚拟按键的另一种控制方式） ----------
  function setupDpad() {
    const keys = Array.from(document.querySelectorAll('.dpad-key'));
    const pointers = new Map(); // pointerId -> { btn, dir }，支持多指同时按住不同方向
    const dirCounts = { forward: 0, backward: 0, left: 0, right: 0 };

    function press(e) {
      const btn = e.currentTarget;
      const dir = btn.dataset.dir;
      if (!dir || pointers.has(e.pointerId)) return;
      e.preventDefault();
      pointers.set(e.pointerId, { btn, dir });
      dirCounts[dir] += 1;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (err) {
        // 个别浏览器不支持指针捕获时忽略，pointerup 仍然能正常结束
      }
      btn.classList.add('active');
      keyState[dir] = true;
      updateInput();
    }

    function release(e) {
      const rec = pointers.get(e.pointerId);
      if (!rec) return;
      pointers.delete(e.pointerId);
      dirCounts[rec.dir] = Math.max(0, dirCounts[rec.dir] - 1);
      if (dirCounts[rec.dir] === 0) {
        rec.btn.classList.remove('active');
        keyState[rec.dir] = false;
        updateInput();
      }
    }

    keys.forEach((btn) => {
      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      // 指针捕获被系统收走（来电、切后台等）时也要松开，避免按键卡住
      btn.addEventListener('lostpointercapture', release);
    });

    // 阵亡 / 观战 / 切换控制方式时统一松开：控件隐藏后 pointerup 可能收不到
    resetDpadPointers = function () {
      let changed = false;
      pointers.forEach((rec, id) => {
        try {
          rec.btn.releasePointerCapture(id);
        } catch (e) {
          // 指针已经不在捕获状态，忽略即可
        }
        if (keyState[rec.dir]) changed = true;
        keyState[rec.dir] = false;
      });
      pointers.clear();
      for (const dir in dirCounts) dirCounts[dir] = 0;
      keys.forEach((btn) => btn.classList.remove('active'));
      if (changed) updateInput();
    };
  }

  // ---------- 设置页：控制方式切换 ----------
  function applyControlMode(next, persist) {
    controlMode = next === 'dpad' ? 'dpad' : 'joystick';
    document.body.classList.toggle('control-dpad', controlMode === 'dpad');
    document.body.classList.toggle('control-joystick', controlMode === 'joystick');
    controlPicker.querySelectorAll('.control-option').forEach((btn) => {
      const on = btn.dataset.control === controlMode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    controlDescEl.textContent = CONTROL_MODE_INFO[controlMode];

    // 切换时清空两种虚拟控件的残留输入，避免切过去以后还带着旧按键
    if (resetDpadPointers) resetDpadPointers();
    if (resetJoystickDrag) resetJoystickDrag();
    joystickVector = null;
    lastUseBackward = false;
    keyState.forward = false;
    keyState.backward = false;
    keyState.left = false;
    keyState.right = false;
    updateInput();

    if (persist) {
      try {
        localStorage.setItem(CONTROL_MODE_KEY, controlMode);
      } catch (e) {
        // 隐私模式下存储失败也不影响本次使用
      }
    }
  }

  btnOpenSettings.addEventListener('click', () => {
    landingErrorShow('');
    showView('settings');
  });
  btnSettingsBack.addEventListener('click', () => showView('landing'));
  controlPicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.control-option');
    if (!btn) return;
    applyControlMode(btn.dataset.control, true);
  });

  // 读取上次保存的控制方式（默认摇杆），再初始化触屏控件。
  // 这些调用必须放在 joystickVector / resetJoystickDrag / resetDpadPointers 等
  // let 声明之后，否则会因 TDZ 抛错。
  try {
    const savedControlMode = localStorage.getItem(CONTROL_MODE_KEY);
    if (savedControlMode === 'dpad' || savedControlMode === 'joystick') controlMode = savedControlMode;
  } catch (e) {
    // localStorage 不可用时保持默认
  }
  applyControlMode(controlMode, false);

  if (isTouchDevice) {
    document.body.classList.add('is-touch');
    setupJoystick();
    setupMoveToggle();
    setupFireButton();
    setupDpad();
  }
})();