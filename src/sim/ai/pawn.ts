// 数据驱动行为卡系统 —— 卡产"意图"，行为系统执行（mod 友好）
// 设计：卡 = 数据表（权重/阈值/收益/意图）+ 统一工厂生成 condition/utility/decide
// 玩法数值全部在 defs（卡片表）+ tuning；本文件只剩机制（抽卡/权重合成/生成流程）
// 加新卡 = defs/cards.ts 加一行（或 ModRegistry.registerCard），不改分发逻辑

import { SimRng } from '../core/rng';
import type { DesireId } from '../core/desires';
import { allDesires } from '../core/desires';
import { TRAITS, allTraits, type AttrKey, type TraitDef } from '../defs/traits';
import { INTERESTS, allInterests } from '../defs/interests';
import { MARKOV_BIAS, SERIES_TO_DESIRE } from '../defs/behavior';
import { TUNING, type PawnTuning, type DesireTuning, type TuningConfig } from '../defs/tuning';
import { BASE_CARD_DEFS } from '../defs/cards';
import { cardPredicateOf, weightRulesOf } from '../mods/registry';
import { JOBS } from '../defs/jobs';

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
  interests: string[]; // 兴趣属性（表驱动：娱乐活动由兴趣决定做什么，用户 2026-08-13）
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
  hasRaft(): boolean;
  // 通用建筑 tag 查询（mod 谓词注册口：registerPredicate 里可查任意建筑 tag）
  hasBuildingWithTag?(tag: string): boolean;
  // 已解锁科技（探索卡谓词 hasTech-xxx 用）
  techs?: ReadonlySet<string>;
  buildQueueCount: number;
  stockpile: Record<string, number>;
  desiresOf?(eid: number): Record<DesireId, number> | null;
  // 环境调制（DESIGN §6）：下雨 → 户外工作低、娱乐高；酷暑/严寒 → 户外工作低
  env?: { raining: boolean; temperature: number };
  // 马尔可夫偏置（DESIGN §6）：上一事件系列 → 本轮权重偏置
  lastSeries?: string;
  // 派系优先级（用户 Q8：AI 按环境下达工作优先指令）：workType → 权重倍率
  factionPriority?: Record<string, number>;
  // 神谕目标（影响目标层）：{ workType, label, until }——目标对应工作系列权重放大
  oracleGoal?: { workType: string; label: string; until: number } | null;
  // 指派职业（Q10 生产线）：当前小人固定从事的工作
  assignedJob?: string;
  // 行为结果学习（EWA 吸引模型）：经验记忆（期望收益）→ 权重倍率（1=中性，>1 偏做，<1 回避）
  leanOf?(eid: number, key: string): number;
  // 个人经济预期（按工作类型）：这个活预期能赚多少 → 经济理性调制工作选择
  expectEarnOf?(eid: number, workType: string): number;
  // 全量平衡参数（只读；卡组/mod 卡可读阈值/倍率做决策）
  tuning?: TuningConfig;
  // 马尔可夫偏置表（registry 替身，mod 可覆盖/扩展）
  markovBias?: Record<string, Record<string, number>>;
  // 指派职业 → 主导工作卡（registry 替身，mod 可注册新职业）
  jobCards?: Record<string, string>;
  // 系列默认欲望映射（registry 替身；卡 declare desire 优先）
  desireOfSeries?(series: string): DesireId | null;
  // 互助探测（2026-08-14 互助卡）：返回附近值得帮的弱势邻人 eid（缺食/受伤/低落 + 我好感高）
  // null = 无值得帮的邻人。卡 condition 用它，execHelp 执行送食/陪伴/疗伤。
  helpTargetOf?(eid: number): number | null;
}

export interface CardContext {
  view: CardView;
  eid: number;
}

// 行为意图：卡决策产出，由 BehaviorSystem 执行。
// action 开放为 string：内置 walkAndWork/eat/rest/pray/heal/idle；
// mod 卡 decide 可产出自定义 action，配套 registerIntent(id, executor) 注册执行器即生效（见 cardSystem）
export type IntentAction = string;

export interface BehaviorIntent {
  action: IntentAction;
  workType?: string; // walkAndWork 用（开放字符串：内置 chop/mine/caveMine/build，mod 可注册新工作类型）
  label: string; // 显示的工作名
}

