// 全局平衡参数表（tuning）—— 收敛散落在各系统的魔法数值
// 铁律：一切跨实体的平衡数值（阈值/概率/倍率/速率/半径）都从这里读，系统不写死。
// mod 可通过 ModRegistry.overrideTuning() 部分覆盖（DESIGN docs/DATA_DRIVEN.md §3.4）
import type { SkillId } from '../ai/pawn';

export interface NeedsTuning {
  foodDecay: number;       // 饥饿每秒衰减
  restDecay: number;       // 精力每秒衰减
  nightRestDrain: number;  // 夜晚额外精力流失
  hungerAt: number;        // food < 此值 = 紧急进食
  sleepyAt: number;        // rest < 此值 = 紧急休息
  urgentEatAt: number;     // 紧急进食满足阈值（≥ 此值解除 urgent）
  urgentRestAt: number;    // 紧急休息满足阈值
  starvationDmg: number;   // 饿死时 HP 每秒流失
  foodMoodLow: number;     // 饥饿时心情流失阈值
  foodMoodHigh: number;    // 饱食时心情回升阈值
  moodDriftDown: number;
  moodDriftUp: number;
  sanRecover: number;      // SAN 自然恢复
  sanTraumaThreshold: number; // 重伤/低满足动摇理智的阈值
  sanTraumaDrain: number;
}

export interface SanTuning {
  crazyAt: number;         // SAN < 此值 = 狂乱
  witnessRadius: number;   // 目睹死亡的距离
  fireComfortRadius: number; // 篝火安全感半径
  deathShock: number;      // 目睹死亡 SAN 冲击基数
  deathMood: number;       // 目睹死亡心情损失
  nightDrain: number;      // 黑夜离火 SAN 流失
  fireRecover: number;     // 篝火旁 SAN 恢复
  crazyCooldownMin: number;
  crazyCooldownMax: number;
}

export interface GatherTuning {
  toolBonus: number;
  strBonusPerPoint: number;
  strBase: number;
  moodGainSuccess: number;
  moodGainFail: number;
}

export interface FaithTuning {
  prayTime: number;        // 祈祷所需秒数
  prayMood: number;        // 祈祷心情加成
  prayFaith: number;       // 祈祷信仰增加
  appBase: number;         // 魅力加成基准（APP - 此值）/50
  appScale: number;
  healPerSec: number;      // 疗伤回血速率
  healTime: number;        // 疗伤最长秒数
  caveWorkDuration: number; // 矿洞一次工作最长秒数
  oracleRadius: number;    // 神谕影响半径
  oracleDuration: number;  // 神谕祝福持续秒数
  oracleMood: number;      // 神谕心情加成基数
  oracleFaith: number;     // 神谕信仰增幅
  oracleTrustAt: number;   // 神谕信任门槛（信仰/100 ≥ 此值才受影响）
}

export interface CombatTuning {
  wolfHp: number;          // 狼基础血量
  wolfSpeed: number;       // 狼移动速度（格/秒）
  wolfDmg: number;         // 狼每秒伤害
  unitDmg: number;         // 派系掠夺者每秒伤害
  pawnDmg: number;         // 小人近战每秒伤害
  unitHp: number;          // 掠夺者血量
  initialRaidDelay: number; // 开局首波前等待
  baseInterval: number;    // 基线袭击间隔
  pressureCap: number;     // 叙事压力上限
  pressureScale: number;   // 压力增速（和平秒数 / 基数）
  raidCountBase: number;
  raidCountPerPawn: number;
  meleeRange: number;      // 接敌距离
  buildingDmg: number;     // 打建筑每秒伤害
  buildingRadius: number;  // 打建筑搜索半径
  minDodge: number;        // DEX 闪避下限
  dodgePerPoint: number;   // 每点 DEX 闪避
  dodgeBase: number;
  wolfLootOre: number;     // 击杀掉矿
}

