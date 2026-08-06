// 建造系统：蓝图进度 → 完成 → 事件
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';

export class BuildSystem implements GameSystem {
  id = 'build';

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    const q = this.ctx.buildQueue;
    for (let i = q.length - 1; i >= 0; i--) {
      const b = q[i];
      b.progress += dt;
      const def = this.ctx.buildingDef(b.defId);
      if (!def) continue;
      if (b.progress >= def.buildTime) {
        if (b.cost) {
          this.ctx.stockpile.wood -= b.cost.wood;
          if (b.cost.ore) this.ctx.stockpile.ore = Math.max(0, (this.ctx.stockpile.ore ?? 0) - b.cost.ore);
        }
        // 升级语义数据化：若原地已有"会升级成此建筑"的建筑（def.upgradesTo === b.defId）→ 原地升级而非新建
        const existing = this.ctx.world.getBuilding(b.x, b.y);
        if (existing && existing.def.upgradesTo === b.defId) {
          this.ctx.upgradeBuilding(b.x, b.y, b.defId, b.faction);
        } else {
          this.ctx.world.placeBuilding(b.x, b.y, b.defId, b.faction);
        }
        this.ctx.bus.emit({ type: 'building_built', x: b.x, y: b.y, defId: b.defId });
        this.ctx.clearTrailCache();
        q.splice(i, 1);
      }
    }
  }
}
