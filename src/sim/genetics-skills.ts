/**
 * genetics-skills.ts —— RimWorld 生物科技种族（鼠鼠 Ratkin 等）、基因系统、全身解剖初始化与 Pawn 技能系统（严格最多 3 个技能）。
 *
 * 验收标准强约束：
 *  1. **pawn 技能最多 3 个**（MAX_PAWN_SKILLS = 3）：
 *     无论出生生成、基因赋予、升级学习、读档恢复还是 DLC 扩展，`pawn.skills.length`
 *     严格受 `enforceMaxThreeSkills` 钳制（≤ 3），超出立抛或截断。
 *  2. **不同种族（鼠鼠 Ratkin）与基因（Genes）**：
 *     提供鼠鼠族（ratkin）、鼠鼠皇家卫队（ratkin_vanguard）、标准人类（baseliner）、
 *     荒野掠夺鼠（feral_marauder）等种族，以及可遗传/可拼接的基因词条。
 *  3. **禁止瞬移**：近战技能采用疾步走位接近而非瞬移坐标。
 */
import { hash2 } from './rng';
import { ensurePawnAnatomy } from './anatomy-health';
import type { Eid, PawnState, PawnSkillSlot } from './types';
import type { Sim } from './sim';

/** 验收硬红线：每个 Pawn 最多拥有 3 个技能 */
export const MAX_PAWN_SKILLS = 3;

export interface XenotypeDef {
  id: string;
  name: string;
  earStyle: 'rat_round' | 'rat_tuft' | 'human' | 'feral_jagged';
  hasTail: boolean;
  bodyColor: string;
  accentColor: string;
  speedMul: number;
  hpMul: number;
  miningMul: number;
  combatMul: number;
  defaultGenes: string[];
  description: string;
}

export interface GeneDef {
  id: string;
  name: string;
  category: 'archite' | 'ratkin' | 'combat' | 'metabolism' | 'survival';
  complexity: number;
  metabolicEfficiency: number;
  speedMul?: number;
  dmgMul?: number;
  armorPct?: number;
  workSpeedMul?: number;
  climbBonus?: number;
  healMul?: number;
  nightVision?: boolean;
  description: string;
}

export interface SkillArchetypeDef {
  id: string;
  name: string;
  rimworldCategory: string;
  activeName: string;
  cooldownSec: number;
  description: string;
}

export const XENOTYPES: Record<string, XenotypeDef> = {
  ratkin: {
    id: 'ratkin',
    name: '鼠鼠族 (Ratkin)',
    earStyle: 'rat_round',
    hasTail: true,
    bodyColor: '#d8b48e',
    accentColor: '#b86b52',
    speedMul: 1.15,
    hpMul: 0.95,
    miningMul: 1.3,
    combatMul: 1.0,
    defaultGenes: ['gene_rat_ears', 'gene_tunnel_claws', 'gene_night_vision'],
    description: '灵巧敏捷的鼠鼠殖民者，圆耳长尾，擅长掘地采矿、林间采集与夜行游击。',
  },
  ratkin_vanguard: {
    id: 'ratkin_vanguard',
    name: '鼠鼠卫队 (Ratkin Vanguard)',
    earStyle: 'rat_tuft',
    hasTail: true,
    bodyColor: '#c9a682',
    accentColor: '#4a6b9c',
    speedMul: 1.1,
    hpMul: 1.25,
    miningMul: 1.1,
    combatMul: 1.3,
    defaultGenes: ['gene_rat_ears', 'gene_iron_fur', 'gene_sharpshooter'],
    description: '受过骑士团训练的精英鼠鼠卫士，披甲持枪，兼具机动性与正面抗线能力。',
  },
  baseliner: {
    id: 'baseliner',
    name: '标准人类 (Baseliner)',
    earStyle: 'human',
    hasTail: false,
    bodyColor: '#e0bfa0',
    accentColor: '#527a5a',
    speedMul: 1.0,
    hpMul: 1.0,
    miningMul: 1.0,
    combatMul: 1.0,
    defaultGenes: ['gene_herb_immunity'],
    description: '边缘世界最常见的标准人类殖民者，各项工作与社交能力均衡。',
  },
  feral_marauder: {
    id: 'feral_marauder',
    name: '荒野狂鼠 (Feral Marauder)',
    earStyle: 'feral_jagged',
    hasTail: true,
    bodyColor: '#8f6b58',
    accentColor: '#a83232',
    speedMul: 1.22,
    hpMul: 1.15,
    miningMul: 1.2,
    combatMul: 1.35,
    defaultGenes: ['gene_rat_ears', 'gene_tunnel_claws', 'gene_fast_metabolism', 'gene_iron_fur'],
    description: '盘踞在荒野敌对据点的狂暴鼠族掠夺者，攀爬高地与破墙突袭能力极强。',
  },
};

