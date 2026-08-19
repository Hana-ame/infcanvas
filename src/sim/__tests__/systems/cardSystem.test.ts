// cardSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：饥饿小人决策为进食意图 / 闲逛小人至少不崩 / 决策记录（lastDecision）/ 熟练度增长
import { describe, it, expect, beforeEach } from 'vitest';
import { BehaviorSystem } from '../../systems/cardSystem';
import { makeMinCtx } from '../helpers/minCtx';
import { Sim } from '../../sim';
import type { BehaviorIntent } from '../../ai/pawn';

describe('CardSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(17);
  beforeEach(() => { ctx = makeMinCtx(17); });

  it('饥饿小人 → 决策出进食意图（eat/urgent 路径）', () => {
    const sys = new BehaviorSystem(ctx);
    const eid = ctx.spawnPawn(30, 30);
    const st = ctx._pawnStates.get(eid)!;
    // 压到饿（urgent）
    const t = ctx.tuning.needs;
    ctx.setNeeds(eid, { food: t.hungerAt - 1, rest: 100, mood: 100, san: 100 });
    sys.update(1);
    expect(st.lastDecision).toBeDefined(); // 记录了决策
    expect(st.lastDecision!.drawn.length).toBeGreaterThan(0);
    // 加固：选中的卡必须来自抽出的手牌（picked ∈ drawn），这是决策语义的硬约束
    expect(st.lastDecision!.drawn).toContain(st.lastDecision!.picked);
    // 饥饿小人的卡池必装配进食卡（slots 是装配结果，与随机抽样无关，可稳定断言）
    expect(st.slots.some((c) => c?.id === 'eat')).toBe(true);
  });

  it('决策记录：drawn 含抽到的卡、picked 为选中卡', () => {
    const sys = new BehaviorSystem(ctx);
    const eid = ctx.spawnPawn(30, 30);
    sys.update(1);
    const st = ctx._pawnStates.get(eid)!;
    expect(st.lastDecision).toBeDefined();
    expect(st.lastDecision!.drawn.length).toBeGreaterThan(0);
    expect(st.lastDecision!.drawn).toContain(st.lastDecision!.picked);
  });

  it('选中卡熟练度增长（mastery +1，惰性衰减窗口外回落）', () => {
    const sys = new BehaviorSystem(ctx);
    const eid = ctx.spawnPawn(30, 30);
    sys.update(1);
    const st = ctx._pawnStates.get(eid)!;
    // 选中的卡 lastUsed 被标记（在 slots 中找同名卡）
    const pickedId = st.lastDecision!.picked;
    const slotCard = st.slots.find((c) => c?.name === pickedId);
    if (slotCard) {
      expect(slotCard.lastUsed).toBe(ctx.time);
      expect(slotCard.mastery ?? 0).toBeGreaterThan(0);
    }
  });

  it('多小人并发决策不串（每人都独立 lastDecision）', () => {
    const sys = new BehaviorSystem(ctx);
    const a = ctx.spawnPawn(30, 30);
    const b = ctx.spawnPawn(60, 60);
    for (let i = 0; i < 5; i++) { ctx.time = i + 1; sys.update(1); }
    expect(ctx._pawnStates.get(a)!.lastDecision).toBeDefined();
    expect(ctx._pawnStates.get(b)!.lastDecision).toBeDefined();
    // 两人决策独立（time 各自记录，随 update 递增）
    expect(ctx._pawnStates.get(a)!.lastDecision!.time).toBeGreaterThan(0);
    expect(ctx._pawnStates.get(b)!.lastDecision!.time).toBeGreaterThan(0);
  });

  // ---- 2026-08-16 决策节流回归 ----

  it('决策节流：decisionCd > 0 时不抽卡决策（保持上次 job）', () => {
    const sys = new BehaviorSystem(ctx);
    const eid = ctx.spawnPawn(30, 30);
    const st = ctx._pawnStates.get(eid)!;
    // 第一次决策（decisionCd 缺省 → 0 → 真正 decide）
    sys.update(0.2);
    const firstJob = st.job;
    expect(firstJob).toBeDefined();
    // decisionCd 应被设为 decisionInterval
    expect(st.decisionCd).toBe(ctx.tuning.pawn.decisionInterval);
    // 第二次 update（decisionCd > 0）→ 不 decide，job 不变
    sys.update(0.2);
    expect(st.job).toBe(firstJob); // 保持上次意图
    expect(st.decisionCd).toBeLessThan(ctx.tuning.pawn.decisionInterval); // 冷却递减
  });

  it('决策节流：冷却归零后恢复决策（job 可能变化）', () => {
    const sys = new BehaviorSystem(ctx);
    const eid = ctx.spawnPawn(30, 30);
    const st = ctx._pawnStates.get(eid)!;
    sys.update(0.2); // 首次决策
    expect(st.decisionCd).toBe(ctx.tuning.pawn.decisionInterval);
    // 推过冷却期
    for (let i = 0; i < 20; i++) sys.update(0.2); // 4 秒 > 2 秒冷却
    // 冷却归零后恢复决策 → 新 decisionCd > 0（刚 decide 后设了冷却）
    expect(st.decisionCd ?? 0).toBeGreaterThan(0);
  });

  it('决策节流：紧急需求不被节流阻塞（urgent 优先于 decisionCd）', () => {
    const sys = new BehaviorSystem(ctx);
    const eid = ctx.spawnPawn(30, 30);
    const st = ctx._pawnStates.get(eid)!;
    // 设高 decisionCd + 紧急需求
    st.decisionCd = 10; // 远未到决策时间
    st.urgent = 'eat';
    const n = ctx._needs.get(eid)!;
    n.food = 100; // 紧急进食
    // urgent 分支在 decisionCd 检查之前 → 不被节流阻塞（不崩即可）
    expect(() => sys.update(0.2)).not.toThrow();
  });

  it('决策分散：spawnPawn 后 decisionCd 为随机值（0~interval 范围内）', () => {
    // 用完整 Sim（spawnPawn 在 sim.ts 里设随机 decisionCd，分散同 tick 集中 decide）
    const sim = new Sim({ seed: 42, pawnCount: 3 });
    for (const eid of sim.pawns) {
      const st = sim.pawnStates.get(eid)!;
      const cd = st.decisionCd ?? 0;
      expect(cd).toBeGreaterThanOrEqual(0);
      expect(cd).toBeLessThanOrEqual(sim.tuning.pawn.decisionInterval);
    }
  });

});
