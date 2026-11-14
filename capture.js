'use strict';

/**
 * 占点模式：据点生成 + 占领进度状态机。
 *
 * 设计要点（与需求确认一致）：
 *   - 场上只有一个据点，占领一次得 1 分，先占 N 次者获胜；
 *   - 据点被占领后立刻随机换到新位置（由 Room 负责换点）；
 *   - 据点位置完全随机：不再对齐格心、不刻意避开存活玩家，
 *     只保留一个半径的边距，保证整个圆留在世界范围内；
 *   - 圆圈允许跨墙，圆心甚至可能落在墙体附近；是否在圈内按坦克中心判定；
 *   - 单人站在圈内开始涨进度；只有"圈内 >=2 个存活实体，并且原 owner 本人也在圈内"
 *     时进度才冻结。原 owner 阵亡/离开后，哪怕圈里挤了两个人也不能替他守进度，
 *     旧进度会继续按 5 秒衰减；
 *   - 圈内没人时旧进度按 10 秒衰减。
 *
 * 团队对抗使用下面的 stepTeamCapture：进度归属改为队伍，同队多人共享一份进度，
 * 只有敌我两队同时在圈内才冻结；单人模式继续走 stepCapture，行为完全不变。
 *
 * 进度状态（point.status）：
 *   idle        圈内没人且进度为 0
 *   capturing   圈内只有一个玩家，正在涨进度
 *   contested   圈内 >=2 人且原 owner 在圈内（或还没有 owner），进度冻结/保持 0
 *   neutralizing 圈内有人，但原 owner 不在圈内，旧进度按 5 秒清退
 *   decaying    圈内没人，旧进度按 10 秒衰减
 */

// 据点半径（世界坐标 px）。直径 160px，比坦克直径 30px 大不少。
const CAPTURE_RADIUS = 80;
// 单人从 0 占满 100% 所需秒数。
const CAPTURE_TIME = 10;
// 圈内没人时，旧进度从 100% 衰减到 0 所需秒数。
const DECAY_EMPTY_TIME = 10;
// 圈内有人、但原 owner 不在圈内时，清掉旧进度所需秒数（比无人衰减更快）。
const DECAY_NEUTRALIZE_TIME = 5;

/** 坦克中心是否在据点圆内。 */
function isInside(point, x, y) {
  const dx = x - point.x;
  const dy = y - point.y;
  return dx * dx + dy * dy <= point.radius * point.radius;
}

/**
 * 完全随机地生成一个据点圆心。
 *
 * 只保留一个半径的边距，保证整个圆都在地图内；不再限制在格心，
 * 也不再避开存活玩家或挑选"离所有人最远"的位置——刷在谁脚下就是谁脚下。
 * 圆心可能落在墙边/墙体内（圆圈本来就允许跨墙）。
 */
function pickCaptureSpot({ cols, rows, cell, radius = CAPTURE_RADIUS, rand = Math.random }) {
  const worldW = cols * cell;
  const worldH = rows * cell;
  const minX = radius;
  const maxX = Math.max(radius, worldW - radius);
  const minY = radius;
  const maxY = Math.max(radius, worldH - radius);
  return {
    x: minX + rand() * Math.max(0, maxX - minX),
    y: minY + rand() * Math.max(0, maxY - minY),
  };
}

/** 生成一个进度为 0 的据点；id 由 Room 统一分配。 */
function createCapturePoint(opts = {}) {
  const radius = Number.isFinite(opts.radius) ? opts.radius : CAPTURE_RADIUS;
  const spot = pickCaptureSpot({ ...opts, radius });
  return {
    id: 0,
    x: spot.x,
    y: spot.y,
    radius,
    progress: 0,
    ownerId: null,
    // 团队对抗下据点按队伍归属；普通占点模式恒为 null。
    ownerTeam: null,
    ownerColor: null,
    status: 'idle',
  };
}

