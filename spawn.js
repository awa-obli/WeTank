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
 * 格子，10 人永远放得下，count 超过格子总数时按格子总数封顶（防御性处理）。
 * 占点模式会传入 avoidZones（据点圈），把圈内格心排除掉，避免一出生就占点。
 */
function pickSpawnCells({ cols, rows, cell, count, avoidZones = [], rand = Math.random }) {
  const total = cols * rows;
  const need = Math.max(0, Math.min(count, total));

  const spots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      spots.push({ r, c, x: c * cell + cell / 2, y: r * cell + cell / 2 });
    }
  }

  // 占点模式的据点圆圈：开局出生点不要落在圈内，否则一出生就开始占点。
  // 正常情况下格子数量远大于被排除的格数；极端拥挤时退回全图，保证能开局。
  const safe = avoidZones.length === 0
    ? spots
    : spots.filter((s) => !avoidZones.some((z) => {
      const dx = s.x - z.x;
      const dy = s.y - z.y;
      return dx * dx + dy * dy < z.r * z.r;
    }));
  const pool = safe.length >= need ? safe : spots;

  // Fisher-Yates，用注入的 rand 便于测试里用固定种子复现
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, need);
}

/**
 * 大乱斗 / 占点模式复活点：从全图格心里随机挑一个，优先避开与存活坦克贴脸的位置。
 *
 * 和开局出生一样只用格心，保证不会刷进墙体；区别在于复活是单人、随时发生的，
 * 所以额外做一层"离所有存活坦克至少 minDist"的过滤，避免直接刷在别人车头上。
 * 占点模式还会传入 avoidZones（当前据点圈），复活点优先不落在圈内；
 * 如果过滤后没有剩余格子（极端拥挤），就退回全图格心随机，保证一定能复活。
 */
function pickRespawnCell({ cols, rows, cell, avoid = [], avoidZones = [], minDist = 0, rand = Math.random }) {
  const all = [];
  const safe = [];
  const zoneSafe = [];
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
      // 占点模式：复活点不要落在当前据点圈内，避免一复活就白拿占领进度。
      let inZone = false;
      for (const z of avoidZones) {
        const dx = spot.x - z.x;
        const dy = spot.y - z.y;
        if (dx * dx + dy * dy < z.r * z.r) {
          inZone = true;
          break;
        }
      }
      if (!inZone) zoneSafe.push(spot);
      if (clear && !inZone) safe.push(spot);
    }
  }
  // 优先"既不贴脸坦克、也不在据点圈内"；拥挤时至少保证不在据点圈内。
  const pool = safe.length ? safe : (zoneSafe.length ? zoneSafe : all);
  if (pool.length === 0) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

module.exports = { pickSpawnCells, pickRespawnCell };
