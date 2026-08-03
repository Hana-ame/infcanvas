// 袭击 + 战斗系统：刷狼群 → 移动 → 接敌 → 战死掉落
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';

export class RaidSystem implements GameSystem {
  id = 'raid';
  private raidTimer = 60;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this.updateRaids(dt);
    this.updateCombat(dt);
  }

  private updateRaids(dt: number): void {
    if (this.ctx.pawnList.length === 0) return;
    if (this.ctx.hostiles.length === 0 && this.raidTimer <= 0) {
      // 上一波结束，安排下一波
      this.raidTimer = 75;
    }
    if (this.ctx.hostiles.length === 0) {
      this.raidTimer -= dt;
      if (this.raidTimer <= 0) {
        const count = Math.floor(2 + this.ctx.pawnList.length * 0.5);
        this.spawnRaid(count);
        this.ctx.bus.emit({ type: 'raid_started', count });
        this.ctx.logEvent(`⚠ 野狼来袭！${count} 只`);
      }
    }
  }

  private spawnRaid(count: number): void {
    const w = this.ctx.world;
    const edge = Math.floor(this.ctx.rng.next() * 4);
    const cx = Math.floor(w.width / 2);
    const cy = Math.floor(w.height / 2);
    for (let i = 0; i < count; i++) {
      let x: number, y: number;
      if (edge === 0) { x = this.ctx.rng.int(0, w.width - 1); y = 0; }
      else if (edge === 1) { x = this.ctx.rng.int(0, w.width - 1); y = w.height - 1; }
      else if (edge === 2) { x = 0; y = this.ctx.rng.int(0, w.height - 1); }
      else { x = w.width - 1; y = this.ctx.rng.int(0, w.height - 1); }
      this.ctx.hostiles.push({ x, y, hp: 60, maxHp: 60, targetX: cx, targetY: cy });
    }
  }

  private updateCombat(dt: number): void {
    if (this.ctx.hostiles.length === 0) return;
    for (const h of this.ctx.hostiles) {
      const dx = h.targetX - h.x;
      const dy = h.targetY - h.y;
      const d = Math.hypot(dx, dy);
      const step = 3.5 * dt;
      if (d > step) {
        h.x += (dx / d) * step;
        h.y += (dy / d) * step;
      }
    }
    for (let i = this.ctx.hostiles.length - 1; i >= 0; i--) {
      const h = this.ctx.hostiles[i];
      let nearest: number | null = null;
      let nd = 5;
      for (const eid of this.ctx.pawnList) {
        const pos = this.ctx.pawnPositions.get(eid);
        if (!pos) continue;
        const d = Math.hypot(pos.x - h.x, pos.y - h.y);
        if (d < nd) { nd = d; nearest = eid; }
      }
      // 没有足够近的小人时，攻击附近建筑（墙优先）
      if (nearest === null) {
        const b = this.nearestBuilding(h, 6);
        if (b) {
          const r = this.ctx.world.damageBuilding(b.x, b.y, 15 * dt);
          if (r.destroyed) this.ctx.logEvent('💥 建筑被野狼摧毁！');
          continue;
        }
      }
      if (nearest !== null) {
        h.hp -= 8 * dt;
        if (h.hp <= 0) {
          this.ctx.hostiles.splice(i, 1);
          this.ctx.stockpile.ore += 2;
          this.ctx.bus.emit({ type: 'resource_gained', eid: nearest, item: 'ore', amount: 2 });
          continue;
        }
        const hk = this.ctx.readHealth(nearest);
        if (hk) {
          const dmg = Math.min(hk.hp, 5 * dt);
          hk.hp -= dmg;
          if (hk.hp <= 0) {
            this.ctx.setHealth(nearest, { hp: 0, maxHp: hk.maxHp });
            const pos = this.ctx.readPosition(nearest);
            this.ctx.bus.emit({ type: 'pawn_died', eid: nearest, x: pos?.x ?? 0, y: pos?.y ?? 0, cause: 'combat' });
            this.ctx.killPawn(nearest);
      } else {
        this.ctx.setHealth(nearest, hk);
      }
    }
    }
    }
  }

  private nearestBuilding(h: { x: number; y: number }, radius: number): { x: number; y: number } | null {
    const w = this.ctx.world;
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = Math.round(h.x) + dx;
        const y = Math.round(h.y) + dy;
        if (!w.inBounds(x, y)) continue;
        if (!w.getBuilding(x, y)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = { x, y }; }
      }
    }
    return best;
  }
}
