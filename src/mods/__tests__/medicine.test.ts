// medicine 玩法包独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖（RimWorld 式受伤规则，2026-08-14 重构）：
//   伤口实体（部位/愈合/出血/感染）/ 自然愈合自动痊愈 / 出血失血+凝血 / 治疗=triage 处理
//   / 感染赛跑恶化+治疗回落 / 部位命中权重 / 类型封顶 / 旧档迁移
// 发现背景：旧版枚举伤口无上限堆叠 26 条 → san 恒 0 永久崩溃（30 分钟局 3/10 人）；
// 重构为 RimWorld 规则后：自然愈合让数量自我收敛，封顶兜底瞬间爆发。
import { describe, it, expect } from 'vitest';
import { makeMinCtx } from '../../sim/__tests__/helpers/minCtx';
import { MedicineSystem } from '../packs/medicine';

type Wound = { kind: 'cut' | 'bruise' | 'burn'; part: 'head' | 'torso' | 'limb'; severity: number; bleeding: boolean; infection: number };
const woundsOf = (ctx: ReturnType<typeof makeMinCtx>, eid: number): Wound[] =>
  (ctx._pawnStates.get(eid)!.extra?.wounds as Wound[] | undefined) ?? [];

const makeSys = (seed = 7) => {
  const ctx = makeMinCtx(seed);
  const sys = new MedicineSystem(ctx);
  sys.init();
  const eid = ctx.spawnPawn(10, 10);
  ctx.setHealth(eid, { hp: 100, maxHp: 100 });
  return { ctx, sys, eid };
};

