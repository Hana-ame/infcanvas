/**
 * sim/culinary-dishes.ts —— 丰富的食材料理系统 (Rich Ingredients & Culinary Dish System)
 *
 * 与 RimWorld 原版单调的“简单食物/精致食物/奢侈食物 (Simple/Fine/Lavish Meal)”不同，
 * 本系统引入：
 *   1. 四大类 14 种细分食材：
 *      - 主食谷物 (Grain & Starch)：高山稻米、冰原土豆、甜玉米粒、精磨麦粉
 *      - 肉禽水产 (Meat, Poultry & Seafood)：鲜切生兽肉、雪花霜降肉排、冷水鲜鱼肉、野禽鲜蛋
 *      - 果蔬菌菇 (Vegetables, Fruits & Fungi)：野生甜浆果、幽光洞穴蘑菇、霜叶甘蓝
 *      - 香料乳酪与秘制辅料 (Spices, Dairy & Condiments)：野生琥珀蜂蜜、秘制香辛料、窖藏醇香奶酪
 *   2. 三大烹饪阶梯 10 道特色料理：
 *      - 营火野炊料理 (Campfire / Great Bonfire)
 *      - 厨灶家常料理 (Stove Home-Style)
 *      - 传世星级盛宴 (Gourmet Feast)
 *   3. 每道料理赋予殖民者独特的持续风味增益 (Culinary Buff)：
 *      移动速度、工作建造效率、近战/射击伤害加成、生命再生速率、耐寒抗暑温度加成与专属心情加成。
 */

import type { Eid, PawnState } from './types';
import type { Sim } from './sim';

export type IngredientCategory = 'grain' | 'protein' | 'produce' | 'condiment';

export interface CulinaryIngredientDef {
  id: string;
  name: string;
  enName: string;
  icon: string;
  category: IngredientCategory;
  categoryLabel: string;
  basePrice: number;
  unitMassKg: number;
  rawNutrition: number;
  sourceHint: string;
  desc: string;
}

export type CulinaryTier = 'campfire' | 'stove' | 'feast';

export interface CulinaryBuffSpec {
  buffName: string;
  durationSec: number;
  moodBonus: number;
  moveSpeedPct: number;
  workSpeedPct: number;
  combatDmgPct: number;
  regenHpPerMin: number;
  coldHeatResistC: number;
  summary: string;
}

export interface CulinaryRecipeDef {
  id: string;
  name: string;
  enName: string;
  icon: string;
  tier: CulinaryTier;
  tierLabel: string;
  stationTags: Array<'campfire' | 'great_bonfire' | 'stove' | 'spice_prep_table'>;
  ingredients: Record<string, number>;
  yieldQty: number;
  nutritionGain: number;
  basePrice: number;
  unitMassKg: number;
  flavorDesc: string;
  buff: CulinaryBuffSpec;
}

