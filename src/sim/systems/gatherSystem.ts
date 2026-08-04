// 采集系统：伐木/采矿进度 → 产出资源（通过事件）
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import type { EventBus } from '../core/events';

export class GatherSystem implements GameSystem {
  id = 'gather';

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    // 工具加成：每把工具 +30% 采集产出
    const toolBonus = (this.ctx.stockpile.tools ?? 0) > 0 ? 1.3 : 1;
    // STR 力量加成：采集产出（COC §3）
    const strBonusOf = (eid: number): number => {
      const dna = this.ctx.dnaOf(eid);
      return dna ? 1 + Math.max(0, (dna.str - 40)) / 100 : 1;
    };
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      // 祈祷进度
      if (st.praying) {
        st.praying.progress += dt;
        if (st.praying.progress >= 2) {
          st.praying = undefined;
          this.ctx.adjustMood(eid, 6);
          // APP 外貌：魅力高 → 信仰传播效果好（COC §3）
          const dna = this.ctx.dnaOf(eid);
          const appBoost = dna ? 1 + Math.max(0, (dna.app - 40)) / 50 : 1;
          st.faith = Math.min(100, (st.faith ?? 0) + 5 * appBoost);
          this.ctx.recordLean(eid, 'pray', 1);
          this.ctx.logEvent('🕯 向篝火祈祷，心灵安宁');
        }
        continue;
      }
      // 疗伤回血
      if (st.healing) {
        st.healing.progress += dt;
        const hk = this.ctx.readHealth(eid);
        if (hk) {
          hk.hp = Math.min(hk.maxHp, hk.hp + 12 * dt);
          this.ctx.setHealth(eid, hk);
          if (hk.hp >= hk.maxHp || st.healing.progress >= 4) {
            st.healing = undefined;
            st.job = '闲逛';
            this.ctx.logEvent('🩹 伤势痊愈');
          }
        }
        continue;
      }
      // 矿洞持续采掘（稳定产出，饥荒式矿场）
      if (st.caveWork) {
        st.caveWork.progress += dt;
        // 工作一段时间后结束，避免永远困在矿洞
        st.caveWork.duration = (st.caveWork.duration ?? 0) + dt;
        if ((st.caveWork.duration ?? 0) >= 40) {
          st.caveWork = undefined;
          st.job = '闲逛';
          this.ctx.logEvent('⛏ 结束了矿洞采掘');
          continue;
        }
        if (st.caveWork.progress >= 4) {
          st.caveWork.progress = 0;
          const ev = this.ctx.rollEventSkill(eid, 70, 'work');
          const gain = Math.round((ev.success ? 2 : 1) * toolBonus * strBonusOf(eid));
          this.ctx.stockpile.ore += gain;
          this.ctx.growSkill(eid, 'work'); this.ctx.recordLean(eid, 'caveMine', ev.success ? 1.5 : -1);
          this.ctx.bus.emit({ type: 'resource_gained', eid, item: 'ore', amount: gain });
          this.ctx.adjustMood(eid, ev.success ? 2 : -2);
          this.ctx.logEvent(ev.success ? '矿洞采到矿石' : '矿洞挖出废石');
        }
        continue;
      }
      // 采矿
      if (st.mining) {
        st.mining.progress += dt;
        if (st.mining.progress >= 3) {
          const { x, y } = st.mining;
          this.ctx.world.setTile(x, y, 'dirt');
          const ev = this.ctx.rollEventSkill(eid, 60, 'work');
          const gain = Math.round((ev.success ? 3 : 1) * toolBonus * strBonusOf(eid));
          this.ctx.stockpile.ore += gain;
          this.ctx.growSkill(eid, 'work'); this.ctx.recordLean(eid, 'mine', ev.success ? 1.5 : -1);
          this.ctx.bus.emit({ type: 'resource_gained', eid, item: 'ore', amount: gain });
          this.ctx.bus.emit({ type: 'work_completed', eid, work: 'mine', success: ev.success, x, y });
          this.ctx.adjustMood(eid, ev.success ? 3 : -4);
          this.ctx.logEvent(ev.success ? '采到富矿！' : '采矿一无所获');
          this.ctx.clearTrailCache();
          st.mining = undefined;
        }
      }
      // 伐木
      if (st.chopXY) {
        st.chopProgress = (st.chopProgress ?? 0) + dt;
        if (st.chopProgress >= 2.5) {
          const { x, y } = st.chopXY;
          this.ctx.world.setTile(x, y, 'grass');
          const ev = this.ctx.rollEventSkill(eid, 55, 'work');
          const gain = Math.round((ev.success ? 5 : 2) * toolBonus * strBonusOf(eid));
          this.ctx.stockpile.wood += gain;
          this.ctx.growSkill(eid, 'work'); this.ctx.recordLean(eid, 'chop', ev.success ? 1.5 : -1);
          this.ctx.bus.emit({ type: 'resource_gained', eid, item: 'wood', amount: gain });
          this.ctx.bus.emit({ type: 'work_completed', eid, work: 'chop', success: ev.success, x, y });
          this.ctx.adjustMood(eid, ev.success ? 2 : -3);
          this.ctx.clearTrailCache();
          st.chopXY = undefined;
          st.chopProgress = undefined;
        }
      }
    }
  }
}
