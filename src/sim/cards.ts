/**
 * cards.ts —— 一切皆抽卡（原则①，权重高于一切功能）。
 *
 * 决策引擎 = 给小人抽一张卡并执行其动作。没有行为树、没有任务队列、没有 if-else 优先级。
 * 卡 = { id, label, series(系列), weight(基础权重), condition?(谓词), action(动作), duration? }：
 *  - 抽中后承诺 duration 秒（缺省 tuning.pawn.defaultCardSec），期间每 tick 执行 action；
 *    到期重新抽卡。action 自己声明路径/结算效果，幂等（重复执行安全）。
 *  - 权重管线 = base × 钩子(cardWeight) × 特质(seriesMul) × 熟练度(0.5+m/100)。
 *    需求饥饿/疲惫不构成优先级——它们只是把"吃/睡"卡的权重推高，抽不到就忍着，
 *    这正是"需求也只引导、抽不到就忍着"的涌现哲学。
 *  - 熟练度 = 卡的演化：触发 +gain、久不用按流逝时间惰性衰减；卡 = 习惯的建模。
 */
import type { SimContext } from './context';
import type { PawnState } from './types';

export interface CardDef {
  id: string;
  label: string;
  series: string; // 工作系列：需求钩子/特质调制的命中键（跨包词汇表见 mods/contracts.ts）
  weight: number; // 基础权重（≥0）
  condition?: (p: PawnState, ctx: SimContext) => boolean; // 不满足 = 本轮不可抽
  action: (p: PawnState, ctx: SimContext, dt: number) => void; // 执行期间每 tick 调用
  duration?: number; // 承诺秒数，缺省 tuning.pawn.defaultCardSec
}

/** 有效熟练度：存储值按"距上次触碰的流逝时间"折算衰减后的即时值。
 *  惰性衰减 = 读时才算，O(1) 且省掉全局遍历。 */
export function effectiveMastery(p: PawnState, cardId: string, ctx: SimContext): number {
  const e = p.mastery[cardId];
  if (!e) return 0;
  const decayed = e.v - ctx.tuning.pawn.masteryDecayPerSec * Math.max(0, ctx.time - e.t);
  return Math.max(0, decayed);
}

/** 触碰熟练度：先把流逝衰减折进来，再加触发增量并盖章（上限 100）。 */
export function touchMastery(p: PawnState, cardId: string, ctx: SimContext): void {
  const cur = effectiveMastery(p, cardId, ctx);
  const next = Math.min(100, cur + ctx.tuning.pawn.masteryGain);
  p.mastery[cardId] = { v: next, t: ctx.time };
}

/** 单卡当前最终权重（管线顺序刻意固定，保证可解释可测试） */
export function cardWeight(p: PawnState, card: CardDef, ctx: SimContext): number {
  let w = card.weight;
  for (const hook of ctx.weightHooks()) {
    w *= hook(p, card, ctx);
  }
  const traitDef = ctx.tuning.traits[p.trait];
  w *= traitDef?.seriesMul?.[card.series] ?? 1;
  w *= 0.5 + effectiveMastery(p, card.id, ctx) / 100;
  return Math.max(0, w);
}

/**
 * 加权抽选：候选 = condition 通过的卡；按最终权重轮盘赌。
 * 全部权重为 0 / 无候选 → null（内核 behavior 回落到内置兜底卡）。
 */
export function drawCard(ctx: SimContext, p: PawnState): CardDef | null {
  const candidates: CardDef[] = [];
  const weights: number[] = [];
  let total = 0;
  for (const card of ctx.cards()) {
    if (card.condition && !card.condition(p, ctx)) continue;
    const w = cardWeight(p, card, ctx);
    if (w <= 0) continue;
    candidates.push(card);
    weights.push(w);
    total += w;
  }
  if (candidates.length === 0 || total <= 0) return null;
  let r = ctx.rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1]; // 浮点兜底：必返一张已算过的
}
