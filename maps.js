'use strict';

/**
 * 地图类型生成器。
 *
 * 所有类型都输出同一份数据结构：
 *   - wallsV[r][c] 第 c 列与第 c+1 列之间、第 r 行的墙（竖向墙边）
 *   - wallsH[r][c] 第 r 行与第 r+1 行之间、第 c 列的墙（横向墙边）
 *   - rects        由墙边展开出的碰撞矩形（含外围边界）
 *
 * 这样服务端的坦克碰撞、子弹反弹、客户端的绘制都不需要区分地图类型，
 * 新增类型只要换一套 wallsV/wallsH 生成逻辑即可。
 *
 * 随机源通过参数注入，单元测试可以用固定种子复现。
 */

// “随机”不是一种具体布局，而是每回合从下面四种里抽一种。
const CONCRETE_MAP_TYPES = ['maze', 'open', 'symmetric', 'scatter'];
const MAP_TYPE_KEYS = [...CONCRETE_MAP_TYPES, 'random'];

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeEmptyWalls(cols, rows) {
  return {
    wallsV: Array.from({ length: rows }, () => Array(Math.max(0, cols - 1)).fill(false)),
    wallsH: Array.from({ length: Math.max(0, rows - 1) }, () => Array(cols).fill(false)),
  };
}

function makeFullWalls(cols, rows) {
  return {
    wallsV: Array.from({ length: rows }, () => Array(Math.max(0, cols - 1)).fill(true)),
    wallsH: Array.from({ length: Math.max(0, rows - 1) }, () => Array(cols).fill(true)),
  };
}

// ---------- 迷宫（原有算法，原样迁移） ----------
// 随机深度优先生成完美迷宫，再随机打通一些墙制造环路，避免死胡同过多。
function generateMaze(cols, rows, rand = Math.random) {
  const { wallsV, wallsH } = makeFullWalls(cols, rows);
  const visited = Array.from({ length: rows }, () => Array(cols).fill(false));

  function neighbors(r, c) {
    const list = [];
    if (r > 0) list.push([r - 1, c, 'H', r - 1, c]);
    if (r < rows - 1) list.push([r + 1, c, 'H', r, c]);
    if (c > 0) list.push([r, c - 1, 'V', r, c - 1]);
    if (c < cols - 1) list.push([r, c + 1, 'V', r, c]);
    return list;
  }

  const stack = [[0, 0]];
  visited[0][0] = true;
  while (stack.length > 0) {
    const [r, c] = stack[stack.length - 1];
    const opts = shuffle(neighbors(r, c), rand).filter(([nr, nc]) => !visited[nr][nc]);
    if (opts.length === 0) {
      stack.pop();
      continue;
    }
    const [nr, nc, orient, wr, wc] = opts[0];
    if (orient === 'H') wallsH[wr][wc] = false;
    else wallsV[wr][wc] = false;
    visited[nr][nc] = true;
    stack.push([nr, nc]);
  }

  // 打通一些额外的墙，制造环路，避免纯树形死胡同太多
  const extraRemovals = Math.floor(cols * rows * 0.12);
  for (let i = 0; i < extraRemovals; i++) {
    if (rand() < 0.5) {
      const r = Math.floor(rand() * rows);
      const c = Math.floor(rand() * Math.max(1, cols - 1));
      wallsV[r][c] = false;
    } else {
      const r = Math.floor(rand() * Math.max(1, rows - 1));
      const c = Math.floor(rand() * cols);
      wallsH[r][c] = false;
    }
  }

  return { wallsV, wallsH };
}

// ---------- 空旷 ----------
// 一个内墙都没有，只剩外围边界。坦克和子弹只会在四周反弹。
function generateOpen(cols, rows) {
  return makeEmptyWalls(cols, rows);
}

// ---------- 短墙工具 ----------
// 一段短墙用“起点 + 方向 + 长度”表示：
//   { orient: 'V', r, c, len } => wallsV[r..r+len-1][c]
//   { orient: 'H', r, c, len } => wallsH[r][c..c+len-1]
function segmentEdges(seg) {
  const edges = [];
  for (let i = 0; i < seg.len; i++) {
    if (seg.orient === 'V') edges.push({ orient: 'V', r: seg.r + i, c: seg.c });
    else edges.push({ orient: 'H', r: seg.r, c: seg.c + i });
  }
  return edges;
}

function setEdges(wallsV, wallsH, edges, value) {
  for (const edge of edges) {
    if (edge.orient === 'V') wallsV[edge.r][edge.c] = value;
    else wallsH[edge.r][edge.c] = value;
  }
}