export const CULINARY_INGREDIENTS: readonly CulinaryIngredientDef[] = [
  // 一、主食谷物 (Grain & Starch)
  {
    id: 'rice_grain',
    name: '高山稻米',
    enName: 'Highland Rice',
    icon: '🌾',
    category: 'grain',
    categoryLabel: '主食谷物',
    basePrice: 6,
    unitMassKg: 0.35,
    rawNutrition: 8,
    sourceHint: '农田种植 / 水培植物盆',
    desc: '颗粒饱满的高山粳米，煮制后米香浓郁，是炒饭与海鲜浓汤的核心主食。',
  },
  {
    id: 'potato_tuber',
    name: '冰原土豆',
    enName: 'Tundra Potato',
    icon: '🥔',
    category: 'grain',
    categoryLabel: '主食谷物',
    basePrice: 6,
    unitMassKg: 0.45,
    rawNutrition: 9,
    sourceHint: '贫瘠土地农田 / 遗迹粮仓',
    desc: '耐寒抗旱的淀粉块茎，炖煮后绵密起沙，极适合慢炖浓汤与烤肉配菜。',
  },
  {
    id: 'sweet_corn',
    name: '甜玉米粒',
    enName: 'Golden Sweet Corn',
    icon: '🌽',
    category: 'grain',
    categoryLabel: '主食谷物',
    basePrice: 7,
    unitMassKg: 0.4,
    rawNutrition: 10,
    sourceHint: '肥沃农田丰收',
    desc: '汁水充盈的金黄甜玉米，既可炭火直烤，也可熬制甜香浓汤。',
  },
  {
    id: 'wheat_flour',
    name: '精磨麦粉',
    enName: 'Stone-Milled Flour',
    icon: '🥖',
    category: 'grain',
    categoryLabel: '主食谷物',
    basePrice: 9,
    unitMassKg: 0.4,
    rawNutrition: 10,
    sourceHint: '备菜与香料研磨台研磨谷物',
    desc: '精细研磨的小麦面粉，用于烘焙酥皮派、煎饼与浓汤勾芡。',
  },

  // 二、肉禽水产 (Meat, Poultry & Seafood)
  {
    id: 'meat',
    name: '鲜切生兽肉',
    enName: 'Fresh Raw Meat',
    icon: '🥩',
    category: 'protein',
    categoryLabel: '肉禽水产',
    basePrice: 10,
    unitMassKg: 0.6,
    rawNutrition: 12,
    sourceHint: '狩猎野生动物后在屠宰台分解',
    desc: '新鲜分割的野兽红肉，富含优质蛋白，是炙烤与红烧料理的基础肉源。',
  },
  {
    id: 'prime_cut',
    name: '雪花霜降肉排',
    enName: 'Marbled Prime Cut',
    icon: '🥓',
    category: 'protein',
    categoryLabel: '肉禽水产',
    basePrice: 22,
    unitMassKg: 0.65,
    rawNutrition: 16,
    sourceHint: '大型猎物屠宰精修 / 备菜台刀工分解',
    desc: '油脂纹理如霜雪般均匀的顶级里脊肉排，香煎或涮煮皆入口即化。',
  },
  {
    id: 'fresh_fish',
    name: '冷水鲜鱼肉',
    enName: 'Coldwater Fish Fillet',
    icon: '🐟',
    category: 'protein',
    categoryLabel: '肉禽水产',
    basePrice: 14,
    unitMassKg: 0.5,
    rawNutrition: 13,
    sourceHint: '浅滩水域渔获 / 备菜台精修',
    desc: '肉质紧实清甜的冷水鱼柳，毫无腥气，适合熬制金汤或香煎鱼排。',
  },
  {
    id: 'poultry_egg',
    name: '野禽鲜蛋',
    enName: 'Wildfowl Egg',
    icon: '🥚',
    category: 'protein',
    categoryLabel: '肉禽水产',
    basePrice: 8,
    unitMassKg: 0.25,
    rawNutrition: 10,
    sourceHint: '野外灌木采集 / 备菜台精选',
    desc: '蛋黄橙红饱满的野禽蛋，是黄金蛋炒饭与松饼不可或缺的灵魂食材。',
  },

  // 三、果蔬菌菇 (Vegetables, Fruits & Fungi)
  {
    id: 'food',
    name: '野生甜浆果',
    enName: 'Wild Sweet Berries',
    icon: '🍓',
    category: 'produce',
    categoryLabel: '果蔬菌菇',
    basePrice: 6,
    unitMassKg: 0.35,
    rawNutrition: 12,
    sourceHint: '采集野外浆果灌木 / 农田种植',
    desc: '酸甜多汁的野生浆果，可直接生食充饥，或调配果香烤肉酱与甜点。',
  },
  {
    id: 'cave_mushroom',
    name: '幽光洞穴蘑菇',
    enName: 'Glow-Cap Mushroom',
    icon: '🍄',
    category: 'produce',
    categoryLabel: '果蔬菌菇',
    basePrice: 12,
    unitMassKg: 0.3,
    rawNutrition: 11,
    sourceHint: '岩洞暗处采集 / 农田菌菇培育',
    desc: '伞盖泛着微光的肥厚野生菌菇，富含氨基酸，炖汤鲜美无比。',
  },
  {
    id: 'frost_cabbage',
    name: '霜叶甘蓝',
    enName: 'Frost-Leaf Cabbage',
    icon: '🥬',
    category: 'produce',
    categoryLabel: '果蔬菌菇',
    basePrice: 7,
    unitMassKg: 0.4,
    rawNutrition: 9,
    sourceHint: '农田蔬菜种植',
    desc: '经霜冻后愈发清脆甘甜的绿叶蔬菜，能完美中和烤肉与火锅的油腻。',
  },

  // 四、香料乳酪与秘制辅料 (Spices, Dairy & Condiments)
  {
    id: 'wild_honey',
    name: '野生琥珀蜂蜜',
    enName: 'Amber Wild Honey',
    icon: '🍯',
    category: 'condiment',
    categoryLabel: '香料乳酪',
    basePrice: 18,
    unitMassKg: 0.3,
    rawNutrition: 14,
    sourceHint: '古树蜂巢采集 / 商队贸易',
    desc: '芬芳稠密的天然琥珀色蜂蜜，涂抹在烤肉表面可形成诱人的焦糖脆壳。',
  },
  {
    id: 'aromatic_spice',
    name: '秘制香辛料',
    enName: 'Exotic Spice Blend',
    icon: '🌶️',
    category: 'condiment',
    categoryLabel: '香料乳酪',
    basePrice: 20,
    unitMassKg: 0.15,
    rawNutrition: 4,
    sourceHint: '备菜与香料研磨台配制 / 农田香草种植',
    desc: '由胡椒、山奈、红椒与百里香研磨而成的复合香料，瞬间激发食材灵魂。',
  },
  {
    id: 'aged_cheese',
    name: '窖藏醇香奶酪',
    enName: 'Cave-Aged Cheese',
    icon: '🧀',
    category: 'condiment',
    categoryLabel: '香料乳酪',
    basePrice: 24,
    unitMassKg: 0.45,
    rawNutrition: 15,
    sourceHint: '备菜与香料研磨台发酵熟化',
    desc: '在恒温岩穴中熟化的浓香奶酪，加热后拉丝绵长，奶香醇厚。',
  },
];

