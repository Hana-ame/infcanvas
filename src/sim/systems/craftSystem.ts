// 生产系统：工作台等 craft 建筑按各自配方把材料 → 产物（工具提升采集产出）
// 数据驱动：每座 craft 建筑读自己的 def.recipe（mod 新加工建筑带配方即接入，不写死 workbench）
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { RecipeDef } from '../defs/recipes';
import type { EventBus } from '../core/events';

export class CraftSystem implements GameSystem {
  id = 'craft';
  private craftCd = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    // 收集所有 craft 建筑，按各自配方聚合（同一配方多座共享一次产出节奏）
    const groups = new Map<string, { recipe: RecipeDef; count: number }>();
    for (const [key, b] of this.ctx.world.buildings) {
      const rid = b.def.recipe;
      if (!rid || !b.def.tags?.includes('craft')) continue;
      const def = this.ctx.recipe(rid);
      if (!def || def.kind !== 'batch') continue;
      const g = groups.get(rid) ?? { recipe: def, count: 0 };
      g.count++;
      groups.set(rid, g);
    }
    if (groups.size === 0) return;
    this.craftCd -= dt;
    if (this.craftCd > 0) return;
    this.craftCd = this.craftNextInterval(groups);
    // 每配方组各做一批（各自成本/产物）
    for (const g of groups.values()) {
      const input = g.recipe.input?.[0];
      const cost = input?.amount ?? this.ctx.tuning.craft.costFallback;
      if (this.ctx.stockpile.wood < cost) continue;
      this.ctx.stockpile.wood -= cost;
      const item = g.recipe.output.item;
      this.ctx.stockpile[item] = (this.ctx.stockpile[item] ?? 0) + (g.recipe.output.amount ?? this.ctx.tuning.craft.outputFallback);
      this.ctx.logEvent(`🛠 ${g.recipe.name ?? item} 完成`);
    }
  }

  // 下一次生产节奏：取所有在产配方中最小的 interval/count（保持与原"共享冷却"近似的均匀节奏）
  private craftNextInterval(groups: Map<string, { recipe: RecipeDef; count: number }>): number {
    let next = Infinity;
    for (const g of groups.values()) {
      const itv = (g.recipe.interval ?? this.ctx.tuning.craft.intervalFallback) / Math.max(1, g.count);
      if (itv < next) next = itv;
    }
    return next === Infinity ? 6 : next;
  }
}