// 卡：数据 + 条件 + 收益 + 决策（产 intent）
export interface BehaviorCard {
  id: string;
  name: string;
  // 系列开放为 string：内置 work/combat/social/religion/leisure/physio；
  // MARKOV_BIAS 按 key 查（未列出默认 1）；火焰'work'等比较为字面量、兼容自定义系列
  series: string;
  weight: number;
  condition?: (ctx: CardContext) => boolean;
  utility?: (ctx: CardContext) => number;
  // 满足欲望声明（数据驱动）：卡被选中执行后满足对应欲望（mod 新工作卡可声明，替代文案匹配）
  satisfies?: { desire: DesireId; amount: number }[];
  // 欲望关联声明：匮乏时升该类卡权重（缺省按系列映射：work→greed 等；mod 新欲望可用此字段直接挂钩）
  desire?: DesireId;
  // 兴趣关联（娱乐开放活动：卡属于哪个兴趣；ruleInterest 按 pawn.interests 调制权重）
  interest?: string;
  // 熟练度（P0.5 卡演化：卡=习惯的建模）：触发↑、长期不用↓，权重调制 ×(0.5+mastery/100)
  // 注意：卡实例必须按小人独立（initSlots 克隆），否则共享单例互相污染
  mastery?: number;
  lastUsed?: number;
  decide(ctx: CardContext): BehaviorIntent;
}

// 声明式卡数据（数据驱动核心）：工厂把 needAt/utility* 生成 condition/utility
export interface BehaviorCardDef {
  id: string;
  name: string;
  series: string;
  weight: number;
  needAt?: Partial<{ food: number; rest: number; mood: number; hp: number }>; // 需求触发阈值
  utilityBase?: number;    // utility = utilityBase - 对应需求值（needAt 首个键）
  utilityFixed?: number;   // 固定收益
  utilityPerQueue?: number; // utility = 建造队列长度 × 此值
  action: IntentAction;    // 意图（eat/rest/pray/heal/idle/walkAndWork…）
  workType?: string;       // walkAndWork 用
  label: string;           // 显示的工作名
  reason?: string;         // 印卡原因（LLM/反馈层填，UI 展示）
  satisfies?: { desire: DesireId; amount: number }[];
  desire?: DesireId;
  interest?: string; // 兴趣关联（ruleInterest 按 pawn.interests 调制；mod 卡可声明）
  when?: string[]; // 声明式条件谓词（CARD_PREDICATES 表查，AND 组合；mod 可 registerPredicate 扩展）
  condition?: (c: CardContext) => boolean; // needAt/when 之外的自定义条件
  extraUtility?: (c: CardContext) => number; // 叠加收益（与 need/queue 合并）
}

// 卡工厂：声明式数据 → 行为卡（condition/utility/decide 统一生成）
// condition = when 谓词 AND 需求阈值 AND 自定义条件（全声明组合，谓词表集中机制钩子）
export function cardFromDef(def: BehaviorCardDef): BehaviorCard {
  const conds: ((c: CardContext) => boolean)[] = [];
  if (def.when?.length) {
    const preds = def.when.map((pid) => cardPredicateOf(pid));
    conds.push((c) => preds.every((p) => p(c)));
  }
  let utility: ((c: CardContext) => number) | undefined = def.utilityFixed !== undefined ? () => def.utilityFixed! : undefined;
  // 需求阈值：condition = 需求 < 阈值；utility = utilityBase - 需求值
  const needKey = def.needAt ? (Object.keys(def.needAt)[0] as 'food' | 'rest' | 'mood' | 'hp') : null;
  if (needKey && def.needAt) {
    const at = def.needAt[needKey]!;
    const readNeed = (c: CardContext): number => {
      if (needKey === 'hp') return c.view.healthOf?.(c.eid)?.hp ?? 100;
      return c.view.needsOf(c.eid)?.[needKey] ?? 100;
    };
    conds.push((c) => readNeed(c) < at);
    if (def.utilityBase !== undefined) {
      utility = (c) => def.utilityBase! - readNeed(c);
    }
  }
  // 建造队列收益（未声明条件时自带队列非空条件，向后兼容旧式卡）
  if (def.utilityPerQueue !== undefined) {
    if (!def.when && !def.condition) conds.push((c) => c.view.buildQueueCount > 0);
    utility = (c) => c.view.buildQueueCount * def.utilityPerQueue!;
  }
  if (!utility && def.extraUtility) utility = def.extraUtility;
  const condition = conds.length > 0 ? (c: CardContext) => conds.every((f) => f(c)) : undefined;
  return {
    id: def.id, name: def.name, series: def.series, weight: def.weight,
    condition, utility,
    satisfies: def.satisfies, desire: def.desire, interest: def.interest,
    mastery: 0, lastUsed: 0,
    decide: () => ({ action: def.action, workType: def.workType, label: def.label }),
  };
}

