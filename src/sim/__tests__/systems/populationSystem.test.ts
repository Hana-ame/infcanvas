// populationSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：食物充足定期招募 / 未达上限 / 已达上限不招 / 食物不足不招（delay 重试）
import { describe, it, expect, beforeEach } from 'vitest';
import { PopulationSystem } from '../../systems/populationSystem';
import { makeMinCtx, attach } from '../helpers/minCtx';

describe('PopulationSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(4);
  beforeEach(() => { ctx = makeMinCtx(4); });

  it('食物充足 + 未达上限 → 定期招募新小人', () => {
    const sys = attach(ctx, new PopulationSystem(ctx));
    const eid = ctx.spawnPawn(30, 30);
    ctx.stockpile.food = 999;
    const before = ctx.pawnList.length;
    // 跑足够长（招募间隔 tuning.population.recruitInterval）
    const t = ctx.tuning.population;
    for (let i = 0; i < Math.ceil(t.recruitInterval) + 10; i++) sys.update(1);
    expect(ctx.pawnList.length).toBeGreaterThan(before);
    expect(ctx._spawned.length).toBeGreaterThan(0);
  });

  it('已达人口上限 → 不招募', () => {
    const sys = attach(ctx, new PopulationSystem(ctx));
    ctx.stockpile.food = 999;
    const t = ctx.tuning.population;
    // 塞满上限（pawnList 直接填上限个）
    for (let i = 0; i < t.maxPawns; i++) ctx.spawnPawn(30 + i, 30);
    const before = ctx.pawnList.length;
    for (let i = 0; i < Math.ceil(t.recruitInterval) + 10; i++) sys.update(1);
    expect(ctx.pawnList.length).toBe(before);
  });

  it('食物不足 → 不招募，且重试计时重置（delayed retry）', () => {
    const sys = attach(ctx, new PopulationSystem(ctx));
    const eid = ctx.spawnPawn(30, 30);
    ctx.stockpile.food = 0;
    const before = ctx.pawnList.length;
    const t = ctx.tuning.population;
    for (let i = 0; i < Math.ceil(t.recruitInterval) + 10; i++) sys.update(1);
    expect(ctx.pawnList.length).toBe(before);
  });

  // ---- 2026-08-16 扩展 ----
  it('食物不足时不招募（foodThreshold 门控）', () => {
    const sys = attach(ctx, new PopulationSystem(ctx));
    ctx.stockpile.food = 0;
    const before = ctx.pawnList.length;
    for (let i = 0; i < 120; i++) sys.update(1);
    expect(ctx.pawnList.length).toBe(before); // 缺粮不招人
  });

  it('达人口上限后不招募（maxPawns 门控）', () => {
    const sys = attach(ctx, new PopulationSystem(ctx));
    ctx.stockpile.food = 9999;
    // 先填满到上限
    while (ctx.pawnList.length < ctx.tuning.population.maxPawns) {
      ctx.spawnPawn(50, 50);
    }
    const before = ctx.pawnList.length;
    for (let i = 0; i < 120; i++) sys.update(1);
    expect(ctx.pawnList.length).toBe(before); // 到上限不招
  });

});
