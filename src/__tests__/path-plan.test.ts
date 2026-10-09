/**
 * path-plan.test.ts —— RoutePlanner 脱离 Sim 的直接单测（2026-10-08 sim 维度）。
 *
 * 这份测试存在的理由与 chunk-index-direct.test.ts 相同：走 Sim.setPath 的集成测试
 * 证明不了"规划策略已经从实体容器里拆出来了"。本文件用**假的 canStep/canStand**
 * 和**假的 AnchorSource**（一个可变的墙集合 + 一个版本号）直接驱动 RoutePlanner，
 * 因此只有当 path-plan.ts 真的不依赖 Sim/World 时才编译通过——依赖方向的编译期证据。
 *
 * 同时它是**行为等价**的证据：拆分前 setPath 内联的策略（双档预算 + 长距标志位）
 * 与拆分后 RoutePlanner.plan 的输出在这里被逐用例对拍。golden 指纹是端到端护栏，
 * 这里给的是策略层护栏——各挡一层。
 */
import { describe, expect, it } from 'vitest';
import {
  LONG_DIST,
  LONG_MAX_ITER,
  RoutePlanner,
  SEGMENT_MAX_ITER,
  SHORT_MAX_ITER,
  type AnchorSource,
} from '../sim/path-plan';
import { findPath, planRoute } from '../sim/pathfinding';
import type { BuildingState, Pos } from '../sim/types';
import { K_TAG_WAYPOINT } from '../mods/contracts';

/** 墙集合的编解码（x,y -> number）。只用于测试夹具，不进生产代码。 */
const K = (x: number, y: number) => x * 20007 + y;

/** 开放网格 + 可增删的墙集合：除墙上的格之外，任何格都可走、可站。 */
function openGrid(walls: Set<number>) {
  return {
    canStep: (_fx: number, _fy: number, ax: number, ay: number) => !walls.has(K(ax, ay)),
    canStand: (ax: number, ay: number) => !walls.has(K(ax, ay)),
    /** 同一套判定的显式 findPath 引用，用于和 RoutePlanner 的输出对拍。 */
    ref: (sx: number, sy: number, tx: number, ty: number, maxIter: number) =>
      findPath(
        (_fx, _fy, ax, ay) => !walls.has(K(ax, ay)),
        (ax, ay) => !walls.has(K(ax, ay)),
        sx,
        sy,
        tx,
        ty,
        maxIter,
      ),
  };
}

const NO_ANCHORS: AnchorSource = { tagVersionNow: () => 1, buildingsByTag: () => [] };

/** 生产里的 BuildingState 不带 tag（标签由 tuning 的建筑定义给出），
 *  假来源必须自己造这个映射，所以局部扩一个 TaggedBuilding。 */
type TaggedBuilding = BuildingState & { tags: string[] };

const bld = (id: string, x: number, y: number, tags: string[]): TaggedBuilding => ({
  id,
  defId: 'b',
  pos: { x, y },
  hp: 1,
  tags,
});

describe('预算常量（搜索预算，非玩法数值）', () => {
  it('短距/长距/分段三档预算与阈值保持不变', () => {
    expect(SHORT_MAX_ITER).toBe(1500);
    expect(LONG_MAX_ITER).toBe(8000);
    expect(SEGMENT_MAX_ITER).toBe(1500);
    expect(LONG_DIST).toBe(24);
  });
});

