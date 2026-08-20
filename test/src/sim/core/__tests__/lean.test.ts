// 行为结果学习（EWA 吸引模型）单测：结果 → 权重倍率闭环
import { describe, it, expect } from 'vitest';
import {
  LEANS, initLean, recordOutcome, weightMulOf,
  type LeanDef, type LeanParams,
} from '../lean';

const PARAMS: LeanParams = {
  learnRate: 0.5,
  temperature: 1.0,
  minMul: 0.2,
  maxMul: 5,
  maxA: 3,
};

const def = (key: string): LeanDef => LEANS[key];

describe('lean EWA 吸引模型', () => {
  it('初始无经验 → 倍率 1（中性，不影响抽卡权重）', () => {
    const lean = initLean();
    expect(weightMulOf(lean, 'chop', def('chop'), PARAMS)).toBe(1);
  });

  it('持续正收益 → 吸引力上升，倍率 >1（值得做的事越做越多）', () => {
    const lean = initLean();
    for (let i = 0; i < 10; i++) recordOutcome(lean, 'chop', 5, def('chop'), PARAMS);
    // 收敛到 A = 5/5 = 1 → exp(1) ≈ 2.718
    expect(lean.chop).toBeCloseTo(1, 1);
    expect(weightMulOf(lean, 'chop', def('chop'), PARAMS)).toBeCloseTo(Math.exp(1), 1);
  });

  it('持续负收益 → 吸引力下降，倍率 <1（白干的事越做越少）', () => {
    const lean = initLean();
    for (let i = 0; i < 10; i++) recordOutcome(lean, 'mine', -3, def('mine'), PARAMS);
    expect(lean.mine).toBeCloseTo(-1, 1);
    expect(weightMulOf(lean, 'mine', def('mine'), PARAMS)).toBeLessThan(1);
  });

  it('收益平平 → 吸引力接近 0（不过度偏向）', () => {
    const lean = initLean();
    for (let i = 0; i < 10; i++) recordOutcome(lean, 'chop', 0, def('chop'), PARAMS);
    expect(Math.abs(lean.chop)).toBeLessThan(0.01);
    expect(weightMulOf(lean, 'chop', def('chop'), PARAMS)).toBeCloseTo(1, 2);
  });

  it('结果量按 scale 归一：大产出比小产出升得更快', () => {
    const a = initLean();
    const b = initLean();
    // 采到 8 木（scale=5 → 归一 1.6）vs 采到 2 木（归一 0.4）
    recordOutcome(a, 'chop', 8, def('chop'), PARAMS);
    recordOutcome(b, 'chop', 2, def('chop'), PARAMS);
    expect(a.chop).toBeGreaterThan(b.chop);
  });

  it('学习率 φ 控制记忆：φ 大反应快、φ 小记性好', () => {
    const fast = { ...PARAMS, learnRate: 0.8 };
    const slow = { ...PARAMS, learnRate: 0.1 };
    const a = initLean(); const b = initLean();
    recordOutcome(a, 'chop', 10, def('chop'), fast);
    recordOutcome(b, 'chop', 10, def('chop'), slow);
    expect(a.chop).toBeGreaterThan(b.chop);
  });

  it('温度 β 控制映射强度：β 大收益差放大更狠', () => {
    const hot = { ...PARAMS, temperature: 2 };
    const mild = { ...PARAMS, temperature: 0.5 };
    const a = initLean(); const b = initLean();
    recordOutcome(a, 'chop', 5, def('chop'), PARAMS);
    recordOutcome(b, 'chop', 5, def('chop'), PARAMS);
    expect(weightMulOf(a, 'chop', def('chop'), hot)).toBeGreaterThan(
      weightMulOf(b, 'chop', def('chop'), mild),
    );
  });

  it('钳制：吸引力封顶 maxA，倍率封顶 maxMul / 保底 minMul', () => {
    const lean = initLean();
    for (let i = 0; i < 100; i++) recordOutcome(lean, 'chop', 100, def('chop'), PARAMS);
    expect(lean.chop).toBeLessThanOrEqual(PARAMS.maxA);
    expect(weightMulOf(lean, 'chop', def('chop'), PARAMS)).toBeLessThanOrEqual(PARAMS.maxMul);
    for (let i = 0; i < 100; i++) recordOutcome(lean, 'chop', -100, def('chop'), PARAMS);
    expect(lean.chop).toBeGreaterThanOrEqual(-PARAMS.maxA);
    expect(weightMulOf(lean, 'chop', def('chop'), PARAMS)).toBeGreaterThanOrEqual(PARAMS.minMul);
  });

  it('未知行为 key → 倍率 1（未注册的卡不受学习影响）', () => {
    const lean = initLean();
    expect(weightMulOf(lean, 'nope', undefined, PARAMS)).toBe(1);
    recordOutcome(lean, 'nope', 5, undefined, PARAMS); // 不应崩溃
    expect(weightMulOf(lean, 'nope', undefined, PARAMS)).toBe(1);
  });

  it('EOA 波动：一次坏结果能把高吸引力拉下来（经验可被新结果修正）', () => {
    const lean = initLean();
    for (let i = 0; i < 5; i++) recordOutcome(lean, 'caveMine', 3, def('caveMine'), PARAMS);
    const before = lean.caveMine;
    recordOutcome(lean, 'caveMine', -3, def('caveMine'), PARAMS);
    expect(lean.caveMine).toBeLessThan(before);
  });
});