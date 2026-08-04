// 农场系统：农田持续产出食物
import type { GameSystem } from './registry';
import type { SimContext } from './context';

export class FarmSystem implements GameSystem {
  id = 'farm';

  constructor(private ctx: SimContext) {}

  update(dt: number): void {
    // 每个农田按其附近单位产出（Q9：单位独立生产；玩家单位=全局）
    for (const [key, b] of this.ctx.world.buildings) {
      if (!b.def.tags?.includes('farm')) continue;
      const x = key % this.ctx.world.width;
      const y = Math.floor(key / this.ctx.world.width);
      this.ctx.addProductionNear(x, y, 'food', 0.2 * dt);
    }
  }
}
