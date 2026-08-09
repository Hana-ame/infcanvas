// 行为结果学习接线验证：sim.recordOutcome → leanOf 倍率 → 抽卡权重
import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { LEANS } from '../core/lean';

function makeSim(seed = 7, mods?: (m: import('../mods/registry').ModRegistry) => void) {
  return new Sim({ seed, pawnCount: 2, mods });
}

describe('lean 结果反馈接线（sim 层）', () => {
  it('recordOutcome 后 leanOf 返回倍率（>1 偏做 / <1 回避 / 初始 1）', () => {
    const sim = makeSim();
    const pawn = sim.pawnList[0];
    // 初始无经验 → 中性 1
    expect(sim.leanOf(pawn, 'chop')).toBe(1);
    // 连续采到 5 木（scale=5 → 收敛 A≈1 → exp(1)≈2.72）
    for (let i = 0; i < 20; i++) sim.recordOutcome(pawn, 'chop', 5);
    expect(sim.leanOf(pawn, 'chop')).toBeGreaterThan(1.5);
    // 连续白干 → 回避
    for (let i = 0; i < 20; i++) sim.recordOutcome(pawn, 'chop', -5);
    expect(sim.leanOf(pawn, 'chop')).toBeLessThan(0.5);
    // 其他小人不受影响（经验是 per-pawn 的）
    const other = sim.pawnList[1];
    expect(sim.leanOf(other, 'chop')).toBe(1);
  });

  it('学习参数可被 mod 覆盖（overrideTuning.card.lean）', () => {
    const sim = new Sim({
      seed: 3, pawnCount: 1,
      mods: (m) => m.overrideTuning({ card: { lean: { learnRate: 0.05, temperature: 2 } } }),
    });
    const pawn = sim.pawnList[0];
    for (let i = 0; i < 10; i++) sim.recordOutcome(pawn, 'caveMine', 3);
    // 低学习率 → 收敛慢（A 小）；高温度 → 放大照样明显
    expect(sim.leanOf(pawn, 'caveMine')).toBeGreaterThan(1);
    expect(sim.mods.tuning.card.lean.learnRate).toBe(0.05);
  });

  it('mod 可注册新行为轨道（registerLean）且不冲突', () => {
    const sim = new Sim({
      seed: 5, pawnCount: 1,
      mods: (m) => m.registerLean({ key: 'brew', label: '酿酒', scale: 4 }),
    });
    const pawn = sim.pawnList[0];
    expect(sim.leanOf(pawn, 'brew')).toBe(1);
    for (let i = 0; i < 20; i++) sim.recordOutcome(pawn, 'brew', 8);
    expect(sim.leanOf(pawn, 'brew')).toBeGreaterThan(1.5);
    // 内置表未被污染（leanStore 共享但 key 不冲突）
    expect(sim.mods.leans.brew).toEqual({ key: 'brew', label: '酿酒', scale: 4 });
    expect(LEANS.brew).toBeUndefined(); // 模块级 BUILTIN 表不受影响，注册在 registry store
  });
});