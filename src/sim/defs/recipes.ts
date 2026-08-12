// 生产配方（RecipeDef）—— 数据驱动生产（DESIGN docs/DATA_DRIVEN.md §3.2）
// 生产 = 查配方，系统通用执行。mod 注册新配方 = 新生产玩法。
import type { SkillId } from '../ai/pawn';

// 生产配方三种形态：
//   passive：无需小人，建筑按秒持续产出（农田）→ output.amount = 每秒量
//   batch：  无需小人，每 interval 秒消耗 input、产出 output（工作台）
//   work：   需小人到建筑工作，每 interval 秒做一次检定，成功产 output、失败产 failOutput（矿洞）
export interface RecipeDef {
  id: string;
  name: string;
  kind: 'passive' | 'batch' | 'work';
  input?: { item: string; amount: number }[];
  output: { item: string; amount: number };
  failOutput?: { item: string; amount: number };
  interval?: number;   // batch/work：每几秒一轮
  skill?: SkillId;     // work：检定技能（默认 work）
  dc?: number;         // work：检定 DC（默认 60）
}

// 配方表（消费方：farm 类 passive 由 FarmSystem 读、workbench 类 batch 由 CraftSystem 读、
// cave/fishing 类 work 由行为系统走位到建筑后检定产出；mod 注册新配方 = 新生产玩法）
export const RECIPES: Record<string, RecipeDef> = {
  farm: {
    id: 'farm', name: '农田产出', kind: 'passive',
    output: { item: 'food', amount: 0.2 },
  },
  workbench: {
    id: 'workbench', name: '制作工具', kind: 'batch',
    input: [{ item: 'wood', amount: 5 }],
    output: { item: 'tools', amount: 1 },
    interval: 6,
  },
  cave: {
    id: 'cave', name: '矿洞采掘', kind: 'work',
    output: { item: 'ore', amount: 2 },
    failOutput: { item: 'ore', amount: 1 },
    interval: 4,
    skill: 'work',
    dc: 70,
  },
  fishing: {
    id: 'fishing', name: '捕鱼', kind: 'work',
    output: { item: 'food', amount: 3 },
    failOutput: { item: 'food', amount: 1 },
    interval: 6,
    skill: 'work',
    dc: 55,
  },
};
