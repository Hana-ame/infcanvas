// SAN 理智系统（DESIGN §3）：目睹死亡/恐怖事件 ↓，远离篝火独自过夜 ↓，
// 低理智 → 狂乱行为（发呆/乱跑）；篝火附近休息恢复。
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus, GameEvent } from '../core/events';
import type { PawnState, NeedsData } from '../sim';

const CRAZY_SAN = 25; // 低于此值触发狂乱
const WITNESS_RADIUS = 8; // 目睹死亡的距离
const FIRE_COMFORT = 7; // 篝火安全感半径

export class SanSystem implements GameSystem {
  id = 'san';

  constructor(private ctx: SimContext) {}

  init(bus: EventBus): void {
    // 目睹死亡：附近小人理智受创
    bus.on('pawn_died', (ev) => {
      const died = ev as Extract<GameEvent, { type: 'pawn_died' }>;
      if (died.cause === 'starvation' || died.cause === 'combat') {
        for (const eid of this.ctx.pawnList) {
          const pos = this.ctx.pawnPositions.get(eid);
          if (!pos) continue;
          const d = Math.hypot(pos.x - died.x, pos.y - died.y);
          if (d <= WITNESS_RADIUS) {
            const n = this.ctx.readNeeds(eid);
            if (n) {
              // POW 意志抗压：高意志对死亡冲击耐受（COC §3）
              const dna = this.ctx.dnaOf(eid);
              const resist = dna ? 1 - Math.max(0, (dna.pow - 40)) / 100 : 1;
              const shock = 12 * Math.max(0.4, 1 - d / WITNESS_RADIUS) * Math.max(0.4, resist);
              n.san -= shock;
              n.mood -= 4;
              this.ctx.setNeeds(eid, n);
              this.ctx.adjustMood(eid, -4);
              if (n.san < CRAZY_SAN) this.ctx.logEvent('😨 目睹死亡，理智崩溃');
            }
          }
        }
      }
    });
  }

  update(dt: number): void {
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const n = this.ctx.readNeeds(eid);
      if (!n) continue;
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;

      // 黑夜 + 远离篝火 → 黑暗恐惧，理智流失（POW 高更镇定）
      if (this.ctx.isNight() && !this.nearCampfire(pos.x, pos.y)) {
        const dna = this.ctx.dnaOf(eid);
        const resist = dna ? 1 - Math.max(0, (dna.pow - 40)) / 100 : 1;
        n.san -= 0.35 * Math.max(0.4, resist) * dt;
      }

      // 篝火旁休息 → 理智恢复
      if (this.nearCampfire(pos.x, pos.y)) {
        n.san += 2.5 * dt;
      }

      this.ctx.setNeeds(eid, n);

      // 狂乱行为：理智过低 → 发呆 / 乱跑（行为变化极端档）
      if (n.san < CRAZY_SAN) {
        this.handleCrazy(eid, st, n, dt);
      }
    }
  }

  private nearCampfire(x: number, y: number): boolean {
    const w = this.ctx.world;
    for (let dy = -FIRE_COMFORT; dy <= FIRE_COMFORT; dy++) {
      for (let dx = -FIRE_COMFORT; dx <= FIRE_COMFORT; dx++) {
        const bx = Math.round(x) + dx;
        const by = Math.round(y) + dy;
        if (!w.inBounds(bx, by)) continue;
        const b = w.getBuilding(bx, by);
        if (b && b.def.id === 'campfire') return true;
      }
    }
    return false;
  }

  // 狂乱：发呆或随机乱跑
  private handleCrazy(eid: number, st: PawnState, n: NeedsData, dt: number): void {
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
        st.crazyCooldown = 3 + this.ctx.rng.next() * 4;
        return;
      }
    }
  }
}