export const CULINARY_INGREDIENT_MAP: Record<string, CulinaryIngredientDef> = {
  ...Object.fromEntries(CULINARY_INGREDIENTS.map((ing) => [ing.id, ing])),
};
// 兼容别名键映射 (Aliases for crop/resource keys)
CULINARY_INGREDIENT_MAP['corn_sweet'] = CULINARY_INGREDIENT_MAP['sweet_corn'];
CULINARY_INGREDIENT_MAP['glow_mushroom'] = CULINARY_INGREDIENT_MAP['cave_mushroom'];
CULINARY_INGREDIENT_MAP['frost_greens'] = CULINARY_INGREDIENT_MAP['frost_cabbage'];

export const CULINARY_RECIPES: readonly CulinaryRecipeDef[] = [
  // ==================== 第一阶：营火野炊料理 (Campfire / Great Bonfire) ====================
  {
    id: 'dish_honey_roast_skewer',
    name: '蜜汁炭烤野味串',
    enName: 'Honey-Glazed Roast Skewers',
    icon: '🍢',
    tier: 'campfire',
    tierLabel: '营火野炊',
    stationTags: ['campfire', 'great_bonfire', 'stove'],
    ingredients: { meat: 2, wild_honey: 1 },
    yieldQty: 3,
    nutritionGain: 48,
    basePrice: 26,
    unitMassKg: 0.45,
    flavorDesc: '明火炙烤得滋滋作响的鲜肉串，刷上琥珀蜂蜜与浆果汁，外焦里嫩。',
    buff: {
      buffName: '炭火蜜香',
      durationSec: 240,
      moodBonus: 8,
      moveSpeedPct: 6,
      workSpeedPct: 5,
      combatDmgPct: 8,
      regenHpPerMin: 1.5,
      coldHeatResistC: 5,
      summary: '心情+8 · 移速+6% · 战力+8%',
    },
  },
  {
    id: 'dish_campfire_mushroom_pot',
    name: '篝火菌菇山芋吊锅',
    enName: 'Campfire Mushroom & Tuber Pot',
    icon: '🍲',
    tier: 'campfire',
    tierLabel: '营火野炊',
    stationTags: ['campfire', 'great_bonfire', 'stove'],
    ingredients: { potato_tuber: 2, cave_mushroom: 1 },
    yieldQty: 3,
    nutritionGain: 46,
    basePrice: 24,
    unitMassKg: 0.5,
    flavorDesc: '在铁吊锅中咕嘟慢炖的冰原土豆与幽光蘑菇，热气腾腾，驱散荒野寒意。',
    buff: {
      buffName: '暖胃山野汤',
      durationSec: 240,
      moodBonus: 7,
      moveSpeedPct: 4,
      workSpeedPct: 8,
      combatDmgPct: 0,
      regenHpPerMin: 2.0,
      coldHeatResistC: 10,
      summary: '心情+7 · 工效+8% · 耐寒+10℃',
    },
  },
  {
    id: 'dish_charred_herb_fish',
    name: '香草盐烤冷水鱼',
    enName: 'Herb-Crusted Grilled Fish',
    icon: '🐟',
    tier: 'campfire',
    tierLabel: '营火野炊',
    stationTags: ['campfire', 'great_bonfire', 'stove'],
    ingredients: { fresh_fish: 1, aromatic_spice: 1, frost_cabbage: 1 },
    yieldQty: 3,
    nutritionGain: 50,
    basePrice: 28,
    unitMassKg: 0.45,
    flavorDesc: '鱼皮烤至金黄酥脆，内里鱼肉紧实多汁，伴有清新的山野香草气息。',
    buff: {
      buffName: '河鲜明目',
      durationSec: 260,
      moodBonus: 9,
      moveSpeedPct: 8,
      workSpeedPct: 6,
      combatDmgPct: 5,
      regenHpPerMin: 1.5,
      coldHeatResistC: 4,
      summary: '心情+9 · 移速+8% · 工效+6%',
    },
  },

  // ==================== 第二阶：厨灶家常料理 (Stove Home-Style) ====================
  {
    id: 'dish_golden_fried_rice',
    name: '黄金扬州蛋炒饭',
    enName: 'Golden Egg & Ham Fried Rice',
    icon: '🍛',
    tier: 'stove',
    tierLabel: '厨灶名菜',
    stationTags: ['stove', 'spice_prep_table'],
    ingredients: { rice_grain: 2, poultry_egg: 1, meat: 1 },
    yieldQty: 4,
    nutritionGain: 58,
    basePrice: 36,
    unitMassKg: 0.5,
    flavorDesc: '猛火快炒使每一粒高山稻米都裹满金黄蛋液，配以肉丁与葱花，镬气十足。',
    buff: {
      buffName: '粒粒金黄',
      durationSec: 320,
      moodBonus: 12,
      moveSpeedPct: 10,
      workSpeedPct: 14,
      combatDmgPct: 5,
      regenHpPerMin: 2.5,
      coldHeatResistC: 6,
      summary: '心情+12 · 工效+14% · 移速+10%',
    },
  },
  {
    id: 'dish_braised_beef_potato',
    name: '红烧慢炖牛腩土豆煲',
    enName: 'Slow-Braised Beef & Potato Casserole',
    icon: '🥘',
    tier: 'stove',
    tierLabel: '厨灶名菜',
    stationTags: ['stove', 'spice_prep_table'],
    ingredients: { meat: 2, potato_tuber: 2, aromatic_spice: 1 },
    yieldQty: 4,
    nutritionGain: 64,
    basePrice: 40,
    unitMassKg: 0.6,
    flavorDesc: '厚重砂锅慢火煨炖数小时，牛腩软烂入味，土豆吸饱浓郁肉汁。',
    buff: {
      buffName: '醇厚肉煲',
      durationSec: 360,
      moodBonus: 13,
      moveSpeedPct: 6,
      workSpeedPct: 12,
      combatDmgPct: 12,
      regenHpPerMin: 3.5,
      coldHeatResistC: 12,
      summary: '心情+13 · 战力+12% · 再生+3.5/分',
    },
  },
  {
    id: 'dish_creamy_mushroom_pasta',
    name: '芝士奶油菌菇烩面',
    enName: 'Creamy Cheese & Mushroom Pasta',
    icon: '🍝',
    tier: 'stove',
    tierLabel: '厨灶名菜',
    stationTags: ['stove', 'spice_prep_table'],
    ingredients: { wheat_flour: 2, cave_mushroom: 1, aged_cheese: 1 },
    yieldQty: 4,
    nutritionGain: 60,
    basePrice: 42,
    unitMassKg: 0.5,
    flavorDesc: '手工宽面裹满融化的窖藏醇香奶酪与鲜美菌菇白酱，令人幸福感爆棚。',
    buff: {
      buffName: '芝香浓郁',
      durationSec: 340,
      moodBonus: 15,
      moveSpeedPct: 8,
      workSpeedPct: 16,
      combatDmgPct: 4,
      regenHpPerMin: 2.5,
      coldHeatResistC: 8,
      summary: '心情+15 · 工效+16% · 移速+8%',
    },
  },
  {
    id: 'dish_berry_honey_pancake',
    name: '浆果蜜糖松软厚松饼',
    enName: 'Berry & Honey Fluffy Pancakes',
    icon: '🥞',
    tier: 'stove',
    tierLabel: '厨灶名菜',
    stationTags: ['stove', 'spice_prep_table'],
    ingredients: { wheat_flour: 1, poultry_egg: 1, food: 2, wild_honey: 1 },
    yieldQty: 4,
    nutritionGain: 54,
    basePrice: 38,
    unitMassKg: 0.4,
    flavorDesc: '云朵般蓬松的鸡蛋厚松饼，淋上野生琥珀蜂蜜与酸甜红浆果，治愈一切疲惫。',
    buff: {
      buffName: '蜜糖治愈',
      durationSec: 360,
      moodBonus: 18,
      moveSpeedPct: 10,
      workSpeedPct: 12,
      combatDmgPct: 0,
      regenHpPerMin: 3.0,
      coldHeatResistC: 5,
      summary: '心情+18 · 工效+12% · 移速+10%',
    },
  },

  // ==================== 第三阶：传世星级盛宴 (Gourmet Feast) ====================
  {
    id: 'dish_polar_spicy_hotpot',
    name: '极地九宫格麻辣红油火锅',
    enName: 'Polar Nine-Grid Spicy Hotpot',
    icon: '🫕',
    tier: 'feast',
    tierLabel: '传世盛宴',
    stationTags: ['stove', 'spice_prep_table', 'great_bonfire'],
    ingredients: {
      prime_cut: 1,
      meat: 1,
      cave_mushroom: 1,
      frost_cabbage: 1,
      aromatic_spice: 1,
    },
    yieldQty: 4,
    nutritionGain: 78,
    basePrice: 68,
    unitMassKg: 0.65,
    flavorDesc: '翻滚的牛油红汤香气四溢，涮入雪花肉排、鲜脆霜叶甘蓝与洞穴菌菇，酣畅淋漓！',
    buff: {
      buffName: '红汤热血沸腾',
      durationSec: 480,
      moodBonus: 22,
      moveSpeedPct: 15,
      workSpeedPct: 18,
      combatDmgPct: 16,
      regenHpPerMin: 4.5,
      coldHeatResistC: 18,
      summary: '心情+22 · 移速+15% · 工效+18% · 耐寒+18℃',
    },
  },
  {
    id: 'dish_black_pepper_prime_steak',
    name: '黑椒脆皮霜降牛排配烤蔬',
    enName: 'Black-Pepper Prime Steak & Roasted Veg',
    icon: '🥩',
    tier: 'feast',
    tierLabel: '传世盛宴',
    stationTags: ['stove', 'spice_prep_table'],
    ingredients: {
      prime_cut: 2,
      sweet_corn: 1,
      aged_cheese: 1,
      aromatic_spice: 1,
    },
    yieldQty: 4,
    nutritionGain: 80,
    basePrice: 74,
    unitMassKg: 0.6,
    flavorDesc: '高温封汁的五分熟雪花肉排，浇上现磨黑椒奶酪汁，佐以焦糖甜玉米。',
    buff: {
      buffName: '皇家铁板盛宴',
      durationSec: 480,
      moodBonus: 20,
      moveSpeedPct: 14,
      workSpeedPct: 15,
      combatDmgPct: 22,
      regenHpPerMin: 5.0,
      coldHeatResistC: 12,
      summary: '心情+20 · 战力+22% · 再生+5/分 · 移速+14%',
    },
  },
  {
    id: 'dish_imperial_seafood_bisque',
    name: '星海金汤芝士龙虾鱼柳釜饭',
    enName: 'Imperial Golden Seafood & Cheese Rice Pot',
    icon: '🦞',
    tier: 'feast',
    tierLabel: '传世盛宴',
    stationTags: ['stove', 'spice_prep_table'],
    ingredients: {
      fresh_fish: 2,
      rice_grain: 2,
      aged_cheese: 1,
      wild_honey: 1,
    },
    yieldQty: 4,
    nutritionGain: 82,
    basePrice: 78,
    unitMassKg: 0.6,
    flavorDesc: '冷水鱼柳与高山稻米在浓醇芝士金汤中慢煨收汁，鲜香直抵灵魂深处。',
    buff: {
      buffName: '星海至味',
      durationSec: 520,
      moodBonus: 25,
      moveSpeedPct: 16,
      workSpeedPct: 22,
      combatDmgPct: 14,
      regenHpPerMin: 4.5,
      coldHeatResistC: 15,
      summary: '心情+25 · 工效+22% · 移速+16%',
    },
  },
];