export interface PawnLike {
  dna: Dna;
  slots: (BehaviorCard | null)[];
}

// ---- 基础卡池（数据表在 defs/cards.ts，工厂生成）----
export const BASE_CARDS: BehaviorCard[] = BASE_CARD_DEFS.map(cardFromDef);

// 天赋卡池（数据表在 defs/traits.ts；动态生成——registerTrait 后新天赋卡自动生效）
export const TRAIT_CARDS: Record<string, BehaviorCard> = Object.fromEntries(
  allTraits().filter((id) => TRAITS[id]?.card).map((id) => [id, traitCardOf(TRAITS[id]!)]),
);

function traitCardOf(t: TraitDef): BehaviorCard {
  return cardFromDef({ ...t.card!, id: t.card!.id, name: t.card!.name, series: t.card!.series, weight: t.card!.weight });
}

// 生成 DNA（确定性：给定 seed）；出生参数全读 tuning
export function generateDna(
  seed: number,
  t?: PawnTuning & Pick<DesireTuning, 'sinInitMin' | 'sinInitRange' | 'sinFloor'>,
): Dna {
  const cfg = t ?? { ...TUNING.pawn, sinInitMin: TUNING.desire.sinInitMin, sinInitRange: TUNING.desire.sinInitRange, sinFloor: TUNING.desire.sinFloor };
  const rng = new SimRng(seed);
  const roll = (min: number, max: number) => rng.int(min, max);

  // 天赋抽选（按表 weight 加权；同人不重复）
  const traits: string[] = [];
  const traitCount = rng.int(cfg.traitCountMin, cfg.traitCountMax);
  const pool = allTraits().filter((id) => TRAITS[id] !== undefined);
  for (let i = 0; i < traitCount; i++) {
    const cand = pool.filter((id) => !traits.includes(id));
    if (cand.length === 0) break;
    const weights = cand.map((id) => TRAITS[id].weight);
    const picked = rng.weightedPick(cand, weights);
    if (picked) traits.push(picked);
  }

  // 兴趣抽选（v2026-08-13 兴趣驱动娱乐：娱乐 = 开放活动空间，做什么由 pawn 兴趣决定）
  // 起因：娱乐卡池写死（idle+explore）→ 全营地统一反复建 toy 39 次吃光木头（toy:39/well:2/house:1）；
  //       初试「buildMinWood 门槛」被否决（治标），改为兴趣属性治本。
  // 经过：按 INTERESTS 表 weight 加权抽 1~3 个兴趣（interestsMin/interestsRange 读 tuning.pawn）；
  //       兴趣卡进卡槽（initSlots），带 interest 标记的卡由 ruleInterest 按有无该兴趣调制权重。
  // 结果：每个人娱乐活动由自己的兴趣决定——有人采集有人钓鱼，建造只是少数人的娱乐。
  const interests: string[] = [];
  const interestCount = cfg.interestsMin + rng.int(0, cfg.interestsRange);
  const ipool = allInterests().filter((id) => INTERESTS[id] !== undefined);
  for (let i = 0; i < interestCount; i++) {
    const cand = ipool.filter((id) => !interests.includes(id));
    if (cand.length === 0) break;
    const iw = cand.map((id) => INTERESTS[id].weight);
    const picked = rng.weightedPick(cand, iw);
    if (picked) interests.push(picked);
  }

  const dna: Dna = {
    str: roll(cfg.attrMin, cfg.attrMax),
    con: roll(cfg.attrMin, cfg.attrMax),
    int: roll(cfg.attrMin, cfg.attrMax),
    siz: roll(cfg.attrMin, cfg.attrMax),
    dex: roll(cfg.attrMin, cfg.attrMax),
    app: roll(cfg.attrMin, cfg.attrMax),
    pow: roll(cfg.attrMin, cfg.attrMax),
    edu: roll(cfg.attrMin, cfg.attrMax),
    traits,
    interests,
    maxSlots: cfg.maxSlotsMin + rng.int(0, cfg.maxSlotsRand),
    skillBonuses: {},
    sins: {},
  };

  // 天赋 → 属性微调（表驱动：statMods）
  for (const id of traits) {
    const tr = TRAITS[id];
    if (!tr?.statMods) continue;
    for (const [k, mod] of Object.entries(tr.statMods) as [AttrKey, number][]) {
      dna[k] = Math.min(90, dna[k] + mod);
    }
  }

  // 天赋 → 罪孽倾向（个性权重 0-1）：先随机底值，再叠加天赋修正（表驱动：sinMods）
  const sins: Dna['sins'] = {};
  for (const k of allDesires()) sins[k] = cfg.sinInitMin + rng.next() * cfg.sinInitRange;
  for (const id of traits) {
    const tr = TRAITS[id];
    if (!tr?.sinMods) continue;
    for (const [k, mod] of Object.entries(tr.sinMods) as [DesireId, number][]) {
      const v = (sins[k] ?? 0) + mod;
      sins[k] = Math.min(1, Math.max(cfg.sinFloor, v));
    }
  }
  dna.sins = sins;

  // 天赋 → 技能加成（表驱动：skillBonuses）
  for (const id of traits) {
    const tr = TRAITS[id];
    if (!tr?.skillBonuses) continue;
    for (const [k, mod] of Object.entries(tr.skillBonuses) as [SkillId, number][]) {
      dna.skillBonuses[k] = (dna.skillBonuses[k] ?? 1) * mod;
    }
  }

  return dna;
}

