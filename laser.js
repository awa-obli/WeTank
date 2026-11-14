'use strict';

/**
 * 激光道具的纯几何逻辑。
 *
 * 激光是一条有固定总路程的射线：从炮口出发，沿车头方向前进，碰到墙体就按
 * 墙面法线做镜面反射（和子弹用的是同一套圆-矩形扫掠/反射口径），直到总路程
 * 耗尽。它不是实体子弹，不进入 bullets 数组，只在发射的那一帧结算一次。
 *
 * 这里只放与房间/玩家无关的计算，方便单元测试直接驱动：
 *   - traceLaserPath()   求整条反弹路径的折线点
 *   - collectLaserHits() 求路径碰到的敌方坦克（每个敌人只记最早的一次）
 */

const physics = require('./physics');

const LASER_LENGTH = 480; // 固定总路程(px)，约 6 个格子
const LASER_MAX_BOUNCES = 32; // 反弹次数上限，防止极端几何下无限反射
const LASER_HALF_WIDTH = 2; // 激光视觉/判定半宽(px)
const LASER_DAMAGE = 1; // 每个敌人 1 点伤害
// 炮口起点离坦克中心的前向距离。必须明显小于坦克半径(15)：
// 坦克贴墙时（圆心到墙至少 TANK_RADIUS），起点仍能保证在墙外。
const LASER_MUZZLE_OFFSET = 12;
// 求墙体交点时用的扫掠半径。取一个很小的值而不是 0，避免正好贴边时的退化情况。
const LASER_WALL_RADIUS = 0.5;
// 反射后沿法线离开墙面的微小距离，避免下一段扫掠又从接触点开始。
const LASER_SKIN = 0.05;
const LASER_HIT_RADIUS = 15 + LASER_HALF_WIDTH; // 坦克半径 + 激光半宽

/**
 * 从 (x, y) 沿 angle 射出，求固定总长度的镜面反弹折线。
 *
 * @param {number} x 起点 x
 * @param {number} y 起点 y
 * @param {number} angle 方向（弧度，和服务端坦克 angle 同约定）
 * @param {Array} rects 墙体矩形（maps.js 生成的 rects）
 * @param {object} [options] { length, maxBounces, radius, skin }
 * @returns {{ points: Array<{x:number,y:number}>, bounces: number, length: number }}
 *   points 是折线点，相邻两点构成一段；length 是实际使用的总路程。
 */
function traceLaserPath(x, y, angle, rects, options = {}) {
  const length = options.length != null ? options.length : LASER_LENGTH;
  const maxBounces = options.maxBounces != null ? options.maxBounces : LASER_MAX_BOUNCES;
  const radius = options.radius != null ? options.radius : LASER_WALL_RADIUS;
  const skin = options.skin != null ? options.skin : LASER_SKIN;

  let dx = Math.cos(angle);
  let dy = Math.sin(angle);
  let remaining = length;
  let bounces = 0;
  const points = [{ x, y }];

  while (remaining > 1e-6 && bounces < maxBounces) {
    const hit = physics.sweepCircleVsRects(x, y, dx * remaining, dy * remaining, radius, rects);
    if (!hit) {
      // 没撞到墙：剩下的路程直接走完
      x += dx * remaining;
      y += dy * remaining;
      remaining = 0;
      points.push({ x, y });
      break;
    }

    const segLen = Math.hypot(hit.x - x, hit.y - y);
    // 接触点沿法线抬起一个 skin，作为下一段的起点；
    // 折线里保留这个点，客户端画出来几乎是连续的。
    const nx = hit.nx;
    const ny = hit.ny;
    x = hit.x + nx * skin;
    y = hit.y + ny * skin;
    points.push({ x, y });
    remaining -= segLen;

    // 镜面反射：v' = v - 2(v·n)n；只在迎面撞墙时反射。
    const dot = dx * nx + dy * ny;
    if (dot < 0) {
      dx -= 2 * dot * nx;
      dy -= 2 * dot * ny;
    }
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) break; // 退化方向，直接停下
    dx /= len;
    dy /= len;
    bounces += 1;
  }

  if (remaining > 1e-6) {
    // 达到反弹上限：剩余路程沿当前方向画完，保证总长度始终是固定值
    x += dx * remaining;
    y += dy * remaining;
    points.push({ x, y });
    remaining = 0;
  }

  return { points, bounces, length };
}

