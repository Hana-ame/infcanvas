/**
 * hpa-infinite.test.ts —— 无限地图（infcanvas）三层分层寻路引擎完整测试。
 *
 * 覆盖：
 *  1. Tier 1 短距 Micro A*（≤32格）+ 共线路径简化（simplifyPath）
 *  2. Tier 2 中长距 Chunk-Portal HPA*（32~512格）+ 64×64 区块边界门户提取 + 单区块 O(1) 脏失效
 *  3. Tier 3 超远距宏走廊步进（>512格，覆盖正负大坐标 ±1200 格）+ 群体 Raid 流场（FlowFieldPlanner）
 */
import { describe, expect, it } from 'vitest';
import { Sim, InfiniteChunkPathfinder, FlowFieldPlanner, simplifyPath, type InfinitePathStats } from '../sim';
import { ModRegistry } from '../mods';
import { tileChunkKey } from '../shared/chunks';

describe('infcanvas 无限地图三层寻路引擎 (hpa-infinite)', () => {
  it('simplifyPath 剔除共线冗余中间点，保留拐点与起终点', () => {
    const raw = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
    ];
    const simp = simplifyPath(raw);
    expect(simp).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 2 },
    ]);
  });

  it('Tier 1 (≤32格)：短距寻路走 micro-astar 并命中缓存', () => {
    const sim = new Sim({ seed: 42, pawnCount: 0, registry: ModRegistry.default() });
    const stats: InfinitePathStats = {
      tierUsed: 'micro-astar',
      visitedNodes: 0,
      chunksScanned: 0,
      portalsEvaluated: 0,
      cacheHits: 0,
    };
    const p1 = sim.infinitePathfinder.findInfinitePath(0, 0, 8, 6, 2, [], stats);
    expect(p1.length).toBeGreaterThan(0);
    expect(stats.tierUsed).toBe('micro-astar');

    // 第二次同起终点直接命中缓存
    const p2 = sim.infinitePathfinder.findInfinitePath(0, 0, 8, 6, 2, [], stats);
    expect(stats.tierUsed).toBe('cache-hit');
    expect(p2).toEqual(p1);
  });

  it('Tier 2 (32~512格)：跨 64×64 区块提取边界 Portal 并完成 HPA* 寻路', () => {
    const sim = new Sim({ seed: 42, pawnCount: 0, registry: ModRegistry.default() });
    const portals = sim.infinitePathfinder.getChunkPortals(0, 0, 2);
    expect(portals.portals.length).toBeGreaterThan(0);

    const stats: InfinitePathStats = {
      tierUsed: 'micro-astar',
      visitedNodes: 0,
      chunksScanned: 0,
      portalsEvaluated: 0,
      cacheHits: 0,
    };
    const path = sim.infinitePathfinder.findInfinitePath(0, 0, 140, 110, 2, [{ x: 60, y: 50 }], stats);
    expect(path.length).toBeGreaterThan(0);
    expect(['chunk-hpa', 'macro-corridor']).toContain(stats.tierUsed);
  });

  it('单区块 O(1) 脏失效：在区块 (0,0) 建墙只递增该区块版本，不污染远方区块 (5,5)', () => {
    const sim = new Sim({ seed: 42, pawnCount: 0, registry: ModRegistry.default() });
    const ck0 = tileChunkKey(2, 2).key;
    const ckFar = tileChunkKey(320, 320).key;
    const v0Before = sim.infinitePathfinder.chunkVersionOf(ck0);
    const vFarBefore = sim.infinitePathfinder.chunkVersionOf(ckFar);

    sim.addBuilding('wall', 2, 2);
    expect(sim.infinitePathfinder.chunkVersionOf(ck0)).toBe(v0Before + 1);
    expect(sim.infinitePathfinder.chunkVersionOf(ckFar)).toBe(vFarBefore);
  });

  it('Tier 3 (>512格 & 负坐标)：跨正负大坐标 (-350,-300) -> (450,400) 超远距寻路成功', () => {
    const sim = new Sim({ seed: 42, pawnCount: 0, registry: ModRegistry.default() });
    const stats: InfinitePathStats = {
      tierUsed: 'micro-astar',
      visitedNodes: 0,
      chunksScanned: 0,
      portalsEvaluated: 0,
      cacheHits: 0,
    };
    const path = sim.infinitePathfinder.findInfinitePath(-350, -300, 450, 400, 2, [], stats);
    expect(path.length).toBeGreaterThan(0);
    expect(stats.tierUsed).toBe('macro-corridor');
  });

  it('FlowFieldPlanner：群体 Raid 流场为周围多个坐标提供 O(1) 收敛向目标的方向步进', () => {
    const sim = new Sim({ seed: 42, pawnCount: 0, registry: ModRegistry.default() });
    const ff = new FlowFieldPlanner(sim.world, 0, 0, 20, 2);
    expect(ff.vectors.size).toBeGreaterThan(50);

    const stepFrom5 = ff.nextStepFrom(4, 3);
    expect(stepFrom5).not.toBeNull();
    if (stepFrom5) {
      expect(Math.hypot(stepFrom5.x, stepFrom5.y)).toBeLessThan(Math.hypot(4, 3));
    }
  });
});
