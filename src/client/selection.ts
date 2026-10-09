/**
 * client/selection.ts —— 框选的**纯几何判定**（R1-4） + 选择态不可变快照（flow 线）。
 *
 * ## 为什么需要不可变快照（2026-10-08 flow 线拆分）
 *
 * 之前 main.ts 用 `selected = new Set<number>()` 作为共享可变引用，
 * 被 Renderer 的 onSelect/HUD 的 frame/ctrl.move 三方同时读写，时序不可控。
 *
 * 修法：每帧生成一个不可变 SelectionSnapshot，只在事件处理器收口处一次性替换。
 * 渲染/HUD/ctrl 每帧读的是同一份快照，谁也不改它。
 *
 * 与既有 eidsInRect 的关系：
 *   eidsInRect 是"框出哪些鼠"的纯几何函数，返回原始的 eid 数组；
 *   本层是"把这些 eid 包装成不可变选择态"，是流向上游到下游的契约载体。
 *
 * ## 坐标约定
 *   函数收到的是**世界坐标**的矩形，已由调用方从屏幕坐标换算完毕。
 *   换算留在 render.ts 中因它依赖相机/缩放这些表现层状态；
 *   「哪些点落在矩形里」则是纯几何，没有理由沾上表现层。
 */
import type { Eid, Pos } from '../sim/types';

/** 选择快照：每帧不变，一次性替换。含鼠/建筑/敌袭三方互斥语义。 */
export interface SelectionSnapshot {
  readonly pawns: ReadonlySet<Eid>;
  readonly buildingId: string | null;
  readonly hostileId: number | null;
}

/** 空选择（无选中对象） */
export const EMPTY_SELECTION: SelectionSnapshot = Object.freeze({
  pawns: new Set<Eid>(),
  buildingId: null,
  hostileId: null,
});

/** 纯函数：生成新快照（只替换鼠选取，清空建筑/敌袭） */
export function selectPawns(eids: Iterable<Eid>): SelectionSnapshot {
  return { pawns: new Set(eids), buildingId: null, hostileId: null };
}

/** 纯函数：选中建筑（清鼠选） */
export function selectBuilding(buildingId: string | null): SelectionSnapshot {
  return { pawns: new Set(), buildingId, hostileId: null };
}

/** 纯函数：选中敌袭（清鼠选） */
export function selectHostile(hostileId: number | null): SelectionSnapshot {
  return { pawns: new Set(), buildingId: null, hostileId };
}

/** 轴对齐矩形（世界坐标；允许 x0>x1 / y0>y1，反向拖拽也能正确处理） */
export interface WorldRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 把可能反向的矩形归一为「左下 + 右上」两个角点 */
export function normalizeRect(r: WorldRect): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return {
    minX: Math.min(r.x0, r.x1),
    minY: Math.min(r.y0, r.y1),
    maxX: Math.max(r.x0, r.x1),
    maxY: Math.max(r.y0, r.y1),
  };
}

/**
 * 矩形是否命中一个点（边界算命中）。
 * 用 <=/>= 而非 </>：边界上的一只鼠如果漏选，玩家会以为「框没生效」
 * 而不是「它刚好在边上」，后者远比前者难排查。
 */
export function rectContains(n: { minX: number; minY: number; maxX: number; maxY: number }, p: Pos): boolean {
  return p.x >= n.minX && p.x <= n.maxX && p.y >= n.minY && p.y <= n.maxY;
}

/**
 * 框内实体的 eid 集合。
 * 传 items 而不是 view.pawns()：保持纯函数（无 WorldView 依赖），
 * 调用方决定传什么——目前是权威 pawns。
 */
export function eidsInRect<T extends { eid: Eid; pos: Pos }>(r: WorldRect, items: Iterable<T>): Eid[] {
  const n = normalizeRect(r);
  const out: Eid[] = [];
  for (const it of items) if (rectContains(n, it.pos)) out.push(it.eid);
  return out;
}
