// DLC 插拔测试（2026-08-20）：确保所有 DLC 包可在游戏开始前排除/挂载
import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods/registry';

const DLC_IDS = [
  'seasons', 'astronomy', 'sailing', 'disease', 'breeding',
  'lineage', 'genetics', 'flying', 'buildings-extra', 'biomes',
  'field-command', 'beast-taming', 'drafting',
];

describe('DLC 插拔（2026-08-20）', () => {
  // 每个 DLC 单独排除
  for (const id of DLC_IDS) {
    it(`排除 ${id}：不在 packIds + 步进不崩`, () => {
      const mods = ModRegistry.default([id]);
      expect(mods.packIds).not.toContain(id);
      const sim = new Sim({ seed: 1, pawnCount: 2, registry: mods });
      expect(() => { for (let i = 0; i < 10; i++) sim.step(1); }).not.toThrow();
    });
  }

  it('排除多个 DLC（seasons + flying + biomes）同时', () => {
    const mods = ModRegistry.default(['seasons', 'flying', 'biomes']);
    expect(mods.packIds).not.toContain('seasons');
    expect(mods.packIds).not.toContain('flying');
    expect(mods.packIds).not.toContain('biomes');
    const sim = new Sim({ seed: 1, pawnCount: 2, registry: mods });
    expect(() => { for (let i = 0; i < 10; i++) sim.step(1); }).not.toThrow();
  });

  it('排除 drafting 级联排除 field-command（依赖断裂自动跳过）', () => {
    const mods = ModRegistry.default(['drafting']);
    expect(mods.packIds).not.toContain('drafting');
    expect(mods.packIds).not.toContain('field-command'); // 级联排除
    const sim = new Sim({ seed: 1, pawnCount: 2, registry: mods });
    expect(() => { for (let i = 0; i < 10; i++) sim.step(1); }).not.toThrow();
  });

  it('不排除任何 DLC（默认全挂）', () => {
    const mods = ModRegistry.default();
    for (const id of DLC_IDS) {
      expect(mods.packIds).toContain(id);
    }
  });

  it('排除所有 DLC → 仅核心系统（needs/economy/social/...）', () => {
    const mods = ModRegistry.default(DLC_IDS);
    const sim = new Sim({ seed: 1, pawnCount: 2, registry: mods });
    expect(sim.systemIds).toContain('behavior');
    expect(sim.systemIds).toContain('needs');
    expect(() => { for (let i = 0; i < 10; i++) sim.step(1); }).not.toThrow();
  });

  it('排除后单独挂回（先排除 biomes 再 mount）', () => {
    const mods = ModRegistry.default(['biomes']);
    expect(mods.packIds).not.toContain('biomes');
    // mount 回来
    mods.mount({
      id: 'biomes', requires: [],
      apply(m) {
        m.registerTile({ id: 'biome-desert', name: '沙漠', passable: true, buildable: true, color: '#d4a84a' });
      },
    });
    expect(mods.packIds).toContain('biomes');
  });
});