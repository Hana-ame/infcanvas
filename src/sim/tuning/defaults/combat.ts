/**
 * defaults/combat.ts —— 社交 + 战斗 + 防御数值（social / raid / hunting / combat / fortify）。
 */

export const social = {
  chatRadius: 2.5,
  approachRadius: 26,
  chatMoodGain: 8,
  chatRelGain: 6,
  affinityDenom: 100,
  quarrelChance: 0.08,
  lowMoodQuarrelAt: 30,
  quarrelMoodHit: 4,
  quarrelRelHit: 3,
};

export const raid = {
  kind: 'cat',
  pressurePerSec: 0.55,
  pressureThreshold: 100,
  spawnDistMin: 16,
  spawnDistMax: 24,
  leashRadius: 11,
  attackRange: 1.25,
  senseRadius: 18,
  fleeHpRatio: 0.6,
  threatWorkMul: 0.35,
};

export const hunting = {
  meatGain: 50,
  huntSenseRadius: 24,
  huntMagnetRadius: 24,
  huntWorkRadius: 2.0,
  spawnIntervalSec: 25,
  spawnRadius: 30,
  maxAnimals: 6,
  leaveRadius: 40,
  wanderStepMin: 1,
  wanderStepMax: 3,
  fleeRadius: 2.5,
};

export const combat = {
  attackRange: 1.75,
  defendMagnetRadius: 24,
  holdRadius: 2.0,
  focusMul: 1.4,
  flankMul: 1.5,
  flankOffset: 3.5,
  rallySenseRadius: 24,
  rallyMinEnemies: 2,
  defendMulMultiEnemy: 1.6,
  multiEnemyThreshold: 3,
};

export const fortify = {
  trapDmgPerSec: 6,
  trapHitRadius: 0.6,
  wallMinGap: 1,
  trapDurabilitySec: 3,
};
