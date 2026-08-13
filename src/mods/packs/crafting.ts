// 手作玩法包（2026-08-14 插件化重构：玩法 = mod，内核只留基础系统）
// 背景：原 craft 系统内置在 SYSTEM_DEFS 内核。正向组装模型下本包提供
// "工作台 batch 配方产出工具"（木材→工具，采集 ×1.3）。
// 依赖：内核 build（工作台经建造落成）；无其它玩法包依赖。
// 装配：before 'raid'（产出先于敌袭结算；与 farming 同锚点，插入逻辑保注册序）。
import type { ModRegistry } from '../../sim/mods/registry';
import { CraftSystem } from '../../sim/systems/craftSystem';
import type { Sim } from '../../sim/sim';

export function craftingPack(m: ModRegistry): void {
  m.registerSystemDef({
    id: 'craft', label: '手作', category: 'production',
    ctor: (s: Sim) => new CraftSystem(s),
    before: 'raid',
  });
}
