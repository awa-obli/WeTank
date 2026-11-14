'use strict';

/**
 * 暗黑模式的视野几何。
 *
 * 可见范围 = 「以坦克为中心、面朝方向 ±FOV/2 的扇形」∪「以坦克为中心的近身小圈」，
 * 两者都会被墙体挡住。墙体直接用服务端 game_start 下发的 maze.rects
 * （与坦克碰撞、子弹/激光反弹是同一套矩形），所以"看得见的墙"和"挡视线的墙"完全一致。
 *
 * 计算方式：从坦克中心向四周发射射线，每条射线取最近的墙体交点，
 * 再把每条射线的可见距离按"扇形内 = range，扇形外 = nearRadius"截断，
 * 连成的多边形就是可见区域。射线角度由三部分组成：
 *   1. 扇形内均匀采样（保证圆弧/边界平滑）；
 *   2. 扇形外那圈近身圆弧的均匀采样；
 *   3. 附近墙体每个角点的精确角度（± 一个很小的 epsilon），让遮挡边界贴着墙角，
 *      不会被均匀采样"抹圆"。
 *
 * 这个模块同时被浏览器（挂到 window.TankVision）和 Node 单元测试（module.exports）使用，
 * 所以用最简单的 UMD 包装，不依赖任何 DOM / Canvas API。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TankVision = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FULL_TURN = Math.PI * 2;
  // 默认视野参数，与 client.js 里的 DARK_* 常量保持一致（测试也直接引用这里的默认值）。
  const DEFAULT_FOV = (90 * Math.PI) / 180; // 面朝方向两侧各 45°
  const DEFAULT_RANGE = 360;                // 扇形最大距离（4.5 格）
  const DEFAULT_NEAR_RADIUS = 60;           // 近身圈半径（约 0.75 格）

  const EPS = 1e-9;

  /**
   * 把服务端的墙体矩形展开成线段列表。
   * 每个矩形贡献 4 条边；附带 minX/maxX/minY/maxY 用于快速剔除远处的墙。
   *
   * @param {Array<{cx:number, cy:number, hw:number, hh:number}>} rects
   * @returns {Array<{x1:number,y1:number,x2:number,y2:number,minX:number,minY:number,maxX:number,maxY:number}>}
   */
  function buildSegments(rects) {
    const segments = [];
    if (!Array.isArray(rects)) return segments;
    for (const r of rects) {
      if (!r) continue;
      const { cx, cy, hw, hh } = r;
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(hw > 0) || !(hh > 0)) continue;
      const left = cx - hw;
      const right = cx + hw;
      const top = cy - hh;
      const bottom = cy + hh;
      const boxes = [
        [left, top, right, top],
        [right, top, right, bottom],
        [right, bottom, left, bottom],
        [left, bottom, left, top],
      ];
      for (const [x1, y1, x2, y2] of boxes) {
        segments.push({
          x1, y1, x2, y2,
          minX: Math.min(x1, x2),
          maxX: Math.max(x1, x2),
          minY: Math.min(y1, y2),
          maxY: Math.max(y1, y2),
        });
      }
    }
    return segments;
  }

  // 把角度归一化到 (-π, π]，用于判断"在不在面朝扇形内"。
  function normalizeAngle(angle) {
    let a = angle % FULL_TURN;
    if (a > Math.PI) a -= FULL_TURN;
    else if (a <= -Math.PI) a += FULL_TURN;
    return a;
  }

  // 把角度归一化到 [0, 2π)，用于按角度排序。
  function normalizeTurn(angle) {
    let a = angle % FULL_TURN;
    if (a < 0) a += FULL_TURN;
    return a;
  }

  // 点到线段 AABB 的最近距离平方，用作"这条墙是否在视野范围内"的快速下界。
  function distSqToSegmentBox(seg, x, y) {
    const nx = Math.max(seg.minX, Math.min(x, seg.maxX));
    const ny = Math.max(seg.minY, Math.min(y, seg.maxY));
    const dx = nx - x;
    const dy = ny - y;
    return dx * dx + dy * dy;
  }

  /**
   * 只保留距 (x, y) 不超过 radius 的墙段（按 AABB 下界判断，只会多留、不会漏）。
   * 视野范围通常只有几格，这一步能把整张图的墙从几百段压到几十段。
   */
  function selectNearbySegments(segments, x, y, radius) {
    const r2 = radius * radius;
    const out = [];
    for (const seg of segments) {
      if (distSqToSegmentBox(seg, x, y) <= r2) out.push(seg);
    }
    return out;
  }

  /**
   * 从 (ox, oy) 沿 angle 方向发射射线，返回最近的墙体距离。
   * 没有命中时返回 maxDist（即被视野上限截断）。
   */
  function castRay(segments, ox, oy, angle, maxDist) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // 射线自身 AABB，用于逐段快速剔除
    const ex = ox + dx * maxDist;
    const ey = oy + dy * maxDist;
    const rayMinX = Math.min(ox, ex);
    const rayMaxX = Math.max(ox, ex);
    const rayMinY = Math.min(oy, ey);
    const rayMaxY = Math.max(oy, ey);

    let nearest = maxDist;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.maxX < rayMinX || seg.minX > rayMaxX || seg.maxY < rayMinY || seg.minY > rayMaxY) continue;
      const sx = seg.x2 - seg.x1;
      const sy = seg.y2 - seg.y1;
      // 射线方向与线段的叉积；接近 0 表示平行，直接跳过
      const denom = dx * sy - dy * sx;
      if (denom > -EPS && denom < EPS) continue;
      const qx = seg.x1 - ox;
      const qy = seg.y1 - oy;
      const t = (qx * sy - qy * sx) / denom;
      if (t < 0 || t >= nearest) continue;
      const u = (qx * dy - qy * dx) / denom;
      if (u < 0 || u > 1) continue;
      nearest = t;
    }
    return nearest;
  }

  /**
   * 某条方向上的可见距离：扇形内最多 range，扇形外最多 nearRadius，再被墙体截断。
   */
  function visibleDistance(segments, x, y, viewAngle, dirAngle, opts = {}) {
    const fov = Number.isFinite(opts.fov) ? opts.fov : DEFAULT_FOV;
    const range = Number.isFinite(opts.range) ? opts.range : DEFAULT_RANGE;
    const nearRadius = Number.isFinite(opts.nearRadius) ? opts.nearRadius : DEFAULT_NEAR_RADIUS;
    const delta = normalizeAngle(dirAngle - viewAngle);
    const limit = Math.abs(delta) <= fov / 2 + EPS ? range : nearRadius;
    return Math.min(limit, castRay(segments, x, y, dirAngle, limit));
  }

  /**
   * 计算可见区域多边形（世界坐标，按角度顺序排列）。
   *
   * @param {object} opts
   *   segments   buildSegments 的结果
   *   x, y       坦克中心
   *   angle      坦克朝向（弧度）
   *   fov/range/nearRadius  视野参数，默认 90° / 360px / 60px
   *   coneStep   扇形内采样角步长，默认 1°
   *   outerStep  扇形外近身圆弧采样步长，默认 3°
   * @returns {Array<{x:number,y:number}>} 多边形顶点，可直接 moveTo/lineTo 后 fill
   */
  function visibilityPolygon(opts) {
    const {
      segments,
      x,
      y,
      angle,
      fov = DEFAULT_FOV,
      range = DEFAULT_RANGE,
      nearRadius = DEFAULT_NEAR_RADIUS,
      coneStep = Math.PI / 180,
      outerStep = Math.PI / 60,
      cornerEps = 0.0006,
    } = opts || {};

    const half = fov / 2;
    const maxR = Math.max(range, nearRadius);
    const nearby = selectNearbySegments(segments || [], x, y, maxR + 2);
    const start = angle - half; // 扇形起点，后续角度都相对它归一化到 [0, 2π)
    const relAngles = [];

    // 1) 扇形内部：均匀采样，两端各带一个边界角（边界处会出现"扇形 range → 近身圈"的径向跳变）
    for (let rel = 0; rel <= fov + EPS; rel += coneStep) relAngles.push(rel);

    // 扇形与近身圈的衔接是"径向跳变"：到达视角边界后，可见距离从 range 直接掉到 nearRadius。
    // 必须在边界外侧补一个紧贴边界的角：否则多边形会用一条长斜边把边界外侧、
    // 近身圈之外的区域也包进来，造成扇形边缘"漏视野"。
    relAngles.push(fov + 1e-4);        // 右边界外侧
    relAngles.push(FULL_TURN - 1e-4);  // 左边界外侧（闭合边回到 rel=0）

    // 2) 扇形之外：只剩近身圈，采样一整圈圆弧（从扇形右边界一路绕回左边界）
    for (let rel = fov; rel <= FULL_TURN - EPS; rel += outerStep) relAngles.push(rel);

    // 3) 墙体角点：每个角点取精确角与 ±epsilon 三条射线，遮挡边界就会贴着墙角走。
    //    角落通常被多个矩形共用，先用坐标去重，避免重复射线。
    const seenCorners = new Set();
    for (const seg of nearby) {
      const corners = [
        [seg.x1, seg.y1],
        [seg.x2, seg.y2],
      ];
      for (const [cx, cy] of corners) {
        const key = `${Math.round(cx * 100)},${Math.round(cy * 100)}`;
        if (seenCorners.has(key)) continue;
        seenCorners.add(key);
        const vx = cx - x;
        const vy = cy - y;
        const dist = Math.hypot(vx, vy);
        if (dist < 1e-6 || dist > maxR + 2) continue;
        const ca = Math.atan2(vy, vx);
        // 角点本身必须落在可见范围内，否则这条射线只会打到视野边界上，没有意义
        const delta = normalizeAngle(ca - angle);
        const limit = Math.abs(delta) <= half + EPS ? range : nearRadius;
        if (dist > limit + 2) continue;
        const rel = normalizeTurn(ca - start);
        relAngles.push(rel - cornerEps, rel, rel + cornerEps);
      }
    }

    // 统一归一化到 [0, 2π) 后排序，并过滤掉间距过小的重复角，
    // 避免多边形出现零长度边（某些角点可能同时被多个矩形和采样角覆盖）。
    const sorted = relAngles
      .map((rel) => normalizeTurn(rel))
      .sort((a, b) => a - b);
    const unique = [];
    for (const rel of sorted) {
      if (unique.length === 0 || rel - unique[unique.length - 1] > 1e-6) unique.push(rel);
    }

    const points = [];
    for (const rel of unique) {
      const dir = start + rel;
      const limit = rel <= fov + EPS ? range : nearRadius;
      const dist = Math.min(limit, castRay(nearby, x, y, dir, limit));
      points.push({ x: x + Math.cos(dir) * dist, y: y + Math.sin(dir) * dist });
    }
    return points;
  }

  // 计算多边形某个顶点指向可见区域内部（近似指向坦克）的法线。
  // 相邻两条边的法线取平均，这样扇形的侧边（径向边）也能得到"侧向"的偏移，
  // 墙角/尖刺处退化时回退到"指向坦克中心"的径向方向。
  function inwardNormalAt(points, i, ox, oy) {
    const n = points.length;
    const p = points[i];
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    let nx = 0;
    let ny = 0;
    for (const q of [prev, next]) {
      const ex = p.x - q.x;
      const ey = p.y - q.y;
      const len = Math.hypot(ex, ey);
      if (len < 1e-9) continue;
      let vx = -ey / len;
      let vy = ex / len;
      if (vx * (ox - p.x) + vy * (oy - p.y) < 0) {
        vx = -vx;
        vy = -vy;
      }
      nx += vx;
      ny += vy;
    }
    let len = Math.hypot(nx, ny);
    if (len < 1e-9) {
      nx = ox - p.x;
      ny = oy - p.y;
      len = Math.hypot(nx, ny);
    }
    if (len < 1e-9) return [0, 0];
    return [nx / len, ny / len];
  }

  /**
   * 把可见多边形的所有顶点沿内法线的反方向向外扩 amount 距离。
   * 墙体遮挡顶点和视野极限顶点一视同仁，轮廓整体向外"长胖"一圈，用于向外羽化。
   *
   * @param {Array<{x:number,y:number}>} points visibilityPolygon 的结果
   * @param {number} ox, oy 坦克中心
   * @param {number} amount 向外扩展距离（px）
   * @returns {Array<{x:number,y:number}>} 扩展后的多边形
   */
  function expandPolygon(points, ox, oy, amount) {
    if (!Array.isArray(points) || !(amount > 0)) return points || [];
    return points.map((p, i) => {
      const [nx, ny] = inwardNormalAt(points, i, ox, oy);
      return { x: p.x - nx * amount, y: p.y - ny * amount };
    });
  }

  /**
   * 生成向外羽化用的多层多边形：由内到外逐层扩大，alpha 依次为 1、1/2、1/3 …… 1/steps，
   * 叠加后黑色从视野边界处的 0 线性过渡到边界外 width 处的 1。
   * 所有边界（包括墙体遮挡造成的边界）都一起向外扩。
   *
   * @param {Array} points visibilityPolygon 的结果
   * @param {number} ox, oy 坦克中心
   * @param {number} width 羽化带宽度（px）
   * @param {number} steps 分层数，默认 12
   * @returns {Array<{points:Array, alpha:number}>} 从原多边形开始、由内到外的绘制顺序
   */
  function featherRings(points, ox, oy, width, steps = 12) {
    if (!Array.isArray(points)) return [];
    const rings = [{ points, alpha: 1 }];
    if (!(width > 0) || !(steps >= 1)) return rings;
    const n = Math.floor(steps);
    for (let k = 1; k <= n; k++) {
      rings.push({
        points: expandPolygon(points, ox, oy, (k * width) / n),
        alpha: 1 / k,
      });
    }
    return rings;
  }

  /**
   * 生成每堵墙的"阴影多边形"（世界坐标）：从坦克看过去，墙面切线之间的整块区域，
   * 一直延伸到 length 距离。用来把墙后的视野硬切成全黑，墙边不参与羽化。
   *
   * 只使用几何信息，不依赖可见多边形：因此扇形边界即使中途撞到墙，墙前的部分
   * 仍然可以正常羽化，只有墙后的阴影被整块涂黑。
   *
   * @param {Array<{cx:number,cy:number,hw:number,hh:number}>} rects 墙体矩形
   * @param {number} ox, oy 坦克中心
   * @param {number} length 阴影延伸距离（px）
   * @returns {Array<Array<{x:number,y:number}>>} 阴影多边形列表
   */
  function wallShadowPolygons(rects, ox, oy, length) {
    const shadows = [];
    if (!Array.isArray(rects) || !(length > 0)) return shadows;
    for (const r of rects) {
      if (!r) continue;
      const left = r.cx - r.hw;
      const right = r.cx + r.hw;
      const top = r.cy - r.hh;
      const bottom = r.cy + r.hh;
      // 坦克在墙体内（正常游戏不会发生）：跳过，避免切线计算退化
      if (ox > left && ox < right && oy > top && oy < bottom) continue;
      // 墙比关注区域还远：它的阴影起点也在关注区域之外，不必绘制
      const nearX = Math.max(left, Math.min(ox, right));
      const nearY = Math.max(top, Math.min(oy, bottom));
      if (Math.hypot(nearX - ox, nearY - oy) > length) continue;

      // 四个角相对"墙心方向"的角度，找出角度最小的两个角作为切线端点。
      const centerAngle = Math.atan2(r.cy - oy, r.cx - ox);
      const corners = [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
      ];
      let minRel = Infinity;
      let maxRel = -Infinity;
      let minIdx = 0;
      let maxIdx = 0;
      for (let i = 0; i < corners.length; i++) {
        const [cx, cy] = corners[i];
        const rel = normalizeAngle(Math.atan2(cy - oy, cx - ox) - centerAngle);
        if (rel < minRel) {
          minRel = rel;
          minIdx = i;
        }
        if (rel > maxRel) {
          maxRel = rel;
          maxIdx = i;
        }
      }
      const span = maxRel - minRel;
      if (!(span > 1e-4)) continue;

      const a0 = centerAngle + minRel;
      const a1 = centerAngle + maxRel;
      const [ax, ay] = corners[minIdx];
      const [bx, by] = corners[maxIdx];
      // 远边界沿弧线采样，保证任意方向都被阴影覆盖到 length，而不是被一条直弦截短
      const steps = Math.max(1, Math.ceil(span / (Math.PI / 18)));
      const poly = [{ x: ax, y: ay }];
      for (let i = 0; i <= steps; i++) {
        const a = a0 + (span * i) / steps;
        poly.push({ x: ox + Math.cos(a) * length, y: oy + Math.sin(a) * length });
      }
      poly.push({ x: bx, y: by });
      shadows.push(poly);
    }
    return shadows;
  }

  return {
    DEFAULT_FOV,
    DEFAULT_RANGE,
    DEFAULT_NEAR_RADIUS,
    buildSegments,
    normalizeAngle,
    normalizeTurn,
    selectNearbySegments,
    castRay,
    visibleDistance,
    visibilityPolygon,
    expandPolygon,
    featherRings,
    wallShadowPolygons,
  };
});
