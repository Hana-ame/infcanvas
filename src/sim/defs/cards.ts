// 基础卡数据表（行为卡，数据驱动）—— 卡 = 权重/阈值/收益/意图全声明，
// condition/utility 由共享工厂生成（needAt/utilityBase/utilityFixed/utilityPerQueue），
// 仅剩的代码是 decide 无法数据化的机制函数（hasCave/hasCampfire 等条件）
// mod 经 ModRegistry.registerCard / overrideDef('card') 增改
import type { BehaviorCardDef } from '../ai/pawn';

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
    condition: (c) => c.view.hasCave(),
    action: 'walkAndWork', workType: 'caveMine', label: '矿洞采掘',
    satisfies: [{ desire: 'greed', amount: 2 }],
  },
  {
    id: 'build', name: '建造', series: 'work', weight: 5,
    utilityPerQueue: 20,
    condition: (c) => c.view.buildQueueCount > 0,
    action: 'walkAndWork', workType: 'build', label: '建造',
    satisfies: [{ desire: 'greed', amount: 1.5 }],
  },
  {
    id: 'pray', name: '祈祷', series: 'religion', weight: 1,
    utilityFixed: 6,
    condition: (c) => c.view.hasCampfire(),
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