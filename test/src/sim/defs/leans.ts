// 行为学习轨道表（EWA 吸引模型）—— 迁自 core/lean.ts 的数据表
// scale = 该行为一次"典型成功结果量"，结果量/scale 进吸引力记忆（mod 可 registerLean/overrideLean）
import type { LeanKey, LeanDef } from '../core/lean';

export type { LeanKey, LeanDef } from '../core/lean';

// 学习轨道表（消费方：core/lean.ts 把行为每次结果量 / scale 归一化为吸引力记忆，
// 再经 tuning.card.lean（φ/β/钳制）合成权重倍率；卡 id 即轨道 key）
export const LEANS: Record<LeanKey, LeanDef> = {
  chop:     { key: 'chop', label: '伐木', scale: 5 },
  mine:     { key: 'mine', label: '采矿', scale: 3 },
  caveMine: { key: 'caveMine', label: '矿洞采掘', scale: 3 },
  build:    { key: 'build', label: '建造', scale: 1 },
  eat:      { key: 'eat', label: '进食', scale: 40 },
  rest:     { key: 'rest', label: '休息', scale: 40 },
  pray:     { key: 'pray', label: '祈祷', scale: 1 },
  heal:     { key: 'heal', label: '疗伤', scale: 5 },
  fight:    { key: 'fight', label: '战斗', scale: 2 },
  idle:     { key: 'idle', label: '闲逛', scale: 1 },
};