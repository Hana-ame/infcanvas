// 数据驱动行为卡系统 —— 卡产"意图"，行为系统执行（mod 友好）
// 设计：卡 = 数据 + 条件 + 收益 + 决策(intent)。意图由统一 BehaviorSystem 消化成走位/工作。
// 加新卡 = 定义一张卡（含 condition/utility/intent），不改任何分发逻辑。

import { SimRng } from '../core/rng';
import type { DesireId } from '../core/desires';

export type SkillId = 'work' | 'fight' | 'social' | 'faith' | 'craft';

export interface Dna {
  str: number;   // 力量：近战/搬运/建造
  con: number;   // 体质：HP/抗病
  int: number;   // 智力：技能学习/施工精度
  siz: number;   // 体型：HP/负重
  dex: number;   // 敏捷：闪避/命中/手工
  app: number;   // 外貌：社交/信仰传播
  pow: number;   // 意志：对抗欲望/抗压/SAN
  edu: number;   // 教育：技能起点/科技
  traits: string[];
  maxSlots: number;
  skillBonuses: Partial<Record<SkillId, number>>;
  sins: Partial<Record<DesireId, number>>; // 罪孽倾向（个性权重 0-1）
}

// 卡决策可读的 sim 信息（只读，决策用）
export interface CardView {
  needsOf(eid: number): { food: number; rest: number; mood: number; san: number } | null;
  healthOf?(eid: number): { hp: number; maxHp: number } | null;
  isNight(): boolean;
  hasCampfire(): boolean;
  hasCave(): boolean;
  buildQueueCount: number;
  stockpile: Record<string, number>;
  desiresOf?(eid: number): Record<DesireId, number> | null;
  // 环境调制（DESIGN §6）：下雨 → 户外工作低、娱乐高；酷暑/严寒 → 户外工作低
  env?: { raining: boolean; temperature: number };
  // 马尔可夫偏置（DESIGN §6）：上一事件系列 → 本轮权重偏置
  lastSeries?: string;
  // 派系优先级（用户 Q8：AI 按环境下达工作优先指令）：workType → 权重倍率
  factionPriority?: Record<string, number>;
  // 指派职业（Q10 生产线）：当前小人固定从事的工作
  assignedJob?: string;
  // 行为倾向（勒沙特列反馈）：该小人各行为的持久倾向
  leanOf?(eid: number, key: string): number;
}

export interface CardContext {
  view: CardView;
  eid: number;
}

// 行为意图：卡决策产出，由 BehaviorSystem 执行
export type IntentAction = 'walkAndWork' | 'eat' | 'rest' | 'pray' | 'heal' | 'idle';

export interface BehaviorIntent {
  action: IntentAction;
  workType?: string; // walkAndWork 用（开放字符串：内置 chop/mine/caveMine/build，mod 可注册新工作类型）
  label: string; // 显示的工作名
}

// 卡：数据 + 条件 + 收益 + 决策（产 intent）
export interface BehaviorCard {
  id: string;
  name: string;
  series: 'work' | 'combat' | 'social' | 'religion' | 'leisure' | 'physio';
  weight: number;
  condition?: (ctx: CardContext) => boolean;
  utility?: (ctx: CardContext) => number;
  // 满足欲望声明（数据驱动）：卡被选中执行后满足对应欲望（mod 新工作卡可声明，替代文案匹配）
  satisfies?: { desire: DesireId; amount: number }[];
  decide(ctx: CardContext): BehaviorIntent;
}

export interface PawnLike {
  dna: Dna;
  slots: (BehaviorCard | null)[];
}

