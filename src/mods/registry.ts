/**
 * registry.ts —— ModRegistry：插件注册面（原则④公开 API）+ 系统装配。
 *
 * 注册面一览（本阶段用到的全实现；数据表类先立骨架供 DLC/测试扩展）：
 *   registerSystemDef / registerCommand / registerCard / registerHook(cardWeight) /
 *   registerBuilding(→tuning) / registerItem / registerRecipe / registerEnemy(→tuning) /
 *   registerEvent / registerPredicate / overrideTuning / disableSystem
 *   （2026-08-21 用户裁定：registerStrategyCard/"××令"机制整体移除）
 *
 * 装配序 = 类别序 × 组内注册序（见 systems.ts）。内核系统（behavior）在构造时最先注册，
 * 自然排在 ai 类首位。disableSystem 只影响装配过滤，不删注册数据（重装配可复活）。
 */
import { DEFAULT_TUNING, type Tuning } from '../sim/tuning';
import type { SimContext, CardWeightHook } from '../sim/context';
import type { CardDef } from '../sim/cards';
import { behaviorCtor, CATEGORY_ORDER, type Category, type GameSystem, type SystemDef } from '../sim/systems';
import type { BuildingTuningEntry, EnemyTuningEntry } from '../sim/tuning';
import { topoSort, type ModPack } from './pack';

export type CommandHandler = (ctx: SimContext, args: Record<string, unknown>, source: 'player' | 'system') => void;

/** 数据种子类注册：物品/配方/事件/谓词先立登记面（DLC 与测试会用到），
 *  本阶段内核不消费——它们是"给涌现的种子"，不是死代码。 */
export interface ItemDef {
  id: string;
  name: string;
}
export interface RecipeDef {
  id: string;
  name: string;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
}
export interface EventSeedDef {
  id: string;
  name: string;
  /** 局面触发谓词（事件从局面来，不是脚本线） */
  when: (ctx: SimContext) => boolean;
  /** 命中后的效果表（声明式，非流程） */
  effects: { log: string };
}

type TuningOverride = (t: Tuning) => void;

export class ModRegistry {
  private systemDefs: SystemDef[] = [];
  private disabled = new Set<string>();
  private commandMap = new Map<string, CommandHandler>();
  readonly cards: CardDef[] = [];
  readonly weightHooks: CardWeightHook[] = [];
  readonly items: ItemDef[] = [];
  readonly recipes: RecipeDef[] = [];
  readonly eventSeeds: EventSeedDef[] = [];
  private predicates = new Map<string, (ctx: SimContext) => boolean>();
  private tuningOverrides: TuningOverride[] = [];

  constructor() {
    // 内核系统最先注册：决策引擎是引擎服务（原则④终态裁定），内联于此而非玩法包。
    this.registerSystemDef({ id: 'behavior', category: 'ai', ctor: behaviorCtor });
  }

  // ================= 注册面 =================
  registerSystemDef(def: SystemDef): void {
    if (this.systemDefs.some((d) => d.id === def.id)) throw new Error(`系统已存在：${def.id}`);
    this.systemDefs.push(def);
  }
  registerCommand(type: string, handler: CommandHandler): void {
    if (this.commandMap.has(type)) throw new Error(`命令已存在：${type}`);
    this.commandMap.set(type, handler);
  }
  registerCard(card: CardDef): void {
    if (this.cards.some((c) => c.id === card.id)) throw new Error(`卡已存在：${card.id}`);
    this.cards.push(card);
  }
  registerHook(name: 'cardWeight', fn: CardWeightHook): void {
    if (name !== 'cardWeight') throw new Error(`未知钩子：${name}`); // 显式白名单防拼写漂移
    this.weightHooks.push(fn);
  }
  registerItem(def: ItemDef): void {
    this.items.push(def);
  }
  registerRecipe(def: RecipeDef): void {
    this.recipes.push(def);
  }
  registerEvent(def: EventSeedDef): void {
    this.eventSeeds.push(def);
  }
  registerPredicate(name: string, fn: (ctx: SimContext) => boolean): void {
    this.predicates.set(name, fn);
  }
  predicate(name: string): ((ctx: SimContext) => boolean) | undefined {
    return this.predicates.get(name);
  }

