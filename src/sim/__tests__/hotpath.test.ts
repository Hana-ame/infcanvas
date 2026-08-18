// 热路径优化语义等价回归（2026-08-16 profile 第二轮：总 step 耗时 -42% 的三处改动）
// 1) sim.findNearest 环剪枝（原全扫半径后返回最近；剪枝后仍必须返回严格最近命中）
// 2) world.nearestBuildingWithTag（专供 campfireDist；必须与 queryBuildingsNear+过滤完全等价）
// 3) history.record 批量容量裁剪（原每次超限 splice 整表；裁剪后 count ≤ cap、recent 语义不变）
// 4) history.record 去 spread（level 字段直接赋值——MINOR 标记行为不变）
// 守护点：未来任何"为了更快"的改动若破坏等价语义，这些对拍会先红。
import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { HistoryLog } from '../core/history';
import type { GameEvent } from '../core/events';

// 在营地旁可建格放一个 campfire（warmth tag），返回其中心坐标
function placeFireAt(sim: Sim, tx: number, ty: number): void {
  for (let dy = 0; dy < 6; dy++) {
    for (let dx = 0; dx < 6; dx++) {
      if (sim.world.canBuildFootprint(tx + dx, ty + dy, sim.buildingDef('campfire')!)) {
        expect(sim.world.placeBuilding(tx + dx, ty + dy, 'campfire', 'player')).toBe(true);
        return;
      }
    }
  }
  throw new Error('找不到 campfire 可建点');
}

describe('热路径等价回归（2026-08-16）', () => {
  it('findNearest 环剪枝后仍返回严格最近命中（全扫对拍）', () => {
    const sim = new Sim({ seed: 7, pawnCount: 1 });
    const eid = sim.pawns[0];
    const p = sim.pawnPositions.get(eid)!;
    // 三个 campfire 放在已知相对偏移（可建点找在 tx,ty 起点的 6×6 内，距离可控）
    placeFireAt(sim, Math.round(p.x) + 10, Math.round(p.y));
    placeFireAt(sim, Math.round(p.x) + 20, Math.round(p.y));
    placeFireAt(sim, Math.round(p.x) + 30, Math.round(p.y));
    const cond = (x: number, y: number): boolean =>
      sim.world.getBuilding(x, y)?.def.tags?.includes('warmth') ?? false;
    const got = sim.findNearest(p, cond, true, 60)!;
    // 全扫对拍：穷举半径内全部 warm 建筑起点，取 d² 最小者
    let bestD2 = Infinity;
    let best = null;
    for (let r = 1; r <= 60; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = Math.round(p.x) + dx;
          const y = Math.round(p.y) + dy;
          if (cond(x, y)) {
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) { bestD2 = d2; best = { x, y }; }
          }
        }
      }
    }
    expect(got).toEqual(best);
  });

  it('nearestBuildingWithTag 与 queryBuildingsNear+tag 过滤完全等价', () => {
    const sim = new Sim({ seed: 11, pawnCount: 1 });
    const p = sim.pawnPositions.get(sim.pawns[0])!;
    placeFireAt(sim, Math.round(p.x) + 8, Math.round(p.y) + 3);
    placeFireAt(sim, Math.round(p.x) + 5, Math.round(p.y) + 12);
    placeFireAt(sim, Math.round(p.x) + 25, Math.round(p.y) - 2);
    const cx = Math.round(p.x);
    const cy = Math.round(p.y);
    const fast = sim.world.nearestBuildingWithTag(cx, cy, 32, 'warmth');
    const slowAll = sim.world.queryBuildingsNear(cx, cy, 32).filter((b) => b.def.tags?.includes('warmth'));
    if (slowAll.length === 0) {
      expect(fast).toBeNull();
      return;
    }
    const slow = slowAll.reduce((a, b) => (b.dist < a.dist ? b : a));
    expect(fast).not.toBeNull();
    expect(fast!.dist).toBeCloseTo(slow.dist, 6);
  });

  it('history.record 批量裁剪：count 保持 ≤ cap，recent 视图语义不变', () => {
    const log = new HistoryLog(100); // 小 cap 快速触发裁剪
    const t0 = 100;
    const ev = (type: string): GameEvent => ({ type } as GameEvent);
    // 灌 250 条（> cap，且 minor 事件超半 → 逼 recent 回退分支）
    for (let i = 0; i < 250; i++) {
      log.record(ev(i % 3 === 0 ? 'social' : i % 3 === 1 ? 'eat' : 'work_completed'), t0 + i, 1);
    }
    expect(log.count).toBeLessThanOrEqual(100);
    expect(log.count).toBeGreaterThanOrEqual(75); // 裁剪到 cap 的 3/4
    // minor（eat）仍完整可查（完整事实保留，只影响 recent 概览）
    expect(log.query({ type: 'eat', limit: 1000 }).length).toBeGreaterThan(10);
    // major 数量 ≥3 → recent 全为 major（social/work_completed），无 minor 占位
    const recent = log.recent;
    expect(recent.length).toBe(20);
    for (const e of recent) expect(e.level).not.toBe('minor');
    // 最新一条 = 最后记录的事件（i=249 → 249%3=0 → social；裁剪没丢尾部）
    expect(recent[0].type).toBe('social');
  });

  it('history.record MINOR 标记：eat/rest/mood_changed 标 minor，其余不标（去 spread 回归）', () => {
    const log = new HistoryLog(50);
    log.record({ type: 'eat', eid: 1 } as GameEvent, 1, 1);
    log.record({ type: 'rest', eid: 1 } as GameEvent, 2, 1);
    log.record({ type: 'mood_changed', eid: 1 } as GameEvent, 3, 1);
    log.record({ type: 'social', eid: 1 } as GameEvent, 4, 1);
    log.record({ type: 'work_completed', eid: 1 } as GameEvent, 5, 1);
    const all = log.toJSON();
    expect(all[0].level).toBe('minor');
    expect(all[1].level).toBe('minor');
    expect(all[2].level).toBe('minor');
    expect(all[3].level).toBeUndefined();
    expect(all[4].level).toBeUndefined();
  });
});