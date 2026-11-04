(() => {
  'use strict';

  // ---------- 视图切换 ----------
  const views = {
    landing: document.getElementById('view-landing'),
    lobby: document.getElementById('view-lobby'),
    game: document.getElementById('view-game'),
  };
  function showView(name) {
    for (const k in views) views[k].classList.toggle('hidden', k !== name);
  }

  // ---------- DOM 元素 ----------
  const createNameEl = document.getElementById('create-name');
  const joinNameEl = document.getElementById('join-name');
  const joinCodeEl = document.getElementById('join-code');
  const btnCreate = document.getElementById('btn-create');
  const btnJoin = document.getElementById('btn-join');
  const landingError = document.getElementById('landing-error');

  const lobbyCodeEl = document.getElementById('lobby-code');
  const lobbyPlayersEl = document.getElementById('lobby-players');
  const btnStart = document.getElementById('btn-start');
  const btnLeaveLobby = document.getElementById('btn-leave-lobby');

  const hudScores = document.getElementById('hud-scores');
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const overlayRound = document.getElementById('overlay-round');
  const overlayTitle = document.getElementById('overlay-title');
  const overlaySub = document.getElementById('overlay-sub');

  const joystickZone = document.getElementById('joystick-zone');
  const joystickStick = document.getElementById('joystick-stick');
  const btnMoveToggle = document.getElementById('btn-move-toggle');
  const btnFire = document.getElementById('btn-fire');

  // ---------- 状态 ----------
  let ws = null;
  let myId = null;
  let hostId = null;
  let roomCode = null;
  let players = [];
  let maze = null;
  let worldW = 960, worldH = 640;
  let tanks = [];
  let bullets = [];
  let items = []; // 场上道具：{id, type, x, y}
  let explosions = []; // 死亡爆炸特效：{x, y, color, startTime}
  let trails = []; // 加速拖尾粒子：{x, y, start}
  let prevPos = {}; // id -> 上一帧坐标 {x, y}，用来算加速拖尾的运动方向
  let prevShield = {}; // id -> 上一帧是否有护盾，用来检测"护盾刚被打破"这一瞬间
  const ITEM_COLORS = { shield: '#3A86FF', speed: '#FFD60A', triple: '#E63946', homing: '#B565D8', invisible: '#8FBDB6' };
  const SELF_INVISIBLE_ALPHA = 0.35; // 自己隐身时，自己视角看到的半透明程度
  const TANK_RADIUS = 15; // 仅用于绘制光环/角标的偏移，需与服务端坦克半径保持一致
  let prevAlive = {};  // id -> 上一帧是否存活，用来检测"刚刚死亡"这一瞬间

  // 名字标签贴边时用来把绘制坐标钳制在 canvas 内的内边距
  const LABEL_PAD = 4;
  const LABEL_TOP_PAD = 14; // 需要能容下 13px 字体的整行高度，不然顶部还是会被裁一点
  function clampNum(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', () => {
      if (!views.landing.classList.contains('hidden')) return;
      landingErrorShow('与服务器断开连接，请刷新页面重试');
    });
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
  }

  function landingErrorShow(msg) { landingError.textContent = msg; }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ---------- 创建 / 加入 ----------
  btnCreate.addEventListener('click', async () => {
    landingErrorShow('');
    try {
      if (!ws) await connect();
      send({ type: 'create_room', name: createNameEl.value });
    } catch (e) {
      landingErrorShow('无法连接服务器');
    }
  });

  btnJoin.addEventListener('click', async () => {
    landingErrorShow('');
    const code = joinCodeEl.value.trim().toUpperCase();
    if (code.length !== 4) {
      landingErrorShow('请输入 4 位房间码');
      return;
    }
    try {
      if (!ws) await connect();
      send({ type: 'join_room', name: joinNameEl.value, code });
    } catch (e) {
      landingErrorShow('无法连接服务器');
    }
  });

  btnStart.addEventListener('click', () => send({ type: 'start_game' }));
  btnLeaveLobby.addEventListener('click', () => {
    send({ type: 'leave_room' });
    location.reload();
  });

  // ---------- 消息处理 ----------
  function onMessage(evt) {
    const msg = JSON.parse(evt.data);
    switch (msg.type) {
      case 'joined':
        myId = msg.playerId;
        hostId = msg.hostId;
        roomCode = msg.code;
        players = msg.players;
        lobbyCodeEl.textContent = roomCode;
        renderLobby();
        showView('lobby');
        break;

      case 'error':
        landingErrorShow(msg.message);
        break;

      case 'room_update':
        hostId = msg.hostId;
        players = msg.players;
        renderLobby();
        break;

      case 'game_start':
        maze = msg.maze;
        worldW = msg.worldW;
        worldH = msg.worldH;
        players = msg.players;
        explosions = [];
        trails = [];
        items = [];
        prevAlive = {};
        prevShield = {};
        prevPos = {};
        overlayRound.classList.add('hidden');
        renderHud();
        showView('game');
        break;

      case 'state':
        detectDeaths(msg.tanks);
        updateSpeedTrails(msg.tanks);
        tanks = msg.tanks;
        bullets = msg.bullets;
        items = msg.items || [];
        applyJoystickSteering(); // 用刚收到的最新朝向重新计算该转左还是转右
        renderHudFromTanks();
        draw();
        break;

      case 'round_end':
        players = msg.scores;
        renderHud();
        overlayTitle.textContent = msg.winnerId
          ? `${nameOf(msg.winnerId)} 获胜本回合！`
          : '平局！';
        overlaySub.textContent = '下一回合即将开始…';
        overlayRound.classList.remove('hidden');
        break;

      case 'match_end':
        players = msg.scores;
        renderHud();
        if (msg.reason === 'not_enough_players') {
          overlayTitle.textContent = '对手已离开';
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

  // 对比本帧与上一帧的存活状态，一旦发现"从活着变成死亡"就在坦克当前位置生成一次爆炸特效；
  // 同时对比护盾状态，一旦发现"护盾刚被打破"（人还活着）就生成一次小一号的蓝色火花特效
  function detectDeaths(newTanks) {
    newTanks.forEach((t) => {
      if (prevAlive[t.id] && !t.alive) {
        spawnExplosion(t.x, t.y, t.color);
      } else if (t.alive && prevShield[t.id] && !t.shield) {
        spawnShieldBreak(t.x, t.y);
      }
      prevAlive[t.id] = t.alive;
      prevShield[t.id] = t.shield;
    });
  }

  // ---------- 大厅渲染 ----------
  function renderLobby() {
    lobbyPlayersEl.innerHTML = '';
    players.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'player-row';
      const dot = document.createElement('span');
      dot.className = 'player-dot';
      dot.style.background = p.color;
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
      lobbyPlayersEl.appendChild(row);
    });

    const amHost = myId === hostId;
    if (amHost) {
      btnStart.disabled = players.length < 2;
      btnStart.textContent = players.length < 2 ? '等待玩家加入…' : `开始游戏（${players.length}人）`;
    } else {
      btnStart.disabled = true;
      btnStart.textContent = '等待房主开始…';
    }
  }

  // ---------- HUD ----------
  function renderHud() {
    hudScores.innerHTML = '';
    players.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'hud-item';
      item.id = 'hud-' + p.id;
      const dot = document.createElement('span');
      dot.className = 'hud-dot';
      dot.style.background = p.color;
      const label = document.createElement('span');
      label.textContent = `${p.name} · ${p.score}`;
      item.appendChild(dot);
      item.appendChild(label);
      hudScores.appendChild(item);
    });
  }
  function renderHudFromTanks() {
    tanks.forEach((t) => {
      const el = document.getElementById('hud-' + t.id);
      if (el) el.classList.toggle('dead', !t.alive);
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

  function drawTank(t) {
    const isSelf = t.id === myId;
    // 别人视角：隐身的坦克完全不画（车身、炮管、护盾光环、名字全部跳过）
    if (t.invisible && !isSelf) return;

    ctx.save();
    ctx.translate(t.x, t.y);
    if (!t.alive) ctx.globalAlpha = 0.25;
    // 自己视角：自己隐身时整体变半透明，直观提示"我现在是隐身状态"
    if (t.invisible && isSelf) ctx.globalAlpha *= SELF_INVISIBLE_ALPHA;
    ctx.rotate(t.angle);

    ctx.strokeStyle = '#06110F';
    ctx.lineWidth = 3;

    // 车身（最底层的方形履带车体）
    ctx.fillStyle = t.color;
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
    ctx.fillStyle = t.color;
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.restore();

    if (t.alive) {
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

      ctx.fillStyle = '#F2FBF9';
      ctx.font = '600 13px Inter, sans-serif';
      ctx.textAlign = 'center';
      // 名字默认画在坦克正上方(t.y - 26)，但坦克可以贴着地图边缘移动
      // (服务端允许坦克中心到 TANK_RADIUS=16)，这时 26px 的偏移会把文字
      // 顶到 canvas 可见区域外面，被裁掉、看起来像"消失在地图外的背景里"。
      // 这里把绘制坐标钳制在 canvas 范围内(留一点内边距)，保证名字始终完整可见。
      const textWidth = ctx.measureText(t.name).width;
      const labelX = clampNum(t.x, textWidth / 2 + LABEL_PAD, canvas.width - textWidth / 2 - LABEL_PAD);
      const labelY = clampNum(t.y - 26, LABEL_TOP_PAD, canvas.height - LABEL_PAD);
      ctx.fillText(t.name, labelX, labelY);
      ctx.restore();
    }
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
      const glyph = it.type === 'shield' ? '盾' : it.type === 'speed' ? '速' : it.type === 'triple' ? '三' : it.type === 'homing' ? '追' : '隐';
      ctx.fillText(glyph, 0, 1);
      ctx.restore();
    });
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1B4B43';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawMaze();
    drawItems();
    drawTrails(performance.now());
    tanks.forEach(drawTank);
    bullets.forEach(drawBullet);
    drawExplosions(performance.now());
    drawShieldBreaks(performance.now());
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
    e.preventDefault();
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
    if (!myTank) {
      // 游戏刚开始、还没收到过 state，先不移动，只等下一帧 state 到来再决定
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
  }

  // 必须放在 setupJoystick / setupMoveToggle / setupFireButton 以及它们依赖的
  // let/const（isMoving、joystickVector、JOY_DEADZONE 等）声明之后再调用：
  // 这几个 setup 函数里有的会在调用时立刻读取这些变量，如果它们的声明语句还没
  // 执行到（哪怕函数本身已经被提升），会因为 TDZ 直接抛错，导致后面的代码全部
  // 不执行，包括 draw()，表现为地图怎么都画不出来。
  if (isTouchDevice) {
    document.body.classList.add('is-touch');
    setupJoystick();
    setupMoveToggle();
    setupFireButton();
  }
})();