// 系统装配表（数据驱动：逻辑组件层）
// sim 按表顺序装配系统；mod 启动期可 registerSystem 插入任意阶段（before 锚点）
// 系统 id 即锚点（见 SystemRegistry.insertBefore）；分类仅作文档/工具用途
// 2026-08-14 插件化重构：本表只剩【内核基础系统】；玩法系统（farm/craft/repair/
// techPool/autobuild）已迁出为玩法包（src/mods/packs/），ModRegistry.default()
// 默认挂载全部玩法包 = 完整模拟器。模拟器 = 内核 + 玩法包叠加（正向组装）。
import type { Sim } from '../sim';
import { SCRIPTED_EVENTS } from './events';
import type { GameSystem } from '../systems/registry';
import { NeedsSystem } from '../systems/needsSystem';
import { SanSystem } from '../systems/sanSystem';
import { DesireSystem } from '../systems/desireSystem';
import { BehaviorSystem } from '../systems/cardSystem';
import { SocialUnitSystem } from '../systems/socialUnitSystem';
import { SocialSystem } from '../systems/socialSystem';
import { GatherSystem } from '../systems/gatherSystem';
import { BuildSystem } from '../systems/buildSystem';
import { RaidSystem } from '../systems/raidSystem';
import { PopulationSystem } from '../systems/populationSystem';
import { EventSystem } from '../systems/eventSystem';

export interface SystemDef {
  id: string;              // 唯一 id（排序/插入锚点，与 GameSystem.id 一致）
  label: string;           // 中文名（调试/文档）
  category: 'needs' | 'society' | 'production' | 'raid' | 'world' | 'ai';
  ctor: (sim: Sim) => GameSystem; // 依赖注入：构造（sim 即 SimContext）
  before?: string;         // mod 专用：插入到该 id 系统之前（缺省追加到表尾）
}

// 执行顺序 = 表序（数值修正先于行为，行为先于产出，产出先于敌袭/补员）
// 内核 11 系统；farm/craft/repair 经玩法包以 before:'raid' 插回产出位，
// autobuild/techPool 经玩法包追加表尾（默认装配后仍为原 16 系统顺序）。
export const SYSTEM_DEFS: SystemDef[] = [
  { id: 'needs',       label: '生存需求', category: 'needs',      ctor: (s) => new NeedsSystem(s) },
  { id: 'san',         label: '理智',     category: 'needs',      ctor: (s) => new SanSystem(s) },
  { id: 'desire',      label: '欲望',     category: 'needs',      ctor: (s) => new DesireSystem(s) },
  { id: 'behavior',    label: '行为决策', category: 'ai',         ctor: (s) => new BehaviorSystem(s) },
  { id: 'socialUnit',  label: '派系单位', category: 'society',    ctor: (s) => new SocialUnitSystem(s) },
  { id: 'social',      label: '社交互动', category: 'society',    ctor: (s) => new SocialSystem(s) },
  { id: 'gather',      label: '采集',     category: 'production', ctor: (s) => new GatherSystem(s) },
  { id: 'build',       label: '建造',     category: 'production', ctor: (s) => new BuildSystem(s) },
  { id: 'raid',        label: '敌袭',     category: 'raid',       ctor: (s) => new RaidSystem(s) },
  { id: 'population',  label: '补员',     category: 'world',      ctor: (s) => new PopulationSystem(s) },
  { id: 'events',      label: '剧本事件', category: 'world',      ctor: (s) => new EventSystem(s, [...SCRIPTED_EVENTS, ...s.mods.events], s.llmEventProvider) },
];
