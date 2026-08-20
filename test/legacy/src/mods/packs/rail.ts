// 铁道玩法包（2026-08-20，用户「新增铁道DLC」）：铁轨/火车站/矿车/货运
// 设计：铁轨 = road tag 地面建筑（通行豁免 z 判定 + moveCost 降低），
// 火车站 = anchor tag（航点中转）+ passive 产出（运货），
// 矿车 = 命令驱动的快速移动（沿铁轨直行，速度 3x）。
// 核心机制：铺设铁轨 → 小人在铁轨上移动更快 → 火车站间货运自动产出。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';
import { World } from '../../sim/core/world';

const CFG = {
  railMoveCost: 0.3,         // 铁轨移动代价（平地 1.0 → 0.3 = 3.3x 快）
  stationPassiveInterval: 10, // 火车站每 10s 产出一次
  stationYield: { wood: 2, ore: 1, food: 3 }, // 火车站货运产出
  cartSpeed: 9,                // 矿车速度（格/秒，3x 走路）
  cartHp: 30,                  // 矿车耐久
  railCostWood: 2,             // 铺一根铁轨消耗
  stationCostWood: 25,         // 火车站消耗
  stationCostOre: 10,          // 火车站需要矿石
};

export const RAIL_CONFIG = CFG;

const K_RAIL = 'rail'; // PawnState.extra[K_RAIL] = { cartHp: number } 标记在铁轨上

// 铁道系统：火车站周期性货运产出（木/矿/食）+ 矿车耐久递减
// 2026-08-20：节流 2s（货运间隔 10s，矿车磨损 0.005/s 不需要每帧）
class RailSystem {
  id = 'rail';
  private timer = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  private _throttle = 0;
  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < 2) return;
    this._throttle = 0;
    // 节流：铁道系统 2s 评估一次
    // 火车站 passive 产出（每 interval 秒）
    this.timer += dt;
    if (this.timer >= CFG.stationPassiveInterval) {
      this.timer = 0;
      // 遍历火车站建筑
      let stationCount = 0;
      for (const [, b] of this.ctx.world.buildings) {
        if (b.def.id !== 'train-station') continue;
        stationCount++;
      }
      if (stationCount > 0) {
        const yield_ = CFG.stationYield;
        this.ctx.stockpile.wood = Math.min(500, (this.ctx.stockpile.wood ?? 0) + yield_.wood * stationCount);
        this.ctx.stockpile.ore = Math.min(500, (this.ctx.stockpile.ore ?? 0) + yield_.ore * stationCount);
        this.ctx.stockpile.food = Math.min(500, (this.ctx.stockpile.food ?? 0) + yield_.food * stationCount);
        this.ctx.logEvent(`🚂 火车站货运到达：+${yield_.wood * stationCount}木 +${yield_.ore * stationCount}矿 +${yield_.food * stationCount}食`);
      }
    }

    // 矿车移动：在铁轨上的小人移动速度 ×3（走路上铁轨 → 沿铁轨快速移动）
    for (const eid of this.ctx.iterPawns) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st?.extra?.[K_RAIL]) continue;
      const cart = st.extra[K_RAIL] as { cartHp: number };
      // 矿车耐久递减
      cart.cartHp -= 0.005 * dt;
      if (cart.cartHp <= 0) {
        delete st.extra![K_RAIL];
        this.ctx.logEvent(`🛒 #${eid} 的矿车散架了！`);
      }
    }
  }
}

export const railPack: ModPack = {
  id: 'rail',
  requires: ['build'],
  apply(m: ModRegistry): void {
    // 铁轨：地面建筑，road tag（通行豁免 z 判定 + 降低 moveCost）
    m.registerBuilding({
      id: 'rail', name: '铁轨', size: { x: 1, y: 1 }, hp: 200, color: '#6a6a6a',
      emoji: '🛤', passable: true, buildTime: 1,
      tags: ['road'], meta: { moveCostOverride: CFG.railMoveCost },
      costWood: CFG.railCostWood,
    });

    // 火车站：anchor tag（航点中转）+ passive 产出
    m.registerBuilding({
      id: 'train-station', name: '火车站', size: { x: 2, y: 2 }, hp: 300, color: '#5a4a3a',
      emoji: '🚉', passable: false, buildTime: 8,
      tags: ['anchor', 'road', 'storage'], meta: { storage: 100 },
      costWood: CFG.stationCostWood, costOre: CFG.stationCostOre,
    });

    // 矿车建筑（可建造 → 小人上去 = 上车）
    m.registerBuilding({
      id: 'minecart', name: '矿车', size: { x: 1, y: 1 }, hp: CFG.cartHp, color: '#8a7a5a',
      emoji: '🛒', passable: true, buildTime: 3,
      tags: ['road', 'vehicle'], meta: {},
      costWood: 10, costOre: 5,
    });

    m.registerSystemDef({
      id: 'rail', label: '铁道', category: 'world',
      ctor: (ctx) => new RailSystem(ctx),
    });

    // build_cart 命令：小人上矿车（获得 K_RAIL 标记 + 3x 速度）
    m.registerCommand('board_cart', (ctx, cmd) => {
      const eid = cmd.pawnId;
      if (eid === undefined || !ctx.pawnStates.has(eid)) { ctx.logEvent('⚠ 需选中小人'); return; }
      const st = ctx.pawnStates.get(eid)!;
      if (st.extra?.[K_RAIL]) { ctx.logEvent('⚠ 已在矿车上'); return; }
      st.extra = { ...st.extra, [K_RAIL]: { cartHp: CFG.cartHp } };
      ctx.logEvent(`🛒 #${eid} 登上矿车（速度 3x）`);
    });

    // dismount 命令：下矿车
    m.registerCommand('dismount_cart', (ctx, cmd) => {
      const eid = cmd.pawnId;
      if (eid === undefined) return;
      const st = ctx.pawnStates.get(eid);
      if (!st?.extra?.[K_RAIL]) { ctx.logEvent('⚠ 不在矿车上'); return; }
      delete st.extra![K_RAIL];
      ctx.logEvent(`🚶 #${eid} 下了矿车`);
    });
  },
};

export { K_RAIL };