/**
 * 推进一帧占领进度。
 *
 * @param {object} point 据点对象（原地修改）
 * @param {Array<{id:string,color:string}>} occupants 圈内的存活实体（调用方已过滤阵亡/凝聚/观战）
 * @param {number} dt 秒
 * @returns {boolean} 这一帧是否刚好占满 100%
 */
function stepCapture(point, occupants, dt) {
  if (!point || !(dt > 0)) return false;

  // 原 owner 本人是否还在圈内。owner 可能已经阵亡/离开，ownerId 和进度仍保留着，
  // 所以这里必须按"活着的圈内实体里有没有 owner"来判断。
  const ownerInside = point.ownerId
    ? occupants.some((p) => p.id === point.ownerId)
    : false;

  // 冻结条件 = 圈内 >=2 人 且 原 owner 在圈内。
  // 原 owner 已经阵亡/离开时，其他人再多也不能替他把进度冻住，
  // 否则就会出现"两个人站在圈里帮一个已经不在场的人守进度"。
  if (point.ownerId && ownerInside && occupants.length >= 2) {
    point.status = 'contested';
    return false;
  }

  // 没人：旧进度按 10 秒 / 100% 的速度回退到 0。
  if (occupants.length === 0) {
    if (point.progress > 0) {
      point.progress = Math.max(0, point.progress - dt / DECAY_EMPTY_TIME);
      if (point.progress <= 1e-9) {
        point.progress = 0;
        point.ownerId = null;
        point.ownerColor = null;
        point.status = 'idle';
      } else {
        point.status = 'decaying';
      }
    } else {
      point.progress = 0;
      point.ownerId = null;
      point.ownerColor = null;
      point.status = 'idle';
    }
    return false;
  }

  // 原 owner 不在圈内，但圈内有人（1 人或多人）：
  // 旧进度按 5 秒 / 100% 清退，谁都别想替不在场的人保住它。
  if (point.ownerId && !ownerInside && point.progress > 0) {
    point.progress = Math.max(0, point.progress - dt / DECAY_NEUTRALIZE_TIME);
    point.status = 'neutralizing';
    if (point.progress <= 1e-9) {
      point.progress = 0;
      point.ownerId = null;
      point.ownerColor = null;
      // 清完的同一帧如果圈里还有 >=2 人，直接进入"互相牵制"状态，
      // 避免客户端闪一帧"无人占领"的亮青色圈。
      if (occupants.length >= 2) point.status = 'contested';
    }
    return false;
  }

  // 走到这里还 >=2 人，说明：
  //   - 还没有 owner（进度本来就是 0），或
  //   - 旧 owner 的进度已经清零、owner 也已清掉。
  // 多人站在一个未占领的圈里互相牵制，进度保持 0，谁也不能开始占。
  if (occupants.length >= 2) {
    // 这里的 owner 要么为空，要么已经不在圈内（在圈内的情况上面已经冻结返回）。
    // 旧 owner 进度已经是 0，清掉残留的 owner 颜色，避免它继续给客户端染色。
    if (point.ownerId && !ownerInside) {
      point.ownerId = null;
      point.ownerColor = null;
    }
    point.status = 'contested';
    return false;
  }

  // 此时圈内只剩 1 人：
  //   - owner 在圈内：继续/开始涨进度；
  //   - owner 不在圈内但进度已清零：清掉残留 owner，由这个新玩家开始涨。
  const p = occupants[0];
  if (point.ownerId && point.ownerId !== p.id) {
    point.ownerId = null;
    point.ownerColor = null;
  }
  point.ownerId = p.id;
  point.ownerColor = p.color;
  point.status = 'capturing';
  point.progress = Math.min(1, point.progress + dt / CAPTURE_TIME);
  if (point.progress >= 1 - 1e-9) {
    point.progress = 1;
    return true;
  }
  return false;
}