// ---- 基础卡池 ----
export const BASE_CARDS: BehaviorCard[] = [
  {
    id: 'eat', name: '进食', series: 'physio', weight: 9,
    condition: (c) => (c.view.needsOf(c.eid)?.food ?? 0) < 45,
    utility: (c) => 60 - (c.view.needsOf(c.eid)?.food ?? 0),
    decide: () => ({ action: 'eat', label: '进食' }),
  },
  {
    id: 'rest', name: '休息', series: 'physio', weight: 8,
    condition: (c) => (c.view.needsOf(c.eid)?.rest ?? 0) < 40,
    utility: (c) => 50 - (c.view.needsOf(c.eid)?.rest ?? 0),
    decide: () => ({ action: 'rest', label: '休息' }),
  },
  {
    id: 'chop', name: '伐木', series: 'work', weight: 6,
    utility: () => 30,
    satisfies: [{ desire: 'greed', amount: 2 }],
    decide: () => ({ action: 'walkAndWork', workType: 'chop', label: '伐木' }),
  },
  {
    id: 'mine', name: '采矿', series: 'work', weight: 4,
    utility: () => 25,
    satisfies: [{ desire: 'greed', amount: 2 }],
    decide: () => ({ action: 'walkAndWork', workType: 'mine', label: '采矿' }),
  },
  {
    id: 'caveMine', name: '矿洞采掘', series: 'work', weight: 6,
    condition: (c) => c.view.hasCave(),
    utility: () => 28,
    satisfies: [{ desire: 'greed', amount: 2 }],
    decide: () => ({ action: 'walkAndWork', workType: 'caveMine', label: '矿洞采掘' }),
  },
  {
    id: 'build', name: '建造', series: 'work', weight: 5,
    condition: (c) => c.view.buildQueueCount > 0,
    utility: (c) => c.view.buildQueueCount * 20,
    satisfies: [{ desire: 'greed', amount: 1.5 }],
    decide: () => ({ action: 'walkAndWork', workType: 'build', label: '建造' }),
  },
  {
    id: 'pray', name: '祈祷', series: 'religion', weight: 1,
    condition: (c) => c.view.hasCampfire(),
    utility: () => 6,
    satisfies: [{ desire: 'pride', amount: 2 }],
    decide: () => ({ action: 'pray', label: '祈祷' }),
  },
  {
    id: 'heal', name: '疗伤', series: 'physio', weight: 6,
    condition: (c) => (c.view.healthOf ? (c.view.healthOf(c.eid)?.hp ?? 100) < 70 : false),
    utility: (c) => 70 - (c.view.healthOf ? (c.view.healthOf(c.eid)?.hp ?? 100) : 100),
    decide: () => ({ action: 'heal', label: '疗伤' }),
  },
  {
    id: 'idle', name: '闲逛', series: 'leisure', weight: 2,
    utility: () => 2,
    decide: () => ({ action: 'idle', label: '闲逛' }),
  },
];

// 生成 DNA（确定性：给定 seed）
export function generateDna(seed: number): Dna {
  const rng = new SimRng(seed);
  const roll = (min: number, max: number) => rng.int(min, max);

  const traits: string[] = [];
  const traitCount = rng.int(1, 3);
  const traitPool = ['夜猫子', '热爱工作', '好斗', '虔诚', '懒惰', '强壮', '机灵'];
  for (let i = 0; i < traitCount; i++) {
    const t = rng.pick(traitPool);
    if (!traits.includes(t)) traits.push(t);
  }

  const dna: Dna = {
    str: roll(30, 70),
    con: roll(30, 70),
    int: roll(30, 70),
    siz: roll(30, 70),
    dex: roll(30, 70),
    app: roll(30, 70),
    pow: roll(30, 70),
    edu: roll(30, 70),
    traits,
    maxSlots: 2 + rng.int(0, 2),
    skillBonuses: {},
    sins: {},
  };

  // 天赋 → 属性微调（COC 属性卡，DESIGN §3）
  if (traits.includes('强壮')) { dna.str = Math.min(90, dna.str + 12); dna.siz = Math.min(90, dna.siz + 6); }
  if (traits.includes('机灵')) { dna.int = Math.min(90, dna.int + 10); dna.dex = Math.min(90, dna.dex + 6); }
  if (traits.includes('夜猫子')) dna.pow = Math.min(90, dna.pow + 8);

  // 天赋 → 罪孽倾向（个性权重 0-1）
  const sins: Dna['sins'] = {};
  sins.gluttony = 0.3 + rng.next() * 0.4;
  sins.sloth = 0.3 + rng.next() * 0.4;
  sins.greed = 0.3 + rng.next() * 0.4;
  sins.envy = 0.2 + rng.next() * 0.4;
  sins.pride = 0.3 + rng.next() * 0.4;
  sins.wrath = 0.2 + rng.next() * 0.4;
  sins.lust = 0.2 + rng.next() * 0.4;
  if (traits.includes('懒惰')) sins.sloth = Math.min(1, sins.sloth + 0.3);
  if (traits.includes('好斗')) sins.wrath = Math.min(1, sins.wrath + 0.3);
  if (traits.includes('热爱工作')) sins.sloth = Math.max(0.1, sins.sloth - 0.3);
  if (traits.includes('虔诚')) sins.pride = Math.max(0.1, sins.pride - 0.2);
  dna.sins = sins;

  if (traits.includes('热爱工作')) dna.skillBonuses.work = 1.5;
  if (traits.includes('好斗')) dna.skillBonuses.fight = 1.5;
  if (traits.includes('虔诚')) dna.skillBonuses.faith = 1.5;
  if (traits.includes('机灵')) dna.skillBonuses.craft = 1.2;

  return dna;
}

