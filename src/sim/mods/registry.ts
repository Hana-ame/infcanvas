// mod 注册表（DESIGN §7 扩展性原则 + docs/DATA_DRIVEN.md §5）
// 目标：任何 mod 能力都应能通过注册表实现，不改 sim 源码。
// 注册时机：Sim 构造后立即调用（服务端加载 mod → 注册 → defs 只读下发客户端）。
import type { Sim } from '../sim';
import type { TileDef, BuildingDef, ItemDef } from '../defs';
import { TILES, BUILDINGS, ITEMS } from '../defs';
import { TUNING } from '../defs/tuning';
import type { EnemyDef } from '../defs/enemies';
import { ENEMIES } from '../defs/enemies';
import type { RecipeDef } from '../defs/recipes';
import { RECIPES } from '../defs/recipes';
import type { TuningConfig } from '../defs/tuning';
import type { BehaviorCard, BehaviorCardDef } from '../ai/pawn';
import { cardFromDef, BASE_CARDS } from '../ai/pawn';
import type { IntentExecutor, WorkExecutor } from '../systems/cardSystem';
import type { GameSystem } from '../systems/registry';
import type { SystemDef } from '../defs/systems';
import type { ScriptedEvent } from '../systems/eventSystem';
import type { ExpansionPlan } from '../systems/autonomousBuildSystem';
import { DESIRES } from '../core/desires';
import type { DesireId } from '../core/desires';
import { TRAITS as BUILTIN_TRAITS, type TraitDef } from '../defs/traits';
import { INTERESTS as BUILTIN_INTERESTS, type InterestDef } from '../defs/interests';
import { MARKOV_BIAS as BUILTIN_MARKOV, SERIES_TO_DESIRE as BUILTIN_SERIES } from '../defs/behavior';
import { JOBS as BUILTIN_JOBS } from '../defs/jobs';
import { LEANS as BUILTIN_LEANS, type LeanDef, type LeanKey } from '../defs/leans';
import { CARD_PREDICATES as BUILTIN_PREDICATES } from '../defs/cards';
import { EVENT_PREDICATES } from '../defs/events';
import type { StrategyCardDef } from '../defs/strategyCards';
import { STRATEGY_CARDS } from '../defs/strategyCards';
import { TECHS } from '../defs/techs';
import type { TechDef } from '../defs/techs';
import { makeExploreCard } from '../defs/explore';
import { BUILTIN_WEIGHT_RULES, type WeightRule } from '../defs/weightRules';
import { SOCIAL_LINES, type SocialLineTable, type TopicTemplate } from '../defs/socialLines';
import type { CardContext } from '../ai/pawn';
import { predicateStore, weightRuleStore, socialLinesStore } from './query';
// 默认玩法包（2026-08-14 插件化重构）：玩法系统全部由玩法包提供，内核只留基础系统
import { farmingPack } from '../../mods/packs/farming';
import { craftingPack } from '../../mods/packs/crafting';
import { repairPack } from '../../mods/packs/repair';
import { techPoolPack } from '../../mods/packs/tech-pool';
import { autobuildPack } from '../../mods/packs/autobuild';

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
  // 行为结果学习表（EWA）：per-key scale 归一化。跨 Sim 实例共享（与 DESIRES 同策略）
  private static leanStore: Map<LeanKey, LeanDef> = new Map(Object.entries(BUILTIN_LEANS));
  // 卡条件谓词表 / 权重规则表 / 社交模板表：定义移到 mods/query.ts（2026-08-14
  // 打破 registry↔pawn 循环依赖，见 query.ts 头注释）。此处仅从 query 存取。
  events: ScriptedEvent[] = [];
  expansionPlans: ExpansionPlan[] = [];
  tuning: TuningConfig;
  private systems: GameSystem[] = [];
  // 数据驱动系统装配（逻辑组件层）：mod 声明系统表项，按 before 锚点插入执行顺序
  private _systemDefs: SystemDef[] = [];
  // 禁用的系统 id（2026-08-14 用户指摘"为什么不能卸载插件"：装配时跳过。
  // 让"只留采集狩猎"等玩法包能撤掉 farm/techPool/autobuild 等默认系统）
  private _disabledSystems = new Set<string>();
  private hooks = new Map<string, Array<(ctx: HookContext) => void>>();
  private cache = new Map<string, Record<string, unknown>>();

  // 默认装配（Sim 构造与服务端 mod 管理器共用：先建注册表、挂载包，再交给 Sim）
  static default(): ModRegistry {
    const r = new ModRegistry({
      tiles: TILES, buildings: BUILDINGS, items: ITEMS, enemies: ENEMIES,
      cards: BASE_CARDS, recipes: RECIPES, tuning: TUNING, intents: [], works: [],
    });
    for (const c of STRATEGY_CARDS) r.registerStrategyCard(c); // 内置策略卡表（神谕降旨全数据化）
    // 内置科技统一走 registerTech（含探索卡生成）——mod 追加科技走同一入口 = DLC 科技
    for (const techId of Object.keys(TECHS)) r.registerTech(TECHS[techId]);
    // 默认玩法包（2026-08-14 插件化重构：模拟器 = 内核 11 系统 + 玩法包叠加）。
    // 默认装配全部 → new Sim() 即完整模拟器；玩法包可被 disableSystem 撤换
    //（hunter-gatherer = 换装：卸载 5 个默认玩法系统 + 注册狩猎系统）。
    // 注意注册顺序：before:'raid' 同锚点插入保序（sim.registerSystems 按注册序排同组），
    // 故产出包按 farm→craft→repair 声明，最终执行序 = farm→craft→repair→raid。
    farmingPack(r);
    craftingPack(r);
    repairPack(r);
    techPoolPack(r);
    autobuildPack(r);
    return r;
  }

  // 科技注册（DLC 扩展口）：注册即自动接入——hasTech 谓词 / noBuilding 谓词 / 探索卡
  //（探索卡 = 娱乐系列：科技建筑解锁初期只有娱乐抽卡能命中建造意图，用户机制）
  registerTech(def: TechDef): this {
    TECHS[def.id] = def;
    this.registerPredicate(`hasTech-${def.id}`, (c) => c.view.techs?.has(def.id) ?? false);
    for (const b of def.unlocks) {
      this.registerPredicate(`noBuilding-${b}`, (c) => !(c.view.hasBuildingWithTag?.(b) ?? false));
      this.registerCardDef(makeExploreCard(b, def.id));
    }
    return this;
  }

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

  // 行为结果学习表（EWA）：只读 Record 视图，供 Sim.leanDefOf 查询
  // 缓存：leanOf 在抽卡决策里高频调用（每卡 × 每 pawn × 每 tick），
  // 每次 Object.fromEntries 全表重建是行为系统 16% 热点（cpu profile 定位）
  private leansCache: Record<string, LeanDef> | null = null;
  private leansCacheV = -1;
  get leans(): Record<string, LeanDef> {
    const v = ModRegistry.leanStore.size;
    if (!this.leansCache || this.leansCacheV !== v) {
      this.leansCache = Object.fromEntries(ModRegistry.leanStore);
      this.leansCacheV = v;
    }
    return this.leansCache;
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

  // 声明式卡注册（逻辑组件层）：纯数据 def（needAt/when/utility*）→ 工厂生成，mod 无需写函数
  registerCardDef(def: BehaviorCardDef): this {
    return this.registerCard(cardFromDef(def));
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

  // 新行为学习轨道：mod 新工作卡配一个 lean key（scale = 该工作一次成功的典型结果量）。
  // 同 key 幂等覆盖（不同定义尺寸保留旧值同字段），与 DESIRES 一致跨实例共享。
  registerLean(def: LeanDef): this {
    this.leansCache = null;
    const old = ModRegistry.leanStore.get(def.key);
    if (old && old.scale !== def.scale) throw new Error(`mod: lean "${def.key}" 冲突（已定义 scale=${old.scale}）`);
    ModRegistry.leanStore.set(def.key, { ...old, ...def });
    return this;
  }

  // 天赋表（跨实例共享，与 DESIRES 同策略）：registerTrait 直接写 BUILTIN_TRAITS
  private static traitStore: Record<string, TraitDef> = BUILTIN_TRAITS;
  // 兴趣表（v2026-08-13 兴趣驱动娱乐，跨实例共享）：registerInterest 直接写 BUILTIN_INTERESTS
  private static interestStore: Record<string, InterestDef> = BUILTIN_INTERESTS;
  // 马尔可夫偏置表（跨实例共享）：overrideMarkovBias 以"来源系列"为单位合并
  private static markovStore: Record<string, Record<string, number>> = BUILTIN_MARKOV;
  // 系列→欲望默认映射（跨实例共享）
  private static seriesStore: Record<string, DesireId> = BUILTIN_SERIES;
  // 职业表（跨实例共享）：registerJob 新职业
  private static jobStore: Record<string, { label: string; cardId: string }> = BUILTIN_JOBS;

  get traits(): Record<string, TraitDef> {
    return ModRegistry.traitStore;
  }
  get interests(): Record<string, InterestDef> {
    return ModRegistry.interestStore;
  }
  get markovBias(): Record<string, Record<string, number>> {
    return ModRegistry.markovStore;
  }
  get seriesDesire(): Record<string, DesireId> {
    return ModRegistry.seriesStore;
  }
  get jobCards(): Record<string, string> {
    return Object.fromEntries(Object.entries(ModRegistry.jobStore).map(([id, j]) => [id, j.cardId]));
  }

  // 新天赋：进天赋表（跨实例共享）；id 冲突同定义幂等、不同定义抛错
  registerTrait(def: TraitDef): this {
    const old = ModRegistry.traitStore[def.id];
    if (old && JSON.stringify(old) !== JSON.stringify(def)) {
      throw new Error(`mod: trait "${def.id}" 已存在，请用 overrideTrait 或不同 id`);
    }
    ModRegistry.traitStore[def.id] = def;
    return this;
  }

  // 注册新兴趣（v2026-08-13）：写共享表（generateDna/initSlots/ruleInterest 自动接入）
  registerInterest(def: InterestDef): this {
    const old = ModRegistry.interestStore[def.id];
    if (old && JSON.stringify(old) !== JSON.stringify(def)) {
      throw new Error(`mod: interest "${def.id}" 已存在，请用 overrideInterest 或不同 id`);
    }
    ModRegistry.interestStore[def.id] = def;
    return this;
  }

  // 覆盖兴趣（部分字段合并）
  overrideInterest(id: string, patch: Partial<InterestDef>): this {
    const old = ModRegistry.interestStore[id];
    if (!old) throw new Error(`mod: 覆盖目标 interest "${id}" 不存在，请先 registerInterest`);
    ModRegistry.interestStore[id] = { ...old, ...patch };
    return this;
  }

  // 覆盖天赋（部分字段合并）
  overrideTrait(id: string, patch: Partial<TraitDef>): this {
    const old = ModRegistry.traitStore[id];
    if (!old) throw new Error(`mod: 覆盖目标 trait "${id}" 不存在，请先 registerTrait`);
    ModRegistry.traitStore[id] = { ...old, ...patch };
    return this;
  }

  // 扩展马尔可夫偏置：为某来源系列合并/覆盖一组目标系列倍率
  registerMarkovBias(fromSeries: string, toMuls: Record<string, number>): this {
    ModRegistry.markovStore[fromSeries] = { ...ModRegistry.markovStore[fromSeries], ...toMuls };
    return this;
  }

  // 系列默认欲望映射（mod 自定义系列 → 默认欲望）
  registerSeriesDesire(series: string, desire: DesireId): this {
    ModRegistry.seriesStore[series] = desire;
    return this;
  }

  // 新职业（Q10）：记录职业 → 主导工作卡 + 标签
  registerJob(id: string, def: { label: string; cardId: string }): this {
    // 同定义幂等（重复挂载同包安全）；不同定义 → 抛错
    const old = ModRegistry.jobStore[id];
    if (old && JSON.stringify(old) !== JSON.stringify(def)) throw new Error(`mod: job "${id}" 已存在，请用不同 id`);
    ModRegistry.jobStore[id] = def;
    return this;
  }

  // 覆盖行为学习参数（mod 可调 scale 归一化尺度）
  overrideLean(key: string, patch: Partial<LeanDef>): this {
    this.leansCache = null;
    const old = ModRegistry.leanStore.get(key);
    if (!old) throw new Error(`mod: 覆盖目标 lean "${key}" 不存在，请先 registerLean`);
    ModRegistry.leanStore.set(key, { ...old, ...patch });
    return this;
  }

  registerSystem(s: GameSystem): this {
    this.systems.push(s);
    return this;
  }

  // 数据驱动系统装配（逻辑组件层）：mod 声明系统表项，按 before 锚点插入执行顺序
  registerSystemDef(def: SystemDef): this {
    if (this._systemDefs.some((d) => d.id === def.id)) throw new Error(`mod: system "${def.id}" 已存在`);
    this._systemDefs.push(def);
    return this;
  }

  get systemDefs(): readonly SystemDef[] {
    return this._systemDefs;
  }

  // 卸载系统（2026-08-14）：声明禁用某系统 id（内置或 mod 的），装配时跳过。
  // 幂等；禁用后 registerSystemDef 同 id 再注册也会被跳过。
  disableSystem(id: string): this {
    this._disabledSystems.add(id);
    return this;
  }
  isSystemEnabled(id: string): boolean {
    return !this._disabledSystems.has(id);
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

  // 策略卡注册（神谕降旨表全数据化：条件/蓝图副作用/权重声明式；引擎按表采样）
  private strategyCardsMap = new Map<string, StrategyCardDef>();
  registerStrategyCard(def: StrategyCardDef): this {
    this.assertNew('strategyCard', def.id, this.strategyCardsMap);
    this.strategyCardsMap.set(def.id, def);
    return this;
  }
  get strategyCards(): StrategyCardDef[] {
    return [...this.strategyCardsMap.values()];
  }

  // 事件谓词注册（声明式事件 DLC：defs.events 的 when 引用；SimContext 签名，与卡谓词分开）
  registerEventPredicate(id: string, fn: (ctx: import('../systems/context').SimContext) => boolean): this {
    EVENT_PREDICATES[id] = fn;
    return this;
  }

  // 卡条件谓词注册（行为树条件节点）：卡 when: ['hasChurch'] → registerPredicate('hasChurch', ...)
  registerPredicate(id: string, fn: (c: CardContext) => boolean): this {
    // 静态共享键：幂等（重复挂载同包安全，保持首次定义）；不同 mod 想替换用新 id
    if (predicateStore.has(id)) return this;
    predicateStore.set(id, fn);
    return this;
  }

  // 谓词查询（卡工厂组合条件用）；缺省抛错（拼错 id 立即暴露，提示注册）
  cardPredicate(id: string): (c: CardContext) => boolean {
    const fn = predicateStore.get(id);
    if (!fn) throw new Error(`mod: 条件谓词 "${id}" 未注册，请先用 registerPredicate 注册`);
    return fn;
  }

  // 权重调制规则注册（权重合成流水线）：插入内置规则之前（before 锚点）；缺省追加表尾
  registerWeightRule(rule: WeightRule, before?: string): this {
    if (weightRuleStore.has(rule.id)) throw new Error(`mod: 权重规则 "${rule.id}" 已存在，请用不同 id`);
    const rules = [...weightRuleStore.values()];
    const idx = before ? rules.findIndex((r) => r.id === before) : -1;
    if (before && idx >= 0) rules.splice(idx, 0, rule);
    else rules.push(rule);
    weightRuleStore.clear();
    for (const r of rules) weightRuleStore.set(r.id, r);
    return this;
  }

  // 社交对话模板：追加一条微互动文案（greet/positive/negative）
  registerLine(category: keyof Pick<SocialLineTable, 'greet' | 'positive' | 'negative'>, line: string): this {
    // 静态共享键：同文案重复注册幂等
    if (!socialLinesStore[category].includes(line)) socialLinesStore[category].push(line);
    return this;
  }

  // 社交对话模板：追加一条话题模板（历史事件 type → 文案）；同事件多条按注册序取用
  registerTopicTemplate(tpl: TopicTemplate): this {
    socialLinesStore.topics.push(tpl);
    return this;
  }

  // 权重规则替换（保持位置）：mod 调整内置规则的行为（如改天赋倍率的合成方式）
  overrideWeightRule(id: string, apply: WeightRule['apply']): this {
    const old = weightRuleStore.get(id);
    if (!old) throw new Error(`mod: 覆盖目标权重规则 "${id}" 不存在，请先 registerWeightRule`);
    weightRuleStore.set(id, { ...old, apply });
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

// 模块级查询函数 cardPredicateOf/weightRulesOf/socialLinesOf 已移到 mods/query.ts（2026-08-14）
export { cardPredicateOf, weightRulesOf, socialLinesOf } from './query';
