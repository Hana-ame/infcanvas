// Sim —— 组装层（系统挂载 + 主循环 + 命令 + UI 读取）
// 架构：Sim 实现 SimContext，系统通过 context 操作 sim，事件经 EventBus 流动
// 权威仿真 = src/sim：零 DOM，浏览器/Node 双端复用同一份；数值全部数据驱动（defs/tuning，mod 可覆盖）
import {
  createWorld, addEntity, addComponent, setComponent, query,
  type World as EcsWorld,
} from 'bitecs';
import { World, type ChunkData } from './core/world';
import { TECHS } from './defs/techs';
import { findPath } from './core/pathfinding';
import { SimRng } from './core/rng';
import { initNeeds } from './core/needs';
import { EventBus, type GameEvent } from './core/events';
import { HistoryLog } from './core/history';
import { generateDna, initSlots, type Dna, type SkillId, BASE_CARDS, TRAIT_CARDS } from './ai/pawn';
import { initDesires, type DesireId } from './core/desires';
import { initEnv, tickEnv, type EnvState } from './core/env';

import { initLean, recordOutcome, weightMulOf, type LeanKey, type LeanDef } from './core/lean';
import { BUILDINGS, TILES, ITEMS, type BuildingDef } from './defs';
import { ENEMIES } from './defs/enemies';
import { RECIPES } from './defs/recipes';
import { TUNING, type TuningConfig } from './defs/tuning';
import type { RecipeDef } from './defs/recipes';
import { ModRegistry } from './mods/registry';
import { cardFromDef, type BehaviorCardDef, type BehaviorCard } from './ai/pawn';
import type { SimContext } from './systems/context';
import { SystemRegistry } from './systems/registry';
import type { ScriptedEvent } from './systems/eventSystem';

import { SYSTEM_DEFS, CATEGORY_ORDER, type SystemDef } from './defs/systems';
import { jobLabelOf } from './defs/jobs';
import { INTERESTS } from './defs/interests';
// 2026-08-15 内核纯引擎：不再硬引用 BehaviorSystem/SocialUnitSystem 类——
// behavior/socialUnit 迁出为玩法包，经 provide 能力让渡。仅取执行器类型签名。
import type { IntentExecutor, WorkExecutor } from './systems/cardSystem';
import type { BootstrapCap } from '../mods/packs/bootstrap';
import type { EconomyCap } from '../mods/packs/economy';

// 兴趣卡静态表（id → 卡）：存档 load 按卡 id 还原用（与 TRAIT_CARDS 同策略）。
// 背景：兴趣休闲卡（interest:xxx）是 initSlots 注入卡槽的，不属于 mods.cards/基础卡/天赋卡，
// load 时若不查此表 → 还原成 null → 娱乐活动丢失（存档往返测试暴露）。v2026-08-13。
const INTEREST_CARDS: Map<string, BehaviorCard> = new Map(
  Object.values(INTERESTS).filter((i) => i.card).map((i) => [i.card!.id, cardFromDef(i.card!)]),
);

// socialUnit 系统被卸载时的 no-op 空实现（2026-08-14 插件化加固）：
// 纪律"卸载不破坏核心"——SimContext.socialUnits 是契约字段，消费方（needsSystem 记需求、
// socialSystem 交流历史、sim 自身归属回调）无条件调用它；系统卸载时若直接置 null 会空引用。
// 方案：字段默认回落空实现（调用即无操作），registerSystems 启用时回填真实例。
const NOOP_SOCIAL_UNITS: SimContext['socialUnits'] = {
  onCampfireBuilt: () => {},
  assignPawn: () => {},
  unassignPawn: () => {},
  addMemory: () => {},
  fireHistory: () => [],
};

// behavior 能力（2026-08-15 纯引擎：决策引擎 = 玩法包提供的能力，Sim 只消费注册面）
export interface BehaviorCap {
  registerIntent(id: string, fn: IntentExecutor): void;
  registerWork(type: string, fn: WorkExecutor): void;
}

// ---- ECS 组件定义 ----
export interface PositionData { x: number; y: number }
export interface NeedsData { food: number; rest: number; mood: number; san: number }
export interface SpeedData { v: number }
export interface HealthData { hp: number; maxHp: number }

export const Position = { x: [] as number[], y: [] as number[] };
export const Pawn = {} as { _flag?: number[] };
export const NeedsComp = { food: [] as number[], rest: [] as number[], mood: [] as number[], san: [] as number[] };
export const Speed = { v: [] as number[] };
export const Health = { hp: [] as number[], maxHp: [] as number[] };

// 组件自动回写：bitecs 的 setComponent 调用 → 自动同步到并行数组（组件即数组，读端直接索引取值）。
// 为什么：ECS 组件用并行数组存储，系统/UI 读侧（readNeeds/readHealth 等）只读数组零拷贝；
// observe+onSet 让所有 setComponent 路径免手写同步，避免"组件值改了数组没写"的坑
function registerAutoStore(world: EcsWorld, component: Record<string, number[]>): void {
  observe(world, onSet(component), (eid: number, data: Record<string, number>) => {
    for (const key of Object.keys(data)) {
      const arr = component[key];
      if (Array.isArray(arr)) arr[eid] = data[key];
    }
  });
}

import { observe, onSet } from 'bitecs';

