// 篝火系统（2026-08-14 重构：派系实体层删除）
// 用户裁决：不要派系系统，派系只是个体关系的涌现展示。
// 本系统只做三件事（全部是"涌现层"）：
//   1. 篝火区域记忆：事件（建筑/袭击/战死/需求）记入最近 campfire 的记忆（挂在建筑上）
//   2. 归属计算：pawn.fireId = 最近篝火建筑 key（无派系实体；走到哪就近属谁）
//   3. 另起篝火：区域持续不舒适 → 附近另起 campfire（无单位，只是建筑）
// 已删除：SocialUnit 类型 / units / membership / 单位私有库存 / 单位间贸易战争传话 /
//         征服 / 单位命名升级 / faction_event —— 这些"派系作为行动者"的机制全部下沉到个体关系
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import { World } from '../core/world';

// 派系单位系统：篝火记忆管理（谁在哪里建了什么 → 区域记忆 → 社交聊天素材）
export class SocialUnitSystem implements GameSystem {
  id = 'socialUnit';

  constructor(private ctx: SimContext) {}

  init(bus: EventBus): void {
    // 区域历史收集：事件发生时记入「离事发点最近的篝火」记忆（该篝火 = 这片区域的历史载体）。
    // 交流篝火情况 = 读这份记忆（见 socialSystem.交流篝火情况）。
    const recordNearby = (x: number, y: number, text: string): void => {
      const key = this.nearestFire(x, y, this.ctx.tuning.faction.upgradeNearDist);
      if (key !== null) this.addMemory(key, text);
    };
    bus.on('raid_started', (ev) => {
      // 野猫袭击记入营地篝火记忆（敌意信号，交流推断 enemy）
      const d = ev as Extract<import('../core/events').GameEvent, { type: 'raid_started' }>;
      recordNearby(this.ctx.world.width / 2, this.ctx.world.height / 2, `🐱 营地遭到野猫袭击（${d.count} 只）`);
    });
    bus.on('building_built', (ev) => {
      const d = ev as Extract<import('../core/events').GameEvent, { type: 'building_built' }>;
      recordNearby(d.x, d.y, `🏗 建起了建筑（${this.ctx.buildingDef(d.defId)?.name ?? d.defId}）`);
    });
    bus.on('building_destroyed', (ev) => {
      // 建筑被毁记入篝火记忆（敌意信号）
      const d = ev as Extract<import('../core/events').GameEvent, { type: 'building_destroyed' }>;
      recordNearby(d.x, d.y, `💥 建筑被摧毁（${this.ctx.buildingDef(d.defId)?.name ?? d.defId}）`);
    });
    bus.on('pawn_died', (ev) => {
      // 成员战死记入附近篝火记忆
      const e = ev as Extract<import('../core/events').GameEvent, { type: 'pawn_died' }>;
      recordNearby(e.x, e.y, `💀 一名成员${e.cause === 'starvation' ? '饿死' : '战死'}`);
    });
  }

  // 记一条篝火记忆（容量上限，超出丢最旧）
  addMemory(key: number, text: string): void {
    const arr = this.ctx.world.fireMemory.get(key) ?? [];
    arr.push({ time: this.ctx.time, text });
    if (arr.length > 30) arr.splice(0, arr.length - 30);
    this.ctx.world.fireMemory.set(key, arr);
  }

  // 篝火区域记忆（供交流读取）：最近 N 条（从新到旧）
  fireHistory(key: number, limit = 5): string[] {
    const arr = this.ctx.world.fireMemory.get(key) ?? [];
    return arr.slice(-limit).reverse().map((m) => m.text);
  }

  // 归属：pawn.fireId = 最近 campfire 建筑 key（无派系实体，走到哪就近属谁）
  assignPawn(eid: number): void {
    const pos = this.ctx.pawnPositions.get(eid);
    if (!pos) return;
    const st = this.ctx.pawnStates.get(eid);
    if (!st) return;
    const key = this.nearestFire(pos.x, pos.y);
    st.fireId = key; // null = 游牧（附近无篝火）
  }

  unassignPawn(eid: number): void {
    const st = this.ctx.pawnStates.get(eid);
    if (st) st.fireId = null;
  }

  // 找 (x,y) 半径内最近的 campfire 建筑主格 key；无则 null
  private nearestFire(x: number, y: number, radius = Infinity): number | null {
    const w = this.ctx.world;
    let best: number | null = null;
    let bestD = Infinity;
    const R2 = radius * radius;
    for (const [key, b] of w.buildings) {
      if (b.def.id !== 'campfire' && !b.def.tags?.includes('anchor')) continue;
      const { x: bx, y: by } = World.keyToXY(key);
      const d = (bx - x) ** 2 + (by - y) ** 2;
      if (d <= R2 && d < bestD) { bestD = d; best = key; }
    }
    return best;
  }