  /** 建筑/敌人走 tuning 表注册（数据驱动：定义即数据，无逻辑） */
  registerBuilding(entry: BuildingTuningEntry & { id: string }): void {
    const { id, ...rest } = entry;
    if (this.baseTuning.buildings[id]) throw new Error(`建筑已存在：${id}`);
    this.baseTuning.buildings[id] = rest;
  }
  registerEnemy(entry: EnemyTuningEntry & { id: string }): void {
    const { id, ...rest } = entry;
    if (this.baseTuning.enemies[id]) throw new Error(`敌人已存在：${id}`);
    this.baseTuning.enemies[id] = rest;
  }

  /** 调参覆盖：mod 不改出厂表，按路径写覆盖函数（生效值 = 出厂 → 覆盖链依次应用） */
  overrideTuning(fn: TuningOverride): void {
    this.tuningOverrides.push(fn);
  }

  disableSystem(id: string): void {
    this.disabled.add(id);
  }
  isSystemDisabled(id: string): boolean {
    return this.disabled.has(id);
  }

  // ================= 生效值与装配 =================
  private baseTuning: Tuning = structuredClone(DEFAULT_TUNING); // 注册期写入（registerBuilding 等）
  private cachedTuning: Tuning | null = null;

  effectiveTuning(): Tuning {
    if (!this.cachedTuning) {
      const t = structuredClone(this.baseTuning);
      for (const fn of this.tuningOverrides) fn(t);
      this.cachedTuning = t;
    }
    return this.cachedTuning;
  }

  cardById(id: string): CardDef | undefined {
    return this.cards.find((c) => c.id === id);
  }

  commands: ReadonlyMap<string, CommandHandler> = this.commandMap;

  systemIds(): string[] {
    return this.systemDefs.map((d) => d.id);
  }

  /** 装配：类别序 × 组内注册序 → 实例化（跳过禁用）。init 由 Sim 在全部 ctor 后统一调。 */
  assemble(ctx: SimContext): GameSystem[] {
    const catRank = (c: Category) => CATEGORY_ORDER.indexOf(c);
    const ordered = [...this.systemDefs].sort((a, b) => catRank(a.category) - catRank(b.category));
    return ordered.filter((d) => !this.disabled.has(d.id)).map((d) => d.ctor(ctx));
  }

  /** 挂载一个包（apply 幂等性由包自己保证：重复 apply 的重复注册会抛"已存在"） */
  mountPack(pack: ModPack): void {
    pack.apply(this);
  }

  /** 默认装配：拓扑挂载默认玩法清单 + 契约校验。
   *  清单是纯数据（playstyle.ts）；框架其余部分不 import 任何玩法包——
   *  只有这个工厂触碰它，纯引擎使用者（最小装配测试）零玩法依赖。 */
  static default(): ModRegistry {
    const { DEFAULT_PLAYSTYLE_PACKS } = playstyleList();
    return ModRegistry.mountPacks(DEFAULT_PLAYSTYLE_PACKS);
  }

  /** 拓扑挂载给定清单（乱序自动拉齐），末尾跑契约校验（违例即抛，防回归静默漂移） */
  static mountPacks(packs: ModPack[]): ModRegistry {
    const reg = new ModRegistry();
    for (const p of topoSort([...packs])) p.apply(reg);
    const errors = validateContracts(reg);
    if (errors.length > 0) throw new Error(`契约校验失败：\n- ${errors.join('\n- ')}`);
    return reg;
  }
}

// 数据清单与契约校验用静态 import：它们是纯数据/纯函数，不构成框架↔玩法运行时环
// （玩法包只 import 本文件的**类型**，类型在编译期擦除）。
import { DEFAULT_PLAYSTYLE_PACKS } from './packs/playstyle';
import { validateContracts } from './contracts';

function playstyleList(): typeof import('./packs/playstyle') {
  return { DEFAULT_PLAYSTYLE_PACKS };
}
