// 补员玩法包（2026-08-14 完全插件化：population 迁出内核）
// 背景：原内核 SYSTEM_DEFS 的"补员"（人口低谷时刷新人加入）。完全插件化裁决迁出——
//   补员是玩法/生态平衡系统，非引擎骨架。位于敌袭之后（先结算威胁再补员）。
// 装配：id 已在 SYSTEM_DEFS 表登记（类别推导执行序），无需 before 锚点。
import type { ModRegistry } from '../../sim/mods/registry';
import { PopulationSystem } from '../../sim/systems/populationSystem';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const populationPack: ModPack = {
  id: 'population',
// 依赖（2026-08-15 显式化）：无硬前置——补员走引擎 spawnPawn
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({ id: 'population', label: '补员', category: 'world', ctor: (s: Sim) => new PopulationSystem(s) });
  }
};