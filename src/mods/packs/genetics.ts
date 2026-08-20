// 基因系统玩法包（2026-08-20，用户「基因」）：DNA 遗传/突变/显性隐性
// 设计：出生时父母 DNA 各 50% 概率遗传每个属性 + 随机突变（±5）。
// 显性隐性 = 同一属性父母值差 > 20 → 高值（显性）70% 概率传子代。
// 与 lineage 包配合：lineage 设血脉天赋，genetics 做基因混合细节。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';
import type { Dna } from '../../sim/ai/pawn';

const CFG = {
  mutationChance: 0.15,   // 每个属性 15% 概率突变
  mutationRange: 5,       // 突变量 ±5
  dominantThreshold: 20,   // 父母差 > 此值 → 高值 70% 遗传（显性）
  dominantBias: 0.7,      // 显性遗传概率
};

export const GENETICS_CONFIG = CFG;

// 基因混合：父母各 50% → 突变 → 显性隐性
export function mixDna(rng: { next: () => number }, parentA: Dna, parentB: Dna): Dna {
  const attrs = ['str', 'con', 'siz', 'dex', 'int', 'pow', 'app', 'edu'] as const;
  const result: Record<string, number> = {};
  for (const attr of attrs) {
    const a = parentA[attr];
    const b = parentB[attr];
    let val: number;
    if (Math.abs(a - b) > CFG.dominantThreshold) {
      // 显性：高值 70% 概率
      val = rng.next() < CFG.dominantBias ? Math.max(a, b) : Math.min(a, b);
    } else {
      // 均匀混合：取平均 ± 随机偏差
      val = Math.round((a + b) / 2 + (rng.next() - 0.5) * 4);
    }
    // 突变
    if (rng.next() < CFG.mutationChance) {
      val += Math.round((rng.next() - 0.5) * 2 * CFG.mutationRange);
    }
    result[attr] = Math.max(20, Math.min(95, val));
  }
  // traits 继承：随机取父母一方的 traits
  const traits = rng.next() < 0.5 ? [...parentA.traits] : [...parentB.traits];
  // 5% 概率获得新随机天赋
  if (rng.next() < 0.05) traits.push('天才');
  return {
    str: result.str!, con: result.con!, siz: result.siz!, dex: result.dex!,
    int: result.int!, pow: result.pow!, app: result.app!, edu: result.edu!,
    traits, maxSlots: Math.max(parentA.maxSlots, parentB.maxSlots),
  } as unknown as Dna;
}

// 基因系统：天才特质（traits 含"天才"）的心情加成 + mixDna 遗传函数（出生时由 breeding 调用）
// 2026-08-20：节流 5s（天才加成是被动 buff，不需要每帧遍历全体）
class GeneticsSystem {
  id = 'genetics';

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  private _timer = 0;
  update(dt: number): void {
    this._timer += dt;
    if (this._timer < 5) return;
    this._timer = 0;
    // 被动系统：基因混合在出生时由 breeding/lineage 调 mixDna
    // 这里做轻量检查：有突变的鼠（traits 含 '天才'）→ 技能成长更快
    for (const eid of this.ctx.iterPawns) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st?.dna?.traits.includes('天才')) continue;
      // 天才：技能成长时额外 +1（growSkill 已有 COC 规则，这里加被动 buff）
      const n = this.ctx.readNeeds(eid);
      if (n && n.mood < 100) { n.mood = Math.min(100, n.mood + 0.02); this.ctx.setNeeds(eid, n); }
    }
  }
}

export const geneticsPack: ModPack = {
  id: 'genetics',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'genetics', label: '基因', category: 'society',
      ctor: (ctx) => new GeneticsSystem(ctx),
    });
  },
};