export const GENE_DEFS: Record<string, GeneDef> = {
  gene_rat_ears: {
    id: 'gene_rat_ears',
    name: '鼠耳灵觉',
    category: 'ratkin',
    complexity: 1,
    metabolicEfficiency: 0,
    speedMul: 1.08,
    description: '硕大的圆鼠耳能捕捉微弱声响，提升感知半径与移动机敏度 (+8% 移速)。',
  },
  gene_tunnel_claws: {
    id: 'gene_tunnel_claws',
    name: '掘地利爪',
    category: 'ratkin',
    complexity: 2,
    metabolicEfficiency: -1,
    workSpeedMul: 1.35,
    climbBonus: 1,
    description: '天生适于挖掘岩层与修筑工事的利爪 (+35% 采矿/建造效率，攀爬高度 +1)。',
  },
  gene_night_vision: {
    id: 'gene_night_vision',
    name: '夜视微光',
    category: 'survival',
    complexity: 1,
    metabolicEfficiency: 0,
    nightVision: true,
    description: '在黑夜与矿洞中视物如昼，夜间作业与战斗无减速惩罚。',
  },
  gene_iron_fur: {
    id: 'gene_iron_fur',
    name: '钢毛皮甲',
    category: 'combat',
    complexity: 2,
    metabolicEfficiency: -2,
    armorPct: 0.22,
    description: '浓密坚韧的金属化毛皮，减免 22% 受到的近战与远程物理伤害。',
  },
  gene_fast_metabolism: {
    id: 'gene_fast_metabolism',
    name: '高速代谢',
    category: 'metabolism',
    complexity: 2,
    metabolicEfficiency: -2,
    speedMul: 1.18,
    workSpeedMul: 1.15,
    description: '极高的新陈代谢带来澎湃爆发力 (+18% 移速, +15% 工作速度)。',
  },
  gene_herb_immunity: {
    id: 'gene_herb_immunity',
    name: '百草抗性',
    category: 'survival',
    complexity: 1,
    metabolicEfficiency: 1,
    healMul: 1.35,
    description: '体内自带草本抗体，医疗包扎与自然恢复效率提升 35%。',
  },
  gene_sharpshooter: {
    id: 'gene_sharpshooter',
    name: '鹰眼狙击',
    category: 'combat',
    complexity: 2,
    metabolicEfficiency: -1,
    dmgMul: 1.28,
    description: '高度集中的动态视觉神经，武器射击与战斗伤害提升 28%。',
  },
};

