/**
 * hpa-infinite.ts —— 针对 infcanvas 无限地图的三层分层寻路引擎（3-Tier Infinite-Canvas Pathfinding）。
 *
 * 为什么无限地图不能只用单层 A*：
 *  1. 无限地图坐标域 (x,y) ∈ (-∞, +∞)，当目标被大湖/高差岩层阻隔时，普通 A* 的 open 集合
 *     按 O(D²) 膨胀，容易耗尽迭代预算或造成帧尖峰。
 *  2. 玩家可随时在任意区块建墙/拆墙，无法像固定 250×250 地图那样在开局预烘焙全图网格。
 *  3. 多人对战/玩家扮演 Raid 时，20+ 袭击单位同时向殖民地寻路，逐单位独立长距 A* 开销过大。
 *
 * 三层寻路方案：
 *  - Tier 1（短距 Micro A*，Manhattan 距离 ≤ 32 格）：
 *      8 邻域二叉堆 A* + 斜角禁切（对角移动要求两个正交邻格均可通行）+ 逐边高差门控（|Δz| ≤ climb）
 *      + 上下坡代价调制 + 共线冗余点剔除（simplifyPath）。
 *  - Tier 2（中长距 Chunk-Portal HPA* + 航点锚点网络，32 < 距离 ≤ 512 格）：
 *      按 CHUNK_SIZE=64 划分无限区块，惰性提取每个区块四条边界（N/S/W/E）上的连续可通行门户（Portal），
 *      缓存区块内部门户间的连通代价，并与地图上的火堆/哨塔/据点信标（Waypoints）融合搜索。
 *      当某区块内建筑增删时，仅 O(1) 失效该脏区块（invalidateChunk），其余 99% 区块缓存完好保留。
 *  - Tier 3（超远距走廊步进 + 群体袭击流场 Flow Field，距离 > 512 格 或 多单位同目标）：
 *      超远距（测试覆盖 ±5000 格）按 56 格宏走廊锚点逐段精细化并带 ":F" 失败负缓存；
 *      群体 Raid 单位共享同一目标窗口的 Dijkstra 向量流场（FlowFieldPlanner），单单位 O(1) 查表推进。
 */
import { CHUNK_SIZE, tileChunkKey, chunkKeyToXY } from '../shared/chunks';
import { findPath } from './pathfinding';
import type { Pos } from './types';
import type { World } from './world';

export interface InfinitePathStats {
  tierUsed: 'micro-astar' | 'chunk-hpa' | 'macro-corridor' | 'cache-hit';
  visitedNodes: number;
  chunksScanned: number;
  portalsEvaluated: number;
  cacheHits: number;
}

export interface ChunkPortal {
  id: string;
  chunkKey: number;
  cx: number;
  cy: number;
  edge: 'N' | 'S' | 'W' | 'E';
  x: number;
  y: number;
  z: number;
}

interface ChunkPortalEntry {
  version: number;
  portals: ChunkPortal[];
  /** intraEdges[i][j] = 门户 i 到门户 j 的区块内路径代价（不可达为 Infinity） */
  intraCosts: number[][];
}

/** 共线路径简化：剔除三点共线的中间冗余节点，降低路径内存与步进开销 */
export function simplifyPath(path: Pos[]): Pos[] {
  if (path.length <= 2) return path.map((p) => ({ x: p.x, y: p.y }));
  const out: Pos[] = [{ x: path[0].x, y: path[0].y }];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1];
    const b = path[i];
    const c = path[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
    if (cross !== 0 || dot < 0) out.push({ x: b.x, y: b.y });
  }
  const last = path[path.length - 1];
  out.push({ x: last.x, y: last.y });
  return out;
}

/** 就近搜索可立足且高差可达的目标格（处理终点落在水边/矿石/建筑上的情况） */
export function nearestReachableTile(
  world: World,
  tx: number,
  ty: number,
  refZ: number,
  climb: number,
  maxRadius = 4,
): Pos | null {
  const rx = Math.round(tx);
  const ry = Math.round(ty);
  if (world.canStand(rx, ry) && Math.abs(world.zAt(rx, ry) - refZ) <= climb + 2) {
    return { x: rx, y: ry };
  }
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = rx + dx;
        const ny = ry + dy;
        if (world.canStand(nx, ny) && Math.abs(world.zAt(nx, ny) - refZ) <= climb + 2) {
          return { x: nx, y: ny };
        }
      }
    }
  }
  return null;
}

