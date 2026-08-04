// 袭击 + 战斗系统：刷狼群 → 移动 → 接敌 → 战死掉落
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';

export class RaidSystem implements GameSystem {
  id = 'raid';
  private raidTimer = 60;
  private peaceTime = 0; // 距上次袭击的和平时长（叙事压力，DESIGN §6）
  private baseInterval = 75; // 基线袭击间隔（秒）

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this.updateRaids(dt);
    this.updateCombat(dt);
  }

  // 叙事压力（DESIGN §6）：和平越久 → 战斗压力越高
  // 压力 = 超出基线的和平时长比例，缩短间隔 + 放大袭击
  private narrativePressure(): number {
    return Math.min(2, 1 + this.peaceTime / (this.baseInterval * 3));
  }

  private updateRaids(dt: number): void {
    if (this.ctx.pawnList.length === 0) return;
    if (this.ctx.hostiles.length === 0 && this.raidTimer <= 0) {
      // 上一波结束，安排下一波（间隔受叙事压力缩短）
      this.raidTimer = this.baseInterval / this.narrativePressure();
    }
    if (this.ctx.hostiles.length === 0) {
      this.peaceTime += dt;
      this.raidTimer -= dt;
      if (this.raidTimer <= 0) {
        // 和平越久袭击越猛
        const pressure = this.narrativePressure();
        const count = Math.floor((2 + this.ctx.pawnList.length * 0.5) * pressure);
        this.spawnRaid(count, pressure);
        this.peaceTime = 0;
        this.ctx.bus.emit({ type: 'raid_started', count });
        this.ctx.logEvent(`⚠ 野狼来袭！${count} 只${pressure > 1.3 ? '（积怨已久，规模更大）' : ''}`);
      }
    }
  }

  private spawnRaid(count: number, pressure = 1): void {
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
      this.ctx.hostiles.push({ x, y, hp: 60 * pressure, maxHp: 60 * pressure, targetX: cx, targetY: cy });
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
          if (r.destroyed) {
            this.ctx.logEvent('💥 建筑被野狼摧毁！');
            // 征服（Q9）：若被毁的是某派系核心篝火/教堂，且攻击者是派系 → 吞并
            if (h.faction === 'unit' && h.name) {
              const key = this.ctx.world.buildKey(b.x, b.y);
              this.ctx.conquestOf(key, h.name);
            }
          }
          continue;
        }
      }
      if (nearest !== null) {
        h.hp -= 8 * dt;
        this.ctx.growSkill(nearest, 'fight');
        if (h.hp <= 0) {
          this.ctx.hostiles.splice(i, 1);
          this.ctx.stockpile.ore += 2;
          this.ctx.bus.emit({ type: 'resource_gained', eid: nearest, item: 'ore', amount: 2 });
          continue;
        }
        const hk = this.ctx.readHealth(nearest);
        if (hk) {
          // DEX 敏捷闪避（COC §3）：高敏捷有一定几率闪开野狼咬
          const dna = this.ctx.dnaOf(nearest);
          const dodgeChance = dna ? Math.max(0.05, (dna.dex - 30) / 100) : 0;
          const dodge = dna && this.ctx.rng.next() < dodgeChance;
          const dmg = dodge ? 0 : Math.min(hk.hp, 5 * dt);
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
