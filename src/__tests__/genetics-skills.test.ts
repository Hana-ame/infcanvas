/**
 * genetics-skills.test.ts —— 种族（鼠鼠 Ratkin）、Biotech 基因与「Pawn 技能最多 3 个」硬约束测试。
 */
import { describe, expect, it } from 'vitest';
import {
  Sim,
  MAX_PAWN_SKILLS,
  XENOTYPES,
  GENE_DEFS,
  SKILL_ARCHETYPES,
  enforceMaxThreeSkills,
  assignPawnSkill,
  usePawnSkill,
  spliceGene,
  mixXenotypeGenes,
  computeGeneStatMultipliers,
} from '../sim';
import { ModRegistry } from '../mods';

describe('Pawn 技能最多 3 个硬约束 & 鼠鼠基因系统 (genetics-skills)', () => {
  it('MAX_PAWN_SKILLS 恒为 3，且所有出生 Pawn 的技能数严格 <= 3', () => {
    expect(MAX_PAWN_SKILLS).toBe(3);
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const pawns = [...sim.pawns()];
    expect(pawns.length).toBeGreaterThanOrEqual(4);
    for (const p of pawns) {
      expect(p.skills).toBeDefined();
      expect(p.skills!.length).toBeLessThanOrEqual(MAX_PAWN_SKILLS);
      expect(p.skills!.length).toBe(3);
      expect(p.xenotype).toBeDefined();
      expect(XENOTYPES[p.xenotype!]).toBeDefined();
    }
  });

  it('enforceMaxThreeSkills：传入超过 3 个技能时强制截断至 3 个且去重', () => {
    const overList = Object.keys(SKILL_ARCHETYPES).map((id, idx) => ({
      id,
      name: id,
      level: 5 + idx,
      passion: 1 as const,
      cooldown: 0,
    }));
    expect(overList.length).toBeGreaterThan(3);
    const clamped = enforceMaxThreeSkills(overList);
    expect(clamped).toHaveLength(3);
  });

  it('assignPawnSkill：向已满 3 个技能的 Pawn 添加第 4 个技能时，替换最低等级技能，绝不超过 3 个', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const p = [...sim.pawns()][0];
    expect(p.skills!.length).toBe(3);

    // 尝试逐个赋予全部 6 种技能
    for (const skillId of Object.keys(SKILL_ARCHETYPES)) {
      assignPawnSkill(p, skillId, 12, 2);
      expect(p.skills!.length).toBeLessThanOrEqual(3);
    }
  });

  it('usePawnSkill：0/1/2 槽位技能可正常释放并进入冷却，越界槽位 (>=3) 被拒绝', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const p = [...sim.pawns()][0];

    const outOfBounds = usePawnSkill(sim, p.eid, 3);
    expect(outOfBounds.ok).toBe(false);

    const res0 = usePawnSkill(sim, p.eid, 0);
    expect(res0.ok).toBe(true);
    expect(p.skills![0].cooldown).toBeGreaterThan(0);

    // 冷却期间再次释放返回 false
    const resAgain = usePawnSkill(sim, p.eid, 0);
    expect(resAgain.ok).toBe(false);

    // 步进冷却时间后可再次释放
    sim.step(30);
    expect(p.skills![0].cooldown).toBe(0);
  });

  it('鼠鼠族 (Ratkin) 基因拼接与双亲遗传混合：属性倍率生效且子代技能数 <= 3', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const [pA, pB] = [...sim.pawns()];
    pA.xenotype = 'ratkin';
    pB.xenotype = 'ratkin_vanguard';

    const beforeClimb = pA.climb;
    expect(spliceGene(pA, 'gene_tunnel_claws')).toBe(true);
    expect(spliceGene(pA, 'gene_iron_fur')).toBe(true);
    expect(pA.genes).toContain('gene_tunnel_claws');
    expect(pA.climb).toBeGreaterThanOrEqual(beforeClimb);

    const mults = computeGeneStatMultipliers(pA);
    expect(mults.workSpeedMul).toBeGreaterThan(1.2);
    expect(mults.armorPct).toBeGreaterThan(0);
    expect(Object.keys(GENE_DEFS).length).toBeGreaterThanOrEqual(6);

    const child = mixXenotypeGenes(() => sim.rng(), pA, pB);
    expect(['ratkin', 'ratkin_vanguard']).toContain(child.xenotype);
    expect(child.genes.length).toBeGreaterThan(0);
    expect(child.skills.length).toBeLessThanOrEqual(MAX_PAWN_SKILLS);
  });
});
