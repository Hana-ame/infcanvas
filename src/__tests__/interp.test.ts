/**
 * interp.test.ts —— R1-3 远程渲染插值。
 *
 * 验收重点（ROADMAP 原话）：**插值只存在于渲染层副本，不得污染逻辑状态**。
 * 所以除插值数学本身外，本文件花了一半篇幅在测「逻辑状态没被动过」：
 * RemoteSim.pawns() 拿到的必须永远是服务端权威快照。
 */
import { describe, expect, it } from 'vitest';
import { InterpSlot, clamp01, interpK, lerpPos } from '../client/interp';
import { RemoteSim } from '../client/remote';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';
import { snapshotOf } from '../sim/sim-save';
import type { FullState } from '../shared/protocol';

function fullStateOf(sim: Sim): FullState {
  const snap = snapshotOf(sim);
  return {
    time: snap.time,
    stockpile: snap.stockpile,
    pawns: snap.pawns,
    hostiles: snap.hostiles,
    buildings: snap.world.buildings,
    events: snap.events,
    world: snap.world,
    // R2-1 新增字段：科技抽卡池状态（2026-10-06 R1+R2 合并补）。
    // 插值测试不关心科技，但 FullState 是必填字段，缺了 tsc 就红。
    techs: [...sim.techUnlocked()],
    techFragments: { ...sim.techFragments },
    // R3-HUD 新增：HUD 面板依赖的 scratch 白名单子集。插值测试不关心，给空即可。
    hudScratch: {},
  };
}

describe('R1-3 插值数学', () => {
  it('lerpPos 在两端与中点都正确，且不改入参（纯函数）', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: -20 };
    expect(lerpPos(a, b, 0)).toEqual({ x: 0, y: 0 });
    expect(lerpPos(a, b, 0.5)).toEqual({ x: 5, y: -10 });
    expect(lerpPos(a, b, 1)).toEqual({ x: 10, y: -20 });
    // 入参原样：这是「纯计算」的硬要求
    expect(a).toEqual({ x: 0, y: 0 });
    expect(b).toEqual({ x: 10, y: -20 });
  });

  it('k 超出 [0,1] 被 clamp 而非外推（乱序快照不会把实体甩出去）', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(lerpPos(a, b, 1.5)).toEqual({ x: 10, y: 0 });
    expect(lerpPos(a, b, -3)).toEqual({ x: 0, y: 0 });
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(1);
  });

  it('interpK 按 delta 间隔归一化：同一经过时间，慢帧不会跑过头', () => {
    // 500ms 的 delta：走了 250ms → k=0.5
    expect(interpK(250, 0.5)).toBeCloseTo(0.5);
    // 1.2s 的 delta（网络拥塞）：同样走 250ms → k≈0.208，停在端点前而不是超调
    expect(interpK(250, 1.2)).toBeCloseTo(250 / 1200);
    expect(interpK(3000, 1.2)).toBe(1); // clamp 到 1
  });

  it('无区间（interval<=0 或非数）时 k=1：直接落在权威位置，最安全', () => {
    expect(interpK(0, 0)).toBe(1);
    expect(interpK(999, 0)).toBe(1);
    expect(interpK(999, -1)).toBe(1);
    expect(interpK(999, NaN)).toBe(1);
  });
});

describe('R1-3 InterpSlot 双缓冲', () => {
  it('初始 prev=next=起点，不动', () => {
    const s = new InterpSlot({ x: 3, y: 4 });
    expect(s.snapshot(0)).toEqual({ x: 3, y: 4 });
    expect(s.snapshot(9999)).toEqual({ x: 3, y: 4 });
  });

  it('advance 后从 prev 平滑过渡到 next', () => {
    const s = new InterpSlot({ x: 0, y: 0 });
    s.advance({ x: 10, y: 0 }, 0.5);
    expect(s.snapshot(0)).toEqual({ x: 0, y: 0 });
    expect(s.snapshot(250)).toEqual({ x: 5, y: 0 });
    expect(s.snapshot(500)).toEqual({ x: 10, y: 0 });
  });

  it('snapTo 直接吸附（full 对账不插值）', () => {
    const s = new InterpSlot({ x: 0, y: 0 });
    s.advance({ x: 10, y: 0 }, 0.5);
    s.snapTo({ x: 99, y: 99 });
    expect(s.snapshot(0)).toEqual({ x: 99, y: 99 });
    expect(s.intervalSec).toBe(0);
  });

  it('advance 不持有传入对象的引用（调用方后续改写不会影响槽）', () => {
    const s = new InterpSlot({ x: 0, y: 0 });
    const p = { x: 10, y: 0 };
    s.advance(p, 0.5);
    p.x = 999;
    expect(s.snapshot(500)).toEqual({ x: 10, y: 0 });
  });
});