export interface SocialTuning {
  interactCdMin: number;   // 社交冷却下限
  interactCdMax: number;
  friendAt: number;        // 好感 ≥ 此值 = 亲密（协作加成）
  hostileAt: number;       // 好感 ≤ 此值 = 敌对（口角）
  punchChanceBase: number; // 动手基础概率
  punchChancePerHostility: number; // 每点敌对增加概率
  punchChanceMin: number;
  punchChanceMax: number;
  punchDmg: number;
  moodFriend: number;      // 亲密相邻心情加成
  moodHostile: number;     // 敌对相邻心情损失
  relDeltaPositive: number;
  relDeltaNegative: number;
  relDeltaNeutral: number;
  moodPositive: number;
  moodNegative: number;
  preachChance: number;    // 高信仰者传教概率
  preachFaithAt: number;   // 传教信仰门槛
  preachSucceedFaith: number;
  preachFailRel: number;
  preachSucceedRel: number;
}

export interface DesireTuning {
  checkInterval: number;   // 欲望检查周期
  decayPerSec: number;     // 欲望基础衰减
  personalityFactor: number; // 先天倾向对衰减的调制
  scarceAt: number;        // < 此值 = 匮乏
  criticalAt: number;      // < 此值 = 危急
  moodCritical: number;    // 危急时心情损失
  moodScarce: number;      // 匮乏时心情损失（≥2 项）
  malintentChance: number; // 恶意槽触发概率
  malintentMoodGain: number;
  malintentFulfill: number;
  fulfillWork: number;     // 工作时满足贪婪
  fulfillBuild: number;
  fulfillPray: number;
  powResistBase: number;
  stealThreshold: number;  // 偷窃资源需库存超过此值
  stealAmount: number;     // 偷窃取走量
}

export interface FactionTuning {
  warAt: number;           // 双向看法 ≤ 此值 = 开战
  tradeAt: number;         // 双向看法 ≥ 此值 = 贸易
  deficitAt: number;       // 逆差 ≤ 此值 = 怨恨
  tradeRateNormal: number; // 正常汇率（1 木 = x 食）
  tradeRateShort: number;  // 缺粮时汇率
  tradeWood: number;       // 每次贸易交换的木量
  raidCooldown: number;    // 派系袭击冷却
  tradeCooldown: number;
  msgCooldown: number;
  unitRaidCountMin: number;
  unitRaidCountMax: number;
  resourceGrowthWood: number; // 野生单位被动资源增速
  resourceGrowthFood: number;
  resourceGrowthOre: number;
  resourceCap: number;     // 单位库存上限
  opinionFriendly: number; // 协作看法增量
  opinionRaid: number;     // 袭击看法损失
  opinionTrade: number;    // 贸易看法变化（顺差方）
  opinionTradeRecipient: number; // 贸易看法变化（逆差方）
  opinionThreat: number;   // 威胁传话看法变化
  opinionDeficit: number;  // 逆差怨恨看法下滑
  trustTimer: number;      // 信任评估周期
  clusterAllyThreshold: number;
}

export interface PopulationTuning {
  maxPawns: number;        // 人口上限
  recruitInterval: number; // 招募间隔
  foodThreshold: number;   // 招募食物门槛
  recruitRetryAfter: number; // 食物不足重试
}

export interface RepairTuning {
  workTime: number;        // 修理耗时
  repairAmount: number;    // 每次修复量
  searchRadius: number;    // 找受损建筑半径
}

export interface AutobuildTuning {
  evaluateMin: number;     // 评估周期下限
  evaluateMax: number;
  maxPerEval: number;      // 每次最多规划
  campfireWood: number;
  campfireWoodExtra: number;
  pawnsPerCampfire: number;   // 多少人要第二篝火
  campfireTarget: number;
  foodThreshold: number;   // 缺粮阈值
  farmTarget: number;
  toolsThreshold: number;  // 工具不足阈值
  workbenchTarget: number;
  oreThreshold: number;    // 矿少阈值
  caveTarget: number;
  faithThreshold: number;  // 建教堂信仰门槛
  farmWood: number;        // 各计划起建木材门槛
  workbenchWood: number;
  caveWood: number;
  churchWood: number;
  wallWood: number;        // 围墙余木阈值
  wallTarget: number;
  buildRadiusMin: number;
  buildRadiusMax: number;
}

export interface EnvTuning {
  baseTemp: number;
  dayAmplitude: number;
  rainCool: number;
  rainChancePerSec: number;
  rainMin: number;
  rainMax: number;
  hotAt: number;
  coldAt: number;
}

export interface UpgradeTuning {
  faithThreshold: number;  // 篝火→教堂信仰门槛
}

