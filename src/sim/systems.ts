// 系统执行序（2026-08-21 从零重写）
// GameSystem 只依赖 SimContext 接口（不碰 Sim 本体）——可独立测试。
// Sim 每 tick 按类别序 × 注册序驱动全部系统。

import type { Sim } from './sim';

export interface GameSystem {
  id: string;
  /** 每 tick 调用（dt = 秒） */
  update(dt: number): void;
  /** 系统启动（Sim 装配后、首 tick 前） */
  init?(): void;
}