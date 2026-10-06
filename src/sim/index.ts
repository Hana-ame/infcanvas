/**
 * sim/index.ts —— 权威核心公共出口（零 DOM / 零 Node API）。
 * 客户端/服务端/CLI/测试统一从这里 import，禁止深路径穿透。
 */
export * from './types';
export * from './tuning';
export { mulberry32, hash2, type Rng } from './rng';
export { World, type TileKind } from './world';
export { findPath } from './pathfinding';
export type { SimContext, CardWeightHook, DrawSurface } from './context';
export { cardWeight, drawCard, effectiveMastery, touchMastery, type CardDef } from './cards';
export {
  behaviorCtor,
  CATEGORY_ORDER,
  type Category,
  type GameSystem,
  type SystemDef,
} from './systems';
export { Sim, type SimConfig } from './sim';
export { SAVE_VERSION, SAVE_MIGRATIONS, loadSim, snapshotOf, migrate, type SaveData } from './sim-save';
// 权威状态确定性摘要（golden-hash 门禁的"测量"面）：只吃权威态、跨机稳定，
// 不吃表现层浮点。用途与理由见 fingerprint.ts 文件头。
export { fingerprint, fingerprintFields } from './fingerprint';
