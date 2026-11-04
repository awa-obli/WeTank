'use strict';

/**
 * 通用弹体反弹：圆（子弹） vs 矩形墙体。
 *
 * 检测用真实的圆-矩形关系：圆心到矩形的最近距离 < radius 才算接触。
 * 连续检测时把矩形拆成 4 条边，每条边做一次"圆扫掠线段"（即点扫掠
 * 胶囊形）求首次接触，4 条边取最早的那个时刻，就是圆第一次碰到矩形的
 * 时刻。角点不是特殊情况：它只是两条边各自的圆头端点，由同一条通用的
 * 线段扫掠处理，没有单独的角点分支。
 *
 * 反射法线只用矩形四个面的法线（局部 ±X / ±Y，旋转后到世界）：
 * 当两条相邻的边在同一个角点圆头上同时给出接触时，取"速度更迎面"的
 * 那个面（v·n 更小）——那正是子弹真正撞上的面，因此不会出现斜法线。
 *
 * 所谓"从端点旁边飞过不会接触"：
 *   碰撞区域就是真实的圆-矩形接触范围（圆角矩形）。整段路径都在它之外时，
 *   4 条边的扫掠都不会返回接触，自然不反弹。它只是几何性质，不是分支。
 *
 * 和上一版"把矩形向外扩 radius、四个角按直角处理"的区别：
 *   上一版在斜着掠过角落时会比真实情况早最多 r*(√2-1)（本游戏约 1.66px）；
 *   现在接触点严格落在圆角上，不再提前。
 */

const EPS = 1e-9;
// 接触后沿法线离开墙面的微小距离，保证下一次扫掠不会又贴着边界开始
const DEFAULT_SKIN = 0.01;
const DEFAULT_MAX_REFLECTIONS = 6;
const PENETRATION_ITERATIONS = 6;
// 两条相邻边在共享角点上给出接触时刻的浮点误差容忍；只有在这个范围内
// 才认为它们描述的是同一个接触点，可以按"更迎面"的面来挑法线。
const TIE_EPS = 1e-9;

// 每面墙的角度/三角函数/包围圆半径都只算一次；墙在一回合内是静态的。
const rectFrames = new WeakMap();

