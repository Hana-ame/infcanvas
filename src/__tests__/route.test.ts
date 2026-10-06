/**
 * route.test.ts —— 篝火航点中转（锚点对段缓存）：直连失败借火堆分段到达。
 *
 * 测试用"走廊世界"构造确定性场景：stepOk 只允许四段走廊内部与衔接处的移动，
 * 直连(起点→终点)必然失败，唯一可行路线 = 经过走廊锚点的分段拼接。
 */
import { describe, expect, it } from 'vitest';
import { planRoute } from '../sim/pathfinding';
import type { Pos } from '../sim/types';

/** 四段走廊：S 区(x∈[-3,3]) → A 区([5,11]) → B 区([13,19]) → G 区([21,27])，y∈[-3,3]。
 *  相邻区域在边界处重叠 1 格（衔接点）。区域外的任何移动都被禁止。 */
type Zone = { x0: number; x1: number; y0: number; y1: number };

/** 连续走廊：四段首尾共格衔接（锚点路由的成功场景） */
const LINKED: Zone[] = [
  { x0: -3, x1: 4, y0: -3, y1: 3 },
  { x0: 4, x1: 11, y0: -3, y1: 3 },
  { x0: 11, x1: 18, y0: -3, y1: 3 },
  { x0: 18, x1: 25, y0: -3, y1: 3 },
];
/** 断开走廊：段与段之间隔 1 列荒野（无锚点时不可达） */
const BROKEN: Zone[] = [
  { x0: -3, x1: 3, y0: -3, y1: 3 },
  { x0: 5, x1: 11, y0: -3, y1: 3 },
  { x0: 13, x1: 19, y0: -3, y1: 3 },
  { x0: 21, x1: 27, y0: -3, y1: 3 },
];

function makeStep(zones: Zone[]) {
  const inAny = (x: number, y: number): boolean =>
    zones.some((z) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
  const stepOk = (fx: number, fy: number, tx: number, ty: number): boolean =>
    inAny(fx, fy) && inAny(tx, ty) && Math.max(Math.abs(tx - fx), Math.abs(ty - fy)) <= 1;
  return { stepOk, goalOk: inAny };
}
const linked = makeStep(LINKED);
const broken = makeStep(BROKEN);

describe('篝火航点中转', () => {
  const S: Pos = { x: 0, y: 0 };
  const G: Pos = { x: 24, y: 0 };
  const ANCHORS: Pos[] = [
    { x: 8, y: 0 }, // A 区火堆
    { x: 16, y: 0 }, // B 区火堆
  ];

  function directWalkSucceeds(mk: { stepOk: (a: number, b: number, c: number, d: number) => boolean }): boolean {
    let walked = true;
    let cx = S.x;
    let cy = S.y;
    for (let i = 0; i < 40 && (cx !== G.x || cy !== G.y); i++) {
      const nx = cx + Math.sign(G.x - cx);
      if (!mk.stepOk(cx, cy, nx, cy)) {
        walked = false;
        break;
      }
      cx = nx;
      cy += Math.sign(G.y - cy) * (Math.abs(nx - cx) === 0 ? Math.sign(G.y - cy) : 0);
    }
    return walked && cx === G.x && cy === G.y;
  }

  it('断开走廊：直连必然失败（起终点隔着不可通行荒野）', () => {
    expect(directWalkSucceeds(broken)).toBe(false);
  });

  it('断开走廊且无锚点：planRoute 返回空（诚实失败，不硬闯荒野）', () => {
    const r = planRoute(broken.stepOk, broken.goalOk, S.x, S.y, G.x, G.y, [], 100, 100);
    expect(r).toHaveLength(0);
  });

  it('有锚点：分段拼接成功，路径经过两处火堆所在走廊', () => {
    const r = planRoute(linked.stepOk, linked.goalOk, S.x, S.y, G.x, G.y, ANCHORS, 100, 200);
    expect(r.length).toBeGreaterThan(0);
    expect(r[r.length - 1]).toEqual(G);
    // 路径必须进入过 A 区与 B 区（即真的"路过"了两个火堆走廊）
    const passA = r.some((n) => n.x >= 5 && n.x <= 11);
    const passB = r.some((n) => n.x >= 13 && n.x <= 19);
    expect(passA).toBe(true);
    expect(passB).toBe(true);
  });

  it('缓存：相同查询第二次直接命中（结果一致）', () => {
    const cache = new Map<string, Pos[] | null>();
    const r1 = planRoute(linked.stepOk, linked.goalOk, S.x, S.y, G.x, G.y, ANCHORS, 100, 200, cache);
    const size1 = cache.size;
    const r2 = planRoute(linked.stepOk, linked.goalOk, S.x, S.y, G.x, G.y, ANCHORS, 100, 200, cache);
    expect(cache.size).toBe(size1); // 未新增条目=命中缓存
    expect(r2).toEqual(r1);
  });

  it('直连成功时不走锚点（近距优先直连）', () => {
    const near: Pos = { x: 2, y: 2 }; // 与 S 同区，直连即可达
    const r = planRoute(linked.stepOk, linked.goalOk, S.x, S.y, near.x, near.y, ANCHORS, 100, 200);
    expect(r.length).toBeGreaterThan(0);
    expect(r![r.length - 1]).toEqual(near);
  });
});
