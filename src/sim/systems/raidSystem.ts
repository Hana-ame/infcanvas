// 袭击 + 战斗系统：刷野猫群 → 移动 → 接敌 → 战死掉落（天敌=野猫，2026-08-14 世界观修正）
// 数据驱动：数值全读 tuning.combat（mod 可覆盖）；叙事压力（DESIGN §6）：和平越久袭击越猛
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import { World } from '../core/world';
import { buildTagIndex, findNearestTagged } from './building-cache';
import type { EnemyDef } from '../defs/enemies';
import { K_ATTACK, K_DRAFTED } from '../mods/contracts'; // RW-1 征召指定攻击（drafting 包契约键）+ 征召判定（战斗平衡 2026-08-20）
import { pushHostile } from './hostiles'; // 敌人生成共享入口（审计 L6）

// 敌袭系统：敌人移动（nearestBuilding 拆家）+ 战斗结算（攻击/受伤/死亡/征服吞并）
export class RaidSystem implements GameSystem {
  id = 'raid';
  private _bldVer = -1;
  private tagIndex: Map<string, import('./building-cache').CachedBuilding[]> = new Map();
  private raidTimer: number;
  private peaceTime = 0; // 距上次袭击的和平时长（叙事压力，DESIGN §6）
  private baseInterval: number; // 基线袭击间隔（秒）
  // 2026-08-20 万人战争优化：敌人分批处理
  private _hostileBatchIdx = 0;
  private _hostileStart = 0;
  private _hostileEnd = 999999;
  private _gridTick = 0;

  constructor(private ctx: SimContext) {
    this.baseInterval = ctx.tuning.combat.baseInterval;
    this.raidTimer = ctx.tuning.combat.initialRaidDelay;
  }

  init(_bus: EventBus): void {}

  update(dt: number): void {
    // 2026-08-20 万人战争优化：敌人 > 500 时分批处理
    const HOSTILE_BATCH = Math.max(500, Math.floor(this.ctx.hostiles.length / 20)); // 2026-08-20: 动态 batch（n/20，最少 500）
    const useBatch = this.ctx.hostiles.length > HOSTILE_BATCH;
    if (useBatch) {
      this._hostileStart = this._hostileBatchIdx;
      this._hostileEnd = Math.min(this._hostileStart + HOSTILE_BATCH, this.ctx.hostiles.length);
      this._hostileBatchIdx += HOSTILE_BATCH;
      if (this._hostileBatchIdx >= this.ctx.hostiles.length) this._hostileBatchIdx = 0;
    } else {
      this._hostileStart = 0;
      this._hostileEnd = this.ctx.hostiles.length;
    }
    this.updateRaids(dt);
    this.updateCombat(dt);
  }

  // 叙事压力（DESIGN §6）：和平越久 → 战斗压力越高
  // 压力 = 超出基线的和平时长比例，缩短间隔 + 放大袭击
  private narrativePressure(): number {
    const t = this.ctx.tuning.combat;
    return Math.min(t.pressureCap, 1 + this.peaceTime / (this.baseInterval * t.pressureScale));
  }

