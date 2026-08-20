// P2-6: zone 系统（2026-08-20，Dwarf Fortress/RimWorld 风格）
// 设计：玩家划定区域（zone）→ 区域内的小人自动执行对应行为：
// - work zone：区域内优先采集/工作
// - home zone：区域内优先休息/居住
// - storage zone：区域内存放物品
// - forbid zone：区域内禁止进入
// zone = 简单的矩形区域 + tag，通过 moveAdjacent/findNearest 的条件过滤影响行为。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';

const CFG = {
  maxZones: 20,         // 最多 20 个区域
  zoneCheckInterval: 2,  // zone 节流 2s
};

export interface Zone {
  id: string;
  type: 'work' | 'home' | 'storage' | 'forbid';
  x1: number; y1: number; x2: number; y2: number; // 矩形
  label?: string;
}

// 区域系统：管理 work/home/storage/forbid 四类区域，提供 inZone 查询给其他系统
// 其他系统通过 ctx.getCap("zone") 查询某点是否在某类区域内
class ZoneSystem {
  id = 'zone';
  private _throttle = 0;
  zones: Zone[] = [];

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < CFG.zoneCheckInterval) return;
    this._throttle = 0;
    // zone 系统本身不做逻辑——只是提供 zone 查询给其他系统
    // 其他系统通过 ctx.getCap('zone')?.inZone(x, y, type) 查询
  }

  inZone(x: number, y: number, type: Zone['type']): boolean {
    for (const z of this.zones) {
      if (z.type !== type) continue;
      if (x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2) return true;
    }
    return false;
  }

  getZones(type?: Zone['type']): Zone[] {
    return type ? this.zones.filter(z => z.type === type) : this.zones;
  }

  addZone(z: Omit<Zone, 'id'> & { id?: string }): string {
    if (this.zones.length >= CFG.maxZones) return '';
    const id = z.id || `zone_${this.zones.length}`;
    this.zones.push({ ...z, id });
    return id;
  }

  removeZone(id: string): boolean {
    const idx = this.zones.findIndex(z => z.id === id);
    if (idx >= 0) { this.zones.splice(idx, 1); return true; }
    return false;
  }
}

export const zonePack: ModPack = {
  id: 'zone',
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'zone', label: '区域', category: 'world',
      ctor: (ctx) => {
        const sys = new ZoneSystem(ctx);
        // 自报能力：其他系统通过 ctx.getCap('zone') 查询
        ctx.provide('zone', {
          inZone: (x: number, y: number, type: string) => sys.inZone(x, y, type as Zone['type']),
          getZones: (type?: string) => sys.getZones(type as Zone['type']),
          addZone: (z: Parameters<ZoneSystem['addZone']>[0]) => sys.addZone(z),
          removeZone: (id: string) => sys.removeZone(id),
        });
        return sys;
      },
    });
    // zone 命令：划定/删除区域
    m.registerCommand('zone', (ctx, cmd) => {
      const cap = ctx.getCap('zone') as { addZone?: (z: { id?: string; type: string; x1: number; y1: number; x2: number; y2: number; label?: string }) => string; removeZone?: (id: string) => boolean } | null;
      if (!cap) { ctx.logEvent('⚠ zone 系统未挂载'); return; }
      const args = cmd.args as { action?: string; type?: string; x1?: number; y1?: number; x2?: number; y2?: number; id?: string; label?: string };
      if (args.action === 'remove') {
        if (args.id && cap.removeZone?.(args.id)) ctx.logEvent(`🚫 区域 ${args.id} 已删除`);
      } else if (args.type && args.x1 !== undefined && args.y1 !== undefined && args.x2 !== undefined && args.y2 !== undefined) {
        const id = cap.addZone?.({ type: args.type, x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, label: args.label });
        ctx.logEvent(`📐 划定${args.type}区域 ${id} (${args.x1},${args.y1})-(${args.x2},${args.y2})`);
      }
    });
  },
};