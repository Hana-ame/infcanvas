// PathfindingService（2026-08-20 架构优化：从 sim.ts 提取）
// 原 Sim 承担寻路缓存 + getPath + moveTo + evictTrailCache + clearTrailCache
// = 5 个职责 150+ 行代码混在 Sim 里。提取为独立服务，Sim 委托调用。
// Sim 通过 this.path = new PathfindingService(world, tuning) 持有；
// 系统/命令处理器通过 ctx.getPath() 间接调用（SimContext 接口不变）。

// 2026-08-20 正确性修复（重要）：外层缓存 key 从"数字压缩"改回"字符串"。
// 背景（用户指摘的静默正确性问题）：
//   原数字 key = key1 * 4194304 + key2，其中 key1≈4.4e12~8.8e12 → 乘积≈1.8e19~3.7e19，
//   远超 Number.MAX_SAFE_INTEGER（9e15）约 2000~4000 倍 → 高位丢精度 → 不同
//   (起点,终点,climb) 组合可能算出相同 key → 缓存命中错误路径 → 小人走向错误位置 /
//   绕远路 / 卡住（无限世界远距离寻路必现）。
//   内部 A* 的 key = x*65536+y 是安全的（坐标被限制在 2^21，乘积 1.37e11 < 9e15）。
// 修法：外层缓存用字符串 key `${ck}:${sx},${sy}:${ex},${ey}`——安全、可读、无静默碰撞。
// 失败路径后缀 ":F"（原 key+1 奇数标记，字符串化后改用后缀），flusheDirty 按 endsWith(':F') 清。
import type { World } from './core/world';
import type { TuningConfig } from './defs/tuning';
import { findPath } from './core/pathfinding';
import type { WaypointCache } from './core/pathfinding';

// 缓存 key 构造（字符串，无溢出碰撞）
// 2026-08-20：原数字 key 溢出致静默碰撞 → 改字符串。climb 不参与法：调 findPath 时
// climb 已是实际值（含 undefined → Infinity），直接拼进 key 区分不同通过能力。
const keyOf = (ck: number, sx: number, sy: number, ex: number, ey: number): string =>
  `${ck}:${sx},${sy}:${ex},${ey}`;

export class PathfindingService {
  private trailCache = new Map<string, { x: number; y: number }[]>();
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
    const key = keyOf(ck, sx, sy, ex, ey);
    const cached = this.trailCache.get(key);
    if (cached) { this.trailHits++; return cached; }
    this.trailMisses++;
    const world = this.worldGetter();
    const tuning = this.tuningGetter();
    // 航点段缓存：锚点对路径复用同一 trailCache（字符串 key，安全无碰撞）
    const wpCache: WaypointCache = {
      get: (ax, ay, bx, by) => this.trailCache.get(keyOf(ck, ax, ay, bx, by)),
      set: (ax, ay, bx, by, p) => {
        if (this.trailCache.size >= PathfindingService.TRAIL_CACHE_MAX) this.evictTrailCache();
        this.trailCache.set(keyOf(ck, ax, ay, bx, by), p);
      },
    };
    const path = findPath(world, sx, sy, ex, ey, tuning.path, wpCache, climb);
    if (this.trailCache.size >= PathfindingService.TRAIL_CACHE_MAX) this.evictTrailCache();
    // 失败路径（空数组）key 加 ":F" 后缀 → flushDirty 只清失败路径（成功路径跨帧保留）
    this.trailCache.set(path.length === 0 ? `${key}:F` : key, path);
    return path;
  }

  clearTrailCache(): void {
    this.trailCache.clear();
  }

  // 延迟清失败路径：地形变更时标脏 → step 末只清失败路径（key 以 :F 结尾）
  markDirty(): void { this.trailDirty = true; }

  // step 末调用：清失败路径（地形变更后可能变可行）
  flushDirty(): void {
    if (!this.trailDirty) return;
    for (const k of this.trailCache.keys()) {
      if (k.endsWith(':F')) this.trailCache.delete(k);
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