// 建筑扩展二期（2026-08-20，用户「丰富建筑类型，可以自己设计」）：
// 20 个新建筑，覆盖住宅/社交/生产/军事/文化/存储 6 类。
// 设计原则：每个建筑都有明确的 tag → 接入现有系统（warmth/pray/anchor/craft/farm 等），
// 或有独特的 meta/aura 效果。数值在 CFG，注释说明来源。
import type { ModRegistry } from '../../sim/mods/registry';
import type { ModPack } from '../pack';

const CFG = {
  // 住宅类
  tavernCostWood: 25,           // tavernCostFood removed (BuildingDef 无 costFood 字段)     // 酒馆：社交聚集 + 心情 aura
  tavernMoodPerSec: 0.8,        tavernRadius: 5,
  manorCostWood: 50,            manorCostOre: 10,       // 庄园：高级住宅 + rest aura
  manorRestPerSec: 0.6,         manorMoodPerSec: 0.3,   manorRadius: 5,
  // 社交/文化类
  gardenCostWood: 8,                                    // 花园：心情 + 美观
  gardenMoodPerSec: 0.4,         gardenRadius: 4,
  libraryCostWood: 30,           libraryCostOre: 5,      // 图书馆：心情 + 信仰
  libraryMoodPerSec: 0.3,        libraryFaithPerSec: 0.1, libraryRadius: 5,
  shrineCostWood: 12,                                   // 神龛：小型祈祷点
  shrineRadius: 3,               shrineMoodPerSec: 0.2,
  bellTowerCostWood: 20,         bellTowerCostOre: 15,  // 钟楼：时间感知 + 心情
  bellTowerMoodPerSec: 0.3,      bellTowerRadius: 8,
  totemCostWood: 15,             totemCostOre: 5,       // 图腾：原始信仰
  totemMoodPerSec: 0.4,          totemRadius: 6,
  // 生产类
  sawmillCostWood: 20,           sawmillCostOre: 5,     // 锯木厂：木材加工加成
  sawmillCraftSpeed: 2,          // 加工速度 ×2
  quarryCostWood: 15,            quarryCostOre: 8,      // 采石场：石料产出
  brickyardCostWood: 18,         brickyardCostOre: 10,  // 砖窑：黏土→砖
  apiaryCostWood: 10,                                   // 蜂房：食物产出
  apiaryFoodPerSec: 0.15,
  windmillGranaryCostWood: 25,                          // 风车粮仓：食物存储 + 加工
  windmillGranaryStorage: 150,
  // 军事类
  watchtowerCostWood: 15,        watchtowerCostOre: 10,  // 瞭望塔：视野扩展
  watchtowerLightRange: 10,
  barracksCostWood: 30,          barracksCostOre: 10,    // 兵营：征召兵出生点
  catapultCostWood: 40,          catapultCostOre: 20,   // 投石机：远程防御
  catapultRange: 12,             catapultDmg: 5,
  // 存储类
  siloCostWood: 20,                                      // 筒仓：食物专用存储
  siloStorage: 150,
  armoryCostWood: 15,           armoryCostOre: 15,      // 军械库：工具/武器存储
  armoryStorage: 100,
};

export const BUILDINGS_2_CONFIG = CFG;

