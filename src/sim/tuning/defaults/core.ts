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

/** 主角直接操控（P1 2026-10-13）：出厂与自主鼠同值起步，mod 可覆盖。
 *  P2：命中率迁出到 successRate.attack（成功率表统一入口），此处只留位移/范围。 */
export const hero = {
  speed: 4.5,
  attackRange: 1.75,
  /** 环境/NPC 交互判定半径（格，P2）：interact 的 proximity 扫描圈。 */
  interactRange: 2.5,
};

/** 成功率表初稿（P2 2026-10-13）：动作类判定统一入口，数值 mod 可覆盖。
 *  语义 = rollSuccess(rate)，失败语义由动作声明；rng 只在权威侧消费且随档 →
 *  失败可存档可回放。**移动本体无成功率**（终版口径：避免每次按键被判定拦截的手感碎裂）。 */
export const successRate = {
  /** 主角近战命中率（P1 的 hero.attackHitChance 收编于此；失败 = 无伤害但进冷却） */
  attack: 0.8,
  /** 拾取成功率（采浆果/砍树取木；失败 = 本次不采到 + 交互冷却） */
  pickup: 0.9,
  /** 攀爬/跳跃成功率（P2 未引入攀爬动作，表位预留——留审计足迹，避免数值凭空出现） */
  climb: 0.7,
  /** 冲刺成功率（P2 未引入冲刺动作，表位预留） */
  sprint: 0.75,
  /** 对话判定成功率（说服类选项；失败 = NPC 拒绝该选项，效果不生效） */
  dialogue: 0.65,
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