/**
 * 团队对抗的据点状态机。
 *
 * 与单人版的区别：
 *   - 进度归属是队伍（point.ownerTeam），不再属于某一名玩家；
 *   - 同队多人站在圈内不会互相冻结，大家共同推进同一份队伍进度；
 *   - 敌我两队都在圈内才进入 contested，进度冻结；
 *   - 圈内只剩敌方队伍时，旧队伍进度按 5 秒清退，清零后由当前队伍继续占。
 *
 * @param {object} point 据点对象（原地修改）
 * @param {Array<{id:string,team:string}>} occupants 圈内的存活实体（调用方已过滤阵亡/凝聚/观战）
 * @param {number} dt 秒
 * @param {(p:object)=>string|null} teamOf 取队伍 key 的函数
 * @param {object} teamColors 队伍配置（用于把进度染成队伍色）
 * @returns {boolean} 这一帧是否刚好占满 100%
 */
function stepTeamCapture(point, occupants, dt, teamOf, teamColors) {
  if (!point || !(dt > 0)) return false;
  const getTeam = typeof teamOf === 'function' ? teamOf : (p) => (p ? p.team : null);
  const colorOf = (team) => (teamColors && teamColors[team] && teamColors[team].color) || null;

  // 圈内出现了哪些队伍（去重）。没有队伍数据的人不参与团队判定。
  const present = [];
  for (const p of occupants) {
    const team = getTeam(p);
    if ((team === 'red' || team === 'blue') && !present.includes(team)) present.push(team);
  }

  // 圈内没人：旧进度按 10 秒衰减回 0。
  if (present.length === 0) {
    if (point.progress > 0) {
      point.progress = Math.max(0, point.progress - dt / DECAY_EMPTY_TIME);
      if (point.progress <= 1e-9) {
        point.progress = 0;
        point.ownerTeam = null;
        point.ownerId = null;
        point.ownerColor = null;
        point.status = 'idle';
      } else {
        point.status = 'decaying';
      }
    } else {
      point.progress = 0;
      point.ownerTeam = null;
      point.ownerId = null;
      point.ownerColor = null;
      point.status = 'idle';
    }
    return false;
  }

  // 敌我两队都在圈内：互相牵制，进度冻结。若进度属于其中一队，保留它的归属和颜色，
  // 只是不再增长；本来就没有进度则保持中立。
  if (present.length >= 2) {
    point.status = 'contested';
    point.ownerId = null;
    if (!point.ownerTeam || point.progress <= 0) {
      point.progress = 0;
      point.ownerTeam = null;
      point.ownerColor = null;
    }
    return false;
  }

  const team = present[0];

  // 圈内只剩另一队：先把旧队伍的进度按 5 秒清退，清零后下一帧再由当前队伍开始占。
  if (point.ownerTeam && point.ownerTeam !== team && point.progress > 0) {
    point.progress = Math.max(0, point.progress - dt / DECAY_NEUTRALIZE_TIME);
    point.status = 'neutralizing';
    point.ownerId = null;
    if (point.progress <= 1e-9) {
      point.progress = 0;
      point.ownerTeam = null;
      point.ownerColor = null;
    }
    return false;
  }

  // 圈内只剩一支队伍：同队多人共享同一份进度，不因人数增加而冻结或加速。
  point.ownerTeam = team;
  point.ownerId = null;
  point.ownerColor = colorOf(team) || point.ownerColor;
  point.status = 'capturing';
  point.progress = Math.min(1, point.progress + dt / CAPTURE_TIME);
  if (point.progress >= 1 - 1e-9) {
    point.progress = 1;
    return true;
  }
  return false;
}

module.exports = {
  CAPTURE_RADIUS,
  CAPTURE_TIME,
  DECAY_EMPTY_TIME,
  DECAY_NEUTRALIZE_TIME,
  isInside,
  pickCaptureSpot,
  createCapturePoint,
  stepCapture,
  stepTeamCapture,
};
