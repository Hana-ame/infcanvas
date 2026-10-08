/**
 * systems.ts —— 系统契约 + 内核决策引擎（behavior）。
 *
 * 内核边界（原则④）：内核只有"抽卡决策引擎"这一个内联系统——它是引擎服务
 * （没有它"一切皆抽卡"无从谈起），除此之外内核不含任何玩法。采集/吃睡/建造/社交/
 * 敌袭/出生引导全部是玩法包（mods/packs/*）。
 *
 * 执行序 = 类别序 × 组内注册序：CATEGORY_ORDER 定大类先后（需求衰减先于决策、
 * 出生引导恒表尾），同类内按注册顺序（玩法包拓扑挂载序决定）。无 before 锚点——
 * 旧项目教训：锚点语义含糊易漂移，类别×注册序已够表达且可测。
 */
import type { DrawSurface, SimContext } from './context';
import { drawCard, touchMastery } from './cards';
import type { CardDef } from './cards';
import type { PawnState } from './types';
import { tileChunkKey } from '../shared/chunks';
import { K_STOCK_HERB } from '../mods/contracts';

export type Category = 'needs' | 'ai' | 'society' | 'production' | 'raid' | 'world' | 'boot';

export const CATEGORY_ORDER: Category[] = ['needs', 'ai', 'society', 'production', 'raid', 'world', 'boot'];

export interface GameSystem {
  id: string;
  /** 每 tick 步进。允许缺省（纯 init 型系统，如出生引导）。 */
  update?(dt: number): void;
  /**
   * 按区块分片步进（line/net 2026-10-06）。**可选**：实现了就按 admitted 分片跑，
   * 没实现就退回 update(dt) 全量。
   *
   * 契约（必须严格遵守，否则确定性会被悄悄破坏）：
   *  1. **不得改变同 tick 内的处理顺序**。只允许"跳过不在 admitted 里的实体"，
   *     不允许把实体重排（按区块分组遍历必然重排）。理由见 sim.stepChunked：
   *     rng 是单一序列，重排 = 抽卡顺序变 = 整局分叉。
   *  2. 不得写入跨分片的全局状态（那会引入 tick 间的顺序耦合）。
   *
   * 收益边界（诚实前提）：分片只省掉**不活跃区块**的开销。世界小、鼠群集中时
   * 所有鼠都在少数几个区块里，分片几乎不省——不靠"分片了所以更快"自我安慰。
   * 规模收益出现在鼠群分散开之后。
   */
  updateChunked?(dt: number, admitted: ReadonlySet<number>): void;
  init?(): void;
}

export interface SystemDef {
  id: string;
  category: Category;
  ctor(ctx: SimContext): GameSystem;
}

/** 兜底卡：所有卡都不可抽/权重全 0 时的引擎安全网。
 *  它是引擎兜底而非玩法内容（不发呆的引擎会在空轮死循环）；
 *  玩法包应注册自己的闲逛类种子卡，正常局永远抽不到这张。 */
const FALLBACK_CARD: CardDef = {
  id: '_stun',
  label: '愣住',
  series: '_none',
  weight: 0,
  action: () => {}, // 无事发生：站一会儿再抽
};

/** 内核决策引擎：每 tick 对每只鼠——到期抽卡 → 执行当前卡 → 推进路径。
 *  注意它不读任何具体需求/工作字段：一切调制都在权重管线里，内核对玩法零知识。 */
