/**
 * pathfinding.ts —— A* 寻路（8 邻域 + 扁平数组二叉堆 + 正交邻格缓存复用 + 死胡同目标逆向快筛 + 斜角禁切）。
 */
import type { Pos } from './types';

/** 扁平数组二叉堆（零对象分配，按 f 值最小堆） */
class FlatMinHeap {
  private fs: number[] = [];
  private is: number[] = [];
  get size(): number {
    return this.fs.length;
  }
  clear(): void {
    this.fs.length = 0;
    this.is.length = 0;
  }
  push(f: number, i: number): void {
    const fs = this.fs;
    const is = this.is;
    let c = fs.length;
    fs.push(f);
    is.push(i);
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (fs[p] <= f) break;
      fs[c] = fs[p];
      is[c] = is[p];
      c = p;
    }
    fs[c] = f;
    is[c] = i;
  }
  pop(): number {
    const fs = this.fs;
    const is = this.is;
    const top = is[0];
    const lastF = fs.pop()!;
    const lastI = is.pop()!;
    const len = fs.length;
    if (len > 0) {
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        if (l >= len) break;
        const r = l + 1;
        let m = l;
        if (r < len && fs[r] < fs[l]) m = r;
        if (lastF <= fs[m]) break;
        fs[p] = fs[m];
        is[p] = is[m];
        p = m;
      }
      fs[p] = lastF;
      is[p] = lastI;
    }
    return top;
  }
}

export const PATHFINDER_VERSION = 2;

export interface PathStats {
  visited: number;
}

function key(x: number, y: number): number {
  return (x + 32768) * 65536 + (y + 32768);
}

const SQRT2 = Math.SQRT2;
const DIAG_EXTRA = SQRT2 - 1;

const sharedG = new Map<number, number>();
const sharedFrom = new Map<number, number>();
const sharedHeap = new FlatMinHeap();
let sharedInUse = false;

/**
 * 逆向死胡同孤岛快筛：当目标格 (tx, ty) 处于悬崖孤岛或四周封闭区域（逆向可达节点 < 24 且不含起点）时，
 * 仅用 <=24 步即可提前判定不可达，避免正向 A* 盲目展开 1500~8000 节点。
 */