export interface PawnState {
  dna: Dna;
  climb: number; // 通过能力（高差上限；spawn 时从 tuning.pawn.climb 取——单位各自能力，mod 可 overrideTuning）
  // ⚠️ 差距登记（2026-08-15 审计）：实现 = spawn 取 tuning 后从不修改，全小人恒同值；
  // 存档不还原也无差别（值恒等于 tuning）。若未来做个体差异（如天赋加攀爬），
  // 需在 SaveData 增加 climb 字段并随档。enemyDef.climb 差异化不受影响（寻路读各自 def）。
  slots: ReturnType<typeof initSlots>;
  path: { x: number; y: number }[];
  pathIndex: number;
  urgent?: 'eat' | 'rest';
  mining?: { x: number; y: number; progress: number };
  mineTarget?: { x: number; y: number };
  chopTarget?: { x: number; y: number };
  caveTarget?: { x: number; y: number }; // 矿洞工作目标
  caveWork?: { x: number; y: number; progress: number; duration?: number; buildingId?: string }; // 建筑内持续工作（矿洞/竹筏，buildingId=recipe）
  chopXY?: { x: number; y: number };
  chopProgress?: number;
  prayTarget?: { x: number; y: number }; // 祈祷点（篝火）
  praying?: { x: number; y: number; progress: number };
  healTarget?: { x: number; y: number }; // 疗伤点
  healing?: { progress: number };
  commandCooldown?: number; // 玩家命令后的一段时间不自动决策
  faith?: number; // 信仰度（祈祷积累，影响违抗与心情）
  defyCd?: number; // 违抗后的冷却时间（秒）
  crazyCooldown?: number; // 狂乱乱跑冷却
  farScanCd?: number;     // 远距回扫冷却（miss 后不重复大半径扫描）
  pathCd?: number;        // 寻路节流冷却（两次寻路最小间隔，防每帧重寻路风暴）
  expectEarn?: number;    // 个人经济预期：工作赚多少（滚动平均）
  expectSpend?: number;   // 个人经济预期：花费花多少（滚动平均）
  expectEarnBy?: Record<string, number>; // 按工作类型的收益预期（决策调制：赚得多的活更愿意干）
  crazyTime?: number;     // SAN 狂乱累计时长（超过阈值 → 逃向篝火）
  crazyFleeTarget?: { x: number; y: number }; // 崩溃逃向的篝火目标
  skills?: Partial<Record<SkillId, number>>; // COC 技能（百分制，越用越强）
  desires?: Record<DesireId, number>; // 七宗罪满足度（DESIGN §3）
  lastNeedRec?: number; // 需求写入篝火记忆的节流等级（needsSystem.recordNeed 用，防刷屏）
  huntTarget?: { x: number; y: number }; // 狩猎目标猫位置（采集狩猎 mod 的 huntCombat 系统推进攻击）
  huntScanCd?: number; // 狩猎目标扫描冷却（发现背景：hunt 卡提权后无缓存无冷却 → 每帧全图扫猫+寻路，30 分钟局 20s→240s+ 超时）
  huntElapsed?: number; // 追猫累计时长（超时放弃，防猫在水上/建筑中打不到 → 无限追+每 pathCd 重寻路死循环）
  huntSkillCd?: number; // 狩猎技能成长节流（每帧 growSkill → EWA 学习表更新开销大，profile 实测为热点）
  inventory?: Record<string, number>; // 个人私有物品（2026-08-14 用户设计：私有物品 + 真以物易物；
  // 当前实现仅食物私有化：主动采集的食入口袋，进食优先扣个人；木材/矿石仍走全局公共仓库）
  relationships?: Map<number, number>; // 对其他小人的好感度（社交系统）
  socialCd?: number; // 社交冷却
  job?: string;
  // 最近决策记录（设计文档：小人闪过哪3个念头、选了哪个）
  lastDecision?: { drawn: string[]; picked: string; time: number };
  lastSeries?: string; // 上一轮执行的卡系列（马尔可夫偏置，DESIGN §6）
  oracleBuff?: { until: number; mood: number }; // 神谕祝福（到期时间戳，心情加成）
  assignedJob?: string; // 指派职业（Q10 生产线：lumberjack/miner/farmer/crafter）
  lean?: Record<LeanKey, number>; // 行为倾向（勒沙特列反馈：按 profit 自平衡）
  gossip?: { text: string; heardAt: number }; // 听到的八卦（社交网络传播，TTL 内可转述）
  // 关联篝火（用户 2026-08-13 B 方案：每个人保存一个篝火，在篝火周围生存；
  // 不舒适可另起篝火）。null = 游牧（暂无营地归属）
  fireId?: number | null; // 关联篝火建筑 key（2026-08-14 重构：无派系单位，指向 campfire 主格）
  // 对"听说的篝火"的看法（B 方案：通过交流篝火历史判断伙伴/敌人）
  // stance: friend/enemy/unknown；basis = 判断依据（听到的历史事件描述）
  knownFires?: Record<number, { stance: 'friend' | 'enemy' | 'unknown'; basis: string; at: number }>;
  // mod 系统自定义字段（存档扩展点 2026-08-14：伤情/囚犯/温度等由玩法包自由读写，
  // save 原样序列化、load 原样还原——解决"mod 状态一存档就丢"；契约：值必须 JSON-safe）
  extra?: Record<string, unknown>;
  onArriveWork?: () => void; // mod 工作的到达回执（非序列化，仅当 tick 行为态：走到点后调用）
}

export interface SimOptions {
  seed?: number;
  pawnCount?: number;
  tickHz?: number;
  mods?: (m: ModRegistry) => void; // mod 挂载：构造时注册系统/卡/意图（DESIGN §7）
  registry?: ModRegistry;          // 预建注册表（服务端 mod 管理器：先挂载所有包再构造 Sim）；缺省 ModRegistry.default()
  eventProvider?: () => ScriptedEvent | null; // LLM 慢决策层（P1）：替换确定性随机脚本（DESIGN §6）
}

export interface Command {
  // 命令协议（引擎面，2026-08-15 纯插件收敛）：type = 命令名——'move' 引擎内建，
  // 其余由玩法包 registerCommand 提供处理器；`(string & {})` = 开放扩展：玩法包新命令
  // （wear/build/mine/oracle/assign…）无需改内核枚举（IDE 仍提示已知命令）。
  // 命令专属参数走 args 通用位（内核不解释，玩法包自行读取——wear 命令的 itemId 先例）。
  // 曾把 'wear' 写进联合 + itemId 顶层字段，被用户指摘"内核为什么扩展"后收敛为本协议面
  type: 'move' | 'build' | 'haul' | 'mine' | 'oracle' | 'assign' | (string & {});
  pawnId?: number;
  x: number;
  y: number;
  buildingId?: string;
  job?: string; // assign 命令用（lumberjack/miner/farmer/crafter）
  args?: Record<string, unknown>; // 玩法命令参数位（如 wear 的 { itemId }）
}

export interface SaveData {
  time: number;
  dayTime: number;
  stockpile: Record<string, number>;
  tiles: string[] | ChunkData[]; // 旧档 = 全量 string[]（192×192）；新档 = 覆盖层 chunk（DESIGN §375）
  buildings: { key: number; defId: string; hp: number; faction: string; extra?: Record<string, unknown> }[];
  techs?: string[]; // 已解锁科技（旧档缺省空）
  techFragments?: Record<string, number>; // 科技碎片进度（2026-08-14 碎片制；旧档缺省空）
  pawns: {
    eid: number; x: number; y: number;
    dna: Dna; slots: (string | { id: string; m: number; u: number } | null)[]; // 卡 id（+熟练度）——JSON-safe
    needs: NeedsData | null; health: HealthData | null;
    faith?: number;
    skills?: Partial<Record<SkillId, number>>;
    desires?: Record<DesireId, number>;
    inventory?: Record<string, number>;
    oracleBuff?: { until: number; mood: number };
    assignedJob?: string;
    fireId?: number | null; // 关联篝火建筑 key（2026-08-14 重构：无派系单位，指向 campfire 主格）
    knownFires?: Record<number, { stance: 'friend' | 'enemy' | 'unknown'; basis: string; at: number }>;
    extra?: Record<string, unknown>; // mod 自定义字段（存档扩展点：JSON-safe，load 原样还原）
  }[];
}

export class Sim implements SimContext {
  ecs: EcsWorld;
  world: World;
  rng: SimRng;
  bus: EventBus;
  tickHz: number;
  time = 0;
  dayLength: number; // 昼夜时长（秒）—— 装配自 tuning.env.dayLength
  dayTime = 0;  speed = 1;
  paused = false;
  events: { time: number; text: string }[] = [];
  env: EnvState; // 天气/气温（DESIGN §6）—— initEnv 读 tuning.env.baseTemp
  // 派系优先级（用户 Q8：AI 按环境下达工作优先指令）：卡 id → 权重倍率
  // 2026-08-15 纯引擎：此共享状态由 economy 玩法包系统 update 写入，引擎只持有
  factionPriority: Record<string, number> = {};

  pawnStates = new Map<number, PawnState>();
  pawnPositions = new Map<number, { x: number; y: number }>();
  selected: number[] = [];
  hostiles: { x: number; y: number; hp: number; maxHp: number; targetX: number; targetY: number; name?: string; faction?: string; enemyId?: string; speed?: number; dmgPerSec?: number; loot?: { item: string; amount: number } }[] = [];
  buildQueue: { x: number; y: number; defId: string; progress: number; faction: string; cost?: { wood: number; ore: number } }[] = [];
  stockpile: Record<string, number>; // 初始库存 = tuning.population.startStockpile（构造函数里装配）

