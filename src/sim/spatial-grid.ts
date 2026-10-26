/**
 * spatial-grid.ts —— 百人同屏 (100+ Pawns Same-Screen) 极限空间哈希网格索引与批量步进优化器。
 */
import type { Eid, Hostile, PawnState, Pos } from './types';
import type { Sim } from './sim';

function packCellKey(cx: number, cy: number): number {
  return ((cx + 16384) << 15) ^ (cy + 16384);
}

interface GridEntry<T> {
  x: number;
  y: number;
  item: T;
}

export class SpatialHashGrid<T> {
  private readonly invCellSize: number;
  private readonly buckets = new Map<number, GridEntry<T>[]>();
  private readonly pool: GridEntry<T>[][] = [];
  private totalIndexed = 0;

  constructor(readonly cellSize = 8) {
    this.invCellSize = 1 / Math.max(1, cellSize);
  }

  clear(): void {
    for (const b of this.buckets.values()) {
      b.length = 0;
      if (this.pool.length < 256) this.pool.push(b);
    }
    this.buckets.clear();
    this.totalIndexed = 0;
  }

  insert(itemOrX: (T & { pos: Pos }) | number, y?: number, explicitItem?: T): void {
    let px = 0;
    let py = 0;
    let item: T;
    if (typeof itemOrX === 'number') {
      px = itemOrX;
      py = y ?? 0;
      item = explicitItem!;
    } else {
      px = itemOrX.pos.x;
      py = itemOrX.pos.y;
      item = itemOrX;
    }
    const cx = Math.floor(px * this.invCellSize);
    const cy = Math.floor(py * this.invCellSize);
    const k = packCellKey(cx, cy);
    let bucket = this.buckets.get(k);
    if (!bucket) {
      bucket = this.pool.pop() ?? [];
      this.buckets.set(k, bucket);
    }
    bucket.push({ x: px, y: py, item });
    this.totalIndexed++;
  }

  rebuild(items: Iterable<T & { pos: Pos }>): void {
    this.clear();
    for (const it of items) this.insert(it);
  }

  get size(): number {
    return this.totalIndexed;
  }

  get cellCount(): number {
    return this.buckets.size;
  }

  queryRadius(x: number, y: number, radius: number, out: T[] = []): T[] {
    out.length = 0;
    const r2 = radius * radius;
    const minCx = Math.floor((x - radius) * this.invCellSize);
    const maxCx = Math.floor((x + radius) * this.invCellSize);
    const minCy = Math.floor((y - radius) * this.invCellSize);
    const maxCy = Math.floor((y + radius) * this.invCellSize);

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.buckets.get(packCellKey(cx, cy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const e = bucket[i];
          const dx = e.x - x;
          const dy = e.y - y;
          if (dx * dx + dy * dy <= r2) {
            out.push(e.item);
          }
        }
      }
    }
    return out;
  }

  nearestInRadius(x: number, y: number, maxRadius: number, predicate?: (item: T) => boolean): T | null {
    let best: T | null = null;
    let bestD2 = maxRadius * maxRadius;
    const minCx = Math.floor((x - maxRadius) * this.invCellSize);
    const maxCx = Math.floor((x + maxRadius) * this.invCellSize);
    const minCy = Math.floor((y - maxRadius) * this.invCellSize);
    const maxCy = Math.floor((y + maxRadius) * this.invCellSize);

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = this.buckets.get(packCellKey(cx, cy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const e = bucket[i];
          if (predicate && !predicate(e.item)) continue;
          const dx = e.x - x;
          const dy = e.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= bestD2) {
            bestD2 = d2;
            best = e.item;
          }
        }
      }
    }
    return best;
  }
}

export interface HundredPawnPerfMetrics {
  pawnCount: number;
  ticks: number;
  ticksRun: number;
  totalElapsedMs: number;
  avgMsPerTick: number;
  visibleCountInViewport: number;
  lodMode: 'full' | 'compact_100_pawn';
}

/**
 * 一键将当前殖民地扩充至 `targetCount`（默认 100 人同屏），并错峰排布决策时间片以实现百人同屏极致帧率。
 */
export function spawnHundredPawnColony(sim: Sim, targetCount = 100): number {
  const currentCount = sim.pawnMap.size;
  const needed = Math.max(0, targetCount - currentCount);
  const groups = ['group_alpha', 'group_beta', 'group_gamma'];

  for (let i = 0; i < needed; i++) {
    const ring = 1 + Math.floor(i / 16);
    const angle = ((i % 16) / 16) * Math.PI * 2;
    const gx = Math.round(Math.cos(angle) * ring * 1.5);
    const gy = Math.round(Math.sin(angle) * ring * 1.5);
    const eid = sim.spawnPawn(gx, gy);
    const p = sim.pawn(eid);
    if (p) {
      p.groupId = groups[i % groups.length];
      // 错峰分帧抽卡调度 (Time-Sliced Decision Staggering)：将 100 名小人的抽卡周期均匀分散在 20 个子槽位，杜绝同帧尖峰
      p.holdUntil = sim.time + 0.5 + (i % 25) * 0.25;
      p.cardId = null;
      p.path = [{ x: gx + ((i % 2) * 2 - 1), y: gy }];
    }
  }
  sim.rebuildSpatialGrids();
  return sim.pawnMap.size;
}

/**
 * 运行百人同屏极限计算与显示裁剪基准测试
 */
export function benchmarkHundredPawnsSim(
  sim: Sim,
  ticks = 20,
  dt = 0.1,
): HundredPawnPerfMetrics {
  if (sim.pawnMap.size < 100) {
    spawnHundredPawnColony(sim, 100);
  }
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    sim.step(dt);
  }
  const totalElapsedMs = Math.max(0.01, performance.now() - t0);
  const avgMsPerTick = totalElapsedMs / Math.max(1, ticks);
  const nearby = sim.pawnGrid.queryRadius(0, 0, 28);

  return {
    pawnCount: sim.pawnMap.size,
    ticks,
    ticksRun: ticks,
    totalElapsedMs: Number(totalElapsedMs.toFixed(2)),
    avgMsPerTick: Number(avgMsPerTick.toFixed(3)),
    visibleCountInViewport: nearby.length,
    lodMode: sim.pawnMap.size >= 60 ? 'compact_100_pawn' : 'full',
  };
}

export type { PawnState, Hostile };
