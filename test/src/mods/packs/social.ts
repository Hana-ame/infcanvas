// 社交互动玩法包（2026-08-14 完全插件化：social 迁出内核）
// 背景：原内核 SYSTEM_DEFS 的"社交互动"。完全插件化裁决迁出为包——社交是玩法（话题/情绪
//   传染/篝火交流），非引擎骨架。读 socialUnits 篝火记忆（fireHistory）做话题，卸掉 socialUnit
//   时 fireHistory 回落 NOOP 空实现不崩（卸载不破坏核心契约）。
// 装配：id 已在 SYSTEM_DEFS 表登记（类别推导执行序），无需 before 锚点。
import type { ModRegistry } from '../../sim/mods/registry';
import { SocialSystem } from '../../sim/systems/socialSystem';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const socialPack: ModPack = {
  id: 'social',
// 依赖（2026-08-15 显式化）：无硬前置——话题素材读 fireHistory = socialUnit 弱依赖（NOOP 回落安全）
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({ id: 'social', label: '社交互动', category: 'society', ctor: (s: Sim) => new SocialSystem(s) });
  }
};