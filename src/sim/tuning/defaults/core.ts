/**
 * defaults/core.ts —— 核心生存数值（world / pawn / needs / build / gathering）。
 */

export const world = {
  maxZ: 4,
  waterLevel: 0.33,
  stoneLevel: 0.35,
  stoneCell: 7,
  elevCells: [32, 14, 6],
  elevWeights: [0.55, 0.3, 0.15],
  dirtChance: 0.12,
  treeRate: 0.1,
  groveBoost: 2.6,
  moistCell: 18,
  treeSize: 2,
  berryRate: 0.03,
  berryAmountMin: 3,
  berryAmountMax: 5,
  spawnClearRadius: 6,
  harvestRegenSec: 90,
};

export const pawn = {
  speed: 4.5,
  climb: 1,
  hp: 100,
  defaultCardSec: 4,
  masteryGain: 1.5,
  masteryDecayPerSec: 0.02,
  atkCd: 1.2,
  dmg: 6,
  traitDmgMul: { strong: 1.5 },
};

export const needs = {
  foodDecay: 0.15,
  restDecay: 0.15,
  moodDecay: 0.05,
  sanDecay: 0.03,
  eatFoodGain: 40,
  eatMoodGain: 2,
  sleepRestNearFire: 6,
  sleepRestWild: 3,
  sleepSanNearFire: 1,
  sleepMagnetRadius: 24,
};

export const build = {
  minSpacing: 5,
  searchRadius: 6,
  newFireRadius: 24,
  spreadRadius: 16,
  spreadMice: 3,
  hutRatio: 0.5,
  storeRatio: 0.25,
  storeFoodDecayMul: 0.85,
  maxForageDist: 30,
};

export const gathering = { senseRadius: 10 };
