/**
 * triad-specialization.ts —— 技能/特质/熟练度 三者一对一绑定系统
 *
 * 严格实现用户需求：
 *  - 「每个人技能/特质/熟练度 三者绑定，每个人最多三个特质/技能/熟练度，不属于这三者的操作一律效率*50并且无法学习。」
 */
import { hash2 } from './rng';
import type { BoundTriadSlot, PawnSkillSlot, PawnState } from './types';

/** 每个人最多 3 个绑定的【特质 ⇔ 技能 ⇔ 熟练度】三元组 */
export const MAX_BOUND_TRIADS = 3;

/** 非绑定操作的固定效率惩罚倍率：一律效率 ×50% */
export const UNBOUND_ACTION_EFFICIENCY_MUL = 0.5;

export interface TriadArchetypeDef {
  skillId: string;
  skillName: string;
  traitId: string;
  traitName: string;
  masteryId: string;
  masteryLabel: string;
  boundWorkIds: string[];
  boundCardSeries: string[];
  boundCardIds: string[];
}

export const TRIAD_ARCHETYPES: Record<string, TriadArchetypeDef> = {
  mining_construct: {
    skillId: 'mining_construct',
    skillName: '掘地筑造 (Mining & Construct)',
    traitId: 'strong',
    traitName: '掘山壮硕 (Tunnel Strong)',
    masteryId: 'mastery_mining_construct',
    masteryLabel: '采矿建造熟练度',
    boundWorkIds: ['mine', 'construct', 'firefight'],
    boundCardSeries: ['build', 'wood'],
    boundCardIds: ['mining_construct', 'mine', 'construct', 'build_wall', 'build_hut', 'build_store'],
  },
  combat_shoot: {
    skillId: 'combat_shoot',
    skillName: '精准射击 (Shooting)',
    traitId: 'owl',
    traitName: '夜视神射 (Night Hawk)',
    masteryId: 'mastery_combat_shoot',
    masteryLabel: '远程射击熟练度',
    boundWorkIds: ['hunt'],
    boundCardSeries: ['hunt', 'fight', 'defend'],
    boundCardIds: ['combat_shoot', 'hunt', 'fight', 'hold', 'focus', 'flank'],
  },
  combat_melee: {
    skillId: 'combat_melee',
    skillName: '疾风近战 (Melee)',
    traitId: 'strong',
    traitName: '狂战体魄 (Brawler)',
    masteryId: 'mastery_combat_melee',
    masteryLabel: '近身格斗熟练度',
    boundWorkIds: ['firefight', 'hunt'],
    boundCardSeries: ['fight', 'defend', 'flee'],
    boundCardIds: ['combat_melee', 'fight', 'hold', 'rally', 'flee'],
  },
  plants_cook: {
    skillId: 'plants_cook',
    skillName: '农艺烹饪 (Plants & Cooking)',
    traitId: 'workaholic',
    traitName: '勤恳农厨 (Green Thumb)',
    masteryId: 'mastery_plants_cook',
    masteryLabel: '农耕烹饪熟练度',
    boundWorkIds: ['grow', 'plant_cut', 'cook'],
    boundCardSeries: ['farm', 'cook', 'gather', 'wood', 'eat'],
    boundCardIds: ['plants_cook', 'sow_field', 'harvest_field', 'chop_tree', 'gather_berry', 'cook', 'eat'],
  },
  medical_social: {
    skillId: 'medical_social',
    skillName: '战地医疗 (Medical & Social)',
    traitId: 'cheerful',
    traitName: '仁心乐天 (Kind Healer)',
    masteryId: 'mastery_medical_social',
    masteryLabel: '医疗社交熟练度',
    boundWorkIds: ['doctor', 'haul'],
    boundCardSeries: ['heal', 'social', 'trade', 'rest'],
    boundCardIds: ['medical_social', 'heal', 'chat', 'trade', 'sleep'],
  },
  research_craft: {
    skillId: 'research_craft',
    skillName: '科研巧工 (Intellectual & Crafting)',
    traitId: 'lazy',
    traitName: '沉思学者 (Pensive Scholar)',
    masteryId: 'mastery_research_craft',
    masteryLabel: '科研制造熟练度',
    boundWorkIds: ['research'],
    boundCardSeries: ['wander'],
    boundCardIds: ['research_craft', 'wander'],
  },
};

export const TRIAD_CATALOG = TRIAD_ARCHETYPES;

export interface TriadEfficiencyEvaluation {
  isBound: boolean;
  efficiencyMul: number;
  canLearn: boolean;
  matchedTriad: BoundTriadSlot | null;
  reason: string;
}

