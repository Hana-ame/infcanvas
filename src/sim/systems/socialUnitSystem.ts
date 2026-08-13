// 社会单位系统（用户 Q9 + 即时指令）
// 有篝火 = 独立派系。篝火维护部落记忆 + 对其他单位的看法（容量 2-3）。
// 教堂 = 篝火升级（容量 5-10）。派系 = 看法网络涌现。
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import {
  type SocialUnit, nextUnitId, generateUnitName, addMemory, adjustOpinion,
  type UnitLevel,
} from '../core/socialUnit';

export class SocialUnitSystem implements GameSystem {
  id = 'socialUnit';
  units = new Map<string, SocialUnit>();
  // 成员归属：eid → unit id（快速查询）
  membership = new Map<number, string>();
  // 单位间互动节流：渗透率（避免每帧）
  private trustTimer = 0;
  private raidCd = new Map<string, number>();
  private tradeCd = new Map<string, number>();
  private msgCd = new Map<string, number>();

  constructor(private ctx: SimContext) {}

  init(bus: EventBus): void {
    // 核心建筑（篝火/教堂）被摧毁 → 派系解散（防幽灵派系残留：
    // 曾实测狼反复拆篝火 → units 只增不减，16+ 空壳派系挂在世界里）
    bus.on('building_destroyed', (ev) => {
      const d = ev as Extract<import('../core/events').GameEvent, { type: 'building_destroyed' }>;
      const unit = this.unitAtKey(this.ctx.world.buildKey(d.x, d.y));
      if (!unit) return;
      for (const eid of unit.members) {
        this.membership.delete(eid);
        // 成员 fireId 同步清空（曾踩坑：只删 membership 没清 fireId →
        // pawn 显示"有火归属"但单位已删、派系成员 0，形成幽灵归属）
        const st = this.ctx.pawnStates.get(eid);
        if (st) st.fireId = null;
      }
      this.units.delete(unit.id);
      this.ctx.logEvent(`💔 ${unit.name} 的营地被摧毁，派系散落`);
    });
    // 成员死亡 → 记入部落记忆
    bus.on('pawn_died', (ev) => {
      const e = ev as Extract<import('../core/events').GameEvent, { type: 'pawn_died' }>;
      const unitId = this.membership.get(e.eid);
      if (unitId) {
        const u = this.units.get(unitId);
        if (u) addMemory(u, this.ctx.time, `💀 ${u.name} 的一名成员${e.cause === 'starvation' ? '饿死' : '战死'}`);
        this.unassignPawn(e.eid);
      }
    });
    // 区域历史收集（用户 2026-08-13 B 方案：篝火记载这个区域的生活情况/历史事件）：
    // 事件发生时，把事件记入「离事发点最近的篝火」的 memory —— 该篝火成为这片区域的历史载体。
    // 交流篝火情况 = 读这份 history（见 socialSystem.交流篝火情况）。
    const recordNearby = (x: number, y: number, text: string): void => {
      const u = this.unitNearKey(this.ctx.world.buildKey(x, y));
      if (u) addMemory(u, this.ctx.time, text);
    };
    bus.on('raid_started', (ev) => {
      // 狼袭记入营地篝火历史（B 方案：袭击是"敌意"信号，交流时他人听到 → 推断 enemy）
      const d = ev as Extract<import('../core/events').GameEvent, { type: 'raid_started' }>;
      recordNearby(this.ctx.world.width / 2, this.ctx.world.height / 2, `🐺 营地遭到袭击（${d.count} 只野狼）`);
    });
    bus.on('building_built', (ev) => {
      const d = ev as Extract<import('../core/events').GameEvent, { type: 'building_built' }>;
      recordNearby(d.x, d.y, `🏗 建起了建筑（${this.ctx.buildingDef(d.defId)?.name ?? d.defId}）`);
    });
    bus.on('building_destroyed', (ev) => {
      // 建筑被毁记入篝火历史（敌意信号）
      const d = ev as Extract<import('../core/events').GameEvent, { type: 'building_destroyed' }>;
      recordNearby(d.x, d.y, `💥 建筑被摧毁（${this.ctx.buildingDef(d.defId)?.name ?? d.defId}）`);
    });
    bus.on('faction_event', (ev) => {
      const d = ev as Extract<import('../core/events').GameEvent, { type: 'faction_event' }>;
      if (d.kind === 'war') recordNearby(this.ctx.world.width / 2, this.ctx.world.height / 2, `⚔ ${d.from ?? ''} 与 ${d.to ?? ''} 交战`);
    });
  }

