// 大规模单位行为优化（2026-08-20，用户「十万级别」）：
// 时间分片批处理——每 tick 只模拟 N 个 pawn（轮转），N 以下的全体快路径（needs 衰减）。
// 100K pawns: batch=2000 → 每 50 tick（10s at dt=0.2）循环全体 → 每人决策间隔 10s。
// needs 衰减仍 O(n) 但只是 4 次数组写/人 = 400K writes = ~1ms。
//
// 设计：
// 1. Sim 新增 batchSim 选项：pawnCount > threshold 时自动启用
// 2. behavior 系统：只处理当前 batch 的 pawn（decide + walk）
// 3. needs 系统：全体衰减（快路径），但只对 batch 内的做 aura/urgent 检查
// 4. san 系统：全体篝火恢复（快路径），但只对 batch 内的做 handleCrazy
// 5. social 系统：pawnCount > 1000 时自动跳过 O(n²) 互动（改用空间哈希 or 禁用）
// 6. crowdGrid：只统计 batch 内的 pawn（不是全体）

import type { Sim } from '../sim';

export interface BatchConfig {
  enabled: boolean;       // 是否启用批处理
  batchSize: number;     // 每 tick 处理多少 pawn
  batchIndex: number;    // 当前轮转位置
  threshold: number;     // pawnCount > 此值时自动启用
}

// 默认配置：pawnCount > 500 时自动启用批处理
export const DEFAULT_BATCH: BatchConfig = {
  enabled: false,
  batchSize: 500,
  batchIndex: 0,
  threshold: 500,
};

// 获取当前 batch 的 pawn id 列表
export function getBatch(pawnList: readonly number[], cfg: BatchConfig): number[] {
  if (!cfg.enabled || pawnList.length <= cfg.batchSize) return [...pawnList];
  const start = cfg.batchIndex;
  const end = Math.min(start + cfg.batchSize, pawnList.length);
  const batch = pawnList.slice(start, end);
  // 如果不足 batchSize，从头补
  if (batch.length < cfg.batchSize && pawnList.length > 0) {
    const remaining = cfg.batchSize - batch.length;
    batch.push(...pawnList.slice(0, remaining));
  }
  return batch;
}

// 推进 batch 轮转位置
export function advanceBatch(pawnList: readonly number[], cfg: BatchConfig): void {
  if (!cfg.enabled || pawnList.length <= cfg.batchSize) return;
  cfg.batchIndex += cfg.batchSize;
  if (cfg.batchIndex >= pawnList.length) cfg.batchIndex = 0;
}

// 检查是否应该启用批处理
export function shouldEnableBatch(pawnCount: number, cfg: BatchConfig): boolean {
  return pawnCount > cfg.threshold;
}