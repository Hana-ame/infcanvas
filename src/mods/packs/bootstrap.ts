// 引导玩法包（2026-08-15 内核纯引擎：出生引导迁出为插件）
// 背景：Sim 构造函数硬编码的"出生刷人 + 初始营地 + 建篝火归属"引导逻辑（原 spawnPawns/
//   ensureInitialCamp + building_built bus 回调）是玩法引导，非演算框架职责。纯引擎裁决迁出
//   为 bootstrap 玩法包：BootstrapSystem.init 在系统装配完成后刷初始小人 + 首个营地 +
//   订阅建篝火 → 区域记忆归属；同时 `provide('bootstrap')` 供 Sim.respawnPawns/ensureCamp
//   （空世界重开）委托。
// 刷人位置 = 世界中心 3×3 块（与原 spawnPawns 一致）；初始建筑 = tuning.autobuild.starterBuilding。
import type { ModRegistry } from '../../sim/mods/registry';
import type { GameSystem } from '../../sim/systems/registry';
import type { SimContext } from '../../sim/systems/context';
import type { EventBus } from '../../sim/core/events';
import type { GameEvent } from '../../sim/core/events';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

// bootstrap 能力：Sim.respawnPawns/ensureCamp 委托目标（空世界重开）
export interface BootstrapCap {
  respawn(count: number): void;
  ensureCamp(): void;
}

export class BootstrapSystem implements GameSystem {
  id = 'bootstrap';

  constructor(private ctx: SimContext) {
    ctx.provide('bootstrap', {
      respawn: (count) => this.respawn(count),
      ensureCamp: () => this.ensureCamp(),
    } satisfies BootstrapCap);
  }

  init(bus: EventBus): void {
    // 出生刷人（原 Sim 构造 spawnPawns）：世界中心 3×3
    const cx = Math.floor(this.ctx.world.width / 2);
    const cy = Math.floor(this.ctx.world.height / 2);
    for (let i = 0; i < this.ctx.initialPawnCount; i++) {
      this.ctx.spawnPawn(cx + (i % 3) - 1, cy + Math.floor(i / 3) - 1);
    }
    // 建篝火 → 区域记忆 + 全员归属（原 Sim 构造 bus 回调）。订阅先于出生（审计 L4）：
    // 原注册在 ensureInitialCamp 之后 → 出生篝火的 building_built 事件监听不到；
    // 且出生点曾同时走手动 onCampfireBuilt + 事件监听两条路 = 双触发。统一 = 只经
    // 事件单入口、订阅先到位——出生恰触发一次，后续每栋篝火一次。
    const starter = () => this.ctx.tuning.autobuild.starterBuilding;
    bus.on('building_built', (ev: GameEvent) => {
      if (ev.type === 'building_built' && ev.defId === starter()) {
        this.ctx.socialUnits.onCampfireBuilt(this.ctx.world.buildKey(ev.x, ev.y));
      }
    });
    this.ensureInitialCamp();
  }

  update(): void {}

  // 出生点首个篝火 → 第一个派系单位（Q9：有篝火 = 独立派系）
  private ensureInitialCamp(): void {
    const cx = Math.floor(this.ctx.world.width / 2);
    const cy = Math.floor(this.ctx.world.height / 2);
    const starter = this.ctx.tuning.autobuild.starterBuilding;
    if (this.ctx.world.placeBuilding(cx, cy + 2, starter, 'auto')) {
      // 只发事件（审计 L4）：此前这里手动 onCampfireBuilt + bus 监听 building_built 又调一次
      // = 双触发（assignPawn 全员重算跑两遍；fireMemory 有守卫掩盖）。统一走事件单入口。
      this.ctx.bus.emit({ type: 'building_built', x: cx, y: cy + 2, defId: starter });
    }
    for (const eid of this.ctx.pawnList) this.ctx.socialUnits.assignPawn(eid);
  }

  // 若出生点没有篝火则重建（空世界重开用）
  private ensureCamp(): void {
    const cx = Math.floor(this.ctx.world.width / 2);
    const cy = Math.floor(this.ctx.world.height / 2);
    if (!this.ctx.world.getBuilding(cx, cy + 2)) {
      this.ensureInitialCamp();
    } else {
      for (const eid of this.ctx.pawnList) this.ctx.socialUnits.assignPawn(eid);
    }
  }

  // 空世界（旧档全灭/坏档）重开：重建出生点小人 + 初始营地
  private respawn(count: number): void {
    for (const eid of [...this.ctx.pawnList]) this.ctx.killPawn(eid);
    const cx = Math.floor(this.ctx.world.width / 2);
    const cy = Math.floor(this.ctx.world.height / 2);
    for (let i = 0; i < count; i++) {
      this.ctx.spawnPawn(cx + (i % 3) - 1, cy + Math.floor(i / 3) - 1);
    }
  }
}

export const bootstrapPack: ModPack = {
  id: 'bootstrap',
// 依赖（2026-08-15 显式化）：socialUnit——建篝火归属/需求记忆依赖其能力（NOOP 回落不崩但归属失效）
  requires: ['socialUnit'],
  apply(m: ModRegistry): void {
    m.registerSystemDef({ id: 'bootstrap', label: '引导', category: 'boot', ctor: (s: Sim) => new BootstrapSystem(s) });
  }
};