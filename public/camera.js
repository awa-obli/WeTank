'use strict';

/**
 * 视野跟随的相机几何。
 *
 * 逻辑视口固定为 720×480 世界像素（正好是 9×6 格、最小档地图的尺寸，也是全部地图
 * 统一的 3:2 比例）。不管屏幕多大、地图多大，每个玩家看到的世界范围都是这个
 * 720×480 的矩形：
 *   - 目标是自己的坦克，视口中心跟着它走；
 *   - 视口碰到地图边界就夹紧，不会露出地图外的虚空；
 *   - 地图本身不比视口大时（小地图），整图居中，视口不动。
 *
 * 这个模块同时被浏览器（挂到 window.TankCamera）和 Node 单元测试使用，
 * 所以和 vision.js 一样用最简单的 UMD 包装，不依赖任何 DOM / Canvas API。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TankCamera = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VIEW_W = 720;
  const VIEW_H = 480;

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  /**
   * 单轴取视口左上角：能居中就居中，碰到地图边界夹紧；地图比视口还小时整图居中。
   * 目标坐标缺失或非法时按地图中心处理，保证任何情况下都返回一个可用的数。
   */
  function axisOrigin(target, world, view) {
    if (!Number.isFinite(view) || view <= 0) return 0;
    if (!Number.isFinite(world)) return 0;
    if (world <= view) return (world - view) / 2;
    const safeTarget = Number.isFinite(target) ? target : world / 2;
    return clamp(safeTarget - view / 2, 0, world - view);
  }

  /**
   * 计算跟随视口在世界坐标中的矩形。
   *
   * @param {number} targetX, targetY 目标点（自己的坦克中心）
   * @param {number} worldW, worldH   世界尺寸
   * @param {number} viewW, viewH     视口世界尺寸，默认 720×480
   * @returns {{x:number, y:number, w:number, h:number}} 视口左上角与世界尺寸
   */
  function computeView(targetX, targetY, worldW, worldH, viewW = VIEW_W, viewH = VIEW_H) {
    return {
      x: axisOrigin(targetX, worldW, viewW),
      y: axisOrigin(targetY, worldH, viewH),
      w: viewW,
      h: viewH,
    };
  }

  /**
   * 世界坐标视口 → 画布像素的变换（覆盖式缩放：视口铺满画布，多出来的部分居中裁掉）。
   *
   * 地图固定 3:2、画布也按世界宽高等比，所以两个方向的缩放比本来就相等；
   * 万一以后出现别的比例，取较大的一侧，保证画面不出现空白边。
   *
   * @param {{x:number, y:number, w:number, h:number}} view computeView 的结果
   * @param {number} canvasW, canvasH 画布像素尺寸
   * @returns {{scale:number, tx:number, ty:number}} 可直接用于 ctx.setTransform(scale, 0, 0, scale, tx, ty)
   */
  function computeTransform(view, canvasW, canvasH) {
    const vx = view && Number.isFinite(view.x) ? view.x : 0;
    const vy = view && Number.isFinite(view.y) ? view.y : 0;
    const w = view && Number.isFinite(view.w) && view.w > 0 ? view.w : VIEW_W;
    const h = view && Number.isFinite(view.h) && view.h > 0 ? view.h : VIEW_H;
    const scale = Math.max(canvasW / w, canvasH / h);
    // 铺满画布后多出来的部分左右/上下均分，于是裁切是居中的。
    const offsetX = (canvasW - w * scale) / 2;
    const offsetY = (canvasH - h * scale) / 2;
    return {
      scale,
      tx: offsetX - vx * scale,
      ty: offsetY - vy * scale,
    };
  }

  /**
   * 整张地图的视口：阵亡后拉远、观战时使用。
   *
   * @param {number} worldW, worldH 世界尺寸
   * @returns {{x:number, y:number, w:number, h:number}}
   */
  function fullView(worldW, worldH) {
    return { x: 0, y: 0, w: worldW, h: worldH };
  }

  /**
   * 两个视口矩形之间线性插值：t=0 返回 a，t=1 返回 b，超出范围自动夹紧。
   * 跟随视口和全图视口都是 3:2，所以插值过程中的视口也保持 3:2，缩放是匀速的。
   *
   * @param {{x:number,y:number,w:number,h:number}} a
   * @param {{x:number,y:number,w:number,h:number}} b
   * @param {number} t 0..1
   */
  function lerpView(a, b, t) {
    const k = clamp(Number.isFinite(t) ? t : 0, 0, 1);
    return {
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      w: a.w + (b.w - a.w) * k,
      h: a.h + (b.h - a.h) * k,
    };
  }

  /**
   * 缓入缓出（easeInOutCubic）：过渡动画的头尾更柔和，不会突然起停。
   */
  function easeInOutCubic(t) {
    const k = clamp(Number.isFinite(t) ? t : 0, 0, 1);
    return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  }

  return {
    VIEW_W,
    VIEW_H,
    computeView,
    computeTransform,
    fullView,
    lerpView,
    easeInOutCubic,
  };
});