/**
 * 求折线路径碰到的坦克。每个目标只记录最早的一次接触，
 * 所以同一条激光即使来回穿过同一个目标，也只会掉一次血。
 *
 * 注意：这里不排除射手本人——激光反弹回来可以打到自己。
 * 但第一段是从炮口出发的，炮口本来就在射手自己的判定圈内，
 * 所以"起点已在圈内"时会额外要求方向朝圆心，避免刚出膛就自伤。
 *
 * @param {Array<{x:number,y:number}>} points traceLaserPath 的折线
 * @param {Array} tanks 候选坦克（服务端传存活且已有实体的玩家）
 * @param {object} options { ownerId, ownerTeam, teamMode, hitRadius }
 * @returns {Array<{playerId:string, player:object, x:number, y:number, dist:number}>}
 *   按路径距离从近到远排序。
 */
function collectLaserHits(points, tanks, options = {}) {
  const ownerId = options.ownerId;
  const ownerTeam = options.ownerTeam || null;
  const teamMode = !!options.teamMode;
  const hitRadius = options.hitRadius != null ? options.hitRadius : LASER_HIT_RADIUS;

  const hits = [];
  const seen = new Set();
  let travelled = 0;

  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1].x;
    const ay = points[i - 1].y;
    const bx = points[i].x;
    const by = points[i].y;
    const sx = bx - ax;
    const sy = by - ay;
    const segLen2 = sx * sx + sy * sy;
    if (segLen2 < 1e-12) continue;
    const segLen = Math.sqrt(segLen2);

    for (const t of tanks) {
      if (!t) continue;
      if (!t.alive) continue;
      // 重生凝聚中的坦克还没有实体，激光直接穿过，不判定命中。
      if ((t.spawnAnimRemaining || 0) > 0) continue;
      // 团队对抗关闭友伤：激光穿过队友，不会停下来，也不消耗护盾。
      // 但射手自己不受"友伤豁免"保护——反弹回来的射线可以打到自己。
      if (teamMode && ownerTeam && t.team === ownerTeam && t.id !== ownerId) continue;
      if (seen.has(t.id)) continue;

      const startDx = t.x - ax;
      const startDy = t.y - ay;
      // 起点已经在判定圈内（典型情况：第一段从炮口出发，炮口在射手自己的
      // 判定圈里；或者贴墙反弹后落点离自己很近）。这时只有继续朝坦克中心
      // 飞才算命中，避免"刚出膛"或"擦墙反弹"被误判成自伤。
      if (startDx * startDx + startDy * startDy <= hitRadius * hitRadius) {
        if (startDx * sx + startDy * sy <= 0) continue;
      }

      // 点到线段的最近点：投影到 [0,1] 后算距离，和子弹的圆-圆判定口径一致。
      let u = (startDx * sx + startDy * sy) / segLen2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = ax + sx * u;
      const py = ay + sy * u;
      const dx = t.x - px;
      const dy = t.y - py;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        seen.add(t.id);
        hits.push({ playerId: t.id, player: t, x: px, y: py, dist: travelled + segLen * u });
      }
    }

    travelled += segLen;
  }

  hits.sort((a, b) => a.dist - b.dist);
  return hits;
}

module.exports = {
  LASER_LENGTH,
  LASER_MAX_BOUNCES,
  LASER_HALF_WIDTH,
  LASER_DAMAGE,
  LASER_MUZZLE_OFFSET,
  LASER_HIT_RADIUS,
  traceLaserPath,
  collectLaserHits,
};