// 天赋卡
export const TRAIT_CARDS: Record<string, BehaviorCard> = {
  '夜猫子': {
    id: 'trait:夜猫子', name: '夜猫子', series: 'physio', weight: 1,
    condition: (c) => c.view.isNight() && (c.view.needsOf(c.eid)?.rest ?? 0) < 70,
    utility: (c) => 40 - (c.view.needsOf(c.eid)?.rest ?? 0),
    decide: () => ({ action: 'rest', label: '夜间活动' }),
  },
  '热爱工作': {
    id: 'trait:热爱工作', name: '热爱工作', series: 'work', weight: 0,
    utility: () => 0,
    decide: () => ({ action: 'idle', label: '闲逛' }),
  },
  '好斗': {
    id: 'trait:好斗', name: '好斗', series: 'combat', weight: 2,
    condition: () => false,
    utility: () => 0,
    decide: () => ({ action: 'idle', label: '闲逛' }),
  },
  '虔诚': {
    id: 'trait:虔诚', name: '虔诚', series: 'religion', weight: 3,
    condition: (c) => (c.view.needsOf(c.eid)?.mood ?? 0) < 50,
    utility: () => 10,
    decide: () => ({ action: 'pray', label: '祈祷' }),
  },
  '懒惰': {
    id: 'trait:懒惰', name: '懒惰', series: 'leisure', weight: 4,
    utility: () => 12,
    decide: () => ({ action: 'idle', label: '偷懒' }),
  },
  '强壮': {
    id: 'trait:强壮', name: '强壮', series: 'work', weight: 0,
    utility: () => 0,
    decide: () => ({ action: 'idle', label: '闲逛' }),
  },
  '机灵': {
    id: 'trait:机灵', name: '机灵', series: 'work', weight: 0,
    utility: () => 0,
    decide: () => ({ action: 'idle', label: '闲逛' }),
  },
};

// 初始卡池：天赋卡 + mod 卡（全部进入，确保 mod 卡必在池中）+ 基础卡保底
export function initSlots(dna: Dna, extraCards?: BehaviorCard[]): (BehaviorCard | null)[] {
  const slots: (BehaviorCard | null)[] = [];
  const traitCards = dna.traits
    .map((t) => TRAIT_CARDS[t])
    .filter((c): c is BehaviorCard => c !== undefined);
  for (const tc of traitCards) slots.push(tc);
  // mod 卡全部进池（去重排除基础卡；即使超 maxSlots 也保留——抽卡按权重，容量不再挤出 mod 玩法）
  const extra = (extraCards ?? []).filter((c) => !BASE_CARDS.some((b) => b.id === c.id));
  for (const ec of extra) slots.push(ec);
  // 基础卡保底 GUARANTEED_BASE 张（eat/rest/chop）：maxSlots=2 且 2 trait 卡时若无保底 → 小人
  // 没有任何基础卡、永久闲逛（曾实测发生）。保底让"天赋再强也有生存底线"。
  const GUARANTEED_BASE = 3;
  let baseIdx = 0;
  while (baseIdx < GUARANTEED_BASE && baseIdx < BASE_CARDS.length) {
    slots.push(BASE_CARDS[baseIdx++]);
  }
  // 空槽（maxSlots 更大）再继续填
  while (slots.length < dna.maxSlots && baseIdx < BASE_CARDS.length) {
    slots.push(BASE_CARDS[baseIdx++]);
  }
  return slots;
}

// 抽卡：按权重不放回抽 n 张（种子化）
export function drawCards(pawn: PawnLike, rng: SimRng, n: number, ctx: CardContext): BehaviorCard[] {
  const available = pawn.slots.filter((c): c is BehaviorCard => {
    if (!c) return false;
    if (c.condition && !c.condition(ctx)) return false;
    return true;
  });
  if (available.length === 0) return [];
  const pool = [...available];
  const drawn: BehaviorCard[] = [];
  while (pool.length > 0 && drawn.length < n) {
    const weights = pool.map((c) => effectiveWeight(c, pawn, ctx));
    const pick = rng.weightedPick(pool, weights);
    drawn.push(pick);
    pool.splice(pool.indexOf(pick), 1);
  }
  return drawn;
}

