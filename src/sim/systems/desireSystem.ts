// 欲望系统（DESIGN §3）—— 七宗罪满足度：衰减/满足/行为影响/恶意槽
// 满足途径：进食→暴食、休息→懒惰、工作产出→贪婪、战斗→暴怒、祈祷→傲慢
// 长期匮乏 → 恶意槽：偷窃资源 / 暴怒攻击（反社会行为）
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';
import type { DesireId } from '../core/desires';
import { DESIRES, tickDesires, fulfill, starvingDesires } from '../core/desires';

// 卡系列 → 欲望映射（满足该行为即满足对应欲望）
const SERIES_TO_DESIRE: Record<string, DesireId> = {
  physio: 'gluttony',
  leisure: 'sloth',
  work: 'greed',
  combat: 'wrath',
  religion: 'pride',
};

export class DesireSystem implements GameSystem {
  id = 'desire';
  private checkTimer = 0; // 定期检查（欲望变化慢，检查也慢）

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    const d = this.ctx.tuning.desire;
    this.checkTimer -= dt;
    if (this.checkTimer <= 0) {
      this.checkTimer = d.checkInterval; // 定期检查（欲望变化慢，检查也慢）
      this.processDesires(dt * d.checkInterval);
    }
  }

  private processDesires(dt: number): void {
    const t = this.ctx.tuning.desire;
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      if (!st.desires) continue;
      tickDesires(st.desires, st.dna.sins, dt, t);
      // 欲望满足反馈由卡系统在"卡被选中执行"时 fulfill（卡 declares satisfies，见 docs）——
      // 不再按 job 文案子串匹配（语义脆、mod 新工作无从满足）
      // 心情影响：欲望普遍匮乏 → 心情降
      const { scarce, critical } = starvingDesires(st.desires, t);
      if (critical.length > 0) this.ctx.adjustMood(eid, t.moodCritical);
      else if (scarce.length >= 2) this.ctx.adjustMood(eid, t.moodScarce);
      // 恶意槽：长期匮乏的反社会行为（POW 意志压制，DESIGN §3）
      if (critical.length > 0) {
        const dna = this.ctx.dnaOf(eid);
        const powResist = dna ? 1 - Math.max(0, (dna.pow - 40)) / 100 : 1;
        if (this.ctx.rng.next() < t.malintentChance * Math.max(t.powResistBase, powResist)) {
          this.malintent(eid, st, critical);
        }
      }
    }
  }

  // 恶意槽（反社会行为）：偷窃 / 暴怒攻击
  private malintent(eid: number, st: { desires?: Record<DesireId, number> }, critical: DesireId[]): void {
    const t = this.ctx.tuning.desire;
    const d = st.desires;
    if (!d) return;
    const first = critical[0];
    if (first === 'greed' || first === 'sloth') {
      // 贪婪：偷窃资源（从库存拿一份）
      const s = this.ctx.stockpile;
      if (s.food > t.stealThreshold) { s.food -= t.stealAmount; this.ctx.adjustMood(eid, t.malintentMoodGain); this.ctx.logEvent('😈 小人偷吃食物！'); fulfill(d, 'gluttony', t.malintentFulfill); }
      else if (s.wood > t.stealThreshold) { s.wood -= t.stealAmount; this.ctx.adjustMood(eid, t.malintentMoodGain); this.ctx.logEvent('😈 小人私藏木头！'); fulfill(d, 'greed', t.malintentFulfill); }
    } else if (first === 'wrath') {
      // 暴怒：随机打碎一件附近建筑（或攻击野狼发泄）
      const pos = this.ctx.pawnPositions.get(eid);
      if (pos) {
        const b = this.ctx.world.getBuilding(Math.round(pos.x), Math.round(pos.y));
        if (b) {
          this.ctx.world.damageBuilding(Math.round(pos.x), Math.round(pos.y), 10);
          this.ctx.adjustMood(eid, t.malintentMoodGain);
          this.ctx.logEvent(`😡 小人暴怒，砸了${b.def.name}！`);
          fulfill(d, 'wrath', t.malintentFulfill);
        } else {
          this.ctx.adjustMood(eid, 5);
          this.ctx.logEvent('😡 小人暴躁地原地转圈');
          fulfill(d, 'wrath', 8);
        }
      }
    } else if (first === 'lust' || first === 'envy' || first === 'pride') {
      this.ctx.adjustMood(eid, -2);
    }
  }
}
