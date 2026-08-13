// eventSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：定时 roll 事件（脚本池）/ 条件不满足不进池 / cooldown 防连发
import { describe, it, expect, beforeEach } from 'vitest';
import { EventSystem, type ScriptedEvent } from '../../systems/eventSystem';
import { makeMinCtx } from '../helpers/minCtx';

describe('EventSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(15);
  beforeEach(() => { ctx = makeMinCtx(15); });

  const scripts: ScriptedEvent[] = [
    { id: 'storm', name: '暴风雨', weight: 1, run: (c) => { c.stockpile.food = (c.stockpile.food ?? 0) + 5; } },
  ];

  it('间隔后触发事件（run 生效 + event_happened 广播）', () => {
    const t = ctx.tuning.event;
    const ctx2 = makeMinCtx(15, { rng: { next: () => 0.01, int: () => 0 } as never });
    // 加固：用 bus 事件计数断言触发次数（原先断言私有字段 lastTrigger，与实现耦合）
    let happened = 0;
    ctx2.bus.on('event_happened', () => { happened++; });
    const sys2 = new EventSystem(ctx2, scripts);
    for (let i = 0; i < Math.ceil(t.interval) + 2; i++) sys2.update(1);
    expect((ctx2.stockpile.food ?? 0)).toBeGreaterThanOrEqual(5); // run 副作用生效
    // 精确次数：timer 初值 0 → 第 1 帧即触发一次，重置为 interval + floor(next()*jitter) = 45 + 0 = 45，
    // 故第 46 帧触发第二次。若 tuning.jitter 配置变化导致进位（floor 非 0）则此断言会暴露（配置即契约）。
    expect(happened).toBe(2);
  });

  it('minTime 未到 → 事件不进候选池（不触发）', () => {
    const scripts2: ScriptedEvent[] = [
      { id: 'late', name: '后期事件', weight: 1, minTime: 10000, run: () => {} },
    ];
    const ctx2 = makeMinCtx(15, { rng: { next: () => 0.01, int: () => 0 } as never });
    let happened = 0;
    ctx2.bus.on('event_happened', () => { happened++; });
    const sys2 = new EventSystem(ctx2, scripts2);
    const t = ctx2.tuning.event;
    for (let i = 0; i < Math.ceil(t.interval) + 2; i++) sys2.update(1);
    expect(happened).toBe(0);
  });

  it('cooldown：触发后冷却期内不再触发', () => {
    const scripts2: ScriptedEvent[] = [
      { id: 'cd', name: '冷却事件', weight: 1, cooldown: 1000, run: () => {} },
    ];
    const ctx2 = makeMinCtx(15, { rng: { next: () => 0.01, int: () => 0 } as never });
    let happened = 0;
    ctx2.bus.on('event_happened', () => { happened++; });
    const sys2 = new EventSystem(ctx2, scripts2);
    const t = ctx2.tuning.event;
    for (let i = 0; i < Math.ceil(t.interval) + 2; i++) sys2.update(1);
    expect(happened).toBe(1); // 触发一次
    for (let i = 0; i < Math.ceil(t.interval) * 3 + 2; i++) sys2.update(1);
    expect(happened).toBe(1); // 冷却期内不再触发
  });
});
