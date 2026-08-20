// techPoolSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：按池间隔抽碎片发放 / 概率不命中不抽 / 全解锁后不再抽。
// 碎片制（2026-08-14）：每抽 grantTechFragment（攒满解锁由 sim 层负责——见 techs.test.ts；
// minCtx 桩只记录发放，不在桩层复制攒集逻辑）。
import { describe, it, expect, beforeEach } from 'vitest';
import { TechPoolSystem } from '../../systems/techPoolSystem';
import { makeMinCtx } from '../helpers/minCtx';
import { TECH_ORDER } from '../../defs/techs';

describe('TechPoolSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(12);
  beforeEach(() => { ctx = makeMinCtx(12); });

  it('池间隔后按概率发碎片（加权抽候选池 → grantTechFragment）', () => {
    // 桩 rng：next 必中（< poolChance）；weightedPick 取候选第一（rank 最小）
    const ctx2 = makeMinCtx(99, {
      rng: { next: () => 0.01, int: () => 0, weightedPick: (pool: unknown[]) => pool[0] } as never,
    });
    const sys2 = new TechPoolSystem(ctx2);
    const t = ctx2.tuning.tech;
    for (let i = 0; i < Math.ceil(t.poolInterval) + 2; i++) sys2.update(1);
    expect(ctx2._fragments.length).toBeGreaterThanOrEqual(1); // 碎片已发放
    expect(TECH_ORDER).toContain(ctx2._fragments[0]);
  });

  it('池间隔后 rng 不命中 → 不发碎片（等待下一轮）', () => {
    const ctx2 = makeMinCtx(99, {
      rng: { next: () => 0.999, int: () => 0, weightedPick: (pool: unknown[]) => pool[0] } as never, // 必不中
    });
    const sys2 = new TechPoolSystem(ctx2);
    const t = ctx2.tuning.tech;
    for (let i = 0; i < Math.ceil(t.poolInterval) + 2; i++) sys2.update(1);
    expect(ctx2._fragments.length).toBe(0);
  });

  it('科技全解锁 → 不再抽碎片', () => {
    const ctx2 = makeMinCtx(99, { rng: { next: () => 0.01, int: () => 0, weightedPick: (pool: unknown[]) => pool[0] } as never });
    const sys2 = new TechPoolSystem(ctx2);
    const t = ctx2.tuning.tech;
    // 全解锁
    for (const id of TECH_ORDER) ctx2.techs.add(id);
    for (let i = 0; i < Math.ceil(t.poolInterval) + 2; i++) sys2.update(1);
    expect(ctx2._fragments.length).toBe(0);
  });
});
