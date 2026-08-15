// A* 寻路 —— 图块网格，P0 简单实现（无优化，后续可加 JPS/分块）
// （迭代优化：open 表已从线性数组升为二叉堆 MinHeap、加篝火航点中转/迭代上限双档/段缓存，见下文）
// 数据驱动：策略参数（迭代上限/暗区代价/启发式）进表（tuning.path），算法本体保留代码
import { World, type TileId } from './world';
import type { HeuristicId } from '../defs/tuning';

// 启发式策略表（寻路策略数据化：换启发式 = 改表，不碰算法）
const HEURISTICS: Record<HeuristicId, (dx: number, dy: number) => number> = {
  chebyshev: (dx, dy) => Math.max(dx, dy), // 对角移动可接受（默认）
  manhattan: (dx, dy) => dx + dy,           // 四方向网格
  euclidean: (dx, dy) => Math.hypot(dx, dy), // 直线距离
};

export interface PathConfig {
  maxIter?: number;     // 无篝火中转时的迭代上限（防爆）
  waypointMaxIter?: number; // 有篝火中转时放宽的上限
  maxWaypoints?: number;    // 参与中转的锚点数量上限
  waypointRadius?: number;  // 锚点中转范围上限
  waypoints?: boolean;      // 显式开关（缺省自动：有锚点即启用）
  darkCost?: number;   // 未照亮格代价倍率
  heuristic?: HeuristicId;
}

// 航点段缓存回调（sim 侧提供：锚点对路径缓存复用 trailCache）
export interface WaypointCache {
  get(ax: number, ay: number, bx: number, by: number): { x: number; y: number }[] | undefined;
  set(ax: number, ay: number, bx: number, by: number, path: { x: number; y: number }[]): void;
}

interface Node {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: Node | null;
  heapIdx: number; // 在二叉堆中的位置（用于减少键值下降）
}

// 最小二叉堆（按 f 值）：open 列表从数组线性扫最小值（O(n)）升级为 O(log n)，
// 192×192 世界最坏情况下寻路成本从 O(n²) 降到 O(n log n)
class MinHeap {
  private a: Node[] = [];

  get size(): number { return this.a.length; }

  push(n: Node): void {
    n.heapIdx = this.a.length;
    this.a.push(n);
    this.bubbleUp(n.heapIdx);
  }

  pop(): Node | null {
    if (this.a.length === 0) return null;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length > 0) {
      this.a[0] = last;
      last.heapIdx = 0;
      this.siftDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[i].f >= this.a[p].f) break;
      this.swap(i, p);
      i = p;
    }
  }

  private siftDown(i: number): void {
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < this.a.length && this.a[l].f < this.a[m].f) m = l;
      if (r < this.a.length && this.a[r].f < this.a[m].f) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }

  private swap(i: number, j: number): void {
    const t = this.a[i];
    this.a[i] = this.a[j];
    this.a[j] = t;
    this.a[i].heapIdx = i;
    this.a[j].heapIdx = j;
  }
}

// 锚点收集：tags 含 anchor 的建筑（篝火/教堂），按距起点距离排序取 cap 个
function collectAnchors(world: World, sx: number, sy: number, cfg: PathConfig | undefined): { x: number; y: number }[] {
  const cap = cfg?.maxWaypoints ?? 8;
  return [...world.buildings.entries()]
    .filter(([, b]) => b.def.tags?.includes('anchor'))
    .map(([k]) => World.keyToXY(k))
    .sort((a, b) => ((a.x - sx) ** 2 + (a.y - sy) ** 2) - ((b.x - sx) ** 2 + (b.y - sy) ** 2))
    .slice(0, cap);
}

function nearestAnchor(anchors: { x: number; y: number }[], x: number, y: number, radius: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = radius * radius;
  for (const a of anchors) {
    const d = (a.x - x) ** 2 + (a.y - y) ** 2;
    if (d <= bestD) { bestD = d; best = a; }
  }
  return best;
}

