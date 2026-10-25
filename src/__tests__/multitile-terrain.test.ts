/**
 * multitile-terrain.test.ts —— 多格建筑系统（w×h 占地、90° 旋转、全子格命中、周界邻接）与
 *                              RimWorld 地形系统（10 类子地形、移速、肥力门控、高差平整度、掩体）专项测试。
 */
import { describe, expect, it } from 'vitest';
import {
  Sim,
  evaluateMultiTileTerrain,
  executeArchitectOrder,
  inspectFootprintCells,
  placeArchitectBuilding,
  tacticalCoverAt,
  terrainEdgesAt,
  terrainMetaAt,
  terrainStepCost,
} from '../sim';
import { DLC_CATALOG, ModRegistry, toggleSimDlc } from '../mods';

describe('多格建筑逻辑与 RimWorld 地形系统 (multitile-terrain)', () => {
  it('多格占地 (2×2 / 2×1 / 1×2) 与 buildingAt 全子格精确命中（含可通行农田与阻挡建筑）', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    sim.stockpile['wood'] = 200;
    sim.stockpile['ore'] = 100;

    // 1. 放置 2×2 殖民者木屋（阻挡型多格建筑）
    const hutRes = placeArchitectBuilding(sim, 'hut', 2, 2, 0);
    expect(hutRes.ok).toBe(true);
    const hut = hutRes.building!;
    expect(sim.world.footprintOf(hut)).toEqual({ w: 2, h: 2 });
    expect(sim.world.buildingCells(hut)).toHaveLength(4);

    // 2×2 的全部 4 个子格都必须被 buildingAt 精确命中，且全部阻挡通行
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        expect(sim.world.buildingAt(hut.pos.x + dx, hut.pos.y + dy)?.id).toBe(hut.id);
        expect(sim.world.passable(hut.pos.x + dx, hut.pos.y + dy)).toBe(false);
      }
    }

    // 2. 放置 2×2 肥沃农田（可通行多格建筑）
    const fieldRes = placeArchitectBuilding(sim, 'field', -4, 2, 0);
    expect(fieldRes.ok).toBe(true);
    const field = fieldRes.building!;
    expect(sim.world.footprintOf(field)).toEqual({ w: 2, h: 2 });
    // 可通行 2×2 农田的全部 4 个子格同样必须被 buildingAt 命中（解决此前只命中左上角 1 格的缺陷）
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        expect(sim.world.buildingAt(field.pos.x + dx, field.pos.y + dy)?.id).toBe(field.id);
        expect(sim.world.passable(field.pos.x + dx, field.pos.y + dy)).toBe(true);
      }
    }

    // 点击 2×2 农田的右下角子格 (pos.x+1, pos.y+1) 执行拆除，应能准确拆除整座农田
    const deconRes = executeArchitectOrder(sim, 'deconstruct', field.pos.x + 1, field.pos.y + 1);
    expect(deconRes.ok).toBe(true);
    expect(sim.world.buildingAt(field.pos.x, field.pos.y)).toBeUndefined();
  });

  it('非对称多格建筑 (2×1 燃木炉灶 / 1×2 医疗病榻) 支持 90° 旋转朝向 (rot=0..3) 与完整清理', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    sim.stockpile['wood'] = 200;
    sim.stockpile['ore'] = 100;

    // 默认 rot=0 时 stove 为 2×1
    expect(sim.world.footprint('stove', 0)).toEqual({ w: 2, h: 1 });
    // 旋转 90° (rot=1) 时 stove 变为 1×2 竖向占地
    expect(sim.world.footprint('stove', 1)).toEqual({ w: 1, h: 2 });

    const stoveRes = placeArchitectBuilding(sim, 'stove', -3, -3, 1);
    expect(stoveRes.ok).toBe(true);
    const stove = stoveRes.building!;
    expect(stove.rot).toBe(1);
    expect(sim.world.footprintOf(stove)).toEqual({ w: 1, h: 2 });

    // 验证竖向 1×2 子格命中：(x, y) 与 (x, y+1) 命中，而 (x+1, y) 不命中
    expect(sim.world.buildingAt(stove.pos.x, stove.pos.y)?.id).toBe(stove.id);
    expect(sim.world.buildingAt(stove.pos.x, stove.pos.y + 1)?.id).toBe(stove.id);
    expect(sim.world.buildingAt(stove.pos.x + 1, stove.pos.y)).toBeUndefined();

    // 多格周界邻接点查询
    const adj = sim.world.nearestBuildingAdjacent(stove, stove.pos.x + 3, stove.pos.y);
    expect(adj).not.toBeNull();
    expect(sim.world.distToBuilding(adj!.x, adj!.y, stove)).toBeLessThanOrEqual(1.5);

    // 移除旋转后的多格建筑后，全部占用格恢复可通行
    sim.removeBuilding(stove.id);
    expect(sim.world.passable(stove.pos.x, stove.pos.y)).toBe(true);
    expect(sim.world.passable(stove.pos.x, stove.pos.y + 1)).toBe(true);
  });

  it('inspectFootprintCells 逐格蓝图校验：部分子格重叠时精准标记冲突格', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    sim.stockpile['wood'] = 200;
    sim.stockpile['ore'] = 100;

    // 先在 (3, 3) 放置一堵 1×1 围墙
    const wallRes = placeArchitectBuilding(sim, 'wall', 3, 3, 0);
    expect(wallRes.ok).toBe(true);

    // 在 (2, 2) 预览一座 2×2 木屋（覆盖 (2,2), (3,2), (2,3), (3,3)，其中 (3,3) 被围墙占用）
    const check = inspectFootprintCells(sim, 'hut', 2, 2, 0);
    expect(check.valid).toBe(false);
    expect(check.cells).toHaveLength(4);
    const cell33 = check.cells.find((c) => c.x === 3 && c.y === 3);
    expect(cell33?.valid).toBe(false);
    expect(cell33?.reason).toContain('占用');
  });

  it('RimWorld 地形系统：10 类子地形推导、移速代价、肥力门控与战术掩体率计算', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    sim.stockpile['wood'] = 100;

    // 出生安全区内必为可通行壤土或泥地
    const originMeta = terrainMetaAt(sim.world, 0, 0);
    expect(originMeta.passable).toBe(true);
    expect(originMeta.moveSpeedMul).toBeGreaterThan(0.8);
    expect(originMeta.fertility).toBeGreaterThanOrEqual(0.5);

    // 扫描地图验证存在多种 RimWorld 地形子类型（肥沃黑土/普通壤土/岩石/水域等）
    const foundTypes = new Set<string>();
    let rockCoord: { x: number; y: number } | null = null;
    for (let y = -35; y <= 35; y += 2) {
      for (let x = -35; x <= 35; x += 2) {
        const m = terrainMetaAt(sim.world, x, y);
        foundTypes.add(m.id);
        if (m.baseTile === 'stone' && !rockCoord) rockCoord = { x, y };
      }
    }
    expect(foundTypes.size).toBeGreaterThanOrEqual(4);

    // 验证岩石地基肥力为 0%，无法直接开辟 2×2 农田
    if (rockCoord) {
      const rockCheck = evaluateMultiTileTerrain(sim.world, rockCoord.x, rockCoord.y, 2, 2, {
        minFertility: 0.5,
      });
      expect(rockCheck.ok).toBe(false);
      expect(rockCheck.reason).toContain('肥力不足');
    }

    // 验证战术掩体：建墙后邻格掩体率提升至 75%
    const coverBefore = tacticalCoverAt(sim.world, 4, -2);
    placeArchitectBuilding(sim, 'wall', 4, -2, 0);
    const coverAfter = tacticalCoverAt(sim.world, 3, -2);
    expect(coverAfter).toBeGreaterThanOrEqual(0.75);
    expect(coverAfter).toBeGreaterThan(coverBefore);

    // 验证地形移动代价与水岸/断崖边缘计算
    const stepCost = terrainStepCost(sim.world, 0, 0, 1, 0);
    expect(stepCost).toBeGreaterThan(0.5);
    expect(stepCost).toBeLessThan(3);
    const edges = terrainEdgesAt(sim.world, 0, 0);
    expect(typeof edges.shoreN).toBe('boolean');
  });

  it('AI 驱动功能已归入独立 DLC (dlc-ai-director) 且标记为推后实现 (Deferred)', () => {
    const aiDlc = DLC_CATALOG.find((d) => d.id === 'dlc-ai-director');
    expect(aiDlc).toBeDefined();
    expect(aiDlc?.deferred).toBe(true);
    expect(aiDlc?.statusTag).toContain('推后实现');

    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    expect(sim.hasDlc('dlc-ai-director')).toBe(false);
    const res = toggleSimDlc(sim, 'dlc-ai-director', true);
    expect(res.ok).toBe(true);
    expect(res.message).toContain('推后实现');
  });
});
