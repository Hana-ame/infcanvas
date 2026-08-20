// 疾病系统玩法包（2026-08-20，用户「疾病」）：瘟疫传播/隔离/草药治疗
// 设计：疾病走 PawnState.extra[K_DISEASE] = { type, progress, severity }。
// 传播 = 邻近小人有概率感染（社交距离内）；隔离 = 移走病人到远处防扩散；
// 草药 = 采集 herb tile（新 tile）→ 草药治愈。不治疗 → severity 递增 → 死亡。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';

export const K_DISEASE = 'disease';

const CFG = {
  infectRange: 8, // 2026-08-20 平衡：3→8（接触距离更合理, 小人不会贴脸）         // 感染范围（格）
  infectChance: 0.1, // 2026-08-20 平衡：0.02→0.1（接触感染概率提高, 否则小人移动太快不在范围内）     // 每秒邻近感染概率
  severityRate: 0.03, // 2026-08-20 平衡：0.05→0.03（恶化稍慢, 给治疗时间）     // 不治疗时严重度增速/s
  cureRate: 0.5,          // 草药治疗增速/s
  lethalityAt: 1.0,       // 严重度达此值 → 死亡
  herbSpawnChance: 0.15,  // 草药丛在世界生成的概率
  tickInterval: 2,        // 低频评估周期
};

export const DISEASE_CONFIG = CFG;

// 疾病系统：瘟疫传播（邻近小人概率感染）+ 恶化（不治疗 severity 递增 → 死亡）+ 草药治疗
// 2026-08-20：节流 2s（传播概率评估不需要每帧）；infectRange=8 格（小人不会贴脸站）
class DiseaseSystem {
  id = 'disease';
  private timer = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this.timer += dt;
    if (this.timer < CFG.tickInterval) return;
    this.timer = 0;
    const infected: number[] = [];
    for (const eid of this.ctx.iterPawns) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st?.extra?.[K_DISEASE]) continue;
      infected.push(eid);
      const disease = st.extra[K_DISEASE] as { severity: number; type: string };
      // 严重度递增
      disease.severity += CFG.severityRate * CFG.tickInterval;
      if (disease.severity >= CFG.lethalityAt) {
        this.ctx.killPawn(eid);
        this.ctx.logEvent(`💀 #${eid} 因${disease.type}去世`);
        continue;
      }
      // 传播给邻近小人
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;
      for (const other of this.ctx.iterPawns) {
        if (other === eid || infected.includes(other)) continue;
        const ost = this.ctx.pawnStates.get(other);
        if (!ost || ost.extra?.[K_DISEASE]) continue;
        const opos = this.ctx.pawnPositions.get(other);
        if (!opos) continue;
        const d = Math.hypot(pos.x - opos.x, pos.y - opos.y);
        if (d <= CFG.infectRange && this.ctx.rng.next() < CFG.infectChance) {
          ost.extra = { ...ost.extra, [K_DISEASE]: { type: disease.type, severity: 0.1 } };
          this.ctx.logEvent(`🤒 #${other} 被感染了${disease.type}`);
        }
      }
    }
  }
}

export const diseasePack: ModPack = {
  id: 'disease',
  requires: [],
  apply(m: ModRegistry): void {
    // 草药 tile
    m.registerTile({
      id: 'herb', name: '草药丛', passable: true, buildable: true,
      color: '#4a8a3a', growable: true, sprite: 'terrain:tree',
      harvest: { product: 'disease-herb', time: 1, yieldSuccess: 2, yieldFail: 0, dc: 40 },
      harvestReplaces: 'grass',
    });
    // 草药物品
    m.registerItem({ id: 'disease-herb', name: '草药' });
    m.registerSystemDef({
      id: 'disease', label: '疾病', category: 'world',
      ctor: (ctx) => new DiseaseSystem(ctx),
    });
    // treat 命令：用草药治疗
    m.registerCommand('treat', (ctx, cmd) => {
      const eid = cmd.pawnId;
      if (eid === undefined) return;
      const st = ctx.pawnStates.get(eid);
      if (!st?.extra?.[K_DISEASE]) { ctx.logEvent('⚠ 没有疾病'); return; }
      if ((ctx.stockpile['disease-herb'] ?? 0) < 1) { ctx.logEvent('⚠ 没有草药'); return; }
      ctx.stockpile['disease-herb'] -= 1;
      ctx.recordSpend(null, 'disease-herb', 1);
      const disease = st.extra[K_DISEASE] as { severity: number; type: string };
      disease.severity -= CFG.cureRate;
      if (disease.severity <= 0) {
        delete st.extra![K_DISEASE];
        ctx.logEvent(`🌿 #${eid} 康复了！`);
      } else {
        ctx.logEvent(`🌿 #${eid} 服药后好转`);
      }
    });
  },
};