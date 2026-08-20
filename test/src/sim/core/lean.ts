// 行为结果学习（EWA 经验加权吸引模型）—— 用户指定：结果反馈到取值权重，纯算法
// 每个行为维护"吸引力" A（期望收益记忆，0=中性无偏）：
//   recordOutcome(key, outcome)：A ← (1-φ)·A + φ·(outcome/scale)，φ=学习率
// 抽卡权重倍率 = clamp(exp(β·A))（玻尔兹曼映射），β=温度
//   收益持续为正（采到东西/吃饱）→ A↑ → 该行为权重↑；白干/受挫 → A↓ → 权重↓
// 完全数据驱动：轨道表 LEANS 在 defs/leans.ts（layer：数据），φ/β/钳制走 tuning.card.lean，mod 可扩展/覆盖

export type LeanKey = string;

export interface LeanDef {
  key: LeanKey;
  label: string;      // 行为名（日志/显示）
  scale: number;      // 结果归一化尺度：单次"典型成功结果量"，outcome/scale 进吸引力
}

// 行为轨道表（数据在 defs/leans.ts；此处 re-export 保持旧 import 兼容）
import { LEANS } from '../defs/leans';
export { LEANS };
// 学习参数（权威定义在 defs/tuning.ts；此处 re-export 保持旧 import 兼容）
import type { LeanParams } from '../defs/tuning';
export type { LeanParams };

// 初始化吸引力（中性 0 = 无偏；权重倍率 1）
export function initLean(rng?: { next(): number }): Record<LeanKey, number> {
  return initLeanBy(Object.keys(LEANS), rng);
}

// 按轨道集合初始化（数据驱动：轨道来自 defs/leans.ts 表，随 registerLean 动态增长）
export function initLeanBy(keys: Iterable<LeanKey>, rng?: { next(): number }): Record<LeanKey, number> {
  const out: Record<LeanKey, number> = {};
  for (const k of keys) out[k] = 0;
  void rng;
  return out;
}

// EWA 更新：新结果按学习率并入吸引力记忆
// outcome 是实际结果量（正=收益：采到 n 资源/恢复 n 点；负=损耗：白干/受挫）
export function recordOutcome(
  lean: Record<LeanKey, number>,
  key: LeanKey,
  outcome: number,
  def: LeanDef | undefined,
  params: LeanParams,
): void {
  if (!def) return;
  const cur = lean[key] ?? 0;
  const normalized = outcome / def.scale;
  const next = (1 - params.learnRate) * cur + params.learnRate * normalized;
  lean[key] = Math.max(-params.maxA, Math.min(params.maxA, next));
}

// 权重倍率：吸引力 → 玻尔兹曼映射 exp(β·A)，钳制 [minMul, maxMul]
// A=0（无经验）→ 1（中性，不影响抽卡权重）；A>0 → 倍率升；A<0 → 倍率降
export function weightMulOf(
  lean: Record<LeanKey, number>,
  key: LeanKey,
  def: LeanDef | undefined,
  params: LeanParams,
): number {
  if (!def) return 1;
  const a = lean[key] ?? 0;
  const mul = Math.exp(params.temperature * a);
  return Math.max(params.minMul, Math.min(params.maxMul, mul));
}