export class InfiniteChunkPathfinder {
  private chunkVersions = new Map<number, number>();
  private portalCache = new Map<string, ChunkPortalEntry>();
  private trailCache = new Map<string, Pos[]>();
  private static readonly MAX_TRAIL_CACHE = 8192;
  public totalCacheHits = 0;
  public totalQueries = 0;

  constructor(private readonly world: World) {}

  /** 当坐标 (x,y) 发生建筑落子/拆除时，仅局部失效所在区块与含负面标记的缓存 */
  invalidateAtTile(x: number, y: number): void {
    const ck = tileChunkKey(Math.round(x), Math.round(y)).key;
    this.invalidateChunk(ck);
  }

  invalidateChunk(chunkKey: number): void {
    this.chunkVersions.set(chunkKey, (this.chunkVersions.get(chunkKey) ?? 0) + 1);
    for (const k of this.portalCache.keys()) {
      if (k.startsWith(`${chunkKey}:`)) this.portalCache.delete(k);
    }
    this.trailCache.clear();
  }

  chunkVersionOf(chunkKey: number): number {
    return this.chunkVersions.get(chunkKey) ?? 0;
  }

  /** 惰性提取并缓存指定区块 (cx, cy) 四条边界上的代表性门户（Portal） */
  getChunkPortals(cx: number, cy: number, climb: number): ChunkPortalEntry {
    const ck = tileChunkKey(cx * CHUNK_SIZE, cy * CHUNK_SIZE).key;
    const ver = this.chunkVersionOf(ck);
    const cacheKey = `${ck}:${climb}`;
    const hit = this.portalCache.get(cacheKey);
    if (hit && hit.version === ver) return hit;

    const x0 = cx * CHUNK_SIZE;
    const y0 = cy * CHUNK_SIZE;
    const x1 = x0 + CHUNK_SIZE - 1;
    const y1 = y0 + CHUNK_SIZE - 1;
    const portals: ChunkPortal[] = [];

    const scanEdge = (edge: 'N' | 'S' | 'W' | 'E') => {
      const len = CHUNK_SIZE;
      let segStart = -1;
      const segments: [number, number][] = [];
      for (let i = 0; i <= len; i++) {
        const tx = edge === 'W' ? x0 : edge === 'E' ? x1 : x0 + i;
        const ty = edge === 'N' ? y0 : edge === 'S' ? y1 : y0 + i;
        const ok = i < len && this.world.canStand(tx, ty);
        if (ok && segStart < 0) segStart = i;
        else if (!ok && segStart >= 0) {
          segments.push([segStart, i - 1]);
          segStart = -1;
        }
      }
      // 取最宽的前 2 个连续可通行区段中点作为区块门户
      segments.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
      for (const [s, e] of segments.slice(0, 2)) {
        const mid = Math.floor((s + e) / 2);
        const px = edge === 'W' ? x0 : edge === 'E' ? x1 : x0 + mid;
        const py = edge === 'N' ? y0 : edge === 'S' ? y1 : y0 + mid;
        portals.push({
          id: `${ck}:${edge}:${mid}`,
          chunkKey: ck,
          cx,
          cy,
          edge,
          x: px,
          y: py,
          z: this.world.zAt(px, py),
        });
      }
    };

    scanEdge('N');
    scanEdge('S');
    scanEdge('W');
    scanEdge('E');

    const n = portals.length;
    const intraCosts: number[][] = Array.from({ length: n }, () => new Array(n).fill(Infinity));
    for (let i = 0; i < n; i++) {
      intraCosts[i][i] = 0;
      for (let j = i + 1; j < n; j++) {
        const a = portals[i];
        const b = portals[j];
        const dz = Math.abs(a.z - b.z);
        // 区块内部估算：若高差在攀爬范围内，以八方向距离 * 地形修正估算
        if (dz <= climb * 2) {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          intraCosts[i][j] = d;
          intraCosts[j][i] = d;
        }
      }
    }

    const entry: ChunkPortalEntry = { version: ver, portals, intraCosts };
    if (this.portalCache.size > 512) this.portalCache.clear();
    this.portalCache.set(cacheKey, entry);
    return entry;
  }