  private _pawnList: number[] = [];
  private trailCache = new Map<string, { x: number; y: number }[]>();
  private registry = new SystemRegistry();
  // 结构化历史日志（仿真日志：事实来自 sim，LLM 只润色）
  history = new HistoryLog();
  // mod 注册表（DESIGN §7 扩展性原则；opts.registry 提供预建表时替换）
  mods = ModRegistry.default();
  // 平衡参数总表（mod 可覆盖）——getter 保证 mods 回调后读到覆盖后的值
  get tuning(): TuningConfig {
    return this.mods.tuning;
  }
  // 初始人口（SimOptions.pawnCount）：bootstrap 玩法包 init 时据此刷人（2026-08-15 纯引擎）
  initialPawnCount: number;

  // mod 可覆盖的 def 查询（SimContext）
  buildingDef(id: string): BuildingDef | undefined {
    return this.mods.buildings[id];
  }
  recipe(id: string): RecipeDef | undefined {
    return this.mods.recipes[id];
  }
  private _started = false;
  private _eventProvider: (() => ScriptedEvent | null) | null = null;
  // 能力让渡表（2026-08-15 内核纯引擎）：玩法包系统构造时 self-provide（behavior/socialUnits/
  // economy/bootstrap…），Sim 借此取代"写死 this.behavior/this.socialUnits"的硬引用——
  // 插件可装卸的核心机制；未提供时回落 null / NOOP。
  private caps = new Map<string, unknown>();
  provide(cap: string, impl: unknown): void { this.caps.set(cap, impl); }
  private getCap<T>(cap: string): T | null { return (this.caps.get(cap) as T) ?? null; }
  // behavior 能力（决策引擎，由 behavior 玩法包提供）：仅注册表回填 intents/works 用
  private get behavior(): BehaviorCap | null { return this.getCap<BehaviorCap>('behavior'); }
  // LLM 慢决策层注入（构造后由 server 挂接；数据驱动系统装配表经此读取）
  get llmEventProvider(): (() => ScriptedEvent | null) | null { return this._eventProvider; }
  set llmEventProvider(p: (() => ScriptedEvent | null) | null) { this._eventProvider = p; }
  // 篝火单位/部落记忆/派系涌现。
  // 2026-08-14 插件化加固 + 2026-08-15 纯引擎：socialUnit 迁出为玩法包，此字段变 getter——
  // 有包（self-provide 'socialUnits'）→ 真实例；无包 → 回落 NOOP_SOCIAL_UNITS 空实现
  // （"卸载不破坏核心"纪律：needsSystem/socialSystem 及 sim 自身回调契约不变不崩）。
  get socialUnits(): SimContext['socialUnits'] {
    return this.getCap<SimContext['socialUnits']>('socialUnits') ?? NOOP_SOCIAL_UNITS;
  }

  // 已抽到的科技（神谕抽卡解锁；tech 未解锁的建筑不可建造）
  techs = new Set<string>();
  // 科技碎片（2026-08-14 碎片制）：每科技已集碎片数；攒满 fragments 块 → unlockTech。
  // 抽卡端（tech-pool 玩法包）每次抽卡 → grantTechFragment；已解锁科技不重复累计。
  techFragments: Record<string, number> = {};
  // 全局资源流账本（用户 2026-08-13 经济设计：收益/支出自动调节工作概率）
  // 伐木记收益 wood、建造记支出 wood——净支出多 → 经济系统自动拉高伐木概率、压低建造概率
  // （factionPriority 消费：priority 规则 flowAt 判定），无需神谕降"伐木令"
  flow: Record<string, { earn: number; spend: number }> = {};
  // 神谕目标（影响目标层，不碰选择链）：神谕降旨 → 设定一个方向，小人仍自主决策，
  // 但目标对应工作系列的抽卡权重被放大（weightRules.oracleGoal 规则），
  // 且可带蓝图副作用（垦田令 → 农田蓝图入队）——神谕只引导、不指挥
  oracleGoal: { workType: string; label: string; until: number } | null = null;

  // 神谕降旨：设定/刷新目标（幂等，重复降旨仅续期）
  setOracleGoal(def: { workType?: string; label: string; duration: number }): void {
    if (!def.workType) return;
    this.oracleGoal = { workType: def.workType, label: def.label, until: this.time + def.duration };
    this.logEvent(`🎯 神谕降旨：${def.label}（目标持续 ${def.duration}s）`);
  }
  // 科技表（HUD 展示用：id → 名称/说明/所需碎片数）
  get techsMap(): Record<string, { name: string; desc: string; fragments: number }> {
    return Object.fromEntries(Object.entries(TECHS).map(([id, t]) => [id, { name: t.name, desc: t.desc, fragments: t.fragments ?? 1 }]));
  }

  // 抽到科技卡 → 解锁（幂等）
  // 科技解锁时间（渐进权重：科技建筑解锁后建造倾向随时间爬升——用户设计）
  techUnlockedAt: Record<string, number> = {};

  unlockTech(techId: string): boolean {
    if (this.techs.has(techId)) return false;
    this.techs.add(techId);
    this.techUnlockedAt[techId] = this.time;
    const def = TECHS[techId];
    this.logEvent(`🔬 科技完成：${def?.name ?? techId}（碎片攒齐）`);
    return true;
  }

  // 该科技所需碎片总数（def.fragments ?? 1 = 整卡直接解锁，mod/旧数据兼容）
  fragmentsNeeded(techId: string): number {
    return TECHS[techId]?.fragments ?? 1;
  }

  // 拾获一块科技碎片（2026-08-14 碎片制）：攒满 → unlockTech 自动解锁整卡。
  // 返回 true = 本次拾获有效（未解锁科技）；已解锁/未知科技返回 false（幂等防刷）。
  // 日志：碎片拾获（带 x/N 进度）与解锁（🔬 科技完成）分离，玩家可见攒集过程。
  grantTechFragment(techId: string): boolean {
    if (this.techs.has(techId)) return false;
    const needed = this.fragmentsNeeded(techId);
    const have = (this.techFragments[techId] ?? 0) + 1;
    this.techFragments[techId] = have;
    const def = TECHS[techId];
    if (have >= needed) {
      this.logEvent(`🔩 拾获 ${def?.name ?? techId} 碎片（${have}/${needed}）——碎片攒齐！`);
      return this.unlockTech(techId);
    }
    this.logEvent(`🔩 拾获 ${def?.name ?? techId} 碎片（${have}/${needed}）`);
    return true;
  }

  // 科技建筑建造权重（0→1 渐进）：解锁时 0（只有娱乐探索卡能命中），
  // 随解锁时长线性爬升到 1（普通建造卡也能自动建）——tuning.tech.weightRamp
  techBuildWeight(techId: string): number {
    const at = this.techUnlockedAt[techId];
    if (at === undefined) return 0;
    const ramp = this.mods.tuning.tech.weightRamp;
    return Math.min(1, (this.time - at) / ramp);
  }

