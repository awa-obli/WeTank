'use strict';

/**
 * 小地图的纯几何。
 *
 * 小地图是一块固定尺寸的覆盖层画布（内部像素 480×320，CSS 再等比缩放到 150×100），
 * 服务端下发的世界坐标（700–1200 像素宽）要等比塞进这块小画布里：
 *   - scale     世界像素 → 小地图像素的缩放比，取宽高两个方向的较小值，保证整张图都放得下；
 *   - x/y/w/h   地图在小地图画布里的矩形，居中摆放，四周留出 pad 内边距。
 *   所有地图（三档）都是 3:2，这里仍然按"较小缩放比"等比缩放而不是分别拉伸，
 *   这样以后出现非 3:2 的世界尺寸时也不会把地图拉变形。
 *
 * 绘制仍然在 client.js（和 vision.js / camera.js 的分工一致：这里只提供可单测的纯函数），
 * 本模块不依赖任何 DOM / Canvas API。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TankMinimap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isFiniteNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /**
   * 计算世界 → 小地图的等比布局。
   *
   * @param {number} worldW, worldH 世界尺寸（px）
   * @param {number} miniW, miniH   小地图画布的内部像素尺寸
   * @param {number} pad            四周内边距（px），过大时自动收窄，保证可用区域为正
   * @returns {{scale:number, x:number, y:number, w:number, h:number}}
   *          地图在小地图画布中的矩形；世界坐标 (x, y) → 画布 (layout.x + x*scale, layout.y + y*scale)
   */
  function computeLayout(worldW, worldH, miniW, miniH, pad = 0) {
    // 非法世界尺寸按 1×1 处理，调用方拿到的一定是有限数，不会画出 NaN
    const ww = isFiniteNum(worldW) && worldW > 0 ? worldW : 1;
    const wh = isFiniteNum(worldH) && worldH > 0 ? worldH : 1;
    const mw = isFiniteNum(miniW) && miniW > 0 ? miniW : 0;
    const mh = isFiniteNum(miniH) && miniH > 0 ? miniH : 0;
    // 小地图尺寸非法时返回一个零尺寸布局，调用方画不出任何东西，但也不会拿到 NaN
    if (!(mw > 0) || !(mh > 0)) return { scale: 0, x: 0, y: 0, w: 0, h: 0 };
    // 内边距最多留到短边的一半再减 0.5，剩下一块至少 1px 的可用区域
    const rawPad = isFiniteNum(pad) && pad > 0 ? Math.min(pad, Math.min(mw, mh) / 2 - 0.5) : 0;
    const p = Math.max(0, rawPad);
    const availW = Math.max(1, mw - p * 2);
    const availH = Math.max(1, mh - p * 2);
    const scale = Math.min(availW / ww, availH / wh);
    const w = ww * scale;
    const h = wh * scale;
    return {
      scale,
      x: (mw - w) / 2,
      y: (mh - h) / 2,
      w,
      h,
    };
  }

  /**
   * 世界坐标点 → 小地图坐标。
   * 坐标非法时按 0 处理，避免整张地图因为一个坏点变成 NaN。
   */
  function worldToMini(layout, x, y) {
    if (!layout) return null;
    return {
      x: layout.x + (isFiniteNum(x) ? x : 0) * layout.scale,
      y: layout.y + (isFiniteNum(y) ? y : 0) * layout.scale,
    };
  }

  /**
   * 世界坐标多边形（视野形状、墙后阴影等）→ 小地图坐标多边形。
   * 非法顶点直接跳过；调用方按 length < 3 判断是否可绘制。
   */
  function toMiniPolygon(layout, points) {
    if (!layout || !Array.isArray(points)) return [];
    const out = [];
    for (const p of points) {
      if (!p || !isFiniteNum(p.x) || !isFiniteNum(p.y)) continue;
      out.push({ x: layout.x + p.x * layout.scale, y: layout.y + p.y * layout.scale });
    }
    return out;
  }

  /**
   * 服务端墙体矩形 {cx, cy, hw, hh} → 小地图矩形 {x, y, w, h}。
   * 外围边框矩形的中心在 (0, 0) 等世界边界上、半宽超出地图，
   * 调用方需要先裁剪到地图矩形再填充（见 client.js 的 drawMinimap）。
   */
  function rectToMini(layout, rect) {
    if (!layout || !rect) return null;
    const { cx, cy, hw, hh } = rect;
    if (!isFiniteNum(cx) || !isFiniteNum(cy) || !isFiniteNum(hw) || !isFiniteNum(hh)) return null;
    if (hw < 0 || hh < 0) return null;
    return {
      x: layout.x + (cx - hw) * layout.scale,
      y: layout.y + (cy - hh) * layout.scale,
      w: hw * 2 * layout.scale,
      h: hh * 2 * layout.scale,
    };
  }

  return {
    computeLayout,
    worldToMini,
    toMiniPolygon,
    rectToMini,
  };
});
