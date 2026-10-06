/**
 * box-select.test.ts —— R1-4 框选的纯几何判定。
 *
 * 测 selection.ts 而不是 Renderer：框选最容易出错的不是「选中了」而是「选错了」
 * ——反向拖拽、零面积框、框住世界原点，表现只是「好像少选了一只」，
 * 肉眼看画面几乎发现不了。纯函数断言选中的 eid 集合可靠得多。
 */
import { describe, expect, it } from 'vitest';
import { eidsInRect, normalizeRect, rectContains } from '../client/selection';

/** 只用到 eid/pos 的最小实体桩（与 PawnState 的其余字段无关） */
function at(eid: number, x: number, y: number) {
  return { eid, pos: { x, y } };
}

describe('R1-4 框选几何', () => {
  it('框住范围内的全部实体，一并返回', () => {
    const pawns = [at(1, 1, 1), at(2, 2, 2), at(3, 3, 3), at(4, 9, 9)];
    expect(eidsInRect({ x0: 0, y0: 0, x1: 5, y1: 5 }, pawns)).toEqual([1, 2, 3]);
  });

  it('反向拖拽（上→下、右→左）得到同一个矩形', () => {
    const pawns = [at(1, 1, 1), at(2, 4, 4)];
    const fwd = eidsInRect({ x0: 0, y0: 0, x1: 5, y1: 5 }, pawns);
    const rev = eidsInRect({ x0: 5, y0: 5, x1: 0, y1: 0 }, pawns);
    expect(rev).toEqual(fwd);
    expect(rev).toEqual([1, 2]);
  });

  it('只反向一个轴也正确（横向反向、纵向正向）', () => {
    const pawns = [at(1, 2, 2)];
    expect(eidsInRect({ x0: 5, y0: 0, x1: 0, y1: 5 }, pawns)).toEqual([1]);
    expect(eidsInRect({ x0: 0, y0: 5, x1: 5, y1: 0 }, pawns)).toEqual([1]);
  });

  it('边界算命中（框边上的鼠要被选中，否则玩家以为框没生效）', () => {
    expect(rectContains({ minX: 0, minY: 0, maxX: 5, maxY: 5 }, { x: 0, y: 0 })).toBe(true);
    expect(rectContains({ minX: 0, minY: 0, maxX: 5, maxY: 5 }, { x: 5, y: 5 })).toBe(true);
    expect(rectContains({ minX: 0, minY: 0, maxX: 5, maxY: 5 }, { x: 5.01, y: 2 })).toBe(false);
    expect(rectContains({ minX: 0, minY: 0, maxX: 5, maxY: 5 }, { x: -0.01, y: 2 })).toBe(false);
  });

  it('跨世界原点（含负坐标）正常工作', () => {
    const pawns = [at(1, -5, -5), at(2, 0, 0), at(3, 5, 5), at(4, 100, 100)];
    expect(eidsInRect({ x0: -10, y0: -10, x1: 10, y1: 10 }, pawns)).toEqual([1, 2, 3]);
  });

  it('零面积框（点一下不拖）只命中恰好在该点上的实体', () => {
    const pawns = [at(1, 3, 3), at(2, 3.5, 3.5)];
    expect(eidsInRect({ x0: 3, y0: 3, x1: 3, y1: 3 }, pawns)).toEqual([1]);
  });

  it('空框选到空数组（不是 undefined，调用方无需特判）', () => {
    expect(eidsInRect({ x0: 100, y0: 100, x1: 200, y1: 200 }, [at(1, 0, 0)])).toEqual([]);
  });

  it('ROADMAP 验收形状：框选 3 鼠 → 一次返回 3 个 eid（供 move 的 eids 数组用）', () => {
    const pawns = [at(7, 1, 1), at(8, 2, 1), at(9, 1, 2), at(10, 40, 40)];
    const picked = eidsInRect({ x0: 0, y0: 0, x1: 5, y1: 5 }, pawns);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3); // 不重复
  });

  it('normalizeRect 输出可直接喂 rectContains', () => {
    const n = normalizeRect({ x0: 5, y0: 5, x1: 1, y1: 1 });
    expect(n).toEqual({ minX: 1, minY: 1, maxX: 5, maxY: 5 });
    expect(rectContains(n, { x: 3, y: 3 })).toBe(true);
  });
});
