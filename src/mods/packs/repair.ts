// 修缮玩法包（2026-08-14 插件化重构：玩法 = mod，内核只留基础系统）
// 背景：原 repair 系统内置在 SYSTEM_DEFS 内核。正向组装模型下本包提供
// "受损建筑自动派活修理"（袭击/战斗留下残破建筑 → 空闲小人修复）。
// 依赖：内核 build/raid（受损来源与建造落成）；无其它玩法包依赖。
// 装配：before 'raid'（产出/维护先于敌袭结算）。
import type { ModRegistry } from '../../sim/mods/registry';
import { RepairSystem } from '../../sim/systems/repairSystem';
import type { Sim } from '../../sim/sim';

export function repairPack(m: ModRegistry): void {
  m.registerSystemDef({
    id: 'repair', label: '修缮', category: 'production',
    ctor: (s: Sim) => new RepairSystem(s),
    before: 'raid',
  });
}
