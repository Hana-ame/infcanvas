// 基础卡数据表（行为卡，数据驱动）—— 卡 = 权重/阈值/收益/意图全声明，
// condition/utility 由共享工厂生成（needAt/utilityBase/utilityFixed/utilityPerQueue/when），
// when 声明式条件谓词（见 CARD_PREDICATES 表），mod 可 registerPredicate 扩展新谓词
// mod 经 ModRegistry.registerCard / overrideDef('card') 增改
import type { BehaviorCardDef, CardContext } from '../ai/pawn';

// 条件谓词表（行为树条件节点）：卡用 when: ['hasCave'] 声明，工厂查表组合 AND
// 机制钩子集中于此：代码只写一次，卡表纯声明 → 卡片 JSON-safe（load 还原不再依赖函数序列化）
export const CARD_PREDICATES: Record<string, (c: CardContext) => boolean> = {
  hasCave: (c) => c.view.hasCave(),
  hasCampfire: (c) => c.view.hasCampfire(),
  buildQueue: (c) => c.view.buildQueueCount > 0,
};

export const BASE_CARD_DEFS: BehaviorCardDef[] = [
  {
    id: 'eat', name: '进食', series: 'physio', weight: 9,
    needAt: { food: 45 },
    utilityBase: 60,
    action: 'eat', label: '进食',
    satisfies: [{ desire: 'gluttony', amount: 2 }],
  },
  {
    id: 'rest', name: '休息', series: 'physio', weight: 8,
    needAt: { rest: 40 },
    utilityBase: 50,
    action: 'rest', label: '休息',
    satisfies: [{ desire: 'sloth', amount: 2 }],
  },
  {
    id: 'chop', name: '伐木', series: 'work', weight: 6,
    utilityFixed: 30,
    action: 'walkAndWork', workType: 'chop', label: '伐木',
    satisfies: [{ desire: 'greed', amount: 2 }],
  },
  {
    id: 'mine', name: '采矿', series: 'work', weight: 4,
    utilityFixed: 25,
    action: 'walkAndWork', workType: 'mine', label: '采矿',
    satisfies: [{ desire: 'greed', amount: 2 }],
  },
  {
    id: 'caveMine', name: '矿洞采掘', series: 'work', weight: 6,
    utilityFixed: 28,
    when: ['hasCave'],
    action: 'walkAndWork', workType: 'caveMine', label: '矿洞采掘',
    satisfies: [{ desire: 'greed', amount: 2 }],
  },
  {
    id: 'build', name: '建造', series: 'work', weight: 5,
    utilityPerQueue: 20,
    when: ['buildQueue'],
    action: 'walkAndWork', workType: 'build', label: '建造',
    satisfies: [{ desire: 'greed', amount: 1.5 }],
  },
  {
    id: 'pray', name: '祈祷', series: 'religion', weight: 1,
    utilityFixed: 6,
    when: ['hasCampfire'],
    action: 'pray', label: '祈祷',
    satisfies: [{ desire: 'pride', amount: 2 }],
  },
  {
    id: 'heal', name: '疗伤', series: 'physio', weight: 6,
    needAt: { hp: 70 },
    utilityBase: 70,
    action: 'heal', label: '疗伤',
  },
  {
    id: 'idle', name: '闲逛', series: 'leisure', weight: 2,
    utilityFixed: 2,
    action: 'idle', label: '闲逛',
  },
];