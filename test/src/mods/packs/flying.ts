// 飞行单位玩法包（2026-08-20，用户「飞行单位」）：飞行敌人/弓箭手防空/空中侦察
// 设计：飞行 hostile = 无视地形（直线移动，isPassable 不检查）、需弓箭手（archer job）
// 击落。弓箭手 = 新 job + 新 work（射箭 → 伤害飞行 hostile）。
// 飞行敌人 EnemyDef 新字段 flying?: true → raidSystem 移动阶段跳过地形检查。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus, GameEvent } from '../../sim/core/events';
import type { ModPack } from '../pack';
import { pushHostile } from '../../sim/systems/hostiles';

const CFG = {
  flyingEnemyHp: 60,
  flyingEnemySpeed: 10,
  flyingEnemyDmg: 4,
  spawnInterval: 180,     // 飞行敌人每 3 分钟刷 1 只
  spawnRadiusMin: 20,      // 刷怪环带最小半径（营地外围）
  spawnRadiusMax: 35,      // 刷怪环带最大半径
  archerRange: 15,        // 弓箭手射程
  archerDmg: 8,           // 弓箭手每秒伤害
  archerShootCd: 1.5,    // 射箭冷却
};

// 飞行单位系统：周期性刷新鹰（flying hostile，无视地形直线移动）+ 弓箭手射击击落
// 2026-08-20：节流 2s（刷怪间隔 180s，射击检定不需要每帧）；弓箭手 job=archer
class FlyingSystem {
  id = 'flying';
  private spawnTimer = 0;
  private _throttle = 0;
  private shootCd = new Map<number, number>();

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {
    // 监听弓箭手 assigned job → 注册 work
  }

  update(dt: number): void {
    // 2026-08-20 节流：飞行敌人刷怪 + 弓箭手射击 2s 评估一次（spawnTimer 已有内部计时）
    this._throttle += dt;
    if (this._throttle < 2) return;
    this._throttle = 0;
    // 周期性刷飞行敌人
    this.spawnTimer += dt;
    if (this.spawnTimer >= CFG.spawnInterval) {
      this.spawnTimer = 0;
      const cx = Math.floor(this.ctx.world.width / 2);
      const cy = Math.floor(this.ctx.world.height / 2);
      const ang = this.ctx.rng.next() * Math.PI * 2;
      const r = CFG.spawnRadiusMin + this.ctx.rng.next() * (CFG.spawnRadiusMax - CFG.spawnRadiusMin);
      const x = Math.round(cx + Math.cos(ang) * r);
      const y = Math.round(cy + Math.sin(ang) * r);
      pushHostile(this.ctx, {
        id: 'eagle', name: '鹰', hp: CFG.flyingEnemyHp, speed: CFG.flyingEnemySpeed,
        climb: 99, dmg: CFG.flyingEnemyDmg, predator: true, flying: true,
        loot: { item: 'food', amount: 5 },
      } as never, x, y, { targetX: cx, targetY: cy });
      this.ctx.logEvent('🦅 一只鹰从天而降！');
    }

    // 弓箭手射击飞行敌人
    for (const eid of this.ctx.iterPawns) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st || st.assignedJob !== 'archer') continue;
      if ((st.extra?.['drafted'] ?? false) === false && !st.assignedJob) continue;
      const cd = (this.shootCd.get(eid) ?? 0) - dt;
      if (cd > 0) { this.shootCd.set(eid, cd); continue; }
      // 找最近的飞行敌人
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;
      let best: number = -1;
      let bestD = CFG.archerRange;
      for (let i = 0; i < this.ctx.hostiles.length; i++) {
        const h = this.ctx.hostiles[i]!;
        if (!(h as { flying?: boolean }).flying) continue;
        const d = Math.hypot(h.x - pos.x, h.y - pos.y);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        this.ctx.hostiles[best]!.hp -= CFG.archerDmg;
        this.shootCd.set(eid, CFG.archerShootCd);
        if (this.ctx.hostiles[best]!.hp <= 0) {
          const h = this.ctx.hostiles[best]!;
          this.ctx.hostiles.splice(best, 1);
          if (h.loot) this.ctx.stockpile[h.loot.item] = (this.ctx.stockpile[h.loot.item] ?? 0) + h.loot.amount;
          this.ctx.logEvent(`🏹 #${eid} 射落了一只鹰！`);
        }
      }
    }
  }
}

export const flyingPack: ModPack = {
  id: 'flying',
  requires: [],
  apply(m: ModRegistry): void {
    // 鹰（飞行敌人定义）
    m.registerEnemy({
      id: 'eagle', name: '鹰', hp: CFG.flyingEnemyHp, speed: CFG.flyingEnemySpeed,
      climb: 99, dmg: CFG.flyingEnemyDmg, predator: true, flying: true,
      loot: { item: 'food', amount: 5 },
    } as never);
    // 弓箭手职业
    m.registerSystemDef({
      id: 'flying', label: '飞行防空', category: 'world',
      ctor: (ctx) => new FlyingSystem(ctx),
    });
  },
};

export { CFG as FLYING_CONFIG };