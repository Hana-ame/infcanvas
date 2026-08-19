// SAN 理智系统（DESIGN §3）：目睹死亡/恐怖事件 ↓，远离篝火独自过夜 ↓，
// 低理智 → 狂乱行为（发呆/乱跑）；篝火附近休息恢复。
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus, GameEvent } from '../core/events';
import type { PawnState, NeedsData } from '../sim';
import type { SanTuning } from '../defs/tuning';
import { World } from '../core/world';

export class SanSystem implements GameSystem {
  id = 'san';
  // 架构优化（2026-08-16）：每 tick 缓存篝火列表，nearCampfire/fireRecoverAt 改遍历缓存
  // 而非 queryBuildingsNear——后者每次查空间分区，40 pawn × 2 次/tick = 80 次查询；
  // 篝火通常只有 1-3 个，直接距离比较 O(n_fires) 更快。max 109ms 尖峰的主因消除。
  private warmthBuildings: { x: number; y: number; aura: number | undefined }[] = [];

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
              const resist = dna ? 1 - Math.max(0, (dna.pow - s.powResistMid)) / s.powResistScale : 1;
              const shock = s.deathShock * Math.max(s.resistFloor, 1 - d / s.witnessRadius) * Math.max(s.resistFloor, resist);
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
    // 每 tick 刷新篝火缓存（建筑变化时自动跟上——低频操作，篝火数量少）
    this.warmthBuildings = [];
    for (const [key, b] of this.ctx.world.buildings) {
      if (b.def.tags?.includes('warmth')) {
        const { x, y } = World.keyToXY(key);
        this.warmthBuildings.push({ x, y, aura: b.def.aura?.sanPerSec });
      }
    }
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const n = this.ctx.readNeeds(eid);
      if (!n) continue;
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;

      // 单次遍历篝火缓存：同时判定 nearCampfire + fireRecover（合并两次 queryBuildingsNear）
      let nearFire = false;
      let fireRecover = s.fireRecover;
      const r2 = s.fireComfortRadius * s.fireComfortRadius;
      for (const w of this.warmthBuildings) {
        const ddx = w.x - pos.x, ddy = w.y - pos.y;
        if (ddx * ddx + ddy * ddy <= r2) {
          nearFire = true;
          if (w.aura !== undefined) fireRecover = w.aura;
        }
      }

      // 黑夜 + 远离篝火 → 黑暗恐惧，理智流失（POW 高更镇定）
      if (this.ctx.isNight() && !nearFire) {
        const dna = this.ctx.dnaOf(eid);
        const resist = dna ? 1 - Math.max(0, (dna.pow - s.powResistMid)) / s.powResistScale : 1;
        n.san -= s.nightDrain * Math.max(s.resistFloor, resist) * dt;
      }

      // 篝火旁休息 → 理智恢复（aura.sanPerSec 优先，否则 tuning.san.fireRecover）
      if (nearFire) {
        n.san += fireRecover * dt;
      }

      this.ctx.setNeeds(eid, n);

      // 狂乱行为：理智过低 → 发呆 / 乱跑（行为变化极端档）
      if (n.san < s.crazyAt) {
        this.handleCrazy(eid, st, n, dt, s);
      }
    }
  }

  // 狂乱：发呆或随机乱跑；持续超过 crazyFleeAfter → 本能逃向最近篝火
  //（防"远处无火区 SAN 永不复原 → 永久崩溃"死锁：崩溃者终将寻回安全处恢复）
  private handleCrazy(eid: number, st: PawnState, n: NeedsData, dt: number, s: SanTuning): void {
    // 狂乱中不工作、不进食决策
    if (st.path && st.pathIndex < st.path.length) return; // 继续走完当前路径
    st.job = '理智崩溃';
    const pos = this.ctx.pawnPositions.get(eid);
    // 在篝火旁：呆着等 SAN 恢复（任何时刻在火旁都不乱跑、不累计狂乱时长）
    // 发现背景：此前的"火旁重置 crazyTime"落在乱跑逻辑前，但下一帧 crazyTime 从 0
    // 重新累计 → 期间又落下去乱跑走开 → 永远离开火堆、SAN 永不恢复
    //（采集狩猎局 30 分钟 8/11 人永久崩溃，人在火边 4-13 格 san 恒 0）。
    if (pos) {
      // 用篝火缓存判定（与 update 同源，避免再查 queryBuildingsNear）
      const r2 = s.fireComfortRadius * s.fireComfortRadius;
      const nearFire = this.warmthBuildings.some((w) => {
        const ddx = w.x - pos.x, ddy = w.y - pos.y;
        return ddx * ddx + ddy * ddy <= r2;
      });
      if (nearFire) {
        st.crazyTime = 0;
        return;
      }
    }
    st.crazyTime = (st.crazyTime ?? 0) + dt;
    // 逃向篝火模式：寻路到最近 warmth 建筑（到达后 SAN 恢复自然解除）
    if ((st.crazyTime ?? 0) > s.crazyFleeAfter) {
      if (!st.crazyFleeTarget) {
        // 2026-08-16 优化：用 update 的 warmthBuildings 缓存（原遍历全建筑表——
        // 每个崩溃者每帧遍历 = 多人崩溃时 max 29ms 尖峰）
        let best: { x: number; y: number } | null = null;
        let bestD = Infinity;
        for (const w of this.warmthBuildings) {
          const d = (w.x - (pos?.x ?? 0)) ** 2 + (w.y - (pos?.y ?? 0)) ** 2;
          if (d < bestD) { bestD = d; best = { x: w.x, y: w.y }; }
        }
        st.crazyFleeTarget = best ?? undefined;
      }
      if (st.crazyFleeTarget) {
        this.ctx.moveTo(eid, st.crazyFleeTarget.x, st.crazyFleeTarget.y);
        return;
      }
    }
    // 在乱跑冷却内发呆
    st.crazyCooldown = (st.crazyCooldown ?? 0) - dt;
    if ((st.crazyCooldown ?? 0) > 0) return;
    // 随机乱跑：找周围可通行格（pos 取自上方的函数级声明）
    if (!pos) return;
    const w = this.ctx.world;
    for (let attempt = 0; attempt < s.crazyWanderAttempts; attempt++) {
      const tx = Math.round(pos.x) + this.ctx.rng.int(-s.crazyWanderRange, s.crazyWanderRange);
      const ty = Math.round(pos.y) + this.ctx.rng.int(-s.crazyWanderRange, s.crazyWanderRange);
      if (w.inBounds(tx, ty) && w.isPassable(tx, ty)) {
        this.ctx.moveTo(eid, tx, ty);
        st.crazyCooldown = s.crazyCooldownMin + this.ctx.rng.next() * (s.crazyCooldownMax - s.crazyCooldownMin);
        return;
      }
    }
  }
}
