// 贸易玩法包（2026-08-14，插件化大系统实验：商队贸易）
// 背景：派系实体层已删（无营地间贸易/战争），事件系统有"游商到访"但只是随机等价物换购。
// 本包提供玩家可建造的贸易站：商队定期到访贸易站，按定价表用库存做多笔交换——
// 稀有货（工具/矿/大额食物）通常换不走，但商队会带来"批量兑换"机会（量大从优）。
// 机制：
//   ① 新建筑 'tradePost'（tags 'trade'；来访节奏 = CFG.visitMin/visitMax，无 meta 参数）
//   ② 低频评估（60s）：有贸易站 + 最近来访冷却已过 → 触发商队到访，
//      按定价表随机 1-3 笔交易（每笔 give→get，量同步进出 stockpile）
//   ③ 账本：交易收支走全局经济（recordEarn/recordSpend），历史入日志与篝火记忆
// 装配：before 'raid'，默认挂载。无贸易站不触发（与游商事件互不干扰——双通道共存）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { ModPack } from '../pack';

// 本包数值
const CFG = {
  visitMin: 60,     // 商队最短来访间隔（秒）
  visitMax: 150,    // 商队最长来访间隔（秒）
  dealsMin: 1,      // 每次到访最少成交笔数
  dealsMax: 3,      // 每次到访最多成交笔数
};

// 定价表：{ give: {item, amount}, get: {item, amount} }（商队进货/出货 双方向）
// 意图：资源转换不亏大——等价物换购（木↔食、矿↔工具）有轻微手续费，但批量量大从优
interface Deal { give: { item: string; amount: number }; get: { item: string; amount: number }; label?: string }

const DEALS: Deal[] = [
  { give: { item: 'wood', amount: 20 }, get: { item: 'food', amount: 24 }, label: '用木头换食物' },
  { give: { item: 'food', amount: 18 }, get: { item: 'wood', amount: 20 }, label: '用食物换木头' },
  { give: { item: 'ore', amount: 12 }, get: { item: 'tools', amount: 3 }, label: '用矿石换工具' },
  { give: { item: 'tools', amount: 2 }, get: { item: 'food', amount: 20 }, label: '用手工工具换食物' },
  { give: { item: 'wood', amount: 30 }, get: { item: 'ore', amount: 24 }, label: '用木头换矿石' },
  { give: { item: 'ore', amount: 20 }, get: { item: 'wood', amount: 16 }, label: '用矿石换木头' },
];

export const tradePack: ModPack = {
  id: 'trade',
// 依赖（2026-08-15 显式化）：无硬前置——贸易站建筑自注册
  requires: [],
  apply(m: ModRegistry): void {
    m.registerBuilding({
      id: 'tradePost', name: '贸易站', size: { x: 2, y: 2 }, hp: 300, color: '#5a5a3a',
      emoji: '🏪', passable: false, buildTime: 6,
      // 来访节奏读 CFG.visitMin/visitMax（随机间隔）；meta 不再声明死字段 rate
      // （审计 2026-08-15：此前声明 rate:1 但 TradeSystem 从不读——属性声明与实现脱节）
      tags: ['trade'],
      costWood: 40, costOre: 10,
    });
    m.registerSystemDef({
      id: 'trade', label: '商队贸易', category: 'production',
      ctor: (sim) => new TradeSystem(sim),
      // 表内系统不设 before：执行序 = 类别序 × 组内注册序推导（SYSTEM_DEFS 表位置定序；
      // before 锚点仅第三方表外系统专用——2026-08-16 审计 L7 清理死锚点）
    });
  },
};

// 商队评估：贸易站存在 + 冷却过 → 到访成交（随机笔数 × 定价表）
// 冷却/交易量不落盘（存量语义弱，重访问题不大）；trade 总量兼容既有"游商到访"事件通道
export class TradeSystem {
  id = 'trade';
  private timer = 0;

  constructor(private ctx: SimContext) {}

  init(): void {}

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    const hasPost = [...this.ctx.world.buildings.values()].some((b) => b.def.tags?.includes('trade'));
    if (!hasPost) { this.timer = CFG.visitMin; return; } // 无贸易站：等下轮（不触发）
    // 随机来访间隔
    this.timer = CFG.visitMin + Math.floor(this.ctx.rng.next() * (CFG.visitMax - CFG.visitMin));
    const deals = CFG.dealsMin + Math.floor(this.ctx.rng.next() * (CFG.dealsMax - CFG.dealsMin + 1));
    let done = 0;
    for (let i = 0; i < deals; i++) {
      const deal = DEALS[Math.floor(this.ctx.rng.next() * DEALS.length)];
      if ((this.ctx.stockpile[deal.give.item] ?? 0) < deal.give.amount) continue;
      this.ctx.stockpile[deal.give.item] = Math.max(0, (this.ctx.stockpile[deal.give.item] ?? 0) - deal.give.amount);
      this.ctx.stockpile[deal.get.item] = (this.ctx.stockpile[deal.get.item] ?? 0) + deal.get.amount;
      this.ctx.recordSpend(null, deal.give.item, deal.give.amount);
      this.ctx.recordEarn(null, deal.get.item, deal.get.amount);
      this.ctx.logEvent(`🧺 游商${deal.label ?? '完成一笔交易'}（-${deal.give.amount}${deal.give.item} +${deal.get.amount}${deal.get.item}）`);
      done++;
    }
    if (done > 0) this.ctx.logEvent(`🧺 商队到访贸易站，成交 ${done} 笔`);
  }
}