function getRectFrame(rect) {
  const angle = rect.angle || 0;
  let f = rectFrames.get(rect);
  if (!f || f.angle !== angle) {
    f = {
      angle,
      c: Math.cos(angle),
      s: Math.sin(angle),
      bound: Math.hypot(rect.hw, rect.hh),
    };
    rectFrames.set(rect, f);
  }
  return f;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// 世界坐标 -> 墙体局部坐标（以墙心为原点，按 -angle 旋转）
function toLocalPoint(rect, x, y) {
  const f = getRectFrame(rect);
  const dx = x - rect.cx;
  const dy = y - rect.cy;
  return { x: dx * f.c + dy * f.s, y: -dx * f.s + dy * f.c };
}

// 世界方向向量 -> 墙体局部方向（只旋转，不平移）
function toLocalVector(rect, x, y) {
  const f = getRectFrame(rect);
  return { x: x * f.c + y * f.s, y: -x * f.s + y * f.c };
}

// 局部法线 -> 世界法线
function toWorldNormal(rect, nx, ny) {
  const f = getRectFrame(rect);
  return { nx: nx * f.c - ny * f.s, ny: nx * f.s + ny * f.c };
}

// 局部坐标下，点到矩形 [-hw,hw]×[-hh,hh] 的最近距离
function localDistanceToRect(lx, ly, hw, hh) {
  const dx = lx - clamp(lx, -hw, hw);
  const dy = ly - clamp(ly, -hh, hh);
  return Math.hypot(dx, dy);
}

// 真正的圆-矩形重叠判断，坦克移动用。
// 返回"最近点 -> 圆心"的世界坐标向量；没有重叠返回 null。
function circleRectOverlap(cx, cy, radius, rect) {
  const f = getRectFrame(rect);
  const l = toLocalPoint(rect, cx, cy);
  const qx = clamp(l.x, -rect.hw, rect.hw);
  const qy = clamp(l.y, -rect.hh, rect.hh);
  const ex = l.x - qx;
  const ey = l.y - qy;
  const dist2 = ex * ex + ey * ey;
  if (dist2 >= radius * radius) return null;
  return {
    dx: ex * f.c - ey * f.s,
    dy: ex * f.s + ey * f.c,
    dist: Math.sqrt(dist2),
  };
}

/**
 * 子弹用：圆心是否已经和矩形接触（真实圆-矩形，圆角）。
 * 是的话返回把圆心推到接触区外所需的世界坐标法线与深度；否则返回 null。
 *
 * 只在速度朝向墙面时才会被用来反射；法线始终是四个面之一：
 *   - 圆心在矩形外：取分离分量更大的那个轴的面（角点处就是两轴平局，取 X）；
 *   - 圆心在矩形内（贴墙出生）：沿速度反方向推回入射面。
 */
function circleRectPenetration(x, y, radius, rect, vx = 0, vy = 0) {
  const f = getRectFrame(rect);
  const ddx = x - rect.cx;
  const ddy = y - rect.cy;
  const bound = f.bound + radius;
  if (ddx * ddx + ddy * ddy >= bound * bound) return null;

  const hw = rect.hw;
  const hh = rect.hh;
  const l = toLocalPoint(rect, x, y);

  const qx = clamp(l.x, -hw, hw);
  const qy = clamp(l.y, -hh, hh);
  const ex = l.x - qx;
  const ey = l.y - qy;
  const dist = Math.hypot(ex, ey);
  if (dist >= radius) return null;

  // 圆心在矩形外：用分离分量较大的轴作为面法线
  if (dist > EPS) {
    let lnx = 0;
    let lny = 0;
    if (Math.abs(ex) >= Math.abs(ey)) {
      lnx = ex >= 0 ? 1 : -1;
    } else {
      lny = ey >= 0 ? 1 : -1;
    }
    const depth = lnx !== 0 ? hw + radius - Math.abs(l.x) : hh + radius - Math.abs(l.y);
    const n = toWorldNormal(rect, lnx, lny);
    return { nx: n.nx, ny: n.ny, depth };
  }

  // 圆心已经在矩形内部：沿速度反方向推回入射面（子弹一定是从那一侧进来的）
  const lv = toLocalVector(rect, vx, vy);
  const candidates = [];
  if (lv.x > EPS) candidates.push({ nx: -1, ny: 0, depth: l.x + hw + radius });
  else if (lv.x < -EPS) candidates.push({ nx: 1, ny: 0, depth: hw - l.x + radius });
  if (lv.y > EPS) candidates.push({ nx: 0, ny: -1, depth: l.y + hh + radius });
  else if (lv.y < -EPS) candidates.push({ nx: 0, ny: 1, depth: hh - l.y + radius });

  let pick;
  if (candidates.length > 0) {
    pick = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].depth < pick.depth) pick = candidates[i];
    }
  } else {
    // 速度为 0 的退化情况：退回到几何上最近的那一面
    const toLeft = l.x + hw + radius;
    const toRight = hw - l.x + radius;
    const toTop = l.y + hh + radius;
    const toBottom = hh - l.y + radius;
    const m = Math.min(toLeft, toRight, toTop, toBottom);
    if (m === toLeft) pick = { nx: -1, ny: 0, depth: toLeft };
    else if (m === toRight) pick = { nx: 1, ny: 0, depth: toRight };
    else if (m === toTop) pick = { nx: 0, ny: -1, depth: toTop };
    else pick = { nx: 0, ny: 1, depth: toBottom };
  }

  const n = toWorldNormal(rect, pick.nx, pick.ny);
  return { nx: n.nx, ny: n.ny, depth: pick.depth };
}

// 点 (px,py) 沿 (dx,dy) 首次碰到圆 (cx,cy,radius) 的时刻 t∈[0,1]，没有返回 null。
function sweepPointVsCircle(px, py, dx, dy, radius, cx, cy) {
  const a = dx * dx + dy * dy;
  if (a < EPS) return null;
  const ex = px - cx;
  const ey = py - cy;
  const c0 = ex * ex + ey * ey - radius * radius;
  if (c0 < -EPS) return null; // 起点已经在圆内
  const b = 2 * (ex * dx + ey * dy);
  const disc = b * b - 4 * a * c0;
  if (disc < 0) return null;
  let t = (-b - Math.sqrt(disc)) / (2 * a);
  if (!(t >= -EPS && t <= 1 + EPS)) return null;
  if (t < 0) t = 0;
  return t;
}

/**
 * 点沿位移首次进入"线段 (ax,ay)->(bx,by) 向外扩 radius 的胶囊形"的时刻。
 *
 * 胶囊 = 两条平直边 + 两个端点的圆头。这里没有"角点"的概念：
 * 矩形的角点只是某条边的端点，扫到这里自然走端点的圆头。
 * 返回 t∈[0,1]，没有接触返回 null。
 */
