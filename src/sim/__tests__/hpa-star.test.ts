// HPA* 分段寻路回归测试（2026-08-16）：无限世界远距离寻路支持
import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods/registry';
import { findPath } from '../core/pathfinding';

describe('HPA* 分段寻路（无限世界远距离支持，2026-08-16）', () => {
  it('远距离(288格)寻路成功返回非空路径', () => {
    const sim = new Sim({ seed: 42, pawnCount: 0, registry: ModRegistry.default() });
    const path = sim.getPath(96, 96, 300, 300);
    expect(path.length).toBeGreaterThan(0);
  });

  it('远距离(571格)寻路成功返回非空路径', () => {
    const sim = new Sim({ seed: 42, pawnCount: 0, registry: ModRegistry.default() });
    const path = sim.getPath(96, 96, 500, 500);
    expect(path.length).toBeGreaterThan(0);
  });

  it('负坐标远距离寻路成功', () => {
    const sim = new Sim({ seed: 42, pawnCount: 0, registry: ModRegistry.default() });
    const path = sim.getPath(96, 96, -200, -200);
    expect(path.length).toBeGreaterThan(0);
  });

  it('超远距离(1278格)寻路成功', () => {
    const sim = new Sim({ seed: 42, pawnCount: 0, registry: ModRegistry.default() });
    const path = sim.getPath(96, 96, 1000, 1000);
    expect(path.length).toBeGreaterThan(0);
  });

  it('远距离移动：小人能走接近目标', () => {
    const sim = new Sim({ seed: 42, pawnCount: 1, registry: ModRegistry.default() });
    const eid = sim.pawns[0];
    const pos0 = sim.pawnPositions.get(eid)!;
    sim.issueCommand({ type: 'move', x: 300, y: 300, pawnId: eid });
    for (let i = 0; i < 300; i++) sim.step(1);
    const pos1 = sim.pawnPositions.get(eid)!;
    const moved = Math.hypot(pos1.x - pos0.x, pos1.y - pos0.y);
    expect(moved).toBeGreaterThan(100); // 至少走 100 格（之前分段直线只 132 格）
  });

  it('短距离寻路不走分段（< 128 格走正常 A*）', () => {
    const sim = new Sim({ seed: 42, pawnCount: 0, registry: ModRegistry.default() });
    const path = sim.getPath(96, 96, 100, 100);
    expect(path.length).toBeGreaterThan(0);
    expect(path.length).toBeLessThan(20); // 短距离路径不长
  });

  it('显式 maxIter 钳制时不走分段（小 maxIter 远路返回空）', () => {
    const sim = new Sim({ seed: 42, pawnCount: 0, registry: ModRegistry.default() });
    // 直接调 findPath（绕过 sim.getPath 的缓存层）
    const path = findPath(sim.world, 2, 2, 189, 189, { maxIter: 100 });
    expect(path.length).toBeLessThan(200); // maxIter=100 不分段绕过钳制
  });
});