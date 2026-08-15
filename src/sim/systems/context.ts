// 共享类型 + SimContext —— 系统访问 sim 的接口（mod 友好）
// 设计（DESIGN §3 系统层）：所有 sim 系统只依赖此接口、不碰 Sim 本体 → 可单测、可替换；
// 数据驱动查询（buildingDef/recipe/tuning）经此接口下发，mod 覆盖后全局生效
import type { World } from '../core/world';
import type { SimRng } from '../core/rng';
import type { EventBus } from '../core/events';
import type { PawnState } from '../sim';
import type { SkillId } from '../ai/pawn';
import type { World as BitecsWorld } from 'bitecs';
import type { TuningConfig } from '../defs/tuning';
import type { RecipeDef } from '../defs/recipes';
import type { BuildingDef } from '../defs';
import type { ModRegistry } from '../mods/registry';
export interface Hostile {
  x: number; y: number;
  hp: number; maxHp: number;
  targetX: number; targetY: number;
  name?: string;      // 敌对势力身份（部落/猫群）
  faction?: string;   // 派系 id
  enemyId?: string;   // 敌对种类 id（查 enemies 表：speed/dmg/loot 数据驱动）
  speed?: number;     // 移速（enemy def 快照，避免每帧查表）
  dmgPerSec?: number; // 攻击力（部落战士比野猫强）
  loot?: { item: string; amount: number }; // 击杀掉落
  // 捕食者携带态（2026-08-16）：叼走的鼠 eid + 逃跑方向（捕获时定的单位向量）；
  // 携带中不索敌/不拆家,直冲方向跑离营地
  carried?: { eid: number; dirX: number; dirY: number };
}

export interface BuildItem {
  x: number; y: number;
  defId: string;
  progress: number;
  faction: string;
  cost?: { wood: number; ore: number };
}

// 系统能对 sim 做的所有操作（Sim 实现此接口，系统只依赖接口 → 可测试可替换）
export interface SimContext {
  readonly ecs: BitecsWorld;
  readonly world: World;
  readonly rng: SimRng;
  readonly bus: EventBus;
  readonly mods: ModRegistry;
  readonly tuning: TuningConfig; // 平衡参数总表（docs/DATA_DRIVEN.md §3.4）
  // 数据驱动查询：建筑 def / 配方（mod 覆盖后生效）；物品表经 mods.items 直读（clothing/
  // thermo 玩法包读 ItemDef.meta 声明语义，与 BuildingDef.meta 同模式——无需内核查询口）
  buildingDef(id: string): BuildingDef | undefined;
  recipe(id: string): RecipeDef | undefined;
  stockpile: Record<string, number>;
  hostiles: Hostile[];
  buildQueue: BuildItem[];
  pawnStates: Map<number, PawnState>;
  pawnPositions: Map<number, { x: number; y: number }>;
  time: number;
  dayTime: number;
  dayLength: number; // 一天秒数（120）
  pawnList: readonly number[];
  env: { raining: boolean; temperature: number };
  factionPriority: Record<string, number>; // 派系工作优先级（用户 Q8）
  techs: Set<string>; // 已解锁科技（神谕抽卡）
  techBuildWeight(techId: string): number; // 科技建筑建造权重（0→1 渐进：解锁初期仅娱乐探索可命中）
  unlockTech(techId: string): boolean;
  // 科技碎片（2026-08-14 碎片制：每科技 fragments 块碎片攒齐 → 自动解锁整卡）
  techFragments: Record<string, number>; // 每科技已集碎片数（攒满 = 已解锁，不重复累计）
  grantTechFragment(techId: string): boolean; // 拾获一块碎片；攒满 → unlockTech；已解锁科技返回 false
  fragmentsNeeded(techId: string): number; // 该科技所需碎片总数（def.fragments ?? 1）
  oracleGoal: { workType: string; label: string; until: number } | null; // 神谕目标（影响目标层）
  // 神谕设定目标（策略卡 = 神谕目标：只调制工作系列权重 ×oracleGoalMul，不插小人卡槽、不碰选择链）
  // 2026-08-16 更名：不再叫"神谕"——它就是卡池影响项（调工作权重,不裁决、不发布）。
  // 内部标识 oracle* 与命令 type 'oracle' 保留（协议/存档/远程兼容），人类可见面已改"策略卡"。
  setOracleGoal(def: { workType?: string; label: string; duration: number }): void;
  // 印卡 API（RW-1 M1 修订，2026-08-15 加入接口）：策略卡/习惯卡插入小人槽位（空槽优先、
  // 满则顶掉 weight 最低卡），插入后仍走抽 3 选 1 卡池。Sim 早已实现（LLM 印卡通道，
  // DESIGN §6）；唯一原因是玩法包命令处理器需要它——纯插件无法不经接口触碰小人槽位。
  printCard(def: import('../ai/pawn').BehaviorCardDef, opts?: { target?: number | 'random'; note?: string }): number | null;
  socialUnits: {
    // 2026-08-14 重构：派系实体层删除，只剩"篝火记忆 + 归属"工具
    onCampfireBuilt(key: number): void;
    assignPawn(eid: number): void;
    unassignPawn(eid: number): void;
    addMemory(key: number, text: string): void; // 记一条篝火记忆（需求/事件写区域历史）
    // 篝火区域历史（B 方案：交流篝火情况 = 读这份历史推断伙伴/敌人）
    fireHistory(key: number, limit?: number): string[];
  };
  addProductionNear(x: number, y: number, item: string, amount: number, faction?: string): void;
  // 建筑升级（篝火→教堂等）
  upgradeBuilding(x: number, y: number, defId: string, faction: string): boolean;

