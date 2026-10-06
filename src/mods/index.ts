/**
 * mods/index.ts —— 插件框架公共出口。
 * ModRegistry.default() = 默认玩法装配（清单见 packs/playstyle.ts）；
 * ModRegistry.mountPacks([...]) = 自选装配（DLC/测试/极简模式）。
 */
export { topoSort, type ModPack } from './pack';
export {
  ModRegistry,
  type CommandHandler,
  type ItemDef,
  type RecipeDef,
  type EventSeedDef,
} from './registry';
export type { TechTuningEntry } from '../sim/tuning';
export * from './contracts';