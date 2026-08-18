// beginHeal 公共疗伤动作独立测试（2026-08-16 架构优化：双疗伤路径收敛）
// 背景：cardSystem 内核 heal 卡与 medicine treat 卡执行器原为同构复制，收敛为单一
// 实现（systems/heal.ts）。本测试锁定 helper 语义（有篝火/无篝火两分支）——
// 两调用方的行为一致性由各自现有套件回归（sim.test heal 卡路径、medicine.test treat 路径）。
import { describe, it, expect } from 'vitest';
import { makeMinCtx } from '../helpers/minCtx';
import { beginHeal } from '../../systems/heal';

// 找一块可建 campfire 的格（heal tag 建筑）
function placeCampfire(ctx: ReturnType<typeof makeMinCtx>): { x: number; y: number } {
  for (let x = 1; x < ctx.world.width; x++) {
    for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.canBuildFootprint(x, y, ctx.buildingDef('campfire')!)) {
        expect(ctx.world.placeBuilding(x, y, 'campfire', 'player')).toBe(true);
        return { x, y };
      }
    }
  }
  throw new Error('无可建篝火位置');
}

describe('beginHeal（共享疗伤动作，双路径唯一实现）', () => {
  it('有 heal tag 篝火 → healTarget 锁定 + moveAdjacent 走向篝火', () => {
    const ctx = makeMinCtx(21);
    const fire = placeCampfire(ctx);
    const eid = ctx.spawnPawn(fire.x + 3, fire.y + 3);
    const st = ctx._pawnStates.get(eid)!;
    beginHeal(ctx, eid, st);
    // 锁定治疗点（坐标 = 篝火主格）且 moveAdjacent 桩直接把人送到火旁
    expect(st.healTarget).toEqual({ x: fire.x, y: fire.y });
    expect(ctx.readPosition(eid)).toEqual({ x: fire.x, y: fire.y });
    // 不进入原地休养会话
    expect(st.healing).toBeUndefined();
  });

  it('无篝火 → 原地休养会话（healing = { progress: 0 }，不设 healTarget）', () => {
    const ctx = makeMinCtx(21);
    const eid = ctx.spawnPawn(30, 30);
    const st = ctx._pawnStates.get(eid)!;
    beginHeal(ctx, eid, st);
    expect(st.healTarget).toBeUndefined();
    expect(st.healing).toEqual({ progress: 0 });
    // 位置不动（没有火可去）
    expect(ctx.readPosition(eid)).toEqual({ x: 30, y: 30 });
  });

  it('重复调用不残留双态：healTarget 刷新同一治疗点，healing 不叠加', () => {
    // 决策循环每帧可能重发疗伤动作；真实移动是异步寻路（人走在路上），minCtx 桩
    // moveAdjacent 会瞬移——站在火格上 findNearest 不扫自身格（r 从 1 起）找不到"别的
    // 火"，故测前把人放回远处模拟"在路上再决策"
    const ctx = makeMinCtx(21);
    const fire = placeCampfire(ctx);
    const eid = ctx.spawnPawn(fire.x + 3, fire.y + 3);
    const st = ctx._pawnStates.get(eid)!;
    beginHeal(ctx, eid, st);
    ctx.setPosition(eid, { x: fire.x + 4, y: fire.y + 4 });
    beginHeal(ctx, eid, st);
    expect(st.healTarget).toEqual({ x: fire.x, y: fire.y }); // 同一治疗点，无漂移
    expect(st.healing).toBeUndefined(); // 不残留原地休养双态
  });
});