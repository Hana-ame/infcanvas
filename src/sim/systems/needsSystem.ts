// 需求系统：衰减 / 夜晚更困 / 饥饿死亡 / 紧急需求
// 数据驱动：衰减与阈值读 tuning.needs；光环（篝火/奇观）读 BuildingDef.aura，mod 可调
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import { urgentNeedAction } from '../core/needs';
import { World } from '../core/world';
import { buildTagIndex, findNearestTagged, getTaggedInRange } from './building-cache';

// 需求系统：食物/精力/心情/理智 衰减+恢复（tickNeedsBatch 直写 ECS 数组）+ aura 建筑
// 2026-08-20：batch 模式下只对 currentBatch 做 aura 检查（全体衰减仍 O(n) 直接数组写）
export class NeedsSystem implements GameSystem {
  id = 'needs';
  private wonderVersion = -1;
  private wonderCache = false;
  private _bldVer = -1;
  private tagIndex: Map<string, import('./building-cache').CachedBuilding[]> = new Map();
  // 2026-08-20 优化：aura 建筑专用小缓存（~3-5 条，不走通用 tagIndex）
  private auraBuildings: { x: number; y: number; radius: number; moodPerSec?: number; restPerSec?: number }[] = [];

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
    // 2026-08-20 架构优化：aura 建筑用专用小缓存（~3-5 条），不走通用 tagIndex（后者遍历全部 tag × 全部建筑 = O(n²)）
    if (this._bldVer !== this.ctx.world.buildingVersion) { this._bldVer = this.ctx.world.buildingVersion; this.tagIndex = buildTagIndex(this.ctx); }
    this.auraBuildings = this.buildAuraCache();
    // 2026-08-20 大规模优化：aura 只对 batch 内 pawn 检查
    // 2026-08-20 十万级优化：批量 needs 衰减（直接写 ECS 数组，无对象分配）
    if (this.ctx.tickNeedsBatch) {
      this.ctx.tickNeedsBatch(this.ctx.iterPawns, dt); // needs decay 全体（O(n) 直接数组写 = 快）
      // aura 只对 batch 内 pawn 检查
      const batchArr = this.ctx.iterPawns;
      for (const eid of batchArr) {
        const n = this.ctx.readNeeds(eid);
        if (!n) continue;
        const aura = this.nearAura(eid);
        if (aura) {
          if (aura.moodPerSec) n.mood = Math.min(100, n.mood + aura.moodPerSec * dt);
          if (aura.restPerSec) n.rest = Math.min(100, n.rest + aura.restPerSec * dt);
        }
        const pos = this.ctx.pawnPositions.get(eid);
        if (pos) {
          const tile = this.ctx.world.getTileDef(Math.round(pos.x), Math.round(pos.y));
          if (tile.shelter) {
            n.rest = Math.min(100, n.rest + t.shelterRestPerSec * dt);
            n.mood = Math.min(100, n.mood + t.shelterMoodPerSec * dt);
          }
        }
        const st = this.ctx.pawnStates.get(eid);
        if (st?.oracleBuff && st.oracleBuff.until > this.ctx.time) {
          n.mood = Math.min(100, n.mood + st.oracleBuff.mood * dt);
        }
        this.ctx.setNeedField(eid, 'mood', n.mood);
        this.ctx.setNeedField(eid, 'rest', n.rest);
        // 饥饿死亡
        if (n.food <= 0) {
          const hp = this.ctx.readHealth(eid);
          if (hp && hp.hp > 0) {
            this.ctx.setHealth(eid, { hp: hp.hp - t.starvationDmg * dt, maxHp: hp.maxHp });
            if (this.ctx.readHealth(eid)!.hp <= 0) {
              const pos2 = this.ctx.readPosition(eid);
              this.ctx.killPawn(eid);
              this.ctx.bus.emit({ type: 'pawn_died', eid, x: pos2?.x ?? 0, y: pos2?.y ?? 0, cause: 'starvation' } as never);
            }
          }
        }
        // 紧急需求标记
        if (n.food < t.hungerAt) { (st as { urgent?: string }).urgent = 'eat'; }
        else if (n.rest < t.sleepyAt) { (st as { urgent?: string }).urgent = 'rest'; }
        else { (st as { urgent?: string }).urgent = undefined; }
        this.recordNeed(eid, st!, n);
      }
    } else {
      // 回退路径（minCtx 无 tickNeedsBatch）
      const batchArr = this.ctx.iterPawns;
      const batchSet = new Set(batchArr);
      for (const eid of this.ctx.iterPawns) {
        const st = this.ctx.pawnStates.get(eid);
        if (!st) continue;
        const n = this.ctx.readNeeds(eid);
        if (!n) continue;
        n.food -= t.foodDecay * dt;
        n.rest -= t.restDecay * dt;
        if (this.ctx.isNight()) n.rest -= t.nightRestDrain * dt;
        if (n.food < t.foodMoodLow) n.mood -= t.moodDriftDown * dt;
        else if (n.food > t.foodMoodHigh) n.mood += t.moodDriftUp * dt;
        n.san += t.sanRecover * dt;
        if (n.food < t.sanTraumaThreshold || n.mood < t.sanTraumaThreshold) n.san -= t.sanTraumaDrain * dt;
        n.food = Math.max(0, Math.min(100, n.food));
        n.rest = Math.max(0, Math.min(100, n.rest));
        n.mood = Math.max(0, Math.min(100, n.mood));
        n.san = Math.max(0, Math.min(100, n.san));
        this.ctx.setNeedField(eid, 'food', n.food);
        this.ctx.setNeedField(eid, 'rest', n.rest);
        this.ctx.setNeedField(eid, 'mood', n.mood);
        this.ctx.setNeedField(eid, 'san', n.san);
        if (!batchSet.has(eid)) continue;
        const aura = this.nearAura(eid);
        if (aura) {
          if (aura.moodPerSec) n.mood = Math.min(100, n.mood + aura.moodPerSec * dt);
          if (aura.restPerSec) n.rest = Math.min(100, n.rest + aura.restPerSec * dt);
        }
        const pos = this.ctx.pawnPositions.get(eid);
        if (pos) {
          const tile = this.ctx.world.getTileDef(Math.round(pos.x), Math.round(pos.y));
          if (tile.shelter) {
            n.rest = Math.min(100, n.rest + t.shelterRestPerSec * dt);
            n.mood = Math.min(100, n.mood + t.shelterMoodPerSec * dt);
          }
        }
        this.ctx.setNeedField(eid, 'mood', n.mood);
        this.ctx.setNeedField(eid, 'rest', n.rest);
        if (n.food <= 0) {
          const hp = this.ctx.readHealth(eid);
          if (hp && hp.hp > 0) {
            this.ctx.setHealth(eid, { hp: hp.hp - t.starvationDmg * dt, maxHp: hp.maxHp });
            if (this.ctx.readHealth(eid)!.hp <= 0) {
              this.ctx.killPawn(eid);
              this.ctx.bus.emit({ type: 'pawn_died', eid, x: 0, y: 0, cause: 'starvation' } as never);
            }
          }
        }
        if (n.food < t.hungerAt) { (st as { urgent?: string }).urgent = 'eat'; }
        else if (n.rest < t.sleepyAt) { (st as { urgent?: string }).urgent = 'rest'; }
        else { (st as { urgent?: string }).urgent = undefined; }
        this.recordNeed(eid, st!, n);
      }
    }
  }

  // 需求写入附近篝火记忆（饥饿/受伤/低落）。阈值变化才写（节流）：st.lastNeedRec 记录上次写的
  // 等级，跨越更高危急等级才更新 → 不会每帧刷屏。
  private recordNeed(eid: number, st: { lastNeedRec?: number }, n: { food: number; mood: number }): void {
    const t = this.ctx.tuning.social;
    const pos = this.ctx.pawnPositions.get(eid);
    if (!pos) return;
    // 危急等级：0=无事，1=低落，2=濒死（食物/心情越危急等级越高）
    let level = 0;
    if (n.food < t.helpFoodNeedAt) level = 2;          // 濒死（送食）
    else if (n.mood < t.helpMoodNeedAt) level = 1;     // 低落（陪伴）
    if (level <= (st.lastNeedRec ?? 0)) return;        // 未跨越新阈值 → 不写
    st.lastNeedRec = level;
    const text = level === 2 ? `🙏 #${eid} 饥饿难耐，渴望食物` : `😔 #${eid} 情绪低落，渴望陪伴`;
    // 记入最近 campfire 的区域记忆（需求进篝火历史 → 交流传播 → 好友得知后送食）
    const w = this.ctx.world;
    let best: number | null = null;
    let bestD = Infinity;
    for (const [key, b] of w.buildings) {
      if (b.def.id !== 'campfire') continue;
      // 新 key 编码（2026-08-14 无限地图）：World.keyToXY 解码（负坐标支持）
      const { x: bx, y: by } = World.keyToXY(key);
      const d = (pos.x - bx) ** 2 + (pos.y - by) ** 2;
      if (d < bestD) { bestD = d; best = key; }
    }
    if (best !== null) this.ctx.socialUnits.addMemory(best, text);
  }

  // 附近 aura 建筑（2026-08-20 架构优化：用共享 building-cache）
  // 构建 aura 缓存（从共享 tagIndex 提取带 aura 的建筑 → 专用小列表）
  private buildAuraCache(): { x: number; y: number; radius: number; moodPerSec?: number; restPerSec?: number }[] {
    const out: { x: number; y: number; radius: number; moodPerSec?: number; restPerSec?: number }[] = [];
    const R = this.ctx.tuning.needs.auraScanRadius;
    for (const [, buildings] of this.tagIndex) {
      for (const b of buildings) {
        if (!b.def.aura) continue;
        out.push({ x: b.x, y: b.y, radius: b.def.aura.radius ?? R, moodPerSec: b.def.aura.moodPerSec, restPerSec: b.def.aura.restPerSec });
      }
    }
    return out;
  }

  private nearAura(eid: number): { moodPerSec?: number; restPerSec?: number } | null {
    const pos = this.ctx.pawnPositions.get(eid);
    if (!pos) return null;
    // 遍历所有 tag 的建筑，找带 aura 的最近建筑
    let best: { moodPerSec?: number; restPerSec?: number } | null = null;
    let bestD = Infinity;
    for (const [, buildings] of this.tagIndex) {
      for (const b of buildings) {
        if (!b.def.aura) continue;
        const radius = b.def.aura.radius ?? this.ctx.tuning.needs.auraScanRadius;
        const d = (b.x - pos.x) ** 2 + (b.y - pos.y) ** 2;
        if (d <= radius * radius && d < bestD) {
          bestD = d;
          best = { moodPerSec: b.def.aura.moodPerSec, restPerSec: b.def.aura.restPerSec };
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
