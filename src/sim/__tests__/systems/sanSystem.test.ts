// sanSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：目睹死亡理智冲击（POW 抗压）/ 低理智狂乱 / 篝火附近休息恢复理智
import { describe, it, expect, beforeEach } from 'vitest';
import { SanSystem } from '../../systems/sanSystem';
import { makeMinCtx, attach } from '../helpers/minCtx';

describe('SanSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(3);
  beforeEach(() => { ctx = makeMinCtx(3); });

  it('目睹死亡：附近小人 san 与 mood 受创（bus 事件驱动）', () => {
    const sys = attach(ctx, new SanSystem(ctx));
    const eid = ctx.spawnPawn(20, 20);
    const eid2 = ctx.spawnPawn(80, 80); // 远处的不受影响
    const t = ctx.tuning.san;
    ctx.bus.emit({ type: 'pawn_died', eid: 999, x: 21, y: 21, cause: 'combat' } as never);
    const n1 = ctx._needs.get(eid)!;
    const n2 = ctx._needs.get(eid2)!;
    expect(n1.san).toBeLessThan(100);
    expect(n1.mood).toBeLessThan(100);
    expect(n2.san).toBe(100); // 距离 witnessRadius 之外无影响
    expect(t.witnessRadius).toBeGreaterThan(0); // 阈值存在
  });

  it('饿死/战死触发理智冲击；老死不触发', () => {
    const sys = attach(ctx, new SanSystem(ctx));
    const eid = ctx.spawnPawn(20, 20);
    ctx.bus.emit({ type: 'pawn_died', eid: 999, x: 21, y: 21, cause: 'starvation' } as never);
    expect(ctx._needs.get(eid)!.san).toBeLessThan(100);
    // 老死（自然死亡）不冲击
    const eid2 = ctx.spawnPawn(22, 22);
    const before = ctx._needs.get(eid2)!.san;
    ctx.bus.emit({ type: 'pawn_died', eid: 998, x: 22, y: 22, cause: 'old' } as never);
    expect(ctx._needs.get(eid2)!.san).toBe(before);
  });

  it('低理智小人狂乱：crazyCooldown 设置 / 乱跑逻辑（不动向检查）', () => {
    const sys = attach(ctx, new SanSystem(ctx));
    const eid = ctx.spawnPawn(20, 20);
    const st = ctx._pawnStates.get(eid)!;
    // 把理智压到狂乱阈值下
    const t = ctx.tuning.san;
    ctx.setNeeds(eid, { food: 100, rest: 100, mood: 100, san: t.crazyAt - 1 });
    sys.update(1);
    // 狂乱后应有冷却（狂乱乱跑防抖）
    expect(st.crazyCooldown ?? 0).toBeGreaterThan(0);
  });

  it('篝火附近休息恢复理智（读 building aura）', () => {
    const sys = attach(ctx, new SanSystem(ctx));
    const eid = ctx.spawnPawn(20, 20);
    // 先受创
    ctx.bus.emit({ type: 'pawn_died', eid: 999, x: 21, y: 21, cause: 'combat' } as never);
    const low = ctx._needs.get(eid)!.san;
    expect(low).toBeLessThan(100);
    // 在 campfire 旁休息（aura 恢复）——sanSystem 恢复逻辑在 update 里（见实现）
    let fx = 0, fy = 0;
    for (let x = 0; x < ctx.world.width && !fx; x++)
      for (let y = 0; y < ctx.world.height; y++)
        if (ctx.world.placeBuilding(x, y, 'campfire', 'player')) { fx = x; fy = y; break; }
    ctx.setPosition(eid, { x: fx, y: fy });
    // 跑一段时间应恢复
    for (let i = 0; i < 600; i++) sys.update(1);
    expect(ctx._needs.get(eid)!.san).toBeGreaterThan(low);
  });

  it('回归：崩溃者逃到篝火旁后呆着恢复，不再乱跑走开（永久崩溃死锁）', () => {
    // 发现背景：采集狩猎局 30 分钟 8/11 人永久崩溃，人在火边 4-13 格 san 恒 0——
    // handleCrazy 到火旁重置 crazyTime 后继续落下去走乱跑逻辑，永远离开火堆。
    // 修复：火旁 return（呆着等 SAN 恢复，恢复后自然解除狂乱）。
    const sys = attach(ctx, new SanSystem(ctx));
    const eid = ctx.spawnPawn(20, 20);
    const st = ctx._pawnStates.get(eid)!;
    // 找首个可放 campfire 的位置，把人放上去（fireComfortRadius 内判定火旁）
    let fx = 0, fy = 0;
    for (let x = 0; x < ctx.world.width && !fx; x++)
      for (let y = 0; y < ctx.world.height; y++)
        if (ctx.world.placeBuilding(x, y, 'campfire', 'player')) { fx = x; fy = y; break; }
    expect(fx || fy).toBeTruthy(); // 至少有一格可放
    const t = ctx.tuning.san;
    ctx.setNeeds(eid, { food: 100, rest: 100, mood: 100, san: t.crazyAt - 1 });
    ctx.setPosition(eid, { x: fx, y: fy });
    st.crazyTime = t.crazyFleeAfter + 10; // 已过逃火阈值
    const before = { ...ctx._pawnPositions.get(eid)! };
    for (let i = 0; i < 10; i++) sys.update(1);
    expect(ctx._pawnPositions.get(eid)).toEqual(before); // 不乱跑（位置不变）
    // 火旁恢复把 san 拉回狂乱阈值之上（此前会落下去乱跑走开，san 恒 ≤ crazyAt）
    expect(ctx._needs.get(eid)!.san).toBeGreaterThan(t.crazyAt);
  });

  // ---- 2026-08-16 架构优化回归：篝火缓存 ----

  it('篝火缓存：warmth 建筑在 fireComfortRadius 内恢复理智，远离不恢复', () => {
    const sys = attach(ctx, new SanSystem(ctx));
    const eid = ctx.spawnPawn(20, 20);
    // 受创
    ctx.bus.emit({ type: 'pawn_died', eid: 999, x: 21, y: 21, cause: 'combat' } as never);
    const low = ctx._needs.get(eid)!.san;
    expect(low).toBeLessThan(100);
    // 放 campfire 在远处
    let fx = 0, fy = 0;
    for (let x = 0; x < ctx.world.width && !fx; x++)
      for (let y = 0; y < ctx.world.height; y++)
        if (ctx.world.placeBuilding(x, y, 'campfire', 'player')) { fx = x; fy = y; break; }
    // pawn 远离 campfire → 不恢复
    ctx.setPosition(eid, { x: 20, y: 20 });
    sys.update(1);
    expect(ctx._needs.get(eid)!.san).toBe(low); // 远离篝火不恢复
    // pawn 到 campfire 旁 → 恢复
    ctx.setPosition(eid, { x: fx, y: fy });
    for (let i = 0; i < 60; i++) sys.update(1);
    expect(ctx._needs.get(eid)!.san).toBeGreaterThan(low);
  });

  it('篝火缓存：fireRecover fallback 恢复（campfire 无 aura.sanPerSec → 用 tuning 值）', () => {
    const sys = attach(ctx, new SanSystem(ctx));
    const eid = ctx.spawnPawn(20, 20);
    ctx.setNeeds(eid, { food: 100, rest: 100, mood: 100, san: 50 });
    let fx = 0, fy = 0;
    for (let x = 0; x < ctx.world.width && !fx; x++)
      for (let y = 0; y < ctx.world.height; y++)
        if (ctx.world.placeBuilding(x, y, 'campfire', 'player')) { fx = x; fy = y; break; }
    ctx.setPosition(eid, { x: fx, y: fy });
    sys.update(1);
    const after = ctx._needs.get(eid)!.san;
    expect(after).toBeGreaterThan(50); // fireRecover fallback 生效
  });

});
