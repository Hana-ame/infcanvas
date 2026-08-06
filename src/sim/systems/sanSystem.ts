// SAN 理智系统（DESIGN §3）：目睹死亡/恐怖事件 ↓，远离篝火独自过夜 ↓，
// 低理智 → 狂乱行为（发呆/乱跑）；篝火附近休息恢复。
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus, GameEvent } from '../core/events';
import type { PawnState, NeedsData } from '../sim';
import type { SanTuning } from '../defs/tuning';

export class SanSystem implements GameSystem {
  id = 'san';

  constructor(private ctx: SimContext) {}

  init(bus: EventBus): void {
    // 目睹死亡：附近小人理智受创
    bus.on('pawn_died', (ev) => {
      const died = ev as Extract<GameEvent, { type: 'pawn_died' }>;
      if (died.cause === 'starvation' || died.cause === 'combat') {
        const s = this.ctx.tuning.san;
        for (const eid of this.ctx.pawnList) {
          const pos = this.ctx.pawnPositions.get(eid);
          if (!pos) continue;
          const d = Math.hypot(pos.x - died.x, pos.y - died.y);
          if (d <= s.witnessRadius) {
            const n = this.ctx.readNeeds(eid);
            if (n) {
              // POW 意志抗压：高意志对死亡冲击耐受（COC §3）
              const dna = this.ctx.dnaOf(eid);
              const resist = dna ? 1 - Math.max(0, (dna.pow - 40)) / 100 : 1;
              const shock = s.deathShock * Math.max(0.4, 1 - d / s.witnessRadius) * Math.max(0.4, resist);
              n.san -= shock;
              n.mood -= s.deathMood;
              this.ctx.setNeeds(eid, n);
              this.ctx.adjustMood(eid, -s.deathMood);
              if (n.san < s.crazyAt) this.ctx.logEvent('😨 目睹死亡，理智崩溃');
            }
          }
        }
      }
    });
  }

  update(dt: number): void {
    const s = this.ctx.tuning.san;
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const n = this.ctx.readNeeds(eid);
      if (!n) continue;
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;

      // 黑夜 + 远离篝火 → 黑暗恐惧，理智流失（POW 高更镇定）
      if (this.ctx.isNight() && !this.nearCampfire(pos.x, pos.y, s.fireComfortRadius)) {
        const dna = this.ctx.dnaOf(eid);
        const resist = dna ? 1 - Math.max(0, (dna.pow - 40)) / 100 : 1;
        n.san -= s.nightDrain * Math.max(0.4, resist) * dt;
      }

      // 篝火旁休息 → 理智恢复（BuildingDef.aura.sanPerSec 优先）
      if (this.nearCampfire(pos.x, pos.y, s.fireComfortRadius)) {
        n.san += this.fireRecoverAt(pos.x, pos.y, s.fireRecover) * dt;
      }

      this.ctx.setNeeds(eid, n);

      // 狂乱行为：理智过低 → 发呆 / 乱跑（行为变化极端档）
      if (n.san < s.crazyAt) {
        this.handleCrazy(eid, st, n, dt, s);
      }
    }
  }

  // 篝火光环理智恢复：aura.sanPerSec 优先，否则 tuning.san.fireRecover
  private fireRecoverAt(x: number, y: number, fallback: number): number {
    const w = this.ctx.world;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const b = w.getBuilding(Math.round(x) + dx, Math.round(y) + dy);
        if (b && b.def.aura?.sanPerSec !== undefined) return b.def.aura.sanPerSec;
      }
    }
    return fallback;
  }

  private nearCampfire(x: number, y: number, radius: number): boolean {
    const w = this.ctx.world;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const bx = Math.round(x) + dx;
        const by = Math.round(y) + dy;
        if (!w.inBounds(bx, by)) continue;
        const b = w.getBuilding(bx, by);
        if (b && b.def.tags?.includes('warmth')) return true;
      }
    }
    return false;
  }

  // 狂乱：发呆或随机乱跑
  private handleCrazy(eid: number, st: PawnState, n: NeedsData, dt: number, s: SanTuning): void {
    // 狂乱中不工作、不进食决策
    if (st.path && st.pathIndex < st.path.length) return; // 继续走完当前路径
    st.job = '理智崩溃';
    // 在乱跑冷却内发呆
    st.crazyCooldown = (st.crazyCooldown ?? 0) - dt;
    if ((st.crazyCooldown ?? 0) > 0) return;
    // 随机乱跑：找周围可通行格
    const pos = this.ctx.pawnPositions.get(eid);
    if (!pos) return;
    const w = this.ctx.world;
    for (let attempt = 0; attempt < 8; attempt++) {
      const tx = Math.round(pos.x) + this.ctx.rng.int(-6, 6);
      const ty = Math.round(pos.y) + this.ctx.rng.int(-6, 6);
      if (w.inBounds(tx, ty) && w.isPassable(tx, ty)) {
        this.ctx.moveTo(eid, tx, ty);
        st.crazyCooldown = s.crazyCooldownMin + this.ctx.rng.next() * (s.crazyCooldownMax - s.crazyCooldownMin);
        return;
      }
    }
  }
}
