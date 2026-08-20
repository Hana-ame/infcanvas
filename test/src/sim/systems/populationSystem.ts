// 人口系统：食物充足时偶有新人加入
// 数据驱动：间隔/阈值/上限/出生环读 tuning.population（mod 可调）
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';

// 人口系统：流浪者加入条件判定（心情高 + 有篝火）+ 人口上限控制
export class PopulationSystem implements GameSystem {
  id = 'population';
  private recruitTimer = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  // 定期招募：未达人口上限 + 食物充足 → 出生点向外逐环找可通行空位生成（spawnPawn 失败则继续扫）
  private _throttle = 0;
  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < 10) return; // 2026-08-20 节流：人口补员判定 10s 一次（低频事件）
    this._throttle = 0;
    const p = this.ctx.tuning.population;
    if (this.ctx.iterPawns.length >= p.maxPawns) return;
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