describe('R1-3 插值不污染逻辑状态（核心验收）', () => {
  it('delta 合入后：pawns() 里的 pos 仍是权威值，插值只在 renderPos()', () => {
    const real = new Sim({ seed: 7, registry: ModRegistry.default() });
    const remote = new RemoteSim({ now: () => 0 });
    remote.handleForTest({
      t: 'welcome',
      d: { ...fullStateOf(real), seed: real.world.seed, tuning: structuredClone(real.tuning) },
    });
    const eid = [...real.pawns()][0]!.eid;

    // 服务器侧把鼠挪到远处，然后发一帧 delta
    real.pawn(eid)!.pos = { x: 100, y: 100 };
    const snap = snapshotOf(real);
    remote.handleForTest({
      t: 'delta',
      d: {
        time: real.time + 0.5,
        stockpile: { ...real.stockpile },
        pawns: snap.pawns.filter((p) => p.eid === eid),
        removedPawns: [],
        hostiles: [],
        buildings: snap.world.buildings,
        newEvents: [],
      },
    });

    // 逻辑状态：权威位置，无插值
    expect(remote.pawn(eid)!.pos).toEqual({ x: 100, y: 100 });
    expect(remote.time).toBeGreaterThan(0);
  });

  it('连续读 renderPos 不改变 pawns() 的内容（渲染读再多也不回写）', () => {
    const real = new Sim({ seed: 8, registry: ModRegistry.default() });
    const remote = new RemoteSim({ now: () => 1000 });
    remote.handleForTest({
      t: 'welcome',
      d: { ...fullStateOf(real), seed: real.world.seed, tuning: structuredClone(real.tuning) },
    });
    const eid = [...real.pawns()][0]!.eid;
    const before = JSON.stringify(remote.pawn(eid));
    for (const t of [0, 100, 250, 500, 900]) remote.renderPos(eid, 1000 + t);
    expect(JSON.stringify(remote.pawn(eid))).toBe(before);
  });

  it('插值途中仍能正确选中（命中判定读权威坐标，不读插值）', () => {
    const real = new Sim({ seed: 9, registry: ModRegistry.default() });
    const remote = new RemoteSim({ now: () => 2000 });
    remote.handleForTest({
      t: 'welcome',
      d: { ...fullStateOf(real), seed: real.world.seed, tuning: structuredClone(real.tuning) },
    });
    const eid = [...real.pawns()][0]!.eid;
    const start = real.pawn(eid)!.pos;
    real.pawn(eid)!.pos = { x: start.x + 20, y: start.y };
    remote.handleForTest({
      t: 'delta',
      d: {
        time: real.time + 0.5,
        stockpile: { ...real.stockpile },
        pawns: [structuredClone(real.pawn(eid)!)],
        removedPawns: [],
        hostiles: [],
        buildings: [],
        newEvents: [],
      },
    });
    // 刚收到帧（elapsed=0）时渲染值 == 起点 == 权威旧位；逻辑位已是终点。
    // 命中判定用哪个都不会错位，因为「已收到的帧」的插值起点就是上一权威位。
    expect(remote.renderPos(eid, 2000)).toEqual({ x: start.x, y: start.y });
    expect(remote.pawn(eid)!.pos).toEqual({ x: start.x + 20, y: start.y });
  });

  it('full 到达：插值槽重置并吸附（不留旧插值残影）', () => {
    const real = new Sim({ seed: 10, registry: ModRegistry.default() });
    const remote = new RemoteSim({ now: () => 3000 });
    remote.handleForTest({
      t: 'welcome',
      d: { ...fullStateOf(real), seed: real.world.seed, tuning: structuredClone(real.tuning) },
    });
    const eid = [...real.pawns()][0]!.eid;
    real.pawn(eid)!.pos = { x: 50, y: 50 };
    remote.handleForTest({ t: 'full', d: fullStateOf(real) });
    // 吸附：任何 elapsed 都给出权威位置，不插值
    expect(remote.renderPos(eid, 3000)).toEqual({ x: 50, y: 50 });
    expect(remote.renderPos(eid, 99999)).toEqual({ x: 50, y: 50 });
  });

  it('实体被删除时插值槽同步清理（不留下已死实体的渲染轨迹）', () => {
    const real = new Sim({ seed: 11, registry: ModRegistry.default() });
    const remote = new RemoteSim({ now: () => 4000 });
    remote.handleForTest({
      t: 'welcome',
      d: { ...fullStateOf(real), seed: real.world.seed, tuning: structuredClone(real.tuning) },
    });
    const eid = [...real.pawns()][0]!.eid;
    remote.handleForTest({
      t: 'delta',
      d: {
        time: real.time + 0.5,
        stockpile: {},
        pawns: [],
        removedPawns: [eid],
        hostiles: [],
        buildings: [],
        newEvents: [],
      },
    });
    expect(remote.pawn(eid)).toBeUndefined();
    expect(remote.renderPos(eid, 4000)).toBeUndefined();
  });
});