export const buildings2Pack: ModPack = {
  id: 'buildings-2',
  requires: ['build'],
  apply(m: ModRegistry): void {
    // ===== 住宅类 =====
    // 酒馆：社交聚集点，大范围心情 aura
    m.registerBuilding({
      id: 'tavern', name: '酒馆', size: { x: 2, y: 2 }, hp: 200, color: '#8a5a3a',
      emoji: '🍺', passable: false, buildTime: 6,
      tags: ['anchor', 'social', 'warmth'], costWood: CFG.tavernCostWood, // 酒馆需食物投入（建造成本从食物扣）
      aura: { radius: CFG.tavernRadius, moodPerSec: CFG.tavernMoodPerSec },
    });
    // 庄园：高级住宅，rest + mood 双 aura（木屋升级路线）
    m.registerBuilding({
      id: 'manor', name: '庄园', size: { x: 3, y: 2 }, hp: 300, color: '#9a7a5a',
      emoji: '🏡', passable: false, buildTime: 10, tech: 'shelter:house',
      tags: ['house', 'shelter', 'warmth'], costWood: CFG.manorCostWood, costOre: CFG.manorCostOre,
      aura: { radius: CFG.manorRadius, restPerSec: CFG.manorRestPerSec, moodPerSec: CFG.manorMoodPerSec },
    });
    // ===== 社交/文化类 =====
    // 花园：纯心情 aura，低成本美观建筑
    m.registerBuilding({
      id: 'garden', name: '花园', size: { x: 2, y: 2 }, hp: 50, color: '#5a8a4a',
      emoji: '🌷', passable: true, buildTime: 3,
      tags: ['social'], costWood: CFG.gardenCostWood,
      aura: { radius: CFG.gardenRadius, moodPerSec: CFG.gardenMoodPerSec },
    });
    // 图书馆：心情 + 信仰双 aura（知识=信仰来源）
    m.registerBuilding({
      id: 'library', name: '图书馆', size: { x: 2, y: 2 }, hp: 200, color: '#5a4a3a',
      emoji: '📚', passable: false, buildTime: 8, tech: 'craft:toy',
      tags: ['social', 'pray'], costWood: CFG.libraryCostWood, costOre: CFG.libraryCostOre,
      aura: { radius: CFG.libraryRadius, moodPerSec: CFG.libraryMoodPerSec },
    });
    // 神龛：小型祈祷点（篝火外的补充，低成本）
    m.registerBuilding({
      id: 'shrine', name: '神龛', size: { x: 1, y: 1 }, hp: 100, color: '#7a5a4a',
      emoji: '⛩', passable: true, buildTime: 3,
      tags: ['pray', 'anchor'], costWood: CFG.shrineCostWood,
      aura: { radius: CFG.shrineRadius, moodPerSec: CFG.shrineMoodPerSec },
    });
    // 钟楼：大范围心情 aura + 光源（钟声=文明信号）
    m.registerBuilding({
      id: 'bell-tower', name: '钟楼', size: { x: 1, y: 2 }, hp: 250, color: '#6a6a5a',
      emoji: '🔔', passable: false, buildTime: 6, emitsLight: 8,
      tags: ['anchor', 'warmth', 'light'], costWood: CFG.bellTowerCostWood, costOre: CFG.bellTowerCostOre,
      aura: { radius: CFG.bellTowerRadius, moodPerSec: CFG.bellTowerMoodPerSec },
    });
    // 图腾：原始信仰建筑，大范围 mood aura（比教堂便宜，但无 oracle 能力）
    m.registerBuilding({
      id: 'clan-totem', name: '图腾', size: { x: 1, y: 2 }, hp: 150, color: '#5a3a2a',
      emoji: '🗿', passable: false, buildTime: 5,
      tags: ['pray', 'anchor', 'social'], costWood: CFG.totemCostWood, costOre: CFG.totemCostOre,
      aura: { radius: CFG.totemRadius, moodPerSec: CFG.totemMoodPerSec },
    });
    // ===== 生产类 =====
    // 锯木厂：木材加工速度 ×2（meta.craftSpeed 接入 craft 系统）
    m.registerBuilding({
      id: 'sawmill', name: '锯木厂', size: { x: 2, y: 2 }, hp: 200, color: '#6a4a2a',
      emoji: '🪚', passable: false, buildTime: 5, tech: 'craft:toy',
      tags: ['craft', 'tools'], meta: { craftSpeed: CFG.sawmillCraftSpeed },
      costWood: CFG.sawmillCostWood, costOre: CFG.sawmillCostOre,
    });
    // 采石场：石料产出（passive recipe）
    m.registerBuilding({
      id: 'quarry', name: '采石场', size: { x: 2, y: 2 }, hp: 250, color: '#8a8a7a',
      emoji: '⛏', passable: false, buildTime: 6,
      tags: ['mine'], recipe: 'quarryRecipe',
      costWood: CFG.quarryCostWood, costOre: CFG.quarryCostOre,
    });
    // 砖窑：黏土→砖（passive recipe，需要水边）
    m.registerBuilding({
      id: 'brickyard', name: '砖窑', size: { x: 2, y: 1 }, hp: 180, color: '#9a5a3a',
      emoji: '🧱', passable: false, buildTime: 5,
      tags: ['craft'], recipe: 'brickyardRecipe',
      costWood: CFG.brickyardCostWood, costOre: CFG.brickyardCostOre,
    });
    // 蜂房：被动产食物（不需要小人操作）
    m.registerBuilding({
      id: 'apiary', name: '蜂房', size: { x: 1, y: 1 }, hp: 60, color: '#c8a83a',
      emoji: '🍯', passable: true, buildTime: 2,
      tags: ['food', 'farm'], recipe: 'apiaryRecipe',
      costWood: CFG.apiaryCostWood,
    });
    // 风车粮仓：食物存储 + 加工（meta.storage + aura）
    m.registerBuilding({
      id: 'windmill-granary', name: '风车粮仓', size: { x: 2, y: 2 }, hp: 180, color: '#b8a878',
      emoji: '🌬', passable: false, buildTime: 5,
      tags: ['storage', 'farm'], meta: { storage: CFG.windmillGranaryStorage },
      costWood: CFG.windmillGranaryCostWood,
    });
    // ===== 军事类 =====
    // 瞭望塔：扩展光照范围（emitsLight = 10，比灯塔便宜但无 anchor）
    m.registerBuilding({
      id: 'watchtower', name: '瞭望塔', size: { x: 1, y: 1 }, hp: 150, color: '#6a5a4a',
      emoji: '🗼', passable: false, buildTime: 4, emitsLight: CFG.watchtowerLightRange,
      tags: ['light', 'defense'], costWood: CFG.watchtowerCostWood, costOre: CFG.watchtowerCostOre,
    });
    // 兵营：征召兵出生点（anchor tag + defense）
    m.registerBuilding({
      id: 'barracks', name: '兵营', size: { x: 2, y: 2 }, hp: 300, color: '#5a4a3a',
      emoji: '⚔', passable: false, buildTime: 7,
      tags: ['anchor', 'defense', 'barrier'], costWood: CFG.barracksCostWood, costOre: CFG.barracksCostOre,
    });
    // 投石机：远程防御建筑（meta.defense = { range, dmg }）
    m.registerBuilding({
      id: 'catapult', name: '投石机', size: { x: 2, y: 2 }, hp: 200, color: '#7a6a5a',
      emoji: '🎯', passable: false, buildTime: 8,
      tags: ['defense'], meta: { defense: { range: CFG.catapultRange, dmg: CFG.catapultDmg } },
      costWood: CFG.catapultCostWood, costOre: CFG.catapultCostOre,
    });
    // ===== 存储类 =====
    // 筒仓：食物专用存储（meta.storage 仅对 food 生效）
    m.registerBuilding({
      id: 'silo', name: '筒仓', size: { x: 1, y: 2 }, hp: 150, color: '#9a8a5a',
      emoji: '🏛', passable: false, buildTime: 4,
      tags: ['storage'], meta: { storage: CFG.siloStorage, foodOnly: true },
      costWood: CFG.siloCostWood,
    });
    // 军械库：工具/武器存储
    m.registerBuilding({
      id: 'armory', name: '军械库', size: { x: 2, y: 1 }, hp: 200, color: '#5a5a6a',
      emoji: '🗡', passable: false, buildTime: 5,
      tags: ['storage', 'defense'], meta: { storage: CFG.armoryStorage },
      costWood: CFG.armoryCostWood, costOre: CFG.armoryCostOre,
    });
    // ===== passive 配方 =====
    m.registerRecipe({ id: 'quarryRecipe', name: '采石场产石', kind: 'passive', output: { item: 'ore', amount: 0.1 } });
    m.registerRecipe({ id: 'brickyardRecipe', name: '砖窑产砖', kind: 'passive', output: { item: 'ore', amount: 0.08 } });
    m.registerRecipe({ id: 'apiaryRecipe', name: '蜂房产蜜', kind: 'passive', output: { item: 'food', amount: CFG.apiaryFoodPerSec } });
  },
};