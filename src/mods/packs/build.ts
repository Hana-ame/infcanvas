// 建造玩法包（2026-08-14 完全插件化：build 迁出内核）
// 背景：原内核 SYSTEM_DEFS 的"建造"（buildQueue 消费/建成结算）。完全插件化裁决迁出——
//   建造是一种玩法/生产方式，非引擎骨架。它是产出系锚点（gathering 等玩法包曾锚
//   before 'build'），现按清单占位保序；Sim 的 issueCommand/queueBuild（命令侧）仍在
//   引擎层（命令分发是引擎职责，见 Stage D 说明），本包只提供"每帧消费 buildQueue"的
//   系统本体。
// 装配：id 已在 SYSTEM_DEFS 表登记（类别推导执行序），无需 before 锚点。
import type { ModRegistry } from '../../sim/mods/registry';
import { BuildSystem } from '../../sim/systems/buildSystem';
import type { Sim } from '../../sim/sim';
import type { ModPack } from '../pack';

export const buildPack: ModPack = {
  id: 'build',
// 依赖（2026-08-15 显式化）：无硬前置——蓝图/命令处理自足
  requires: [],
  apply(m: ModRegistry): void {
    m.registerSystemDef({ id: 'build', label: '建造', category: 'production', ctor: (s: Sim) => new BuildSystem(s) });
    // 建造命令处理器（原 Sim.queueBuild）：拒建反馈（先验地形/资源/科技，失败即 logEvent）
    m.registerCommand('build', (ctx, cmd) => {
      const defId = cmd.buildingId ?? ctx.tuning.autobuild.fallbackBuilding;
      const def = ctx.buildingDef(defId);
      if (!def) { ctx.logEvent(`📛 建造被拒：建筑 ${defId} 不存在`); return; }
      // 科技锁：未抽到对应科技卡的建筑不可建造（科技 = 独立抽卡池按 TECH_ORDER 解锁）
      if (def.tech && !ctx.techs.has(def.tech)) { ctx.logEvent(`📛 建造被拒：需要科技「${def.tech}」`); return; }
      if (!ctx.world.canBuildFootprint(cmd.x, cmd.y, def)) { ctx.logEvent(`📛 建造被拒：${cmd.x},${cmd.y} 附近被占用`); return; }
      const cost = {
        wood: def.costWood ?? def.size.x * def.size.y * ctx.tuning.autobuild.costWoodPerCell,
        ore: def.costOre ?? ctx.tuning.autobuild.costOreFallback,
      };
      if (ctx.stockpile.wood < cost.wood) { ctx.logEvent(`📛 建造被拒：木材不足（需 ${cost.wood}，现有 ${Math.floor(ctx.stockpile.wood)}）`); return; }
      if (cost.ore > 0 && ctx.stockpile.ore < cost.ore) { ctx.logEvent(`📛 建造被拒：矿石不足（需 ${cost.ore}，现有 ${Math.floor(ctx.stockpile.ore)}）`); return; }
      ctx.buildQueue.push({ x: cmd.x, y: cmd.y, defId, progress: 0, faction: 'player', cost });
    });
  }
};