describe('航点列表：fire ∪ waypoint，按 tagVersion 缓存', () => {
  it('顺序固定为 fire 桶（插入序）先、waypoint 桶后；篝火同时挂两个标签时去重', () => {
    const src: AnchorSource = {
      tagVersionNow: () => 1,
      buildingsByTag: (tag) =>
        [
          bld('fire2', 20, 20, ['fire']),
          bld('both', 10, 10, ['fire', K_TAG_WAYPOINT]), // 双标签：只在 fire 桶贡献一次
          bld('wp', 30, 30, [K_TAG_WAYPOINT]),
          bld('hut', 0, 0, []),
        ].filter((b) => b.tags.includes(tag)),
    };
    // fire 桶 = [fire2, both]，waypoint 桶 = [both(重复), wp] ⇒ both 只出现一次且按 fire 序排在 fire2 后
    expect(new RoutePlanner(src).anchors()).toEqual([{ x: 20, y: 20 }, { x: 10, y: 10 }, { x: 30, y: 30 }]);
  });

  it('tagVersion 不变时复用缓存本体；版本变了才重建', () => {
    let version = 1;
    const buildings = [bld('fire', 5, 5, ['fire'])];
    const src: AnchorSource = {
      tagVersionNow: () => version,
      buildingsByTag: (tag) => buildings.filter((b) => b.tags.includes(tag)),
    };
    const p = new RoutePlanner(src);
    const a1 = p.anchors();
    expect(p.anchors()).toBe(a1); // 同一引用 = 缓存生效（返回副本会抵消这项优化）

    buildings.push(bld('fire2', 50, 50, ['fire']));
    expect(p.anchors()).toBe(a1); // 版本没动：仍是旧缓存

    version = 2;
    const a2 = p.anchors();
    expect(a2).not.toBe(a1);
    expect(a2).toHaveLength(2);
  });
});

