import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { findPath } from '../core/pathfinding';
import { TECHS, TECH_ORDER } from '../defs/techs';
import { makeDummyCardPlanner } from '../../server/dummyLlm';

// 找一个水面 + 相邻陆地（桥/筏可建处）
function findWaterWithLand(sim: Sim): { x: number; y: number } | null {
  const w = sim.world;
  for (let y = 10; y < w.height - 10; y++) {
    for (let x = 10; x < w.width - 10; x++) {
      if (w.getTile(x, y) !== 'water') continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const t = w.getTile(x + dx, y + dy);
        if (t !== 'water') return { x, y };
      }
    }
  }
  return null;
}

describe('科技抽卡（神谕解锁）', () => {
  it('科技锁：bridge/boat 未解锁时不可建造（queueBuild 拒绝）；解锁后可建', () => {
    const sim = new Sim({ seed: 42, pawnCount: 1 });
    const spot = findWaterWithLand(sim)!;
    const before = sim.buildQueue.length;
    sim.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: 'bridge' });
    expect(sim.buildQueue.length).toBe(before); // 科技锁：拒绝
    sim.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: 'raft' });
    expect(sim.buildQueue.length).toBe(before); // 载具也要科技锁：拒绝
    // 解锁 raftTech + bridgeTech → 均可建
    sim.unlockTech('transport:raft');
    sim.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: 'raft' });
    expect(sim.buildQueue.length).toBe(before + 1);
    sim.unlockTech('transport:bridge');
    sim.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: 'bridge' });
    expect(sim.buildQueue.length).toBe(before + 2);
  });

  it('unlockTech 幂等 + 存档往返保留', () => {
    const sim = new Sim({ seed: 43, pawnCount: 1 });
    expect(sim.unlockTech('transport:raft')).toBe(true);
    expect(sim.unlockTech('transport:raft')).toBe(false); // 幂等
    const data = JSON.parse(JSON.stringify(sim.save()));
    const sim2 = new Sim({ seed: 44, pawnCount: 1 });
    sim2.load(data);
    expect(sim2.techs.has('transport:raft')).toBe(true);
  });

  // 科技来源机制待与文档核对（神谕不降科技——用户 2026-08-13 定案；
  // 原"神谕科技抽卡"测试已随机制移除，解锁/门控能力由下方测试覆盖）
});

describe('桥 = 地形改造（water → bridge tile）', () => {
  it('桥蓝图完成：水格变桥面 tile，小人可通行，寻路可走', () => {
    const sim = new Sim({ seed: 47, pawnCount: 1 });
    sim.unlockTech('transport:bridge');
    const spot = findWaterWithLand(sim)!;
    sim.stockpile.wood = 999;
    sim.stockpile.ore = 999;
    sim.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: 'bridge' });
    expect(sim.buildQueue.length).toBe(1);
    // 等建成（buildTime=3s）
    for (let i = 0; i < 200 && sim.buildQueue.length > 0; i++) sim.step(1 / 20);
    expect(sim.buildQueue.length).toBe(0);
    // 水格 → 桥面（tile 变化，无建筑残留）
    expect(sim.world.getTile(spot.x, spot.y)).toBe('bridge');
    expect(sim.world.getBuilding(spot.x, spot.y)).toBeFalsy();
    expect(sim.world.isPassable(spot.x, spot.y)).toBe(true);
    expect(sim.world.getTileDef(spot.x, spot.y).z).toBe(1); // 桥面高于水面
    // 寻路：水对岸（桥邻接的陆地 → 桥 → 对岸水另一侧？桥只有 1 格：从桥到水另一格仍不可走。
    // 验证：站在桥面 → 寻路能经过桥格（起点=桥旁陆地，终点=桥）
    const land = findWaterWithLand(sim)!; // 同 spot 或相邻
    let fromLand = { x: spot.x + 1, y: spot.y };
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const t = sim.world.getTile(spot.x + dx, spot.y + dy);
      if (t !== 'water' && sim.world.isPassable(spot.x + dx, spot.y + dy)) { fromLand = { x: spot.x + dx, y: spot.y + dy }; break; }
    }
    const path = findPath(sim.world, fromLand.x, fromLand.y, spot.x, spot.y);
    expect(path.length).toBeGreaterThan(0);
    const last = path[path.length - 1];
    expect(last.x).toBe(spot.x); // 能走到桥面
    void land;
  });

  it('桥只能建在水面 + 邻接陆地（onWater 校验）', () => {
    const sim = new Sim({ seed: 48, pawnCount: 1 });
    sim.unlockTech('transport:bridge');
    const def = sim.mods.buildings.bridge;
    const spot = findWaterWithLand(sim)!;
    expect(sim.world.canBuildFootprint(spot.x, spot.y, def)).toBe(true);
    // 草地不可建桥
    let grass: { x: number; y: number } | null = null;
    for (let y = 5; y < 30; y++) for (let x = 5; x < 30; x++) {
      if (sim.world.getTile(x, y) === 'grass' && !sim.world.getBuilding(x, y)) { grass = { x, y }; break; }
    }
    if (grass) expect(sim.world.canBuildFootprint(grass.x, grass.y, def)).toBe(false);
    // 水中央（无邻接陆地）不可建——找全水格（邻接全水）
    let deep: { x: number; y: number } | null = null;
    for (let y = 10; y < sim.world.height - 10 && !deep; y++) {
      for (let x = 10; x < sim.world.width - 10; x++) {
        if (sim.world.getTile(x, y) !== 'water') continue;
        const allWater = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => sim.world.getTile(x + dx, y + dy) === 'water');
        if (allWater) { deep = { x, y }; break; }
      }
    }
    if (deep) expect(sim.world.canBuildFootprint(deep.x, deep.y, def)).toBe(false);
  });
});

describe('竹筏捕鱼（水上建筑 + recipe）', () => {
  it('筏上工作持续产食物（recipe fishing）', () => {
    const sim = new Sim({ seed: 49, pawnCount: 3 });
    sim.unlockTech('transport:raft'); // 载具科技锁
    const spot = findWaterWithLand(sim)!;
    sim.stockpile.wood = 999;
    sim.stockpile.ore = 999;
    sim.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: 'raft' });
    // 等建成
    for (let i = 0; i < 200 && sim.buildQueue.length > 0; i++) sim.step(1 / 20);
    expect([...sim.world.buildings.values()].some((b) => b.def.id === 'raft')).toBe(true);
    // 筏建成 → 出生派系自动把近处小人划入（如有）；直接验证 recipe 存在 + 渔获逻辑
    expect(sim.recipe('fishing')).toBeDefined();
    expect(sim.recipe('fishing')!.output.item).toBe('food');
    // 强制一个小人去捕鱼：直接给 fish 卡（有筏时谓词满足）
    const st = sim.pawnStates.get(sim.pawns[0])!;
    st.slots.push(sim.mods.cards.get('fish')!); // 行为卡实例
    const foodBefore = sim.stockpile.food ?? 0;
    for (let i = 0; i < 600 && (sim.stockpile.food ?? 0) <= foodBefore + 2; i++) sim.step(1 / 20);
    expect(sim.stockpile.food ?? 0).toBeGreaterThan(foodBefore);
  });
});