  // 篝火区域历史（供交流读取）：最近 N 条（从新到旧）
  fireHistory(fireId: string, limit = 5): string[] {
    const u = this.units.get(fireId);
    if (!u) return [];
    return u.memory.slice(-limit).reverse().map((m) => m.text);
  }

  // 建篝火/教堂 → 创建或升级单位。level 由 defId 的标签决定
  onBuildingBuilt(key: number, defId: string, now: number): void {
    const def = this.ctx.world.buildings.get(key)?.def ?? { tags: [] as string[] };
    // 教堂优先（教堂也带 anchor 标签，但应升级而非新建）
    if (def.tags?.includes('faith') || def.tags?.includes('oracle')) {
      // 附近有篝火单位 → 升级它；否则新建教堂单位
      const near = this.unitNear(key);
      if (near) {
        near.key = key;
        this.upgradeUnit(near.id, now);
      } else {
        this.createUnit(key, 'church', now);
      }
    } else if (def.tags?.includes('anchor')) {
      this.createUnit(key, 'campfire', now);
      // 迁徙闭环：新营地建成 → 小人们重新归属最近单位
      //（建成处附近的拓荒者自然划入新派系；远方的旧营地成员不受影响）
      for (const eid of this.ctx.pawnList) this.assignPawn(eid);
    }
  }

  unitAtKey(key: number): SocialUnit | null {
    for (const u of this.units.values()) {
      if (u.key === key) return u;
    }
    return null;
  }

  private unitNear(key: number): SocialUnit | null {    const w = this.ctx.world;
    const x = key % w.width;
    const y = Math.floor(key / w.width);
    for (const u of this.units.values()) {
      const ux = u.key % w.width;
      const uy = Math.floor(u.key / w.width);
      if (Math.abs(ux - x) <= this.ctx.tuning.faction.upgradeNearDist && Math.abs(uy - y) <= this.ctx.tuning.faction.upgradeNearDist) return u;
    }
    return null;
  }

  // 按 key 找最近的篝火（区域历史记入用；无精确匹配时取范围内最近）
  private unitNearKey(key: number): SocialUnit | null {
    const w = this.ctx.world;
    const x = key % w.width;
    const y = Math.floor(key / w.width);
    let best: SocialUnit | null = null;
    let bestD = Infinity;
    for (const u of this.units.values()) {
      const ux = u.key % w.width;
      const uy = Math.floor(u.key / w.width);
      const d = (ux - x) ** 2 + (uy - y) ** 2;
      if (d < bestD) { bestD = d; best = u; }
    }
    // 仅限"近距离"（同 chunk 级）：太远的事件不该记到别的篝火
    const radius = this.ctx.tuning.faction.upgradeNearDist;
    if (best && bestD <= radius * radius) return best;
    return null;
  }

  createUnit(key: number, level: UnitLevel, now: number): SocialUnit {
    const existing = this.unitAtKey(key);
    if (existing) return existing;
    const unit: SocialUnit = {
      id: nextUnitId(),
      key,
      level,
      name: generateUnitName(this.ctx.rng, {
        prefixes: this.ctx.tuning?.faction?.namePrefixes ?? [],
        suffixes: this.ctx.tuning?.faction?.nameSuffixes ?? [],
      }),
      members: [],
      memory: [],
      opinions: new Map(),
      createdAt: now,
      resources: { ...this.ctx.tuning.faction.unitStartResources }, // 派系初始库存（Q9，数据在 tuning.faction）
      tradeBalance: new Map(),
      raidCount: 0,
    };
    this.units.set(unit.id, unit);
    addMemory(unit, now, `🏕 ${unit.name} 建立营地`);
    return unit;
  }

