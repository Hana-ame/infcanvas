// 建造系统：蓝图进度 → 完成 → 事件
// 数据驱动：buildTime/upgradesTo/replacesTile 读 def（mod 新建筑带 def 即接入）
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
        // 升级语义数据化：若原地已有"会升级成此建筑"的建筑（def.upgradesTo === b.defId）→ 原地升级而非新建
        const existing = this.ctx.world.getBuilding(b.x, b.y);
        const isUpgrade = !!existing && existing.def.upgradesTo === b.defId;
        // 落点 footprint 校验（升级路径占格，跳过）：非法 → 放弃蓝图且不扣资源
        // （此前 placeBuilding 返回值被忽略：落点被占/不可建时资源已扣、建筑没建 = 资源蒸发）
        if (!isUpgrade && !this.ctx.world.canBuildFootprint(b.x, b.y, def)) {
          this.ctx.logEvent(`🚧 放弃【${b.defId}】蓝图（落点不可建）`);
          q.splice(i, 1);
          continue;
        }
        // 资源不足 → 等待（不扣、不移除）；避免负库存
        if (b.cost) {
          if (this.ctx.stockpile.wood < b.cost.wood) continue;
          if (b.cost.ore > 0 && (this.ctx.stockpile.ore ?? 0) < b.cost.ore) continue;
          this.ctx.stockpile.wood = Math.max(0, this.ctx.stockpile.wood - b.cost.wood);
          if (b.cost.ore) this.ctx.stockpile.ore = Math.max(0, (this.ctx.stockpile.ore ?? 0) - b.cost.ore);
        }
        if (def.replacesTile) {
          // 地形改造（修桥）：把 footprint 格替换为目标 tile（water → bridge），不留建筑
          for (const key of this.ctx.world.footprintKeys(b.x, b.y, def)) {
            const gx = key % this.ctx.world.width;
            const gy = Math.floor(key / this.ctx.world.width);
            this.ctx.world.setTile(gx, gy, def.replacesTile);
          }
        } else if (isUpgrade) {
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
