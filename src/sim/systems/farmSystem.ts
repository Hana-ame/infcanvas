// 被动产出系统（原"农场系统"泛化）：处理所有 passive recipe 建筑
// 数据驱动：产出完全读 BuildingDef.recipe(passive)——农田产粮、水井取水、浆果摊产浆果……
// mod 新 passive 建筑带 recipe 即接入（曾踩坑：只认 farm tag 导致水井 water 永不产出）
import type { GameSystem } from './registry';
import type { SimContext } from './context';

export class FarmSystem implements GameSystem {
  id = 'farm';

  constructor(private ctx: SimContext) {}

  update(dt: number): void {
    // 每个农田按其附近单位产出（Q9：单位独立生产；faction='player' 进全局）——读 BuildingDef.recipe(passive)
    for (const [key, b] of this.ctx.world.buildings) {
      if (!b.def.recipe) continue; // 任意 passive recipe 建筑（农田/水井/mod 建筑）
      const recipe = this.ctx.recipe(b.def.recipe);
      if (!recipe || recipe.kind !== 'passive') continue;
      const x = key % this.ctx.world.width;
      const y = Math.floor(key / this.ctx.world.width);
      this.ctx.addProductionNear(x, y, recipe.output.item, recipe.output.amount * dt, b.faction);
    }
  }
}
