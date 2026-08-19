// A* 寻路 —— 图块网格，P0 简单实现（无优化，后续可加 JPS/分块）
// （迭代优化：open 表已从线性数组升为二叉堆 MinHeap、加篝火航点中转/迭代上限双档/段缓存，见下文）
// 2026-08-16 架构优化：A* 内部 key/closed/cost 从字符串 `${x},${y}` 改为数字
// `x * 65536 + y`（避免每节点 ×8 邻居 = 8 次字符串分配 + GC 压力，Map<number> 比
// Map<string> 快约 2-3 倍）；reconstruct 后做路径简化（去直线冗余中间点，减缓存体积）。
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
// 锚点缓存（2026-08-16 性能优化：原每次 findPath 遍历全建筑表 filter+map+sort+slice，
// 40 pawn × 多次寻路 = 大量重复。锚点在建筑存活期间不变 → 按 buildingVersion 缓存）
// 注意：必须按 World 实例缓存（WeakMap），不能用模块级单例——多个 Sim/World 的
// buildingVersion 可能相同但建筑集合不同，全局缓存会串世界（测试/多开污染）。
const _anchorCacheByWorld = new WeakMap<World, { version: number; anchors: { x: number; y: number }[] }>();

function collectAnchors(world: World, sx: number, sy: number, cfg: PathConfig | undefined): { x: number; y: number }[] {
  // 版本检查：buildingVersion 变了才重建缓存
  let entry = _anchorCacheByWorld.get(world);
  if (!entry || entry.version !== world.buildingVersion) {
    entry = {
      version: world.buildingVersion,
      anchors: [...world.buildings.entries()]
        .filter(([, b]) => b.def.tags?.includes('anchor'))
        .map(([k]) => World.keyToXY(k)),
    };
    _anchorCacheByWorld.set(world, entry);
  }
  const cap = cfg?.maxWaypoints ?? 8;
  return entry.anchors
    .map((a) => ({ ...a, d: (a.x - sx) ** 2 + (a.y - sy) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, cap)
    .map(({ x, y }) => ({ x, y }));
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
  // 短距离优化（2026-08-16）：起终点 < 32 格直连 A*，不走航点中转——短距离 A*
  // 搜索范围小（64×64 内），航点查找/段缓存/合并开销 > 收益。maxIter 钳到 2000 防爆。
  const distSq = (startX - endX) * (startX - endX) + (startY - endY) * (startY - endY);
  if (distSq <= 32 * 32) {
    const shortMax = Math.min(cfg?.maxIter ?? 2000, 2000);
    return findPathRaw(world, startX, startY, endX, endY, shortMax, cfg, climb);
  }
  // 远距离分段寻路（2026-08-16 HPA* 简化版：无限世界支持）：
  // A* 在远距离（跨多 chunk）maxIter 不够绕行 → 返回空。改为沿直线方向分段：
  // 每 56 格（< chunk 64 宽）做一次短距离 A*（maxIter 8000 够搜），拼接所有段。
  // 某段失败 → 该段回退直线（目标格直接放路径，walk 推进时遇障停下 → 下次决策重试）。
  // 注意：显式 maxIter 钳制时不走分段（测试用小 maxIter 验证"远路返回空"语义）
  const dist = Math.sqrt(distSq);
  const explicitMax = cfg?.maxIter;
  if (dist > 128 && explicitMax === undefined) {
    return findPathSegmented(world, startX, startY, endX, endY, cfg, wpCache, climb);
  }
  const anchors = collectAnchors(world, startX, startY, cfg);
  const hasWp = anchors.length > 0;
  const waypointsEnabled = cfg?.waypoints ?? hasWp;
  // 显式 maxIter = 策略钳制（数据驱动：传小值即钳制，任何路径都不能超过它）
  // 缺省：无篝火 → 小上限防爆；有篝火 → waypointMaxIter 放宽
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
  const closed = new Set<number>();
  const start: Node = { x: startX, y: startY, g: 0, h: h(Math.abs(startX - target.x), Math.abs(startY - target.y)), f: 0, parent: null, heapIdx: -1 };
  start.f = start.g + start.h;
  open.push(start);

  // 数字 key（2026-08-16 架构优化）：避免每节点 8 次字符串分配 + GC；x,y < 2^16 → key = x*65536+y
  const key = (x: number, y: number) => x * 65536 + y;
  const cost = new Map<number, number>();
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
      return simplifyPath(reconstruct(current));
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

// 路径简化（2026-08-16 架构优化）：去直线冗余中间点——三点共线时删中间点。
// 减缓存体积（value 数组更短 → Map 更小）+ 减少 walk 每帧 pathIndex 遍历量。
function simplifyPath(path: { x: number; y: number }[]): { x: number; y: number }[] {
  if (path.length <= 2) return path;
  const out: { x: number; y: number }[] = [path[0]!];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = path[i]!;
    const c = path[i + 1]!;
    // 叉积 = 0 → 三点共线 → b 是冗余中间点，跳过
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (cross !== 0) out.push(b);
  }
  out.push(path[path.length - 1]!);
  return out;
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

// 分段寻路（2026-08-16 HPA* 简化版：无限世界远距离支持）
// 背景：A* 在远距离（>128 格跨多 chunk）下 maxIter 不够绕行大片水/山 → 返回空。
// 方案：沿起→终直线方向，每隔 56 格（< chunk 64 宽）设一个中间点，每段做短距离
// A*（maxIter 8000 够搜 56×56 = 3136 格），拼接所有段。某段失败 → 该段回退直线
// （中间点直接放路径，walk 推进时遇障停下 → 下帧决策重试）。不保证最优但保证"能动"。
function findPathSegmented(
  world: World, sx: number, sy: number, ex: number, ey: number,
  cfg: PathConfig | undefined, wpCache: WaypointCache | undefined, climb: number,
): { x: number; y: number }[] {
  const dx = ex - sx, dy = ey - sy;
  const dist = Math.hypot(dx, dy);
  const segLen = 56; // 每段长度（< chunk 64 宽，保证 A* 搜索范围可控）
  const nSegs = Math.ceil(dist / segLen);
  const segMaxIter = Math.min(cfg?.maxIter ?? 8000, 8000);
  const sZ = world.getTileDef(sx, sy).z ?? 0;
  const result: { x: number; y: number }[] = [{ x: sx, y: sy }];

  for (let i = 1; i <= nSegs; i++) {
    const frac = i / nSegs;
    const mx = Math.round(sx + dx * frac);
    const my = Math.round(sy + dy * frac);
    const prevX = result[result.length - 1]!.x;
    const prevY = result[result.length - 1]!.y;

    // 段终点必须可走；不可走则就近找可走格
    let tx = mx, ty = my;
    if (!world.isPassable(tx, ty, sZ, climb)) {
      const np = nearestPassable(world, mx, my, sZ, climb);
      if (np) { tx = np.x; ty = np.y; }
      else continue; // 跳过该段（直线回退时 walk 会原地停）
    }

    // 段 A*（短距离，maxIter 够搜）
    const segPath = findPathRaw(world, prevX, prevY, tx, ty, segMaxIter, cfg, climb);
    if (segPath.length > 0) {
      // 拼接（去重连接点：segPath[0] == result 末尾）
      result.push(...segPath.slice(1));
    } else {
      // 段 A* 失败 → 直线回退（放目标格，walk 推进遇障停 → 下帧重试）
      result.push({ x: tx, y: ty });
    }
  }

  // 确保终点在结果末尾
  const last = result[result.length - 1]!;
  if (last.x !== ex || last.y !== ey) {
    // 最终段到终点
    const finalPath = findPathRaw(world, last.x, last.y, ex, ey, segMaxIter, cfg, climb);
    if (finalPath.length > 0) result.push(...finalPath.slice(1));
    else result.push({ x: ex, y: ey });
  }

  return simplifyPath(result.length > 1 ? result : []);
}