  private updateRaids(dt: number): void {
    if (this.ctx.pawnList.length === 0) return;
    const t = this.ctx.tuning.combat;
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
        const count = Math.floor((t.raidCountBase + this.ctx.pawnList.length * t.raidCountPerPawn) * pressure);
        const spawned = this.spawnRaid(count, pressure); // 捕食者独行:实际生成数可能被压成 1
        this.peaceTime = 0;
        this.ctx.bus.emit({ type: 'raid_started', count: spawned });
        this.ctx.logEvent(`⚠ ${spawned === 1 && this.ctx.mods.enemyDef().predator ? '🐱 野猫（哈基米）来袭！1 只' : `野猫来袭！${spawned} 只`}${pressure > 1.3 ? '（积怨已久，更凶猛）' : ''}`);
      }
    }
  }

  // 刷一波袭击：从地图边缘随机边出生，直奔营地；规模随人口与叙事压力放大。
  // 捕食者（哈基米 2026-08-20）：独行——固定 1 只,压力只放大强度不放大数量
  private spawnRaid(count: number, pressure = 1): number {
    const w = this.ctx.world;
    // 敌人数值走 enemies 表（mods.enemyDef()，mod 可 overrideDef 调强度/掉落）
    const enemy = this.ctx.mods.enemyDef();
    if (enemy.predator) count = 1; // 哈基米独行:压力只放大强度不放大数量
    const edge = Math.floor(this.ctx.rng.next() * 4);
    const cx = Math.floor(w.width / 2);
    const cy = Math.floor(w.height / 2);
    for (let i = 0; i < count; i++) {
      let x: number, y: number;
      if (edge === 0) { x = this.ctx.rng.int(0, w.width - 1); y = 0; }
      else if (edge === 1) { x = this.ctx.rng.int(0, w.width - 1); y = w.height - 1; }
      else if (edge === 2) { x = 0; y = this.ctx.rng.int(0, w.height - 1); }
      else { x = w.width - 1; y = this.ctx.rng.int(0, w.height - 1); }
      pushHostile(this.ctx, enemy, x, y, { targetX: cx, targetY: cy, hpMul: pressure });
    }
    return count;
  }

  private updateCombat(dt: number): void {
    if (this.ctx.hostiles.length === 0) return;
    const t = this.ctx.tuning.combat;
    const cx = Math.floor(this.ctx.world.width / 2);
    const cy = Math.floor(this.ctx.world.height / 2);
    // ---- 移动阶段 ----
    const allH = this.ctx.hostiles;
    for (let hi = this._hostileStart; hi < this._hostileEnd && hi < allH.length; hi++) {
      const h = allH[hi];
      // 玩家阵营守卫（beast-taming 驯服猫）不参与敌对移动/袭击——由驯兽系统驱动跟随/扑咬
      if (h.faction === 'player') continue;
      // 2026-08-20 十万级优化：附近无鼠 → 只移动不战斗（跳过昂贵的 nearestPawn 搜索）
      const hcx = Math.floor(h.x / this.cellSize);
      const hcy = Math.floor(h.y / this.cellSize);
      let hasNearbyPawn = false;
      for (let dx = -1; dx <= 1 && !hasNearbyPawn; dx++) for (let dy = -1; dy <= 1 && !hasNearbyPawn; dy++) {
        if (this.pawnGrid.get((hcx + dx) * 100000 + (hcy + dy))) hasNearbyPawn = true;
      }
      const pred = this.predatorOf(h);
      let tx = h.targetX, ty = h.targetY;
      let spd = h.speed ?? t.catSpeed;
      if (pred?.predator) {
        if (h.taming) {
          // 驯化中臣服趴伏：不追鼠、不逃、原地不动（驯兽 DLC）
          tx = h.x; ty = h.y; spd = 0;
        } else if (h.carried) {
          // 叼走鼠 → 直冲逃跑方向（捕获时定下的单位向量 × 足够远），速度 ×carrySpeedMul
          tx = h.x + h.carried.dirX * 100000;
          ty = h.y + h.carried.dirY * 100000;
          spd = (h.speed ?? t.catSpeed) * (pred.carrySpeedMul ?? 1.5);
        } else {
          // 独行捕猎：目标 = 最近鼠的实时位置（目的清晰 = 叼鼠,不再是"奔营地中心"）
          const prey = this.nearestPawnTo(h.x, h.y);
          if (prey) { tx = prey.x; ty = prey.y; }
        }
      }
      // 冲刺技能（2026-08-20：猫的跳跃/冲刺——周期性向目标方向瞬间位移一段距离，
      // 越过 meleeRange(3) 近身反击圈突围；dashCd 运行时递减，归零时触发一次瞬移）
      if (pred?.predator && pred.dash && !h.taming) {
        h.dashCd = (h.dashCd ?? 0) - dt;
        if (h.dashCd <= 0) {
          h.dashCd = pred.dash.cd;
          // 向目标方向瞬移 dash.range 格（若目标在 dash 范围内则直接贴脸）
          const ddx = tx - h.x, ddy = ty - h.y;
          const dd = Math.hypot(ddx, ddy);
          if (dd > 0.1) {
            const dashStep = Math.min(pred.dash.range, dd);
            h.x += (ddx / dd) * dashStep;
            h.y += (ddy / dd) * dashStep;
            this.ctx.logEvent(`⚡ ${h.name ?? '野猫'} 发动冲刺！越过近身反击圈`);
          }
        }
      }
      const dx = tx - h.x, dy = ty - h.y;
      const d = Math.hypot(dx, dy);
      const step = spd * dt;
      if (d > step) {
        h.x += (dx / d) * step;
        h.y += (dy / d) * step;
      }
    }
    // ---- 接敌 / 捕获 / 得手结算（从后往前 splice 安全）----
    // 2026-08-20 万人战争优化：死亡清理每 5 tick 一次（大量敌人时 splice 开销大）
    if (this.ctx.hostiles.length > 1000 && this._gridTick % (this.ctx.hostiles.length > 10000 ? 10 : 5) !== 0) {
      // 跳过死亡清理（下一轮再清）
    } else
    for (let i = this.ctx.hostiles.length - 1; i >= 0; i--) {
      const h = this.ctx.hostiles[i];
      if (h.faction === 'player') continue; // 守卫不结算敌对行为（驯兽系统驱动）
      const pred = this.predatorOf(h);
      if (pred?.predator) {
        if (h.taming) {
          // 驯化中臣服假死：不捕猎、不叼人、不被近身反击（玩家营地自动武器不打臣服者；
          // 想反悔 → release/等驯化完成，设计意图见 beast-taming 包头部注释）
          continue;
        }
        if (h.carried) {
          // 得手判定：跑离营地中心 ≥ captureFleeDist → 消失（叼走的鼠 = 损失,不回场）
          if (Math.hypot(h.x - cx, h.y - cy) >= t.captureFleeDist) {
            this.ctx.hostiles.splice(i, 1);
            this.ctx.logEvent('🐱 野猫叼着鼠逃远了……');
            continue;
          }
          // 逃跑途中仍可被击杀：掉落共用同一路径（击杀者口袋私有）——鼠已算 lost,无复活机制
          h.hp -= t.pawnDmg * dt;
          if (h.hp <= 0) {
            const killer = this.nearestPawnInRange(h, 8) ?? -1; // 最近反击者(无则全局掉落)
            this.killHostile(killer, i, h.loot ?? { item: t.catLootItem, amount: t.catLootAmount });
            this.ctx.logEvent('⚔ 野猫（叼着鼠）被击杀！');
          }
          continue;
        }
        // 近身反击：捕猎期有鼠在 meleeRange 可砍猫（十万级优化：nearestPawnInRange 已用空间哈希，O(cell内) 非常快）（自动近身反击防御，非玩家操作）；
        // 2026-08-20 战斗平衡：自动近身反击对捕食者伤害 ×predatorReactionMul(0.25)——
        // 征召鼠（K_DRAFTED，玩家命令优先接战）全伤。动机：90hp 捕食者此前被自动反击
        // 几秒消灭，战场指挥（征召/冲锋）与驯化（重伤窗口）没有存在意义；0.25 让自动
        // 防御只拖不杀，玩家须征召/指挥才能高效击杀或把猫压到重伤驯化。
        // 反击结算在捕获判定前：猫被砍死 → 掉落 + 不叼人（含"砍死猎人"的合理反制，2026-08-20）
        const defender = this.nearestPawnInRange(h, t.meleeRange);
        if (defender !== null) {
          const drafted = this.ctx.pawnStates.get(defender)?.extra?.[K_DRAFTED] === true;
          h.hp -= t.pawnDmg * (drafted ? 1 : t.predatorReactionMul) * dt;
          if (h.hp <= 0) {
            this.killHostile(defender, i, h.loot ?? { item: t.catLootItem, amount: t.catLootAmount });
            this.ctx.logEvent('⚔ 野猫（哈基米）被近身反击砍死！');
            continue;
          }
        }
        // 捕猎：接触 ≤ captureRange 的最近鼠 → 叼走（复用现有 DEX 闪避判定,不新造机制）
        const prey = this.nearestPawnInRange(h, t.captureRange);
        if (prey !== null) {
          const dna = this.ctx.dnaOf(prey);
          const dodgeChance = dna ? Math.max(t.minDodge, (dna.dex - t.dodgeBase) * t.dodgePerPoint) : 0;
          const dodge = dna && this.ctx.rng.next() < dodgeChance;
          if (!dodge) {
            const pos = this.ctx.readPosition(prey);
            this.ctx.bus.emit({ type: 'pawn_died', eid: prey, x: pos?.x ?? 0, y: pos?.y ?? 0, cause: 'captured' });
            this.ctx.killPawn(prey);
            // 逃跑方向 = 从营地中心指向猫（远离营地）
            const dx = h.x - cx, dy = h.y - cy;
            const dl = Math.hypot(dx, dy) || 1;
            h.carried = { eid: prey, dirX: dx / dl, dirY: dy / dl };
            this.ctx.logEvent('🐱 野猫叼起鼠鼠就跑！');
          }
        }
        continue; // 捕食者不拆家、不原地磨血——目的只有一个：叼鼠
      }
      // ---- 非捕食者（掠夺者等）：原袭击逻辑（索敌 / 拆家 / DPS 对耗）----
      // RW-1 征召指定攻击（2026-08-15，drafting 玩法包 K_ATTACK 契约键）：
      // 被征召小人显式指定攻击的目标 → 由指定者优先接战（即便有更近的非征召小人在场；
      // 指定 = 玩家命令，优先于自动索敌）。战斗公式（伤害/闪避/掉落）零复制——只是把
      // "谁接敌"从"纯最近"改为"主选指定者"。指定者未到近战距离时仍回落自动索敌（防
      // 指定者长途奔袭期间基地白挨打）。K_ATTACK 存 hostileIndex（与协议快照下标对齐）。
      let nearest: number | null = null;
      let nd = t.meleeRange;
      const designator = this.attackDesignatorOf(i);
      if (designator !== null) {
        const dpos = this.ctx.pawnPositions.get(designator);
        if (dpos) {
          const d = Math.hypot(dpos.x - h.x, dpos.y - h.y);
          if (d < nd) { nd = d; nearest = designator; }
        }
      }
      if (nearest === null) {
        for (const eid of this.ctx.pawnList) {
          const pos = this.ctx.pawnPositions.get(eid);
          if (!pos) continue;
          const d = Math.hypot(pos.x - h.x, pos.y - h.y);
          if (d < nd) { nd = d; nearest = eid; }
        }
      }
      // 没有足够近的小人时，攻击附近建筑（墙优先）
      if (nearest === null) {
        const b = this.nearestBuilding(h, t.buildingRadius);
        if (b) {
          const r = this.ctx.world.damageBuilding(b.x, b.y, t.buildingDmg * dt);
          if (r.destroyed) {
            this.ctx.logEvent('💥 建筑被敌人摧毁！');
            // 征服已删除（2026-08-14 重构：派系实体层删除，无单位可吞并）
          }
          continue;
        }
      }
      if (nearest !== null) {
        h.hp -= t.pawnDmg * dt;
        this.ctx.growSkill(nearest, 'fight');
        if (h.hp <= 0) {
          this.killHostile(nearest, i, h.loot ?? { item: t.catLootItem, amount: t.catLootAmount });
          continue;
        }
        const hk = this.ctx.readHealth(nearest);
        if (hk) {
          // DEX 敏捷闪避（COC §3）：高敏捷有一定几率闪开扑咬
          const dna = this.ctx.dnaOf(nearest);
          const dodgeChance = dna ? Math.max(t.minDodge, (dna.dex - t.dodgeBase) * t.dodgePerPoint) : 0;
          const dodge = dna && this.ctx.rng.next() < dodgeChance;
          const dmg = dodge ? 0 : Math.min(hk.hp, (h.dmgPerSec ?? 5) * dt); // 5 = 兜底 DPS（正常由 enemy def 提供）
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

  // 击杀敌对单位：splice 移除 + 掉落（food 私有化进击杀者口袋，其他进全局库存）
  private killHostile(killer: number, i: number, loot: { item: string; amount: number }): void {
    this.ctx.hostiles.splice(i, 1);
    if (loot.item === 'food' && killer >= 0) {
      const st = this.ctx.pawnStates.get(killer);
      if (st) st.inventory = { food: (st.inventory?.food ?? 0) + loot.amount };
    } else {
      this.ctx.stockpile[loot.item] = (this.ctx.stockpile[loot.item] ?? 0) + loot.amount;
    }
    if (killer >= 0) this.ctx.recordOutcome(killer, 'fight', loot.amount);
  }

  // 捕食者定义（数据驱动：enemies 表 predator 标记,mod registerEnemy 可自定义捕食者）
  private predatorOf(h: { enemyId?: string }): EnemyDef | undefined {
    return h.enemyId ? this.ctx.mods.enemies[h.enemyId] : undefined;
  }

  // 捕食者索敌：离 (x,y) 最近的鼠位置（实时追捕,目的 = 叼鼠）
  private nearestPawnTo(x: number, y: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (const eid of this.ctx.pawnList) {
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;
      const d = Math.hypot(pos.x - x, pos.y - y);
      if (d < bd) { bd = d; best = pos; }
    }
    return best;
  }

  // 半径内最近的鼠（捕获判定 / 反杀者），无则 null
  // 2026-08-20 万人战争优化：用空间哈希找最近鼠（O(cell 内) 替代 O(全体)）
  private pawnGrid: Map<number, number[]> = new Map();
  private cellSize = 8;
  private nearestPawnInRange(h: { x: number; y: number }, radius: number): number | null {
    // 懒构建：minCtx 无 update → pawnGrid 为空时即时构建
    if (this.pawnGrid.size === 0) {
      for (const eid of this.ctx.pawnList) {
        const pos = this.ctx.pawnPositions.get(eid);
        if (!pos) continue;
        const cx = Math.floor(pos.x / this.cellSize);
        const cy = Math.floor(pos.y / this.cellSize);
        const key = cx * 100000 + cy;
        let bucket = this.pawnGrid.get(key);
        if (!bucket) { bucket = []; this.pawnGrid.set(key, bucket); }
        bucket.push(eid);
      }
    }
    // 只查 h 周围的格子（radius/cellSize + 1 格范围）
    const cellR = Math.ceil(radius / this.cellSize);
    const hcx = Math.floor(h.x / this.cellSize);
    const hcy = Math.floor(h.y / this.cellSize);
    let best: number | null = null;
    let bd = radius;
    for (let dx = -cellR; dx <= cellR; dx++) {
      for (let dy = -cellR; dy <= cellR; dy++) {
        const bucket = this.pawnGrid.get((hcx + dx) * 100000 + (hcy + dy));
        if (!bucket) continue;
        for (const eid of bucket) {
          const pos = this.ctx.pawnPositions.get(eid);
          if (!pos) continue;
          const d = Math.hypot(pos.x - h.x, pos.y - h.y);
          if (d < bd) { bd = d; best = eid; }
        }
      }
    }
    return best;
  }

  // 指定攻击者（RW-1 征召，2026-08-15）：是否有被征召小人显式指定攻击下标为 hostileIndex
  // 的敌人。扫描 pawn.extra[K_ATTACK]（drafting 包契约键）；返回指定者 eid 或 null。
  // 背景：击杀会 splice 敌人数组（下标错位），DraftSystem.resolveTarget 会回写修正下标，
  // 这里只按当前下标找——错位窗口内回落自动索敌（近战结算不崩，只是指定暂时失效）。
  // 指定攻击者：与 hostileIndex 对齐的征召小人（征召指挥优先于最近者；raid 敌对单位
  // 下标会因击杀 splice 漂移，指定方在 drafting.resolveTarget 里持续修正下标）。
  // 类型防御：extra 是运行时 JSON（手写档可能给非数字 hostileIndex → 严格 === 不匹配即忽略）
  private attackDesignatorOf(hostileIndex: number): number | null {
    for (const eid of this.ctx.pawnList) {
      const a = this.ctx.pawnStates.get(eid)?.extra?.[K_ATTACK] as Record<string, unknown> | undefined;
      if (a && typeof a.hostileIndex === 'number' && a.hostileIndex === hostileIndex) return eid;
    }
    return null;
  }

  // 半径内最近的建筑（2026-08-20 架构优化：用共享 building-cache）
  private nearestBuilding(h: { x: number; y: number }, radius: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestD = radius * radius;
    for (const [, buildings] of this.tagIndex) {
      for (const b of buildings) {
        const d = (b.x - h.x) ** 2 + (b.y - h.y) ** 2;
        if (d < bestD) { bestD = d; best = { x: b.x, y: b.y }; }
      }
    }
    return best;
  }
}