export interface PawnTuning {
  baseSpeed: number;       // 小人移动速度（格/秒）
  hpBase: number;          // 血量基础值（+ (con+siz)/2）
}

export interface CardTuning {
  commandCooldown: number; // 玩家命令后不自动决策秒数
  defyCd: number;          // 违抗冷却
  defyLazy: number;        // 懒惰违抗基础概率
  defyMoodLow: number;     // 心情差违抗加成
  defyMoodAt: number;      // 心情阈值
  faithReducePerFaith: number; // 信仰降低违抗
  eatAmount: number;       // 进食补充量
  eatAmountUrgent: number;
  restAmount: number;
  restAmountUrgent: number;
  priority: PriorityRule[]; // 派系工作优先级规则（数据驱动：短缺资源 → 对应工作卡权重提高）
}

export interface PriorityRule {
  cardId: string;          // 受影响的工作卡 id（factionPriority 的 key）
  resource: 'food' | 'wood' | 'ore' | 'queue'; // 'queue' = 用 buildQueue 长度
  lowAt: number;           // 库存低于此值 → boost
  boost: number;           // 短缺时权重倍率
  urgentAt?: number;       // 库存低于此值 → urgentBoost
  urgentBoost?: number;
}

export interface EventTuning {
  interval: number;        // 事件 roll 基础间隔
  intervalJitter: number;  // 间隔随机抖动上限
}

export interface SkillTuning {
  growSkillRoll: 'overCurrent'; // COC：d100 > 当前 才成长
}

export interface TuningConfig {
  needs: NeedsTuning;
  san: SanTuning;
  gather: GatherTuning;
  faith: FaithTuning;
  combat: CombatTuning;
  social: SocialTuning;
  desire: DesireTuning;
  faction: FactionTuning;
  population: PopulationTuning;
  repair: RepairTuning;
  autobuild: AutobuildTuning;
  env: EnvTuning;
  upgrade: UpgradeTuning;
  pawn: PawnTuning;
  event: EventTuning;
  card: CardTuning;
  skill: SkillTuning;
  // 占位：保留给 SkillId 类型引用（避免未使用告警）
  _?: SkillId;
}

