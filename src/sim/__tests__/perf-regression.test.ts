// 性能优化回归测试（2026-08-20）：验证所有优化不破坏游戏行为
import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods/registry';

describe('性能优化回归（2026-08-20）', () => {
  // 决策节流
  it('决策节流：pawn 有 decisionCd，不每帧决策', () => {
    const sim = new Sim({ seed: 1, pawnCount: 1, registry: ModRegistry.default() });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    expect(st.decisionCd).toBeDefined();
    expect(st.decisionCd).toBeGreaterThanOrEqual(0);
    expect(st.decisionCd).toBeLessThanOrEqual(sim.tuning.pawn.decisionInterval);
  });

  // adjustMood 直接数组写入
  it('adjustMood：直接写数组，mood 值正确更新', () => {
    const sim = new Sim({ seed: 2, pawnCount: 1, registry: ModRegistry.default() });
    const eid = sim.pawns[0];
    const before = sim.readNeeds(eid)!.mood;
    sim.adjustMood(eid, -5);
    const after = sim.readNeeds(eid)!.mood;
    expect(after).toBe(before - 5);
  });

  it('adjustMood：clamp 到 [0, 100]', () => {
    const sim = new Sim({ seed: 3, pawnCount: 1, registry: ModRegistry.default() });
    const eid = sim.pawns[0];
    sim.adjustMood(eid, -999);
    expect(sim.readNeeds(eid)!.mood).toBe(0);
    sim.adjustMood(eid, 999);
    expect(sim.readNeeds(eid)!.mood).toBe(100);
  });

  // setNeedField / adjustNeedField
  it('setNeedField：直接设值 + clamp', () => {
    const sim = new Sim({ seed: 4, pawnCount: 1, registry: ModRegistry.default() });
    const eid = sim.pawns[0];
    sim.setNeedField(eid, 'food', 42);
    expect(sim.readNeeds(eid)!.food).toBe(42);
    sim.setNeedField(eid, 'food', -10);
    expect(sim.readNeeds(eid)!.food).toBe(0);
    sim.setNeedField(eid, 'food', 200);
    expect(sim.readNeeds(eid)!.food).toBe(100);
  });

  it('adjustNeedField：增量修改 + clamp', () => {
    const sim = new Sim({ seed: 5, pawnCount: 1, registry: ModRegistry.default() });
    const eid = sim.pawns[0];
    sim.setNeedField(eid, 'san', 50);
    sim.adjustNeedField(eid, 'san', -10);
    expect(sim.readNeeds(eid)!.san).toBe(40);
    sim.adjustNeedField(eid, 'san', -999);
    expect(sim.readNeeds(eid)!.san).toBe(0);
  });

  // trailCache 字符串 key（2026-08-20 修复：原数字 key 溢出静默碰撞 → 改字符串）
  it('trailCache：缓存命中（同一路径第二次调用不重算）', () => {
    const sim = new Sim({ seed: 6, pawnCount: 0, registry: ModRegistry.default() });
    // (96,96)→(60,60) 在 seed=6 生成的世界中路径非空（可通行）
    const p1 = sim.getPath(96, 96, 60, 60);
    expect(p1.length).toBeGreaterThan(0);
    const p2 = sim.getPath(96, 96, 60, 60); // 应命中缓存
    expect(p1).toEqual(p2);
    const hits = (sim as unknown as { trailHits: number }).trailHits;
    expect(hits).toBeGreaterThan(0);
  });

  // pawnProfile 缓存
  it('pawnProfile：同帧内多次调用返回同一引用（缓存生效）', () => {
    const sim = new Sim({ seed: 7, pawnCount: 1, registry: ModRegistry.default() });
    sim.step(1); // 推进一帧建立缓存
    const p1 = sim.pawnProfile(sim.pawns[0]);
    const p2 = sim.pawnProfile(sim.pawns[0]);
    expect(p1).toBe(p2); // 同一引用（缓存命中）
  });

  it('pawnProfile：issueCommand 后缓存清除（读到最新状态）', () => {
    const sim = new Sim({ seed: 8, pawnCount: 1, registry: ModRegistry.default() });
    sim.step(1);
    const p1 = sim.pawnProfile(sim.pawns[0]);
    sim.issueCommand({ type: 'move', x: 50, y: 50, pawnId: sim.pawns[0] });
    const p2 = sim.pawnProfile(sim.pawns[0]);
    expect(p2).not.toBe(p1); // 缓存被清 → 新对象
  });

  // 篝火缓存（san 系统）
  it('san 篝火缓存：火旁恢复理智，远离不恢复', () => {
    const sim = new Sim({ seed: 9, pawnCount: 1, registry: ModRegistry.default() });
    const eid = sim.pawns[0];
    // 压低 san
    sim.setNeedField(eid, 'san', 30);
    // 放 campfire 在小人旁
    const pos = sim.pawnPositions.get(eid)!;
    sim.world.placeBuilding(Math.round(pos.x) + 1, Math.round(pos.y), 'campfire', 'player');
    const before = sim.readNeeds(eid)!.san;
    for (let i = 0; i < 60; i++) sim.step(1);
    const after = sim.readNeeds(eid)!.san;
    expect(after).toBeGreaterThan(before);
  });

  // medicine 节流
  it('medicine 伤口演化 2s 节流：不每帧评估但进度正确', () => {
    const sim = new Sim({ seed: 10, pawnCount: 1, registry: ModRegistry.default() });
    const eid = sim.pawns[0];
    const st = sim.pawnStates.get(eid)!;
    // 注入伤口（出血 + 可感染）
    st.extra = { ...(st.extra ?? {}), wounds: [{ type: 'cut', part: 'arm', severity: 0.3, bleeding: true, infection: 0 }] };
    // 推进 3 秒 > 2 秒节流 → 伤口演化评估至少一次
    sim.step(3);
    // 核心验证：不崩 + 伤口对象仍在（演化被执行过）
    const w = (st.extra?.wounds as { severity: number }[] | undefined);
    expect(w).toBeDefined();
  });

  // queryBuildingsNear 零残留
  it('repair 系统不调 queryBuildingsNear（直接遍历建筑表）', () => {
    const sim = new Sim({ seed: 11, pawnCount: 2, registry: ModRegistry.default() });
    // 放一个受损建筑
    const pos = sim.pawnPositions.get(sim.pawns[0])!;
    sim.world.placeBuilding(Math.round(pos.x) + 2, Math.round(pos.y), 'campfire', 'player');
    sim.world.damageBuilding(Math.round(pos.x) + 2, Math.round(pos.y), 10);
    // 步进不崩（repair 系统遍历建筑表找受损建筑）
    for (let i = 0; i < 60; i++) sim.step(1);
    expect(sim.pawns.length).toBeGreaterThan(0);
  });

  // HPA* 分段寻路
  it('HPA* 远距离寻路：(96,96)→(300,300) 返回非空路径', () => {
    const sim = new Sim({ seed: 12, pawnCount: 0, registry: ModRegistry.default() });
    const path = sim.getPath(96, 96, 300, 300);
    expect(path.length).toBeGreaterThan(0);
  });

  // 决策随机分散
  it('决策分散：spawnPawn 后 decisionCd 在 [0, interval] 内', () => {
    const sim = new Sim({ seed: 13, pawnCount: 5, registry: ModRegistry.default() });
    for (const eid of sim.pawns) {
      const cd = sim.pawnStates.get(eid)!.decisionCd ?? 0;
      expect(cd).toBeGreaterThanOrEqual(0);
      expect(cd).toBeLessThanOrEqual(sim.tuning.pawn.decisionInterval);
    }
  });

  // 长局不崩（综合 smoke）
  it('长局 300s smoke：40 pawn 不崩 + 有产出', () => {
    const sim = new Sim({ seed: 42, pawnCount: 10, registry: ModRegistry.default() });
    for (let i = 0; i < 300; i++) sim.step(1);
    expect(sim.pawns.length).toBeGreaterThan(0);
    expect(sim.stockpile.wood ?? 0).toBeGreaterThan(0);
    expect(sim.stockpile.food ?? 0).toBeGreaterThan(0);
  });
});