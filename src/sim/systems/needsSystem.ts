// 需求系统：衰减 / 夜晚更困 / 饥饿死亡 / 紧急需求
// 数据驱动：衰减与阈值读 tuning.needs；光环（篝火/奇观）读 BuildingDef.aura，mod 可调
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import { tickNeeds, urgentNeedAction } from '../core/needs';
import { World } from '../core/world';

export class NeedsSystem implements GameSystem {
  id = 'needs';
  private wonderVersion = -1;
  private wonderCache = false;
  // 2026-08-16 优化：缓存 aura 建筑列表（原每 pawn 每帧 queryBuildingsNear = 287ms 热点）
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
    // 2026-08-16 优化：每 tick 刷新 aura 建筑缓存（替代每 pawn queryBuildingsNear）
    this.auraBuildings = [];
    const R = t.auraScanRadius;
    for (const [k, b] of this.ctx.world.buildings) {
      if (!b.def.aura) continue;
      const { x, y } = World.keyToXY(k);
      this.auraBuildings.push({ x, y, radius: b.def.aura.radius ?? R, moodPerSec: b.def.aura.moodPerSec, restPerSec: b.def.aura.restPerSec });
    }
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
      // 天然庇护（洞穴 tile shelter）：洞穴里休息恢复（未改造也有房屋属性——用户设计）
      // 数据驱动：TileDef.shelter；改造后的洞穴居所走建筑 aura（更强）
      const pos = this.ctx.pawnPositions.get(eid);
      if (pos && this.ctx.world.getTileDef(Math.round(pos.x), Math.round(pos.y)).shelter) {
        n.rest = Math.min(100, n.rest + this.ctx.tuning.needs.shelterRestPerSec * dt);
        n.mood = Math.min(100, n.mood + this.ctx.tuning.needs.shelterMoodPerSec * dt);
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
      // 需求写篝火历史（2026-08-14 用户设计："篝火记载需求"）：
      // 小人极度饥饿/受伤/低落时，把需求记入附近篝火的区域记忆 → 交流传播 → 好友得知后送食/疗伤。
      // 节流防刷屏：只在该个体"首次达到危急"或"跨过新阈值"时写一次。
      this.recordNeed(eid, st, n);
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

  // 附近 aura 建筑——用缓存遍历（2026-08-16：原 queryBuildingsNear 每 pawn 每帧调用 = 热点）
  private nearAura(eid: number): { moodPerSec?: number; restPerSec?: number } | null {
    const pos = this.ctx.pawnPositions.get(eid);
    if (!pos) return null;
    let best: { moodPerSec?: number; restPerSec?: number } | null = null;
    let bestD = Infinity;
    for (const a of this.auraBuildings) {
      const d = (a.x - pos.x) ** 2 + (a.y - pos.y) ** 2;
      if (d <= a.radius * a.radius && d < bestD) { bestD = d; best = { moodPerSec: a.moodPerSec, restPerSec: a.restPerSec }; }
    }
    return best;
  }

  // 奇观（纪念碑）aura 定义——hasWonder 按 buildingVersion 缓存填充
  private _wonderAura: { moodPerSec?: number } | null = null;
  private get wonderAura(): { moodPerSec?: number } | null {
    return this._wonderAura;
  }
}
