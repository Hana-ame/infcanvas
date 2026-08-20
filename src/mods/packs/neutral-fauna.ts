// 中立生物玩法包（2026-08-20，用户「中立生物」）：鹿/兔/鸟/鱼等被动生物
// 在世界生成时出现 → 不攻击/不被动攻击 → 可狩猎获取食物 → 自然繁殖/迁移
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';
import { pushHostile } from '../../sim/systems/hostiles';

const CFG = {
  spawnInterval: 120,    // 自然生物刷新周期
  maxPop: 8,             // 同时存在的最大中立生物数
  spawnRadius: 20,       // 刷新半径（营地外围）
  fleeSpeed: 5,          // 逃跑速度（小人靠近时逃离）
  fleeRange: 4,          // 逃跑触发距离
  lootAmount: 3,         // 狩猎掉落食物量
};

const CREATURES = [
  { id: 'deer', name: '鹿', hp: 40, speed: 4, loot: 4 },
  { id: 'rabbit', name: '兔', hp: 15, speed: 6, loot: 2 },
  { id: 'fauna-boar', name: '野猪', hp: 60, speed: 3, dmg: 3, loot: 5 },
  { id: 'bird', name: '野鸟', hp: 10, speed: 8, loot: 1 },
] as const;

// 中立生物系统：鹿/兔/野猪/野鸟 被动生物 → 自然刷新 + 鼠靠近时逃跑 + 可猎杀掉肉
// 2026-08-20：节流 1s（逃跑行为不需要每帧更新，刷新间隔 120s）
class NeutralFaunaSystem {
  id = 'neutral-fauna';
  private timer = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  private _throttle = 0;
  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < 1) return;
    this._throttle = 0;
    // 节流：中立生物行为 1s 评估一次
    // 刷新
    this.timer += dt;
    if (this.timer >= CFG.spawnInterval) {
      this.timer = 0;
      // 统计当前中立生物数
      const current = this.ctx.hostiles.filter(h => h.faction === 'neutral-fauna').length;
      if (current < CFG.maxPop) {
        const creature = CREATURES[Math.floor(this.ctx.rng.next() * CREATURES.length)]!;
        const cx = Math.floor(this.ctx.world.width / 2);
        const cy = Math.floor(this.ctx.world.height / 2);
        const r = CFG.spawnRadius + this.ctx.rng.next() * 15;
        const a = this.ctx.rng.next() * Math.PI * 2;
        const x = Math.round(cx + Math.cos(a) * r);
        const y = Math.round(cy + Math.sin(a) * r);
        if (this.ctx.world.inBounds(x, y) && this.ctx.world.isPassable(x, y)) {
          pushHostile(this.ctx, {
            id: creature.id, name: creature.name, hp: creature.hp, speed: creature.speed,
            climb: 1, dmg: ('dmg' in creature ? creature.dmg : 0) as number,
            faction: 'neutral-fauna',
            loot: { item: 'food', amount: creature.loot },
          } as never, x, y, { targetX: x, targetY: y });
        }
      }
    }

    // 中立生物行为：逃离最近的鼠（非中立 faction）
    for (const h of this.ctx.hostiles) {
      if (h.faction !== 'neutral-fauna') continue;
      // 找最近的鼠
      let nearest: { x: number; y: number } | null = null;
      let nearestD = CFG.fleeRange;
      for (const eid of this.ctx.iterPawns) {
        const pos = this.ctx.pawnPositions.get(eid);
        if (!pos) continue;
        const d = Math.hypot(pos.x - h.x, pos.y - h.y);
        if (d < nearestD) { nearestD = d; nearest = pos; }
      }
      if (nearest) {
        // 逃跑：远离鼠
        const dx = h.x - nearest.x;
        const dy = h.y - nearest.y;
        const d = Math.hypot(dx, dy) || 1;
        const step = (h.speed ?? CFG.fleeSpeed) * dt;
        h.x += (dx / d) * step;
        h.y += (dy / d) * step;
      }
    }

    // 中立生物可被猎杀（raidSystem 的 nearestPawnInRange 不攻击 neutral-fauna faction
    // → 需要征召鼠主动攻击或弓箭手射击。但简化：中立生物也可被普通攻击伤害）
    // 实际上 raidSystem 的 combat 循环跳过 faction === 'player' 但不跳过 neutral-fauna
    // → 中立生物会被自动近身反击打死（如果鼠的 meleeRange 内）
    // 这是可接受的：鼠靠近中立生物 → 中立生物逃跑 → 如果跑不掉被打死掉肉
  }
}

export const neutralFaunaPack: ModPack = {
  id: 'neutral-fauna',
  requires: [],
  apply(m: ModRegistry): void {
    // 注册中立生物定义
    for (const c of CREATURES) {
      m.registerEnemy({
        id: c.id, name: c.name, hp: c.hp, speed: c.speed, climb: 1,
        dmg: 'dmg' in c ? c.dmg : 0,
        loot: { item: 'food', amount: c.loot },
      });
    }
    m.registerSystemDef({
      id: 'neutral-fauna', label: '中立生物', category: 'world',
      ctor: (ctx) => new NeutralFaunaSystem(ctx),
    });
  },
};

export { CFG as FAUNA_CONFIG };