// 检查某条墙边周围 margin 格内是否已经有墙。
// 同时扫 wallsV 和 wallsH，可以顺带挡住“竖向墙和横向墙在格子角点相接”的情况；
// 只要每段短墙都和其他墙保持距离，就不会围出封闭区域。
function edgeHasNearbyWall(wallsV, wallsH, edge, cols, rows, margin) {
  const rMin = Math.max(0, edge.r - margin);
  const rMax = Math.min(rows - 1, edge.r + margin);
  const cMin = Math.max(0, edge.c - margin);
  const cMax = Math.min(cols - 1, edge.c + margin);
  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      if (c <= cols - 2 && wallsV[r][c]) return true;
      if (r <= rows - 2 && c <= cols - 1 && wallsH[r][c]) return true;
    }
  }
  return false;
}

function edgeInRoomZone(edge, room) {
  if (!room) return false;
  const cells = edge.orient === 'V'
    ? [[edge.r, edge.c], [edge.r, edge.c + 1]]
    : [[edge.r, edge.c], [edge.r + 1, edge.c]];
  return cells.some(([r, c]) => (
    r >= room.r0 - 1 && r <= room.r1 + 1
    && c >= room.c0 - 1 && c <= room.c1 + 1
  ));
}

// 随机挑一段短墙（长度 1–maxLen），位置保证整段都在网格内部。
function pickSegment(cols, rows, rand, maxLen = 3) {
  if (rand() < 0.5) {
    const maxV = Math.max(1, Math.min(maxLen, rows - 1));
    const len = 1 + Math.floor(rand() * maxV);
    const r = Math.floor(rand() * Math.max(1, rows - len));
    const c = Math.floor(rand() * Math.max(1, cols - 1));
    return { orient: 'V', r, c, len };
  }
  const maxH = Math.max(1, Math.min(maxLen, cols - 1));
  const len = 1 + Math.floor(rand() * maxH);
  const r = Math.floor(rand() * Math.max(1, rows - 1));
  const c = Math.floor(rand() * Math.max(1, cols - len));
  return { orient: 'H', r, c, len };
}

function segmentFits(wallsV, wallsH, seg, cols, rows, room = null) {
  for (const edge of segmentEdges(seg)) {
    const inBounds = edge.orient === 'V'
      ? edge.r >= 0 && edge.r <= rows - 2 && edge.c >= 0 && edge.c <= cols - 2
      : edge.r >= 0 && edge.r <= rows - 2 && edge.c >= 0 && edge.c <= cols - 1;
    if (!inBounds) return false;
    if (edgeInRoomZone(edge, room)) return false;
    if (edgeHasNearbyWall(wallsV, wallsH, edge, cols, rows, 1)) return false;
  }
  return true;
}

// ---------- 散块 ----------
// 随机放几段互不相连的短墙。因为每段墙都是孤立的直线段，没有闭合回路，
// 所以格子之间天然全部连通，不需要运行时再做连通性校验。
function generateScatter(cols, rows, rand = Math.random) {
  const { wallsV, wallsH } = makeEmptyWalls(cols, rows);
  const target = Math.max(3, Math.round((cols * rows) / 16));
  let placed = 0;
  let attempts = 0;
  while (placed < target && attempts < target * 80) {
    attempts += 1;
    const seg = pickSegment(cols, rows, rand);
    if (!segmentFits(wallsV, wallsH, seg, cols, rows)) continue;
    setEdges(wallsV, wallsH, segmentEdges(seg), true);
    placed += 1;
  }
  return { wallsV, wallsH };
}

// ---------- 对称 ----------
// 中心一座四面开门的方堡，再加几段左右镜像的短墙。
// 方堡有门、短墙彼此孤立，所以整张图仍然连通。
function addCentralRoom(wallsV, wallsH, cols, rows) {
  let roomW = cols >= 14 ? 5 : (cols >= 12 ? 4 : 3);
  // 左墙的镜像映射会跨过世界中线：房间宽度和地图列数的奇偶性一致，
  // 房间才能落在正中并且左右完全对称（9→3、12→4、15→5）。
  if (roomW % 2 !== cols % 2) roomW += 1;
  roomW = Math.min(roomW, cols - 2);
  const roomH = Math.min(rows >= 8 ? 4 : 3, rows - 2);

  const c0 = Math.floor((cols - roomW) / 2);
  const r0 = Math.floor((rows - roomH) / 2);
  const c1 = c0 + roomW - 1;
  const r1 = r0 + roomH - 1;

  for (let c = c0; c <= c1; c++) {
    wallsH[r0 - 1][c] = true;
    wallsH[r1][c] = true;
  }
  for (let r = r0; r <= r1; r++) {
    wallsV[r][c0 - 1] = true;
    wallsV[r][c1] = true;
  }

  // 每面至少开一道门；宽度为偶数时上下各开两格，保持左右镜像对称。
  const dc = c0 + Math.floor(roomW / 2);
  const dr = r0 + Math.floor(roomH / 2);
  if (roomW % 2 === 0) {
    wallsH[r0 - 1][dc] = false;
    wallsH[r0 - 1][dc - 1] = false;
    wallsH[r1][dc] = false;
    wallsH[r1][dc - 1] = false;
  } else {
    wallsH[r0 - 1][dc] = false;
    wallsH[r1][dc] = false;
  }
  wallsV[dr][c0 - 1] = false;
  wallsV[dr][c1] = false;

  return { c0, r0, c1, r1 };
}

