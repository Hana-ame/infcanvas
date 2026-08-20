// 水利设施玩法包（2026-08-20，用户「添加水利设施包」）：
// 水渠/水车/堤坝/蓄水池/灌溉渠道 → 影响农田产出/防洪/水力发电
// 设计：纯数据驱动——注册 5 个新建筑 + 1 个 passive 配方（水车产动力）+
// 水车 = power tag（电力系统自动接入）+ 灌溉 = farm tag（农田在灌溉范围内产出倍率）
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';

const CFG = {
  aqueductWaterPerSec: 0.3,    // 水渠 passive 产水速率
  waterwheelPowerPerSec: 0.5,  // 水车 passive 产动力（power 系统接入）
  reservoirCap: 200,           // 蓄水池水容量（防灾时消耗）
  damFloodReduction: 0.8,      // 堤坝降低洪水概率 80%（天文/季节联动）
  irrigationBonus: 1.3,        // 灌溉渠道范围内农田产出 ×1.3
};

export const WATER_CONFIG = CFG;

export const waterworksPack: ModPack = {
  id: 'waterworks',
  requires: ['build'],
  apply(m: ModRegistry): void {
    // 水渠：passive 产水（farm 系统结算）
    m.registerBuilding({
      id: 'aqueduct', name: '水渠', size: { x: 2, y: 1 }, hp: 150, color: '#4a6a8a',
      emoji: '💧', passable: true, buildTime: 4,
      tags: ['water'], meta: {}, recipe: 'aqueductRecipe',
      costWood: 12,
    });

    // 水车：passive 产动力（power 系统结算，meta.power 供电）
    m.registerBuilding({
      id: 'waterwheel', name: '水车', size: { x: 1, y: 1 }, hp: 120, color: '#8a7a5a',
      emoji: '🎡', passable: false, buildTime: 6,
      tags: ['water', 'power'], meta: { power: CFG.waterwheelPowerPerSec },
      costWood: 20,
    });

    // 堤坝：防洪屏障（不可走，高 HP，降低洪水风险）
    m.registerBuilding({
      id: 'dam', name: '堤坝', size: { x: 1, y: 1 }, hp: 800, color: '#6a6a7a',
      emoji: '🌊', passable: false, buildTime: 8,
      tags: ['barrier', 'water'], meta: { floodReduction: CFG.damFloodReduction },
      costWood: 30,
    });

    // 蓄水池：储水防灾（雨季蓄水，旱季释放，meta.water = 容量）
    m.registerBuilding({
      id: 'reservoir', name: '蓄水池', size: { x: 2, y: 2 }, hp: 200, color: '#3a5a7a',
      emoji: '🏞', passable: false, buildTime: 5,
      tags: ['water', 'storage'], meta: { water: CFG.reservoirCap },
      costWood: 15,
    });

    // 灌溉渠道：范围内农田产出 ×1.3（meta.irrigation = 倍率 + 半径）
    m.registerBuilding({
      id: 'irrigation', name: '灌溉渠道', size: { x: 1, y: 3 }, hp: 100, color: '#5a8a5a',
      emoji: '🌾', passable: true, buildTime: 3,
      tags: ['water', 'irrigation'], meta: { irrigation: { bonus: CFG.irrigationBonus, radius: 4 } },
      costWood: 8,
    });

    // 水渠 passive 配方（产水）
    m.registerRecipe({
      id: 'aqueductRecipe', name: '水渠产水', kind: 'passive',
      output: { item: 'water', amount: CFG.aqueductWaterPerSec },
    });

    // 水车 passive 配方（产动力 = tools）
    m.registerRecipe({
      id: 'waterwheelRecipe', name: '水车动力', kind: 'passive',
      output: { item: 'tools', amount: 0.02 },
    });

    // 水车建筑也关联 recipe（farm 系统结算）
    // 注册时把 recipe 写到 building def 上
    const ww = m.buildings['waterwheel'];
    if (ww) ww.recipe = 'waterwheelRecipe';
  },
};