  constructor(opts: SimOptions = {}) {
    const seed = opts.seed ?? 12345;
    const pawnCount = opts.pawnCount ?? 4;
    this.initialPawnCount = pawnCount; // bootstrap 玩法包 init 据此刷人（2026-08-15 纯引擎）
    this.tickHz = opts.tickHz ?? 20;
    // 装配初始数据（数据驱动：初始库存/初始气温/昼夜时长读 tuning）
    this.stockpile = { ...TUNING.population.startStockpile };
    this.env = initEnv(TUNING.env);
    this.dayLength = TUNING.env.dayLength;
    // 预建注册表（服务端 mod 管理器先挂载包）；缺省默认装配
    if (opts.registry) this.mods = opts.registry;
    // 应用 mod（在 world/spawn 前，可覆盖 defs/tuning/配方）——构造期回调
    opts.mods?.(this.mods);
    this._eventProvider = opts.eventProvider ?? null;
    this.ecs = createWorld();
    registerAutoStore(this.ecs, Position);
    registerAutoStore(this.ecs, NeedsComp);
    registerAutoStore(this.ecs, Speed);
    registerAutoStore(this.ecs, Health);
    // 2026-08-14 用户裁决：mod 只在初始化时装配（opts.mods 回调 + 默认包已在上面完成），
    // 不需要运行时热插拔——因此 defs 在此快照进 World 是既定设计：Sim 构造后再注册的
    // 建筑/地形进不了 world.buildingsDefs（placeBuilding 会拒），属预期行为，不做动态支持
    this.world = new World(seed, { tiles: this.mods.tiles, buildings: this.mods.buildings });
    this.rng = new SimRng(seed + 1);
    this.bus = new EventBus();
    // 瓦片变更 → 事件总线（server 增量推送 / mod 订阅 / 测试断言的统一入口）
    this.world.onTileChange = (x, y, tileId) => {
      this.bus.emit({ type: 'tile_changed', x, y, tileId });
      // 地形变更（伐木/采矿/事件改地形）→ 可走性可能变化 → 寻路缓存（含失败缓存）失效
      // 背景：失败路径加入缓存后，必须在地形变更时清掉，否则"伐木后目标变可达"仍被旧失败缓存拒
      this.clearTrailCache();
    };
    // 所有事件 → 结构化历史
    this.bus.onAny((ev) => this.history.record(ev, this.time, this.time / this.dayLength));
    // 2026-08-15 纯引擎：出生刷人/初始营地/建篝火归属回调移入 bootstrap 玩法包系统
    // （本构造器不再 spawn——引擎只装配，玩法引导由包提供）。此处仅装配系统并跑系统 init。
    this.applyMods();
    // 引擎命令注册（2026-08-15 behavior 内核化：assign/oracle 从 behavior 玩法包迁回引擎协议面）
    // 背景：决策引擎归内核（SYSTEM_DEFS 内联 ctor）后，其输入通道（指派职业/神谕降旨）与
    //   'move' 同属引擎协议面——引擎内建命令不随系统装配/卸载消失（卸载 behavior 后命令仍
    //   在，只是无人消费输入，无害）。一致性：走同一 commandHandlers 表 + registerCommand
    //   冲突检测——玩法包重复注册同名命令即抛错，不因来源不同而行为差异。
    this.mods.registerCommand('assign', (ctx, cmd) => {
      // 指派职业：改小人 assignedJob（behavior 抽卡用），幂等写 pawnStates
      const eids = cmd.pawnId ? [cmd.pawnId] : ctx.selected;
      for (const eid of eids) {
        const st = ctx.pawnStates.get(eid);
        if (!st) continue;
        st.assignedJob = cmd.job || undefined;
        ctx.logEvent(st.assignedJob ? `📋 指派 #${eid} 为 ${jobLabelOf(cmd.job!)}` : `📋 取消 #${eid} 的指派`);
      }
    });
    this.mods.registerCommand('oracle', (ctx, cmd) => {
      // 神谕降旨（原 Sim.oracleInfluence）：须在声明 capabilities:['oracle'] 的建筑上发布，
      // 祝福附近高信仰小人（buff/信仰/心情）——只影响"目标层"，执行仍由小人自主
      const b = ctx.world.getBuilding(cmd.x, cmd.y);
      if (!b || !(b.def.capabilities?.includes?.('oracle'))) {
        ctx.logEvent('⛪ 神谕只能在神圣祭坛降下');
        return;
      }
      const f = ctx.tuning.faith;
      const R = f.oracleRadius;
      let affected = 0;
      for (const eid of ctx.pawnList) {
        const pos = ctx.pawnPositions.get(eid);
        if (!pos) continue;
        const d = Math.hypot(pos.x - cmd.x, pos.y - cmd.y);
        if (d > R) continue;
        const st = ctx.pawnStates.get(eid);
        if (!st) continue;
        const trust = (st.faith ?? 0) / 100;
        if (trust < f.oracleTrustAt) continue;
        st.oracleBuff = { until: ctx.time + f.oracleDuration, mood: f.oracleMood * trust };
        ctx.adjustMood(eid, Math.round((f.oracleMood / 2) * trust));
        st.faith = Math.min(100, (st.faith ?? 0) + f.oracleFaith);
        affected++;
      }
      ctx.logEvent(affected > 0 ? `✨ 神谕降下，${affected} 位信众受到祝福` : '✨ 神谕降下，却无人聆听');
    });
    this.registerSystems();
    this._started = true;
    this.registry.initAll(this.bus);
  }

  private applyMods(): void {
    // mod 注册的系统（实例 API，旧式）挂到系统注册表
    for (const s of this.mods.allSystems) this.registry.register(s);
  }

  private registerSystems(): void {
    // 数据驱动：执行序 = 类别语义序(CATEGORY_ORDER) × 组内注册序推导（2026-08-15 一致性重构）。
    // 背景：BASE_SYSTEM_ORDER 全量数组要手工维护 25 行，新增玩法包需同时动 playstyle 清单和
    //   系统表两处。改为：类别序（7 类语义序，boot 引导类恒表尾）为唯一人工语义；组内序 =
    //   注册序（apply 序——requires 拓扑自动拉齐，清单不承担图约束）。默认清单（stable 初始
    //   注册序）与推导组合后与旧数组逐位一致，执行序零漂移（assembly.test 有显式期望序断言）。
    // 一致性（用户 2026-08-15 裁决"插件/mod 不要有不一致行为"）：内核系统（SYSTEM_DEFS 内联
    //   ctor，behavior 决策引擎）与插件系统（包回填 ctor）走完全相同的装配规则——同一类别
    //   推导、同一卸载过滤（isSystemEnabled）、同一 before 锚点兜底；区别只有 ctor 来源。
    const order: SystemDef[] = [];
    for (const cat of CATEGORY_ORDER) {
      // 内核系统（SYSTEM_DEFS 内联 ctor）排在组内最前；插件系统按注册序（apply 序）跟进
      for (const d of Object.values(SYSTEM_DEFS)) {
        if (d.category !== cat || !d.ctor) continue; // 只推内核系统（占位条目不推，由插件 def 顶替）
        if (!this.mods.isSystemEnabled(d.id)) continue;
        order.push(d);
      }
      for (const m of this.mods.systemDefs) {
        // 只推"表内 id"的插件系统（表外 = 第三方/新玩法 → 留待兜底循环按 before 锚点插位，
        // 保持旧语义"清单外系统 = 锚点插位或表尾"——2026-08-15 重构防锚点被推导循环抢先）
        if (!SYSTEM_DEFS[m.id] || SYSTEM_DEFS[m.id]?.ctor) continue; // 表外/内核 id 跳过
        if (m.category !== cat) continue;
        if (!this.mods.isSystemEnabled(m.id)) continue;
        order.push(m);
      }
    }
    // 兜底：清单外（第三方/新玩法）系统——id 已在推导序 → 跳过；否则按 before 锚点插位。
    // 卸载过滤在此同样生效（防禁用系统经兜底追加回序——2026-08-15 重构回归保护：
    // 旧架构占位条目天然屏蔽，新推导序里被禁系统不在序中，兜底循环必须显式检查）。
    for (const m of this.mods.systemDefs) {
      if (!this.mods.isSystemEnabled(m.id)) continue;
      if (order.some((d) => d.id === m.id)) continue;
      const idx = order.findIndex((d) => d.id === m.before);
      if (m.before && idx >= 0) {
        // 插到锚点前、但已在锚点前的同锚点组之后（保持同组注册序）
        let at = idx;
        for (let j = idx; j < order.length && order[j].before === m.before; j++) at = j + 1;
        order.splice(at, 0, m);
      } else order.push(m);
    }
    for (const d of order) {
      if (!d.ctor) continue;         // 占位且无包提供 → 跳过（启用态不该发生）
      const sys = d.ctor(this);
      this.registry.register(sys);
      // 能力自报：玩法包系统构造时 self-provide（behavior/socialUnits/economy/bootstrap），
      // Sim 经 getter 消费——内核系统 behavior 也走同一路径（systems.ts 内联 ctor 里 provide），
      // 一致性：所有系统的能力供给/消费不区分内核还是插件
    }
    // mod 注册的意图/工作执行器交给行为系统（系统实例确定后挂接）。
    // 卸载 behavior（disableSystem('behavior')）后 this.behavior 回落 null → 跳过挂接，
    // 卸载不破坏核心（与其他系统同一卸载语义）。
    if (this.behavior) {
      for (const [id, fn] of this.mods.intents) this.behavior.registerIntent(id, fn);
      for (const [type, fn] of this.mods.works) this.behavior.registerWork(type, fn);
    }
  }

