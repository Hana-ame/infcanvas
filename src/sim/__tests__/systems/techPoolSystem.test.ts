// techPoolSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：按池间隔抽卡解锁 / 已全解锁不再抽
import { describe, it, expect, beforeEach } from 'vitest';
import { TechPoolSystem } from '../../systems/techPoolSystem';
import { makeMinCtx } from '../helpers/minCtx';
import { TECH_ORDER } from '../../defs/techs';

describe('TechPoolSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(12);
  beforeEach(() => { ctx = makeMinCtx(12); });

  it('池间隔后按概率解锁下一张科技（TECH_ORDER 顺序）', () => {
    const sys = new TechPoolSystem(ctx);
    const t = ctx.tuning.tech;
    // 固定 rng 让 rng.next() < poolChance 命中
    const ctx2 = makeMinCtx(99, {
      rng: { next: () => 0.01, int: () => 0 } as never, // 必中
    });
    const sys2 = new TechPoolSystem(ctx2);
    for (let i = 0; i < Math.ceil(t.poolInterval) + 2; i++) sys2.update(1);
    expect(ctx2._unlockedTechs.length).toBeGreaterThanOrEqual(1);
    expect(TECH_ORDER).toContain(ctx2._unlockedTechs[0]);
  });

  it('池间隔后 rng 不命中 → 不解锁（等待下一轮）', () => {
    const ctx2 = makeMinCtx(99, {
      rng: { next: () => 0.999, int: () => 0 } as never, // 必不中
    });
    const sys2 = new TechPoolSystem(ctx2);
    const t = ctx2.tuning.tech;
    for (let i = 0; i < Math.ceil(t.poolInterval) + 2; i++) sys2.update(1);
    expect(ctx2._unlockedTechs.length).toBe(0);
  });

  it('科技全解锁 → 不再解锁', () => {
    const ctx2 = makeMinCtx(99, { rng: { next: () => 0.01, int: () => 0 } as never });
    const sys2 = new TechPoolSystem(ctx2);
    const t = ctx2.tuning.tech;
    // 全解锁
    for (const id of TECH_ORDER) ctx2.techs.add(id);
    for (let i = 0; i < Math.ceil(t.poolInterval) + 2; i++) sys2.update(1);
    expect(ctx2._unlockedTechs.length).toBe(0);
  });
});