// 主入口：篝火航点寻路
//  - 起点/终点各自就近找锚点（上限 maxWaypoints 个、范围内 waypointRadius）
//  - 锚点对路径走段缓存（sim 侧 trailCache 复用，建筑变更自动失效）
//  - 迭代上限：无篝火 → maxIter（防爆）；有篝火 → waypointMaxIter（放宽）
//  - 任一段失败 → 回退直连（放宽 1.5 倍上限）
export function findPath(world: World, startX: number, startY: number, endX: number, endY: number, cfg?: PathConfig, wpCache?: WaypointCache, climb = Infinity): { x: number; y: number }[] {
  const anchors = collectAnchors(world, startX, startY, cfg);
  const hasWp = anchors.length > 0;
  const waypointsEnabled = cfg?.waypoints ?? hasWp;
  // 显式 maxIter = 策略钳制（数据驱动：传小值即钳制，任何路径都不能超过它）
  // 缺省：无篝火 → 小上限防爆；有篝火 → waypointMaxIter 放宽
  const explicitMax = cfg?.maxIter;
  const baseMaxIter = explicitMax ?? (hasWp ? cfg?.waypointMaxIter ?? 40000 : 15000);
  const wpMaxIter = explicitMax ?? cfg?.waypointMaxIter ?? Math.max(baseMaxIter, 40000);
  if (!waypointsEnabled || !hasWp) {
    return findPathRaw(world, startX, startY, endX, endY, baseMaxIter, cfg, climb);
  }
  const radius = cfg?.waypointRadius ?? 60;
  const wa = nearestAnchor(anchors, startX, startY, radius);
  const wb = nearestAnchor(anchors, endX, endY, radius);
  // 无范围内锚点 / 同锚点 → 直连（同域不需要中转）
  if (!wa || !wb || (wa.x === wb.x && wa.y === wb.y)) {
    return findPathRaw(world, startX, startY, endX, endY, wpMaxIter, cfg, climb);
  }
  // 段缓存（锚点对）：sim 侧 trailCache 复用；成功/失败都缓存——失败段（石丘/水隔断）
  // 每帧重算会跑满 maxIter（石丘地图实测 16x 退化）；失效由 sim 侧 clearTrailCache 统一管
  const segOf = (ax: number, ay: number, bx: number, by: number): { x: number; y: number }[] => {
    const cached = wpCache?.get(ax, ay, bx, by);
    if (cached) return cached;
    const p = findPathRaw(world, ax, ay, bx, by, wpMaxIter, cfg, climb);
    wpCache?.set(ax, ay, bx, by, p);
    return p;
  };
  const seg1 = findPathRaw(world, startX, startY, wa.x, wa.y, baseMaxIter, cfg, climb);
  const seg2 = segOf(wa.x, wa.y, wb.x, wb.y);
  const seg3 = findPathRaw(world, wb.x, wb.y, endX, endY, baseMaxIter, cfg, climb);
  if (seg1.length > 0 && seg2.length > 0 && seg3.length > 0) {
    // 合并（去重连接点）
    return [...seg1, ...seg2.slice(1), ...seg3.slice(1)];
  }
  // 任一段失败 → 直连重试（显式 maxIter 尊重钳制；默认才放宽）
  return findPathRaw(world, startX, startY, endX, endY, explicitMax !== undefined ? explicitMax : Math.max(wpMaxIter, Math.floor(baseMaxIter * 1.5)), cfg, climb);
}

