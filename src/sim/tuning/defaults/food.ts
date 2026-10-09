/**
 * defaults/food.ts —— 食物链 + 医疗数值（farming / cooking / medicine）。
 */

export const farming = {
  searchRadius: 8,
  fieldRatio: 2,
  growSec: 120,
  yieldFood: 3,
  workRadius: 1.5,
  magnetRadius: 30,
  hungryBelow: 55,
  hungryWeightMul: 2.2,
};

export const cooking = {
  cookRawCost: 1,
  cookYield: 1,
  eatCookedFoodGain: 55,
  magnetRadius: 6,
  workRadius: 2.5,
  cookRawMaxStock: 40,
  cookSec: 6,
  rawStockMin: 0,
  cookWeightNearFire: 3.0,
};

export const medicine = {
  woundedBelow: 0.7,
  healPerSec: 2.0,
  bedBonus: 2.0,
  bedWorkRadius: 4,
  herbCost: 1,
  healWorkRadius: 2.5,
  healMagnetRadius: 24,
  naturalHealPerSec: 0.05,
  healWeightWounded: 3.0,
  healRequireHerb: 1,
  restWeightWounded: 1.6,
  bedSearchRadius: 12,
  bedRatio: 1,
};
