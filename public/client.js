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
  const mapPickerEl = document.getElementById('map-picker');
  const hpInputEl = document.getElementById('hp-input');
  const btnHpMinus = document.getElementById('btn-hp-minus');
  const btnHpPlus = document.getElementById('btn-hp-plus');
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
  let mapSize = 'medium'; // 房间级设置，以服务端广播为准；只有房主能改
  let maxHp = 3; // 房间级设置：每回合初始血量，以服务端广播为准；只有房主能改
  const MIN_HP = 1;
  const MAX_HP = 20;
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
  const SELF_INVISIBLE_ALPHA = 0.35; // 自己隐身时，自己视角看到的半透明程度
  const TANK_RADIUS = 15; // 仅用于绘制光环/角标的偏移，需与服务端坦克半径保持一致
  const SPAWN_PROTECT_TIME = 3; // 与服务端 SPAWN_PROTECT_TIME 一致，用于把剩余秒数换算成进度弧比例
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
        mapSize = msg.mapSize || 'medium';
        maxHp = msg.maxHp || 3;
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
        mapSize = msg.mapSize || mapSize;
        maxHp = msg.maxHp || maxHp;
        renderLobby();
        break;

      case 'game_start':
        maze = msg.maze;
        worldW = msg.worldW;
        worldH = msg.worldH;
        maxHp = msg.maxHp || maxHp;
        // 画布按世界尺寸调整（CSS 负责等比缩放到容器），这样不同档位的地图
        // 都能用同一套世界坐标绘制，不需要额外换算缩放比。
        canvas.width = worldW;
        canvas.height = worldH;
        players = msg.players;
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
        renderHud();
        showView('game');
        break;

      case 'ammo':
        // 服务端每 tick 只私发本人的弹药，不触发重绘——
        // 紧接着到达的 state 消息会统一 draw()，那时用的就是这里刚更新的值。
        myAmmo = msg.ammo;
        myAmmoMax = msg.max || AMMO_MAX;
        myAmmoReload = msg.reload || 0;
        break;

      case 'state':
        detectDeaths(msg.tanks);
        updateSpeedTrails(msg.tanks);
        tanks = msg.tanks;
        msg.tanks.forEach((t) => { lastHp[t.id] = t.hp; });
        bullets = msg.bullets;
        items = msg.items || [];
        applyJoystickSteering(); // 用刚收到的最新朝向重新计算该转左还是转右
        renderHudFromTanks();
        draw();
        break;

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
        players = msg.scores;
        renderHud();
        // renderHud 会重建 HUD，死状态（删除线/红心）会丢；用最后一帧坦克状态补回来，
        // 让结算展示期间阵亡玩家继续显示红色 + 删除线。
        renderHudFromTanks();
        overlayTitle.textContent = msg.winnerId
          ? `${nameOf(msg.winnerId)} 获胜本回合！`
          : '平局！';
        overlaySub.textContent = '下一回合即将开始…';
        overlayRound.classList.remove('hidden');
        break;

      case 'match_end':
        players = msg.scores;
        renderHud();
        renderHudFromTanks();
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

    renderMapPicker();
    renderHpSetting();
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

  // ---------- 初始血量设置 ----------
  // 大厅右侧的初始血量：房主可直接输入 1–20 的整数，也可以用两侧的 −/+ 微调；
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
      hudScores.appendChild(item);
    });
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

  // 分段血条：格数 = 房间设置的初始血量（1–20），掉一格就是少 1 点。
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

  function drawAmmoBadge(now) {
    const self = tanks.find((t) => t.id === myId);
    if (!self || !self.alive) return;

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
    // 空弹时整体红色脉冲：比静态红色更醒目，又不至于像死亡特效那样吵闹
    if (empty) ctx.globalAlpha *= 0.55 + 0.45 * Math.abs(Math.sin(now / 220));

    ctx.fillStyle = 'rgba(6, 17, 15, 0.88)';
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
    drawAmmoBadge(now); // 画在子弹之上，贴边时也不会被飞过的子弹盖住
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