// 派系单位玩法包（2026-08-15 内核纯引擎：socialUnit 迁出为插件）
// 背景：socialUnit（篝火 = 社会单位：区域记忆 + 归属）原为内核引擎系统，SimContext.socialUnits
//   是硬契约字段（needsSystem 记需求 / socialSystem 交流 / sim 归属回调消费）。纯引擎裁决迁出
//   为玩法包——系统构造时 `provide('socialUnits', sys)` 自报能力，Sim.socialUnits 变为 getter：
//   有本包 → 真实例，无本包 → 回落 NOOP_SOCIAL_UNITS 空实现（卸载不破坏核心契约）。
import type { ModRegistry } from '../../sim/mods/registry';
import { SocialUnitSystem } from '../../sim/systems/socialUnitSystem';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const socialUnitPack: ModPack = {
  id: 'socialUnit',
  // 依赖（2026-08-15 显式化）：无硬前置——派系单位契约自足
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'socialUnit', label: '派系单位', category: 'society',
      ctor: (s: Sim) => {
        const sys = new SocialUnitSystem(s);
        s.provide('socialUnits', sys); // 能力自报：Sim.socialUnits getter 返回真实例
        return sys;
      },
    });
  }
};