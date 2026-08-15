// 科技抽卡池玩法包（2026-08-14 插件化重构：玩法 = mod，内核只留基础系统）
// 背景：原 techPool 系统内置在 SYSTEM_DEFS 内核。正向组装模型下本包提供
// "神谕科技抽卡"（techInterval 独立计时，TECH_ORDER 顺序解锁；科技门控建造）。
// 依赖：behavior（科技解锁经卡池/建造意图生效）；不依赖其它玩法包——无科技时
// 建造仅靠基础 build + autobuild 玩法包。
// 装配：尾部追加（科技结算在设计上位于敌袭/补员之后，保持原表序末尾）。
import type { ModRegistry } from '../../sim/mods/registry';
import { TechPoolSystem } from '../../sim/systems/techPoolSystem';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const techPoolPack: ModPack = {
  id: 'techPool',
  // 依赖（2026-08-15 显式化）：无硬前置——科技表 TECHS 是全局 defs
  requires: [],
  apply(m: ModRegistry): void {
  m.registerSystemDef({
    id: 'techPool', label: '科技抽卡池', category: 'world',
    ctor: (s: Sim) => new TechPoolSystem(s),
  });
  }
};