function sweepPointVsCapsule(px, py, dx, dy, radius, ax, ay, bx, by) {
  const ex = bx - ax;
  const ey = by - ay;
  const len = Math.hypot(ex, ey);
  if (len < EPS) return null;

  const ux = ex / len;
  const uy = ey / len;
  const vx = -uy;
  const vy = ux;

  // 线段局部坐标：x 沿线段 [0,len]，y 垂直于线段
  const rx = px - ax;
  const ry = py - ay;
  const lx = rx * ux + ry * uy;
  const ly = rx * vx + ry * vy;
  const dlx = dx * ux + dy * uy;
  const dly = dx * vx + dy * vy;

  // 起点已经在线段半径内：交给穿透修正
  const near = clamp(lx, 0, len);
  const ox = lx - near;
  const oy = ly;
  if (ox * ox + oy * oy < radius * radius) return null;

  let best = Infinity;

  // 两条平直边：垂直方向进入 |y| = radius，且接触点落在线段范围内
  if (dly > EPS) {
    const t = (-radius - ly) / dly;
    if (t >= 0 && t <= 1) {
      const x = lx + dlx * t;
      if (x >= 0 && x <= len) best = t;
    }
  } else if (dly < -EPS) {
    const t = (radius - ly) / dly;
    if (t >= 0 && t <= 1) {
      const x = lx + dlx * t;
      if (x >= 0 && x <= len) best = t;
    }
  }

  // 两个端点圆头（矩形的角点在这里被当作边的端点处理）
  const t0 = sweepPointVsCircle(lx, ly, dlx, dly, radius, 0, 0);
  if (t0 != null && t0 < best) best = t0;
  const t1 = sweepPointVsCircle(lx, ly, dlx, dly, radius, len, 0);
  if (t1 != null && t1 < best) best = t1;

  return isFinite(best) ? best : null;
}

/**
 * 圆从 (px, py) 沿 (dx, dy) 扫掠，求与单个矩形的首次接触。
 * 返回 { t, x, y, nx, ny }（t∈[0,1] 为位移比例，n 为世界坐标单位法线），
 * 没有接触返回 null。
 *
 * 四条边各扫一次，取最早接触；同一角点（两条边的共享端点）上出现并列时，
 * 取 v·n 更小（更迎面）的那个面的法线。
 */
function sweepCircleVsRect(px, py, dx, dy, radius, rect) {
  // 粗筛：扫掠线段离墙心最近的距离
  const f = getRectFrame(rect);
  const rr = f.bound + radius;
  const len2 = dx * dx + dy * dy;
  let u = 0;
  if (len2 > EPS) {
    u = clamp(((rect.cx - px) * dx + (rect.cy - py) * dy) / len2, 0, 1);
  }
  const cx = px + dx * u - rect.cx;
  const cy = py + dy * u - rect.cy;
  if (cx * cx + cy * cy > rr * rr) return null;

  const l = toLocalPoint(rect, px, py);
  const ld = toLocalVector(rect, dx, dy);
  const hw = rect.hw;
  const hh = rect.hh;

  // 起点已经和矩形接触：扫掠给不出"进入"时刻，交给穿透修正
  if (localDistanceToRect(l.x, l.y, hw, hh) < radius) return null;

  // 4 条边，法线指向矩形外侧
  const edges = [
    { ax: -hw, ay: -hh, bx: hw, by: -hh, nx: 0, ny: -1 }, // 上
    { ax: hw, ay: -hh, bx: hw, by: hh, nx: 1, ny: 0 }, // 右
    { ax: hw, ay: hh, bx: -hw, by: hh, nx: 0, ny: 1 }, // 下
    { ax: -hw, ay: hh, bx: -hw, by: -hh, nx: -1, ny: 0 }, // 左
  ];

  let bestT = Infinity;
  let bestNx = 0;
  let bestNy = 0;
  let bestDot = Infinity;

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const t = sweepPointVsCapsule(l.x, l.y, ld.x, ld.y, radius, e.ax, e.ay, e.bx, e.by);
    if (t == null) continue;
    const dot = ld.x * e.nx + ld.y * e.ny;
    if (t < bestT - TIE_EPS) {
      bestT = t;
      bestNx = e.nx;
      bestNy = e.ny;
      bestDot = dot;
    } else if (t <= bestT + TIE_EPS && dot < bestDot) {
      // 同一个角点圆头上两条边并列：选速度更迎面的那个面
      bestNx = e.nx;
      bestNy = e.ny;
      bestDot = dot;
      if (t < bestT) bestT = t;
    }
  }

  if (!isFinite(bestT)) return null;

  const n = toWorldNormal(rect, bestNx, bestNy);
  return {
    t: bestT,
    x: px + dx * bestT,
    y: py + dy * bestT,
    nx: n.nx,
    ny: n.ny,
  };
}

