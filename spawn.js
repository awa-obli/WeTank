'use strict';

/**
 * 出生点随机化：把整张地图的所有格子中心当作候选点，洗牌后取前 count 个。
 *
 * 为什么只用格心：
 *   - 迷宫墙体全部画在格子边界上（半厚 WALL_THICK/2），格子中心到任意墙面的距离
 *     至少是 CELL/2 - WALL_THICK/2，远大于坦克半径，所以随机到任何格子都不会卡墙；
 *   - 不需要再做"和墙重叠就重新随机"的拒绝采样，逻辑简单、结果可预期。
 *
 * 当前规则（需求确认过）：只要求玩家不在同一个格子，不额外限制两人之间的最小间隔。
 * 因此一次 Fisher-Yates 洗牌 + 取前 N 个即可，天然互不重复；最小地图 9×6=54 个
 * 格子，7 人永远放得下，count 超过格子总数时按格子总数封顶（防御性处理）。
 */
function pickSpawnCells({ cols, rows, cell, count, rand = Math.random }) {
  const total = cols * rows;
  const need = Math.max(0, Math.min(count, total));

  const spots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      spots.push({ r, c, x: c * cell + cell / 2, y: r * cell + cell / 2 });
    }
  }

  // Fisher-Yates，用注入的 rand 便于测试里用固定种子复现
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }

  return spots.slice(0, need);
}

/**
 * 大乱斗复活点：从全图格心里随机挑一个，优先避开与存活坦克贴脸的位置。
 *
 * 和开局出生一样只用格心，保证不会刷进墙体；区别在于复活是单人、随时发生的，
 * 所以额外做一层"离所有存活坦克至少 minDist"的过滤，避免直接刷在别人车头上。
 * 如果过滤后没有剩余格子（极端拥挤），就退回全图格心随机，保证一定能复活。
 */
function pickRespawnCell({ cols, rows, cell, avoid = [], minDist = 0, rand = Math.random }) {
  const all = [];
  const safe = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const spot = { r, c, x: c * cell + cell / 2, y: r * cell + cell / 2 };
      all.push(spot);
      let clear = true;
      for (const t of avoid) {
        const dx = spot.x - t.x;
        const dy = spot.y - t.y;
        if (dx * dx + dy * dy < minDist * minDist) {
          clear = false;
          break;
        }
      }
      if (clear) safe.push(spot);
    }
  }
  const pool = safe.length ? safe : all;
  if (pool.length === 0) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

module.exports = { pickSpawnCells, pickRespawnCell };
