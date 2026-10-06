/**
 * context.ts —— SimContext：玩法包系统唯一可见的世界切面。
 *
 * 为什么存在（原则④"系统可单独装卸、单独测试"）：
 *  - 系统构造函数只收 SimContext，不收 Sim 本体 → 单测可以构造最小假 ctx 注入，
 *    脱离完整 Sim 验证一个系统的行为。
 *  - 内核演进（加缓存/改存储结构）不破坏玩法包——它们只见接口。
 *
 * 纪律：SimContext 只放"读状态 + 基础动作面"，不放玩法语义（那是卡与系统的事）。
 */
import type { BuildingState, Eid, FeatureHit, Hostile, PawnState, Pos } from './types';
import type { Tuning } from './tuning';
import type { CardDef } from './cards';

/** 权重调制钩子（registerHook('cardWeight', fn) 注册）：返回乘数，≥0。
 *  needs 包用它表达"饿了吃权重大"，特质/熟练度由内核管线另算。 */
export type CardWeightHook = (p: PawnState, card: { series: string; id: string }, ctx: SimContext) => number;

export interface SimContext {  // ---- 时钟与随机 ----
  readonly time: number;
  rng(): number; // 唯一随机源（确定性）

  // ---- 数据表（只读视图；overrideTuning 后的生效值）----
  readonly tuning: Tuning;

  // ---- 实体 ----
  pawns(): IterableIterator<PawnState>;
  pawn(eid: Eid): PawnState | undefined;
  spawnPawn(x?: number, y?: number): Eid;
  killPawn(eid: Eid, cause: string): void;

  // ---- 敌对单位（野兽/袭击者；行为由 raid 包驱动，数据在 tuning.enemies）----
  hostiles(): readonly Hostile[];
  spawnHostile(kind: string, x: number, y: number): Hostile;
  despawnHostile(id: number): void;
  damagePawn(eid: Eid, dmg: number, cause: string): void;
  damageHostile(id: number, dmg: number): void;

  // ---- 世界查询 ----
  /** 可立足（非液体/无树冠/无阻挡建筑）。二元语义仅此一处保留为别名；
   *  移动判定请用 canStep（含高差与攀爬）。 */
  passable(x: number, y: number): boolean;
  zAt(x: number, y: number): number;
  canStep(fx: number, fy: number, tx: number, ty: number, climb: number): boolean;
  featureAt(x: number, y: number): FeatureHit | null;
  nearestFeature(kind: FeatureHit['kind'], x: number, y: number, maxR: number): FeatureHit | null;
  /** 从 (x,y) 特征收割一份 → 返回剩余份数（0 = 采空进再生；-1 = 无特征） */
  takeOne(x: number, y: number): number;
  /** 特征占地矩形（树=2×2；浆果=单点）——多格工作的邻接判定 */
  featureRect(f: FeatureHit): { x0: number; y0: number; x1: number; y1: number };
  distToFeatureRect(px: number, py: number, r: { x0: number; y0: number; x1: number; y1: number }): number;
  /** 特征周边一圈最近的可行走格（多格目标的寻路落点） */
  nearestFreeAdjacent(rect: { x0: number; y0: number; x1: number; y1: number }, fromX: number, fromY: number): Pos | null;
  nearestBuildingByTag(tag: string, x: number, y: number, maxR?: number): BuildingState | undefined;
  /** 全部建筑（系统维护燃料/渲染等用） */
  buildingsAll(): Iterable<BuildingState>;
  addBuilding(defId: string, x: number, y: number): BuildingState | null;
  removeBuilding(id: string): void;

  // ---- 资源池（营地仓库抽象；键 = contracts K_STOCK_*，跨包契约）----
  stockpile: Record<string, number>;

  // ---- 社交关系（-100..100，键 = pairKey；social 包写，未来外交/贸易包读）----
  relation(a: Eid, b: Eid): number;
  addRelation(a: Eid, b: Eid, delta: number): void;

  // ---- 移动服务（内核统一推进路径，卡只声明目标）----
  setPath(p: PawnState, tx: number, ty: number): boolean; // false = 不可达
  moveStep(p: PawnState, dt: number): void; // 沿 path 推进 speed*dt
  adjacent(p: PawnState, x: number, y: number, r?: number): boolean;

  // ---- 决策引擎面（内核 behavior 消费；玩法包经此注册内容）----
  cards(): readonly CardDef[];
  cardById(id: string): CardDef | undefined;
  weightHooks(): readonly CardWeightHook[];
  finishCard(p: PawnState): void; // 卡提前完成（工作做完不等 duration）
  log(text: string): void; // 叙事 feed（历史层）

  // ---- 命令上行（系统也能发命令，如内部联动；玩家命令走 Sim.issueCommand）----
  command(type: string, args?: Record<string, unknown>): void;

  // ---- 运行态暂存（存档随档）：系统把自己的跨 tick 状态放这里而不是闭包，
  //      否则存档无法还原。键约定 "<包或系统id>.<名>"（单包自洽键，不入契约表）。----
  readonly scratch: Record<string, number>;
}