// 在所有墙里找最早的接触
function sweepCircleVsRects(px, py, dx, dy, radius, rects) {
  let best = null;
  for (let i = 0; i < rects.length; i++) {
    const hit = sweepCircleVsRect(px, py, dx, dy, radius, rects[i]);
    if (hit && (!best || hit.t < best.t)) best = hit;
  }
  return best;
}

// 通用镜面反射：v' = v - 2(v·n)n
function reflectVelocity(vx, vy, nx, ny) {
  const dot = vx * nx + vy * ny;
  return { vx: vx - 2 * dot * nx, vy: vy - 2 * dot * ny };
}

/**
 * 把子弹从所有接触区里推出来，并对"正在朝墙里走"的速度做反射。
 * 返回 true 表示迭代上限用尽后仍然接触（异常情况）。
 */
function resolveBulletPenetration(bullet, radius, rects, skin = DEFAULT_SKIN) {
  for (let iter = 0; iter < PENETRATION_ITERATIONS; iter++) {
    let worst = null;
    for (let i = 0; i < rects.length; i++) {
      const p = circleRectPenetration(bullet.x, bullet.y, radius, rects[i], bullet.vx, bullet.vy);
      if (p && (!worst || p.depth > worst.depth)) worst = p;
    }
    if (!worst) return false;

    bullet.x += worst.nx * (worst.depth + skin);
    bullet.y += worst.ny * (worst.depth + skin);

    const dot = bullet.vx * worst.nx + bullet.vy * worst.ny;
    if (dot < 0) {
      bullet.vx -= 2 * dot * worst.nx;
      bullet.vy -= 2 * dot * worst.ny;
      bullet.bounces = (bullet.bounces || 0) + 1;
    }
  }

  // 迭代完还有残留？认为卡住了，由调用方决定怎么处理
  for (let i = 0; i < rects.length; i++) {
    if (circleRectPenetration(bullet.x, bullet.y, radius, rects[i], bullet.vx, bullet.vy)) return true;
  }
  return false;
}

/**
 * 让子弹在一个时间步 dt 内移动，并在撞墙时按面法线反射。
 * 一次调用可以处理多次反弹（例如打进墙角连弹两下），用 maxReflections 兜底。
 *
 * 返回 { stuck, reflections }。stuck 为 true 表示子弹卡在墙体几何里无法解算，
 * 调用方应把它移除，避免它从墙里直接穿出去。
 */
function stepBullet(bullet, radius, dt, rects, options = {}) {
  const skin = options.skin != null ? options.skin : DEFAULT_SKIN;
  const maxReflections = options.maxReflections != null ? options.maxReflections : DEFAULT_MAX_REFLECTIONS;
  if (bullet.bounces == null) bullet.bounces = 0;

  // 出生就嵌在墙里 / 上一帧残留的嵌入：先推出来
  if (resolveBulletPenetration(bullet, radius, rects, skin)) {
    return { stuck: true, reflections: 0 };
  }

  let remaining = dt;
  let reflections = 0;

  for (let i = 0; i < maxReflections && remaining > EPS; i++) {
    const hit = sweepCircleVsRects(bullet.x, bullet.y, bullet.vx * remaining, bullet.vy * remaining, radius, rects);
    if (!hit) {
      bullet.x += bullet.vx * remaining;
      bullet.y += bullet.vy * remaining;
      remaining = 0;
      break;
    }

    // 移动到接触点，并沿法线离开一点点
    bullet.x = hit.x + hit.nx * skin;
    bullet.y = hit.y + hit.ny * skin;

    const dot = bullet.vx * hit.nx + bullet.vy * hit.ny;
    if (dot < 0) {
      bullet.vx -= 2 * dot * hit.nx;
      bullet.vy -= 2 * dot * hit.ny;
      bullet.bounces += 1;
      reflections += 1;
    }

    remaining *= 1 - hit.t;

    // 沿法线的微调可能把子弹顶进相邻的另一面墙
    if (resolveBulletPenetration(bullet, radius, rects, skin)) {
      return { stuck: true, reflections };
    }
  }

  return { stuck: false, reflections };
}

module.exports = {
  circleRectOverlap,
  circleRectPenetration,
  sweepCircleVsRect,
  sweepCircleVsRects,
  reflectVelocity,
  resolveBulletPenetration,
  stepBullet,
  DEFAULT_SKIN,
};
