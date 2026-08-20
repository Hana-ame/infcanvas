// desireSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：欲望衰减 / 匮乏 → 心情降 / 嫉妒满足（更强同伴 → envy 满足）
import { describe, it, expect, beforeEach } from 'vitest';
import { DesireSystem } from '../../systems/desireSystem';
import { makeMinCtx } from '../helpers/minCtx';

describe('DesireSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(11);
  beforeEach(() => { ctx = makeMinCtx(11); });

  it('欲望随时间衰减', () => {
    const sys = new DesireSystem(ctx);
    const eid = ctx.spawnPawn(20, 20);
    const st = ctx._pawnStates.get(eid)!;
    st.desires = { gluttony: 50, sloth: 50, greed: 50, wrath: 50, envy: 50, pride: 50, lust: 50 };
    sys.update(1); // 一帧不触发（checkInterval 累计）
    const t = ctx.tuning.desire;
    for (let i = 0; i < Math.ceil(t.checkInterval) + 2; i++) sys.update(1);
    // 衰减后任一欲望低于初始
    const after = st.desires!;
    expect(Object.values(after).some((v) => v < 50)).toBe(true);
  });

  it('欲望普遍匮乏 → 心情下降（adjustMood 负值）', () => {
    const sys = new DesireSystem(ctx);
    const eid = ctx.spawnPawn(20, 20);
    const st = ctx._pawnStates.get(eid)!;
    // 全部压到 0（critical 匮乏）
    st.desires = { gluttony: 0, sloth: 0, greed: 0, wrath: 0, envy: 0, pride: 0, lust: 0 };
    const t = ctx.tuning.desire;
    for (let i = 0; i < Math.ceil(t.checkInterval) + 2; i++) sys.update(1);
    // 心情被调低（至少有一次负向 adjustMood）
    const deltas = [...ctx._moodAdj.values()];
    expect(deltas.some((d) => d < 0)).toBe(true);
  });

  it('嫉妒满足：工作完成且存在比自己技能高的同伴 → envy 满足（bus work_completed）', () => {
    const sys = new DesireSystem(ctx);
    sys.init(ctx.bus);
    const weak = ctx.spawnPawn(20, 20);
    const strong = ctx.spawnPawn(25, 25);
    const stWeak = ctx._pawnStates.get(weak)!;
    const stStrong = ctx._pawnStates.get(strong)!;
    stWeak.desires = { gluttony: 50, sloth: 50, greed: 50, wrath: 50, envy: 0, pride: 50, lust: 50 };
    stStrong.desires = { gluttony: 50, sloth: 50, greed: 50, wrath: 50, envy: 50, pride: 50, lust: 50 };
    // 强者技能更高
    stStrong.skills = { work: 80 };
    stWeak.skills = { work: 10 };
    ctx.bus.emit({ type: 'work_completed', eid: weak, work: 'chop', success: true, x: 20, y: 20 } as never);
    expect(stWeak.desires!.envy).toBeGreaterThan(0); // 嫉妒满足上升
  });
});
