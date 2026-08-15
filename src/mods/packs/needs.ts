// 生存需求玩法包（2026-08-14 完全插件化：needs/san/desire 迁出内核）
// 背景：三系统硬编码在内核 SYSTEM_DEFS。完全插件化裁决"内核 = 纯引擎"后迁出——行为决策
//   (behavior) 读的 PawnState 字段（hunger/tired/mood/san）在引擎结构里恒在，本包不挂时
//   字段不更新（卸载不破坏核心：不崩，只是状态静止）。三个状态系统紧耦合（同写 PawnState
//   供 behavior 消费），故合为一个玩法包、各自 registerSystemDef（disableSystem 按 id 可
//   单独卸载任一）。
// 装配：id 已在 SYSTEM_DEFS 表登记（类别推导执行序），无需 before 锚点。
import type { ModRegistry } from '../../sim/mods/registry';
import { NeedsSystem } from '../../sim/systems/needsSystem';
import { SanSystem } from '../../sim/systems/sanSystem';
import { DesireSystem } from '../../sim/systems/desireSystem';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const needsPack: ModPack = {
  id: 'needs',
// 依赖（2026-08-15 显式化）：无硬前置——需求写篝火记忆 = socialUnit 弱依赖（NOOP 回落安全）
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({ id: 'needs', label: '生存需求', category: 'needs', ctor: (s: Sim) => new NeedsSystem(s) });
    m.registerSystemDef({ id: 'san', label: '理智', category: 'needs', ctor: (s: Sim) => new SanSystem(s) });
    m.registerSystemDef({ id: 'desire', label: '欲望', category: 'needs', ctor: (s: Sim) => new DesireSystem(s) });
  }
};