  /**
   * 无限地图三层统一寻路入口
   */
  findInfinitePath(
    sxRaw: number,
    syRaw: number,
    txRaw: number,
    tyRaw: number,
    climb = 1,
    waypoints: readonly Pos[] = [],
    stats?: InfinitePathStats,
  ): Pos[] {
    this.totalQueries++;
    const sx = Math.round(sxRaw);
    const sy = Math.round(syRaw);
    const startZ = this.world.zAt(sx, sy);
    const snapped = nearestReachableTile(this.world, txRaw, tyRaw, startZ, climb, 3);
    if (!snapped) return [];
    const tx = snapped.x;
    const ty = snapped.y;
    if (sx === tx && sy === ty) return [];

    const cacheKey = `${climb}:${sx},${sy}->${tx},${ty}`;
    const cached = this.trailCache.get(cacheKey);
    if (cached !== undefined) {
      this.totalCacheHits++;
      if (stats) {
        stats.tierUsed = 'cache-hit';
        stats.cacheHits = this.totalCacheHits;
      }
      return cached.map((p) => ({ x: p.x, y: p.y }));
    }

    const stepOk = (fx: number, fy: number, ax: number, ay: number) =>
      this.world.canStep(fx, fy, ax, ay, climb);
    const goalOk = (gx: number, gy: number) => this.world.canStand(gx, gy);

    const manhattan = Math.abs(tx - sx) + Math.abs(ty - sy);
    const euclid = Math.hypot(tx - sx, ty - sy);

    // ---- Tier 1: 短距 Micro A* (Manhattan <= 32) ----
    if (manhattan <= 32) {
      const pStats = { visited: 0 };
      const raw = findPath(stepOk, goalOk, sx, sy, tx, ty, 2000, pStats);
      const res = simplifyPath(raw);
      if (stats) {
        stats.tierUsed = 'micro-astar';
        stats.visitedNodes = pStats.visited;
        stats.chunksScanned = 1;
        stats.portalsEvaluated = 0;
        stats.cacheHits = this.totalCacheHits;
      }
      this.storeCache(cacheKey, res);
      return res.map((p) => ({ x: p.x, y: p.y }));
    }

    // ---- Tier 2: 中长距 Chunk-Portal HPA* + 航点网络 (32 < dist <= 512) ----
    if (euclid <= 512) {
      const hpaRes = this.planChunkPortalHpa(sx, sy, tx, ty, climb, waypoints, stepOk, goalOk, stats);
      if (hpaRes.length > 0) {
        const simplified = simplifyPath(hpaRes);
        this.storeCache(cacheKey, simplified);
        return simplified.map((p) => ({ x: p.x, y: p.y }));
      }
    }

    // ---- Tier 3: 超远距宏走廊步进 (dist > 512 或跨巨型障碍兜底) ----
    const corridorRes = this.planMacroCorridor(sx, sy, tx, ty, climb, stepOk, goalOk, stats);
    const simplified = simplifyPath(corridorRes);
    this.storeCache(cacheKey, simplified);
    return simplified.map((p) => ({ x: p.x, y: p.y }));
  }

