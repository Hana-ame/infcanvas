// 陨石玩法包（2026-08-20，用户「陨石」）：天降陨石 → 落地破坏地形 +
// 留下稀有矿物（ore 大量）+ 冲击波伤害附近小人/建筑。周期性事件，可观测有预警。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus, GameEvent } from '../../sim/core/events';
import type { ModPack } from '../pack';
import { World } from '../../sim/core/world';

const CFG = {
  interval: 240,       // 陨石周期（秒，约4分钟一次）
  warningTime: 10,     // 落地前 10 秒预警
  radius: 5,           // 冲击波半径（格）
  damage: 30,         // 冲击波伤害（小人/建筑）
  oreYield: 15,       // 陨石坑产出矿石量
  tileReplace: 'stone', // 落地格变为石头（陨石坑 = 矿石源）
};

export const METEOR_CONFIG = CFG;

// 陨石系统：周期性天降陨石 → 10s 预警 → 落地冲击波伤害小人/建筑 + 产出矿石
// 2026-08-20：预警倒计时 + 落地效果，定时器驱动（不需要每帧跑循环）
class MeteorSystem {
  id = 'meteor';
  private timer = CFG.interval; // 首次在 interval 秒后
  private pending: { x: number; y: number; countdown: number } | null = null;

  constructor(private ctx: SimContext) {}

  init(bus: EventBus): void {
    bus.on('building_built', (ev: GameEvent) => {
      // 灯塔降低陨石概率（天文观测=预警更长）
    });
  }

  update(dt: number): void {
    if (this.pending) {
      // 预警中 → 倒计时
      this.pending.countdown -= dt;
      if (this.pending.countdown <= 0) {
        this.impact(this.pending.x, this.pending.y);
        this.pending = null;
      }
      return;
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = CFG.interval + this.ctx.rng.next() * 120; // 4-6 分钟随机
      // 随机落点（营地附近 10-40 格环带）
      const cx = Math.floor(this.ctx.world.width / 2);
      const cy = Math.floor(this.ctx.world.height / 2);
      const r = 10 + this.ctx.rng.next() * 30;
      const a = this.ctx.rng.next() * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * r);
      const y = Math.round(cy + Math.sin(a) * r);
      this.pending = { x, y, countdown: CFG.warningTime };
      this.ctx.logEvent(`☄ 陨石预警！${Math.ceil(CFG.warningTime)} 秒后坠落于 (${x},${y})`);
    }
  }

  private impact(x: number, y: number): void {
    // 冲击波：伤害范围内小人
    for (const eid of this.ctx.iterPawns) {
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;
      const d = Math.hypot(pos.x - x, pos.y - y);
      if (d <= CFG.radius) {
        const h = this.ctx.readHealth(eid);
        if (h) this.ctx.setHealth(eid, { hp: Math.max(0, h.hp - CFG.damage), maxHp: h.maxHp });
        this.ctx.logEvent(`💥 #${eid} 被陨石冲击波击中！(-${CFG.damage} HP)`);
      }
    }
    // 破坏范围内建筑
    const toDestroy: number[] = [];
    for (const [k, b] of this.ctx.world.buildings) {
      const bp = World.keyToXY(k);
      const d = Math.hypot(bp.x - x, bp.y - y);
      if (d <= CFG.radius) toDestroy.push(k);
    }
    for (const k of toDestroy) {
      const { x: bx, y: by } = World.keyToXY(k);
      this.ctx.world.damageBuilding(bx, by, 99999);
    }
    // 落地格变石头（陨石坑 = 矿石源）
    if (this.ctx.world.inBounds(x, y)) {
      this.ctx.world.setTile(x, y, CFG.tileReplace);
    }
    // 产出矿石
    this.ctx.stockpile.ore = (this.ctx.stockpile.ore ?? 0) + CFG.oreYield;
    this.ctx.recordEarn(null, 'ore', CFG.oreYield, 'meteor');
    this.ctx.logEvent(`☄ 陨石坠落！(${x},${y}) 产出矿石 +${CFG.oreYield}`);
  }
}


export const meteorPack: ModPack = {
  id: 'meteor',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'meteor', label: '陨石', category: 'world',
      ctor: (ctx) => new MeteorSystem(ctx),
    });
  },
};