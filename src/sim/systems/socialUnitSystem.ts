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
      for (const eid of unit.members) this.membership.delete(eid);
      this.units.delete(unit.id);
      if (this.ctx.playerUnitId === unit.id) this.ctx.playerUnitId = null; // step 尾部 checkPossession 转移视角
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
  //  初始派系成员 → 开局 1s 假团灭附身；margin 保证近距离新营不洗牌、
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
    } else if (oldUnit && !oldUnit.members.includes(eid)) {
      // 未能切换 → 保持原归属（重新挂回，防止重算时被解聘后无归属）
      oldUnit.members.push(eid);
      this.membership.set(eid, oldUnit.id);
    }
  }

  unassignPawn(eid: number): void {
    for (const u of this.units.values()) {
      const i = u.members.indexOf(eid);
      if (i >= 0) u.members.splice(i, 1);
    }
    this.membership.delete(eid);
  }

  update(dt: number): void {
    // 信任：双方单位成员相邻时，看法朝友好漂移（协作凝聚）
    this.trustTimer -= dt;
    if (this.trustTimer > 0) return;
    this.trustTimer = this.ctx.tuning.faction.trustTimer; // 推动周期读 tuning.faction
    this.updateTrust();
    this.unitRelations();
    this.allocateResources(dt);
  }

  // 分派系资源（Q9 利益最大化 + 报告差距"生产走全局"的轻量打通）
  // 玩家单位 = 全局库存镜像（生产全进玩家营地）；野生/其他单位按成员数被动产出
  private allocateResources(dt: number): void {
    const f = this.ctx.tuning.faction;
    const s = this.ctx.stockpile;
    const playerId = this.ctx.playerUnitId;
    for (const u of this.units.values()) {
      if (u.id === playerId) {
        // 玩家单位库存 = 全局库存（单一生产池）
        u.resources = { ...s };
      } else {
        // 其他单位：按成员数被动自给（成员在野外采集微薄资源）
        const members = Math.max(1, u.members.length);
        u.resources.wood = (u.resources.wood ?? 0) + f.resourceGrowthWood * members * dt;
        u.resources.food = (u.resources.food ?? 0) + f.resourceGrowthFood * members * dt;
        u.resources.ore = (u.resources.ore ?? 0) + f.resourceGrowthOre * members * dt;
      }
    }
  }

  // 产出归集（Q9：各单位营地建筑产出归该单位；玩家单位=全局）
  // 在世界坐标附近找最近单位，把产出记入其库存
  addProductionNear(x: number, y: number, item: string, amount: number): void {
    const f = this.ctx.tuning.faction;
    let best: SocialUnit | null = null;
    let bestD = Infinity;
    for (const u of this.units.values()) {
      const ux = u.key % this.ctx.world.width;
      const uy = Math.floor(u.key / this.ctx.world.width);
      const d = (x - ux) ** 2 + (y - uy) ** 2;
      if (d < bestD) { bestD = d; best = u; }
    }
    if (!best) return;
    if (best.id === this.ctx.playerUnitId) {
      // 玩家单位 → 全局生产池
      this.ctx.stockpile[item] = Math.min(f.resourceCap, (this.ctx.stockpile[item] ?? 0) + amount);
    } else {
      best.resources[item] = Math.min(f.resourceCap, (best.resources[item] ?? 0) + amount);
    }
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

    // 玩家单位 = 全局库存（生产池）；贸易时直接操作全局
    const isPlayer = ua.id === this.ctx.playerUnitId;
    const uaFood = isPlayer ? (this.ctx.stockpile.food ?? 0) : (ua.resources.food ?? 0);
    const uaWood = isPlayer ? this.ctx.stockpile.wood : (ua.resources.wood ?? 0);
    const rate = uaFood < f.tradeFoodScarceAt ? f.tradeRateShort : f.tradeRateNormal;
    if (uaWood >= f.tradeWood) {
      if (isPlayer) {
        this.ctx.stockpile.wood = uaWood - f.tradeWood;
        this.ctx.stockpile.food = Math.min(f.resourceCap, (this.ctx.stockpile.food ?? 0) + f.tradeWood * rate);
      } else {
        ua.resources.wood = uaWood - f.tradeWood;
        ua.resources.food = (ua.resources.food ?? 0) + f.tradeWood * rate;
      }
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