  // ---- 系统可通过 SimContext 访问 ----
  // 数据驱动装配后的执行顺序（调试/工具/测试用）
  get systemIds(): readonly string[] { return this.registry.all.map((s) => s.id); }
  get pawnList(): readonly number[] { return this._pawnList; }

  readPosition(eid: number): PositionData | null {
    if (Position.x[eid] === undefined) return null;
    return { x: Position.x[eid], y: Position.y[eid] };
  }
  readNeeds(eid: number): NeedsData | null {
    if (NeedsComp.food[eid] === undefined) return null;
    return { food: NeedsComp.food[eid], rest: NeedsComp.rest[eid], mood: NeedsComp.mood[eid], san: NeedsComp.san[eid] ?? 100 };
  }
  readHealth(eid: number): HealthData | null {
    if (Health.hp[eid] === undefined) return null;
    return { hp: Health.hp[eid], maxHp: Health.maxHp[eid] };
  }
  readSpeed(eid: number): SpeedData | null {
    if (Speed.v[eid] === undefined) return null;
    return { v: Speed.v[eid] };
  }
  setNeeds(eid: number, n: NeedsData): void { setComponent(this.ecs, eid, NeedsComp, n); }
  setHealth(eid: number, h: HealthData): void { setComponent(this.ecs, eid, Health, h); }
  setPosition(eid: number, p: PositionData): void { setComponent(this.ecs, eid, Position, p); }

  isNight(): boolean {
    return this.dayTime > this.tuning.env.nightStart || this.dayTime < this.tuning.env.nightEnd;
  }

  moveTo(eid: number, x: number, y: number): void {
    const pos = this.readPosition(eid);
    if (!pos) return;
    // 寻路带单位通过能力（高差判定）：每个单位各自 climb
    const path = this.getPath(Math.round(pos.x), Math.round(pos.y), Math.round(x), Math.round(y), this.pawnStates.get(eid)?.climb);
    const st = this.pawnStates.get(eid);
    if (st) {
      st.path = path;
      st.pathIndex = 0;
      st.mineTarget = undefined;
      st.mining = undefined;
      st.chopTarget = undefined;
      st.chopXY = undefined;
      st.chopProgress = undefined;
      st.prayTarget = undefined;
      st.praying = undefined;
      st.healTarget = undefined;
      st.healing = undefined;
      // 玩家命令优先：短暂时间内不自动决策
      st.commandCooldown = this.tuning.card.commandCooldown;
    }
  }