// 初始卡池：天赋卡（表驱动）+ mod 卡（全部进入，确保 mod 卡必在池中）+ 基础卡保底
export function initSlots(dna: Dna, extraCards?: BehaviorCard[], t?: CardTuningLike): (BehaviorCard | null)[] {
  const cfg = t ?? TUNING.card;
  const slots: (BehaviorCard | null)[] = [];
  // 天赋卡：从 traits 表生成（registerTrait 后新天赋自动生效 + 卡槽自动进入）
  const clone = (c: BehaviorCard): BehaviorCard => ({ ...c }); // 每小人独立实例（mastery 不串）
  for (const id of dna.traits) {
    const tr = TRAITS[id];
    if (tr?.card) slots.push(clone(traitCardOf(tr)));
  }
  // 兴趣休闲卡（v2026-08-13：娱乐 = 开放活动空间，做什么由兴趣决定）：
  // 每个兴趣一张专属 leisure 卡进卡槽（INTERESTS[id].card）；克隆独立实例（mastery 不串人）。
  // 注意：此卡进槽后即参与抽卡——娱乐时小人优先抽自己的兴趣卡（权重调制见 ruleInterest）。
  for (const id of dna.interests) {
    const card = INTERESTS[id]?.card;
    if (card) slots.push(clone(cardFromDef(card)));
  }
  // mod 卡全部进池（去重排除基础卡；即使超 maxSlots 也保留——抽卡按权重，容量不再挤出 mod 玩法）
  const extra = (extraCards ?? []).filter((c) => !BASE_CARDS.some((b) => b.id === c.id));
  for (const ec of extra) slots.push(clone(ec));
  // 互助卡常驻（2026-08-14 用户设计：好感高 → 帮忙）：进每个小人槽位。
  // 触发由 condition 控制（附近有弱势邻人 + 我好感高），平时权重被 condition 过滤不参与抽卡。
  const helpCard = BASE_CARDS.find((c) => c.id === 'help');
  if (helpCard) slots.push(clone(helpCard));
  // 基础卡保底 guaranteedBase 张（eat/rest/chop）：maxSlots=2 且 2 trait 卡时若无保底 → 小人
  // 没有任何基础卡、永久闲逛（曾实测发生）。保底让"天赋再强也有生存底线"。
  let baseIdx = 0;
  while (baseIdx < cfg.guaranteedBase && baseIdx < BASE_CARDS.length) {
    slots.push(clone(BASE_CARDS[baseIdx++]));
  }
  // 空槽（maxSlots 更大）再继续填
  while (slots.length < dna.maxSlots && baseIdx < BASE_CARDS.length) {
    slots.push(clone(BASE_CARDS[baseIdx++]));
  }
  return slots;
}

export type CardTuningLike = TuningConfig['card'];

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

export function effectiveWeight(card: BehaviorCard, pawn: PawnLike, ctx?: CardContext): number {
  // 权重合成流水线（数据驱动）：规则表（defs/weightRules.ts）按序调制，mod 可插入/替换
  let w = card.weight;
  for (const rule of weightRulesOf()) w = rule.apply(w, card, pawn, ctx);
  // 熟练度（P0.5 卡演化）：越熟练越想干 → ×(0.5 + mastery/100)，上限 1.5×
  return w * (0.5 + (card.mastery ?? 0) / 100);
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

// 职业 → 主导工作卡（数据在 defs/jobs.ts；保留导出兼容）
export { JOBS, JOB_CARD } from '../defs/jobs';
export { MARKOV_BIAS, SERIES_TO_DESIRE } from '../defs/behavior';
export * from '../defs/traits';
export type { TraitDef } from '../defs/traits';