// 抽卡权重调制规则表（逻辑组件层：权重合成公式数据驱动）
// effectiveWeight = card.weight 依次经过各规则调制；规则顺序 = 表序
// mod 可 registerWeightRule 插入（before 锚点）或 overrideWeightRule 替换内置
// 规则函数是"机制"（参数全部读表/tuning），表序与组合才是数据——mod 无需改内核源码
import type { BehaviorCard, PawnLike, CardContext } from '../ai/pawn';
import { TRAITS } from './traits';
import { INTERESTS } from './interests';
import { MARKOV_BIAS } from './behavior';

export interface WeightRule {
  id: string;
  label: string; // 中文名（调试/文档）
  apply(w: number, card: BehaviorCard, pawn: PawnLike, ctx?: CardContext): number;
}

// 神谕目标（DESIGN §6：神谕影响目标层，不碰选择链）：
// 神谕降旨设定的目标工作类型 → 对应卡权重放大（倍率读 tuning.card.oracleGoalMul，默认 3）
// 小人仍自主抽卡择优（可被欲望/环境/违抗 roll 顶掉）——神谕只引导方向
const ruleOracleGoal: WeightRule = {
  id: 'oracleGoal',
  label: '神谕目标',
  apply(w, card, _pawn, ctx) {
    const goal = ctx?.view.oracleGoal;
    const mul = ctx?.view.tuning?.card?.oracleGoalMul;
    if (goal && mul && card.decide(ctx).workType === goal.workType) w *= mul;
    return w;
  },
};

// 个人经济预期（用户设计：每个人心里有本账——工作会赚多少，就愿意干多少）
// 按工作类型的预期收益 ≥ 基准 → 该工作权重升（经济理性选择）；低于基准 → 权重降
const ruleExpectation: WeightRule = {
  id: 'expectation',
  label: '经济预期',
  apply(w, card, _pawn, ctx) {
    const e = ctx?.view.tuning?.economy;
    const expect = ctx?.view.expectEarnOf?.(ctx.eid, card.decide(ctx).workType ?? '');
    if (e && expect !== undefined && e.expectBase > 0) {
      const k = (expect - e.expectBase) / e.expectBase;
      w *= Math.max(0.5, 1 + k * e.expectMul);
    }
    return w;
  },
};

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
// RW-1（2026-08-15）：work-priority 玩法包新增 workPriority 规则（before:'job'），把
// assignedJob 演化为每工作 0~4 优先级。当 pawn 已有工作优先级（view.workPriorities 非空）
// 时，本规则**让位**——优先级调制完全由 workPriority 规则承担，避免双重调制（assign
// 快捷方式会把 assignedJob 迁移为 workPriorities，两者会同时在场）。仅在无优先级的旧
// 行为（纯 assignedJob，如 hg 玩法或未迁移）下兜底。
const ruleJob: WeightRule = {
  id: 'job',
  label: '指派职业',
  apply(w, card, pawn, ctx) {
    const pri = ctx?.view.workPriorities;
    if (pri && Object.keys(pri).length > 0) return w; // 优先级在场 → 交 workPriority 规则
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

// 兴趣调制（v2026-08-13 兴趣驱动娱乐落地，规则顺序=表序第 1 位）
// 起因：娱乐活动被写死成固定小卡池（idle+explore），探索卡人人权重一致 → 全营地统一反复建 toy
//       39 次吃光木头（试玩统计 toy:39/well:2/house:1）。
// 经过：先试「buildMinWood 游牧期门槛」拦截全部科技建筑建造被用户否决——「肯定是建造toy的意愿降低啊」，
//       改为正确架构：娱乐 = 开放活动空间，做什么由 pawn 兴趣属性决定（用户 2026-08-13 原话）。
// 结果：卡声明 interest（属于哪个兴趣）→ pawn 有此兴趣权重 ×INTERESTS[id].weightMul（表驱动），
//       无此兴趣 ÷weightMul（压到低）——不感兴趣就不做，从权重合成层杜绝重复循环。
// 放在规则表首位（先于天赋/欲望）：兴趣是最底层的「人设」，先于一切即时调制。
const ruleInterest: WeightRule = {
  id: 'interest',
  label: '兴趣调制',
  apply(w, card, pawn) {
    if (!card.interest) return w;
    const def = INTERESTS[card.interest];
    const mul = def?.weightMul ?? 1;
    return pawn.dna.interests.includes(card.interest) ? w * mul : w / mul;
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

// 内置规则表（权重合成顺序 = 表序：兴趣→天赋→欲望→环境→马尔可夫→派系优先→神谕目标→指派职业→EWA 学习，
// 前规则输出 = 后规则输入；mod 可 registerWeightRule 在任意规则前插入、overrideWeightRule 替换同 id 规则）
export const BUILTIN_WEIGHT_RULES: WeightRule[] = [
  ruleInterest,
  ruleTrait,
  ruleDesire,
  ruleEnv,
  ruleMarkov,
  rulePriority,
  ruleOracleGoal,
  ruleExpectation,
  ruleJob,
  ruleLean,
];
