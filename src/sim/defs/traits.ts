// 天赋表（数据驱动）—— 天赋 = 数据（属性微调/罪孽倾向/技能加成/权重倍率/天赋卡），
// 生成与调制逻辑全读表（mod 可 registerTrait 加新天赋、overrideTrait 调整数值）
import type { SkillId } from '../ai/pawn';
import type { DesireId } from '../core/desires';
import type { CardContext } from '../ai/pawn';

export type AttrKey = 'str' | 'con' | 'int' | 'siz' | 'dex' | 'app' | 'pow' | 'edu';

// 天赋卡数据（声明式：needAt/utilityBase 生成 condition/utility，action 决定行为）
export interface TraitCardData {
  id: string;
  name: string;
  series: string;
  weight: number;
  needAt?: Partial<{ food: number; rest: number; mood: number; hp: number }>; // 需求触发阈值
  utilityBase?: number;   // utility = utilityBase - 对应需求值（needAt 首个键）
  utilityFixed?: number;  // 固定收益
  action: string;         // IntentAction（eat/rest/pray/idle/walkAndWork…）
  workType?: string;      // walkAndWork 用
  label: string;
  condition?: (c: CardContext) => boolean; // needAt 之外的自定义条件
  satisfies?: { desire: DesireId; amount: number }[];
  desire?: DesireId;
}

export interface TraitDef {
  id: string;
  label: string;
  weight: number;         // 出生抽选权重
  statMods?: Partial<Record<AttrKey, number>>;     // 属性微调（COC 属性卡）
  sinMods?: Partial<Record<DesireId, number>>;     // 罪孽倾向修正
  skillBonuses?: Partial<Record<SkillId, number>>; // 技能加成
  weightMuls?: Record<string, number>;             // 抽卡权重倍率（series → 倍率）
  card?: TraitCardData;   // 天赋卡（进卡池）
}

// 内建天赋（mod 扩展经 ModRegistry.registerTrait，跨实例共享）
export const TRAITS: Record<string, TraitDef> = {
  '夜猫子': {
    id: '夜猫子', label: '夜猫子', weight: 1,
    statMods: { pow: 8 },
    card: {
      id: 'trait:夜猫子', name: '夜猫子', series: 'physio', weight: 1,
      needAt: { rest: 70 }, utilityBase: 40,
      action: 'rest', label: '夜间活动',
    },
  },
  '热爱工作': {
    id: '热爱工作', label: '热爱工作', weight: 2,
    sinMods: { sloth: -0.3 },
    skillBonuses: { work: 1.5 },
    weightMuls: { work: 1.8 },
    card: { id: 'trait:热爱工作', name: '热爱工作', series: 'work', weight: 0, utilityFixed: 0, action: 'idle', label: '闲逛' },
  },
  '好斗': {
    id: '好斗', label: '好斗', weight: 1,
    sinMods: { wrath: 0.3 },
    skillBonuses: { fight: 1.5 },
    card: { id: 'trait:好斗', name: '好斗', series: 'combat', weight: 2, utilityFixed: 0, action: 'idle', label: '闲逛', condition: () => false },
  },
  '虔诚': {
    id: '虔诚', label: '虔诚', weight: 1,
    sinMods: { pride: -0.2 },
    skillBonuses: { faith: 1.5 },
    card: {
      id: 'trait:虔诚', name: '虔诚', series: 'religion', weight: 3,
      needAt: { mood: 50 }, utilityBase: 10,
      action: 'pray', label: '祈祷',
    },
  },
  '懒惰': {
    id: '懒惰', label: '懒惰', weight: 2,
    sinMods: { sloth: 0.3 },
    weightMuls: { work: 0.5 },
    card: { id: 'trait:懒惰', name: '懒惰', series: 'leisure', weight: 4, utilityFixed: 12, action: 'idle', label: '偷懒' },
  },
  '强壮': {
    id: '强壮', label: '强壮', weight: 1,
    statMods: { str: 12, siz: 6 },
    card: { id: 'trait:强壮', name: '强壮', series: 'work', weight: 0, utilityFixed: 0, action: 'idle', label: '闲逛' },
  },
  '机灵': {
    id: '机灵', label: '机灵', weight: 1,
    statMods: { int: 10, dex: 6 },
    skillBonuses: { craft: 1.2 },
    card: { id: 'trait:机灵', name: '机灵', series: 'work', weight: 0, utilityFixed: 0, action: 'idle', label: '闲逛' },
  },
};

// 动态取天赋目录（registerTrait 后生效）
export function allTraits(): string[] {
  return Object.keys(TRAITS);
}