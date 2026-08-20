// 敌袭玩法包（2026-08-14 完全插件化：raid 迁出内核）
// 背景：原内核 SYSTEM_DEFS 的"敌袭"（敌人生成/追击/战斗结算）。完全插件化裁决迁出——
//   敌袭是玩法/威胁系统，非引擎骨架。它在清单中位于产出结算之后（cook 之后、population
//   之前），敌人先被产出/大系统结算（prison 俘获濒死、medicine 评估伤口）再发起袭击。
// 装配：id 已在 SYSTEM_DEFS 表登记（类别推导执行序），无需 before 锚点。
import type { ModRegistry } from '../../sim/mods/registry';
import { RaidSystem } from '../../sim/systems/raidSystem';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const raidPack: ModPack = {
  id: 'raid',
// 依赖（2026-08-15 显式化）：无硬前置——cat 是内核 defs
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({ id: 'raid', label: '敌袭', category: 'raid', ctor: (s: Sim) => new RaidSystem(s) });
  }
};