  upgradeUnit(id: string, now: number): void {
    const u = this.units.get(id);
    if (!u) return;
    const was = u.level;
    u.level = 'church';
    addMemory(u, now, `⛪ ${u.name} 从${was === 'campfire' ? '篝火' : '营地'}升级为教堂，影响范围扩大`);
  }

  // 成员归属
  // 成员归属：pawn 归入最近单位
  // 门槛：新归属距离必须比旧归属**明显更近**（距差 > reassignMargin 格）才切换
  //（曾踩坑：出生 4 人触发行 autobuild 第二个篝火建在出生圈内 → 重算全量划走
  //  初始派系成员 → 开局 1s 归属洗牌；margin 保证近距离新营不洗牌、
  //  只有远走迁徙者（距新营地显著更近）才改归属）
  assignPawn(eid: number, margin?: number): void {
    const pos = this.ctx.pawnPositions.get(eid);
    if (!pos) return;
    const m = margin ?? this.ctx.tuning.faction?.unitReassignMargin ?? 4;
    // 先解除旧归属（迁徙/重算时保持单一派系，避免成员同时挂在两个单位）
    const oldId = this.membership.get(eid);
    const oldUnit = oldId ? this.units.get(oldId) : null;
    const oldD = oldUnit
      ? (pos.x - (oldUnit.key % this.ctx.world.width)) ** 2 + (pos.y - Math.floor(oldUnit.key / this.ctx.world.width)) ** 2
      : Infinity;
    this.unassignPawn(eid);
    let best: SocialUnit | null = null;
    let bestD = Infinity;
    for (const u of this.units.values()) {
      const x = u.key % this.ctx.world.width;
      const y = Math.floor(u.key / this.ctx.world.width);
      const d = (pos.x - x) ** 2 + (pos.y - y) ** 2;
      if (d < bestD) { bestD = d; best = u; }
    }
    // 门槛判定：最近单位必须是"明显更近"（旧距离 - 新距离 ≥ margin 格²的平方根阈值）
    if (best && bestD + m * m <= oldD) {
      if (!best.members.includes(eid)) best.members.push(eid);
      this.membership.set(eid, best.id);
      // 个体持有篝火（用户 2026-08-13 B 方案：pawn.fireId = 我所属的篝火）
      const st = this.ctx.pawnStates.get(eid);
      if (st) st.fireId = best.id;
    } else if (oldUnit && !oldUnit.members.includes(eid)) {
      // 未能切换 → 保持原归属（重新挂回，防止重算时被解聘后无归属）
      oldUnit.members.push(eid);
      this.membership.set(eid, oldUnit.id);
      const st = this.ctx.pawnStates.get(eid);
      if (st) st.fireId = oldUnit.id;
    }
  }

  unassignPawn(eid: number): void {
    for (const u of this.units.values()) {
      const i = u.members.indexOf(eid);
      if (i >= 0) u.members.splice(i, 1);
    }
    this.membership.delete(eid);
    const st = this.ctx.pawnStates.get(eid);
    if (st) st.fireId = null; // 脱离篝火（B 方案：个体不再持有任何篝火）
  }

  private migrateTimer = 0;
  private reassignTimer = 0;

  update(dt: number): void {
    // 另起篝火（用户 2026-08-13 B 方案：不舒适环境可另起）：低频检查
    this.migrateTimer -= dt;
    if (this.migrateTimer <= 0) {
      this.migrateTimer = this.ctx.tuning.faction.migrateCheckEvery;
      this.migrateIfUncomfortable();
    }
    // 归属持续收敛（曾踩坑：归属只在"建 campfire/出生/迁徙"瞬间算，
    // 小人之后走到新营地旁也不重算 → 大量"人在营地旁却无火"的游牧幽灵。
    // 低频全量重算，让靠近营地的个体自然划入最近单位）
    this.reassignTimer -= dt;
    if (this.reassignTimer <= 0) {
      this.reassignTimer = this.ctx.tuning.faction.reassignInterval;
      for (const eid of this.ctx.pawnList) this.assignPawn(eid);
    }
    // 信任：双方单位成员相邻时，看法朝友好漂移（协作凝聚）
    this.trustTimer -= dt;
    if (this.trustTimer > 0) return;
    this.trustTimer = this.ctx.tuning.faction.trustTimer; // 推动周期读 tuning.faction
    this.updateTrust();
    this.unitRelations();
    this.allocateResources(dt);
  }

