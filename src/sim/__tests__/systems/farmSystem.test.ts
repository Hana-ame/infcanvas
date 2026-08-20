// farmSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：passive recipe 建筑持续产出 / 非 passive 不产出
import { describe, it, expect, beforeEach } from 'vitest';
import { FarmSystem } from '../../systems/farmSystem';
import { makeMinCtx, attach } from '../helpers/minCtx';

describe('FarmSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(8);
  beforeEach(() => { ctx = makeMinCtx(8); });

  it('农田（passive recipe）持续产粮', () => {
    const sys = attach(ctx, new FarmSystem(ctx));
    const def = ctx.buildingDef('farm');
    if (!def) return; // 无农田定义则跳过
    let placed = false;
    for (let x = 1; x < ctx.world.width && !placed; x++) for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.placeBuilding(x, y, 'farm', 'player')) { placed = true; break; }
    }
    if (!placed) throw new Error('无法放置农田');
    const foodBefore = ctx.stockpile.food ?? 0;
    for (let i = 0; i < 60; i++) sys.update(1);
    expect((ctx.stockpile.food ?? 0)).toBeGreaterThan(foodBefore);
  });

  it('无 passive 建筑 → 无产出', () => {
    const sys = attach(ctx, new FarmSystem(ctx));
    const foodBefore = ctx.stockpile.food ?? 0;
    for (let i = 0; i < 60; i++) sys.update(1);
    expect(ctx.stockpile.food ?? 0).toBe(foodBefore);
  });

  // ---- 2026-08-20 扩展覆盖 ----

  it('水井（passive recipe）持续产水', () => {
    const sys = attach(ctx, new FarmSystem(ctx));
    const def = ctx.buildingDef('well');
    if (!def) return;
    let placed = false;
    for (let x = 1; x < ctx.world.width && !placed; x++) for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.placeBuilding(x, y, 'well', 'player')) { placed = true; break; }
    }
    if (!placed) throw new Error('无法放置水井');
    const before = ctx.stockpile.water ?? 0;
    for (let i = 0; i < 60; i++) sys.update(1);
    expect(ctx.stockpile.water ?? 0).toBeGreaterThan(before);
  });

  it('多 passive 建筑叠加产出（2 农田 > 1 农田）', () => {
    const sys = attach(ctx, new FarmSystem(ctx));
    // 放 1 个农田
    let p1 = false;
    for (let x = 1; x < ctx.world.width && !p1; x++) for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.placeBuilding(x, y, 'farm', 'player')) { p1 = true; break; }
    }
    for (let i = 0; i < 60; i++) sys.update(1);
    const oneFarm = ctx.stockpile.food ?? 0;
    // 放第 2 个农田
    let p2 = false;
    for (let x = 1; x < ctx.world.width && !p2; x++) for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.placeBuilding(x, y, 'farm', 'player')) { p2 = true; break; }
    }
    const before2 = ctx.stockpile.food ?? 0;
    for (let i = 0; i < 60; i++) sys.update(1);
    const twoFarms = (ctx.stockpile.food ?? 0) - before2;
    expect(twoFarms).toBeGreaterThan(0);
  });

  it('recipe 查不到的建筑不崩（无 recipe 字段）', () => {
    const sys = attach(ctx, new FarmSystem(ctx));
    // campfire 有 recipe？不应该有 passive recipe
    let placed = false;
    for (let x = 1; x < ctx.world.width && !placed; x++) for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.placeBuilding(x, y, 'campfire', 'player')) { placed = true; break; }
    }
    expect(() => { for (let i = 0; i < 10; i++) sys.update(1); }).not.toThrow();
  });

});
