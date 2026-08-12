// 修理系统：受损建筑由空闲小人自动修复
// 数据驱动：workTime/searchRadius/inPlaceDist 读 tuning.repair（mod 可调）
import type { GameSystem } from './registry';
import type { SimContext } from './context';

export class RepairSystem implements GameSystem {
  id = 'repair';
  // 记录每个正在修理的小人：{ eid, key, progress }
  private repairing = new Map<number, { x: number; y: number; progress: number }>();

  constructor(private ctx: SimContext) {}

  update(dt: number): void {
    const rp = this.ctx.tuning.repair;
    // 推进正在修理的
    for (const [eid, r] of [...this.repairing]) {
      // 若小人不在（死了）或建筑没了，移除
      const st = this.ctx.pawnStates.get(eid);
      if (!st) { this.repairing.delete(eid); continue; }
      if (!this.ctx.world.getBuilding(r.x, r.y)) { this.repairing.delete(eid); continue; }
      r.progress += dt;
      if (r.progress >= rp.workTime) {
        this.ctx.world.repairBuilding(r.x, r.y, rp.repairAmount);
        this.repairing.delete(eid);
        st.job = '闲逛';
        this.ctx.logEvent('🔧 小人修好了建筑');
      }
    }

    // 给空闲小人派修理活
    for (const eid of this.ctx.pawnList) {
      if (this.repairing.has(eid)) continue;
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      // 只在真正空闲时派活（没在工作/没在走路）
      if (st.path && st.path.length > 0) continue;
      if (st.mining || st.chopXY || st.praying) continue;
      if (st.urgent) continue;
      const pos = this.ctx.readPosition(eid);
      if (!pos) continue;
      // 找受损建筑
      const target = this.findDamaged(pos, this.ctx.tuning.repair.searchRadius);
      if (!target) continue;
      st.job = '修理';
      // 距离近则直接开始修，否则走过去
      const d = Math.hypot(pos.x - target.x, pos.y - target.y);
      if (d <= this.ctx.tuning.repair.inPlaceDist) {
        this.repairing.set(eid, { x: target.x, y: target.y, progress: 0 });
      } else {
        this.ctx.moveAdjacent(eid, target.x, target.y);
      }
    }
  }

  // 扫 radius 内最近的受损建筑（修理优先级 = 距离最近；chunk 分区查询）
  private findDamaged(pos: { x: number; y: number }, radius: number): { x: number; y: number } | null {
    const w = this.ctx.world;
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const b of w.queryBuildingsNear(Math.round(pos.x), Math.round(pos.y), radius)) {
      if (b.hp >= b.def.hp) continue;
      if (b.dist < bestD) { bestD = b.dist; best = { x: b.key % w.width, y: Math.floor(b.key / w.width) }; }
    }
    return best;
  }
}
