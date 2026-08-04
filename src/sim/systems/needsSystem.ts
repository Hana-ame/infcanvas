// 需求系统：衰减 / 夜晚更困 / 饥饿死亡 / 紧急需求
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import { tickNeeds, urgentNeedAction } from '../core/needs';

export class NeedsSystem implements GameSystem {
  id = 'needs';
  private wonderVersion = -1;
  private wonderCache = false;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  // 是否有奇观（纪念碑）——按 buildingVersion 缓存
  private get hasWonder(): boolean {
    const ver = this.ctx.world.buildingVersion;
    if (ver !== this.wonderVersion) {
      this.wonderVersion = ver;
      let found = false;
      for (const [, b] of this.ctx.world.buildings) {
        if (b.def.id === 'monument') { found = true; break; }
      }
      this.wonderCache = found;
    }
    return this.wonderCache;
  }

  update(dt: number): void {
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const n = this.ctx.readNeeds(eid);
      if (!n) continue;
      tickNeeds(n, dt);
      // 夜晚精力消耗加快
      if (this.ctx.isNight()) n.rest -= 0.12 * dt;
      // 篝火光环（饥荒式社会锚点）：火边心情回暖、夜晚不易困
      if (this.nearCampfire(eid)) {
        n.mood = Math.min(100, n.mood + 0.5 * dt);
        n.rest = Math.min(100, n.rest + 0.3 * dt);
      }
      // 神谕祝福（buff 持续期间心情加成）
      if (st.oracleBuff && st.oracleBuff.until > this.ctx.time) {
        n.mood = Math.min(100, n.mood + st.oracleBuff.mood * dt);
      }
      // 奇观光环（Q10）：纪念碑建成 → 全营地敬畏（心情+信仰）
      if (this.hasWonder) {
        n.mood = Math.min(100, n.mood + 0.3 * dt);
      }
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

  // 篝火半径内（社交/安心锚点）
  private nearCampfire(eid: number): boolean {
    const pos = this.ctx.pawnPositions.get(eid);
    if (!pos) return false;
    const w = this.ctx.world;
    const R = 6;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const bx = Math.round(pos.x) + dx;
        const by = Math.round(pos.y) + dy;
        if (!w.inBounds(bx, by)) continue;
        const b = w.getBuilding(bx, by);
        if (b && b.def.id === 'campfire') return true;
      }
    }
    return false;
  }
}
