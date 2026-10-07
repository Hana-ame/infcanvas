/**
 * mods/index.ts —— 插件框架公共出口。
 * ModRegistry.default() = 默认玩法装配（清单见 packs/playstyle.ts）；
 * ModRegistry.default({ dlc, exclude }) = 带 DLC 的装配（P0）；
 * ModRegistry.mountPacks([...]) = 自选装配（DLC/测试/极简模式）。
 */
export { topoSort, type ModPack, type DlcDecl } from './pack';
export {
  ModRegistry,
  type CommandHandler,
  type ItemDef,
  type RecipeDef,
  type EventSeedDef,
  type ModRegistryOptions,
} from './registry';
export type { TechTuningEntry } from '../sim/tuning';
export * from './contracts';