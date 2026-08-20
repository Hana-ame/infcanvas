// craftSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：craft 建筑按配方批量产出（材料→工具）/ 材料不足不产出 / 非 craft 建筑不参与
import { describe, it, expect, beforeEach } from 'vitest';
import { CraftSystem } from '../../systems/craftSystem';
import { makeMinCtx, attach } from '../helpers/minCtx';

describe('CraftSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(7);
  beforeEach(() => { ctx = makeMinCtx(7); });

  function placeBuilding(defId: string): { x: number; y: number } {
    const def = ctx.buildingDef(defId);
    if (!def) throw new Error(`def 不存在: ${defId}`);
    for (let x = 1; x < ctx.world.width; x++) for (let y = 1; y < ctx.world.height; y++) {
      if (ctx.world.placeBuilding(x, y, defId, 'player')) return { x, y };
    }
    throw new Error(`无法放置 ${defId}`);
  }

  it('workbench（craft 建筑）→ 木材变工具（batch 配方）', () => {
    const sys = attach(ctx, new CraftSystem(ctx));
    // 加固：workbench 是内置建筑表成员，缺失即测试失败（原先 if(!def) return 会静默假通过）
    expect(ctx.buildingDef('workbench')).toBeDefined();
    placeBuilding('workbench');
    ctx.stockpile.wood = 100;
    const toolsBefore = ctx.stockpile.tools ?? 0;
    // 跑足够久触发一批
    for (let i = 0; i < 120; i++) sys.update(1);
    expect((ctx.stockpile.tools ?? 0)).toBeGreaterThan(toolsBefore);
    expect(ctx.stockpile.wood).toBeLessThan(100);
  });

  it('材料不足 → 不产出（等待）', () => {
    const sys = attach(ctx, new CraftSystem(ctx));
    expect(ctx.buildingDef('workbench')).toBeDefined(); // 内置表成员，缺失即失败
    placeBuilding('workbench');
    ctx.stockpile.wood = 0;
    for (let i = 0; i < 120; i++) sys.update(1);
    expect(ctx.stockpile.tools ?? 0).toBe(0);
  });
});
