// 生产系统：工作台把木头 → 工具（工具提升采集产出）
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';

export class CraftSystem implements GameSystem {
  id = 'craft';
  private craftCd = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    let benches: { x: number; y: number }[] = [];
    for (const [key, b] of this.ctx.world.buildings) {
      if (b.def.id === 'workbench') {
        benches.push({ x: key % this.ctx.world.width, y: Math.floor(key / this.ctx.world.width) });
      }
    }
    if (benches.length === 0) return;
    // 冷却：每 6 秒尝试做 1 个工具（每个工作台）
    this.craftCd -= dt;
    if (this.craftCd <= 0) {
      this.craftCd = 6 / benches.length;
      const woodCost = 5;
      if (this.ctx.stockpile.wood >= woodCost) {
        this.ctx.stockpile.wood -= woodCost;
        this.ctx.stockpile.tools = (this.ctx.stockpile.tools ?? 0) + 1;
        this.ctx.logEvent('🛠 工作台造出工具');
      }
    }
  }
}