describe('medicine 玩法包（RimWorld 式）', () => {
  it('自然愈合：cut 伤口随时间自动痊愈并移除（不治疗也会好）', () => {
    const { ctx, sys, eid } = makeSys();
    ctx.rng.next = () => 0.5; // 感染检定 2% 概率，override 避开（测愈合本身）
    ctx._pawnStates.get(eid)!.extra = { wounds: [{ kind: 'cut', part: 'limb', severity: 0, bleeding: false, infection: 0 }] };
    for (let i = 0; i < 60; i++) sys.update(1); // 60s 整（healTime cut = 60s）
    expect(woundsOf(ctx, eid).length).toBe(0);
    expect(ctx._log.some((l) => l.includes('痊愈'))).toBe(true);
  });

  it('出血：新 cut 失血 + 掉理智；愈合过半自然凝血后不再失血', () => {
    const { ctx, sys, eid } = makeSys();
    ctx.rng.next = () => 0.5; // 同上：避开感染检定，只测出血窗口
    ctx._pawnStates.get(eid)!.extra = { wounds: [{ kind: 'cut', part: 'limb', severity: 0, bleeding: true, infection: 0 }] };
    const hp0 = ctx.readHealth(eid)!.hp;
    const san0 = ctx.readNeeds(eid)!.san;
    for (let i = 0; i < 50; i++) sys.update(1); // 50s：前 30s 出血（autoClotAt 0.5），后 20s 凝血
    const hp1 = ctx.readHealth(eid)!.hp;
    // 前 30s：0.5/s × 30 = 15hp（limb 无部位修正）
    expect(hp0 - hp1).toBeCloseTo(15, 0);
    // 出血窗口 san 流失 0.4/s × 30 = 12；30-50s 已凝血不再掉
    expect(san0 - ctx.readNeeds(eid)!.san).toBeCloseTo(12, 0);
    // 伤口仍在（severity 0.83 未满 1 不痊愈）
    const w = woundsOf(ctx, eid)[0];
    expect(w.bleeding).toBe(false);
  });

  it('治疗成功 = 止血 + 加速愈合 + 感染回落（处理伤口不是移除）', () => {
    const { ctx, sys, eid } = makeSys();
    const st = ctx._pawnStates.get(eid)!;
    st.extra = { wounds: [{ kind: 'cut', part: 'torso', severity: 0.1, bleeding: true, infection: 0.8 }] };
    st.job = '疗伤养伤';
    // 治疗检定：minCtx 桩是 roll >= dc 且不算 bonus（与真实实现差异），测试直接
    // override 成恒成功——本测试验证的是"治疗效果语义"而非检定概率
    ctx.rollEventSkill = () => ({ success: true, roll: 1 });
    // 4s 检定间隔：跑 5s 应完成一次检定
    for (let i = 0; i < 5; i++) sys.update(1);
    const w = woundsOf(ctx, eid)[0];
    expect(w.bleeding).toBe(false);            // 止血
    expect(w.infection).toBeLessThan(0.8);     // 感染回落（-0.5）
    expect(w.severity).toBeGreaterThan(0.1);   // 愈合加速（+0.3）
    expect(ctx._log.some((l) => l.includes('处理好了'))).toBe(true);
  });

  it('感染赛跑：未处理 cut 感染度增长并持续掉血，治疗使其回落', () => {
    const { ctx, sys, eid } = makeSys();
    const st = ctx._pawnStates.get(eid)!;
    st.extra = { wounds: [{ kind: 'cut', part: 'head', severity: 0, bleeding: false, infection: 0 }] };
    const hp0 = ctx.readHealth(eid)!.hp;
    for (let i = 0; i < 60; i++) sys.update(1); // 60s：head 感染率 0.02/s → 感染度到 1（坏疽态）
    let w = woundsOf(ctx, eid)[0];
    expect(w.infection).toBe(1);              // 封顶坏疽
    expect(ctx.readHealth(eid)!.hp).toBeLessThan(hp0); // 感染掉血
    // 治疗回落
    st.job = '疗伤养伤';
    ctx.rollEventSkill = () => ({ success: true, roll: 1 });
    for (let i = 0; i < 5; i++) sys.update(1);
    w = woundsOf(ctx, eid)[0];
    expect(w.infection).toBeLessThan(0.6); // 治疗 1→0.5 + 1s 感染增长 0.02
  });

  it('部位命中权重：多次受伤中头部占比显著低于四肢', () => {
    const { ctx, sys, eid } = makeSys();
    let head = 0, total = 0;
    for (let i = 0; i < 300; i++) {
      const cur = ctx.readHealth(eid)!.hp;
      if (cur <= 6) ctx.setHealth(eid, { hp: 100, maxHp: 100 });
      ctx.setHealth(eid, { hp: ctx.readHealth(eid)!.hp - 6, maxHp: 100 });
      sys.update(0.1);
      // 模拟愈合：每步清空伤口（否则类型封顶后不再生成，样本失真）
      // 首次迭代 prevHp 无记录 → lost=0 不创建 extra，先保底建空
      const st0 = ctx._pawnStates.get(eid)!;
      st0.extra = st0.extra ?? {};
      st0.extra.wounds = [];
    }
    // 受伤日志带部位文案（封顶拒生成不记录，故按日志统计生成分布）
    for (const l of ctx._log) if (l.includes('🩸')) { total++; if (l.includes('头部')) head++; }
    expect(total).toBeGreaterThan(280); // 重置 hp 的首次掉血 lost<0 不生成（约 17 次）
    expect(head / total).toBeLessThan(0.3);  // 理论 0.1，统计宽松 0.3
  });

  it('类型封顶：cut 最多 4 条（瞬间多次咬伤不堆叠）', () => {
    const { ctx, sys, eid } = makeSys();
    const st = ctx._pawnStates.get(eid)!;
    st.extra = { wounds: Array.from({ length: 4 }, () => ({ kind: 'cut', part: 'limb', severity: 0.5, bleeding: false, infection: 0 })) };
    // 再掉 6hp 触发生成 → 第 5 条被拒
    const cur = ctx.readHealth(eid)!.hp;
    ctx.setHealth(eid, { hp: cur - 6, maxHp: 100 });
    sys.update(0.1);
    expect(woundsOf(ctx, eid).filter((w) => w.kind === 'cut').length).toBe(4);
  });

  it('旧档迁移：字符串数组 wounds 转成伤口实体', () => {
    const { ctx, sys, eid } = makeSys();
    const st = ctx._pawnStates.get(eid)!;
    st.extra = { wounds: ['bleed', 'bruise'] };
    sys.update(0.1); // 读取触发迁移
    const w = woundsOf(ctx, eid);
    expect(w.length).toBe(2);
    expect(w[0]).toMatchObject({ kind: 'cut', bleeding: true });
    expect(w[1]).toMatchObject({ kind: 'bruise', bleeding: false });
  });
});