function isGoalIsolatedPocket(
  stepOk: (fx: number, fy: number, tx: number, ty: number) => boolean,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): boolean {
  const startK = key(sx, sy);
  const goalK = key(tx, ty);
  const seen = new Set<number>([goalK]);
  const qx = [tx];
  const qy = [ty];
  let head = 0;
  const POCKET_LIMIT = 24;

  while (head < qx.length && qx.length < POCKET_LIMIT) {
    const cx = qx[head];
    const cy = qy[head];
    head++;

    const okE = stepOk(cx + 1, cy, cx, cy);
    const okW = stepOk(cx - 1, cy, cx, cy);
    const okS = stepOk(cx, cy + 1, cx, cy);
    const okN = stepOk(cx, cy - 1, cx, cy);

    if (okE) {
      const nk = key(cx + 1, cy);
      if (nk === startK) return false;
      if (!seen.has(nk)) { seen.add(nk); qx.push(cx + 1); qy.push(cy); }
    }
    if (okW) {
      const nk = key(cx - 1, cy);
      if (nk === startK) return false;
      if (!seen.has(nk)) { seen.add(nk); qx.push(cx - 1); qy.push(cy); }
    }
    if (okS) {
      const nk = key(cx, cy + 1);
      if (nk === startK) return false;
      if (!seen.has(nk)) { seen.add(nk); qx.push(cx); qy.push(cy + 1); }
    }
    if (okN) {
      const nk = key(cx, cy - 1);
      if (nk === startK) return false;
      if (!seen.has(nk)) { seen.add(nk); qx.push(cx); qy.push(cy - 1); }
    }

    if (
      stepOk(cx + 1, cy + 1, cx, cy) &&
      stepOk(cx + 1, cy + 1, cx, cy + 1) &&
      stepOk(cx + 1, cy + 1, cx + 1, cy)
    ) {
      const nk = key(cx + 1, cy + 1);
      if (nk === startK) return false;
      if (!seen.has(nk)) { seen.add(nk); qx.push(cx + 1); qy.push(cy + 1); }
    }
    if (
      stepOk(cx + 1, cy - 1, cx, cy) &&
      stepOk(cx + 1, cy - 1, cx, cy - 1) &&
      stepOk(cx + 1, cy - 1, cx + 1, cy)
    ) {
      const nk = key(cx + 1, cy - 1);
      if (nk === startK) return false;
      if (!seen.has(nk)) { seen.add(nk); qx.push(cx + 1); qy.push(cy - 1); }
    }
    if (
      stepOk(cx - 1, cy + 1, cx, cy) &&
      stepOk(cx - 1, cy + 1, cx, cy + 1) &&
      stepOk(cx - 1, cy + 1, cx - 1, cy)
    ) {
      const nk = key(cx - 1, cy + 1);
      if (nk === startK) return false;
      if (!seen.has(nk)) { seen.add(nk); qx.push(cx - 1); qy.push(cy + 1); }
    }
    if (
      stepOk(cx - 1, cy - 1, cx, cy) &&
      stepOk(cx - 1, cy - 1, cx, cy - 1) &&
      stepOk(cx - 1, cy - 1, cx - 1, cy)
    ) {
      const nk = key(cx - 1, cy - 1);
      if (nk === startK) return false;
      if (!seen.has(nk)) { seen.add(nk); qx.push(cx - 1); qy.push(cy - 1); }
    }
  }

  return qx.length < POCKET_LIMIT;
}

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
  const sx = Math.round(sxRaw);
  const sy = Math.round(syRaw);
  const tx = Math.round(txRaw);
  const ty = Math.round(tyRaw);
  if (sx === tx && sy === ty) return [];
  if (!Number.isFinite(tx) || Math.abs(tx) > 30000 || Math.abs(ty) > 30000) return [];

  const startK = key(sx, sy);
  const goalK = key(tx, ty);
  if (!goalOk(tx, ty)) return [];

  if (false) {
    if (isGoalIsolatedPocket(stepOk, sx, sy, tx, ty)) {
      return [];
    }
  }

  const useShared = !sharedInUse;
  if (useShared) sharedInUse = true;
  const g = useShared ? sharedG : new Map<number, number>();
  const from = useShared ? sharedFrom : new Map<number, number>();
  const open = useShared ? sharedHeap : new FlatMinHeap();
  if (useShared) {
    g.clear();
    from.clear();
    open.clear();
  }

  g.set(startK, 0);
  const dxa0 = Math.abs(sx - tx);
  const dya0 = Math.abs(sy - ty);
  open.push((dxa0 >= dya0 ? dxa0 + DIAG_EXTRA * dya0 : dya0 + DIAG_EXTRA * dxa0), startK);
  let visited = 0;

  while (open.size > 0 && visited < maxIter) {
    const cur = open.pop();
    visited++;
    if (cur === goalK) {
      if (stats) stats.visited = visited;
      const res = reconstruct(from, cur);
      if (useShared) sharedInUse = false;
      return res;
    }
    const cx = Math.floor(cur / 65536) - 32768;
    const cy = (cur % 65536) - 32768;
    const gc = g.get(cur)!;

    const okE = stepOk(cx, cy, cx + 1, cy);
    if (okE) {
      const ax = cx + 1;
      const nk = key(ax, cy);
      const ng = gc + 1;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        from.set(nk, cur);
        const dx = Math.abs(ax - tx);
        const dy = Math.abs(cy - ty);
        open.push(ng + (dx >= dy ? dx + DIAG_EXTRA * dy : dy + DIAG_EXTRA * dx), nk);
      }
    }

    const okW = stepOk(cx, cy, cx - 1, cy);
    if (okW) {
      const ax = cx - 1;
      const nk = key(ax, cy);
      const ng = gc + 1;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        from.set(nk, cur);
        const dx = Math.abs(ax - tx);
        const dy = Math.abs(cy - ty);
        open.push(ng + (dx >= dy ? dx + DIAG_EXTRA * dy : dy + DIAG_EXTRA * dx), nk);
      }
    }

    const okS = stepOk(cx, cy, cx, cy + 1);
    if (okS) {
      const ay = cy + 1;
      const nk = key(cx, ay);
      const ng = gc + 1;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        from.set(nk, cur);
        const dx = Math.abs(cx - tx);
        const dy = Math.abs(ay - ty);
        open.push(ng + (dx >= dy ? dx + DIAG_EXTRA * dy : dy + DIAG_EXTRA * dx), nk);
      }
    }

    const okN = stepOk(cx, cy, cx, cy - 1);
    if (okN) {
      const ay = cy - 1;
      const nk = key(cx, ay);
      const ng = gc + 1;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        from.set(nk, cur);
        const dx = Math.abs(cx - tx);
        const dy = Math.abs(ay - ty);
        open.push(ng + (dx >= dy ? dx + DIAG_EXTRA * dy : dy + DIAG_EXTRA * dx), nk);
      }
    }

    if (okE && okS && stepOk(cx, cy, cx + 1, cy + 1)) {
      const ax = cx + 1;
      const ay = cy + 1;
      const nk = key(ax, ay);
      const ng = gc + SQRT2;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        from.set(nk, cur);
        const dx = Math.abs(ax - tx);
        const dy = Math.abs(ay - ty);
        open.push(ng + (dx >= dy ? dx + DIAG_EXTRA * dy : dy + DIAG_EXTRA * dx), nk);
      }
    }

    if (okE && okN && stepOk(cx, cy, cx + 1, cy - 1)) {
      const ax = cx + 1;
      const ay = cy - 1;
      const nk = key(ax, ay);
      const ng = gc + SQRT2;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        from.set(nk, cur);
        const dx = Math.abs(ax - tx);
        const dy = Math.abs(ay - ty);
        open.push(ng + (dx >= dy ? dx + DIAG_EXTRA * dy : dy + DIAG_EXTRA * dx), nk);
      }
    }

    if (okW && okS && stepOk(cx, cy, cx - 1, cy + 1)) {
      const ax = cx - 1;
      const ay = cy + 1;
      const nk = key(ax, ay);
      const ng = gc + SQRT2;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        from.set(nk, cur);
        const dx = Math.abs(ax - tx);
        const dy = Math.abs(ay - ty);
        open.push(ng + (dx >= dy ? dx + DIAG_EXTRA * dy : dy + DIAG_EXTRA * dx), nk);
      }
    }

    if (okW && okN && stepOk(cx, cy, cx - 1, cy - 1)) {
      const ax = cx - 1;
      const ay = cy - 1;
      const nk = key(ax, ay);
      const ng = gc + SQRT2;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        from.set(nk, cur);
        const dx = Math.abs(ax - tx);
        const dy = Math.abs(ay - ty);
        open.push(ng + (dx >= dy ? dx + DIAG_EXTRA * dy : dy + DIAG_EXTRA * dx), nk);
      }
    }
  }
  if (stats) stats.visited = visited;
  if (useShared) sharedInUse = false;
  return [];
}

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
  skipDirect = false,
): Pos[] {
  const sx = Math.round(sxRaw);
  const sy = Math.round(syRaw);
  const tx = Math.round(txRaw);
  const ty = Math.round(tyRaw);
  const ck = sx + ',' + sy + '->' + tx + ',' + ty;
  if (cache?.has(ck)) return cache.get(ck)! ?? [];

  if (!skipDirect) {
    const direct = findPath(stepOk, goalOk, sx, sy, tx, ty, directMaxIter);
    if (direct.length > 0) {
      cache?.set(ck, direct);
      return direct;
    }
  }

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