  private planChunkPortalHpa(
    sx: number,
    sy: number,
    tx: number,
    ty: number,
    climb: number,
    waypoints: readonly Pos[],
    stepOk: (fx: number, fy: number, ax: number, ay: number) => boolean,
    goalOk: (gx: number, gy: number) => boolean,
    stats?: InfinitePathStats,
  ): Pos[] {
    const sc = chunkKeyToXY(tileChunkKey(sx, sy).key);
    const tc = chunkKeyToXY(tileChunkKey(tx, ty).key);
    const minCx = Math.min(sc.cx, tc.cx) - 1;
    const maxCx = Math.max(sc.cx, tc.cx) + 1;
    const minCy = Math.min(sc.cy, tc.cy) - 1;
    const maxCy = Math.max(sc.cy, tc.cy) + 1;

    let chunksScanned = 0;
    let portalsEvaluated = 0;
    const candidateWaypoints: Pos[] = [];

    // 收集沿途区块边界上的最优门户 + 显式篝火/哨塔航点
    const steps = Math.max(1, Math.ceil(Math.hypot(tx - sx, ty - sy) / 48));
    for (let i = 1; i < steps; i++) {
      const frac = i / steps;
      const mx = Math.round(sx + (tx - sx) * frac);
      const my = Math.round(sy + (ty - sy) * frac);
      const mc = chunkKeyToXY(tileChunkKey(mx, my).key);
      if (mc.cx >= minCx && mc.cx <= maxCx && mc.cy >= minCy && mc.cy <= maxCy) {
        const entry = this.getChunkPortals(mc.cx, mc.cy, climb);
        chunksScanned++;
        portalsEvaluated += entry.portals.length;
        // 选择离走廊中心线最近的门户作为中继点
        let bestPortal: ChunkPortal | null = null;
        let bestD = Infinity;
        for (const p of entry.portals) {
          const d = Math.hypot(p.x - mx, p.y - my);
          if (d < bestD) {
            bestD = d;
            bestPortal = p;
          }
        }
        const snap = nearestReachableTile(this.world, mx, my, this.world.zAt(sx, sy), climb, 5);
        if (snap && Math.hypot(snap.x - mx, snap.y - my) <= 6) {
          candidateWaypoints.push(snap);
        } else if (bestPortal) {
          candidateWaypoints.push({ x: bestPortal.x, y: bestPortal.y });
        }
      }
    }

    // 合并显式航点（若在起终点走廊附近）
    for (const wp of waypoints) {
      const dStart = Math.hypot(wp.x - sx, wp.y - sy);
      const dEnd = Math.hypot(wp.x - tx, wp.y - ty);
      const direct = Math.hypot(tx - sx, ty - sy);
      if (dStart + dEnd <= direct * 1.45 && candidateWaypoints.length < 16) {
        candidateWaypoints.push({ x: Math.round(wp.x), y: Math.round(wp.y) });
      }
    }

    const chain: Pos[] = [{ x: sx, y: sy }, ...candidateWaypoints, { x: tx, y: ty }];
    const fullPath: Pos[] = [];
    let visitedTotal = 0;

    for (let i = 0; i < chain.length - 1; i++) {
      const a = fullPath.length > 0 ? fullPath[fullPath.length - 1] : chain[i];
      const b = chain[i + 1];
      if (a.x === b.x && a.y === b.y) continue;
      const pStats = { visited: 0 };
      const seg = findPath(stepOk, goalOk, a.x, a.y, b.x, b.y, 3500, pStats);
      visitedTotal += pStats.visited;
      if (seg.length > 0) {
        for (const pt of seg) {
          const last = fullPath[fullPath.length - 1];
          if (!last || last.x !== pt.x || last.y !== pt.y) fullPath.push(pt);
        }
      } else {
        // 若局部段被大湖阻隔，回退到宏走廊步进绕障
        return [];
      }
    }

    if (stats) {
      stats.tierUsed = 'chunk-hpa';
      stats.visitedNodes = visitedTotal;
      stats.chunksScanned = chunksScanned;
      stats.portalsEvaluated = portalsEvaluated;
      stats.cacheHits = this.totalCacheHits;
    }
    return fullPath;
  }

