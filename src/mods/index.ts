// mods 层导出（2026-08-21 从零重写）
export { ModRegistry, type BuildingDef, type EnemyDef, type CommandHandler, type AiAction } from './registry';
export { CATEGORY_ORDER, topoSort, type ModPack, type SystemDef, type Category } from './pack';
export * from './packs';
