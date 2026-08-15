// 袭击 + 战斗系统：刷野猫群 → 移动 → 接敌 → 战死掉落（天敌=野猫，2026-08-14 世界观修正）
// 数据驱动：数值全读 tuning.combat（mod 可覆盖）；叙事压力（DESIGN §6）：和平越久袭击越猛
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import { World } from '../core/world';
import { K_ATTACK } from '../mods/contracts'; // RW-1 征召指定攻击（drafting 包契约键）

export class RaidSystem implements GameSystem {
  id = 'raid';
  private raidTimer: number;
  private peaceTime = 0; // 距上次袭击的和平时长（叙事压力，DESIGN §6）
  private baseInterval: number; // 基线袭击间隔（秒）

  constructor(private ctx: SimContext) {
    this.baseInterval = ctx.tuning.combat.baseInterval;
    this.raidTimer = ctx.tuning.combat.initialRaidDelay;
  }

  init(_bus: EventBus): void {}

  update(dt: number): void {
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
        this.spawnRaid(count, pressure);
        this.peaceTime = 0;
        this.ctx.bus.emit({ type: 'raid_started', count });
        this.ctx.logEvent(`⚠ 野猫来袭！${count} 只${pressure > 1.3 ? '（积怨已久，规模更大）' : ''}`);
      }
    }
  }

  // 刷一波袭击：从地图边缘随机边出生，直奔营地中心；规模随人口与叙事压力放大
  private spawnRaid(count: number, pressure = 1): void {
    const w = this.ctx.world;
    // 敌人数值走 enemies 表（mods.enemyDef()，mod 可 overrideDef 调强度/掉落）
    const enemy = this.ctx.mods.enemyDef();
    const edge = Math.floor(this.ctx.rng.next() * 4);
    const cx = Math.floor(w.width / 2);
    const cy = Math.floor(w.height / 2);
    for (let i = 0; i < count; i++) {
      let x: number, y: number;
      if (edge === 0) { x = this.ctx.rng.int(0, w.width - 1); y = 0; }
      else if (edge === 1) { x = this.ctx.rng.int(0, w.width - 1); y = w.height - 1; }
      else if (edge === 2) { x = 0; y = this.ctx.rng.int(0, w.height - 1); }
      else { x = w.width - 1; y = this.ctx.rng.int(0, w.height - 1); }
      this.ctx.hostiles.push({
        x, y, hp: enemy.hp * pressure, maxHp: enemy.hp * pressure,
        targetX: cx, targetY: cy,
        name: enemy.name, enemyId: enemy.id, faction: enemy.faction,
        speed: enemy.speed, dmgPerSec: enemy.dmg, loot: enemy.loot,
      });
    }
  }

  private updateCombat(dt: number): void {
    if (this.ctx.hostiles.length === 0) return;
    const t = this.ctx.tuning.combat;
    for (const h of this.ctx.hostiles) {
      const dx = h.targetX - h.x;
      const dy = h.targetY - h.y;
      const d = Math.hypot(dx, dy);
      const step = (h.speed ?? this.ctx.tuning.combat.catSpeed) * dt;
      if (d > step) {
        h.x += (dx / d) * step;
        h.y += (dy / d) * step;
      }
    }
    for (let i = this.ctx.hostiles.length - 1; i >= 0; i--) {
      const h = this.ctx.hostiles[i];
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
            this.ctx.logEvent('💥 建筑被野猫摧毁！');
            // 征服已删除（2026-08-14 重构：派系实体层删除，无单位可吞并）
          }
          continue;
        }
      }
      if (nearest !== null) {
        h.hp -= t.pawnDmg * dt;
        this.ctx.growSkill(nearest, 'fight');
        if (h.hp <= 0) {
          this.ctx.hostiles.splice(i, 1);
          const loot = h.loot ?? { item: this.ctx.tuning.combat.catLootItem, amount: this.ctx.tuning.combat.catLootAmount };
          // 私有物品（2026-08-14）：猎物掉落食物 → 击杀者个人口袋（私有），其他仍全局
          if (loot.item === 'food') {
            const st = this.ctx.pawnStates.get(nearest);
            if (st) st.inventory = { food: (st.inventory?.food ?? 0) + loot.amount };
          } else {
            this.ctx.stockpile[loot.item] = (this.ctx.stockpile[loot.item] ?? 0) + loot.amount;
          }
          this.ctx.bus.emit({ type: 'resource_gained', eid: nearest, item: loot.item, amount: loot.amount });
          // 战斗结果反馈（EWA）：击杀战利品量 → fight 吸引力（被杀的小人已死，不需记录）
          this.ctx.recordOutcome(nearest, 'fight', loot.amount);
          continue;
        }
        const hk = this.ctx.readHealth(nearest);
        if (hk) {
          // DEX 敏捷闪避（COC §3）：高敏捷有一定几率闪开野猫扑咬
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

  // 半径内最近的建筑（野猫拆家；被毁建筑若为核心 → 触发征服吞并，见 updateCombat）
  private nearestBuilding(h: { x: number; y: number }, radius: number): { x: number; y: number } | null {
    const w = this.ctx.world;
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    // chunk 空间分区查询（原 O(r²) 全格扫描 × hostile × tick）
    for (const b of w.queryBuildingsNear(Math.round(h.x), Math.round(h.y), radius)) {
      // 新 key 编码（2026-08-14 无限地图）：World.keyToXY 解码（负坐标支持）
      if (b.dist < bestD) { bestD = b.dist; best = World.keyToXY(b.key); }
    }
    return best;
  }
}
