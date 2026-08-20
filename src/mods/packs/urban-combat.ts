// 巷战玩法包（2026-08-20，用户「添加巷战玩法包，视野等」）：
// 视野系统：小人/敌人有视野范围，墙/建筑遮挡视线 → 看不见的敌人不攻击/不被攻击
// 巷战 = 高密度建筑群中的近距离战斗：视线受限 → 转角遭遇战
// 种子原则：
// 1. 视野 = 射线投射（LOS line-of-sight）→ po 边界格是 barrier → 遮挡
// 2. 攻击需要 LOS：无 LOS 的敌人不可被远程攻击/不可被征召追踪
// 3. 视野节流 0.5s（LOS 计算较贵，不需每帧）
// 4. 高地（z 差）> climb → 视线跨越（站得高看得远）
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';

const CFG = {
  visionRange: 12,          // 小人视野范围（格）
  visionCheckInterval: 0.5, // 视野节流（LOS 计算较贵）
  barrierTags: ['barrier'],  // 遮挡视线的建筑 tag
  edgePadding: 3,            // 地图边缘不可视（未知区域）
  highGroundBonus: 4,        // 每 1 z 差 +4 格视野（站得高看得远）
};

// 视野缓存：eid → { x, y, range, visibleHostiles: Set<idx>, visiblePawns: Set<eid> }
// 只缓存有视野需求的小人（征召 + 指挥官），非征召不计算
const visionCache = new Map<number, { x: number; y: number; range: number; visibleHostiles: Set<number> }>();

// Bresenham 射线投射：判断 (x0,y0) → (x1,y1) 是否被 barrier 遮挡
// 逐格推进，遇到 barrier 建筑 → 遮挡；到达目标 → 可见
function hasLOS(ctx: SimContext, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  // 最多走视野范围步（防无限循环）
  const maxSteps = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2) + 1;
  for (let i = 0; i < maxSteps; i++) {
    // 到达目标（含目标自身）
    if (x === x1 && y === y1) return true;
    // 检查当前格是否有 barrier 建筑遮挡（起点本身不算）
    if (i > 0) {
      const b = ctx.world.getBuilding(x, y);
      if (b && b.def.tags?.some(t => CFG.barrierTags.includes(t))) return false;
    }
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return false;
}

class UrbanCombatSystem {
  id = 'urban-combat';
  private _throttle = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < CFG.visionCheckInterval) return;
    this._throttle = 0;

    // 只计算征召/指挥官小人的视野（非征召=平民不参与战斗，无需视野）
    for (const eid of this.ctx.iterPawns) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st) continue;
      const drafted = st.extra?.['drafted' as string] === true;
      const commander = st.extra?.['commander' as string];
      if (!drafted && !commander) continue;

      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;

      // 视野范围 = 基础 + z 差加成
      const z0 = this.ctx.world.getTileDef(Math.round(pos.x), Math.round(pos.y)).z ?? 0;
      const range = CFG.visionRange + z0 * CFG.highGroundBonus;

      // 计算可见敌人（LOS + 距离）
      const visible = new Set<number>();
      for (let i = 0; i < this.ctx.hostiles.length; i++) {
        const h = this.ctx.hostiles[i]!;
        const d = Math.hypot(h.x - pos.x, h.y - pos.y);
        if (d > range) continue;
        if (hasLOS(this.ctx, Math.round(pos.x), Math.round(pos.y), Math.round(h.x), Math.round(h.y))) {
          visible.add(i);
        }
      }
      visionCache.set(eid, { x: pos.x, y: pos.y, range, visibleHostiles: visible });
    }

    // 清理已死亡的小人视野
    const alive = new Set(this.ctx.iterPawns);
    for (const eid of visionCache.keys()) {
      if (!alive.has(eid)) visionCache.delete(eid);
    }
  }

  // 查询：eid 是否看见 hostileIndex
  canSee(eid: number, hostileIndex: number): boolean {
    const v = visionCache.get(eid);
    if (!v) return false;
    return v.visibleHostiles.has(hostileIndex);
  }

  // 查询：eid 看见多少敌人
  visibleCount(eid: number): number {
    return visionCache.get(eid)?.visibleHostiles.size ?? 0;
  }
}

export const urbanCombatPack: ModPack = {
  id: 'urban-combat',
  requires: ['drafting'],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'urban-combat', label: '巷战视野', category: 'raid',
      ctor: (ctx) => {
        const sys = new UrbanCombatSystem(ctx);
        // 能力让渡：drafting/field-command/weapons 通过 getCap 查视野
        ctx.provide('vision', {
          canSee: (eid: number, hostileIndex: number) => sys.canSee(eid, hostileIndex),
          visibleCount: (eid: number) => sys.visibleCount(eid),
          hasLOS: (x0: number, y0: number, x1: number, y1: number) => hasLOS(ctx, x0, y0, x1, y1),
        });
        return sys;
      },
    });
  },
};