export function behaviorCtor(ctx: SimContext): GameSystem {
  return {
    id: 'behavior',
    update(dt) {
      for (const p of ctx.pawns()) stepPawn(ctx, p, dt);
    },
    /**
     * 分片步进（line/net）：**顺序与 update 逐字一致**，只是跳过不在 admitted 区块里的鼠。
     *
     * 为什么这里是最值得做分片的地方（实测依据见 docs/PROGRESS.md 本轮条目）：
     * behavior 是唯一 per-pawn 每 tick 执行的系统，工作量 O(鼠数)，
     * 且卡 action 里包含寻路（findPath，maxIter 上限 8000）——单只鼠的一次远距离
     * 规划就能占到整 tick 的可观比例。世界上 90% 的区块没有鼠时，这部分全是浪费。
     *
     * 关键：`for (const p of ctx.pawns()) if (!admitted.has(...)) continue;` 这个形状
     * 保证跳过不改变其余鼠的处理顺序 → rng 消费序列在 admitted=全集时与 update 相同，
     * 分片只在"确实没有活跃实体"的区块上省掉工作量，不引入分叉。
     */
    updateChunked(dt, admitted) {
      for (const p of ctx.pawns()) {
        // 每鼠一次 Map 查（O(1)）；比"先分组再遍历"便宜，且不重排。
        if (!admitted.has(tileChunkKey(p.pos.x, p.pos.y).key)) continue;
        stepPawn(ctx, p, dt);
      }
    },
  };
}

/** 单只鼠的一 tick 推进：抽卡 → 执行当前卡 → 冷却/路径。
 *  抽成函数是为了让 update 与 updateChunked **共用同一份实现**——
 *  两份复制品迟早分叉（改一边忘了另一边 = 确定性 bug 潜伏）。 */
function stepPawn(ctx: SimContext, p: PawnState, dt: number): void {
  // 到期（且不在玩家命令优先窗口内）→ 抽新卡
  if (ctx.time >= p.busyUntil && ctx.time >= p.holdUntil) {
    // P2 #7：旧卡自然到期时释放草药预留（防资源泄漏——clearTarget 仅在 heal 内部条件满足时调用，
    // 若目标未康复且卡自然到期，预留量会留在 scratch 永不归还 stockpile）
    const herbKey = `medicine.herbReserved.${p.eid}`;
    const reserved = ctx.scratch[herbKey];
    if (reserved) {
      ctx.scratch[herbKey] = 0;
      ctx.stockpile[K_STOCK_HERB] = (ctx.stockpile[K_STOCK_HERB] ?? 0) + reserved;
    }
    const card = drawCard(ctx, p) ?? FALLBACK_CARD;
    commit(ctx, p, card);
    // 原子性预留：heal 卡抽中时预留草药，防并发超卖（P1 #4）
    if (card.id === 'heal' && ctx.tuning.medicine?.healRequireHerb > 0) {
      const cost = ctx.tuning.medicine.herbCost ?? 1;
      // 预留整张卡时长所需草药（duration 秒 × 每秒 1 份）
      const duration = card.duration ?? ctx.tuning.pawn.defaultCardSec;
      const totalCost = cost * duration;
      const herbs = (ctx.stockpile[K_STOCK_HERB] ?? 0);
      if (herbs >= totalCost) {
        ctx.stockpile[K_STOCK_HERB] = herbs - totalCost;
        // 记录预留量，finishCard 时若未消费则释放
        ctx.scratch[`medicine.herbReserved.${p.eid}`] = totalCost;
      }
    }
  }
  // 当前卡每 tick 执行（action 幂等：重复声明路径/结算安全）
  if (p.cardId !== null) {
    const card = ctx.cardById(p.cardId);
    if (card) card.action(p, ctx, dt);
    else p.cardId = null; // 卡被卸载（mod 热插拔）：安全落地，下轮重抽
  }
  if (p.atkCd > 0) p.atkCd = Math.max(0, p.atkCd - dt);
  if (p.path.length > 0) ctx.moveStep(p, dt);
}

/** 抽中承诺：写当前卡 + 到期时刻 + 统计 + 熟练度成长（卡=习惯：越用越顺手）。
 *  导出供 Sim.debugForceCard 复用（测试口子必须走同一条承诺路径，避免两套语义漂移） */
export function commit(ctx: DrawSurface, p: PawnState, card: CardDef): void {
  p.cardId = card.id;
  p.busyUntil = ctx.time + (card.duration ?? ctx.tuning.pawn.defaultCardSec);
  p.uses[card.id] = (p.uses[card.id] ?? 0) + 1;
  touchMastery(p, card.id, ctx);
}
