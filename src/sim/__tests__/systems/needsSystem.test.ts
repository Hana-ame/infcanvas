// needsSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：需求衰减 / 夜晚额外困 / 饥饿死亡 / 紧急需求标记 / 需求写入篝火记忆（节流）
import { describe, it, expect, beforeEach } from 'vitest';
import { NeedsSystem } from '../../systems/needsSystem';
import { makeMinCtx, attach } from '../helpers/minCtx';

describe('NeedsSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(1);
  beforeEach(() => { ctx = makeMinCtx(1); });

  it('需求随时间衰减', () => {
    const sys = attach(ctx, new NeedsSystem(ctx));
    const eid = ctx.spawnPawn(10, 10);
    // 初始满需求
    const n0 = ctx._needs.get(eid)!;
    expect(n0.food).toBe(100);
    sys.update(10);
    const n1 = ctx._needs.get(eid)!;
    expect(n1.food).toBeLessThan(100);
    expect(n1.rest).toBeLessThan(100);
  });

  it('夜晚额外消耗精力（isNight=true）', () => {
    const ctx2 = makeMinCtx(2, { isNight: () => true });
    const sys = attach(ctx2, new NeedsSystem(ctx2));
    const eid = ctx2.spawnPawn(10, 10);
    sys.update(10);
    const n1 = ctx2._needs.get(eid)!;
    // 夜晚 rest 消耗更多（对照白天：白天 10s 消耗 < 夜晚 10s 消耗）
    const ctx3 = makeMinCtx(2, { isNight: () => false });
    const sys3 = attach(ctx3, new NeedsSystem(ctx3));
    const eid3 = ctx3.spawnPawn(10, 10);
    sys3.update(10);
    const n3 = ctx3._needs.get(eid3)!;
    expect(n1.rest).toBeLessThan(n3.rest);
  });

  it('饥饿归零后持续掉血，血量归零则饿死（killPawn + pawn_died）', () => {
    const ctx2 = makeMinCtx(2, { isNight: () => false });
    const sys = attach(ctx2, new NeedsSystem(ctx2));
    const eid = ctx2.spawnPawn(10, 10);
    // 直接把需求设为 0（模拟长期没吃东西）
    ctx2.setNeeds(eid, { food: 0, rest: 100, mood: 100, san: 100 });
    let died = false;
    ctx2.bus.on('pawn_died', () => { died = true; });
    // 连续跑（饿死需要时间，快速循环）
    for (let i = 0; i < 400; i++) sys.update(1);
    expect(ctx2._killed).toContain(eid);
    expect(died).toBe(true);
  });

  it('紧急需求标记：食物极低 → urgent=eat', () => {
    const sys = attach(ctx, new NeedsSystem(ctx));
    const eid = ctx.spawnPawn(10, 10);
    // 把食物压到紧急阈值以下
    const t = ctx.tuning.needs;
    ctx.setNeeds(eid, { food: t.hungerAt - 1, rest: 100, mood: 100, san: 100 });
    sys.update(1);
    expect(ctx._pawnStates.get(eid)!.urgent).toBe('eat');
  });

  it('需求写入篝火记忆（濒死写一次，节流不刷屏）', () => {
    // 建一个 campfire 在附近（找第一个可建位置）
    let fx = 0, fy = 0, placed = false;
    for (let x = 0; x < ctx.world.width && !placed; x++) {
      for (let y = 0; y < ctx.world.height && !placed; y++) {
        if (ctx.world.placeBuilding(x, y, 'campfire', 'player')) { fx = x; fy = y; placed = true; }
      }
    }
    expect(placed).toBe(true);
    const key = fy * ctx.world.width + fx;
    // 记录 addMemory 调用
    const mems: string[] = [];
    ctx.socialUnits.addMemory = (_key: number, text: string) => { mems.push(text); };
    const sys = attach(ctx, new NeedsSystem(ctx));
    const eid = ctx.spawnPawn(fx + 1, fy); // 站在 campfire 旁
    ctx.setNeeds(eid, { food: 10, rest: 100, mood: 100, san: 100 }); // 濒死
    sys.update(1);
    expect(mems.length).toBe(1);
    expect(mems[0]).toContain('饥饿难耐');
    // 再跑一次（状态不变）不重复写
    sys.update(1);
    expect(mems.length).toBe(1);
  });
});
