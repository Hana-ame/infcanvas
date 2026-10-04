/**
 * pathfinding.ts —— A* 寻路（8 邻域 + 二叉堆 + 双档迭代上限 + 斜角禁切）。
 *
 * 技术规格对应：A* 二叉堆 ✓、迭代上限双档 ✓（近距离低上限快速失败，远距离高上限）。
 * 篝火航点中转（锚点对段缓存）是超远距离优化，阶段①②的感知半径 ≤ 24 格用不到，
 * 刻意不做——留待联机/大地图阶段按 profile 数据决定。
 *
 * 两条铁律（都是真实踩坑换来的）：
 *  1. **整数格契约**：起点/终点必须先 Math.round 再进来。小人坐标是连续的
 *     （moveStep 在格心之间插值），浮点 key 进 A* 会解码错位甚至整条返回空路径
 *     ——曾导致半路重规划全部静默失败（逃跑卡形同虚设）。
 *  2. **斜角禁切**：对角移动要求两个正交邻格都可通行，否则会从两面墙的夹缝挤过去。
 */
import type { Pos } from './types';

/** 二叉堆（最小堆，按 f 值）。手写而非数组排序：A* 每步都要 O(log n) 取最小 */
class MinHeap {
  private items: { f: number; i: number }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(f: number, i: number): void {
    const a = this.items;
    a.push({ f, i });
    let c = a.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (a[p].f <= a[c].f) break;
      [a[p], a[c]] = [a[c], a[p]];
      c = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0].i;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === p) break;
        [a[p], a[m]] = [a[m], a[p]];
        p = m;
      }
    }
    return top;
  }
}

/** 实现版本哨兵：测试用它确认运行的是含斜角禁切/z 门控的新实现（缓存陈旧防呆） */
export const PATHFINDER_VERSION = 2;

export interface PathStats {
  visited: number; // 展开节点数（测试/性能观测用）
}

/** 数字 key 编码：x,y 各限 ±32767（无限地图防御边界，超出直接判不可达）。
 *  只接受整数——见文件头铁律 1。 */
function key(x: number, y: number): number {
  return (x + 32768) * 65536 + (y + 32768);
}

// 8 邻域（固定顺序 = 确定性平局展开）；dx/dy 同非零为对角
const DIRS: readonly { dx: number; dy: number; cost: number }[] = [
  { dx: 1, dy: 0, cost: 1 },
  { dx: -1, dy: 0, cost: 1 },
  { dx: 0, dy: 1, cost: 1 },
  { dx: 0, dy: -1, cost: 1 },
  { dx: 1, dy: 1, cost: Math.SQRT2 },
  { dx: 1, dy: -1, cost: Math.SQRT2 },
  { dx: -1, dy: 1, cost: Math.SQRT2 },
  { dx: -1, dy: -1, cost: Math.SQRT2 },
];

/**
 * A* 搜索。stepOk(fromX,fromY,toX,toY) 由调用方注入——**按边判定**而非按格：
 * z 高度模型下"能不能上"取决于出发格与目标格的高差和单位攀爬，格子本身不再有
 * 二元的可通行属性。goalOk(x,y) 单独判终点可立足。内核不依赖 World 类型。
 * 返回路径不含起点；不可达/超预算返回 []。
 */
export function findPath(
  stepOk: (fx: number, fy: number, tx: number, ty: number) => boolean,
  goalOk: (x: number, y: number) => boolean,
  sxRaw: number,
  syRaw: number,
  txRaw: number,
  tyRaw: number,
  maxIter: number,
  stats?: PathStats,
): Pos[] {
  // 整数量化（铁律 1）：调用方可能传连续坐标
  const sx = Math.round(sxRaw);
  const sy = Math.round(syRaw);
  const tx = Math.round(txRaw);
  const ty = Math.round(tyRaw);
  if (sx === tx && sy === ty) return [];
  if (!Number.isFinite(tx) || Math.abs(tx) > 30000 || Math.abs(ty) > 30000) return [];

  const startK = key(sx, sy);
  const goalK = key(tx, ty);
  if (!goalOk(tx, ty)) return []; // 终点不可立足（水/被占）→ 直接不可达

  const g = new Map<number, number>([[startK, 0]]);
  const from = new Map<number, number>();
  const open = new MinHeap();
  // 八距离启发（4 邻域曼哈顿的 对角版，可采纳不会高估）
  const h = (x: number, y: number): number => {
    const dxa = Math.abs(x - tx);
    const dya = Math.abs(y - ty);
    return Math.max(dxa, dya) + (Math.SQRT2 - 1) * Math.min(dxa, dya);
  };
  open.push(h(sx, sy), startK);
  let visited = 0;

  while (open.size > 0 && visited < maxIter) {
    const cur = open.pop();
    visited++;
    if (cur === goalK) {
      if (stats) stats.visited = visited;
      return reconstruct(from, cur);
    }
    const cx = Math.floor(cur / 65536) - 32768;
    const cy = (cur % 65536) - 32768;
    const gc = g.get(cur)!;
    for (const d of DIRS) {
      const ax = cx + d.dx;
      const ay = cy + d.dy;
      // 按边判定（z 高差/液体等）；斜角禁切（铁律 2）：两个正交邻格也必须可走
      if (!stepOk(cx, cy, ax, ay)) continue;
      if (d.dx !== 0 && d.dy !== 0 && !(stepOk(cx, cy, cx + d.dx, cy) && stepOk(cx, cy, cx, cy + d.dy))) continue;
      const nk = key(ax, ay);
      const ng = gc + d.cost;
      if ((g.get(nk) ?? Infinity) <= ng) continue;
      g.set(nk, ng);
      from.set(nk, cur);
      open.push(ng + h(ax, ay), nk);
    }
  }
  if (stats) stats.visited = visited;
  return []; // 不可达或预算耗尽
}

