// 跨 Sim 实例共享的模块级表与查询（2026-08-14 独立测试改造）
// 背景：此前 cardPredicateOf/weightRulesOf/socialLinesOf 与 static store 都定义在 mods/registry.ts，
// 而 pawn.ts 运行时依赖它们 → 模块级循环 import（registry→pawn, pawn→registry），
// 加载顺序一变化（新测试文件触发）就报 "cardPredicateOf is not a function"。
// 修复：store 与查询函数移到本模块（只依赖 defs 层），registry/pawn/socialSystem 单向依赖这里 → 无环。
import type { CardContext } from '../ai/pawn';
import type { WeightRule } from '../defs/weightRules';
import { BUILTIN_WEIGHT_RULES } from '../defs/weightRules';
import { CARD_PREDICATES } from '../defs/cards';
import { SOCIAL_LINES, type SocialLineTable } from '../defs/socialLines';

// 卡条件谓词表（行为树条件节点）：内置谓词 + mod 扩展。跨 Sim 实例共享
export const predicateStore: Map<string, (c: CardContext) => boolean> = new Map(Object.entries(CARD_PREDICATES));
// 抽卡权重调制规则表（权重合成流水线）：规则顺序 = 执行顺序。跨 Sim 实例共享
export const weightRuleStore: Map<string, WeightRule> = new Map(BUILTIN_WEIGHT_RULES.map((r) => [r.id, r]));
// 社交对话模板表（文本层）：微互动 + 话题。跨 Sim 实例共享
export const socialLinesStore: SocialLineTable = {
  greet: [...SOCIAL_LINES.greet],
  positive: [...SOCIAL_LINES.positive],
  negative: [...SOCIAL_LINES.negative],
  topics: [...SOCIAL_LINES.topics], // 模板含函数，浅拷贝即可
};

// 谓词查询（卡工厂组合条件用）；缺省抛错（拼错 id 立即暴露，提示注册）
export function cardPredicateOf(id: string): (c: CardContext) => boolean {
  const fn = predicateStore.get(id);
  if (!fn) throw new Error(`mod: 条件谓词 "${id}" 未注册，请先用 registerPredicate 注册`);
  return fn;
}

// 权重规则流水线查询（effectiveWeight 合成用；规则顺序 = 表序，跨 Sim 实例共享）
export function weightRulesOf(): WeightRule[] {
  return [...weightRuleStore.values()];
}

// 社交对话模板查询（社交系统取文案用；跨 Sim 实例共享）
export function socialLinesOf(): SocialLineTable {
  return socialLinesStore;
}