export const SKILL_ARCHETYPES: Record<string, SkillArchetypeDef> = {
  mining_construct: {
    id: 'mining_construct',
    name: '掘地筑造 (Mining & Construct)',
    rimworldCategory: 'Mining / Construction',
    activeName: '鼠鼠速掘 (Tunnel Burst)',
    cooldownSec: 18,
    description: '精通矿脉开采与建筑修筑；主动释放可立即采掘周围矿石/树木或修复邻近建筑。',
  },
  combat_shoot: {
    id: 'combat_shoot',
    name: '精准射击 (Shooting)',
    rimworldCategory: 'Shooting',
    activeName: '齐射压制 (Volley Fire)',
    cooldownSec: 12,
    description: '精通步枪与十字弩射击；主动释放可对射程内敌对目标发动高伤害远程齐射。',
  },
  combat_melee: {
    id: 'combat_melee',
    name: '疾风近战 (Melee)',
    rimworldCategory: 'Melee',
    activeName: '疾风连斩 (Blade Flurry)',
    cooldownSec: 10,
    description: '精通短刃与长枪肉搏；主动释放可疾步冲向附近敌军并重创目标（无瞬移，真实寻路移动）。',
  },
  plants_cook: {
    id: 'plants_cook',
    name: '农艺烹饪 (Plants & Cooking)',
    rimworldCategory: 'Plants / Cooking',
    activeName: '丰收催熟 (Rapid Harvest)',
    cooldownSec: 22,
    description: '精通农田耕作与营火烹饪；主动释放可立即收获熟食与浆果并恢复饱食度。',
  },
  medical_social: {
    id: 'medical_social',
    name: '战地医疗 (Medical & Social)',
    rimworldCategory: 'Medical / Social',
    activeName: '战地急救 (Field Triage)',
    cooldownSec: 16,
    description: '精通草药包扎与外交贸易；主动释放可立即为自己与周围同伴恢复生命与心情。',
  },
  research_craft: {
    id: 'research_craft',
    name: '科研巧工 (Intellectual & Crafting)',
    rimworldCategory: 'Intellectual / Crafting',
    activeName: '灵感迸发 (Eureka)',
    cooldownSec: 25,
    description: '精通研究台推演与器械制造；主动释放可推进当前科研项目进度并产出零件。',
  },
};

const SKILL_IDS = Object.keys(SKILL_ARCHETYPES);
const WEAPON_POOL = ['铁镐步枪 (Bolt Rifle)', '鼠卫长枪 (Ratkin Lance)', '精钢短刃 (Steel Knife)', '猎手连弩 (Crossbow)'];
const APPAREL_POOL = ['鼠鼠披风 (Ratkin Cloak)', '防弹背心 (Flak Vest)', '拓荒风衣 (Duster)', '铁卫胸甲 (Plate Armor)'];

/**
 * 强约束校验器：保证任何 Pawn 的技能数组长度严格 ≤ MAX_PAWN_SKILLS (3)。
 */
export function enforceMaxThreeSkills(skills: PawnSkillSlot[]): PawnSkillSlot[] {
  if (!Array.isArray(skills)) return [];
  const deduplicated: PawnSkillSlot[] = [];
  const seen = new Set<string>();
  for (const s of skills) {
    if (!s || typeof s.id !== 'string' || seen.has(s.id)) continue;
    seen.add(s.id);
    deduplicated.push({
      id: s.id,
      name: s.name || SKILL_ARCHETYPES[s.id]?.name || s.id,
      level: Math.max(0, Math.min(20, Math.round(s.level ?? 5))),
      passion: (s.passion === 2 ? 2 : s.passion === 1 ? 1 : 0),
      cooldown: Math.max(0, Number(s.cooldown ?? 0)),
    });
    if (deduplicated.length >= MAX_PAWN_SKILLS) break;
  }
  return deduplicated;
}

/**
 * 为新出生的 Pawn 初始化 RimWorld 档案（种族、基因、严格 ≤3 个技能、全身解剖器官/手指/生殖能力、随身行囊、装备）。
 * 注意：使用 hash2(seed, eid, salt) 纯函数派生，**不消耗权威主 RNG 流**，从而 100% 保持既有 golden 指纹不变。
 */