function mirrorSegment(seg, cols) {
  if (seg.orient === 'V') {
    // 竖墙沿行方向延伸，镜像只改列号；cols-2-c 是竖墙边界的镜像位置。
    return { orient: 'V', r: seg.r, c: cols - 2 - seg.c, len: seg.len };
  }
  // 横墙沿列方向延伸，镜像后起点要整体翻到另一侧。
  return { orient: 'H', r: seg.r, c: cols - seg.len - seg.c, len: seg.len };
}

function generateSymmetric(cols, rows, rand = Math.random) {
  const { wallsV, wallsH } = makeEmptyWalls(cols, rows);
  const room = addCentralRoom(wallsV, wallsH, cols, rows);
  const target = Math.max(2, Math.round((cols * rows) / 35));
  let placed = 0;
  let attempts = 0;

  while (placed < target && attempts < target * 120) {
    attempts += 1;
    const seg = pickSegment(cols, rows, rand, 2);

    // 只在地图左半边生成，再镜像到右半边；保证两段不跨中线重叠。
    const half = seg.orient === 'V' ? (cols - 2) / 2 : (cols - 1) / 2;
    if (seg.c + seg.len - 1 >= half) continue;
    if (!segmentFits(wallsV, wallsH, seg, cols, rows, room)) continue;

    // 先放左半段，再检查镜像段；镜像段不合法就整段撤回。
    setEdges(wallsV, wallsH, segmentEdges(seg), true);
    const mirror = mirrorSegment(seg, cols);
    if (!segmentFits(wallsV, wallsH, mirror, cols, rows, room)) {
      setEdges(wallsV, wallsH, segmentEdges(seg), false);
      continue;
    }
    setEdges(wallsV, wallsH, segmentEdges(mirror), true);
    placed += 1;
  }

  return { wallsV, wallsH };
}

// ---------- 墙边 -> 碰撞矩形 ----------
function buildRects(wallsV, wallsH, cols, rows, cell, wallThick) {
  const worldW = cols * cell;
  const worldH = rows * cell;
  const rects = [];
  const OVERLAP = wallThick / 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (wallsV[r][c]) {
        rects.push({
          cx: (c + 1) * cell,
          cy: r * cell + cell / 2,
          hw: wallThick / 2,
          hh: cell / 2 + OVERLAP,
        });
      }
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      if (wallsH[r][c]) {
        rects.push({
          cx: c * cell + cell / 2,
          cy: (r + 1) * cell,
          hw: cell / 2 + OVERLAP,
          hh: wallThick / 2,
        });
      }
    }
  }

  // 外边界
  rects.push({ cx: worldW / 2, cy: 0, hw: worldW / 2 + wallThick, hh: wallThick / 2 });
  rects.push({ cx: worldW / 2, cy: worldH, hw: worldW / 2 + wallThick, hh: wallThick / 2 });
  rects.push({ cx: 0, cy: worldH / 2, hw: wallThick / 2, hh: worldH / 2 + wallThick });
  rects.push({ cx: worldW, cy: worldH / 2, hw: wallThick / 2, hh: worldH / 2 + wallThick });

  return rects;
}

/**
 * 按类型生成一局地图。
 *
 * @param {string} type maze | open | symmetric | scatter | random
 * @param {object} opts { cols, rows, cell, wallThick, rand }
 * @returns {{ type: string, wallsV: boolean[][], wallsH: boolean[][], rects: object[] }}
 */
function generateMap(type, opts = {}) {
  const { cols, rows, cell = 80, wallThick = 10, rand = Math.random } = opts;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) {
    throw new Error('地图行列数必须是 >= 2 的整数');
  }

  const resolved = type === 'random'
    ? CONCRETE_MAP_TYPES[Math.floor(rand() * CONCRETE_MAP_TYPES.length)]
    : type;
  if (!CONCRETE_MAP_TYPES.includes(resolved)) {
    throw new Error(`未知的地图类型: ${type}`);
  }

  let walls;
  if (resolved === 'maze') walls = generateMaze(cols, rows, rand);
  else if (resolved === 'open') walls = generateOpen(cols, rows);
  else if (resolved === 'symmetric') walls = generateSymmetric(cols, rows, rand);
  else walls = generateScatter(cols, rows, rand);

  return {
    type: resolved,
    wallsV: walls.wallsV,
    wallsH: walls.wallsH,
    rects: buildRects(walls.wallsV, walls.wallsH, cols, rows, cell, wallThick),
  };
}

module.exports = {
  CONCRETE_MAP_TYPES,
  MAP_TYPE_KEYS,
  generateMap,
  generateMaze,
  generateOpen,
  generateSymmetric,
  generateScatter,
  buildRects,
};
