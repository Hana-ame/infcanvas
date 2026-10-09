/**
 * defaults/meta.ts —— 系统级数值 + 数据表（factions / techs / techPool / bootstrap / events / tiles / buildings / enemies / traits）。
 */

export const factions = {
  repInit: 35,
  friendlyThresh: 30,
  hostileThresh: -25,
  tradeRatio: 0.5,
  tradeMagnetRadius: 28,
  tradeWorkRadius: 2.5,
  tradeWoodCost: 2,
  checkSec: 20,
  repGainTrade: 4,
  repLossRaid: 12,
  repMeanRev: 0.005,
  repDriftMag: 10,
  gossipDecayPerSec: 0.01,
  gossipPerRaid: 0.35,
  socialPenalty: 0.5,
  maxRaiderWave: 2,
  raidCooldownSec: 90,
  spawnRadius: 26,
};

export const techs: Record<string, import('../types').TechTuningEntry> = {};

export const techPool = {
  intervalSec: 90,
  chance: 1.0,
};

export const bootstrap = { pawnCount: 4 };

export const events = {
  maxLog: 200,
  checkSec: 12,
  cooldownSec: 120,
  thresholds: {
    harvestFoodBelow: 60,
    coldsnapMinPawns: 6,
    plagueMinPawns: 6,
    strangerFoodAbove: 40,
    festivalFoodAbove: 80,
    fecundFoodAbove: 50,
  },
  effects: {
    harvestStockDelta: 20,
    coldsnapTempShift: -12,
    plagueHpDelta: -10,
    strangerSpawnPawn: 1,
    fecundSeasonStockMul: 1.3,
    festivalStockDelta: 15,
  },
};

export const tiles: Record<string, import('../types').TileTuningEntry> = {
  grass: { name: '草地' },
  dirt: { name: '泥地' },
  hill: { name: '丘陵' },
  stone: { name: '岩层' },
  water: { name: '水域', liquid: true },
};

export const buildings: Record<string, import('../types').BuildingTuningEntry> = {};

export const enemies: Record<string, import('../types').EnemyTuningEntry> = {};

export const traits = {
  strong: { name: '壮硕', seriesMul: {} },
  lazy: { name: '懒散', seriesMul: { rest: 1.4, gather: 0.9 } },
  owl: { name: '夜猫子', seriesMul: { wood: 1.2, rest: 0.9 } },
  workaholic: { name: '工作狂', seriesMul: { gather: 1.2, wood: 1.2, rest: 0.8 } },
  cheerful: { name: '乐天派', seriesMul: { social: 1.5 } },
};
