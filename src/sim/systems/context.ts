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
import type { SocialUnit } from '../core/socialUnit';

export interface Hostile {
  x: number; y: number;
  hp: number; maxHp: number;
  targetX: number; targetY: number;
  name?: string;      // 敌对势力身份（部落/狼群）
  faction?: string;   // 派系 id
  enemyId?: string;   // 敌对种类 id（查 enemies 表：speed/dmg/loot 数据驱动）
  speed?: number;     // 移速（enemy def 快照，避免每帧查表）
  dmgPerSec?: number; // 攻击力（部落战士比狼强）
  loot?: { item: string; amount: number }; // 击杀掉落
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
  // 数据驱动查询：建筑 def / 配方（mod 覆盖后生效）
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
  oracleGoal: { workType: string; label: string; until: number } | null; // 神谕目标（影响目标层）
  // 神谕设定目标（策略卡 = 神谕目标：只调制工作系列权重 ×oracleGoalMul，不插小人卡槽、不碰选择链）
  setOracleGoal(def: { workType?: string; label: string; duration: number }): void;
  socialUnits: {
    units: Map<string, SocialUnit>;
    membership: Map<number, string>;
    onBuildingBuilt(key: number, defId: string, now: number): void;
    assignPawn(eid: number): void;
    unassignPawn(eid: number): void;
  };
  playerUnitId: string | null; // 玩家派系 id（Q9：玩家单位 = 全局库存镜像；null = 玩家尚未建营）
  // 征服（Q9）：核心建筑被毁 → 吞并该派系
  conquestOf(coreKey: number, conquerorName: string): void;
  addProductionNear(x: number, y: number, item: string, amount: number): void;
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
  moveAdjacent(eid: number, tx: number, ty: number): void;
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
  // 经济账本（用户设计：收益/支出自动调节工作概率；个人预期 + 全局资源流）
  // eid 可空：null = 公共支出（建造扣公共库存）只记全局流
  recordEarn(eid: number | null, item: string, amount: number, workType?: string): void;
  recordSpend(eid: number | null, item: string, amount: number): void;
  flowRatio(item: string): number;
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
}