// 马尔可夫偏置表：上一事件系列 → 本轮系列权重倍率（DESIGN §6）
// 未列出的默认 1。mod 可扩展。
export const MARKOV_BIAS: Record<string, Record<string, number>> = {
  work:    { leisure: 1.6, physio: 1.4 },   // 干完活想歇
  combat:  { physio: 1.6, work: 1.2 },      // 打完想缓、也容易上头继续干活
  physio:  { work: 1.5, leisure: 1.2 },     // 吃饱睡足想动
  leisure: { work: 1.4 },                    // 闲够了想干点正事
  religion:{ work: 1.2, physio: 1.1 },      // 祈祷完心安
  social:  { leisure: 1.4 },
};

// 指派职业（Q10 生产线）→ 主导工作卡 id
export const JOB_CARD: Record<string, string> = {
  lumberjack: 'chop',
  miner: 'mine',
  farmer: 'build',   // 农田自动产粮，农民负责扩建/维护农田（build）
  crafter: 'build',
};

function effectiveWeight(card: BehaviorCard, pawn: PawnLike, ctx?: CardContext): number {
  let w = card.weight;
  if (pawn.dna.traits.includes('热爱工作') && card.series === 'work') w *= 1.8;
  if (pawn.dna.traits.includes('懒惰') && card.series === 'work') w *= 0.5;
  // 欲望驱动：未满足的欲望 → 对应系列卡权重升高（DESIGN §3）
  if (ctx?.view.desiresOf) {
    const desire = seriesToDesire(card.series);
    if (desire) {
      const d = ctx.view.desiresOf(ctx.eid);
      if (d && d[desire] !== undefined) {
        const hunger = 100 - d[desire];
        if (hunger > 40) w *= 1 + (hunger - 40) / 100; // 匮乏(>40%) → 权重升
      }
    }
  }
  // 环境调制（DESIGN §6）：下雨/酷暑/严寒 → 户外工作低，娱乐高
  const env = ctx?.view.env;
  if (env) {
    if (card.series === 'work') {
      if (env.raining) w *= 0.5;
      if (env.temperature > 32 || env.temperature < 0) w *= 0.6;
    } else if (card.series === 'leisure') {
      if (env.raining) w *= 1.6;
    } else if (card.series === 'physio') {
      if (env.temperature > 32 || env.temperature < 0) w *= 1.3; // 极端天气更想进食/休息
    }
  }
  // 马尔可夫偏置（DESIGN §6）：上一轮干了什么 → 本轮倾向
  const last = ctx?.view.lastSeries;
  if (last && MARKOV_BIAS[last]?.[card.series] !== undefined) {
    w *= MARKOV_BIAS[last][card.series];
  }
  // 派系优先级（用户 Q8）：环境评估下达的工作优先指令，调制对应工作卡权重
  const pri = ctx?.view.factionPriority?.[card.id];
  if (pri !== undefined) w *= pri;
  // 指派职业（Q10）：强制主导对应工作卡，其他工作卡权重压到极低
  const job = ctx?.view.assignedJob;
  if (job) {
    const jobCard = JOB_CARD[job];
    if (jobCard) {
      w *= card.id === jobCard ? 6 : 0.1;
    }
  }
  // 行为倾向（勒沙特列反馈）：按该行为倾向调制权重（自平衡）
  const lean = ctx?.view.leanOf?.(ctx.eid, card.id);
  if (lean !== undefined) w *= lean / 50;
  return w;
}

const seriesToDesire = (series: BehaviorCard['series']): DesireId | null => {
  switch (series) {
    case 'physio': return 'gluttony';
    case 'leisure': return 'sloth';
    case 'work': return 'greed';
    case 'combat': return 'wrath';
    case 'religion': return 'pride';
    default: return null;
  }
};

// 挑收益最高
export function pickBest(drawn: BehaviorCard[], ctx: CardContext): BehaviorCard | null {
  if (drawn.length === 0) return null;
  let best = drawn[0];
  let bestU = -Infinity;
  for (const c of drawn) {
    const u = c.utility ? c.utility(ctx) : c.weight;
    if (u > bestU) { bestU = u; best = c; }
  }
  return best;
}