export const TUNING: TuningConfig = {
  needs: {
    foodDecay: 0.15,
    restDecay: 0.08,
    nightRestDrain: 0.12,
    hungerAt: 30,
    sleepyAt: 20,
    urgentEatAt: 70,
    urgentRestAt: 70,
    starvationDmg: 2.5,
    foodMoodLow: 30,
    foodMoodHigh: 70,
    moodDriftDown: 0.05,
    moodDriftUp: 0.01,
    sanRecover: 0.02,
    sanTraumaThreshold: 15,
    sanTraumaDrain: 0.03,
  },
  san: {
    crazyAt: 25,
    witnessRadius: 8,
    fireComfortRadius: 7,
    deathShock: 12,
    deathMood: 4,
    nightDrain: 0.35,
    fireRecover: 2.5,
    crazyCooldownMin: 3,
    crazyCooldownMax: 7,
  },
  gather: {
    toolBonus: 1.3,
    strBonusPerPoint: 0.01,
    strBase: 40,
    moodGainSuccess: 2,
    moodGainFail: -3,
  },
  faith: {
    prayTime: 2,
    prayMood: 6,
    prayFaith: 5,
    appBase: 40,
    appScale: 50,
    healPerSec: 12,
    healTime: 4,
    caveWorkDuration: 40,
    oracleRadius: 6,
    oracleDuration: 30,
    oracleMood: 12,
    oracleFaith: 3,
    oracleTrustAt: 0.3,
  },
  combat: {
    wolfHp: 60,
    wolfSpeed: 3.5,
    wolfDmg: 5,
    unitDmg: 7,
    pawnDmg: 8,
    unitHp: 90,
    initialRaidDelay: 60,
    baseInterval: 75,
    pressureCap: 2,
    pressureScale: 3,
    raidCountBase: 2,
    raidCountPerPawn: 0.5,
    meleeRange: 5,
    buildingDmg: 15,
    buildingRadius: 6,
    minDodge: 0.05,
    dodgeBase: 30,
    dodgePerPoint: 0.01,
    wolfLootOre: 2,
  },
  social: {
    interactCdMin: 15,
    interactCdMax: 25,
    friendAt: 40,
    hostileAt: -20,
    punchChanceBase: 0.08,
    punchChancePerHostility: 0.004,
    punchChanceMin: 0.08,
    punchChanceMax: 0.4,
    punchDmg: 8,
    moodFriend: 0.5,
    moodHostile: -0.5,
    relDeltaPositive: 3,
    relDeltaNegative: -4,
    relDeltaNeutral: 1,
    moodPositive: 1,
    moodNegative: -2,
    preachChance: 0.25,
    preachFaithAt: 30,
    preachSucceedFaith: 4,
    preachFailRel: -5,
    preachSucceedRel: 6,
  },
  desire: {
    checkInterval: 5,
    decayPerSec: 0.02,
    personalityFactor: 0.6,
    scarceAt: 30,
    criticalAt: 15,
    moodCritical: -8,
    moodScarce: -3,
    malintentChance: 0.12,
    malintentMoodGain: 8,
    malintentFulfill: 15,
    fulfillWork: 2,
    fulfillBuild: 1.5,
    fulfillPray: 2,
    powResistBase: 0.3,
    stealThreshold: 10,
    stealAmount: 5,
  },
  faction: {
    warAt: -40,
    tradeAt: 40,
    deficitAt: -20,
    tradeRateNormal: 1.5,
    tradeRateShort: 3,
    tradeWood: 4,
    raidCooldown: 45,
    tradeCooldown: 60,
    msgCooldown: 90,
    unitRaidCountMin: 2,
    unitRaidCountMax: 4,
    resourceGrowthWood: 0.4,
    resourceGrowthFood: 0.3,
    resourceGrowthOre: 0.15,
    resourceCap: 500,
    opinionFriendly: 0.5,
    opinionRaid: -5,
    opinionTrade: 1,
    opinionTradeRecipient: -0.5,
    opinionThreat: -1.5,
    opinionDeficit: -0.8,
    trustTimer: 8,
    clusterAllyThreshold: 30,
  },
  population: {
    maxPawns: 12,
    recruitInterval: 45,
    foodThreshold: 60,
    recruitRetryAfter: 30,
  },
  repair: {
    workTime: 1.5,
    repairAmount: 20,
    searchRadius: 15,
  },
  autobuild: {
    evaluateMin: 20,
    evaluateMax: 30,
    maxPerEval: 2,
    campfireWood: 6,
    campfireWoodExtra: 10,
    pawnsPerCampfire: 4,
    campfireTarget: 2,
    foodThreshold: 80,
    farmTarget: 3,
    toolsThreshold: 2,
    workbenchTarget: 2,
    oreThreshold: 20,
    caveTarget: 2,
    faithThreshold: 35,
    farmWood: 12,
    workbenchWood: 20,
    caveWood: 15,
    churchWood: 25,
    wallWood: 60,
    wallTarget: 6,
    buildRadiusMin: 2,
    buildRadiusMax: 6,
  },
  env: {
    baseTemp: 18,
    dayAmplitude: 10,
    rainCool: -4,
    rainChancePerSec: 0.003,
    rainMin: 15,
    rainMax: 35,
    hotAt: 32,
    coldAt: 0,
  },
  upgrade: {
    faithThreshold: 35,
  },
  pawn: {
    baseSpeed: 4,
    hpBase: 40,
  },
  event: {
    interval: 45,
    intervalJitter: 30,
  },
  card: {
    commandCooldown: 3,
    defyCd: 30,
    defyLazy: 0.25,
    defyMoodLow: 0.3,
    defyMoodAt: 20,
    faithReducePerFaith: 0.005,
    eatAmount: 40,
    eatAmountUrgent: 50,
    restAmount: 40,
    restAmountUrgent: 40,
    priority: [
      { cardId: 'farm', resource: 'food', lowAt: 60, boost: 1.6, urgentAt: 20, urgentBoost: 2.4 },
      { cardId: 'chop', resource: 'wood', lowAt: 40, boost: 1.5 },
      { cardId: 'mine', resource: 'ore', lowAt: 15, boost: 1.4 },
      { cardId: 'caveMine', resource: 'ore', lowAt: 15, boost: 1.4 },
      { cardId: 'build', resource: 'queue', lowAt: 0, boost: 1.8 },
    ],
  },
  skill: {
    growSkillRoll: 'overCurrent',
  },
};
