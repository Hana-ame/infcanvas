// P3-10: 更多生物群系（2026-08-20）：丛林/草原/苔原
// 种子原则：只注册 tile + 专属可采集物 + 专属敌人 → 世界生成自然分布
// 丛林 = 密林（moveCost 高 + 藤蔓采集）/ 草原 = 开阔（moveCost 低 + 浆果）/ 苔原 = 冻土（z=0 + 地衣）
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';

export const biomes2Pack: ModPack = {
  id: 'biomes-2',
  requires: [],
  apply(m: ModRegistry): void {
    // ---- 丛林群系 ----
    m.registerTile({ id: 'biome-jungle', name: '丛林', passable: true, buildable: false, color: '#2a6a2a', moveCost: 1.8, z: 0 });
    m.registerTile({ id: 'biome-vine', name: '藤蔓', passable: false, buildable: false, color: '#3a8a3a', growable: true, sprite: 'terrain:tree',
      harvest: { product: 'food', time: 2, yieldSuccess: 3, yieldFail: 1, dc: 40 }, harvestReplaces: 'biome-jungle' });
    m.registerTile({ id: 'biome-mahogany', name: '红木', passable: false, buildable: false, color: '#5a3a1a', growable: true, sprite: 'terrain:tree',
      harvest: { product: 'wood', time: 3, yieldSuccess: 5, yieldFail: 2, dc: 55 }, harvestReplaces: 'biome-jungle' });

    // ---- 草原群系 ----
    m.registerTile({ id: 'biome-prairie', name: '草原', passable: true, buildable: true, color: '#a8c87a', moveCost: 0.8, z: 0 });
    m.registerTile({ id: 'biome-berry', name: '野浆果', passable: true, buildable: false, color: '#8a4a3a', growable: true, sprite: 'terrain:tree',
      harvest: { product: 'food', time: 1, yieldSuccess: 4, yieldFail: 1, dc: 30 }, harvestReplaces: 'biome-prairie' });

    // ---- 苔原群系 ----
    m.registerTile({ id: 'biome-tundra', name: '苔原', passable: true, buildable: true, color: '#c8c8b8', moveCost: 1.3, z: 0 });
    m.registerTile({ id: 'biome-lichen', name: '地衣', passable: true, buildable: false, color: '#8a9a6a', growable: true,
      harvest: { product: 'food', time: 3, yieldSuccess: 1, yieldFail: 1, dc: 50 }, harvestReplaces: 'biome-tundra' });
    m.registerTile({ id: 'biome-permafrost', name: '永冻土', passable: true, buildable: false, color: '#a8b8c8', moveCost: 2, z: 0 });

    // ---- 专属敌人 ----
    m.registerEnemy({ id: 'jungle-panther', name: '黑豹', hp: 90, speed: 7, climb: 3, dmg: 6, predator: true, loot: { item: 'food', amount: 4 } });
    m.registerEnemy({ id: 'prairie-wolf', name: '草原狼', hp: 45, speed: 5, climb: 2, dmg: 4, loot: { item: 'food', amount: 2 } });
    m.registerEnemy({ id: 'tundra-mammoth', name: '猛犸', hp: 200, speed: 2, climb: 1, dmg: 10, loot: { item: 'food', amount: 10 } });
  },
};