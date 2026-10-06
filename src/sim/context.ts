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

/**
 * DrawSurface —— 抽卡引擎「不触碰玩法内容」那部分的**全部**依赖，只有 5 个成员。
 *
 * 为什么单独切出来（2026-10-07，用户观察「抽卡系统和棋盘系统可以分离处理」）：
 * SimContext 有 50 个成员，而抽卡引擎真正只用到 5 个。类型系统把边界强制了出来：
 *  - 不触碰 content 的引擎函数（cards.ts 的 effectiveMastery / touchMastery，
 *    systems.ts 的 commit）只认这 5 个成员，**完全不知道棋盘存在**；
 *  - 会回调 content 的函数（drawCard / cardWeight，它们要调 condition/weightHooks）
 *    只能拿 SimContext——因为 condition/action 是包作者写的玩法内容，本来就要
 *    读写棋盘。这条分离不掉，是**桥**，不是耦合。
 * 价值：引擎可以被 5 成员假对象单测（而不是被迫伪造 50 个）；改棋盘存储结构不影响
 * 引擎签名，反之亦然；依赖方向可读（棋盘 → 引擎单向）。
 *
 * ⚠ 别把这条缝当成「抽卡系统已彻底分离」。分离的是**引擎下半段**（权重算术、
 * 熟练度、承诺记账）；上半段（候选筛选、加权轮盘）与棋盘之间隔着玩法内容，
 * 那道桥是设计意图——「一切皆抽卡」正是要让卡去看棋盘。
 */
export interface DrawSurface {
  readonly time: number;
  rng(): number; // 唯一随机源（确定性）
  readonly tuning: Tuning;
  cards(): readonly CardDef[];
  weightHooks(): readonly CardWeightHook[];
}

export interface SimContext extends DrawSurface {  // ---- 时钟与随机（见 DrawSurface）----

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

  // ---- 科技抽卡池（R2-1）----
  // 设计取舍：为什么科技进度放 Sim 而非 SimContext 抽象层？
  // 科技解锁是**世界事实**（随存档、要进 SaveData、要进协议），不是"系统可替换的玩法"。
  // 所以查询面挂在 SimContext（tech-pool 包与 building 包都只见接口，测试可注入假 ctx），
  // 而**真实存储**在 Sim 上（scratch 之外的显式字段，见 sim.ts techFragments/techsUnlocked）。
  /** 已解锁科技 id 集合（权威存储在 Sim；此处只读视图） */
  techUnlocked(): ReadonlySet<string>;
  /** 某科技已攒碎片数（缺省 0）。命名说明：存储字段 Sim.techFragments 才是裸名，
   *  这里用 from 动词避免与存储字段同名（否则实现类会字段/方法冲突，TS 报重复标识符）。 */
  techFragmentsOf(techId: string): number;
  /**
   * 授予一块科技碎片：攒满自动解锁并记事件。
   * 返回 'progress'（进度 +1）/ 'unlocked'（本块凑满最后一片）/ 'dup'（已解锁的重复卡，不累计）。
   * 为什么抽到已解锁科技不累计：用户 2026-08-15 裁决「重复可开出」——抽到重复 = 稀释，
   * 让新科技解锁期望更慢（渐进节奏），而不是给白拿的碎片奖励。
   */
  grantTechFragment(techId: string): 'progress' | 'unlocked' | 'dup' | 'unknown';
  /** 科技抽卡池顺序（TECH_ORDER：order 升序 = 权重递减方向） */
  techOrder(): string[];
  /**
   * 建筑科技门控判定（R2-1 消费端）：给定 BuildingTuningEntry.tech 列表，
   * 判断是否全部已解锁。语义三条：
   *  - 缺省/空数组 = 无门控（放行）；
   *  - 引用的科技**不在表里** = 放行（mod 未挂/热卸载的数据半残不许锁死世界）；
   *  - 表里有但未解锁 = 拒绝。
   * 放在 SimContext 而非让 building 包自己遍历 techUnlocked()：
   * 判定规则（"表外放行"这条尤其）是契约，只允许一处实现，避免两包各写一遍漂移。
   */
  techSatisfied(tech?: readonly string[]): boolean;

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
  // cards() / weightHooks() 已在 DrawSurface 中声明（抽卡引擎的窄依赖）。
  cardById(id: string): CardDef | undefined;
  finishCard(p: PawnState): void; // 卡提前完成（工作做完不等 duration）
  log(text: string): void; // 叙事 feed（历史层）

  // ---- 命令上行（系统也能发命令，如内部联动；玩家命令走 Sim.issueCommand）----
  command(type: string, args?: Record<string, unknown>): void;

  // ---- 运行态暂存（存档随档）：系统把自己的跨 tick 状态放这里而不是闭包，
  //      否则存档无法还原。键约定 "<包或系统id>.<名>"（单包自洽键，不入契约表）。----
  readonly scratch: Record<string, number>;
}