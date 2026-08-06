// 共享类型 + SimContext —— 系统访问 sim 的接口（mod 友好）
import type { World } from '../core/world';
import type { SimRng } from '../core/rng';
import type { EventBus } from '../core/events';
import type { PawnState } from '../sim';
import type { SkillId } from '../ai/pawn';
import type { World as BitecsWorld } from 'bitecs';
import type { TuningConfig } from '../defs/tuning';
import type { RecipeDef } from '../defs/recipes';
import type { ModRegistry } from '../mods/registry';

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
  buildingDef(id: string): import('../defs').BuildingDef | undefined;
  recipe(id: string): RecipeDef | undefined;
  stockpile: Record<string, number>;
  hostiles: Hostile[];
  buildQueue: BuildItem[];
  pawnStates: Map<number, PawnState>;
  pawnPositions: Map<number, { x: number; y: number }>;
  time: number;
  dayTime: number;
  pawnList: readonly number[];
  env: { raining: boolean; temperature: number };
  factionPriority: Record<string, number>; // 派系工作优先级（用户 Q8）
  socialUnits: {
    units: Map<string, unknown>;
    membership: Map<number, string>;
    onBuildingBuilt(key: number, defId: string, now: number): void;
    assignPawn(eid: number): void;
    unassignPawn(eid: number): void;
  };
  playerUnitId: string | null;
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
  findNearest(pos: { x: number; y: number }, cond: (x: number, y: number) => boolean, allowNonPassable?: boolean): { x: number; y: number } | null;
  // 实体
  spawnPawn(x: number, y: number): number;
  killPawn(eid: number): void;
  // 属性（COC）
  dnaOf(eid: number): { str: number; con: number; int: number; siz: number; dex: number; app: number; pow: number; edu: number } | null;
  // 事件/骰子/日志
  rollEvent(eid: number, dc: number): { success: boolean; roll: number };
  rollEventSkill(eid: number, dc: number, skill: SkillId): { success: boolean; roll: number };
  adjustMood(eid: number, delta: number): void;
  logEvent(text: string): void;
  clearTrailCache(): void;
  // 技能（COC）：读取 + 使用后成长
  skillOf(eid: number, skill: SkillId): number;
  growSkill(eid: number, skill: SkillId): void;
  // 行为倾向（勒沙特列反馈）：按 profit 调整 / 读取
  recordLean(eid: number, key: string, profit: number): void;
  leanOf(eid: number, key: string): number;
  // 历史（仿真日志）：结构化查询（社交话题等素材）
  historyQuery(opts?: { type?: string; eid?: number; limit?: number }): { type: string; data?: Record<string, unknown> | undefined }[];
}
