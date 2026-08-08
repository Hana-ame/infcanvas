// mod 注册表（DESIGN §7 扩展性原则 + docs/DATA_DRIVEN.md §5）
// 目标：任何 mod 能力都应能通过注册表实现，不改 sim 源码。
// 注册时机：Sim 构造后立即调用（服务端加载 mod → 注册 → defs 只读下发客户端）。
import type { Sim } from '../sim';
import type { TileDef, BuildingDef, ItemDef } from '../defs';
import type { EnemyDef } from '../defs/enemies';
import type { RecipeDef } from '../defs/recipes';
import type { TuningConfig } from '../defs/tuning';
import type { BehaviorCard } from '../ai/pawn';
import type { IntentExecutor, WorkExecutor } from '../systems/cardSystem';
import type { GameSystem } from '../systems/registry';
import type { ScriptedEvent } from '../systems/eventSystem';
import type { ExpansionPlan } from '../systems/autonomousBuildSystem';
import { DESIRES } from '../core/desires';

// 生命周期钩子上下文（step:before / step:after，见 sim.step）
export interface HookContext {
  sim: Sim;
  dt: number;
}

type RegistryMap = Map<string, unknown>;

// 登记项（含冲突检测）
export class ModRegistry {
  // 内部 Map（冲突检测 / 覆盖 / 新增都用 Map）
  tilesMap = new Map<string, TileDef>();
  buildingsMap = new Map<string, BuildingDef>();
  itemsMap = new Map<string, ItemDef>();
  enemiesMap = new Map<string, EnemyDef>();
  cards = new Map<string, BehaviorCard>();
  intents = new Map<string, IntentExecutor>();
  works = new Map<string, WorkExecutor>();
  recipesMap = new Map<string, RecipeDef>();
  events: ScriptedEvent[] = [];
  expansionPlans: ExpansionPlan[] = [];
  tuning: TuningConfig;
  private systems: GameSystem[] = [];
  private hooks = new Map<string, Array<(ctx: HookContext) => void>>();
  private cache = new Map<string, Record<string, unknown>>();

  constructor(seed: {
    tiles: Record<string, TileDef>;
    buildings: Record<string, BuildingDef>;
    items: Record<string, ItemDef>;
    enemies: Record<string, EnemyDef>;
    cards: BehaviorCard[];
    recipes: Record<string, RecipeDef>;
    tuning: TuningConfig;
    intents: [string, IntentExecutor][];
    works: [string, WorkExecutor][];
  }) {
    for (const [k, v] of Object.entries(seed.tiles)) this.tilesMap.set(k, v);
    for (const [k, v] of Object.entries(seed.buildings)) this.buildingsMap.set(k, v);
    for (const [k, v] of Object.entries(seed.items)) this.itemsMap.set(k, v);
    for (const [k, v] of Object.entries(seed.enemies)) this.enemiesMap.set(k, v);
    for (const [k, v] of Object.entries(seed.recipes)) this.recipesMap.set(k, v);
    for (const c of seed.cards) this.cards.set(c.id, c);
    for (const [k, v] of seed.intents) this.intents.set(k, v);
    for (const [k, v] of seed.works) this.works.set(k, v);
    this.tuning = structuredClone(seed.tuning);
  }

  // 只读 Record 视图（World/Sim 等消费方按 id 索引；Map 用于冲突检测/覆盖）
  get tiles(): Record<string, TileDef> {
    return this.record('tiles', this.tilesMap);
  }
  get buildings(): Record<string, BuildingDef> {
    return this.record('buildings', this.buildingsMap);
  }
  get items(): Record<string, ItemDef> {
    return this.record('items', this.itemsMap);
  }
  get enemies(): Record<string, EnemyDef> {
    return this.record('enemies', this.enemiesMap);
  }
  get recipes(): Record<string, RecipeDef> {
    return this.record('recipes', this.recipesMap);
  }

  // 敌人定义查询：按 id 查（缺省用 tuning.combat.raidEnemy），查不到回退第一项
  // 供袭击系统共用（自然袭击 / 派系袭击），overrideDef('enemy') 即时生效
  enemyDef(id?: string): EnemyDef {
    const key = id ?? this.tuning.combat.raidEnemy;
    return this.enemies[key] ?? Object.values(this.enemies)[0];
  }

  private record<T>(key: string, map: Map<string, T>): Record<string, T> {
    let r = this.cache.get(key) as Record<string, T> | undefined;
    if (!r) {
      r = Object.fromEntries(map);
      this.cache.set(key, r);
    }
    return r;
  }

  // ---- 新增定义（id 冲突 → 抛错，防静默覆盖）----
  registerTile(def: TileDef): this {
    this.assertNew('tile', def.id, this.tilesMap);
    this.tilesMap.set(def.id, def);
    this.cache.delete('tiles');
    return this;
  }

  registerBuilding(def: BuildingDef): this {
    this.assertNew('building', def.id, this.buildingsMap);
    this.buildingsMap.set(def.id, def);
    this.cache.delete('buildings');
    return this;
  }

  registerItem(def: ItemDef): this {
    this.assertNew('item', def.id, this.itemsMap);
    this.itemsMap.set(def.id, def);
    this.cache.delete('items');
    return this;
  }