export const CULINARY_RECIPE_MAP: Record<string, CulinaryRecipeDef> = Object.fromEntries(
  CULINARY_RECIPES.map((r) => [r.id, r]),
);

export function ensureInitialCulinaryStockpile(sim: Sim): void {
  const defaults: Record<string, number> = {
    rice_grain: 16,
    potato_tuber: 14,
    sweet_corn: 12,
    corn_sweet: 12,
    wheat_flour: 10,
    meat: 18,
    prime_cut: 8,
    fresh_fish: 10,
    poultry_egg: 12,
    food: 24,
    cave_mushroom: 10,
    glow_mushroom: 10,
    frost_cabbage: 12,
    frost_greens: 12,
    wild_honey: 8,
    aromatic_spice: 10,
    aged_cheese: 8,
    dish_golden_fried_rice: 3,
    dish_honey_roast_skewer: 3,
  };
  for (const [k, qty] of Object.entries(defaults)) {
    if ((sim.stockpile[k] ?? 0) < qty) {
      sim.stockpile[k] = qty;
    }
  }
}

export function getColonyCulinarySummary(sim: Sim): {
  totalDishes: number;
  totalIngredients: number;
  dishes: Array<{ def: CulinaryRecipeDef; count: number }>;
  ingredients: Array<{ def: CulinaryIngredientDef; count: number }>;
} {
  const st = sim.stockpile;
  const dishes: Array<{ def: CulinaryRecipeDef; count: number }> = [];
  let totalDishes = 0;
  for (const r of CULINARY_RECIPES) {
    const count = Math.round(st[r.id] ?? 0);
    if (count > 0) {
      dishes.push({ def: r, count });
      totalDishes += count;
    }
  }
  const ingredients: Array<{ def: CulinaryIngredientDef; count: number }> = [];
  let totalIngredients = 0;
  for (const ing of CULINARY_INGREDIENTS) {
    const aliasCount =
      ing.id === 'sweet_corn'
        ? (st['corn_sweet'] ?? 0)
        : ing.id === 'cave_mushroom'
          ? (st['glow_mushroom'] ?? 0)
          : ing.id === 'frost_cabbage'
            ? (st['frost_greens'] ?? 0)
            : 0;
    const count = Math.round(Math.max(st[ing.id] ?? 0, aliasCount));
    if (count > 0) {
      ingredients.push({ def: ing, count });
      totalIngredients += count;
    }
  }
  return { totalDishes, totalIngredients, dishes, ingredients };
}

