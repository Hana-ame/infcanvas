// 简化版 DNA + 插槽系统（P0，纯确定性，无 LLM）
// 完整版设计见 DESIGN.md §小人养成。P0 只实现：
//  - DNA：生成时固定的属性（影响插槽数/属性）
//  - 插槽：每小人固定几个行为卡槽，卡有触发权重，按权重挑"下一个目标"

import { SimRng } from '../core/rng';

export type SkillId = 'work' | 'fight' | 'social' | 'faith' | 'craft';

export interface Dna {
  // COC 简化属性（P0 只留核心几个）
  str: number; // 力量
  con: number; // 体质
  int: number; // 智力
  // 天赋加成（影响插槽/卡）
  traits: string[]; // 天赋名，如 '夜猫子' '热爱工作' '好斗'
  maxSlots: number; // 天生插槽数
  // 概率/判定加成
  skillBonuses: Partial<Record<SkillId, number>>;
}

export interface BehaviorCard {
  id: string;
  name: string;
  series: 'work' | 'combat' | 'social' | 'religion' | 'leisure' | 'physio';
  weight: number; // 基础触发权重
  condition?: (pawn: PawnLike) => boolean; // 触发条件（P0 简化：可选）
  action: 'work' | 'rest' | 'eat' | 'build' | 'haul' | 'pray' | 'idle'; // P0 简化动作
}

export interface PawnLike {
  dna: Dna;
  slots: (BehaviorCard | null)[]; // 插槽，null = 空
}

// 基础卡池（P0 简化，后续扩展）
export const BASE_CARDS: BehaviorCard[] = [
  { id: 'sleep', name: '睡觉', series: 'physio', weight: 8, action: 'rest' },
  { id: 'eat', name: '进食', series: 'physio', weight: 8, action: 'eat' },
  { id: 'work', name: '工作', series: 'work', weight: 6, action: 'work' },
  { id: 'build', name: '建造', series: 'work', weight: 4, action: 'build' },
  { id: 'haul', name: '搬运', series: 'work', weight: 4, action: 'haul' },
  { id: 'pray', name: '祈祷', series: 'religion', weight: 1, action: 'pray' },
  { id: 'idle', name: '闲逛', series: 'leisure', weight: 2, action: 'idle' },
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
    maxSlots: 2 + rng.int(0, 2), // 天生 2-4 槽
    skillBonuses: {},
  };

  // 天赋影响技能加成
  if (traits.includes('热爱工作')) dna.skillBonuses.work = 1.5;
  if (traits.includes('好斗')) dna.skillBonuses.fight = 1.5;
  if (traits.includes('虔诚')) dna.skillBonuses.faith = 1.5;
  if (traits.includes('机灵')) dna.skillBonuses.craft = 1.2;

  return dna;
}

// 初始插槽：填满基础卡（默认），后续神谕/成长可替换
export function initSlots(dna: Dna): (BehaviorCard | null)[] {
  const slots: (BehaviorCard | null)[] = [];
  for (let i = 0; i < dna.maxSlots; i++) {
    const card = i < BASE_CARDS.length ? BASE_CARDS[i] : null;
    slots.push(card);
  }
  return slots;
}

// 按权重挑下一个目标动作（确定性，用给定 rng）
export function pickNextAction(pawn: PawnLike, rng: SimRng): BehaviorCard {
  const filled = pawn.slots.filter((c): c is BehaviorCard => c !== null);
  if (filled.length === 0) return BASE_CARDS.find((c) => c.id === 'idle')!;
  const items = filled;
  const weights = filled.map((c) => c.weight);
  return rng.weightedPick(items, weights);
}