export interface TriadActionLearnOutcome {
  isBound: boolean;
  canLearn: boolean;
  efficiencyMul: number;
  effectiveOutput: number;
  effectiveWorkDone: number;
  xpGained: number;
  masteryGained: number;
  levelBefore: number;
  levelAfter: number;
  masteryBefore: number;
  masteryAfter: number;
  message: string;
}

/**
 * 强制约束并同步 Pawn 的【特质 ⇔ 技能 ⇔ 熟练度】三绑定数组（严格 <= 3 个）。
 * 默认不直接改写 `p.mastery` 表以保证既有 golden 指纹 100% 逐位不变。
 */
export function ensurePawnTriads(p: PawnState, worldSeed = 42, syncMasteryTable = false): BoundTriadSlot[] {
  const skills: PawnSkillSlot[] = (p.skills ?? []).slice(0, MAX_BOUND_TRIADS);
  if (skills.length === 0) {
    const ids = Object.keys(TRIAD_ARCHETYPES);
    for (let i = 0; i < MAX_BOUND_TRIADS; i++) {
      const h = hash2(worldSeed, p.eid * 19 + i, 0x61a9);
      const sid = ids[(Math.floor(h * ids.length) + i) % ids.length];
      const arch = TRIAD_ARCHETYPES[sid];
      skills.push({
        id: sid,
        name: arch.skillName,
        level: 6 + i * 2,
        passion: i === 0 ? 2 : 1,
        cooldown: 0,
      });
    }
    p.skills = skills;
  }

  const triads: BoundTriadSlot[] = [];
  const seenSkillIds = new Set<string>();

  for (const sk of skills) {
    if (seenSkillIds.has(sk.id)) continue;
    seenSkillIds.add(sk.id);
    const arch = TRIAD_ARCHETYPES[sk.id] ?? TRIAD_ARCHETYPES.mining_construct;
    const existingTriad = p.triads?.find((t) => t.skillId === sk.id);
    const masteryEntry = p.mastery?.[arch.masteryId] ?? p.mastery?.[sk.id];
    const masteryVal = existingTriad?.masteryValue ?? masteryEntry?.v ?? Math.min(100, sk.level * 5);

    const slot: BoundTriadSlot = {
      index: triads.length as 0 | 1 | 2,
      traitId: arch.traitId,
      traitName: arch.traitName,
      skillId: sk.id,
      skillName: arch.skillName,
      masteryId: arch.masteryId,
      masteryLabel: arch.masteryLabel,
      boundWorkIds: [...arch.boundWorkIds],
      boundCardSeries: [...arch.boundCardSeries],
      level: Math.max(0, Math.min(20, sk.level)),
      xp: existingTriad?.xp ?? 0,
      masteryValue: Math.max(0, Math.min(100, masteryVal)),
      passion: sk.passion,
    };
    triads.push(slot);
    if (triads.length >= MAX_BOUND_TRIADS) break;
  }

  p.triads = triads;
  p.boundTraits = triads.map((t) => t.traitId);
  if (syncMasteryTable) {
    if (!p.mastery) p.mastery = {};
    for (const t of triads) {
      p.mastery[t.masteryId] = { v: t.masteryValue, t: p.mastery[t.masteryId]?.t ?? 0 };
    }
  }
  return triads;
}

/**
 * 为 Pawn 重新配置指定的最多 3 个三绑定专精
 */
export function setPawnBoundTriads(
  p: PawnState,
  skillIds: string[],
  initialLevel = 8,
  initialMastery = 40,
): BoundTriadSlot[] {
  const uniqueIds = [...new Set(skillIds)]
    .filter((id) => Boolean(TRIAD_ARCHETYPES[id]))
    .slice(0, MAX_BOUND_TRIADS);
  p.skills = uniqueIds.map((sid, idx) => ({
    id: sid,
    name: TRIAD_ARCHETYPES[sid].skillName,
    level: initialLevel,
    passion: idx === 0 ? 2 : 1,
    cooldown: 0,
  }));
  p.triads = undefined;
  const built = ensurePawnTriads(p, 42, true);
  for (const t of built) {
    t.level = initialLevel;
    t.masteryValue = initialMastery;
    p.mastery[t.masteryId] = { v: initialMastery, t: 0 };
  }
  return built;
}

/**
 * 判断某项操作 (`actionOrWorkId`) 是否属于该小人的 3 个绑定【技能/特质/熟练度】之一：
 *  - 属于三绑定之一：效率 `>= 1.0`（受等级与熟练度加成），且 `canLearn = true`。
 *  - 不属于三绑定：**效率一律 ×50% (`efficiencyMul = 0.5`)，且无法学习 (`canLearn = false`)**！
 */
