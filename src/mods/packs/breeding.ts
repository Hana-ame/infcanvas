// 生育系统玩法包（2026-08-20，用户「生育」）：伴侣配对/怀孕/出生
// 设计：社交好感 ≥ threshold 的两个小人 → 概率怀孕 → 怀孕期（pregnancyDuration 秒）
// → 出生新小人（spawnPawn）。走 PawnState.extra[K_PREGNANCY] = { partner, time }。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';

export const K_PREGNANCY = 'pregnancy';

const CFG = {
  loveThreshold: 30, // 2026-08-20 平衡：60→30（好感门槛降低, 早期可生育）      // 好感阈值：≥ 此值才可能怀孕
  pregnancyChance: 0.02, // 2026-08-20 平衡：0.01→0.02（提高怀孕概率）  // 每秒好感达标的伴侣怀孕概率
  pregnancyDuration: 60,  // 怀孕期（秒）
  tickInterval: 5,        // 低频评估
  maxOffspring: 2,        // 单对最多同时孕育数（防人口爆炸）
};

export const BREEDING_CONFIG = CFG;

// 生育系统：社交好感 ≥ loveThreshold 的伴侣 → 概率怀孕 → 孕期到期出生新小人
// 2026-08-20：节流 5s（怀孕是慢过程，不需要每帧检查）；出生时调 genetics.mixDna（如挂载）
class BreedingSystem {
  id = 'breeding';
  private timer = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this.timer += dt;
    if (this.timer < CFG.tickInterval) return;
    this.timer = 0;
    // 检查怀孕中的小人
    const checked = new Set<number>();
    for (const eid of this.ctx.iterPawns) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st?.extra?.[K_PREGNANCY]) continue;
      const preg = st.extra[K_PREGNANCY] as { partner: number; time: number };
      preg.time += CFG.tickInterval;
      if (preg.time >= CFG.pregnancyDuration) {
        // 出生
        const pos = this.ctx.pawnPositions.get(eid);
        if (pos) {
          const baby = this.ctx.spawnPawn(Math.round(pos.x) + 1, Math.round(pos.y));
          if (baby !== -1) {
            this.ctx.logEvent(`👶 #${eid} 生了一个小宝宝 #${baby}！`);
            // 基因混合由 genetics 包处理（若挂载）
          }
        }
        delete st.extra![K_PREGNANCY];
      }
      checked.add(eid);
      checked.add(preg.partner);
    }
    // 检查配对（好感达标 + 无怀孕 → 概率怀孕）
    for (const eid of this.ctx.iterPawns) {
      if (checked.has(eid)) continue;
      const st = this.ctx.pawnStates.get(eid);
      if (!st || st.extra?.[K_PREGNANCY]) continue;
      const rel = st.relationships;
      if (!rel || rel.size === 0) continue;
      // 找好感最高的伴侣
      let bestPartner = -1;
      let bestRel = 0;
      for (const [other, r] of rel) {
        if (r >= CFG.loveThreshold && r > bestRel && !checked.has(other)) {
          bestPartner = other;
          bestRel = r;
        }
      }
      if (bestPartner >= 0 && this.ctx.rng.next() < CFG.pregnancyChance * CFG.tickInterval) {
        st.extra = { ...st.extra, [K_PREGNANCY]: { partner: bestPartner, time: 0 } };
        checked.add(eid);
        checked.add(bestPartner);
        this.ctx.logEvent(`💕 #${eid} 和 #${bestPartner} 有了爱情的结晶`);
      }
    }
  }
}

export const breedingPack: ModPack = {
  id: 'breeding',
  requires: ['social'],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'breeding', label: '生育', category: 'world',
      ctor: (ctx) => new BreedingSystem(ctx),
    });
  },
};