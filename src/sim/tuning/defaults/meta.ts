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

/** 对话数据表（P2 2026-10-13 MVP）：
 *  - **选项 = 玩家选择**（给玩家里子）——不做抽卡式随机选线；
 *  - **任务给"抽卡"面子**——选项效果走现有 gacha 机制（techFragment = 科技抽卡池碎片、
 *    stock = 营地仓库），不新造任务系统；
 *  - 选项可带 rollSuccess → 过 tuning.successRate.dialogue（说服检定，失败即拒绝）。
 *  MVP 单节点对话；键名 = PawnState.npc.dialogueId（缺省 'colony' 兜底）。
 *  数值只作演示性与测试锚点，内容线可自由替换（纯数据，mod 可覆盖）。
 */
export const dialogues: import('../types').Tuning['dialogues'] = {
  colony: {
    name: '鼠叔',
    lines: ['吱吱…（它在打量你）', '是外乡来的小家伙？营地可不常有你这样的。'],
    options: [
      { label: '「认识一下」' },
      { label: '「讨点口粮」', rollSuccess: true, stock: { food: 5 }, close: true },
      { label: '「再会」', close: true },
    ],
  },
  elder: {
    name: '鼠长老',
    lines: ['你也闻到那个味道了对吧——好，说明你有用。', '去把仓库的木头登记清楚，营地的炭火撑不过这个冬天。'],
    options: [
      { label: '「接受委托」（奖励走科技抽卡池）', techFragment: 'craft:tool' },
      { label: '「我先想想」', close: true },
    ],
  },
};