  registerEnemy(def: EnemyDef): this {
    this.assertNew('enemy', def.id, this.enemiesMap);
    this.enemiesMap.set(def.id, def);
    this.cache.delete('enemies');
    return this;
  }

  registerCard(card: BehaviorCard): this {
    this.assertNew('card', card.id, this.cards);
    this.cards.set(card.id, card);
    return this;
  }

  registerRecipe(def: RecipeDef): this {
    this.assertNew('recipe', def.id, this.recipesMap);
    this.recipesMap.set(def.id, def);
    this.cache.delete('recipes');
    return this;
  }

  // 新意图执行器：新 AI 行为 = 注册一个 executor（客户端只收结果）
  registerIntent(id: string, fn: IntentExecutor): this {
    if (this.intents.has(id)) throw new Error(`mod: intent "${id}" 已存在`);
    this.intents.set(id, fn);
    return this;
  }

  // 新工作类型执行器：walkAndWork 按 workType 分派到这里（卡 decide 产出非内置 workType 时必配）
  registerWork(type: string, fn: WorkExecutor): this {
    if (this.works.has(type)) throw new Error(`mod: work "${type}" 已存在`);
    this.works.set(type, fn);
    return this;
  }

  // 新欲望维度（DESIGN §3）：进入欲望循环（初始值/衰减/匮乏/恶意槽/满足自动成立）。
  // mod 卡用 satisfies / desire 字段引用新欲望 id 即完成接线。
  // DESIRES 是模块级目录（跨 Sim 实例共享）：同 id 同 label 重复注册幂等，不同定义才抛冲突
  registerDesire(id: string, label: string): this {
    if (id in DESIRES) {
      if (DESIRES[id].label === label) return this;
      throw new Error(`mod: desire "${id}" 冲突（已定义为「${DESIRES[id].label}」）`);
    }
    DESIRES[id] = { label };
    return this;
  }

  registerSystem(s: GameSystem): this {
    this.systems.push(s);
    return this;
  }

  // 新剧本事件（mod 玩法）：与内置事件同池，condition/cooldown/weight 生效
  registerEvent(ev: ScriptedEvent): this {
    if (this.events.some((e) => e.id === ev.id)) throw new Error(`mod: event "${ev.id}" 已存在`);
    this.events.push(ev);
    return this;
  }

  // 新自主建造计划（mod 玩法）：defId + 条件 + 成本
  registerExpansionPlan(plan: ExpansionPlan): this {
    if (this.expansionPlans.some((p) => p.id === plan.id)) throw new Error(`mod: expansion "${plan.id}" 已存在`);
    this.expansionPlans.push(plan);
    return this;
  }

  // ---- 覆盖既有定义（部分字段合并，不改未覆盖字段）----
  overrideDef(kind: 'tile' | 'building' | 'item' | 'card' | 'recipe' | 'enemy', id: string, patch: Record<string, unknown>): this {
    const map = this.mapFor(kind);
    if (!map || !map.has(id)) throw new Error(`mod: 覆盖目标 ${kind} "${id}" 不存在`);
    map.set(id, { ...(map.get(id) as Record<string, unknown>), ...patch });
    const cacheKey = kind === 'card' ? null : kind + 's';
    if (cacheKey) this.cache.delete(cacheKey);
    return this;
  }

  private mapFor(kind: 'tile' | 'building' | 'item' | 'card' | 'recipe' | 'enemy'): RegistryMap {
    switch (kind) {
      case 'tile': return this.tilesMap;
      case 'building': return this.buildingsMap;
      case 'item': return this.itemsMap;
      case 'card': return this.cards;
      case 'recipe': return this.recipesMap;
      case 'enemy': return this.enemiesMap;
    }
  }

  // 覆盖平衡参数（深合并，只改覆盖字段）
  overrideTuning(patch: DeepPartial<TuningConfig>): this {
    this.tuning = deepMerge(this.tuning, patch);
    return this;
  }

  // 阶段钩子：check 流程 beforeRoll 等（mod 可插入）
  registerHook(stage: string, fn: (ctx: HookContext) => void): this {
    if (!this.hooks.has(stage)) this.hooks.set(stage, []);
    this.hooks.get(stage)!.push(fn);
    return this;
  }

  runHooks(stage: string, ctx: HookContext): void {
    this.hooks.get(stage)?.forEach((fn) => fn(ctx));
  }

  get allSystems(): GameSystem[] {
    return this.systems;
  }

  private assertNew(kind: string, id: string, map: Map<string, unknown>): void {
    if (map.has(id)) throw new Error(`mod: ${kind} "${id}" 已存在，请用不同 id`);
  }
}

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(target: T, patch: DeepPartial<T>): T {
  if (isPlainObject(target) && isPlainObject(patch)) {
    const out: Record<string, unknown> = { ...target };
    for (const k of Object.keys(patch)) {
      const pv = patch[k];
      if (pv === undefined) continue;
      if (isPlainObject(out[k]) && isPlainObject(pv)) out[k] = deepMerge(out[k], pv);
      else out[k] = pv;
    }
    return out as T;
  }
  return (patch === undefined ? target : patch) as T;
}
