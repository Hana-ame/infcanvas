// 生物群系包（2026-08-20，用户「添加生物群系包」）：沙漠/雪原/沼泽/火山
// 设计：注册 4 个新 tile def + 各群系特有资源 tile + 群系特有敌人。
// 世界生成的 tileAt() 函数按 seed + 坐标确定地形——本包不改生成算法，
// 只注册 tile def 让世界已有的地形 ID 有数据定义。mod 可 override noise 参数
// 改变群系分布。
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';

export const biomesPack: ModPack = {
  id: 'biomes',
  requires: [],
  apply(m: ModRegistry): void {
    // ---- 沙漠群系 ----
    m.registerTile({
      id: 'biome-desert', name: '沙漠', passable: true, buildable: true,
      color: '#d4a84a', moveCost: 1.5, z: 0,
    });
    m.registerTile({
      id: 'biome-cactus', name: '仙人掌', passable: false, buildable: false,
      color: '#3a7a3a', growable: true, sprite: 'terrain:tree',
      harvest: { product: 'food', time: 2, yieldSuccess: 1, yieldFail: 0, dc: 30 },
      harvestReplaces: 'biome-desert',
    });

    // ---- 雪原群系 ----
    m.registerTile({
      id: 'biome-snow', name: '雪地', passable: true, buildable: true,
      color: '#e8e8f0', moveCost: 1.3, z: 0,
    });
    m.registerTile({
      id: 'biome-ice', name: '冰面', passable: true, buildable: false,
      color: '#a8c8e8', moveCost: 2, z: 0,
    });

    // ---- 沼泽群系 ----
    m.registerTile({
      id: 'biome-swamp', name: '沼泽', passable: true, buildable: false,
      color: '#5a6a3a', moveCost: 2, z: 0,
    });
    m.registerTile({
      id: 'biome-mushroom', name: '蘑菇丛', passable: true, buildable: true,
      color: '#8a4a6a', growable: true, sprite: 'terrain:tree',
      harvest: { product: 'food', time: 1.5, yieldSuccess: 2, yieldFail: 0, dc: 35 },
      harvestReplaces: 'biome-swamp',
    });

    // ---- 火山群系 ----
    m.registerTile({
      id: 'biome-volcanic', name: '火山岩', passable: true, buildable: false,
      color: '#3a2a2a', moveCost: 1.8, z: 1,
    });
    m.registerTile({
      id: 'biome-lava', name: '熔岩', passable: false, buildable: false,
      color: '#ff4a2a', z: 0,
    });

    // 群系特有敌人
    m.registerEnemy({
      id: 'biome-scorpion', name: '沙漠蝎', hp: 50, speed: 4, climb: 2, dmg: 4,
      loot: { item: 'food', amount: 2 },
    });
    m.registerEnemy({
      id: 'biome-yeti', name: '雪怪', hp: 150, speed: 3, climb: 3, dmg: 8,
      predator: true, loot: { item: 'food', amount: 6 },
    });
    m.registerEnemy({
      id: 'biome-swamp-beast', name: '沼泽兽', hp: 80, speed: 3, climb: 1, dmg: 5,
      loot: { item: 'ore', amount: 3 },
    });
  },
};