function findPathRaw(world: World, startX: number, startY: number, endX: number, endY: number, maxIter: number, cfg?: PathConfig, climb = Infinity): { x: number; y: number }[] {
  const darkCost = cfg?.darkCost ?? 3;
  const h = HEURISTICS[cfg?.heuristic ?? 'chebyshev'];
  if (!world.inBounds(endX, endY)) return [];
  const zOf = (x: number, y: number) => world.getTileDef(x, y).z ?? 0;
  // 终点不可走（如站在建筑上），找最近可走格；z 感知（高差地图）：
  // 终点与起点 z 差 > climb（石丘顶上的目标）→ 目标落到起点可达的格，避免 A* 满跑失败
  const sZ = zOf(startX, startY);
  const target = world.isPassable(endX, endY, sZ, climb) ? { x: endX, y: endY } : nearestPassable(world, endX, endY, sZ, climb);
  if (!target) return [];
  const open = new MinHeap();
  const closed = new Set<string>();
  const start: Node = { x: startX, y: startY, g: 0, h: h(Math.abs(startX - target.x), Math.abs(startY - target.y)), f: 0, parent: null, heapIdx: -1 };
  start.f = start.g + start.h;
  open.push(start);

  const key = (x: number, y: number) => `${x},${y}`;
  const cost = new Map<string, number>();
  cost.set(key(startX, startY), 0);

  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  let iterations = 0;

  while (open.size > 0 && iterations++ < maxIter) {
    const current = open.pop()!;
    const ck = key(current.x, current.y);
    // 跳过过期节点：堆里保留 cost 更新前的旧拷贝（stale），反复 pop 会浪费迭代
    // 在重复展开上，有效探索远少于 maxIter——碎片化地图（2026-08-14 稀疏化 hash 后
    // 树墙/石丘分割）实测 60000 迭代仍返回空路径。closed 或 cost 已更优 → 直接丢弃
    if (closed.has(ck)) continue;
    const bestG = cost.get(ck);
    if (bestG !== undefined && current.g > bestG) continue;

    if (current.x === target.x && current.y === target.y) {
      return reconstruct(current);
    }

    closed.add(ck);

    // 地道入口（另一维度，用户 2026-08-14）：入口间虚拟边直连——地下隧道不经过地表，
    // 无视地形可走性/高差/建筑；成本 = 直线距离（速度无加成，快在路线直）
    const curB = world.getBuilding(current.x, current.y);
    if (curB && curB.def.tags?.includes('tunnel')) {
      const entries = collectTunnelEntries(world);
      for (const en of entries) {
        if (en.x === current.x && en.y === current.y) continue;
        if (closed.has(key(en.x, en.y))) continue;
        const d = Math.hypot(en.x - current.x, en.y - current.y);
        const g = current.g + d;
        const existing = cost.get(key(en.x, en.y));
        if (existing !== undefined && existing <= g) continue;
        cost.set(key(en.x, en.y), g);
        const hh = h(Math.abs(en.x - target.x), Math.abs(en.y - target.y));
        const n: Node = {
          x: en.x, y: en.y,
          g,
          h: hh,
          f: g + hh,
          parent: current,
          heapIdx: -1,
        };
        open.push(n);
      }
    }

    const curZ = zOf(current.x, current.y);
    for (const [dx, dy] of dirs) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      // 高差判定：|Δz| > 单位通过能力(climb) → 无法上下（用户设计：地形有 z 值）
      if (!world.isPassable(nx, ny, curZ, climb)) continue;
      if (closed.has(key(nx, ny))) continue;

      const diag = dx !== 0 && dy !== 0;
      const moveCost = diag ? 1.414 : 1;
      const tileCost = world.getTileDef(nx, ny).moveCost ?? 1;
      // 黑暗区高代价权重：尽量走篝火照亮的路
      const lightCost = world.isLit(nx, ny) ? 1 : darkCost;
      const g = current.g + moveCost * tileCost * lightCost;

      const existing = cost.get(key(nx, ny));
      if (existing !== undefined && existing <= g) continue;

      cost.set(key(nx, ny), g);
      const hh = h(Math.abs(nx - target.x), Math.abs(ny - target.y));
      const n: Node = {
        x: nx, y: ny,
        g,
        h: hh,
        f: g + hh,
        parent: current,
        heapIdx: -1,
      };
      open.push(n);
    }
  }
  return [];
}

// 地道入口收集（另一维度）：遍历建筑表找 tunnel 标记的建筑 mainKey 坐标。
// 入口数量小（玩家手动挖），直接遍历；虚拟边在 A* 内展开
function collectTunnelEntries(world: World): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const [k, b] of world.buildings) {
    if (!b.def.tags?.includes('tunnel')) continue;
    out.push(World.keyToXY(k));
  }
  return out;
}

function reconstruct(node: Node): { x: number; y: number }[] {
  const path: { x: number; y: number }[] = [];
  let cur: Node | null = node;
  while (cur) {
    path.unshift({ x: cur.x, y: cur.y });
    cur = cur.parent;
  }
  return path;
}

// 终点不可走（如站在建筑上）→ 就近搜可走格：半径固定 3（常量），
// 只处理"终点被占一格"的局部情况，代价可控；3 格内全不可走则放弃
// 2026-08-14 z 感知：fromZ/climb 参与判定（目标须从起点可达——石丘顶目标落到可攀格）
function nearestPassable(world: World, x: number, y: number, fromZ: number, climb: number): { x: number; y: number } | null {
  for (let r = 1; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (world.isPassable(nx, ny, fromZ, climb)) return { x: nx, y: ny };
      }
    }
  }
  return null;
}