describe('规划决策：双档预算 + 长距标志位（与拆分前内联逻辑对拍）', () => {
  it('短距（≤ 24 格）走直连 A*，预算 = SHORT_MAX_ITER', () => {
    const g = openGrid(new Set());
    const got = new RoutePlanner(NO_ANCHORS).plan({
      canStep: g.canStep,
      canStand: g.canStand,
      sx: 0,
      sy: 0,
      tx: 3,
      ty: 4,
    });
    // 开放网格上 A* 允许斜向（禁切角），所以最优步数是切比雪夫距离 max(|dx|,|dy|)
    expect(got).toEqual(g.ref(0, 0, 3, 4, SHORT_MAX_ITER));
    expect(got.length).toBe(Math.max(3, 4));
  });

  it('边界值：Manhattan 距离正好 24 仍算短距，25 才算长距', () => {
    const g = openGrid(new Set());
    const p = new RoutePlanner(NO_ANCHORS);
    const at24 = p.plan({ canStep: g.canStep, canStand: g.canStand, sx: 0, sy: 0, tx: LONG_DIST, ty: 0 });
    expect(at24).toEqual(g.ref(0, 0, LONG_DIST, 0, SHORT_MAX_ITER));
    const at25 = p.plan({ canStep: g.canStep, canStand: g.canStand, sx: 0, sy: 0, tx: LONG_DIST + 1, ty: 0 });
    expect(at25).toEqual(g.ref(0, 0, LONG_DIST + 1, 0, LONG_MAX_ITER));
  });

  it('长距 + 有标志位：走分段导航，输出与显式 planRoute 对拍一致', () => {
    const g = openGrid(new Set());
    const anchors: Pos[] = [{ x: 40, y: 0 }];
    const src: AnchorSource = { tagVersionNow: () => 1, buildingsByTag: () => [bld('f', 40, 0, ['fire'])] };
    const planner = new RoutePlanner(src);

    const got = planner.plan({ canStep: g.canStep, canStand: g.canStand, sx: 0, sy: 0, tx: 300, ty: 0 });
    const ref = planRoute(g.canStep, g.canStand, 0, 0, 300, 0, anchors, SEGMENT_MAX_ITER, SEGMENT_MAX_ITER, new Map());
    expect(got).toEqual(ref);
    expect(got.length).toBeGreaterThan(0);

    // 长距分支命中段缓存：同请求第二次返回**同一个数组本体**
    const again = planner.plan({ canStep: g.canStep, canStand: g.canStand, sx: 0, sy: 0, tx: 300, ty: 0 });
    expect(again).toBe(got);
  });

  it('长距 + 无标志位：退化为 LONG_MAX_ITER 直连', () => {
    const g = openGrid(new Set());
    const got = new RoutePlanner(NO_ANCHORS).plan({ canStep: g.canStep, canStand: g.canStand, sx: 0, sy: 0, tx: 2000, ty: 0 });
    expect(got).toEqual(g.ref(0, 0, 2000, 0, LONG_MAX_ITER));
  });

  it('起终点相同：返回空路径且不触发任何搜索', () => {
    const g = openGrid(new Set());
    let calls = 0;
    const step = (..._a: number[]) => {
      calls++;
      return true;
    };
    const got = new RoutePlanner(NO_ANCHORS).plan({ canStep: step, canStand: g.canStand, sx: 7, sy: 7, tx: 7, ty: 7 });
    expect(got).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('clearRoutes：建筑增删后段缓存必须作废', () => {
  it('墙出现后重算必须绕开新墙（不清缓存会拿到穿越墙的旧路线）', () => {
    const walls = new Set<number>();
    const g = openGrid(walls);
    const planner = new RoutePlanner(NO_ANCHORS);

    const before = planner.plan({ canStep: g.canStep, canStand: g.canStand, sx: 0, sy: 0, tx: 50, ty: 0 });
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((s) => s.x === 25 && s.y === 0)).toBe(true); // 原路线穿过 (25,0)

    // 在 x=25 封一列（留出 y 方向的绕行空间）
    for (let y = -40; y <= 40; y++) walls.add(K(25, y));

    planner.clearRoutes();
    const after = planner.plan({ canStep: g.canStep, canStand: g.canStand, sx: 0, sy: 0, tx: 50, ty: 0 });
    expect(after).not.toEqual(before);
    expect(after.length).toBeGreaterThan(0); // 绕过去了，不是"不可达"
    for (const step of after) expect(walls.has(K(step.x, step.y)), `(${step.x},${step.y}) 踩在墙上`).toBe(false);
  });

  it('长距分支：清缓存前后都必须绕开墙（证明 clearRoutes 不产生分叉）', () => {
    const walls = new Set<number>();
    for (let y = -40; y <= 40; y++) walls.add(K(75, y));
    const g = openGrid(walls);
    const planner = new RoutePlanner({ tagVersionNow: () => 1, buildingsByTag: () => [bld('f', 100, 0, ['fire'])] });

    const first = planner.plan({ canStep: g.canStep, canStand: g.canStand, sx: 0, sy: 0, tx: 300, ty: 0 });
    planner.clearRoutes();
    const second = planner.plan({ canStep: g.canStep, canStand: g.canStand, sx: 0, sy: 0, tx: 300, ty: 0 });
    expect(second).toEqual(first);
    for (const step of second) expect(walls.has(K(step.x, step.y))).toBe(false);
  });
});

describe('返回数组的别名纪律（调用方必须取副本）', () => {
  it('长距分支返回的是段缓存本体：原地推进会把缓存掏空，所以 Sim.setPath 必须 slice', () => {
    const g = openGrid(new Set());
    const planner = new RoutePlanner({ tagVersionNow: () => 1, buildingsByTag: () => [bld('f', 100, 0, ['fire'])] });
    const first = planner.plan({ canStep: g.canStep, canStand: g.canStand, sx: 0, sy: 0, tx: 300, ty: 0 });
    expect(first.length).toBeGreaterThan(1);

    // 模拟调用方忘记取副本、用 shift() 把整条路线走完（moveStep 每 tick 推进一次）
    while (first.length > 0) first.shift();

    const second = planner.plan({ canStep: g.canStep, canStand: g.canStand, sx: 0, sy: 0, tx: 300, ty: 0 });
    // 缓存已被掏空 ⇒ 第二次同请求拿到同一个被清空的数组本体
    expect(second).toBe(first);
    expect(second).toEqual([]);
    // 后果：一条本来可达的路线从此被永久判成"不可达"，小人原地空转——
    // 这就是 Sim.setPath 里 `path.slice()` 存在的全部理由（golden 真实踩坑 2026-10-06）
  });
});
