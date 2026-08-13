// 兴趣属性表（数据驱动，v2026-08-13「兴趣驱动娱乐」设计落地）
//
// 起因：试玩分析发现 toy（玩具建筑）被反复建造 39 次（建造次数统计：toy:39 / well:2 / house:1），
//       木头因此吃光。第一次修复尝试加「buildMinWood 游牧期门槛」拦截全部科技建筑建造，
//       被用户否决——「神经病，肯定是建造toy的意愿降低啊」→ 治标不如治本。
// 经过：根因是娱乐活动被写死成固定小卡池（idle 闲逛 + explore 探索），探索卡权重高、人人可中，
//       建筑被狼拆（hp40）后谓词转 true 又触发重建 → 全营地统一反复建 toy。
// 结果（本文件）：娱乐改为「开放活动空间」——娱乐可以做任何事情，做什么由 pawn 兴趣属性决定：
//   - 每人随机 1-3 个兴趣（generateDna 按 weight 抽选，interestsMin/interestsRange 读 tuning.pawn）
//   - 兴趣带专属休闲卡（card）进卡槽（initSlots）——娱乐时做自己感兴趣的事
//   - 卡可声明 interest 标记（如 explore 卡标 build），ruleInterest 按 pawn.interests 调制权重：
//     有兴趣 ×weightMul（表驱动），无兴趣 ÷weightMul → 不感兴趣就不做（从架构杜绝重复循环）
// 机制（消费方）：generateDna → initSlots → ruleInterest（weightRules.ts）
// mod 扩展：registerInterest 加新兴趣（含休闲卡/权重倍率），generateDna/initSlots 自动接入
import type { BehaviorCardDef } from '../ai/pawn';

export interface InterestDef {
  id: string;
  label: string;          // 兴趣名（HUD/日志显示）
  weight: number;         // 出生抽选权重
  card?: BehaviorCardDef; // 专属休闲卡（该兴趣的娱乐活动，leisure 系列，进卡槽）
  weightMul?: number;     // 该兴趣对应卡的权重倍率（card.interest===id 的卡 ×此值；缺省 1）
  desc?: string;
}

// 内建兴趣（mod 经 ModRegistry.registerInterest 追加，跨实例共享）
export const INTERESTS: Record<string, InterestDef> = {
  gather: {
    id: 'gather', label: '采集', weight: 2,
    card: {
      id: 'interest:gather', name: '采集', series: 'leisure', weight: 3,
      utilityFixed: 8, action: 'walkAndWork', workType: 'chop', label: '采集',
      satisfies: [{ desire: 'sloth', amount: 1 }],
    },
  },
  mine: {
    id: 'mine', label: '采矿', weight: 1.5,
    card: {
      id: 'interest:mine', name: '采矿', series: 'leisure', weight: 3,
      utilityFixed: 8, action: 'walkAndWork', workType: 'mine', label: '挖矿',
      satisfies: [{ desire: 'greed', amount: 1 }],
    },
  },
  fish: {
    id: 'fish', label: '钓鱼', weight: 1.5,
    card: {
      id: 'interest:fish', name: '钓鱼', series: 'leisure', weight: 3,
      utilityFixed: 10, action: 'walkAndWork', workType: 'fish', label: '钓鱼',
      satisfies: [{ desire: 'gluttony', amount: 1 }],
    },
  },
  build: {
    id: 'build', label: '建造', weight: 2, weightMul: 3,
    // 建造兴趣无专属休闲卡——靠 explore 卡（兴趣标记 build，见 defs/explore.ts）高权重触发「灵光一现」。
    // 背景（v2026-08-13）：探索卡若人人权重一致，全营地会统一反复建 toy（39 次吃光木头）。
    // 只有有建造兴趣的 pawn 探索权重 ×3，其余 ÷3 → 建造成为「少数人的娱乐活动」。
  },
  pray: {
    id: 'pray', label: '祈祷', weight: 1.5,
    card: {
      id: 'interest:pray', name: '静心', series: 'leisure', weight: 3,
      utilityFixed: 6, action: 'pray', label: '静心',
      satisfies: [{ desire: 'pride', amount: 1 }],
    },
  },
  wander: {
    id: 'wander', label: '漫游', weight: 2,
    card: {
      id: 'interest:wander', name: '漫游', series: 'leisure', weight: 3,
      utilityFixed: 4, action: 'idle', label: '漫游',
      satisfies: [{ desire: 'sloth', amount: 1 }],
    },
  },
  rest: {
    id: 'rest', label: '休憩', weight: 1.5,
    card: {
      id: 'interest:rest', name: '休憩', series: 'leisure', weight: 3,
      utilityFixed: 6, action: 'rest', label: '休憩',
      satisfies: [{ desire: 'sloth', amount: 1 }],
    },
  },
};

// 动态取兴趣目录（registerInterest 后生效，勿缓存 Object.keys 结果）
export function allInterests(): string[] {
  return Object.keys(INTERESTS);
}