  // 另起篝火（B 方案）：某篝火区域"持续不舒适"→ 成员迁出另起新篝火
  // 机制（v2026-08-14 收紧，防连锁崩盘）：
  //   - 判不适 = 该篝火 raidCount 达到阈值（连续多波袭击落在营地附近），单次遇敌不算（是战斗）
  //   - 每检查周期最多迁 1 人；起新篝火找"远离当前威胁方向 + 可建"的落点
  // 曾踩坑（首次实现）：仅凭"敌人离小人近"就迁徙 → 狼群驱散整个文明，
  //   12 次另起篝火产生 15 个空壳派系连锁分裂。改为按篝火遭袭计数判定。
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
    // 迁移判据（v2026-08-14 三修）：迁徙 = 营地真实"不舒适"，不是"狼路过"。
    //   - 遭袭计数只算"该篝火附近确有建筑被摧毁"（building_destroyed 已记入 memory 的 💥 行）
    //   - 狼路过营地不算（可以战斗/逃跑），否则狼群扫过一遍 → raidCount 疯涨 → 连锁搬家雪崩
    //     曾实测：90 分钟"另起篝火"40 次、41 个单位 34 个空壳，全部由"狼路过也迁"造成。
    const R2 = f.migrateHostileRadius * f.migrateHostileRadius;
    const nearThreat = (u: { key: number }): boolean => {
      const ux = u.key % w.width;
      const uy = Math.floor(u.key / w.width);
      return this.ctx.hostiles.some((h) => (h.x - ux) ** 2 + (h.y - uy) ** 2 <= R2);
    };
    for (const u of this.units.values()) {
      // 真实遭袭 = 篝火历史里有"💥 建筑被摧毁"记录，且当前仍有威胁在场
      const gotHurt = u.memory.some((m) => m.text.includes('💥'));
      const underThreat = nearThreat(u);
      if (gotHurt && underThreat) u.raidCount = (u.raidCount ?? 0) + 1;
      else if (!gotHurt) u.raidCount = 0; // 无真实损失 → 清零（不累积"狼路过"）
    }
    // 迁移：raidCount 达标 + 有成员 + 本周期未满额 → 该篝火最"被威胁"的一名成员迁出
    let done = 0;
    for (const u of [...this.units.values()]) {
      if (done >= f.migrateMaxPerCheck) break;
      if ((u.raidCount ?? 0) < f.migrateRaidThreshold) continue;
      if (u.members.length === 0) continue;
      const eid = u.members[0];
      const st = this.ctx.pawnStates.get(eid);
      const pos = this.ctx.pawnPositions.get(eid);
      if (!st || !pos) continue;
      // 起新篝火：远离旧营地（≥migrateMinDist）+ 可建 + 非威胁区。曾踩坑：落点 4-8 格太近，
      // 新营地仍在狼威胁半径内 → 继续遭袭 → 连锁再迁（雪崩）。必须真正"另起炉灶"。
      let placed = false;
      const oldKey = u.key;
      for (let r = 8; r <= 14 && !placed; r++) {
        for (let dy = -r; dy <= r && !placed; dy++) {
          for (let dx = -r; dx <= r && !placed; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const nx = pos.x + dx, ny = pos.y + dy;
            if (!w.inBounds(nx, ny)) continue;
            if (hostileNear(nx, ny)) continue; // 落点必须远离威胁
            if (!w.canBuildAt(nx, ny)) continue;
            const nk = w.buildKey(nx, ny);
            if (Math.abs(nk % w.width - oldKey % w.width) + Math.abs(Math.floor(nk / w.width) - Math.floor(oldKey / w.width)) < f.migrateMinDist) continue;
            if (w.placeBuilding(nx, ny, 'campfire', 'auto')) {
              const key = w.buildKey(nx, ny);
              this.createUnit(key, 'campfire', this.ctx.time);
              this.ctx.logEvent(`🔥 ${u.name} 屡遭侵扰（${u.raidCount ?? 0} 次实际损失），#${eid} 另起篝火@(${nx},${ny})`);
              u.raidCount = 0; // 已行动，重置
              // 迁徙闭环（复用 onBuildingBuilt 的重新归属）：新篝火近者划入
              for (const pe of this.ctx.pawnList) this.assignPawn(pe);
              placed = true;
            }
          }
        }
      }
      if (placed) done++;
    }
  }

  // 分派系资源（Q9 利益最大化 + 报告差距"生产走全局"的轻量打通）
  // 所有单位按成员数被动产出（2026-08-13 架构裁决：玩家不是派系单位）
  private allocateResources(dt: number): void {
    const f = this.ctx.tuning.faction;
    const s = this.ctx.stockpile;
    // 所有单位一视同仁：按成员数被动自给（成员在野外采集微薄资源）
    // （2026-08-13 架构裁决：玩家不是派系单位——全局仓库 stockpile 即玩家资源池，不需要"玩家单位=全局镜像"）
    for (const u of this.units.values()) {
      const members = Math.max(1, u.members.length);
      u.resources.wood = (u.resources.wood ?? 0) + f.resourceGrowthWood * members * dt;
      u.resources.food = (u.resources.food ?? 0) + f.resourceGrowthFood * members * dt;
      u.resources.ore = (u.resources.ore ?? 0) + f.resourceGrowthOre * members * dt;
    }
  }

  // 产出归集（Q9：各单位营地建筑产出归该单位；faction='player' 建筑直接进全局）
  // 在世界坐标附近找最近单位，把产出记入其库存
  // 产出归集（Q9 + 全局生产池）：
  // 建筑 faction='player'（玩家/探索/神谕蓝图建成）→ 产出直接进全局生产池；
  // 否则（野营 auto 建筑）→ 归最近单位——曾踩坑：well 被野营 campfire 抢归集，
  // 玩家水井产水全进野营库存（全局 water 恒 0）
  addProductionNear(x: number, y: number, item: string, amount: number, faction?: string): void {
    const f = this.ctx.tuning.faction;
    if (faction === 'player') {
      this.ctx.stockpile[item] = Math.min(f.resourceCap, (this.ctx.stockpile[item] ?? 0) + amount);
      return;
    }
    let best: SocialUnit | null = null;
    let bestD = Infinity;
    for (const u of this.units.values()) {
      const ux = u.key % this.ctx.world.width;
      const uy = Math.floor(u.key / this.ctx.world.width);
      const d = (x - ux) ** 2 + (y - uy) ** 2;
      if (d < bestD) { bestD = d; best = u; }
    }
    if (!best) return;
    // 归最近单位库存（非玩家建筑：auto 野营产出归该单位）
    // （2026-08-13 架构裁决：无"玩家单位"概念——faction='player' 的建筑已在上面直接进全局仓库）
    best.resources[item] = Math.min(f.resourceCap, (best.resources[item] ?? 0) + amount);
  }

  // 单位间关系效应（Q9：篝火间信任机制 → 贸易/战争）
  // 双向敌对(≤-40)：派掠夺者袭击对方营地；双向友好(≥40)：贸易交换资源
  // 逆差联动：某单位对另一单位持续大逆差(≤-20) → 心生怨恨，好感下滑 → 可能破裂开战
  private unitRelations(): void {
    const f = this.ctx.tuning.faction;
    const ids = [...this.units.keys()];
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const ua = this.units.get(a);
      if (!ua) continue;
      for (let j = i + 1; j < ids.length; j++) {
        const b = ids[j];
        const ub = this.units.get(b);
        if (!ub) continue;
        const ab = ua.opinions.get(b)?.value ?? 0;
        const ba = ub.opinions.get(a)?.value ?? 0;
        // 逆差 → 怨恨：欠债方（逆差≤-20）对债主好感下滑，债主也不满
        const balA = ua.tradeBalance.get(b) ?? 0;
        const balB = ub.tradeBalance.get(a) ?? 0;
        if (balA <= f.deficitAt) adjustOpinion(ua, b, f.opinionDeficit, this.ctx.time); // 欠得多 → 怨恨债主
        if (balB <= f.deficitAt) adjustOpinion(ub, a, f.opinionDeficit, this.ctx.time);
        // 双向敌对 → 袭击（利益冲突升级为战争，Q9）
        if (ab <= f.warAt && ba <= f.warAt) {
          this.raidBetween(ua, ub);
        }
        // 双向友好 → 贸易（友好派系互惠）
        else if (ab >= f.tradeAt && ba >= f.tradeAt) {
          this.tradeBetween(ua, ub);
        }
        // 关系中性 → 传话（Q9：派系间没有直接控制权，只有传话）
        else {
          this.messaging(ua, ub, ab, ba);
        }
      }
    }
  }

  // 袭击：从 a 营地派掠夺者去打 b 营地
  private raidBetween(ua: SocialUnit, ub: SocialUnit): void {
    const f = this.ctx.tuning.faction;
    const cd = this.raidCd.get(ua.id) ?? 0;
    if (this.ctx.time < cd) return;
    this.raidCd.set(ua.id, this.ctx.time + f.raidCooldown);
    const bx = ub.key % this.ctx.world.width;
    const by = Math.floor(ub.key / this.ctx.world.width);
    const ax = ua.key % this.ctx.world.width;
    const ay = Math.floor(ua.key / this.ctx.world.width);
    const count = f.unitRaidCountMin + Math.floor(this.ctx.rng.next() * (f.unitRaidCountMax - f.unitRaidCountMin + 1));
    // 掠夺者数值走 enemies 表（tuning.combat.unitRaidEnemy → def；mod 可 overrideDef('enemy') 调强度/掉落）
    const enemy = this.ctx.mods.enemyDef(this.ctx.tuning.combat.unitRaidEnemy);
    for (let k = 0; k < count; k++) {
      this.ctx.hostiles.push({
        x: ax, y: ay, hp: enemy.hp, maxHp: enemy.hp,
        targetX: bx, targetY: by,
        name: enemy.name, enemyId: enemy.id, faction: enemy.faction,
        speed: enemy.speed, dmgPerSec: enemy.dmg, loot: enemy.loot,
      });
    }
    this.ctx.logEvent(`⚔ ${ua.name} 派兵攻打 ${ub.name}！`);
    this.ctx.bus.emit({ type: 'faction_event', kind: 'raid', from: ua.name, to: ub.name });
    addMemory(ua, this.ctx.time, `⚔ 出兵攻打 ${ub.name}`);
    addMemory(ub, this.ctx.time, `⚔ 遭到 ${ua.name} 攻打`);
    // 战争加深仇恨
    adjustOpinion(ua, ub.id, f.opinionRaid, this.ctx.time);
    adjustOpinion(ub, ua.id, f.opinionRaid, this.ctx.time);
  }

  // 传话（Q9：派系间不直接控制，只有传话等事件）
  // 中性关系时：传话带信息，态度倾向决定方向（友善→关系更近，敌意→更疏）
  private messaging(ua: SocialUnit, ub: SocialUnit, ab: number, ba: number): void {
    const f = this.ctx.tuning.faction;
    const cd = this.msgCd.get(ua.id) ?? 0;
    if (this.ctx.time < cd) return;
    this.msgCd.set(ua.id, this.ctx.time + f.msgCooldown);
    const sum = ab + ba;
    if (sum >= 0) {
      adjustOpinion(ua, ub.id, f.opinionMsgFriendly, this.ctx.time);
      adjustOpinion(ub, ua.id, f.opinionMsgFriendly, this.ctx.time);
      this.ctx.logEvent(`💬 ${ua.name} 传话给 ${ub.name}："听闻贵部族兴起，愿结善缘"`);
      this.ctx.bus.emit({ type: 'faction_event', kind: 'message', from: ua.name, to: ub.name });
      addMemory(ua, this.ctx.time, `💬 向 ${ub.name} 传友善的话`);
    } else {
      adjustOpinion(ua, ub.id, f.opinionThreat, this.ctx.time);
      adjustOpinion(ub, ua.id, f.opinionThreat, this.ctx.time);
      this.ctx.logEvent(`📣 ${ua.name} 传话给 ${ub.name}："退让，否则刀兵相见"`);
      this.ctx.bus.emit({ type: 'faction_event', kind: 'threat', from: ua.name, to: ub.name });
      addMemory(ub, this.ctx.time, `📣 收到 ${ua.name} 的威胁`);
    }
  }

  // 贸易（Q9）：友好派系按汇率交换资源；汇率随供需波动（稀缺方付出更多）
  // 逆差追踪：长期逆差 → 关系破裂 → 战争
  private tradeBetween(ua: SocialUnit, ub: SocialUnit): void {
    const f = this.ctx.tuning.faction;
    const cd = this.tradeCd.get(ua.id) ?? 0;
    if (this.ctx.time < cd) return;
    this.tradeCd.set(ua.id, this.ctx.time + f.tradeCooldown);

    // 派系间贸易（玩家不参与——玩家是神谕，只有卡片/指令，无派系身份；2026-08-13 架构裁决）
    const uaFood = ua.resources.food ?? 0;
    const uaWood = ua.resources.wood ?? 0;
    const rate = uaFood < f.tradeFoodScarceAt ? f.tradeRateShort : f.tradeRateNormal;
    if (uaWood >= f.tradeWood) {
      ua.resources.wood = uaWood - f.tradeWood;
      ua.resources.food = (ua.resources.food ?? 0) + f.tradeWood * rate;
      // 记账逆差：a 付出木、得到食 → 对 b 顺差（b 逆差）
      const balA = (ua.tradeBalance.get(ub.id) ?? 0);
      const balB = (ub.tradeBalance.get(ua.id) ?? 0);
      ua.tradeBalance.set(ub.id, balA + f.tradeWood);
      ub.tradeBalance.set(ua.id, balB - f.tradeWood);
      this.ctx.logEvent(`🤝 ${ua.name} 与 ${ub.name} 交易（汇率 1木=${rate}食）`);
      this.ctx.bus.emit({ type: 'faction_event', kind: 'trade', from: ua.name, to: ub.name });
      addMemory(ua, this.ctx.time, `🤝 与 ${ub.name} 交易（${rate}食/木）`);
      addMemory(ub, this.ctx.time, `🤝 与 ${ua.name} 交易`);
      // 贸易增进好感，但持续逆差方心生不满
      adjustOpinion(ua, ub.id, f.opinionTrade, this.ctx.time);
      adjustOpinion(ub, ua.id, f.opinionTradeRecipient, this.ctx.time);
    }
  }

  private updateTrust(): void {
    // 不同单位成员相遇到一起工作 → 双向看法正向 → 派系凝聚
    const f = this.ctx.tuning.faction;
    const list = this.ctx.pawnList;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const uaId = this.membership.get(a);
      if (!uaId) continue;
      const posA = this.ctx.pawnPositions.get(a);
      if (!posA) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const ubId = this.membership.get(b);
        if (!ubId || ubId === uaId) continue;
        const posB = this.ctx.pawnPositions.get(b);
        if (!posB) continue;
        if (Math.hypot(posA.x - posB.x, posA.y - posB.y) > f.trustMeetDist) continue;
        // 两单位成员协作 → 双向看法增进（信任机制 → 派系涌现）
        adjustOpinion(this.units.get(uaId)!, ubId, f.opinionFriendly, this.ctx.time);
        adjustOpinion(this.units.get(ubId)!, uaId, f.opinionFriendly, this.ctx.time);
      }
    }
  }
}