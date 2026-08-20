// 热区/冷区系统（2026-08-20，用户「热区（前线）冷区（前线之外）」）：
// 在 zone 系统基础上扩展 'front'（热区/前线）和 'rear'（冷区/后方）类型。
// 热区 = 战斗活跃区域（自动检测：有敌人在附近 → 该区域变热）
// 冷区 = 前线之外（安全区域）
// 影响：
// 1. 热区内的小人自动征召（非征召鼠进入热区 → 自动征召自卫）
// 2. 热区内的建筑自动受损（战争破坏）→ 修理优先
// 3. 冷区内的小人不参与战斗（自动解除征召 → 回归生产）
// 4. 指挥链优先向热区下达冲锋，冷区下达集结
// 种子原则：不写新系统——扩展 zone type + 系统驱动
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';
import { K_DRAFTED } from '../../sim/mods/contracts';
import { World } from '../../sim/core/world';

const CFG = {
  frontDetectRange: 15,      // 热区自动检测：敌人 15 格内 = 热区
  frontCheckInterval: 3,     // 热区检测 3s 一次
  autoDraftInFront: true,    // 热区内自动征召
  autoUndraftInRear: true,   // 冷区内自动解除征召
  buildingDamageInFront: 0.5, // 热区内建筑每秒受损 0.5（战争破坏）
};

export interface HotColdZone {
  id: string;
  type: 'front' | 'rear';     // front=热区/前线, rear=冷区/后方
  x1: number; y1: number; x2: number; y2: number;
  label?: string;
  // 运行时状态（热区是否活跃 = 检测到敌人在范围内）
  active?: boolean;
  enemyCount?: number;
}

// 热区冷区系统：前线（有敌人=热区）→ 自动征召 + 建筑损坏；后方（冷区）→ 自动解除征召
// 3s 节流（热区检测），15 格内检测敌人 active 状态
// 指挥链联动：getActiveFronts() 供指挥官查询
class HotColdSystem {
  id = 'hot-cold';
  private _throttle = 0;
  zones: HotColdZone[] = [];

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < CFG.frontCheckInterval) return;
    this._throttle = 0;

    // 更新热区状态：检测各热区附近敌人数量 → 标记 active
    for (const z of this.zones) {
      if (z.type !== 'front') continue;
      const cx = (z.x1 + z.x2) / 2;
      const cy = (z.y1 + z.y2) / 2;
      let enemies = 0;
      const r2 = CFG.frontDetectRange * CFG.frontDetectRange;
      for (const h of this.ctx.hostiles) {
        const d2 = (h.x - cx) ** 2 + (h.y - cy) ** 2;
        if (d2 <= r2) enemies++;
      }
      z.enemyCount = enemies;
      z.active = enemies > 0;

      if (z.active) {
        // 热区内自动征召非征召鼠
        if (CFG.autoDraftInFront) {
          for (const eid of this.ctx.iterPawns) {
            const pos = this.ctx.pawnPositions.get(eid);
            if (!pos) continue;
            if (pos.x < z.x1 || pos.x > z.x2 || pos.y < z.y1 || pos.y > z.y2) continue;
            const st = this.ctx.pawnStates.get(eid);
            if (st && st.extra?.[K_DRAFTED] !== true) {
              st.extra = { ...st.extra, [K_DRAFTED]: true };
              st.job = '待命';
            }
          }
        }

        // 热区内建筑受损（战争破坏）
        for (const [k, b] of this.ctx.world.buildings) {
          // 简化：只检查建筑中心是否在热区内
          const { x, y } = World.keyToXY(k);
          if (x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) {
            this.ctx.world.damageBuilding(x, y, CFG.buildingDamageInFront * CFG.frontCheckInterval);
          }
        }
      }
    }

    // 冷区内自动解除征召（回归生产）
    if (CFG.autoUndraftInRear) {
      for (const z of this.zones) {
        if (z.type !== 'rear') continue;
        for (const eid of this.ctx.iterPawns) {
          const pos = this.ctx.pawnPositions.get(eid);
          if (!pos) continue;
          if (pos.x < z.x1 || pos.x > z.x2 || pos.y < z.y1 || pos.y > z.y2) continue;
          const st = this.ctx.pawnStates.get(eid);
          // 只解除非指挥官的征召（指挥官不能被自动解除）
          if (st && st.extra?.[K_DRAFTED] === true && !st.extra?.['commander']) {
            st.extra = { ...st.extra, [K_DRAFTED]: false };
            st.job = '闲逛';
          }
        }
      }
    }
  }

  // 查询某点是否在活跃热区内
  inHotZone(x: number, y: number): boolean {
    for (const z of this.zones) {
      if (z.type !== 'front' || !z.active) continue;
      if (x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) return true;
    }
    return false;
  }

  // 查询某点是否在冷区内
  inColdZone(x: number, y: number): boolean {
    for (const z of this.zones) {
      if (z.type !== 'rear') continue;
      if (x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) return true;
    }
    return false;
  }

  // 获取所有活跃热区
  getActiveFronts(): HotColdZone[] {
    return this.zones.filter(z => z.type === 'front' && z.active);
  }

  addZone(z: Omit<HotColdZone, 'id' | 'active' | 'enemyCount'> & { id?: string }): string {
    const id = z.id || `hc_${this.zones.length}`;
    this.zones.push({ ...z, id, active: false, enemyCount: 0 });
    return id;
  }

  removeZone(id: string): boolean {
    const idx = this.zones.findIndex(z => z.id === id);
    if (idx >= 0) { this.zones.splice(idx, 1); return true; }
    return false;
  }
}

export const hotColdPack: ModPack = {
  id: 'hot-cold',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'hot-cold', label: '热区冷区', category: 'raid',
      ctor: (ctx) => {
        const sys = new HotColdSystem(ctx);
        ctx.provide('hot-cold', {
          inHotZone: (x: number, y: number) => sys.inHotZone(x, y),
          inColdZone: (x: number, y: number) => sys.inColdZone(x, y),
          getActiveFronts: () => sys.getActiveFronts(),
          addZone: (z: Parameters<HotColdSystem['addZone']>[0]) => sys.addZone(z),
          removeZone: (id: string) => sys.removeZone(id),
        });
        return sys;
      },
    });

    // hotcold 命令：划定热区/冷区
    m.registerCommand('hotcold', (ctx, cmd) => {
      const cap = ctx.getCap('hot-cold') as { addZone?: (z: { id?: string; type: string; x1: number; y1: number; x2: number; y2: number; label?: string }) => string; removeZone?: (id: string) => boolean } | null;
      if (!cap) { ctx.logEvent('⚠ hot-cold 系统未挂载'); return; }
      const args = cmd.args as { action?: string; type?: string; x1?: number; y1?: number; x2?: number; y2?: number; id?: string; label?: string };
      if (args.action === 'remove') {
        if (args.id && cap.removeZone?.(args.id)) ctx.logEvent(`🚫 ${args.id} 已删除`);
      } else if (args.type && args.x1 !== undefined && args.y1 !== undefined && args.x2 !== undefined && args.y2 !== undefined) {
        const id = cap.addZone?.({ type: args.type, x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, label: args.label });
        ctx.logEvent(`${args.type === 'front' ? '🔴 热区' : '🔵 冷区'} ${id} 已划定 (${args.x1},${args.y1})-(${args.x2},${args.y2})`);
      }
    });
  },
};