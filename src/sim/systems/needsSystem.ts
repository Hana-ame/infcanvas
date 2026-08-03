// 需求系统：衰减 / 夜晚更困 / 饥饿死亡 / 紧急需求
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import { tickNeeds, urgentNeedAction } from '../core/needs';

export class NeedsSystem implements GameSystem {
  id = 'needs';

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const n = this.ctx.readNeeds(eid);
      if (!n) continue;
      tickNeeds(n, dt);
      // 夜晚精力消耗加快
      if (this.ctx.isNight()) n.rest -= 0.12 * dt;
      this.ctx.setNeeds(eid, n);
      // 饿死
      if (n.food <= 0) {
        const h = this.ctx.readHealth(eid);
        if (h) {
          h.hp -= 2.5 * dt;
          if (h.hp <= 0) {
            this.ctx.setHealth(eid, { hp: 0, maxHp: h.maxHp });
            const pos = this.ctx.readPosition(eid);
            this.ctx.bus.emit({ type: 'pawn_died', eid, x: pos?.x ?? 0, y: pos?.y ?? 0, cause: 'starvation' });
            this.ctx.killPawn(eid);
            continue;
          }
          this.ctx.setHealth(eid, h);
        }
      }
      const urgent = urgentNeedAction(n);
      if (urgent) st.urgent = urgent;
    }
  }
}
