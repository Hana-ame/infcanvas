// 采集玩法包（2026-08-14 完全插件化：采集系统迁出内核）
// 背景：此前 gather 系统硬编码在内核 SYSTEM_DEFS（AGENTS 曾把"采集"列为内核允许项）。
// 完全插件化裁决后迁出——内核只留需求/决策/社交/建造/敌袭/人口/事件等"社会骨架"，
// 采集(伐木/采矿/采食)作为一种玩法由包提供。默认 playstyle 必挂本包，故默认模拟器行为不变；
// 纯内核(卸掉本包)则无采集产出，仅剩基础循环（符合"卸载不破坏核心"= 不崩，非保生存）。
// 依赖：内核 build（产出经 building.recipe / harvest 结算）；无其它玩法包依赖。
// 装配：before 'build'（原内核表序 gather 在 build 前，迁出后仍锚在 build 前保持原位）。
import type { ModRegistry } from '../../sim/mods/registry';
import { GatherSystem } from '../../sim/systems/gatherSystem';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const gatheringPack: ModPack = {
  id: 'gathering',
// 依赖（2026-08-15 显式化）：无硬前置——采集自足
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({
      id: 'gather', label: '采集', category: 'production',
      ctor: (s: Sim) => new GatherSystem(s),
      before: 'build',
    });
    // 采矿命令处理器（原 Sim.mineAt）：给小人设 mineTarget（GatherSystem 推进采矿）
    // 与内核 caveMine 卡（cardSystem 洞穴矿脉）同写 st.mineTarget——命令后设置覆盖卡目标
    // （玩家指挥优先，审计 2026-08-15 约定登记）；GatherSystem 按 mineTarget 就近推进
    m.registerCommand('mine', (ctx, cmd) => {
      const eids = cmd.pawnId ? [cmd.pawnId] : ctx.selected;
      for (const eid of eids) {
        const st = ctx.pawnStates.get(eid);
        if (!st) continue;
        const tile = ctx.world.getTileDef(cmd.x, cmd.y);
        if (!tile.mineral) continue;
        const pos = ctx.readPosition(eid);
        if (!pos) continue;
        const path = ctx.getPath(Math.round(pos.x), Math.round(pos.y), cmd.x, cmd.y, st.climb);
        st.path = path;
        st.pathIndex = 0;
        st.mineTarget = { x: cmd.x, y: cmd.y };
      }
    });
  }
};