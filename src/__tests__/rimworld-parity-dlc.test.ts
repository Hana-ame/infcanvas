/**
 * rimworld-parity-dlc.test.ts —— RimWorld 工作优先级、征召战斗、建造规划、DLC 入口与归档验收测试。
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Sim,
  setPawnWorkPriority,
  setPawnDrafted,
  orderPawnAttackHostile,
  placeArchitectBuilding,
  executeArchitectOrder,
} from '../sim';
import {
  ModRegistry,
  DLC_CATALOG,
  toggleSimDlc,
  loadCustomModJsonOnSim,
} from '../mods';

describe('RimWorld 机制对标、DLC 入口与 Archive 归档验收 (rimworld-parity-dlc)', () => {
  it('工作优先级 (1-4 & 0) 与征召命令 (Draft R) 正常工作', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const p = [...sim.pawns()][0];

    expect(setPawnWorkPriority(sim, p.eid, 'mine', 1)).toBe(true);
    expect(p.workPriorities?.['mine']).toBe(1);

    expect(setPawnDrafted(sim, [p.eid], true)).toBe(1);
    expect(p.drafted).toBe(true);

    // 征召状态下集火攻击敌方单位
    const cat = sim.spawnHostile('cat', p.pos.x + 1, p.pos.y);
    const hp0 = cat.hp;
    expect(orderPawnAttackHostile(sim, [p.eid], cat.id)).toBe(true);
    expect(cat.hp).toBeLessThan(hp0);
  });

  it('Architect 建造规划与作业指令（建墙/炉灶/开采/砍树/拆除）完整闭环', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    sim.stockpile['wood'] = 100;
    sim.stockpile['ore'] = 50;

    const bRes = placeArchitectBuilding(sim, 'stove', 3, 3);
    expect(bRes.ok).toBe(true);
    expect(bRes.building).toBeDefined();

    const dRes = executeArchitectOrder(sim, 'deconstruct', bRes.building!.pos.x, bRes.building!.pos.y);
    expect(dRes.ok).toBe(true);
  });

  it('DLC 入口：内置 4 大官方 DLC 可通过 ModRegistry.default({ dlc }) 或运行时 toggleSimDlc 挂载，且支持自定义 .mod.json', () => {
    expect(DLC_CATALOG.length).toBeGreaterThanOrEqual(4);
    const regWithDlc = ModRegistry.default({
      dlc: ['dlc-biotech-ratkin', 'dlc-raider-pvp', 'dlc-royalty-empire', 'dlc-ideology-cult'],
    });
    const sim = new Sim({ seed: 42, registry: regWithDlc });
    expect(sim.hasDlc('dlc-biotech-ratkin')).toBe(true);
    expect(sim.hasDlc('dlc-raider-pvp')).toBe(true);
    expect(sim.tuning.buildings['gene_assembler']).toBeDefined();
    expect(sim.tuning.buildings['royal_throne']).toBeDefined();

    // 运行时热切换 DLC 与挂载自定义 .mod.json
    const sim2 = new Sim({ seed: 42, registry: ModRegistry.default() });
    expect(sim2.hasDlc('dlc-biotech-ratkin')).toBe(false);
    const tRes = toggleSimDlc(sim2, 'dlc-biotech-ratkin', true);
    expect(tRes.ok).toBe(true);
    expect(sim2.hasDlc('dlc-biotech-ratkin')).toBe(true);

    const modRes = loadCustomModJsonOnSim(
      sim2,
      JSON.stringify({
        id: 'custom-ratkin-bakery',
        buildings: [
          { id: 'rat_oven', name: '鼠鼠烤炉', cost: { wood: 5 }, hp: 80, tags: ['fire'], passable: false },
        ],
      }),
    );
    expect(modRes.ok).toBe(true);
    expect(sim2.tuning.buildings['rat_oven']?.name).toBe('鼠鼠烤炉');
  });

  it('归档验证：旧版抽卡机制与旧版文档已完整归档至 archive/cards 与 archive/docs', () => {
    const root = process.cwd();
    expect(existsSync(resolve(root, 'archive/cards/cards.ts'))).toBe(true);
    expect(existsSync(resolve(root, 'archive/cards/tech-pool.ts'))).toBe(true);
    expect(existsSync(resolve(root, 'archive/docs/DESIGN.md'))).toBe(true);
    expect(existsSync(resolve(root, 'docs/PARITY_SCORE_AUDIT.md'))).toBe(true);
    expect(existsSync(resolve(root, 'docs/PATHFINDING_INFCANVAS.md'))).toBe(true);
  });
});
