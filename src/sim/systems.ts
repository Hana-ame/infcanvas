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
import type { SimContext } from './context';
import { drawCard, touchMastery } from './cards';
import type { CardDef } from './cards';
import type { PawnState } from './types';

export type Category = 'needs' | 'ai' | 'society' | 'production' | 'raid' | 'world' | 'boot';

export const CATEGORY_ORDER: Category[] = ['needs', 'ai', 'society', 'production', 'raid', 'world', 'boot'];

export interface GameSystem {
  id: string;
  /** 每 tick 步进。允许缺省（纯 init 型系统，如出生引导）。 */
  update?(dt: number): void;
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
      for (const p of ctx.pawns()) {
        // 到期（且不在玩家命令优先窗口内）→ 抽新卡
        if (ctx.time >= p.busyUntil && ctx.time >= p.holdUntil) {
          const card = drawCard(ctx, p) ?? FALLBACK_CARD;
          commit(ctx, p, card);
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
    },
  };
}

/** 抽中承诺：写当前卡 + 到期时刻 + 统计 + 熟练度成长（卡=习惯：越用越顺手）。
 *  导出供 Sim.debugForceCard 复用（测试口子必须走同一条承诺路径，避免两套语义漂移） */
export function commit(ctx: SimContext, p: PawnState, card: CardDef): void {
  p.cardId = card.id;
  p.busyUntil = ctx.time + (card.duration ?? ctx.tuning.pawn.defaultCardSec);
  p.uses[card.id] = (p.uses[card.id] ?? 0) + 1;
  touchMastery(p, card.id, ctx);
}