/** 回溯路径并去掉起点 */
function reconstruct(from: Map<number, number>, goalK: number): Pos[] {
  const out: Pos[] = [];
  let cur = goalK;
  while (from.has(cur)) {
    out.push({ x: Math.floor(cur / 65536) - 32768, y: (cur % 65536) - 32768 });
    cur = from.get(cur)!;
  }
  out.reverse();
  return out;
}

/**
 * 航点路由：直连失败（远距离预算不足/地形隔断）时，借"火堆锚点"分段拼接。
 *
 * 为什么是火堆：篝火=鼠群活动过、确认过安全的地面标记（设计出处：
 * 规格书「篝火航点中转（锚点对段缓存）」）。散布的火堆自然构成导航网络——
 * 新火堆落子即扩展可导航范围，与建造玩法天然组合。
 *
 * 策略：先试直连；失败则取"离起点最近的 ≤2 个锚点 × 离终点最近的 ≤2 个锚点"
 * 组成分段方案（每段独立 A*），全部段成功才返回整条路线；任何一段失败即放弃该组合。
 * cache 由调用方持有（建筑增删时清空），键为起终点量化坐标。
 */
export function planRoute(
  stepOk: (fx: number, fy: number, tx: number, ty: number) => boolean,
  goalOk: (x: number, y: number) => boolean,
  sxRaw: number,
  syRaw: number,
  txRaw: number,
  tyRaw: number,
  anchors: readonly Pos[],
  directMaxIter: number,
  segMaxIter: number,
  cache?: Map<string, Pos[] | null>,
): Pos[] {
  const sx = Math.round(sxRaw);
  const sy = Math.round(syRaw);
  const tx = Math.round(txRaw);
  const ty = Math.round(tyRaw);
  const ck = sx + ',' + sy + '->' + tx + ',' + ty;
  if (cache?.has(ck)) return cache.get(ck)! ?? [];

  // ① 直连
  const direct = findPath(stepOk, goalOk, sx, sy, tx, ty, directMaxIter);
  if (direct.length > 0) {
    cache?.set(ck, direct);
    return direct;
  }

  // ② 借锚点：按距离排序去重后各取最近 2 个，组成至多 4 种两段方案
  const byStart = [...anchors]
    .sort((a, b) => Math.hypot(a.x - sx, a.y - sy) - Math.hypot(b.x - sx, b.y - sy))
    .slice(0, 2);
  const byGoal = [...anchors]
    .sort((a, b) => Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty))
    .slice(0, 2);
  const seenPair = new Set<string>();
  const pairs: { a: Pos; b: Pos }[] = [];
  for (const a of byStart) {
    for (const b of byGoal) {
      const kk = Math.round(a.x) + ',' + Math.round(a.y) + '|' + Math.round(b.x) + ',' + Math.round(b.y);
      if (seenPair.has(kk)) continue;
      seenPair.add(kk);
      pairs.push({ a, b });
    }
  }

  for (const { a, b } of pairs) {
    const leg1 = findPath(stepOk, goalOk, sx, sy, a.x, a.y, segMaxIter);
    if (leg1.length === 0 && !(sx === a.x && sy === a.y)) continue;
    let mid: Pos[] = [];
    if (a.x !== b.x || a.y !== b.y) {
      mid = findPath(stepOk, goalOk, a.x, a.y, b.x, b.y, segMaxIter);
      if (mid.length === 0) continue;
    }
    const lastLegFrom = a.x === b.x && a.y === b.y ? a : b;
    const leg3 = findPath(stepOk, goalOk, lastLegFrom.x, lastLegFrom.y, tx, ty, segMaxIter);
    if (leg3.length === 0 && !(tx === lastLegFrom.x && ty === lastLegFrom.y)) continue;

    // 拼接并去掉相邻重复点
    const out: Pos[] = [];
    const push = (n: Pos): void => {
      const last = out[out.length - 1];
      if (!last || last.x !== n.x || last.y !== n.y) out.push(n);
    };
    for (const n of leg1) push(n);
    for (const n of mid) push(n);
    for (const n of leg3) push(n);
    if (out.length === 0) continue;
    cache?.set(ck, out);
    return out;
  }
  cache?.set(ck, null);
  return [];
}
