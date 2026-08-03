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
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      // 祈祷进度
      if (st.praying) {
        st.praying.progress += dt;
        if (st.praying.progress >= 2) {
          st.praying = undefined;
          this.ctx.adjustMood(eid, 6);
          this.ctx.logEvent('🕯 向篝火祈祷，心灵安宁');
        }
        continue;
      }
      // 采矿
      if (st.mining) {
        st.mining.progress += dt;
        if (st.mining.progress >= 3) {
          const { x, y } = st.mining;
          this.ctx.world.setTile(x, y, 'dirt');
          const ev = this.ctx.rollEvent(eid, 60);
          const gain = Math.round((ev.success ? 3 : 1) * toolBonus);
          this.ctx.stockpile.ore += gain;
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
          const ev = this.ctx.rollEvent(eid, 55);
          const gain = Math.round((ev.success ? 5 : 2) * toolBonus);
          this.ctx.stockpile.wood += gain;
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
