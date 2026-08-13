// buildSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：蓝图完成 → 建筑落成（building_built） / 升级语义 / 落点非法放弃 / 资源不足等待
import { describe, it, expect, beforeEach } from 'vitest';
import { BuildSystem } from '../../systems/buildSystem';
import { makeMinCtx, attach } from '../helpers/minCtx';

describe('BuildSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(6);
  beforeEach(() => { ctx = makeMinCtx(6); });

  // 找第一个可建 campfire 的位置
  function placeSpot(): { x: number; y: number } {
    for (let x = 1; x < ctx.world.width; x++) for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.canBuildFootprint(x, y, ctx.buildingDef('campfire')!)) return { x, y };
    }
    throw new Error('无可建位置');
  }

  it('蓝图完成 → 建筑落成并发射 building_built', () => {
    const sys = attach(ctx, new BuildSystem(ctx));
    const { x, y } = placeSpot();
    ctx.buildQueue.push({ x, y, defId: 'campfire', progress: 0, faction: 'player' });
    let built = 0;
    ctx.bus.on('building_built', () => { built++; });
    const def = ctx.buildingDef('campfire')!;
    for (let i = 0; i < Math.ceil(def.buildTime) + 2; i++) sys.update(1);
    expect(built).toBe(1);
    expect(ctx.world.getBuilding(x, y)).toBeDefined();
  });

  it('升级语义：原地已有"会升级成目标"的建筑 → 原地升级（upgradeBuilding）', () => {
    const sys = attach(ctx, new BuildSystem(ctx));
    // 找 campfire 升级到 church 的路径：先建 campfire，再加 church 蓝图（def.upgradesTo === 'church'）
    const { x, y } = placeSpot();
    ctx.world.placeBuilding(x, y, 'campfire', 'player');
    const churchDef = ctx.buildingDef('church')!;
    if (!churchDef || !ctx.world.getBuilding(x, y)!.def.upgradesTo) {
      // 无 church 定义则跳过（buildings 表没有升级链时）
      return;
    }
    ctx.buildQueue.push({ x, y, defId: 'church', progress: 0, faction: 'player' });
    for (let i = 0; i < Math.ceil(churchDef.buildTime) + 2; i++) sys.update(1);
    expect(ctx._upgrades.length).toBeGreaterThanOrEqual(1);
  });

  it('落点非法 → 放弃蓝图且不扣资源', () => {
    const sys = attach(ctx, new BuildSystem(ctx));
    // 水面位置不可建（buildFootprint 校验）
    let wx = 0, wy = 0;
    for (let x = 0; x < ctx.world.width; x++) for (let y = 0; y < ctx.world.height; y++) {
      if (ctx.world.getTileDef(x, y).id === 'water') { wx = x; wy = y; }
    }
    ctx.buildQueue.push({ x: wx, y: wy, defId: 'campfire', progress: 9999, faction: 'player', cost: { wood: 100, ore: 0 } });
    ctx.stockpile.wood = 100;
    sys.update(1);
    // 蓝图被放弃（进度已到但落点非法）
    expect(ctx.buildQueue.length).toBe(0);
    expect(ctx.world.getBuilding(wx, wy)).toBeNull();
    expect(ctx.stockpile.wood).toBe(100); // 未扣资源
  });

  it('资源不足 → 等待（不扣、不移除蓝图）', () => {
    const sys = attach(ctx, new BuildSystem(ctx));
    const { x, y } = placeSpot();
    ctx.buildQueue.push({ x, y, defId: 'campfire', progress: 9999, faction: 'player', cost: { wood: 100, ore: 0 } });
    ctx.stockpile.wood = 50; // 不足
    sys.update(1);
    expect(ctx.buildQueue.length).toBe(1); // 还在等
    expect(ctx.stockpile.wood).toBe(50);
  });
});
