// 需求系统：衰减 / 夜晚更困 / 饥饿死亡 / 紧急需求
// 数据驱动：衰减与阈值读 tuning.needs；光环（篝火/奇观）读 BuildingDef.aura，mod 可调
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
      this._wonderAura = null;
      for (const [, b] of this.ctx.world.buildings) {
        if (b.def.tags?.includes('wonder')) {
          found = true;
          this._wonderAura = b.def.aura ?? null;
          break;
        }
      }
      this.wonderCache = found;
    }
    return this.wonderCache;
  }

  // 每帧：需求衰减 + 环境/光环修正 + 饥饿死亡 + 紧急需求标记
  update(dt: number): void {
    const t = this.ctx.tuning.needs;
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const n = this.ctx.readNeeds(eid);
      if (!n) continue;
      tickNeeds(n, dt, t);
      // 夜晚精力消耗加快（读 tuning.needs）
      if (this.ctx.isNight()) n.rest -= t.nightRestDrain * dt;
      // 篝火光环（饥荒式社会锚点）：火边心情回暖、夜晚不易困（读 BuildingDef.aura）
      const aura = this.nearAura(eid);
      if (aura) {
        if (aura.moodPerSec) n.mood = Math.min(100, n.mood + aura.moodPerSec * dt);
        if (aura.restPerSec) n.rest = Math.min(100, n.rest + aura.restPerSec * dt);
      }
      // 神谕祝福（buff 持续期间心情加成）
      if (st.oracleBuff && st.oracleBuff.until > this.ctx.time) {
        n.mood = Math.min(100, n.mood + st.oracleBuff.mood * dt);
      }
      // 奇观光环（Q10）：纪念碑建成 → 全营地敬畏（心情+信仰）
      if (this.hasWonder) {
        const wonderAura = this.wonderAura;
        if (wonderAura?.moodPerSec) n.mood = Math.min(100, n.mood + wonderAura.moodPerSec * dt);
      }
      this.ctx.setNeeds(eid, n);
      // 饿死
      if (n.food <= 0) {
        const h = this.ctx.readHealth(eid);
        if (h) {
          h.hp -= t.starvationDmg * dt;
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
      const urgent = urgentNeedAction(n, this.ctx.tuning.needs);
      if (urgent) st.urgent = urgent;
    }
  }

  // 附近 aura 建筑（篝火/纪念碑）——返回最近的 aura 定义（读 BuildingDef.aura）
  private nearAura(eid: number): { moodPerSec?: number; restPerSec?: number } | null {
    const pos = this.ctx.pawnPositions.get(eid);
    if (!pos) return null;
    const w = this.ctx.world;
    const R = this.ctx.tuning.needs.auraScanRadius; // 扫描半径（tuning；生效距离由 def.aura.radius 决定）
    let best: { moodPerSec?: number; restPerSec?: number } | null = null;
    let bestD = Infinity;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const bx = Math.round(pos.x) + dx;
        const by = Math.round(pos.y) + dy;
        if (!w.inBounds(bx, by)) continue;
        const b = w.getBuilding(bx, by);
        if (b && b.def.aura) {
          const d = dx * dx + dy * dy;
          const radius = b.def.aura.radius ?? R; // mod 可调各建筑光环半径
          if (d <= radius * radius && d < bestD) { bestD = d; best = b.def.aura; }
        }
      }
    }
    return best;
  }

  // 奇观（纪念碑）aura 定义——hasWonder 按 buildingVersion 缓存填充
  private _wonderAura: { moodPerSec?: number } | null = null;
  private get wonderAura(): { moodPerSec?: number } | null {
    return this._wonderAura;
  }
}
