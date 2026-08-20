// 马尔可夫偏置表 + 系列→欲望映射（行为数据，数据驱动）
// MARKOV_BIAS：上一事件系列 → 本轮系列权重倍率（DESIGN §6），未列出默认 1
import type { DesireId } from '../core/desires';

export const MARKOV_BIAS: Record<string, Record<string, number>> = {
  work:    { leisure: 1.6, physio: 1.4 },   // 干完活想歇
  combat:  { physio: 1.6, work: 1.2 },      // 打完想缓、也容易上头继续干活
  physio:  { work: 1.5, leisure: 1.2 },     // 吃饱睡足想动
  leisure: { work: 1.4 },                    // 闲够了想干点正事
  religion:{ work: 1.2, physio: 1.1 },      // 祈祷完心安
  social:  { leisure: 1.4 },
};

// 系列默认欲望映射（卡未声明 desire 字段时的兜底；mod 新系列可 registerSeriesDesire）
export const SERIES_TO_DESIRE: Record<string, DesireId> = {
  physio: 'gluttony',
  leisure: 'sloth',
  work: 'greed',
  combat: 'wrath',
  religion: 'pride',
};