// 血脉系统玩法包（2026-08-20，用户「血脉」）：家族谱系/继承/血脉天赋
// 设计：PawnState.extra[K_LINEAGE] = { parents: [eid, eid], generation, bloodline: trait }。
// 出生时父母 DNA 混合 → 子代继承父母最高属性 + 血脉天赋（特殊卡/技能加成）。
// 谱系图 = 简单 parent → child Map（不多存，按需查 extra）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';

export const K_LINEAGE = 'lineage';

const CFG = {
  inheritanceBonus: 3,       // 子代继承父母最高属性 +3（超过初始 30-70 范围 → 天才后裔）
  bloodlineChance: 0.3,      // 出生时有血脉天赋的概率
  generationThreshold: 3,    // 第 3 代后裔开始有"血统"加成（世家效应）
};

export const LINEAGE_CONFIG = CFG;

const BLOODLINES = [
  { id: 'warrior', name: '武家血脉', bonus: { str: 10, con: 5 }, cardId: 'hunt' },
  { id: 'scholar', name: '书香门第', bonus: { int: 10, edu: 5 }, cardId: undefined },
  { id: 'merchant', name: '商贾世家', bonus: { app: 8, int: 5 }, cardId: undefined },
  { id: 'priest', name: '神官后裔', bonus: { pow: 10, faith: 5 }, cardId: undefined },
] as const;

// 血脉系统：有血脉天赋的小人心情加成 + applyLineage（出生时由 breeding 调用，设家族谱系+天赋）
// 2026-08-20：节流 5s（血脉天赋是被动 buff，不需要每帧遍历全体）
class LineageSystem {
  id = 'lineage';

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  private _timer = 0;
  update(dt: number): void {
    this._timer += dt;
    if (this._timer < 5) return;
    this._timer = 0;
    // 血脉系统被动：出生时由 breeding 包触发（bus 事件 pawn_spawned → 继承）
    // 这里做轻量检查：有血脉天赋的鼠每帧 mood 加成
    for (const eid of this.ctx.iterPawns) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st?.extra?.[K_LINEAGE]) continue;
      const lineage = st.extra[K_LINEAGE] as { bloodline?: string };
      if (lineage.bloodline) {
        // 血脉天赋心情加成（世家子弟更自信）
        const n = this.ctx.readNeeds(eid);
        if (n && n.mood < 100) { n.mood = Math.min(100, n.mood + 0.01); this.ctx.setNeeds(eid, n); }
      }
    }
  }
}

// 出生时设置血脉（breeding 包出生后调此函数，或 bus 事件驱动）
export function applyLineage(ctx: SimContext, babyEid: number, parentA: number, parentB: number): void {
  const baby = ctx.pawnStates.get(babyEid);
  if (!baby) return;
  const gen = Math.max(
    (ctx.pawnStates.get(parentA)?.extra?.[K_LINEAGE] as { generation?: number } | undefined)?.generation ?? 0,
    (ctx.pawnStates.get(parentB)?.extra?.[K_LINEAGE] as { generation?: number } | undefined)?.generation ?? 0,
  ) + 1;
  // 血脉天赋判定
  let bloodline: string | undefined;
  if (ctx.rng.next() < CFG.bloodlineChance || gen >= CFG.generationThreshold) {
    bloodline = BLOODLINES[Math.floor(ctx.rng.next() * BLOODLINES.length)]!.id;
  }
  baby.extra = { ...baby.extra, [K_LINEAGE]: { parents: [parentA, parentB], generation: gen, bloodline } };
  // 属性继承：父母最高 + bonus
  const pA = ctx.pawnStates.get(parentA);
  const pB = ctx.pawnStates.get(parentB);
  if (pA && pB) {
    for (const attr of ['str', 'con', 'siz', 'dex', 'int', 'pow', 'app', 'edu'] as const) {
      const inherited = Math.max(pA.dna[attr], pB.dna[attr]) + CFG.inheritanceBonus;
      baby.dna = { ...baby.dna, [attr]: Math.min(90, inherited) };
    }
  }
  if (bloodline) {
    const bl = BLOODLINES.find((b) => b.id === bloodline);
    if (bl) {
      for (const [k, v] of Object.entries(bl.bonus)) {
        baby.dna = { ...baby.dna, [k]: Math.min(99, (baby.dna as unknown as Record<string, number>)[k] + v) };
      }
      ctx.logEvent(`🩸 #${babyEid} 继承了${bl.name}`);
    }
  }
}

export const lineagePack: ModPack = {
  id: 'lineage',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'lineage', label: '血脉', category: 'world',
      ctor: (ctx) => new LineageSystem(ctx),
    });
    // 监听出生事件 → applyLineage
    m.registerHook('step:after', ({ sim }: { sim: SimContext }) => {
      // breeding 包出生后 lineage 在 extra 里设（breeding 调 applyLineage）
    });
  },
};