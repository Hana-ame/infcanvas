// 农场系统：农田持续产出食物
import type { GameSystem } from './registry';
import type { SimContext } from './context';

export class FarmSystem implements GameSystem {
  id = 'farm';

  constructor(private ctx: SimContext) {}

  update(dt: number): void {
    let farms = 0;
    for (const [, b] of this.ctx.world.buildings) {
      if (b.def.id === 'farm') farms++;
    }
    if (farms > 0) {
      this.ctx.stockpile.food = Math.min(500, this.ctx.stockpile.food + farms * 0.2 * dt);
    }
  }
}
