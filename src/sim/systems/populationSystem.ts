// 人口系统：食物充足时偶有新人加入
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';

export class PopulationSystem implements GameSystem {
  id = 'population';
  private recruitTimer = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    const p = this.ctx.tuning.population;
    if (this.ctx.pawnList.length >= p.maxPawns) return;
    this.recruitTimer += dt;
    if (this.recruitTimer < p.recruitInterval) return;
    if (this.ctx.stockpile.food < p.foodThreshold) { this.recruitTimer = p.recruitRetryAfter; return; }
    this.recruitTimer = 0;
    // 找出生点附近空位生成
    const cx = Math.floor(this.ctx.world.width / 2);
    const cy = Math.floor(this.ctx.world.height / 2);
    const pp = this.ctx.tuning.population;
    for (let r = pp.spawnRingMin; r <= pp.spawnRingMax; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = cx + dx, y = cy + dy;
          if (this.ctx.world.inBounds(x, y) && this.ctx.world.isPassable(x, y)) {
            const eid = this.ctx.spawnPawn(x, y);
            if (eid !== -1) {
              this.ctx.bus.emit({ type: 'pawn_recruited', eid });
              this.ctx.logEvent('一位流浪者加入了定居点');
              return;
            }
          }
        }
      }
    }
  }
}