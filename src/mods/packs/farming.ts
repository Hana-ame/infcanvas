// 耕种玩法包（2026-08-14 插件化重构：玩法 = mod，内核只留基础系统）
// 背景：原 farm 系统内置在 SYSTEM_DEFS 内核，靠 hunter-gatherer 反向卸载。
// 正向组装模型：模拟器 = 内核 11 系统 + 玩法包叠加；本包提供"农田 passive 产粮"。
// 依赖：内核 build（农田经建造落成）；无其它玩法包依赖。
// 装配：before 'raid'（产出先于敌袭结算，保持原表序 farm→craft→repair→raid）。
import type { ModRegistry } from '../../sim/mods/registry';
import { FarmSystem } from '../../sim/systems/farmSystem';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const farmingPack: ModPack = {
  id: 'farming',
// 依赖（2026-08-15 显式化）：无硬前置——passive 建筑全是内核 defs
  requires: [],
  apply(m: ModRegistry): void {
  m.registerSystemDef({
    id: 'farm', label: '耕种', category: 'production',
    ctor: (s: Sim) => new FarmSystem(s),
    // 表内系统不设 before：执行序 = 类别序 × 组内注册序推导（SYSTEM_DEFS 表位置定序；
    // before 锚点仅第三方表外系统专用——2026-08-16 审计 L7 清理死锚点）
  });
  }
};

