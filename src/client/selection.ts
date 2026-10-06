/**
 * client/selection.ts —— 框选的**纯几何判定**（R1-4）。
 *
 * 为什么要独立成模块：框选判定是 R1-4 里最容易出错的部分，而且错法很隐蔽——
 * 反向拖拽、零面积框、框住世界原点这些情况肉眼看画面几乎发现不了，
 * 表现只是「好像少选了一只」。把判定抽成不依赖 DOM/Pixi 的纯函数后，
 * 可以直接断言选中的 eid 集合，比截图对比可靠得多。
 *
 * 坐标约定：函数收到的是**世界坐标**的矩形，已由调用方从屏幕坐标换算完毕。
 * 换算留在 render.ts 是因为它依赖相机/缩放这些表现层状态；
 * 「哪些点落在矩形里」则是纯几何，没有理由沾上表现层。
 */
import type { Eid, Pos } from '../sim/types';

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
