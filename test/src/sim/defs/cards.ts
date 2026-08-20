// 基础卡数据表（行为卡，数据驱动）—— 卡 = 权重/阈值/收益/意图全声明，
// condition/utility 由共享工厂生成（needAt/utilityBase/utilityFixed/utilityPerQueue/when），
// when 声明式条件谓词（见 CARD_PREDICATES 表），mod 可 registerPredicate 扩展新谓词
// mod 经 ModRegistry.registerCard / overrideDef('card') 增改
import type { BehaviorCardDef, CardContext } from '../ai/pawn';

// 条件谓词表（行为树条件节点）：卡用 when: ['hasCave'] 声明，工厂查表组合 AND
// 机制钩子集中于此：代码只写一次，卡表纯声明 → 卡片 JSON-safe（load 还原不再依赖函数序列化）
export const CARD_PREDICATES: Record<string, (c: CardContext) => boolean> = {
  hasCave: (c) => c.view.hasCave(),
  hasRaft: (c) => c.view.hasRaft(),
  hasCampfire: (c) => c.view.hasCampfire(),
  buildQueue: (c) => c.view.buildQueueCount > 0,
};

// 基础卡表（消费方：pawn.initSlots 保底进池 + drawCards 抽卡；卡 id 同时是 weightRules priority 规则、
// jobs 职业主导卡、leans 学习轨道引用的 key，改名需同步三处）
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
    id: 'fish', name: '捕鱼', series: 'work', weight: 10, // 2026-08-20: 5→10 提高钓鱼权重（原与伐木同级, 但水少 → 被压制）
    utilityFixed: 32, // 2026-08-20: 26→32 高于伐木(30) → 指派渔民后优先钓鱼
    when: [], // 2026-08-20 平衡：移除 hasRaft 门槛 → 早期可在水边直接钓鱼（原需竹筏太晚才解锁）
    action: 'walkAndWork', workType: 'fish', label: '捕鱼',
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
      id: 'help', name: '互助', series: 'social', weight: 12,
      // 2026-08-14 用户设计：小人对小人好感高 → 帮忙（满足对方食物/娱乐需求）。
      // 条件：附近有"缺食/受伤/低落"且我对 TA 好感 ≥ helpFriendAt 的邻人。
      // 纯声明式：condition/utility 用 helpTargetOf 探测（决策链解耦，mod 可覆盖/禁用此卡）。
      condition: (c) => {
        // 自身危急时不帮（先自救）：食物/休息告急 → 互助卡不可选
        const my = c.view.needsOf(c.eid);
        const s = c.view.tuning?.social;
        if (my && s && (my.food < s.helpFoodNeedAt || my.mood < s.helpMoodNeedAt)) return false;
        return (c.view.helpTargetOf?.(c.eid) ?? null) !== null;
      },
      extraUtility: (c) => {
        const t = c.view.helpTargetOf?.(c.eid);
        if (t === null || t === undefined) return 0;
        // 弱势程度越高收益越高（缺食 > 受伤 > 低落，与 findHelpTarget 评分一致）；
        // 濒死邻人 (food→0 / hp→0) 时收益远超常规工作 → 利他优先
        const need = c.view.needsOf(t);
        const hp = c.view.healthOf?.(t);
        const s = c.view.tuning?.social;
        let u = 20; // 基础利他倾向（高于普通工作的 30？→ 用 +20 起步，濒死更高）
        if (need && s && need.food < s.helpFoodNeedAt) u += (40 - need.food) * 3;
        if (hp && s && hp.hp < s.helpHpNeedAt) u += (60 - hp.hp) * 2;
        if (need && s && need.mood < s.helpMoodNeedAt) u += (30 - need.mood) * 1.5;
        return u;
      },
      action: 'help', label: '互助',
      satisfies: [{ desire: 'pride', amount: 1 }], // 助人为乐 → 傲慢满足
    },
    { id: 'idle', name: '闲逛', series: 'leisure', weight: 2,
    utilityFixed: 2,
    action: 'idle', label: '闲逛',
  },
];