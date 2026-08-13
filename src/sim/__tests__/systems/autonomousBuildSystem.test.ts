// autonomousBuildSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：无篝火 → 自动规划建篝火 / 已有篝火不重复建 / 木材不足不规划
import { describe, it, expect, beforeEach } from 'vitest';
import { AutonomousBuildSystem } from '../../systems/autonomousBuildSystem';
import { makeMinCtx } from '../helpers/minCtx';

describe('AutonomousBuildSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(16);
  beforeEach(() => { ctx = makeMinCtx(16); });

  it('营地无篝火 + 资源足 → 自动规划 campfire 蓝图', () => {
    const sys = new AutonomousBuildSystem(ctx);
    const t = ctx.tuning.autobuild;
    ctx.stockpile.wood = 999;
    const ctx2 = makeMinCtx(16, { rng: { next: () => 0.01, int: () => 0 } as never });
    ctx2.stockpile.wood = 999;
    const sys2 = new AutonomousBuildSystem(ctx2);
    // 跑过首个评估周期
    for (let i = 0; i < Math.ceil(t.evaluateMax) + 2; i++) sys2.update(1);
    const campfirePlans = ctx2.buildQueue.filter((b) => b.defId === 'campfire');
    expect(campfirePlans.length).toBeGreaterThanOrEqual(1);
  });

  it('已有篝火 → 不重复规划 campfire（评估 need=false）', () => {
    // 先放一个 campfire
    for (let x = 1; x < ctx.world.width; x++) for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.placeBuilding(x, y, 'campfire', 'player')) break;
    }
    const ctx2 = makeMinCtx(16, { rng: { next: () => 0.01, int: () => 0 } as never });
    for (let x = 1; x < ctx2.world.width; x++) for (let y = 1; y < ctx2.world.height; y++) {
      if (ctx2.world.placeBuilding(x, y, 'campfire', 'player')) break;
    }
    ctx2.stockpile.wood = 999;
    const sys2 = new AutonomousBuildSystem(ctx2);
    const t = ctx2.tuning.autobuild;
    for (let i = 0; i < Math.ceil(t.evaluateMax) + 2; i++) sys2.update(1);
    const campfirePlans = ctx2.buildQueue.filter((b) => b.defId === 'campfire');
    expect(campfirePlans.length).toBe(0); // 已有不建
  });

  it('木材不足 → 不规划（minWood 门槛）', () => {
    const ctx2 = makeMinCtx(16, { rng: { next: () => 0.01, int: () => 0 } as never });
    ctx2.stockpile.wood = 0;
    const sys2 = new AutonomousBuildSystem(ctx2);
    const t = ctx2.tuning.autobuild;
    for (let i = 0; i < Math.ceil(t.evaluateMax) + 2; i++) sys2.update(1);
    expect(ctx2.buildQueue.length).toBe(0);
  });
});
