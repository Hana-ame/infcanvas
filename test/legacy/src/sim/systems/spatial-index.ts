// ① findNearest 空间索引优化（2026-08-20）：原环状扫描 O(半径²)
// → 格子哈希表 O(命中格数)。用于工作搜索（找树/矿/建筑）和祈祷点搜索。
// 索引 = Map<格子key, Set<满足条件的格子>>，每 tick 构建（同 crowdGrid 策略）。
// 只索引"可收获 tile"（growable+harvest）和"带 tag 的建筑"——数量少、命中快。

import type { SimContext } from './context';
import { World } from '../core/world';

export interface SpatialIndex {
  // 格子索引：key = (x&0xFFFF) | (y<<16)，值 = 满足条件的格子坐标列表
  tiles: Map<number, { x: number; y: number }[]>;
  // 建筑索引：按 tag 分桶
  buildings: Map<string, { x: number; y: number }[]>;
}

// 构建 tile 空间索引（growable+harvest 的可采集格）
export function buildTileIndex(ctx: SimContext, _range: number): Map<number, { x: number; y: number }[]> {
  const idx = new Map<number, { x: number; y: number }[]>();
  // 扫描已生成 chunk 内的可采集格（只扫出生区 + 周边几个 chunk）
  // 2026-08-20 优化：只扫出生区（world.width×height = 192×192）而非 farScanRadius(36) → 5184 格
  // 出生区外的 tile 极少被采集（小人不会走太远工作）
  for (let x = 0; x < ctx.world.width; x++) {
    for (let y = 0; y < ctx.world.height; y++) {
      const t = ctx.world.getTileDef(x, y);
      if (!t.growable || !t.harvest) continue;
      const k = (x & 0xFFFF) | (y << 16);
      let bucket = idx.get(k);
      if (!bucket) { bucket = []; idx.set(k, bucket); }
      bucket.push({ x, y });
    }
  }
  return idx;
}

// 构建建筑索引（按 tag 分桶）
export function buildBuildingIndex(ctx: SimContext): Map<string, { x: number; y: number }[]> {
  const idx = new Map<string, { x: number; y: number }[]>();
  for (const [k, b] of ctx.world.buildings) {
    if (!b.def.tags) continue;
    const { x, y } = World.keyToXY(k);
    for (const tag of b.def.tags) {
      let bucket = idx.get(tag);
      if (!bucket) { bucket = []; idx.set(tag, bucket); }
      bucket.push({ x, y });
    }
  }
  return idx;
}

// 从索引查最近命中（O(命中格数)，通常 < 20）
export function findNearestFromIndex(
  pos: { x: number; y: number },
  candidates: { x: number; y: number }[],
  maxDist: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = maxDist * maxDist;
  for (const c of candidates) {
    const d = (c.x - pos.x) * (c.x - pos.x) + (c.y - pos.y) * (c.y - pos.y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}