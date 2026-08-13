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
});
