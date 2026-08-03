// 共享类型 + SimContext —— 系统访问 sim 的接口（mod 友好）
import type { World } from '../core/world';
import type { SimRng } from '../core/rng';
import type { EventBus } from '../core/events';
import type { PawnState } from '../sim';
import type { SkillId } from '../ai/pawn';
import type { World as BitecsWorld } from 'bitecs';

export interface Hostile {
  x: number; y: number;
  hp: number; maxHp: number;
  targetX: number; targetY: number;
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
  stockpile: Record<string, number>;
  hostiles: Hostile[];
  buildQueue: BuildItem[];
  pawnStates: Map<number, PawnState>;
  pawnPositions: Map<number, { x: number; y: number }>;
  time: number;
  dayTime: number;
  pawnList: readonly number[];

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
  // 事件/骰子/日志
  rollEvent(eid: number, dc: number): { success: boolean; roll: number };
  rollEventSkill(eid: number, dc: number, skill: SkillId): { success: boolean; roll: number };
  adjustMood(eid: number, delta: number): void;
  logEvent(text: string): void;
  clearTrailCache(): void;
  // 技能（COC）：读取 + 使用后成长
  skillOf(eid: number, skill: SkillId): number;
  growSkill(eid: number, skill: SkillId): void;
}
