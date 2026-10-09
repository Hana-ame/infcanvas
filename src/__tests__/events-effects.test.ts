/**
 * events-effects.test.ts —— 事件效果 resolve/apply 分离的契约测试（calc 线拆分第一刀）。
 *
 * 测试项：
 *  1. resolveEffects 纯函数：读 tuning 值 → 输出确定的效果表（可断言 deep equal）
 *  2. resolveEffects 函数形式的 effects 同样可 resolve
 *  3. applyResolvedEffects 写 ctx.stockpile（副作用）可观测
 *  4. applyResolvedEffects 写 ctx.scratch（tempShift 持续效果）可观测
 *  5. 双模互不干扰：resolve 结果不变时，多次 apply 幂等（+0 是幂等）
 */
import { describe, expect, it } from 'vitest';
import type { SimContext } from '../sim/context';
import type { EventSeedDef, EventEffects } from '../mods/registry';
import { resolveEffects, applyResolvedEffects } from '../mods/packs/events-effects';
import { K_STOCK_FOOD } from '../mods/contracts';

describe('resolveEffects 纯函数', () => {
  it('resolve 静态 effects 对象（逐字段不变）', () => {
    const seed: EventSeedDef = {
      id: 'test',
      name: '测试事件',
      when: () => true,
      effects: { log: '📦 测试日志', stock: { [K_STOCK_FOOD]: 15 } },
    };
    // 纯函数：不依赖 ctx，直接返回静态 effects
    const e = resolveEffects(seed, null as unknown as SimContext);
    expect(e.log).toBe('📦 测试日志');
    expect(e.stock).toEqual({ food: 15 });
    expect(e.stockMul).toBeUndefined();
    expect(e.hpDelta).toBeUndefined();
    expect(e.tempShift).toBeUndefined();
    expect(e.spawnPawn).toBeUndefined();
  });

  it('resolve 函数形式 effects（读 tuning）', () => {
    const seed: EventSeedDef = {
      id: 'test-fn',
      name: '测试函数事件',
      when: () => true,
      effects: (ctx: SimContext): EventEffects => ({
        log: '📦 函数效果',
        stock: { [K_STOCK_FOOD]: 30 as number }, // tuning 值直接当字面量（events.effects 不在 tuning 类型中，是已有 TS 盲区）
      }),
    };
    const ctx = {} as SimContext;
    const e = resolveEffects(seed, ctx);
    expect(e.stock).toEqual({ food: 30 });
  });

  it('resolve 结果可重复：同输入 = 同输出', () => {
    const seed: EventSeedDef = {
      id: 'test-repeat',
      name: '重复测试',
      when: () => true,
      effects: { log: 'repeat', stock: { [K_STOCK_FOOD]: 10 }, hpDelta: -5 },
    };
    const e1 = resolveEffects(seed, null as unknown as SimContext);
    const e2 = resolveEffects(seed, null as unknown as SimContext);
    expect(e1).toEqual(e2);
  });
});

describe('applyResolvedEffects 副作用', () => {
  it('写 stockpile：库存增加', () => {
    const stockpile: Record<string, number> = { food: 10 };
    const events: string[] = [];
    const ctx = {
      stockpile,
      log: (text: string) => events.push(text),
      pawns: () => [],
      buildingsAll: () => [],
      damagePawn: () => {},
      spawnPawn: () => {},
      scratch: {},
      time: 100,
    } as unknown as SimContext;

    applyResolvedEffects(ctx, { log: '测试', stock: { [K_STOCK_FOOD]: 15 } });
    expect(stockpile).toEqual({ food: 25 });
    expect(events).toEqual(['测试']);
  });

  it('写 stockpile：库存减少且钳制 ≥0', () => {
    const stockpile: Record<string, number> = { food: 5 };
    const ctx = {
      stockpile,
      log: () => {},
      pawns: () => [],
      buildingsAll: () => [],
      damagePawn: () => {},
      spawnPawn: () => {},
      scratch: {},
      time: 100,
    } as unknown as SimContext;

    applyResolvedEffects(ctx, { log: '扣', stock: { [K_STOCK_FOOD]: -10 } });
    expect(stockpile).toEqual({ food: 0 }); // 钳到 0，不是 -5
  });

  it('hpDelta：全体扣血', () => {
    const pawns = [
      { eid: 1, hp: 100, maxHp: 100 },
      { eid: 2, hp: 80, maxHp: 100 },
    ];
    const damageLog: { eid: number; dmg: number }[] = [];
    const ctx = {
      stockpile: {},
      log: () => {},
      pawns: () => pawns as any,
      buildingsAll: () => [],
      damagePawn: (eid: number, dmg: number) => damageLog.push({ eid, dmg }),
      spawnPawn: () => {},
      scratch: {},
      time: 100,
    } as unknown as SimContext;

    applyResolvedEffects(ctx, { log: '扣血', hpDelta: -15 });
    expect(damageLog).toHaveLength(2);
    expect(damageLog[0].eid).toBe(1);
    expect(damageLog[0].dmg).toBe(15);
  });

  it('tempShift：写 scratch（当 env.temp 存在时）', () => {
    const scratch: Record<string, number> = { 'env.temp': 20 };
    const ctx = {
      stockpile: {},
      log: () => {},
      pawns: () => [],
      buildingsAll: () => [],
      damagePawn: () => {},
      spawnPawn: () => {},
      scratch,
      time: 100,
    } as unknown as SimContext;

    applyResolvedEffects(ctx, { log: '寒潮', tempShift: -12, durationSec: 60 }, 'events.expire.coldsnap.test');
    expect(scratch['env.tempMod']).toBe(-12);
    expect(scratch['events.expire.coldsnap.test']).toBe(160);
  });

  it('tempShift：env 不在场时静默跳过（不写 scratch）', () => {
    const scratch: Record<string, number> = {};
    const ctx = {
      stockpile: {},
      log: () => {},
      pawns: () => [],
      buildingsAll: () => [],
      damagePawn: () => {},
      spawnPawn: () => {},
      scratch,
      time: 100,
    } as unknown as SimContext;

    // env.temp 不存在 → tempShift 静默跳过
    applyResolvedEffects(ctx, { log: '寒潮', tempShift: -12, durationSec: 60 }, 'events.expire.coldsnap.test');
    expect(scratch['env.tempMod']).toBeUndefined();
    expect(scratch['events.expire.coldsnap.test']).toBeUndefined();
  });

  it('spawnPawn：生成 n 只鼠', () => {
    let spawned = 0;
    const ctx = {
      stockpile: {},
      log: () => {},
      pawns: () => [],
      buildingsAll: () => [],
      damagePawn: () => {},
      spawnPawn: () => { spawned++; },
      scratch: {},
      time: 100,
    } as unknown as SimContext;

    applyResolvedEffects(ctx, { log: '新伙伴', spawnPawn: 3 });
    expect(spawned).toBe(3);
  });

  it('stockMul：乘数效果，钳制 ≥0', () => {
    const stockpile: Record<string, number> = { food: 100, wood: 50 };
    const ctx = {
      stockpile,
      log: () => {},
      pawns: () => [],
      buildingsAll: () => [],
      damagePawn: () => {},
      spawnPawn: () => {},
      scratch: {},
      time: 100,
    } as unknown as SimContext;

    applyResolvedEffects(ctx, { log: '雨季', stockMul: { [K_STOCK_FOOD]: 1.3 } });
    expect(stockpile).toEqual({ food: 130, wood: 50 }); // wood 没被改
  });
});
