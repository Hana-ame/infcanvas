// P2-9: belt/logistics（2026-08-20，Factorio 风格传送带物流）
// 设计：建造传送带 → 自动运输物品（从产出点 → 存储点）
// 传送带 = 建筑，有 direction（上下左右），连成链后自动搬运。
// 每条传送带每秒搬运 0.5 单位物品（从上游取 → 放到下游）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { ModPack } from '../pack';
import { World } from '../../sim/core/world';

const CFG = {
  beltMovePerSec: 0.5,  // 传送带每秒搬运量
  beltCheckInterval: 2,  // 评估间隔 2s
  beltCapacity: 5,      // 传送带上最多暂存 5 单位
  maxBeltChain: 50,     // 最长链 50 格（防爆栈）
};

const DIRS: Record<string, [number, number]> = {
  'up': [0, -1], 'down': [0, 1], 'left': [-1, 0], 'right': [1, 0],
};

// 传送带系统：按方向链式搬运物品（产出点→传送带→存储点），每秒 0.5 单位
// 2s 节流（搬运不需要每帧检查），cellSize=8 空间哈希查找下游
class BeltSystem {
  id = 'belt';
  private _throttle = 0;

  constructor(private ctx: SimContext) {}

  init(_bus: EventBus): void {}

  update(dt: number): void {
    this._throttle += dt;
    if (this._throttle < CFG.beltCheckInterval) return;
    const accumDt = this._throttle;
    this._throttle = 0;

    // 收集所有传送带 → 按 direction 分组 → 遍历链搬运
    const belts: { x: number; y: number; dir: string; item?: string; amount: number }[] = [];
    for (const [k, b] of this.ctx.world.buildings) {
      if (b.def.id !== 'conveyor-belt') continue;
      const pos = World.keyToXY(k);
      const dir = (b.def.meta as Record<string, unknown>)?.direction as string ?? 'right';
      belts.push({ x: pos.x, y: pos.y, dir, amount: (b.def.meta as Record<string, number>)?.buffer ?? 0, item: (b.def.meta as Record<string, string | undefined>)?.bufferItem });
    }

    if (belts.length === 0) return;

    // 按 position 建索引
    const beltMap = new Map<string, typeof belts[0]>();
    for (const b of belts) beltMap.set(`${b.x},${b.y}`, b);

    // 遍历每条传送带 → 向下游搬运
    for (const belt of belts) {
      if (belt.amount <= 0) continue;
      const move = Math.min(belt.amount, CFG.beltMovePerSec * accumDt);

      // 找下游传送带
      const [dx, dy] = DIRS[belt.dir] ?? [1, 0];
      let nx = belt.x + dx, ny = belt.y + dy;
      const downstream = beltMap.get(`${nx},${ny}`);
      if (downstream && downstream.amount < CFG.beltCapacity) {
        // 搬运到下游
        const transfer = Math.min(move, CFG.beltCapacity - downstream.amount);
        downstream.amount += transfer;
        belt.amount -= transfer;
        if (!downstream.item && belt.item) downstream.item = belt.item;
      } else {
        // 无下游 → 检查是否是存储建筑（仓库/筒仓）
        const storageB = this.ctx.world.getBuilding(nx, ny);
        if (storageB && storageB.def.tags?.includes('storage')) {
          // 存入仓库
          if (belt.item) {
            this.ctx.stockpile[belt.item] = Math.min(500, (this.ctx.stockpile[belt.item] ?? 0) + move);
            belt.amount -= move;
          }
        }
      }
    }
  }
}

export const beltPack: ModPack = {
  id: 'belt',
  requires: ['build'],
  apply(m: ModRegistry): void {
    // 传送带建筑（4 方向：通过 meta.direction 控制）
    for (const [dir, emoji] of [['right', '➡'], ['left', '⬅'], ['up', '⬆'], ['down', '⬇']]) {
      m.registerBuilding({
        id: `conveyor-belt-${dir}`, name: `传送带(${dir})`, size: { x: 1, y: 1 }, hp: 50, color: '#5a5a5a',
        emoji, passable: true, buildTime: 1,
        tags: ['belt', 'road'], meta: { direction: dir, buffer: 0, bufferItem: undefined },
        costWood: 2,
      });
    }
    // 通用传送带（默认 right 方向）
    m.registerBuilding({
      id: 'conveyor-belt', name: '传送带', size: { x: 1, y: 1 }, hp: 50, color: '#5a5a5a',
      emoji: '➡', passable: true, buildTime: 1,
      tags: ['belt', 'road'], meta: { direction: 'right', buffer: 0 },
      costWood: 2,
    });

    m.registerSystemDef({
      id: 'belt', label: '传送带', category: 'production',
      ctor: (ctx) => new BeltSystem(ctx),
    });
  },
};