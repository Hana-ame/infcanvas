// mod 注册表（DESIGN §7 扩展性原则）
// 目标：任何 mod 能力都应能通过注册表实现，不改 sim 源码。
// 注册时机：Sim 构造后立即调用（服务端加载 mod → 注册 → defs 只读下发客户端）。
import type { TileDef, BuildingDef, ItemDef } from '../defs';
import type { BehaviorCard } from '../ai/pawn';
import type { IntentExecutor } from '../systems/cardSystem';
import type { GameSystem } from '../systems/registry';

// 登记项（含冲突检测）
export class ModRegistry {
  tiles = new Map<string, TileDef>();
  buildings = new Map<string, BuildingDef>();
  items = new Map<string, ItemDef>();
  cards = new Map<string, BehaviorCard>();
  intents = new Map<string, IntentExecutor>();
  private systems: GameSystem[] = [];
  private hooks = new Map<string, Array<(ctx: unknown) => void>>();

  constructor(seed: {
    tiles: Record<string, TileDef>;
    buildings: Record<string, BuildingDef>;
    items: Record<string, ItemDef>;
    cards: BehaviorCard[];
    intents: [string, IntentExecutor][];
  }) {
    for (const [k, v] of Object.entries(seed.tiles)) this.tiles.set(k, v);
    for (const [k, v] of Object.entries(seed.buildings)) this.buildings.set(k, v);
    for (const [k, v] of Object.entries(seed.items)) this.items.set(k, v);
    for (const c of seed.cards) this.cards.set(c.id, c);
    for (const [k, v] of seed.intents) this.intents.set(k, v);
  }

  // mod 入口：注册新定义（id 冲突 → 抛错，防静默覆盖）
  registerTile(def: TileDef): this {
    this.assertNew('tile', def.id, this.tiles);
    this.tiles.set(def.id, def);
    return this;
  }

  registerBuilding(def: BuildingDef): this {
    this.assertNew('building', def.id, this.buildings);
    this.buildings.set(def.id, def);
    return this;
  }

  registerItem(def: ItemDef): this {
    this.assertNew('item', def.id, this.items);
    this.items.set(def.id, def);
    return this;
  }

  registerCard(card: BehaviorCard): this {
    this.assertNew('card', card.id, this.cards);
    this.cards.set(card.id, card);
    return this;
  }

  // 新意图执行器：新 AI 行为 = 注册一个 executor（客户端只收结果）
  registerIntent(id: string, fn: IntentExecutor): this {
    if (this.intents.has(id)) throw new Error(`mod: intent "${id}" 已存在`);
    this.intents.set(id, fn);
    return this;
  }

  registerSystem(s: GameSystem): this {
    this.systems.push(s);
    return this;
  }

  // 阶段钩子：check 流程 beforeRoll 等（mod 可插入）
  registerHook(stage: string, fn: (ctx: unknown) => void): this {
    if (!this.hooks.has(stage)) this.hooks.set(stage, []);
    this.hooks.get(stage)!.push(fn);
    return this;
  }

  runHooks(stage: string, ctx: unknown): void {
    this.hooks.get(stage)?.forEach((fn) => fn(ctx));
  }

  get allSystems(): GameSystem[] {
    return this.systems;
  }

  private assertNew(kind: string, id: string, map: Map<string, unknown>): void {
    if (map.has(id)) throw new Error(`mod: ${kind} "${id}" 已存在，请用不同 id`);
  }
}