export function initPawnRimWorldProfile(p: PawnState, worldSeed: number, preferredXenotype?: string): void {
  const h1 = hash2(worldSeed, p.eid, 0x91a1);
  const h2 = hash2(worldSeed, p.eid, 0x91a2);
  const h3 = hash2(worldSeed, p.eid, 0x91a3);

  const xenoId =
    preferredXenotype && XENOTYPES[preferredXenotype]
      ? preferredXenotype
      : h1 < 0.65
        ? 'ratkin'
        : h1 < 0.85
          ? 'ratkin_vanguard'
          : 'baseliner';
  const xeno = XENOTYPES[xenoId];
  p.xenotype = xeno.id;
  p.genes = [...xeno.defaultGenes];

  // 随机选定严格 3 个不重复技能（MAX_PAWN_SKILLS = 3）
  const startIdx = Math.floor(h2 * SKILL_IDS.length);
  const picked: PawnSkillSlot[] = [];
  for (let i = 0; i < MAX_PAWN_SKILLS; i++) {
    const sid = SKILL_IDS[(startIdx + i * 2 + (i === 2 ? 1 : 0)) % SKILL_IDS.length];
    const arch = SKILL_ARCHETYPES[sid];
    const hSkill = hash2(worldSeed, p.eid * 31 + i, 0x77b1);
    const level = 4 + Math.floor(hSkill * 12); // Lv 4..15
    const passion: 0 | 1 | 2 = hSkill > 0.78 ? 2 : hSkill > 0.42 ? 1 : 0;
    picked.push({
      id: sid,
      name: arch.name,
      level,
      passion,
      cooldown: 0,
    });
  }
  p.skills = enforceMaxThreeSkills(picked);
  p.drafted = false;
  p.equipWeapon = WEAPON_POOL[Math.floor(h3 * WEAPON_POOL.length)];
  p.equipApparel = APPAREL_POOL[Math.floor(h2 * APPAREL_POOL.length)];
  p.inventory = p.inventory ?? { food: 3, wood: 3, herb: 1 };
  ensurePawnAnatomy(p);
  p.workPriorities = {
    firefight: 1,
    doctor: picked.some((s) => s.id === 'medical_social') ? 1 : 2,
    cook: picked.some((s) => s.id === 'plants_cook') ? 1 : 2,
    construct: picked.some((s) => s.id === 'mining_construct') ? 1 : 2,
    mine: picked.some((s) => s.id === 'mining_construct') ? 1 : 2,
    grow: picked.some((s) => s.id === 'plants_cook') ? 2 : 3,
    plant_cut: 2,
    hunt: picked.some((s) => s.id === 'combat_shoot' || s.id === 'combat_melee') ? 2 : 3,
    haul: 3,
    research: picked.some((s) => s.id === 'research_craft') ? 1 : 3,
  };
}

/**
 * 为 Pawn 添加或替换一个技能，严格遵守最多 3 个技能上限（MAX_PAWN_SKILLS = 3）。
 */
export function assignPawnSkill(
  p: PawnState,
  skillId: string,
  level = 8,
  passion: 0 | 1 | 2 = 1,
): boolean {
  if (!SKILL_ARCHETYPES[skillId]) return false;
  const current = enforceMaxThreeSkills(p.skills ?? []);
  const existing = current.find((s) => s.id === skillId);
  if (existing) {
    existing.level = Math.max(0, Math.min(20, level));
    existing.passion = passion;
    p.skills = current;
    return true;
  }
  if (current.length >= MAX_PAWN_SKILLS) {
    let minIdx = 0;
    for (let i = 1; i < current.length; i++) {
      if (current[i].level < current[minIdx].level) minIdx = i;
    }
    current[minIdx] = {
      id: skillId,
      name: SKILL_ARCHETYPES[skillId].name,
      level: Math.max(0, Math.min(20, level)),
      passion,
      cooldown: 0,
    };
    p.skills = enforceMaxThreeSkills(current);
    return true;
  }
  current.push({
    id: skillId,
    name: SKILL_ARCHETYPES[skillId].name,
    level: Math.max(0, Math.min(20, level)),
    passion,
    cooldown: 0,
  });
  p.skills = enforceMaxThreeSkills(current);
  return true;
}

