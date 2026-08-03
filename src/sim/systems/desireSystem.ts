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
    this.checkTimer -= dt;
    if (this.checkTimer <= 0) {
      this.checkTimer = 5; // 每 5 秒检查一次
      this.processDesires(dt * 5);
    }
  }

  private processDesires(dt: number): void {
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      if (!st.desires) continue;
      tickDesires(st.desires, st.dna.sins, dt);
      // 欲望满足反馈：根据当前状态给行为对应的欲望增量（吃/休息由卡系统直接 fulfill）
      this.fulfillFromActivity(st);
      // 心情影响：欲望普遍匮乏 → 心情降
      const { scarce, critical } = starvingDesires(st.desires);
      if (critical.length > 0) this.ctx.adjustMood(eid, -8);
      else if (scarce.length >= 2) this.ctx.adjustMood(eid, -3);
      // 恶意槽：长期匮乏的反社会行为
      if (critical.length > 0 && this.ctx.rng.next() < 0.12) {
        this.malintent(eid, st, critical);
      }
    }
  }

  // 由当前进行中的行为满足欲望（卡系统执行时已 fulfill，这里兜底：正在工作时满足贪婪）
  private fulfillFromActivity(st: { job?: string; desires?: Record<DesireId, number> }): void {
    const d = st.desires;
    if (!d) return;
    const job = st.job ?? '';
    if (job.includes('伐木') || job.includes('采矿') || job.includes('矿洞')) fulfill(d, 'greed', 2);
    if (job.includes('建造')) fulfill(d, 'greed', 1.5);
    if (job.includes('祈祷')) fulfill(d, 'pride', 2);
  }

  // 恶意槽（反社会行为）：偷窃 / 暴怒攻击
  private malintent(eid: number, st: { desires?: Record<DesireId, number> }, critical: DesireId[]): void {
    const d = st.desires;
    if (!d) return;
    const first = critical[0];
    if (first === 'greed' || first === 'sloth') {
      // 贪婪：偷窃资源（从库存拿一份）
      const s = this.ctx.stockpile;
      if (s.food > 10) { s.food -= 5; this.ctx.adjustMood(eid, 8); this.ctx.logEvent('😈 小人偷吃食物！'); fulfill(d, 'gluttony', 15); }
      else if (s.wood > 10) { s.wood -= 5; this.ctx.adjustMood(eid, 8); this.ctx.logEvent('😈 小人私藏木头！'); fulfill(d, 'greed', 15); }
    } else if (first === 'wrath') {
      // 暴怒：随机打碎一件附近建筑（或攻击野狼发泄）
      const pos = this.ctx.pawnPositions.get(eid);
      if (pos) {
        const b = this.ctx.world.getBuilding(Math.round(pos.x), Math.round(pos.y));
        if (b) {
          this.ctx.world.damageBuilding(Math.round(pos.x), Math.round(pos.y), 10);
          this.ctx.adjustMood(eid, 8);
          this.ctx.logEvent(`😡 小人暴怒，砸了${b.def.name}！`);
          fulfill(d, 'wrath', 15);
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
