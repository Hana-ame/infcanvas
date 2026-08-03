// 建造系统：蓝图进度 → 完成 → 事件
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import { BUILDINGS } from '../defs';

export class BuildSystem implements GameSystem {
  id = 'build';

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    const q = this.ctx.buildQueue;
    for (let i = q.length - 1; i >= 0; i--) {
      const b = q[i];
      b.progress += dt;
      const def = BUILDINGS[b.defId];
      if (b.progress >= def.buildTime) {
        if (b.cost) this.ctx.stockpile.wood -= b.cost.wood;
        this.ctx.world.placeBuilding(b.x, b.y, b.defId, b.faction);
        this.ctx.bus.emit({ type: 'building_built', x: b.x, y: b.y, defId: b.defId });
        this.ctx.clearTrailCache();
        q.splice(i, 1);
      }
    }
  }
}