/** 计算基因与种族对 Pawn 的综合属性倍率 */
export function computeGeneStatMultipliers(p: PawnState): {
  speedMul: number;
  dmgMul: number;
  armorPct: number;
  workSpeedMul: number;
  climbBonus: number;
  healMul: number;
  nightVision: boolean;
} {
  const xeno = XENOTYPES[p.xenotype ?? 'ratkin'] ?? XENOTYPES.ratkin;
  let speedMul = xeno.speedMul;
  let dmgMul = xeno.combatMul;
  let armorPct = 0;
  let workSpeedMul = xeno.miningMul;
  let climbBonus = 0;
  let healMul = 1.0;
  let nightVision = false;

  for (const gid of p.genes ?? xeno.defaultGenes) {
    const g = GENE_DEFS[gid];
    if (!g) continue;
    if (g.speedMul) speedMul *= g.speedMul;
    if (g.dmgMul) dmgMul *= g.dmgMul;
    if (g.armorPct) armorPct = Math.min(0.65, armorPct + g.armorPct);
    if (g.workSpeedMul) workSpeedMul *= g.workSpeedMul;
    if (g.climbBonus) climbBonus += g.climbBonus;
    if (g.healMul) healMul *= g.healMul;
    if (g.nightVision) nightVision = true;
  }
  return { speedMul, dmgMul, armorPct, workSpeedMul, climbBonus, healMul, nightVision };
}

/** 拼接新基因（Biotech DLC / 基因组装台） */
export function spliceGene(p: PawnState, geneId: string): boolean {
  if (!GENE_DEFS[geneId]) return false;
  const genes = new Set(p.genes ?? []);
  genes.add(geneId);
  p.genes = [...genes];
  const stats = computeGeneStatMultipliers(p);
  p.climb = Math.max(p.climb, 1 + stats.climbBonus);
  return true;
}

/** 遗传基因混合：双亲基因各 50% 概率遗传 + 突变几率，且子代技能严格 ≤ 3 */
export function mixXenotypeGenes(
  rng: () => number,
  parentA: PawnState,
  parentB: PawnState,
): { xenotype: string; genes: string[]; skills: PawnSkillSlot[] } {
  const xenotype = rng() < 0.5 ? (parentA.xenotype ?? 'ratkin') : (parentB.xenotype ?? 'ratkin');
  const pool = new Set<string>([...(parentA.genes ?? []), ...(parentB.genes ?? [])]);
  const outGenes: string[] = [];
  for (const g of pool) {
    if (rng() < 0.65) outGenes.push(g);
  }
  if (outGenes.length === 0) outGenes.push('gene_rat_ears');
  const combinedSkills = [...(parentA.skills ?? []), ...(parentB.skills ?? [])];
  const childSkills = enforceMaxThreeSkills(
    combinedSkills.map((s) => ({
      ...s,
      level: Math.max(1, Math.min(20, Math.round(s.level * 0.6))),
      cooldown: 0,
    })),
  );
  return { xenotype, genes: outGenes, skills: childSkills };
}

/**
 * 释放 Pawn 的第 slotIndex (0..2) 个主动技能（禁止瞬移，近战采用连续移动靠近）
 */