  isNight(): boolean;
  // 读组件
  readPosition(eid: number): { x: number; y: number } | null;
  readNeeds(eid: number): { food: number; rest: number; mood: number; san: number } | null;
  readHealth(eid: number): { hp: number; maxHp: number } | null;
  readSpeed(eid: number): { v: number } | null;
  setNeeds(eid: number, n: { food: number; rest: number; mood: number; san: number }): void;
  setHealth(eid: number, h: { hp: number; maxHp: number }): void;
  setPosition(eid: number, p: { x: number; y: number }): void;
  // 命令/移动
  moveTo(eid: number, x: number, y: number): void;
  // 返回是否发起了寻路（false = 超距/节流/无路——调用方可决定放弃目标或等待节流）
  moveAdjacent(eid: number, tx: number, ty: number): boolean;
  findNearest(pos: { x: number; y: number }, cond: (x: number, y: number) => boolean, allowNonPassable?: boolean, radius?: number): { x: number; y: number } | null;
  // 实体
  spawnPawn(x: number, y: number): number;
  killPawn(eid: number): void;
  // 属性（COC）
  dnaOf(eid: number): { str: number; con: number; int: number; siz: number; dex: number; app: number; pow: number; edu: number } | null;
  // 事件/骰子/日志
  rollEvent(eid: number, dc: number): { success: boolean; roll: number };
  rollEventSkill(eid: number, dc: number, skill: SkillId): { success: boolean; roll: number };
  adjustMood(eid: number, delta: number): void;
  issueCommand(cmd: { type: 'build'; x: number; y: number; buildingId?: string }): void;
  // 2026-08-15 纯引擎：命令 = 引擎协议，Sim 路由到注册的命令处理器（mods.commandHandlers）
  // 引擎内建 'move'（实体移动），其余（build/mine/oracle/assign…）由玩法包注册
  // 经济账本（用户设计：收益/支出自动调节工作概率；个人预期 + 全局资源流）
  // eid 可空：null = 公共支出（建造扣公共库存）只记全局流
  // 2026-08-15 纯引擎：记账规则（alpha 平滑/情绪反馈/日志）迁入 economy 玩法包，
  // 本接口签名不变，Sim 委托给 economy 能力（未挂 economy 包时静默无操作——卸载不破坏核心）
  recordEarn(eid: number | null, item: string, amount: number, workType?: string): void;
  recordSpend(eid: number | null, item: string, amount: number): void;
  flowRatio(item: string): number;
  // 全局资源流账本（共享状态：economy 包写入，引擎持有——同 stockpile 的宿主策略）
  flow: Record<string, { earn: number; spend: number }>;
  logEvent(text: string): void;
  clearTrailCache(): void;
  // 技能（COC）：读取 + 使用后成长
  skillOf(eid: number, skill: SkillId): number;
  growSkill(eid: number, skill: SkillId): void;
  // 行为倾向（勒沙特列反馈）：按 profit 调整 / 读取
  // 行为结果学习（EWA 吸引模型）：执行某行为后按实际結果量（如采集产出量）更新吸引力
  recordOutcome(eid: number, key: string, outcome: number): void;
  // 权重倍率读取（1=中性，>1 偏做该行为，<1 回避）
  leanOf(eid: number, key: string): number;
  // 历史（仿真日志）：结构化查询（社交话题等素材）
  historyQuery(opts?: { type?: string; eid?: number; limit?: number }): { type: string; data?: Record<string, unknown> | undefined }[];
  // ---- 引擎服务（2026-08-15 内核纯引擎：能力让渡 + 框架服务）----
  // 能力让渡：玩法包系统在构造时自报实现（如 behavior 报 'behavior'、socialUnit 报
  // 'socialUnits'、economy 报 'economy'、bootstrap 报 'bootstrap'）；Sim 以此取代
  // "写死 this.behavior/this.socialUnits"的硬引用——插件可装卸的核心机制
  provide(cap: string, impl: unknown): void;
  // 寻路服务（命令处理器等玩法代码要寻路时用；moveAdjacent 已内建）
  getPath(sx: number, sy: number, ex: number, ey: number, climb?: number): { x: number; y: number }[];
  // 初始人口数（SimOptions.pawnCount，bootstrap 包读取用于出生刷人）
  initialPawnCount: number;
  // 当前选中实体（命令分发用：命令无 pawnId 时默认作用于选中集）
  selected: number[];
}
