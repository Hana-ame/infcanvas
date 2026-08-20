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
    // 注：升级落点校验（2026-08-20 修复）要求 church 2×2 的新格可建——需找"2×2 全可建"位置
    let x = -1, y = -1;
    for (let sx = 1; sx < ctx.world.width - 1; sx++) for (let sy = 1; sy < ctx.world.height - 1; sy++) {
      const cd = ctx.buildingDef('campfire')!;
      const ch = ctx.buildingDef('church')!;
      if (ctx.world.canBuildFootprint(sx, sy, cd) && ctx.world.canBuildFootprint(sx, sy, ch)) { x = sx; y = sy; }
    }
    expect(x).toBeGreaterThanOrEqual(0);
    ctx.world.placeBuilding(x, y, 'campfire', 'player');
    const churchDef = ctx.buildingDef('church')!;
    // 加固：church 是内置建筑表成员且 campfire.upgradesTo==='church'（升级链固定），缺失即失败
    expect(churchDef).toBeDefined();
    expect(ctx.world.getBuilding(x, y)!.def.upgradesTo).toBe('church');
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

  // 2026-08-20 审查修复回归：升级扩展 footprint（1×1 → 2×2）时，新格被相邻建筑占用
  // → 升级必须被拒绝且不破坏相邻建筑的 gridToBuilding 归属（此前 upgradeBuilding 无条件
  // 覆盖 gridToBuilding，后升级者把前者的格子归属顶掉）
  it('升级 footprint 冲突：相邻篝火各升教堂 → 后升级者被拒，两建筑归属完好', () => {
    const sys = attach(ctx, new BuildSystem(ctx));
    // 两座相邻 campfire（1×1）：A=(x,y)、B=(x+1,y)。church 是 2×2 → 各自升级都会
    // 覆盖对方所在格 → 两个升级都应被 canUpgradeAt 拒绝
    const { x, y } = placeSpot();
    // 需要 A 右侧也是可建空地（placeSpot 返回第一个可建点，其右侧可能不可建 → 重排）
    let ax = x, ay = y;
    let placed = false;
    outer:
    for (let sx = 1; sx < ctx.world.width - 1; sx++) for (let sy = 1; sy < ctx.world.height - 1; sy++) {
      const cd = ctx.buildingDef('campfire')!;
      if (ctx.world.canBuildFootprint(sx, sy, cd) && ctx.world.canBuildFootprint(sx + 1, sy, cd)) { ax = sx; ay = sy; placed = true; break outer; }
    }
    expect(placed).toBe(true);
    ctx.world.placeBuilding(ax, ay, 'campfire', 'player');
    ctx.world.placeBuilding(ax + 1, ay, 'campfire', 'player');
    const churchDef = ctx.buildingDef('church')!;
    // 两个教堂蓝图入队（升级路径）
    ctx.buildQueue.push({ x: ax, y: ay, defId: 'church', progress: 9999, faction: 'player' });
    ctx.buildQueue.push({ x: ax + 1, y: ay, defId: 'church', progress: 9999, faction: 'player' });
    for (let i = 0; i < 3; i++) sys.update(1);
    // 两个升级都被拒（互相占格）：无升级发生、蓝图被放弃
    expect(ctx._upgrades.length).toBe(0);
    expect(ctx.buildQueue.length).toBe(0);
    // 两座 campfire 归属完好：各自 main 格仍指向自己
    const aMain = ctx.world.getBuilding(ax, ay)!.def.id;
    const bMain = ctx.world.getBuilding(ax + 1, ay)!.def.id;
    expect(aMain).toBe('campfire');
    expect(bMain).toBe('campfire');
  });

  it('升级 footprint 扩展：空旷地升级成功（旧格豁免 + 新格可建）', () => {
    const sys = attach(ctx, new BuildSystem(ctx));
    // 找一块"升级成 2×2 也全可建"的 campfire 位置（四周留白）
    let px = -1, py = -1;
    outer2:
    for (let sx = 1; sx < ctx.world.width - 2; sx++) for (let sy = 1; sy < ctx.world.height - 2; sy++) {
      const cd = ctx.buildingDef('campfire')!;
      const ch = ctx.buildingDef('church')!;
      if (ctx.world.canBuildFootprint(sx, sy, cd) && ctx.world.canBuildFootprint(sx, sy, ch)) { px = sx; py = sy; break outer2; }
    }
    expect(px).toBeGreaterThanOrEqual(0);
    ctx.world.placeBuilding(px, py, 'campfire', 'player');
    ctx.buildQueue.push({ x: px, y: py, defId: 'church', progress: 9999, faction: 'player' });
    for (let i = 0; i < 3; i++) sys.update(1);
    expect(ctx._upgrades.length).toBe(1); // 空旷地升级成功
  });
});
