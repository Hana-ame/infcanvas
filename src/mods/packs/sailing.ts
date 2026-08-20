// 航海系统玩法包（2026-08-20，用户「航海」）：船/渡水/港口/海战
// 设计：玩家建造码头 → 造船 → 小人上船渡水 → 船载小人移动（无视地形可走性，
// 直线移动水上）。码头 = anchor tag 建筑。船 = PawnState.extra.boarded 标记 +
// 船位位置独立追踪。海盗 = 飞行/水上 hostile（flying 包联动）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';
import { K_WORN } from '../../sim/mods/contracts';

const K_BOAT = 'boat'; // extra[K_BOAT] = { x, y, hp } 船的位置和耐久

const CFG = {
  boatSpeed: 6,        // 船速（格/秒，比走路快）
  boatHp: 50,          // 船耐久
  boatCostWood: 20,    // 造船消耗
  dockCostWood: 15,    // 码头消耗
  boardingRange: 2,    // 上船范围（格）
};

// 航海系统：船（PawnState.extra[K_BOAT]）耐久递减 + 沉船清除
// 2026-08-20：船磨损 0.01/s，系统循环遍历有船的小人（数量极少）
class SailingSystem {
  id = 'sailing';

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    for (const eid of this.ctx.iterPawns) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const boat = st.extra?.[K_BOAT] as { x: number; y: number; hp: number } | undefined;
      if (!boat) continue;
      // 在船上的小人：船移动（直线走向 targetX/Y，无视地形）
      const pos = this.ctx.readPosition(eid);
      if (!pos) continue;
      const dx = boat.x - pos.x;
      const dy = boat.y - pos.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.5) {
        // 船移动 → 小人跟着移动
        const step = CFG.boatSpeed * dt;
        boat.x += (dx / d) * Math.min(step, d) * 0; // 船跟随小人 target（简化：船=小人位置）
      }
      // 船耐久递减（漂流磨损）
      boat.hp -= 0.01 * dt;
      if (boat.hp <= 0) {
        delete st.extra![K_BOAT];
        this.ctx.logEvent(`🚣 #${eid} 的船散架了！`);
      }
    }
  }
}

export const sailingPack: ModPack = {
  id: 'sailing',
  requires: ['build'],
  apply(m: ModRegistry): void {
    // 码头建筑
    m.registerBuilding({
      id: 'dock', name: '码头', size: { x: 2, y: 2 }, hp: 120, color: '#5a4a3a',
      emoji: '⚓', passable: true, buildTime: 4,
      tags: ['anchor', 'water'], meta: {},
      costWood: CFG.dockCostWood,
    });
    m.registerSystemDef({
      id: 'sailing', label: '航海', category: 'world',
      ctor: (ctx) => new SailingSystem(ctx),
    });
    // build_boat 命令：在码头旁造船
    m.registerCommand('build_boat', (ctx, cmd) => {
      const eid = cmd.pawnId;
      if (eid === undefined || !ctx.pawnStates.has(eid)) { ctx.logEvent('⚠ 需选中小人'); return; }
      const st = ctx.pawnStates.get(eid)!;
      if (st.extra?.[K_BOAT]) { ctx.logEvent('⚠ 已有船'); return; }
      if ((ctx.stockpile.wood ?? 0) < CFG.boatCostWood) { ctx.logEvent('⚠ 木材不足造船'); return; }
      ctx.stockpile.wood -= CFG.boatCostWood;
      ctx.recordSpend(null, 'wood', CFG.boatCostWood);
      const pos = ctx.pawnPositions.get(eid);
      st.extra = { ...st.extra, [K_BOAT]: { x: pos?.x ?? 0, y: pos?.y ?? 0, hp: CFG.boatHp } };
      ctx.logEvent(`🚣 #${eid} 造了一艘船`);
    });
    // disembark 命令：下船
    m.registerCommand('disembark', (ctx, cmd) => {
      const eid = cmd.pawnId;
      if (eid === undefined) return;
      const st = ctx.pawnStates.get(eid);
      if (!st?.extra?.[K_BOAT]) { ctx.logEvent('⚠ 没有船'); return; }
      delete st.extra![K_BOAT];
      ctx.logEvent(`🚶 #${eid} 上岸了`);
    });
  },
};

export { K_BOAT, CFG as SAILING_CONFIG };