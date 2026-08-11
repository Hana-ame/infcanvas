// 系统装配表（数据驱动：逻辑组件层）
// sim 按表顺序装配系统；mod 启动期可 registerSystem 插入任意阶段（before 锚点）
// 系统 id 即锚点（见 SystemRegistry.insertBefore）；分类仅作文档/工具用途
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
import { FarmSystem } from '../systems/farmSystem';
import { CraftSystem } from '../systems/craftSystem';
import { RepairSystem } from '../systems/repairSystem';
import { RaidSystem } from '../systems/raidSystem';
import { PopulationSystem } from '../systems/populationSystem';
import { EventSystem } from '../systems/eventSystem';
import { AutonomousBuildSystem } from '../systems/autonomousBuildSystem';

export interface SystemDef {
  id: string;              // 唯一 id（排序/插入锚点，与 GameSystem.id 一致）
  label: string;           // 中文名（调试/文档）
  category: 'needs' | 'society' | 'production' | 'raid' | 'world' | 'ai';
  ctor: (sim: Sim) => GameSystem; // 依赖注入：构造（sim 即 SimContext）
  before?: string;         // mod 专用：插入到该 id 系统之前（缺省追加到表尾）
}

// 执行顺序 = 表序（数值修正先于行为，行为先于产出，产出先于敌袭/补员）
export const SYSTEM_DEFS: SystemDef[] = [
  { id: 'needs',       label: '生存需求', category: 'needs',      ctor: (s) => new NeedsSystem(s) },
  { id: 'san',         label: '理智',     category: 'needs',      ctor: (s) => new SanSystem(s) },
  { id: 'desire',      label: '欲望',     category: 'needs',      ctor: (s) => new DesireSystem(s) },
  { id: 'behavior',    label: '行为决策', category: 'ai',         ctor: (s) => new BehaviorSystem(s) },
  { id: 'socialUnit',  label: '派系单位', category: 'society',    ctor: (s) => new SocialUnitSystem(s) },
  { id: 'social',      label: '社交互动', category: 'society',    ctor: (s) => new SocialSystem(s) },
  { id: 'gather',      label: '采集',     category: 'production', ctor: (s) => new GatherSystem(s) },
  { id: 'build',       label: '建造',     category: 'production', ctor: (s) => new BuildSystem(s) },
  { id: 'farm',        label: '耕种',     category: 'production', ctor: (s) => new FarmSystem(s) },
  { id: 'craft',       label: '手作',     category: 'production', ctor: (s) => new CraftSystem(s) },
  { id: 'repair',      label: '修缮',     category: 'production', ctor: (s) => new RepairSystem(s) },
  { id: 'raid',        label: '敌袭',     category: 'raid',       ctor: (s) => new RaidSystem(s) },
  { id: 'population',  label: '补员',     category: 'world',      ctor: (s) => new PopulationSystem(s) },
  { id: 'events',      label: '剧本事件', category: 'world',      ctor: (s) => new EventSystem(s, [...SCRIPTED_EVENTS, ...s.mods.events], s.llmEventProvider) },
  { id: 'autobuild',   label: '自主建造', category: 'ai',         ctor: (s) => new AutonomousBuildSystem(s) },
];
