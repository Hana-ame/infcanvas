// 抽卡权重调制规则表（逻辑组件层：权重合成公式数据驱动）
// effectiveWeight = card.weight 依次经过各规则调制；规则顺序 = 表序
// mod 可 registerWeightRule 插入（before 锚点）或 overrideWeightRule 替换内置
// 规则函数是"机制"（参数全部读表/tuning），表序与组合才是数据——mod 无需改内核源码
import type { BehaviorCard, PawnLike, CardContext } from '../ai/pawn';
import { TRAITS } from './traits';
import { MARKOV_BIAS } from './behavior';

export interface WeightRule {
  id: string;
  label: string; // 中文名（调试/文档）
  apply(w: number, card: BehaviorCard, pawn: PawnLike, ctx?: CardContext): number;
}

// 天赋权重倍率（表驱动：TraitDef.weightMuls[series]；mod 天赋也可声明自己的调制）
const ruleTrait: WeightRule = {
  id: 'trait',
  label: '天赋倍率',
  apply(w, card, pawn) {
    for (const id of pawn.dna.traits) {
      const mul = TRAITS[id]?.weightMuls?.[card.series];
      if (mul !== undefined) w *= mul;
    }
    return w;
  },
};

// 欲望驱动：未满足的欲望 → 对应系列卡权重升高（DESIGN §3）
const ruleDesire: WeightRule = {
  id: 'desire',
  label: '欲望驱动',
  apply(w, card, pawn, ctx) {
    const cardT = ctx?.view.tuning?.card;
    if (ctx?.view.desiresOf && cardT) {
      const desire = card.desire ?? ctx.view.desireOfSeries?.(card.series) ?? null;
      if (desire) {
        const d = ctx.view.desiresOf(ctx.eid);
        if (d && d[desire] !== undefined) {
          const hunger = 100 - d[desire];
          if (hunger > cardT.desireHungerAt) w *= 1 + (hunger - cardT.desireHungerAt) / cardT.desireDriveDiv;
        }
      }
    }
    return w;
  },
};

// 环境调制（DESIGN §6）：下雨/酷暑/严寒 → 户外工作低，娱乐高（倍率全读 tuning.card）
const ruleEnv: WeightRule = {
  id: 'env',
  label: '环境调制',
  apply(w, card, pawn, ctx) {
    const env = ctx?.view.env;
    const cardT = ctx?.view.tuning?.card;
    if (env && cardT && ctx) {
      const extreme = () => env.temperature > ctx.view.tuning!.env.hotAt || env.temperature < ctx.view.tuning!.env.coldAt;
      if (card.series === 'work') {
        if (env.raining) w *= cardT.envWorkRainMul;
        if (extreme()) w *= cardT.envWorkExtremeMul;
      } else if (card.series === 'leisure') {
        if (env.raining) w *= cardT.envLeisureRainMul;
      } else if (card.series === 'physio') {
        if (extreme()) w *= cardT.envPhysioExtremeMul;
      }
    }
    return w;
  },
};

// 马尔可夫偏置（DESIGN §6）：上一轮干了什么 → 本轮倾向（mods 注入可覆盖，未注入用内建表）
const ruleMarkov: WeightRule = {
  id: 'markov',
  label: '马尔可夫偏置',
  apply(w, card, pawn, ctx) {
    const bias = ctx?.view.markovBias ?? MARKOV_BIAS;
    const last = ctx?.view.lastSeries;
    if (last && bias?.[last]?.[card.series] !== undefined) {
      w *= bias[last][card.series];
    }
    return w;
  },
};

// 派系优先级（用户 Q8）：环境评估下达的工作优先指令，调制对应工作卡权重
const rulePriority: WeightRule = {
  id: 'priority',
  label: '派系优先级',
  apply(w, card, pawn, ctx) {
    const pri = ctx?.view.factionPriority?.[card.id];
    if (pri !== undefined) w *= pri;
    return w;
  },
};

// 指派职业（Q10）：强制主导对应工作卡，其他工作卡权重压到极低（倍率读 tuning）
const ruleJob: WeightRule = {
  id: 'job',
  label: '指派职业',
  apply(w, card, pawn, ctx) {
    const job = ctx?.view.assignedJob;
    const cardT = ctx?.view.tuning?.card;
    if (job && cardT) {
      const jobCard = ctx!.view.jobCards?.[job];
      if (jobCard) {
        w *= card.id === jobCard ? cardT.jobCardMul : cardT.jobOthersMul;
      }
    }
    return w;
  },
};

// 行为结果学习（EWA）：经验吸引 A → exp(βA) 权重倍率（1=无经验中性，>1 偏做，<1 回避）
const ruleLean: WeightRule = {
  id: 'lean',
  label: '行为学习EWA',
  apply(w, card, pawn, ctx) {
    const lean = ctx?.view.leanOf?.(ctx.eid, card.id);
    if (lean !== undefined) w *= lean;
    return w;
  },
};

export const BUILTIN_WEIGHT_RULES: WeightRule[] = [
  ruleTrait,
  ruleDesire,
  ruleEnv,
  ruleMarkov,
  rulePriority,
  ruleJob,
  ruleLean,
];
