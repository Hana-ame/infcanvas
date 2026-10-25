/**
 * sim/index.ts —— 模拟层统一出口。
 * 外界（客户端/服务器/玩法包/测试）只从这里引，内部文件重排不破调用方。
 */
export * from './types';
export type { SimContext, CardWeightHook, DrawSurface } from './context';
export * from './tuning';
export { mulberry32, hash2, type RngFn } from './rng';
export { World, canBuildingReplace, type SpreadPlantEntry } from './world';
export { findPath } from './pathfinding';
export { type CardDef, cardWeight, drawCard, effectiveMastery, touchMastery } from './cards';
export { type Category as SystemCategory, type GameSystem, type SystemDef, behaviorCtor, CATEGORY_ORDER } from './systems';
export { Sim, type SimConfig, triggerColonistMentalBreak, recruitWildFormerColonist } from './sim';
export { SAVE_VERSION, SAVE_MIGRATIONS, type SaveData, loadSim, snapshotOf, migrate } from './sim-save';
export { fingerprint, fingerprintFields } from './fingerprint';
export * from './hpa-infinite';
export * from './genetics-skills';
export * from './triad-specialization';
export * from './spatial-grid';
export * from './npc-bases';
export * from './multiplayer-raid';
export * from './architect-defs';
export * from './rimworld-work';
export * from './terrain';
export * from './rooms-power-fog';
export * from './power-fog-engine';
export * from './anatomy-health';
export * from './social-trade-weathering';
export * from './corpse-youtube-play';
export * from './mmo-faction-warfare';
export * from './mmo-ruins';
export * from './mmo-groups-ruins';
export * from './rimworld-ecology-butcher';
export * from './culinary-dishes';

export * from '../mods/dlc-entry';