export function evaluatePawnActionEfficiency(
  p: PawnState,
  actionOrWorkId: string,
): TriadEfficiencyEvaluation {
  const triads = ensurePawnTriads(p);
  for (const t of triads) {
    const arch = TRIAD_ARCHETYPES[t.skillId];
    const matched =
      t.skillId === actionOrWorkId ||
      t.masteryId === actionOrWorkId ||
      t.traitId === actionOrWorkId ||
      t.boundWorkIds.includes(actionOrWorkId) ||
      t.boundCardSeries.includes(actionOrWorkId) ||
      (arch?.boundCardIds.includes(actionOrWorkId) ?? false);

    if (matched) {
      const eff = Number((1.0 + t.level * 0.025 + (t.masteryValue / 100) * 0.25).toFixed(2));
      return {
        isBound: true,
        efficiencyMul: eff,
        canLearn: true,
        matchedTriad: t,
        reason: `命中三绑定【${t.traitName} ⇔ ${t.skillName} ⇔ ${t.masteryLabel}】(${Math.round(eff * 100)}% 效率 · 可学习成长)`,
      };
    }
  }

  return {
    isBound: false,
    efficiencyMul: UNBOUND_ACTION_EFFICIENCY_MUL,
    canLearn: false,
    matchedTriad: null,
    reason: `不属于该小人三绑定专精：效率强制 ×50% (${UNBOUND_ACTION_EFFICIENCY_MUL * 100}%) 且无法学习经验或熟练度`,
  };
}

/**
 * 执行一次带三绑定检定的操作并尝试结算学习（技能 XP 与熟练度）：
 *  - 若属于三绑定：产出乘以绑定效率，且正常累加 XP、升级技能与提升熟练度。
 *  - 若不属于三绑定：产出强制 `× 0.5`（50% 效率），且 `xpGained = 0`、`masteryGained = 0`，无法学习！
 */
export function performPawnTriadAction(
  p: PawnState,
  actionOrWorkId: string,
  baseAmount = 10,
  nowSec = 0,
): TriadActionLearnOutcome {
  const evalRes = evaluatePawnActionEfficiency(p, actionOrWorkId);
  const effectiveOutput = Number((baseAmount * evalRes.efficiencyMul).toFixed(2));

  if (!evalRes.isBound || !evalRes.canLearn || !evalRes.matchedTriad) {
    return {
      isBound: false,
      canLearn: false,
      efficiencyMul: UNBOUND_ACTION_EFFICIENCY_MUL,
      effectiveOutput,
      effectiveWorkDone: effectiveOutput,
      xpGained: 0,
      masteryGained: 0,
      levelBefore: 0,
      levelAfter: 0,
      masteryBefore: 0,
      masteryAfter: 0,
      message: `⚠ ${p.name} 执行非绑定操作 [${actionOrWorkId}]：效率强制 ×50% (产出 ${effectiveOutput})，且无法学习 (+0 XP, +0 熟练度)`,
    };
  }

  const triad = evalRes.matchedTriad;
  const levelBefore = triad.level;
  const masteryBefore = triad.masteryValue;

  const passionMul = triad.passion === 2 ? 1.5 : triad.passion === 1 ? 1.2 : 1.0;
  const xpGained = Math.max(5, Math.round(baseAmount * 1.5 * passionMul));
  const masteryGained = Number(Math.max(1.5, baseAmount * 0.25 * passionMul).toFixed(2));

  triad.xp += xpGained;
  while (triad.xp >= 100 && triad.level < 20) {
    triad.xp -= 100;
    triad.level = Math.min(20, triad.level + 1);
  }
  triad.masteryValue = Math.min(100, Number((triad.masteryValue + masteryGained).toFixed(2)));

  const skSlot = p.skills?.find((s) => s.id === triad.skillId);
  if (skSlot) skSlot.level = triad.level;
  if (!p.mastery) p.mastery = {};
  p.mastery[triad.masteryId] = { v: triad.masteryValue, t: nowSec };

  return {
    isBound: true,
    canLearn: true,
    efficiencyMul: evalRes.efficiencyMul,
    effectiveOutput,
    effectiveWorkDone: effectiveOutput,
    xpGained,
    masteryGained,
    levelBefore,
    levelAfter: triad.level,
    masteryBefore,
    masteryAfter: triad.masteryValue,
    message: `⚡ ${p.name} 执行三绑定专精【${triad.skillName}】：效率 ${Math.round(evalRes.efficiencyMul * 100)}%，获得 +${xpGained} XP, +${masteryGained}% 熟练度 (当前 Lv.${triad.level} · 熟 ${triad.masteryValue}%)`,
  };
}
