// 烹饪玩法包（2026-08-14 用户需求「火堆要能 cook」+「香料等等玩法」）
// 设计：篝火 = 简易炉灶。cook 配方（batch 语义）自动把杂食烤成耐存熟食：
//   基础：4 food + 1 wood → 5 food（每 4s 一轮，多座篝火共享节奏均匀化）
//   加料：库存有香料（spice，采自野外香料丛）时优先走 cook_spiced：
//         4 food + 1 wood + 1 spice → 7 food —— 香料把烤制效率从 1.25x 提到 1.75x
// 数值意图：基础净盈余温和（< 农田 2 格产出）且给木材消耗出口；
// 加料 = 香料（稀缺野外资源）的经济价值出口，让"出门采香料 → 回来烤更划算"成立。
// 独立系统（不依赖 craft 系统）：hg（采集狩猎）局卸载 craft 后篝火仍能烤肉——
// 游牧烤肉是世界观刚需，不能随工作台一起消失。
// 数据驱动：配方读 registry（mod 可 overrideDef/registerRecipe 换新配方）；
// 加料配方经 def.meta.cookSpiced 挂到建筑（与 thermo 包的 meta.heat 深合并共存，
// 2026-08-14 overrideDef 改深合并——浅合并时后挂包会冲掉先挂包的 meta）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { GameSystem } from '../../sim/systems/registry';
import type { RecipeDef } from '../../sim/defs/recipes';

export const COOK_RECIPE = 'cook';

export const cookingPack = {
  id: 'cooking',
  // 依赖（2026-08-15 显式化）：无硬前置——campfire 是内核 defs（meta.cookSpiced 与 thermo 的 meta.heat 深合并共存，互不依赖）
  requires: [],
  apply(m: ModRegistry): void {
    // 篝火补烹饪能力（overrideDef 部分合并：仅补 recipe/meta——tags **不重列**：
    // cook 判定只看 def.recipe（见 CookSystem 注释），tags 原值自动保留，
    // 内核 campfire 未来加 tag 不会丢失。审计 2026-08-15：此前全量重列
    // tags 是重复维护点，内核加 tag 不同步此处 = 新 tag 丢失）
    m.overrideDef('building', 'campfire', {
      recipe: COOK_RECIPE,
      meta: { cookSpiced: 'cook_spiced' }, // 加料配方引用（有香料时优先）
    });
    m.registerRecipe({
      id: COOK_RECIPE, name: '烤制食物', kind: 'batch',
      input: [{ item: 'food', amount: 4 }, { item: 'wood', amount: 1 }],
      output: { item: 'food', amount: 5 },
      interval: 4,
    });
    // 加料配方（2026-08-14 香料玩法）：多耗 1 spice 多产出 2 food
    m.registerRecipe({
      id: 'cook_spiced', name: '香料烤制', kind: 'batch',
      input: [{ item: 'food', amount: 4 }, { item: 'wood', amount: 1 }, { item: 'spice', amount: 1 }],
      output: { item: 'food', amount: 7 },
      interval: 4,
    });
    m.registerSystemDef({
      id: 'cook', label: '烹饪', category: 'production',
      ctor: (sim) => new CookSystem(sim),
      before: 'raid',
    });
  },
};

// 每配方组：配方 + 在产篝火数 + 加料版配方（meta.cookSpiced 指向，缺省无）
interface CookGroup { recipe: RecipeDef; count: number; spiced?: RecipeDef }

// 烹饪系统：篝火批量烤食（batch 语义，节奏模式同 CraftSystem——多座共享冷却、节奏随数均分）
// 为什么不用 CraftSystem：其输入硬编码 wood 且要求 tags 含 'craft'；cook 输入是 food，
// 且 hg 卸载 craft 后要保留篝火烹饪（游牧烤肉），故独立实现。
export class CookSystem implements GameSystem {
  id = 'cook';
  private cd = 0;

  constructor(private ctx: SimContext) {}

  init(): void {}

  update(dt: number): void {
    // 按配方分组统计在产篝火（判定只看 def.recipe === COOK_RECIPE——recipe 是 cooking 包自己
    // override 加的，无歧义；tags 检查是冗余约束，已去掉（2026-08-15 审计：tags 全量重列
    // 是重复维护点，改 recipe-only 判定后 cooking 不再需要重列内核 tags，未来内核加 tag 不丢失）
    const groups = new Map<string, CookGroup>();
    for (const [, b] of this.ctx.world.buildings) {
      if (b.def.recipe !== COOK_RECIPE) continue;
      const rid = b.def.recipe;
      let g = groups.get(rid);
      if (!g) {
        const def = this.ctx.recipe(rid);
        if (!def) continue;
        g = { recipe: def, count: 0 };
        groups.set(rid, g);
      }
      g.count++;
      // 加料配方：读建筑 meta.cookSpiced（第一座命中即记）
      if (!g.spiced) {
        const sid = b.def.meta?.['cookSpiced'];
        if (sid) g.spiced = this.ctx.recipe(String(sid)) ?? undefined;
      }
    }
    if (groups.size === 0) return;
    this.cd -= dt;
    if (this.cd > 0) return;
    this.cd = nextInterval(groups);
    for (const g of groups.values()) {
      // 加料优先：香料够就多产（基础配方永不退场——香料耗尽自动回落）
      const r = g.spiced && canAfford(this.ctx, g.spiced) ? g.spiced : g.recipe;
      if (!canAfford(this.ctx, r)) continue; // 缺任一食材不烹饪（不把仅有的口粮烧没）
      for (const inp of r.input ?? []) this.ctx.stockpile[inp.item] -= inp.amount;
      this.ctx.stockpile[r.output.item] = (this.ctx.stockpile[r.output.item] ?? 0) + r.output.amount;
      this.ctx.logEvent(`${r === g.spiced ? '🧂' : '🍳'} ${r.name}完成（${r.output.item} +${r.output.amount}）`);
    }
  }
}

const canAfford = (ctx: SimContext, r: RecipeDef): boolean =>
  (r.input ?? []).every((inp) => (ctx.stockpile[inp.item] ?? 0) >= inp.amount);

// 下一次生产节奏：取所有在产配方中最小的 interval/count（多座篝火共享冷却、节奏均分）
function nextInterval(groups: Map<string, CookGroup>): number {
  let next = Infinity;
  for (const g of groups.values()) {
    const itv = (g.recipe.interval ?? 4) / Math.max(1, g.count);
    if (itv < next) next = itv;
  }
  return next === Infinity ? 4 : next;
}
