// 系统元数据表 + 类别执行序（数据驱动，2026-08-15 一致性重构）
// 背景：BASE_SYSTEM_ORDER 全量 25 序数组需要手工维护，新增玩法包要同时动 playstyle 清单
//   和系统表两处；且"0 系统内核"把决策引擎（behavior）也迁出为插件，而它本质是引擎服务
//   （用户 2026-08-15 裁决修复：行为要一致，插件/mod 不应出现不一致行为）。
// 一致性原则（2026-08-15）：
//   - **内核系统 = 引擎服务**（behavior 决策引擎带内联 ctor）；其余系统 = 插件（ctor 由包回填）。
//     两者走同一装配规则（见 sim.registerSystems：类别序 × 组内注册序 + 卸载过滤 + before 锚点），
//     ctor 来源不同只是"内核 vs 插件"的唯一区别——不搞特殊 case。
//   - **执行序 = 类别语义序（CATEGORY_ORDER）× 组内注册序推导**：唯一人工语义是 7 类类别序；
//     组内序 = apply 序（requires 拓扑自动拉齐，清单顺序不承担图约束）。新增玩法包 = 只改
//     playstyle 清单一处。默认清单（stable 初始注册序）与推导组合后与旧 BASE_SYSTEM_ORDER
//     逐位一致——执行序零漂移。
// 类别语义：needs(数值修正) → ai(决策) → society(派系/社交) → production(产出/结算，敌袭前)
//   → raid(敌袭) → world(补员/事件/科技/扩张) → boot(引导，恒表尾：出生刷人在全体系统
//   init 后，保证 spawnPawn 副作用 bus 事件不早于系统订阅)。
// 第三方玩法包（id 不在本表）仍可用 before 锚点插位（sim.registerSystems 兜底）。
import type { Sim } from '../sim';
import type { GameSystem } from '../systems/registry';
import { BehaviorSystem } from '../systems/cardSystem';

export interface SystemDef {
  id: string;              // 唯一 id（排序/插入锚点，与 GameSystem.id 一致）
  label: string;           // 中文名（调试/文档）
  category: 'needs' | 'ai' | 'society' | 'production' | 'raid' | 'world' | 'boot';
  ctor?: (sim: Sim) => GameSystem; // 内核系统 = 内联 ctor（引擎服务）；插件系统 = 包回填
  before?: string;         // 第三方玩法包专用：插入到该 id 之前（缺省追加到表尾）
}

// 类别语义序（唯一人工维护的执行序数据）：数组位置 = 类别结算顺序；组内序 = 注册序推导
export const CATEGORY_ORDER: SystemDef['category'][] = [
  'needs', 'ai', 'society', 'production', 'raid', 'world', 'boot',
];

// 引擎系统元数据表（2026-08-15 一致性重构）：
//   内核 = 1 个引擎系统（behavior 决策引擎——引擎服务归内核）；其余 24 系统全由玩法包
//   registerSystemDef 提供（回填 ctor）。表 = id → 元数据（含 ctor 的为内核系统；
//   插件 id 的占位条目仅声明类别归属——装配时被 mods.systemDefs 的同 id def 覆盖）。
export const SYSTEM_DEFS: Record<string, SystemDef> = {
  needs:      { id: 'needs',       label: '生存需求', category: 'needs' },
  san:        { id: 'san',         label: '理智',     category: 'needs' },
  desire:     { id: 'desire',      label: '欲望',     category: 'needs' },
  economy:    { id: 'economy',     label: '经济',     category: 'needs' },
  // 内核系统（引擎服务）：决策引擎自报 'behavior' 能力，Sim.behavior getter 经能力让渡消费；
  // 卸载（disableSystem('behavior')）后 Sim 回落 null，intents/works 挂接跳过——与其他
  // 系统一致（统一规则、统一卸载语义，不因内核来源而特殊）。
  behavior:   { id: 'behavior',    label: '行为决策', category: 'ai',
                ctor: (s: Sim) => { const sys = new BehaviorSystem(s); s.provide('behavior', sys); return sys; } },
  socialUnit: { id: 'socialUnit',  label: '派系单位', category: 'society' },
  social:     { id: 'social',      label: '社交互动', category: 'society' },
  gather:     { id: 'gather',      label: '采集',     category: 'production' },
  build:      { id: 'build',       label: '建造',     category: 'production' },
  farm:       { id: 'farm',        label: '耕种',     category: 'production' },
  craft:      { id: 'craft',       label: '手工',     category: 'production' },
  repair:     { id: 'repair',      label: '修缮',     category: 'production' },
  medicine:   { id: 'medicine',    label: '医疗',     category: 'production' },
  power:      { id: 'power',       label: '动力',     category: 'production' },
  thermo:     { id: 'thermo',      label: '热力',     category: 'production' },
  trade:      { id: 'trade',       label: '贸易',     category: 'production' },
  prison:     { id: 'prison',      label: '囚笼',     category: 'production' },
  cook:       { id: 'cook',        label: '烹饪',     category: 'production' },
  clothing:   { id: 'clothing',    label: '制衣',     category: 'production' },
  raid:       { id: 'raid',        label: '敌袭',     category: 'raid' },
  // RW-1 征召（2026-08-15，drafting 玩法包）：category 'raid'——接敌驱动与战斗结算同类别
  //（先结算接敌再续追）。占位条目仅声明类别归属（ctor 由 drafting 包 registerSystemDef 回填）。
  drafting:   { id: 'drafting',    label: '征召',     category: 'raid' },
  // 战场指挥 DLC（2026-08-20，field-command 玩法包）：category 'raid'——战术驱动与
  // 征召追击同类别同组（注册序 = drafting 之后：先征召追击结算再战术修正）。占位条目仅
  // 声明类别归属（ctor 由 field-command 包 registerSystemDef 回填）。
  'field-command': { id: 'field-command', label: '战场指挥', category: 'raid' },
  population: { id: 'population',  label: '补员',     category: 'world' },
  events:     { id: 'events',      label: '剧本事件', category: 'world' },
  techPool:   { id: 'techPool',    label: '科技池',   category: 'world' },
  autobuild:  { id: 'autobuild',   label: '自动建造', category: 'world' },
  // 引导类（'boot'）：类别序恒表尾——出生刷人必须晚于全体系统装配/init（见文件头注释）
  bootstrap:  { id: 'bootstrap',   label: '引导',     category: 'boot' },
};

// 内核（引擎）系统 id 集：只有 behavior（决策引擎 = 引擎服务）。卸载/挂载语义与其他系统
// 完全一致（装配规则统一，见 sim.registerSystems 与文件头"一致性原则"）。
export const KERNEL_SYSTEM_IDS: string[] = ['behavior'];
