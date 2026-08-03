// 数据驱动行为卡系统（P0 实现 DESIGN.md §插槽系统 执行模型）
// 执行模型：定时 check → 按权重抽 3 张（不放回，种子化）→ 挑收益最高 1 张执行
// 每小人一个卡池（槽位）：基础卡 + 天赋卡。LLM 印卡 / 神谕插卡 是后续阶段。

import { SimRng } from '../core/rng';

export type SkillId = 'work' | 'fight' | 'social' | 'faith' | 'craft';

export interface Dna {
  str: number; // 力量
  con: number; // 体质
  int: number; // 智力
  traits: string[]; // 天赋名
  maxSlots: number; // 天生插槽数
  skillBonuses: Partial<Record<SkillId, number>>;
}

// 行为卡动作（Sim 解释执行）
export type CardAction =
  | 'chop'   // 伐木
  | 'mine'   // 采矿
  | 'build'  // 建造（去蓝图处施工）
  | 'eat'    // 进食
  | 'rest'   // 休息
  | 'pray'   // 祈祷（去篝火/教堂）
  | 'idle'   // 闲逛
  | 'haul';  // 搬运

export interface CardContext {
  sim: {
    buildQueueCount: number;
    stockpile: Record<string, number>;
    needsOf: (eid: number) => { food: number; rest: number; mood: number } | null;
    isNight: () => boolean;
  };
  eid: number;
}

export interface BehaviorCard {
  id: string;
  name: string;
  series: 'work' | 'combat' | 'social' | 'religion' | 'leisure' | 'physio';
  weight: number; // 基础触发权重
  action: CardAction;
  // 条件：false = 这张卡当前不可选
  condition?: (ctx: CardContext) => boolean;
  // 收益：用于抽3选1时挑最高收益（数字越高越优先执行）
  utility?: (ctx: CardContext) => number;
}

export interface PawnLike {
  dna: Dna;
  slots: (BehaviorCard | null)[]; // 卡池（槽位）
}

// 基础卡池（数据驱动，后续由天赋/神谕/LLM 扩展）
export const BASE_CARDS: BehaviorCard[] = [
  { id: 'eat', name: '进食', series: 'physio', weight: 9, action: 'eat',
    condition: (c) => (c.sim.needsOf(c.eid)?.food ?? 0) < 45,
    utility: (c) => 60 - (c.sim.needsOf(c.eid)?.food ?? 0) },
  { id: 'rest', name: '休息', series: 'physio', weight: 8, action: 'rest',
    condition: (c) => (c.sim.needsOf(c.eid)?.rest ?? 0) < 40,
    utility: (c) => 50 - (c.sim.needsOf(c.eid)?.rest ?? 0) },
  { id: 'chop', name: '伐木', series: 'work', weight: 6, action: 'chop',
    utility: () => 30 },
  { id: 'mine', name: '采矿', series: 'work', weight: 4, action: 'mine',
    utility: () => 25 },
  { id: 'build', name: '建造', series: 'work', weight: 5, action: 'build',
    condition: (c) => c.sim.buildQueueCount > 0,
    utility: (c) => c.sim.buildQueueCount * 20 },
  { id: 'pray', name: '祈祷', series: 'religion', weight: 1, action: 'pray',
    condition: () => false, // 无教堂前不可选（后续启用）
    utility: () => 5 },
  { id: 'idle', name: '闲逛', series: 'leisure', weight: 2, action: 'idle',
    utility: () => 2 },
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

// 初始卡池：填满基础卡（后续神谕/成长可替换/插入天赋卡）
export function initSlots(dna: Dna): (BehaviorCard | null)[] {
  const slots: (BehaviorCard | null)[] = [];
  for (let i = 0; i < dna.maxSlots; i++) {
    const card = i < BASE_CARDS.length ? BASE_CARDS[i] : null;
    slots.push(card);
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
  // 不放回抽 n 张：每次按权重抽一张，从池中移除
  const pool = [...available];
  const drawn: BehaviorCard[] = [];
  while (pool.length > 0 && drawn.length < n) {
    const weights = pool.map((c) => c.weight);
    const pick = rng.weightedPick(pool, weights);
    drawn.push(pick);
    pool.splice(pool.indexOf(pick), 1);
  }
  return drawn;
}

// 挑收益最高的 1 张执行
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
