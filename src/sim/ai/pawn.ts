// 数据驱动行为卡系统 —— 卡产"意图"，行为系统执行（mod 友好）
// 设计：卡 = 数据 + 条件 + 收益 + 决策(intent)。意图由统一 BehaviorSystem 消化成走位/工作。
// 加新卡 = 定义一张卡（含 condition/utility/intent），不改任何分发逻辑。

import { SimRng } from '../core/rng';

export type SkillId = 'work' | 'fight' | 'social' | 'faith' | 'craft';

export interface Dna {
  str: number;
  con: number;
  int: number;
  traits: string[];
  maxSlots: number;
  skillBonuses: Partial<Record<SkillId, number>>;
}

// 卡决策可读的 sim 信息（只读，决策用）
export interface CardView {
  needsOf(eid: number): { food: number; rest: number; mood: number } | null;
  healthOf?(eid: number): { hp: number; maxHp: number } | null;
  isNight(): boolean;
  hasCampfire(): boolean;
  hasCave(): boolean;
  buildQueueCount: number;
  stockpile: Record<string, number>;
}

export interface CardContext {
  view: CardView;
  eid: number;
}

// 行为意图：卡决策产出，由 BehaviorSystem 执行
export type IntentAction = 'walkAndWork' | 'eat' | 'rest' | 'pray' | 'heal' | 'idle';

export interface BehaviorIntent {
  action: IntentAction;
  workType?: 'chop' | 'mine' | 'caveMine' | 'build'; // walkAndWork 用
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
    decide: () => ({ action: 'walkAndWork', workType: 'chop', label: '伐木' }),
  },
  {
    id: 'mine', name: '采矿', series: 'work', weight: 4,
    utility: () => 25,
    decide: () => ({ action: 'walkAndWork', workType: 'mine', label: '采矿' }),
  },
  {
    id: 'caveMine', name: '矿洞采掘', series: 'work', weight: 6,
    condition: (c) => c.view.hasCave(),
    utility: () => 28,
    decide: () => ({ action: 'walkAndWork', workType: 'caveMine', label: '矿洞采掘' }),
  },
  {
    id: 'build', name: '建造', series: 'work', weight: 5,
    condition: (c) => c.view.buildQueueCount > 0,
    utility: (c) => c.view.buildQueueCount * 20,
    decide: () => ({ action: 'walkAndWork', workType: 'build', label: '建造' }),
  },
  {
    id: 'pray', name: '祈祷', series: 'religion', weight: 1,
    condition: (c) => c.view.hasCampfire(),
    utility: () => 6,
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
    traits,
    maxSlots: 2 + rng.int(0, 2),
    skillBonuses: {},
  };

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

// 初始卡池：天赋卡 + 基础卡
export function initSlots(dna: Dna): (BehaviorCard | null)[] {
  const slots: (BehaviorCard | null)[] = [];
  const traitCards = dna.traits
    .map((t) => TRAIT_CARDS[t])
    .filter((c): c is BehaviorCard => c !== undefined);
  for (const tc of traitCards) slots.push(tc);
  let baseIdx = 0;
  while (slots.length < dna.maxSlots && baseIdx < BASE_CARDS.length) {
    slots.push(BASE_CARDS[baseIdx++]);
  }
  while (slots.length < dna.maxSlots) {
    slots.push(BASE_CARDS[0]);
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
    const weights = pool.map((c) => effectiveWeight(c, pawn));
    const pick = rng.weightedPick(pool, weights);
    drawn.push(pick);
    pool.splice(pool.indexOf(pick), 1);
  }
  return drawn;
}

function effectiveWeight(card: BehaviorCard, pawn: PawnLike): number {
  let w = card.weight;
  if (pawn.dna.traits.includes('热爱工作') && card.series === 'work') w *= 1.8;
  if (pawn.dna.traits.includes('懒惰') && card.series === 'work') w *= 0.5;
  return w;
}

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