  // 建篝火 → 初始化记忆 + 全员重算归属（无派系实体）
  onCampfireBuilt(key: number): void {
    if (!this.ctx.world.fireMemory.has(key)) {
      this.ctx.world.fireMemory.set(key, [{ time: this.ctx.time, text: '🏕 有人在这里建立了营地' }]);
    }
    for (const eid of this.ctx.iterPawns) this.assignPawn(eid);
  }

  private migrateTimer = 0;
  private reassignTimer = 0;

  private _throttle = 0;
  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < 5) return; // 2026-08-20 节流：篝火记忆更新 5s 一次
    this._throttle = 0;
    // 另起篝火（用户 B 方案：不舒适环境可另起）：低频检查
    this.migrateTimer -= dt;
    if (this.migrateTimer <= 0) {
      this.migrateTimer = this.ctx.tuning.faction.migrateCheckEvery;
      this.migrateIfUncomfortable();
    }
    // 归属持续收敛（曾踩坑：归属只在"建 campfire/出生/迁徙"瞬间算，
    // 小人之后走到新营地旁也不重算 → "人在营地旁却无火"游牧幽灵。
    // 低频全量重算，让靠近营地的个体自然划入最近篝火）
    this.reassignTimer -= dt;
    if (this.reassignTimer <= 0) {
      this.reassignTimer = this.ctx.tuning.faction.reassignInterval;
      for (const eid of this.ctx.iterPawns) this.assignPawn(eid);
    }
  }

  // 另起篝火（B 方案）：某篝火区域"持续不舒适"→ 附近另起新篝火（纯建筑，无单位）
  // 判据（v2026-08-14 三修）：迁徙 = 营地真实"不舒适"，不是"猫路过"。
  //   - 遭袭计数只算"该篝火附近确有建筑被摧毁"（💥 记忆行）
  //   - 猫路过营地不算（可以战斗/逃跑），否则猫群扫过一遍 → 连锁搬家雪崩
  private migrateIfUncomfortable(): void {
    const f = this.ctx.tuning.faction;
    const w = this.ctx.world;
    const hostileNear = (x: number, y: number): boolean => {
      for (const h of this.ctx.hostiles) {
        const dx = h.x - x, dy = h.y - y;
        if (dx * dx + dy * dy <= f.migrateHostileRadius * f.migrateHostileRadius) return true;
      }
      return false;
    };
    // 篝火遭袭计数（跨周期累积）：仅当记忆有 💥 且当前有威胁在场才 +1
    const nearThreat = (key: number): boolean => {
      const { x: bx, y: by } = World.keyToXY(key);
      return this.ctx.hostiles.some((h) => (h.x - bx) ** 2 + (h.y - by) ** 2 <= f.migrateHostileRadius ** 2);
    };
    // raidCount 从记忆动态计算（无实体，不存字段）：
    // 最近记忆里 💥 的条数即"实际损失次数"，达标才迁
    let done = 0;
    for (const [key, b] of [...w.buildings]) {
      if (b.def.id !== 'campfire') continue;
      if (done >= f.migrateMaxPerCheck) break;
      if (!nearThreat(key)) continue; // 当前无威胁不迁
      const mem = w.fireMemory.get(key) ?? [];
      const hurtCount = mem.filter((m) => m.text.includes('💥')).length;
      if (hurtCount < f.migrateRaidThreshold) continue;
      // 找离此篝火最近的一名成员（fireId === key）
      const eid = this.ctx.iterPawns.find((pe) => this.ctx.pawnStates.get(pe)?.fireId === key);
      if (eid === undefined) continue;
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;
      // 起新篝火：远离旧营地（≥migrateMinDist）+ 可建 + 非威胁区
      let placed = false;
      for (let r = 8; r <= 14 && !placed; r++) {
        for (let dy = -r; dy <= r && !placed; dy++) {
          for (let dx = -r; dx <= r && !placed; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const nx = pos.x + dx, ny = pos.y + dy;
            if (!w.inBounds(nx, ny)) continue;
            if (hostileNear(nx, ny)) continue;
            if (!w.canBuildAt(nx, ny)) continue;
            const { x: ox, y: oy } = World.keyToXY(key);
            if (Math.abs(nx - ox) + Math.abs(ny - oy) < f.migrateMinDist) continue;
            if (w.placeBuilding(nx, ny, 'campfire', 'auto')) {
              const nk = w.buildKey(nx, ny);
              this.onCampfireBuilt(nk);
              // 记入旧篝火：迁出
              this.addMemory(key, `🔥 ${hurtCount} 次实际损失后，#${eid} 另起篝火@(${nx},${ny})`);
              this.ctx.logEvent(`🔥 篝火屡遭侵扰（${hurtCount} 次损失），#${eid} 在远处另起篝火@(${nx},${ny})`);
              placed = true;
            }
          }
        }
      }
      if (placed) done++;
    }
  }
}