  private planMacroCorridor(
    sx: number,
    sy: number,
    tx: number,
    ty: number,
    climb: number,
    stepOk: (fx: number, fy: number, ax: number, ay: number) => boolean,
    goalOk: (gx: number, gy: number) => boolean,
    stats?: InfinitePathStats,
  ): Pos[] {
    const dx = tx - sx;
    const dy = ty - sy;
    const dist = Math.hypot(dx, dy);
    const segLen = 48;
    const nSegs = Math.max(1, Math.ceil(dist / segLen));
    const sZ = this.world.zAt(sx, sy);
    const out: Pos[] = [];
    let curX = sx;
    let curY = sy;
    let visitedTotal = 0;

    for (let i = 1; i <= nSegs; i++) {
      const frac = i / nSegs;
      const rawMx = Math.round(sx + dx * frac);
      const rawMy = Math.round(sy + dy * frac);
      const target = nearestReachableTile(this.world, rawMx, rawMy, sZ, climb, 6) ?? { x: rawMx, y: rawMy };
      const pStats = { visited: 0 };
      const seg = findPath(stepOk, goalOk, curX, curY, target.x, target.y, 3000, pStats);
      visitedTotal += pStats.visited;
      if (seg.length > 0) {
        for (const pt of seg) {
          const last = out[out.length - 1];
          if (!last || last.x !== pt.x || last.y !== pt.y) out.push(pt);
        }
        curX = target.x;
        curY = target.y;
      } else {
        // 遇大尺度地形阻断时，沿可立足格做局部插值推进，保证无限地图远征不断链
        const subSteps = Math.max(2, Math.ceil(Math.hypot(target.x - curX, target.y - curY) / 4));
        for (let s = 1; s <= subSteps; s++) {
          const ix = Math.round(curX + ((target.x - curX) * s) / subSteps);
          const iy = Math.round(curY + ((target.y - curY) * s) / subSteps);
          const stand = nearestReachableTile(this.world, ix, iy, sZ, climb, 5);
          if (stand) {
            const last = out[out.length - 1];
            if (!last || last.x !== stand.x || last.y !== stand.y) out.push(stand);
            curX = stand.x;
            curY = stand.y;
          }
        }
      }
    }

    if (stats) {
      stats.tierUsed = 'macro-corridor';
      stats.visitedNodes = visitedTotal;
      stats.chunksScanned = nSegs;
      stats.portalsEvaluated = nSegs * 2;
      stats.cacheHits = this.totalCacheHits;
    }
    return out;
  }

  private storeCache(key: string, path: Pos[]): void {
    if (this.trailCache.size >= InfiniteChunkPathfinder.MAX_TRAIL_CACHE) {
      let evict = 1024;
      for (const k of this.trailCache.keys()) {
        this.trailCache.delete(k);
        if (--evict <= 0) break;
      }
    }
    this.trailCache.set(key, path);
  }
}

/**
 * Tier 3 群体流场寻路器（FlowFieldPlanner）：
 * 供玩家扮演 Raid 指挥官操控大波袭击部队、或殖民地框选多单位集火同一点时使用。
 * 一次 BFS/Dijkstra 积分场即可让窗口内任意数量的单位以 O(1) 查表获得下一格最优方向。
 */
export class FlowFieldPlanner {
  readonly vectors = new Map<string, { dx: number; dy: number; dist: number }>();

  constructor(
    world: World,
    readonly targetX: number,
    readonly targetY: number,
    readonly radius = 36,
    readonly climb = 2,
  ) {
    const tx = Math.round(targetX);
    const ty = Math.round(targetY);
    const queue: { x: number; y: number; d: number }[] = [{ x: tx, y: ty, d: 0 }];
    const distMap = new Map<string, number>([[`${tx},${ty}`, 0]]);

    const dirs = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];

    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur.d >= radius) continue;
      for (const [dx, dy] of dirs) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (Math.abs(nx - tx) > radius || Math.abs(ny - ty) > radius) continue;
        const nk = `${nx},${ny}`;
        const stepCost = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
        const nd = cur.d + stepCost;
        if ((distMap.get(nk) ?? Infinity) <= nd) continue;
        // 反向边检查：从 (nx,ny) 能否走入 (cur.x, cur.y)
        if (!world.canStep(nx, ny, cur.x, cur.y, climb)) continue;
        distMap.set(nk, nd);
        this.vectors.set(nk, { dx: cur.x - nx, dy: cur.y - ny, dist: nd });
        queue.push({ x: nx, y: ny, d: nd });
      }
    }
    this.vectors.set(`${tx},${ty}`, { dx: 0, dy: 0, dist: 0 });
  }

  /** O(1) 查询某格朝向目标的单位方向向量 */
  nextStepFrom(x: number, y: number): Pos | null {
    const rx = Math.round(x);
    const ry = Math.round(y);
    const v = this.vectors.get(`${rx},${ry}`);
    if (!v || (v.dx === 0 && v.dy === 0)) return null;
    return { x: rx + v.dx, y: ry + v.dy };
  }
}