export function getActiveCulinaryBuff(
  pawn: PawnState | undefined,
  currentTime: number,
): NonNullable<PawnState['culinaryBuff']> | null {
  if (!pawn?.culinaryBuff) return null;
  if (currentTime > pawn.culinaryBuff.expiresAt) {
    delete pawn.culinaryBuff;
    return null;
  }
  return pawn.culinaryBuff;
}

export function cookCulinaryDish(
  sim: Sim,
  recipeId: string,
  cookEid?: Eid,
  allowAutoSubstitute = true,
): { ok: boolean; recipeId: string; gainedQty: number; message: string } {
  const recipe = CULINARY_RECIPE_MAP[recipeId] ?? CULINARY_RECIPES[0];
  if (!recipe) {
    return { ok: false, recipeId, gainedQty: 0, message: '未找到指定料理食谱' };
  }

  const missing: string[] = [];
  const deductions: Array<{ key: string; qty: number }> = [];

  for (const [ingKey, reqQty] of Object.entries(recipe.ingredients)) {
    const have = sim.stockpile[ingKey] ?? 0;
    if (have >= reqQty) {
      deductions.push({ key: ingKey, qty: reqQty });
    } else if (allowAutoSubstitute) {
      if (have > 0) {
        deductions.push({ key: ingKey, qty: have });
      }
      const deficit = reqQty - have;
      const altKey =
        (sim.stockpile['food'] ?? 0) >= deficit
          ? 'food'
          : (sim.stockpile['meat'] ?? 0) >= deficit
            ? 'meat'
            : (sim.stockpile['rice_grain'] ?? 0) >= deficit
              ? 'rice_grain'
              : null;
      if (altKey) {
        deductions.push({ key: altKey, qty: deficit });
      } else {
        missing.push(`${CULINARY_INGREDIENT_MAP[ingKey]?.name ?? ingKey}×${deficit}`);
      }
    } else {
      missing.push(`${CULINARY_INGREDIENT_MAP[ingKey]?.name ?? ingKey}×${reqQty - have}`);
    }
  }

  if (missing.length > 0 && !allowAutoSubstitute) {
    return {
      ok: false,
      recipeId: recipe.id,
      gainedQty: 0,
      message: `食材不足，缺少：${missing.join('、')}`,
    };
  }

  for (const d of deductions) {
    sim.stockpile[d.key] = Math.max(0, (sim.stockpile[d.key] ?? 0) - d.qty);
  }

  const cook = cookEid !== undefined ? [...sim.pawns()].find((p) => p.eid === cookEid) : [...sim.pawns()].find((p) => !p.isStranger);
  // skills 是 PawnSkillSlot[]（数组，非对象），按 id 查烹饪技能等级；
  // 烹饪对应三绑定 archetpye 是 plants_cook（见 triad-specialization.ts）。
  const cookSkill =
    cook?.skills?.find((s) => s.id === 'plants_cook' || s.id === 'cooking')?.level ??
    cook?.triads?.find((t) => t.skillId === 'plants_cook' || t.skillId === 'cooking')?.level ??
    8;
  const bonusYield = cookSkill >= 12 ? 1 : 0;
  const gainedQty = recipe.yieldQty + bonusYield;

  sim.stockpile[recipe.id] = (sim.stockpile[recipe.id] ?? 0) + gainedQty;
  sim.stockpile['meal'] = (sim.stockpile['meal'] ?? 0) + 1;

  if (cook) {
    // PawnState 本身无 xp（xp 在三绑定槽 BoundTriadSlot 上）：给烹饪槽累加经验。
    const triad = cook.triads?.find((t) => t.skillId === 'plants_cook' || t.skillId === 'cooking');
    if (triad) triad.xp += 18;
  }

  const usedIngLabels = Object.entries(recipe.ingredients)
    .map(([k, q]) => `${CULINARY_INGREDIENT_MAP[k]?.name ?? k}×${q}`)
    .join(' + ');

  const message = `${recipe.icon}【料理出锅】${cook?.name ?? '大厨'} 使用 (${usedIngLabels}) 烹制了【${recipe.name}】×${gainedQty} 份！食用效果：${recipe.buff.summary}`;
  sim.log(message);
  return { ok: true, recipeId: recipe.id, gainedQty, message };
}