  // 工作移动（寻路风暴修复，用户要求）：
  //  1) 限定最大距离 maxWorkDist——超距目标不寻路（工作限距；玩家 move 命令走 moveTo 不限）
  //  2) 寻路节流 pathCd——两次寻路最小间隔；路径缓存后按步走完（path 存在时决策层直接 walk 不重寻）
  //  根因记录：野猫袭击中 path 被频繁打断重建 → 每帧寻路风暴（findPathRaw 75%，50ms/步）；
  //  修复后：被打断的小人在 pathCd 内不重寻，路径稳定走完，寻路频率回归常数级
  moveAdjacent(eid: number, tx: number, ty: number): boolean {
    const pos = this.readPosition(eid);
    if (!pos) return false;
    const maxD = this.mods.tuning.pawn.maxWorkDist;
    if (Math.hypot(tx - pos.x, ty - pos.y) > maxD) return false; // 限定最大距离（不要太远）
    const st = this.pawnStates.get(eid);
    if (st && (st.pathCd ?? 0) > 0) return false; // 寻路节流
    // 9 格邻接目标搜索带 z 判定（起点 z = 当前格 z）：石丘顶的目标（Δ2 不可攀）
    // 直接不发起寻路 → 省一次满跑 A*（高差地图性能优化）
    const climb = st?.climb ?? this.tuning.pawn.climb;
    const zHere = this.world.getTileDef(Math.round(pos.x), Math.round(pos.y)).z ?? 0;
    let target: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = tx + dx, ny = ty + dy;
        if (!this.world.inBounds(nx, ny)) continue;
        if (!this.world.isPassable(nx, ny, zHere, climb)) continue;
        const d = (nx - pos.x) * (nx - pos.x) + (ny - pos.y) * (ny - pos.y);
        if (d < bestD) { bestD = d; target = { x: nx, y: ny }; }
      }
    }
    if (!target || !st) return false;
    const path = this.getPath(Math.round(pos.x), Math.round(pos.y), target.x, target.y, climb);
    if (path.length > 0) {
      st.path = path;
      st.pathIndex = 0;
      st.pathCd = this.mods.tuning.path.pathCd; // 寻路节流冷却
      st.commandCooldown = this.tuning.card.commandCooldown;
      return true;
    }
    return false;
  }

  findNearest(pos: PositionData, cond: (x: number, y: number) => boolean, allowNonPassable = false, radius?: number): { x: number; y: number } | null {
    const R = radius ?? this.mods.tuning.pawn.scanRadius;
    let best: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (let r = 1; r <= R; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = Math.round(pos.x) + dx;
          const y = Math.round(pos.y) + dy;
          if (!this.world.inBounds(x, y)) continue;
          if (!allowNonPassable && !this.world.isPassable(x, y)) continue;
          if (cond(x, y)) {
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; best = { x, y }; }
          }
        }
      }
    }
    return best;
  }

  // 创建小人的唯一入口（出生/存档恢复/招募共用）：建 ECS 实体 + 初始化全部状态
  // （DNA/卡槽/技能/欲望/倾向）。卡槽按人克隆（initSlots）——mastery/熟练度不得串人
  spawnPawn(x: number, y: number): number {
    if (!this.world.inBounds(x, y) || !this.world.isPassable(x, y)) return -1;
    const eid = addEntity(this.ecs);
    addComponent(this.ecs, eid, Position);
    setComponent(this.ecs, eid, Position, { x, y });
    addComponent(this.ecs, eid, Pawn);
    addComponent(this.ecs, eid, NeedsComp);
    setComponent(this.ecs, eid, NeedsComp, initNeeds(this.tuning.needs));
    addComponent(this.ecs, eid, Speed);
    setComponent(this.ecs, eid, Speed, { v: this.tuning.pawn.baseSpeed });
    const dna = generateDna(this.seedFor(eid));
    addComponent(this.ecs, eid, Health);
    const maxHp = this.tuning.pawn.hpBase + Math.floor((dna.con + dna.siz) / 2);
    setComponent(this.ecs, eid, Health, { hp: maxHp, maxHp });
    // COC 技能初始值：INT + EDU 高 → 起点高（百分制）—— 公式参数读 tuning.pawn
    const pw = this.tuning.pawn;
    const intBase = Math.floor((dna.int - pw.skillIntFrom) / pw.skillIntDiv) + Math.floor((dna.edu - pw.skillEduFrom) / pw.skillEduDiv);
    this.pawnStates.set(eid, {
      dna,
      climb: this.tuning.pawn.climb, // 通过能力：单位各自，mod 可 overrideTuning
      slots: initSlots(dna, [...this.mods.cards.values()]),
      path: [],
      pathIndex: 0,
      skills: Object.fromEntries(Object.entries(this.tuning.pawn.skillInit).map(([k, v]) => [k, v + intBase])) as Record<SkillId, number>,
      desires: initDesires(this.rng, this.tuning.desire),
      lean: initLean(this.rng),
    });
    this._pawnList.push(eid);
    this.pawnPositions.set(eid, { x, y });
    this.bus.emit({ type: 'pawn_spawned', eid, x, y });
    return eid;
  }

  killPawn(eid: number): void {
    const idx = this._pawnList.indexOf(eid);
    if (idx >= 0) this._pawnList.splice(idx, 1);
    this.pawnStates.delete(eid);
    this.pawnPositions.delete(eid);
    this.selected = this.selected.filter((s) => s !== eid);
  }

  // COC d100 检定：阈值 = dc + INT 加成（>50 的智力带来收益），roll <= 阈值即成功
  rollEvent(eid: number, dc: number): { success: boolean; roll: number } {
    const roll = this.rng.int(1, 100);
    const st = this.pawnStates.get(eid);
    const dna = st?.dna;
    const intBonus = dna ? Math.floor((dna.int - 50) / 10) : 0;
    return { success: roll <= dc + intBonus, roll };
  }

  // 技能检定：成功阈值 = dc + 技能值/10 加成（技能越高越稳，COC 式成长收益）
  rollEventSkill(eid: number, dc: number, skill: SkillId): { success: boolean; roll: number } {
    const roll = this.rng.int(1, 100);
    const bonus = Math.floor((this.skillOf(eid, skill) - 10) / 10);
    return { success: roll <= dc + bonus, roll };
  }

  // COC 八属性读取
  dnaOf(eid: number) {
    const st = this.pawnStates.get(eid);
    if (!st) return null;
    const { str, con, int, siz, dex, app, pow, edu } = st.dna;
    return { str, con, int, siz, dex, app, pow, edu };
  }

  // 心情调整统一入口：钳制 0-100 + 广播 mood_changed（HUD 飘字/历史日志监听）
  adjustMood(eid: number, delta: number): void {
    const n = this.readNeeds(eid);
    if (!n) return;
    n.mood = Math.max(0, Math.min(100, n.mood + delta));
    this.setNeeds(eid, n);
    this.bus.emit({ type: 'mood_changed', eid, delta });
  }

  // COC 技能：读取（无则用下限 10）
  skillOf(eid: number, skill: SkillId): number {
    return this.pawnStates.get(eid)?.skills?.[skill] ?? 10;
  }

  // 行为结果学习（EWA 吸引模型）：执行某行为后按实际結果量调整吸引力 → 权重
  recordOutcome(eid: number, key: LeanKey, outcome: number): void {
    const st = this.pawnStates.get(eid);
    if (!st) return;
    st.lean = st.lean ?? initLean(this.rng);
    recordOutcome(st.lean, key, outcome, this.leanDefOf(key), this.tuning.card.lean);
  }

  // 倾向读取（抽卡权重倍率：1=中性，>1 偏做，<1 回避）
  leanOf(eid: number, key: LeanKey): number {
    const st = this.pawnStates.get(eid);
    if (!st) return 1;
    st.lean = st.lean ?? initLean(this.rng);
    return weightMulOf(st.lean, key, this.leanDefOf(key), this.tuning.card.lean);
  }

  private leanDefOf(key: LeanKey): LeanDef | undefined {
    return this.mods.leans[key];
  }

  // 技能成长（COC 规则）：掷 d100 > 当前值 → +1d10，越用越强、边际递减
  growSkill(eid: number, skill: SkillId): void {
    const st = this.pawnStates.get(eid);
    if (!st) return;
    const cur = st.skills?.[skill] ?? 10;
    if (cur >= 100) return;
    const roll = this.rng.int(1, 100);
    if (roll > cur) {
      const gain = this.rng.int(1, 10);
      st.skills = { ...st.skills, [skill]: Math.min(100, cur + gain) };
      if (gain >= 8) this.logEvent('📈 技能精进');
    }
  }

  logEvent(text: string): void {
    this.events.push({ time: this.time, text });
    if (this.events.length > 50) this.events.shift();
  }

  clearTrailCache(): void {
    this.trailCache.clear();
  }

  // ---- 个人经济预期（用户 2026-08-13 设计：每个人心里有本账）----
  // 2026-08-15 纯引擎：记账规则迁入 economy 玩法包（经 provide('economy') 能力让渡），
  // 引擎只保留委托入口；未挂 economy 包（纯引擎装配）→ 静默无操作，不破坏核心。
  // 工作产出/个人花费 各自滚动平均成预期；现实 vs 预期对比 → 情绪反馈（详见 economy 包）

  // eid 可空：null = 公共支出（建造扣公共库存）只记全局流；否则同时记个人预期
  recordEarn(eid: number | null, item: string, amount: number, workType?: string): void {
    this.getCap<EconomyCap>('economy')?.recordEarn(eid, item, amount, workType);
  }

  recordSpend(eid: number | null, item: string, amount: number): void {
    this.getCap<EconomyCap>('economy')?.recordSpend(eid, item, amount);
  }

  // 资源净支出率（经济调节输入）：spend/earn（无收益时视为 Infinity = 纯支出）
  // 纯查询留在引擎（flow 共享状态归引擎所有）
  flowRatio(item: string): number {
    const f = this.flow[item];
    if (!f || f.earn <= 0) return f && f.spend > 0 ? Infinity : 0;
    return f.spend / f.earn;
  }

  // ---- 性能分析（内置，profiler 插件消费）----
  enableProfiling(on = true): void {
    this.registry.enableProfiling(on);
  }

  get profileStats(): ReadonlyMap<string, { totalMs: number; count: number; maxMs: number; lastMs: number }> {
    return this.registry.profileStats;
  }

  // 寻路（A* 二叉堆 + 篝火航点中转，缓存带 climb）——2026-08-15 纯引擎公开入 SimContext：
  // mine/gather 命令处理器（gathering 玩法包）需要路径能力，引擎负责提供而非包自实现
  getPath(sx: number, sy: number, ex: number, ey: number, climb = this.tuning.pawn.climb): { x: number; y: number }[] {
    // ⚠️ 2026-08-14 review 修复：缓存 key 必须带 climb——寻路结果依赖单位通过能力
    //（高差判定），若不同单位 climb 不同，低 climb 的失败路径会被高 climb 的成功路径
    // 污染（反之亦然：失败路径缓存更致命）。此前 key 只含坐标，全部单位 climb 相同
    // 时无症状，mod 差异化 climb（接口声称"单位各自能力"）即错乱。
    const c = `c${climb}`;
    const key = `${sx},${sy}->${ex},${ey}#${c}`;
    const cached = this.trailCache.get(key);
    if (cached) return cached;
    // 寻路策略表（tuning.path）：迭代上限/暗区代价/启发式 + 篝火航点中转，
    // mod 可覆盖；航点段（锚点对）路径复用同一 trailCache（建筑变更 clearTrailCache 自动失效）
    // climb = 单位通过能力（高差判定），走单位各自能力（段缓存同理带 climb，见下）
    const path = findPath(this.world, sx, sy, ex, ey, this.tuning.path, {
      get: (ax, ay, bx, by) => this.trailCache.get(`${ax},${ay}->${bx},${by}#${c}`),
      set: (ax, ay, bx, by, p) => {
        if (this.trailCache.size > 8192) this.trailCache.clear();
        this.trailCache.set(`${ax},${ay}->${bx},${by}#${c}`, p);
      },
    }, climb);
    // 成功/失败都缓存：失败路径（目标被石丘/水隔断等）若每帧重算 A* 会跑满 maxIter——
    // 石丘地图实测 16x 性能退化（2026-08-14）；失败缓存在地形/建筑变更时失效
    //（onTileChange → clearTrailCache；buildSystem 建成 → clearTrailCache）
    if (this.trailCache.size > 8192) this.trailCache.clear();
    this.trailCache.set(key, path);
    return path;
  }

  // 空世界（旧档全灭/坏档）重开：重建出生点小人 + 初始营地（供客户端恢复局面）
  // 2026-08-15 纯引擎：委托 bootstrap 玩法包能力；纯引擎（无包）→ 至少清空小人兜底
  respawnPawns(count: number): void {
    const b = this.getCap<BootstrapCap>('bootstrap');
    if (b) { b.respawn(count); return; }
    for (const eid of [...this._pawnList]) this.killPawn(eid);
  }

  // 若出生点没有篝火则重建（空世界重开用）
  ensureCamp(): void {
    this.getCap<BootstrapCap>('bootstrap')?.ensureCamp();
  }

  private seedFor(eid: number): number {
    return (this.rng.int(1, 2 ** 31 - 1) ^ eid) >>> 0;
  }

  // ---- 命令 ----
  // 2026-08-15 纯引擎：issueCommand = 路由器——'move' 是引擎内建命令（实体移动），
  // 其余命令（build/mine/oracle/assign…）由玩法包 registerCommand 提供处理器
  // （signature 与 SimContext 对齐：`(ctx: SimContext, cmd: Command) => void`）。
  // 路由失败仍 logEvent 反馈（原 queueBuild 拒建反馈纪律延续）。
  issueCommand(cmd: Command): void {
    if (cmd.type === 'move') {
      const eids = cmd.pawnId ? [cmd.pawnId] : this.selected;
      for (const eid of eids) this.moveTo(eid, cmd.x, cmd.y);
      return;
    }
    const handler = this.mods.commandHandlers.get(cmd.type);
    if (handler) handler(this, cmd);
    else this.logEvent(`⚠ 未知命令：${cmd.type}`);
  }

  // 产出归集（2026-08-14 重构：派系实体删除，无单位私有库存；全部进全局仓库）
  addProductionNear(x: number, y: number, item: string, amount: number, _faction?: string): void {
    const f = this.mods.tuning.faction;
    this.stockpile[item] = Math.min(f.resourceCap, (this.stockpile[item] ?? 0) + amount);
  }

  // 建筑升级（篝火→教堂）
  upgradeBuilding(x: number, y: number, defId: string, faction: string): boolean {
    return this.world.upgradeBuilding(x, y, defId, faction);
  }

  // ---- LLM 印卡（DESIGN §6：LLM 只印卡+触发事件，不进选择链路）----
  // 生成策略卡插入目标小人槽位：槽满时替换 weight 最低的卡（神谕策略卡可顶基础卡）
  // target: 缺省随机活人；'random' 同；eid 指定某小人
  printCard(def: BehaviorCardDef, opts: { target?: number | 'random'; note?: string } = {}): number | null {
    const targets = this._pawnList.filter((eid) => this.pawnStates.has(eid));
    if (targets.length === 0) return null;
    const target = opts.target === 'random' || opts.target === undefined
      ? targets[Math.floor(this.rng.next() * targets.length)]
      : opts.target;
    const st = this.pawnStates.get(target);
    if (!st) return null;
    const card = cardFromDef(def);
    // 空槽优先；无空槽 → 替换 weight 最低的卡
    let idx = st.slots.indexOf(null);
    if (idx < 0) {
      let min = 0;
      for (let i = 1; i < st.slots.length; i++) {
        const c = st.slots[i];
        if (!c) { min = i; break; }
        const cur = st.slots[min] as BehaviorCard;
        if (c.weight < cur.weight) min = i;
      }
      idx = min;
    }
    st.slots[idx] = card;
    this.logEvent(`🃏 #${target} 收到策略卡「${card.name}」${opts.note ? `（${opts.note}）` : ''}`);
    return target;
  }

  // ---- 主循环 ----
  step(dt: number): void {
    if (this.paused) return;
    dt *= this.speed;
    // mod 钩子：step 前（可读改 sim 状态）
    this.mods.runHooks('step:before', { sim: this, dt });
    this.time += dt;
    this.dayTime = (this.time % this.dayLength) / this.dayLength;
    tickEnv(this.env, dt, this.dayTime, this.rng, this.tuning.env);
    // 2026-08-15 纯引擎：派系优先级评估迁入 economy 玩法包系统 update（exec 位在 behavior 前）
    this.registry.updateAll(dt);
    // 神谕目标到期自动清除
    if (this.oracleGoal && this.time > this.oracleGoal.until) this.oracleGoal = null;
    // mod 钩子：step 后（观察结果）
    this.mods.runHooks('step:after', { sim: this, dt });
  }

  // ---- UI 读取 ----
  get pawns(): readonly number[] { return this._pawnList; }  get buildCount(): number { return this.buildQueue.length; }
  get buildQueueItems(): { x: number; y: number; defId: string; progress: number }[] {
    return this.buildQueue.map((b) => ({ x: b.x, y: b.y, defId: b.defId, progress: b.progress }));
  }
  buildingAt(x: number, y: number): { def: BuildingDef; defId: string; hp: number; maxHp: number; faction: string } | null {
    const b = this.world.getBuilding(x, y);
    if (!b) return null;
    return { def: b.def, defId: b.def.id, hp: Math.round(b.hp), maxHp: b.def.hp, faction: b.faction };
  }

  // 该位置的篝火记忆（2026-08-14 重构：无派系单位，返回区域记忆文本）
  unitAt(x: number, y: number) {
    const key = this.world.buildKey(x, y);
    return this.socialUnits.fireHistory(key, 5);
  }

  // 派系 = 涌现展示（2026-08-14 用户裁决：派系不是系统，只是个体关系的浮现）。
  // 遍历所有 campfire 建筑（含空营地），成员 = 按 pawn.fireId 归属的小人。
  // 无库存/无贸易/无战争，纯只读。供 HUD/客户端展示。
  factionsView() {
    const byFire = new Map<number, number[]>();
    for (const eid of this.pawnList) {
      const fireId = this.pawnStates.get(eid)?.fireId;
      if (fireId == null) continue;
      const arr = byFire.get(fireId) ?? [];
      arr.push(eid);
      byFire.set(fireId, arr);
    }
    const out: { key: number; members: number[]; memory: { time: number; text: string }[]; label: string }[] = [];
    for (const [key, b] of this.world.buildings) {
      if (b.def.id !== 'campfire') continue;
      out.push({
        key,
        members: byFire.get(key) ?? [],
        memory: (this.world.fireMemory.get(key) ?? []).slice(-3),
        label: b.def.name,
      });
    }
    return out;
  }

  // 征服已删除（2026-08-14 重构：派系实体层删除，无单位可吞并）
  pawnJob(eid: number): string { return this.pawnStates.get(eid)?.job ?? ''; }
  healthOf(eid: number) { return this.readHealth(eid); }
  get selectedIds(): number[] { return this.selected; }
  set selectedIds(list: number[]) { this.selected = list; }

  pawnProfile(eid: number): {
    dna: Dna; slots: ReturnType<typeof initSlots>; job: string;
    needs: NeedsData | null; health: HealthData | null; pos: { x: number; y: number };
    faith: number;
    skills: Partial<Record<SkillId, number>>;
    desires: Record<DesireId, number>;
    oracleBuff?: { until: number; mood: number };
    assignedJob?: string;
    lastDecision?: { drawn: string[]; picked: string; time: number };
  } | null {
    const st = this.pawnStates.get(eid);
    if (!st) return null;
    return {
      dna: st.dna, slots: st.slots, job: st.job ?? '',
      needs: this.readNeeds(eid), health: this.readHealth(eid),
      pos: this.pawnPositions.get(eid) ?? { x: 0, y: 0 },
      faith: st.faith ?? 0,
      skills: st.skills ?? {},
      desires: st.desires ?? initDesires(this.rng, this.tuning.desire),
      oracleBuff: st.oracleBuff,
      assignedJob: st.assignedJob,
      lastDecision: st.lastDecision,
    };
  }

  // ---- 历史查询 ----
  historyQuery(opts?: { type?: string; eid?: number; limit?: number }) {
    return this.history.query(opts);
  }
  get historyRecent() { return this.history.recent; }

  // ---- 存档 ----
  save(): SaveData {
    return {
      time: this.time,
      dayTime: this.dayTime,
      stockpile: { ...this.stockpile },
      tiles: this.world.serializeChunks(),
      buildings: this.world.serializeBuildings(),
      techs: [...this.techs],
      techFragments: { ...this.techFragments }, // 碎片进度随档（攒一半的科技读档继续攒）
      pawns: this._pawnList.map((eid) => {
        const st = this.pawnStates.get(eid)!;
        const pos = this.readPosition(eid)!;
        return {
          eid,
          x: pos.x, y: pos.y,
          dna: st.dna,
          slots: st.slots.map((c) => (c ? { id: c.id, m: c.mastery ?? 0, u: c.lastUsed ?? 0 } : null)),
          needs: this.readNeeds(eid),
          health: this.readHealth(eid),
          faith: st.faith ?? 0,
          skills: st.skills ?? {},
          desires: st.desires ?? initDesires(this.rng, this.tuning.desire),
          inventory: st.inventory ?? {},
          oracleBuff: st.oracleBuff,
          assignedJob: st.assignedJob,
          fireId: st.fireId ?? null,
          knownFires: st.knownFires,
          extra: st.extra ?? {}, // mod 自定义字段随档（存档扩展点：伤情/囚犯/电力等玩法包状态）
          // 瞬时工作态（path/mineTarget/chopXY/praying/healing/mining/各类冷却/job/lastDecision/urgent）
          // **不随档**——有意轻量存档（2026-08-15 审计裁决，DATA_DRIVEN §14）：读档后小人
          // 回闲置态重新决策；长期目标（assignedJob/oracleBuff/fireId）已在上面顶层随档。
        };
      }),
    };
  }

  load(data: SaveData): void {
    this.techs = new Set(data.techs ?? []);
    // 碎片进度还原（2026-08-14 碎片制；旧档无此字段 → 空表，已解锁科技不受影响）
    this.techFragments = data.techFragments ? { ...data.techFragments } : {};
    this.time = data.time ?? 0;
    this.dayTime = data.dayTime ?? 0;
    if (data.stockpile) this.stockpile = { ...TUNING.population.startStockpile, ...data.stockpile };
    // 存档地形：旧档全量 string[]（192×192）→ loadTiles；新档覆盖层 chunk → loadChunks
    //（无限地图双图层——DESIGN §375：覆盖层才需要持久化）
    if (data.tiles) {
      if (Array.isArray(data.tiles) && typeof data.tiles[0] === 'string') this.world.loadTiles(data.tiles as string[]);
      else this.world.loadChunks(data.tiles as ChunkData[]);
    }
    if (data.buildings) this.world.loadBuildings(data.buildings);
    // 篝火区域记忆随建筑重建（loadBuildings 已恢复建筑；旧档无 fireMemory，从空开始）
    this.world.fireMemory.clear();
    for (const [key, b] of this.world.buildings) {
      if (b.def.id === 'campfire' || b.def.tags?.includes('anchor')) {
        this.world.fireMemory.set(key, [{ time: this.time, text: '🏕 营地重建' }]);
      }
    }
    // 重建小人（拷贝列表遍历，否则 killPawn 的 splice 会跳过隔一个）
    for (const eid of [...this._pawnList]) this.killPawn(eid);
    if (data.pawns) {
      for (const p of data.pawns) {
        const eid = this.spawnPawn(Math.round(p.x), Math.round(p.y));
        if (eid === -1) continue;
        const st = this.pawnStates.get(eid)!;
        st.dna = p.dna;
        // 卡槽存 id（JSON-safe）：还原时按 id 从 mod 卡 → 基础卡 → 天赋卡 重取；查不到降级 null（抽卡跳过）
        st.slots = (p.slots ?? []).map((slot) => {
          if (!slot) return null;
          // 旧档：纯 id 字符串（无熟练度）；新档：{ id, m, u }
          const id = typeof slot === 'string' ? slot : slot.id;
          const found = this.mods.cards.get(id) ?? BASE_CARDS.find((b) => b.id === id) ?? Object.values(TRAIT_CARDS).find((c) => c.id === id) ?? INTEREST_CARDS.get(id) ?? null;
          if (!found) return null;
          const card = { ...found }; // 克隆（防共享单例 mastery 串）
          if (typeof slot === 'object') {
            card.mastery = slot.m;
            card.lastUsed = slot.u;
          }
          return card;
        });
        st.faith = p.faith ?? 0;
        st.skills = p.skills ?? {};
        st.desires = p.desires ?? initDesires(this.rng, this.tuning.desire);
        st.inventory = p.inventory ?? {};
        st.oracleBuff = p.oracleBuff;
        st.assignedJob = p.assignedJob;
        st.fireId = p.fireId ?? null;
        st.knownFires = p.knownFires;
        if (p.extra) st.extra = p.extra; // mod 自定义字段还原（JSON-safe，玩法定制的状态如伤情/囚犯/电力账户随档）
        if (p.needs) this.setNeeds(eid, p.needs);
        if (p.health) this.setHealth(eid, p.health);
      }
    }
    // 重建后把小人重新归入最近的派系单位（否则 members 恒空）
    for (const eid of this._pawnList) this.socialUnits.assignPawn(eid);
  }

  // 瓦片变更监听：server 推增量 / 测试断言（P1 网络层）。订阅返回退订函数
  addTileListener(fn: (x: number, y: number, tileId: string) => void): () => void {
    const on = (ev: GameEvent) => {
      if (ev.type === 'tile_changed') fn(ev.x, ev.y, ev.tileId);
    };
    const off = this.bus.on('tile_changed', on as never);
    return off;
  }
}
