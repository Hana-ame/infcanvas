// 修理系统：受损建筑由空闲小人自动修复
// 数据驱动：workTime/searchRadius/inPlaceDist 读 tuning.repair（mod 可调）
import type { GameSystem } from './registry';
import type { SimContext } from './context';
import { World } from '../core/world';
import { buildTagIndex, findNearestTagged } from './building-cache';
import { K_DRAFTED } from '../mods/contracts';

// 修缮系统：搜索受损建筑 → 派空闲小人过去修 → 修理进度推进 → hp 恢复
export class RepairSystem implements GameSystem {
  id = 'repair';
  private _bldVer = -1;
  private tagIndex: Map<string, import('./building-cache').CachedBuilding[]> = new Map();
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

    // 2026-08-20 节流：tagIndex 只在建筑变更时重建（version-check）
    if (this._bldVer !== this.ctx.world.buildingVersion) {
      this._bldVer = this.ctx.world.buildingVersion;
      this.tagIndex = buildTagIndex(this.ctx);
    }
    // 给空闲小人派修理活
    for (const eid of this.ctx.iterPawns) {
      if (this.repairing.has(eid)) continue;
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      // 只在真正空闲时派活（没在工作/没在走路）
      if (st.path && st.path.length > 0) continue;
      if (st.mining || st.chopXY || st.praying) continue;
      if (st.urgent) continue;
      // 征召/战斗指挥中的小人不受自动修理差遣（2026-08-20 修复：meleeRange 缩小后
      // 站桩敌会拆营地 → RepairSystem 把征召兵拉去修篝火，覆盖玩家战术命令））
      if (st.extra?.[K_DRAFTED] === true) continue;
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

  // 扫 radius 内最近的受损建筑（2026-08-20 架构优化：用共享 building-cache）
  private findDamaged(pos: { x: number; y: number }, radius: number): { x: number; y: number } | null {
    
    // 遍历所有 tag 的建筑找受损的
    let best: { x: number; y: number } | null = null;
    let bestD = radius * radius;
    for (const [, buildings] of this.tagIndex) {
      for (const raw of buildings) {
        const b = raw as { hp: number; maxHp: number; x: number; y: number };
        if (b.hp >= b.maxHp) continue;
        const d = (b.x - pos.x) ** 2 + (b.y - pos.y) ** 2;
        if (d < bestD) { bestD = d; best = { x: b.x, y: b.y }; }
      }
    }
    return best;
  }
}
