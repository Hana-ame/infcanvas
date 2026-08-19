// repairSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：受损建筑 → 小人自动修复（hp 恢复）/ 无损建筑不派活
import { describe, it, expect, beforeEach } from 'vitest';
import { RepairSystem } from '../../systems/repairSystem';
import { makeMinCtx, attach } from '../helpers/minCtx';

describe('RepairSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(9);
  beforeEach(() => { ctx = makeMinCtx(9); });

  function placeCampfire(): { x: number; y: number } {
    for (let x = 1; x < ctx.world.width; x++) for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.placeBuilding(x, y, 'campfire', 'player')) return { x, y };
    }
    throw new Error('无法放置 campfire');
  }

  it('受损建筑 → 空闲小人走过去修好（hp 恢复）', () => {
    const sys = new RepairSystem(ctx);
    const { x, y } = placeCampfire();
    // 打掉一半血
    ctx.world.damageBuilding(x, y, 50);
    const before = ctx.world.getBuilding(x, y)!.hp;
    expect(before).toBeLessThan(ctx.world.getBuilding(x, y)!.def.hp);
    // 放一个空闲小人
    const eid = ctx.spawnPawn(x + 1, y + 1);
    const st = ctx._pawnStates.get(eid)!;
    st.job = '闲逛';
    // 第一帧：派活（移动到目标附近或直接开修）
    sys.update(1);
    const t = ctx.tuning.repair;
    // 无论 inPlaceDist 是否命中，修完需要 workTime 秒（推进 repairing）
    for (let i = 0; i < Math.ceil(t.workTime) + 2; i++) sys.update(1);
    expect(ctx.world.getBuilding(x, y)!.hp).toBeGreaterThan(before);
  });

  it('无受损建筑 → 不派活（job 保持闲逛）', () => {
    const sys = new RepairSystem(ctx);
    const { x, y } = placeCampfire();
    const eid = ctx.spawnPawn(x + 1, y + 1);
    const st = ctx._pawnStates.get(eid)!;
    st.job = '闲逛';
    for (let i = 0; i < 10; i++) sys.update(1);
    expect(st.job).toBe('闲逛');
  });

  // ---- 2026-08-16 扩展 ----
  it('满血建筑不修（无开销）', () => {
    const sys = attach(ctx, new RepairSystem(ctx));
    let fx = 0, fy = 0;
    for (let x = 1; x < ctx.world.width && !fx; x++) for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.placeBuilding(x, y, 'campfire', 'player')) { fx = x; fy = y; break; }
    }
    const woodBefore = ctx.stockpile.wood ?? 0;
    for (let i = 0; i < 60; i++) sys.update(1);
    expect(ctx.stockpile.wood ?? 0).toBe(woodBefore); // 满血不修 = 不扣木
  });

  it('征召中鼠不触发修理（战术命令优先）', () => {
    const sys = attach(ctx, new RepairSystem(ctx));
    const eid = ctx.spawnPawn(50, 50);
    const st = ctx.pawnStates.get(eid)!;
    st.extra = { ...(st.extra ?? {}), drafted: true };
    let fx = 0, fy = 0;
    for (let x = 1; x < ctx.world.width && !fx; x++) for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.placeBuilding(x, y, 'campfire', 'player')) { fx = x; fy = y; break; }
    }
    ctx.world.damageBuilding(fx, fy, 20);
    const woodBefore = ctx.stockpile.wood ?? 0;
    for (let i = 0; i < 60; i++) sys.update(1);
    expect(ctx.stockpile.wood ?? 0).toBe(woodBefore); // 征召中不修
  });

});
