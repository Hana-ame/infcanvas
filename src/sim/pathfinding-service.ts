// PathfindingService（2026-08-20 架构优化：从 sim.ts 提取）
// 原 Sim 承担寻路缓存 + getPath + moveTo + evictTrailCache + clearTrailCache
// = 5 个职责 150+ 行代码混在 Sim 里。提取为独立服务，Sim 委托调用。
// Sim 通过 this.path = new PathfindingService(world, tuning) 持有；
// 系统/命令处理器通过 ctx.getPath() 间接调用（SimContext 接口不变）。
import type { World } from './core/world';
import type { TuningConfig } from './defs/tuning';
import { findPath } from './core/pathfinding';
import type { WaypointCache } from './core/pathfinding';

// 寻路缓存（trailCache）：数字 key（2026-08-20 优化：消除字符串拼接）
// 编码：key1 = sx * 2097152 + sy + climb * 4398046511104
//       key  = key1 * 4194304 + (ex * 2097152 + ey)
// 失败路径 key+1（奇数 → onTileChange 时只清失败路径）

// PathfindingService：从 sim.ts 提取的寻路缓存服务（trailCache + getPath + FIFO 淘汰）
// 背景：sim.ts 原 1080 行含寻路 150+ 行 → 提取后 Sim 委托调用，职责分离
export class PathfindingService {
  private trailCache = new Map<number, { x: number; y: number }[]>();
  trailHits = 0;
  trailMisses = 0;
  private trailDirty = false;
  static readonly TRAIL_CACHE_MAX = 32768;
  static readonly TRAIL_CACHE_EVICT = 8192;

  constructor(
    private worldGetter: () => World,
    private tuningGetter: () => TuningConfig,
  ) {}

  get trailCacheSize() { return this.trailCache.size; }

  getPath(sx: number, sy: number, ex: number, ey: number, climb: number): { x: number; y: number }[] {
    const ck = climb;
    const key1 = (sx * 2097152 + sy) + ck * 4398046511104;
    const key2 = ex * 2097152 + ey;
    const key = key1 * 4194304 + key2;
    const cached = this.trailCache.get(key);
    if (cached) { this.trailHits++; return cached; }
    this.trailMisses++;
    const world = this.worldGetter();
    const tuning = this.tuningGetter();
    const path = findPath(world, sx, sy, ex, ey, tuning.path, {
      get: (ax: number, ay: number, bx: number, by: number) =>
        this.trailCache.get(((ax * 2097152 + ay) + ck * 4398046511104) * 4194304 + (bx * 2097152 + by)),
      set: (ax: number, ay: number, bx: number, by: number, p: { x: number; y: number }[]) => {
        if (this.trailCache.size >= PathfindingService.TRAIL_CACHE_MAX) this.evictTrailCache();
        this.trailCache.set(((ax * 2097152 + ay) + ck * 4398046511104) * 4194304 + (bx * 2097152 + by), p);
      },
    }, climb);
    if (this.trailCache.size >= PathfindingService.TRAIL_CACHE_MAX) this.evictTrailCache();
    // 失败路径（空数组）key 加 1 → onTileChange 时只清失败路径（成功路径跨帧保留）
    this.trailCache.set(path.length === 0 ? key + 1 : key, path);
    return path;
  }

  clearTrailCache(): void {
    this.trailCache.clear();
  }

  // 延迟清失败路径：地形变更时标脏 → step 末只清失败路径（key 奇数）
  markDirty(): void { this.trailDirty = true; }

  // step 末调用：清失败路径
  flushDirty(): void {
    if (!this.trailDirty) return;
    for (const k of this.trailCache.keys()) {
      if (typeof k === 'number' && (k & 1) === 1) this.trailCache.delete(k);
    }
    this.trailDirty = false;
  }

  // 立即清全部（建筑被毁时调用）
  clearAll(): void {
    this.trailCache.clear();
    this.trailDirty = false;
  }

  // FIFO 近似淘汰：删前 N 条（Map 迭代序 = 插入序，最旧在前）
  private evictTrailCache(): void {
    let n = PathfindingService.TRAIL_CACHE_EVICT;
    for (const k of this.trailCache.keys()) {
      this.trailCache.delete(k);
      if (--n <= 0) break;
    }
  }
}