export function consumeCulinaryDish(
  sim: Sim,
  pawnEid: Eid,
  preferredDishId?: string,
): { ok: boolean; dishId: string; message: string } {
  const pawn = [...sim.pawns()].find((p) => p.eid === pawnEid) ?? [...sim.pawns()].find((p) => !p.isStranger);
  if (!pawn) {
    return { ok: false, dishId: '', message: '未找到可进食的殖民者' };
  }

  let recipe: CulinaryRecipeDef | undefined;
  if (preferredDishId && CULINARY_RECIPE_MAP[preferredDishId]) {
    recipe = CULINARY_RECIPE_MAP[preferredDishId];
  } else {
    const tierOrder: Record<CulinaryTier, number> = { feast: 3, stove: 2, campfire: 1 };
    const available = CULINARY_RECIPES.filter((r) => (sim.stockpile[r.id] ?? 0) > 0).sort(
      (a, b) => tierOrder[b.tier] - tierOrder[a.tier],
    );
    recipe = available[0];
  }

  if (!recipe) {
    const autoCook = cookCulinaryDish(sim, preferredDishId ?? 'dish_golden_fried_rice', pawn.eid, true);
    recipe = CULINARY_RECIPE_MAP[autoCook.recipeId] ?? CULINARY_RECIPES[0];
  }

  if ((sim.stockpile[recipe.id] ?? 0) <= 0) {
    cookCulinaryDish(sim, recipe.id, pawn.eid, true);
  }
  sim.stockpile[recipe.id] = Math.max(0, (sim.stockpile[recipe.id] ?? 1) - 1);

  pawn.needs.food = Math.min(100, pawn.needs.food + recipe.nutritionGain);
  pawn.needs.mood = Math.min(100, pawn.needs.mood + recipe.buff.moodBonus);
  pawn.hp = Math.min(pawn.maxHp, pawn.hp + Math.round(recipe.buff.regenHpPerMin));

  pawn.culinaryBuff = {
    dishId: recipe.id,
    dishName: recipe.name,
    dishIcon: recipe.icon,
    buffName: recipe.buff.buffName,
    expiresAt: sim.time + recipe.buff.durationSec,
    moodBonus: recipe.buff.moodBonus,
    moveSpeedPct: recipe.buff.moveSpeedPct,
    workSpeedPct: recipe.buff.workSpeedPct,
    combatDmgPct: recipe.buff.combatDmgPct,
    regenHpPerMin: recipe.buff.regenHpPerMin,
    coldHeatResistC: recipe.buff.coldHeatResistC,
    summary: recipe.buff.summary,
  };

  const message = `${recipe.icon}【品尝佳肴】${pawn.name} 享用了【${recipe.name}】，饱食度 +${recipe.nutritionGain}，心情 +${recipe.buff.moodBonus}，获得持续增益「${recipe.buff.buffName}」(${recipe.buff.summary})！`;
  sim.log(message);
  return { ok: true, dishId: recipe.id, message };
}