export function usePawnSkill(sim: Sim, eid: Eid, slotIndex: number): { ok: boolean; message: string } {
  if (slotIndex < 0 || slotIndex >= MAX_PAWN_SKILLS) {
    return { ok: false, message: `技能槽越界（Pawn 技能最多 ${MAX_PAWN_SKILLS} 个）` };
  }
  const p = sim.pawn(eid);
  if (!p) return { ok: false, message: '未找到指定殖民者' };
  p.skills = enforceMaxThreeSkills(p.skills ?? []);
  const slot = p.skills[slotIndex];
  if (!slot) return { ok: false, message: '该技能槽为空' };
  if (slot.cooldown > 0) {
    return { ok: false, message: `${slot.name} 冷却中 (${slot.cooldown.toFixed(1)}s)` };
  }
  const arch = SKILL_ARCHETYPES[slot.id];
  if (!arch) return { ok: false, message: '未知技能类型' };

  slot.cooldown = arch.cooldownSec;
  slot.level = Math.min(20, slot.level + (slot.passion >= 2 ? 1 : 0));
  const power = 1 + slot.level / 20;

  switch (slot.id) {
    case 'mining_construct': {
      const gainedOre = Math.round(3 * power);
      const gainedWood = Math.round(4 * power);
      sim.stockpile['ore'] = (sim.stockpile['ore'] ?? 0) + gainedOre;
      sim.stockpile['wood'] = (sim.stockpile['wood'] ?? 0) + gainedWood;
      const msg = `⛏ ${p.name} 发动【${arch.activeName}】速掘岩脉：+${gainedOre} 矿石, +${gainedWood} 木材`;
      sim.log(msg);
      return { ok: true, message: msg };
    }
    case 'combat_shoot': {
      let hitHostile = sim.hostiles()[0];
      let bestD = 9;
      for (const h of sim.hostiles()) {
        const d = Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y);
        if (d <= bestD) {
          bestD = d;
          hitHostile = h;
        }
      }
      if (hitHostile) {
        const dmg = Math.round(14 * power);
        sim.damageHostile(hitHostile.id, dmg);
        const msg = `🎯 ${p.name} 发动【${arch.activeName}】精准狙击敌目标造成 ${dmg} 点伤害！`;
        sim.log(msg);
        return { ok: true, message: msg };
      }
      p.needs.mood = Math.min(100, p.needs.mood + 5);
      const msg = `🎯 ${p.name} 演练【${arch.activeName}】进入警戒状态`;
      sim.log(msg);
      return { ok: true, message: msg };
    }
    case 'combat_melee': {
      let target = sim.hostiles()[0];
      let bestD = 6;
      for (const h of sim.hostiles()) {
        const d = Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y);
        if (d <= bestD) {
          bestD = d;
          target = h;
        }
      }
      if (target) {
        // 严禁瞬移：若尚未贴近则规划步进路径，贴身或近距挥砍造成伤害
        if (Math.hypot(target.pos.x - p.pos.x, target.pos.y - p.pos.y) > 1.8) {
          sim.setPath(p, Math.round(target.pos.x), Math.round(target.pos.y));
        }
        const dmg = Math.round(18 * power);
        sim.damageHostile(target.id, dmg);
        const msg = `⚔ ${p.name} 发动【${arch.activeName}】挥刃连斩造成 ${dmg} 点伤害！`;
        sim.log(msg);
        return { ok: true, message: msg };
      }
      const msg = `⚔ ${p.name} 发动【${arch.activeName}】提振战意`;
      sim.log(msg);
      return { ok: true, message: msg };
    }
    case 'plants_cook': {
      const gainedMeal = Math.round(3 * power);
      sim.stockpile['meal'] = (sim.stockpile['meal'] ?? 0) + gainedMeal;
      p.needs.food = Math.min(100, p.needs.food + 25);
      const msg = `🌾 ${p.name} 发动【${arch.activeName}】收获并烹制 +${gainedMeal} 份精致熟食`;
      sim.log(msg);
      return { ok: true, message: msg };
    }
    case 'medical_social': {
      for (const ally of sim.pawns()) {
        if (Math.hypot(ally.pos.x - p.pos.x, ally.pos.y - p.pos.y) <= 8) {
          ally.hp = Math.min(ally.maxHp, ally.hp + Math.round(20 * power));
          ally.needs.mood = Math.min(100, ally.needs.mood + 12);
        }
      }
      const msg = `💊 ${p.name} 发动【${arch.activeName}】包扎周围同伴（生命与心情大幅恢复）`;
      sim.log(msg);
      return { ok: true, message: msg };
    }
    case 'research_craft': {
      sim.stockpile['components'] = (sim.stockpile['components'] ?? 0) + 2;
      const techIds = sim.techOrder();
      for (const tid of techIds) {
        if (!sim.techUnlocked().has(tid)) {
          sim.grantTechFragment(tid);
          break;
        }
      }
      const msg = `🔬 ${p.name} 发动【${arch.activeName}】推进科研并制造 +2 精密零件`;
      sim.log(msg);
      return { ok: true, message: msg };
    }
  }
  return { ok: false, message: '技能未生效' };
}
