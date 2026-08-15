// 自主扩张玩法包（2026-08-14 插件化重构：玩法 = mod，内核只留基础系统）
// 背景：原 autobuild 系统内置在 SYSTEM_DEFS 内核。正向组装模型下本包提供
// "AI 评估营地状态自动规划扩建"（无篝火→起篝火、缺粮→扩农田、缺工具→工作台…
// 20-30s 评估一次注入 buildQueue）。营地自主生长 = 玩法包特性，非内核必备。
// 依赖：内核 build（蓝图执行）；farm/craft 玩法包（规划目标的落成）。
// 装配：尾部追加（评估在设计上位于产出/敌袭之后，保持原表序末尾）。
import type { ModRegistry } from '../../sim/mods/registry';
import { AutonomousBuildSystem } from '../../sim/systems/autonomousBuildSystem';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const autobuildPack: ModPack = {
  id: 'autobuild',
// 依赖（2026-08-15 显式化）：build——蓝图注入 buildQueue 需 build 系统消费，否则规划永不执行
  requires: ['build'],
  apply(m: ModRegistry): void {
  m.registerSystemDef({
    id: 'autobuild', label: '自主建造', category: 'world',
    ctor: (s: Sim) => new AutonomousBuildSystem(s),
  });
  }
};

