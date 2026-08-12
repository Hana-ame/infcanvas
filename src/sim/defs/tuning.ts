import type { SkillId } from '../ai/pawn';

// 全局平衡参数表（tuning）—— 收敛散落在各系统的魔法数值
// 铁律：一切跨实体的平衡数值（阈值/概率/倍率/速率/半径）都从这里读，系统不写死。
// mod 可通过 ModRegistry.overrideTuning() 部分覆盖（DESIGN docs/DATA_DRIVEN.md §3.4）
export interface NeedsTuning {
  initFood: number;          // 出生需求初始值
  initRest: number;
  initMood: number;
  initSan: number;
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
  auraScanRadius: number;  // nearAura 光环建筑扫描半径（生效距离由 def.aura.radius 决定）
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
  crazyFleeAfter: number; // 狂乱持续超过此秒数 → 本能逃向最近篝火（防永久崩溃死锁）
  powResistMid: number;    // POW 抗压公式中点（POW ≥ 此值开始减伤）
  powResistScale: number;  // POW 抗压公式分母
  shockDistFloor: number;  // 死亡冲击距离衰减下限
  resistFloor: number;     // 抵抗系数下限
  crazyWanderRange: number; // 狂乱乱跑随机范围（格）
  crazyWanderAttempts: number; // 狂乱乱跑尝试次数
}

export interface GatherTuning {
  toolBonus: number;
  strBonusPerPoint: number;
  strBase: number;
  carryBase: number;      // 负重基数：一次采集搬回量下限（SIZ ≤ carryBase 时）
  carryPerSiz: number;    // 负重增量：每点 SIZ 提高的搬回量（SIZ 全属性用途，COC §3）
  caveMoodWin: number;     // 矿洞开采成功心情
  caveMoodLose: number;
  mineMoodWin: number;
  mineMoodLose: number;
  chopMoodWin: number;
  chopMoodLose: number;
  // 配方/地表表缺字段时的兜底（recipes/tiles 表优先）
  harvestInterval: number;  // 矿洞工作每几秒一轮
  harvestDc: number;        // 矿洞检定 DC
  harvestSkill: SkillId;    // 矿洞检定技能
  harvestYield: number;     // 矿洞成功产出
  harvestFailYield: number; // 矿洞失败产出
  harvestItem: string;      // 矿洞产出物
  harvestTime: number;      // 矿石采集最长秒数
  chopTime: number;         // 伐木最长秒数
  chopDc: number;           // 伐木检定 DC
  chopSkill: SkillId;        // 伐木检定技能
  chopYield: number;        // 伐木成功产出
  chopFailYield: number;    // 伐木失败产出
  chopItem: string;         // 伐木产出物
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
  oracleMoodHalfDiv: number; // 神谕即时心情 = oracleMood/此除数 × 信任
  oracleFaith: number;     // 神谕信仰增幅
  oracleTrustAt: number;   // 神谕信任门槛（信仰/100 ≥ 此值才受影响）
}

export interface CombatTuning {
  raidEnemy: string;         // 自然袭击刷的敌人种类 id（查 enemies 表；mod 可切换/注册新敌人）
  unitRaidEnemy: string;     // 派系袭击（掠夺者）刷的敌人种类 id
  wolfSpeed: number;         // 敌人表缺 speed 字段时的兜底
  wolfLootItem: string;      // 敌人表缺 loot 字段时的兜底
  wolfLootAmount: number;
  pawnDmg: number;           // 小人近战每秒伤害
  initialRaidDelay: number;  // 开局首波前等待
  baseInterval: number;      // 基线袭击间隔
  pressureCap: number;       // 叙事压力上限
  pressureScale: number;     // 压力增速（和平秒数 / 基数）
  raidCountBase: number;
  raidCountPerPawn: number;
  meleeRange: number;        // 接敌距离
  buildingDmg: number;       // 打建筑每秒伤害
  buildingRadius: number;    // 打建筑搜索半径
  minDodge: number;          // DEX 闪避下限
  dodgePerPoint: number;     // 每点 DEX 闪避
  dodgeBase: number;
}

export interface SocialTuning {
  tickInterval: number;
  lustFulfillPerInteract: number; // 色欲满足：一次成功社交互动 +此值（七宗罪全途径）
  gossipTtl: number;        // 话题传播有效期（秒）：听到的话题在期内可转述
  gossipChance: number;     // 互动时聊起听到的话题的概率（其余从历史抽新话题）    // 全系统社交节流（秒）
  meetDist: number;        // 相遇距离（相邻才算）
  interactCdMin: number;   // 社交冷却下限
  interactCdMax: number;
  friendAt: number;        // 好感 ≥ 此值 = 亲密（协作加成）
  hostileAt: number;       // 好感 ≤ 此值 = 敌对（口角）
  punchChanceBase: number; // 动手基础概率
  punchChancePerHostility: number; // 每点敌对增加概率
  punchChanceMin: number;
  punchChanceMax: number;
  punchDmg: number;
  punchRelLoss: number;    // 动手后敌对双方向对方好感损失（绝对值）
  punchRelFloor: number;   // 好感下限（绝对值）
  punchMoodWin: number;    // 动手赢家心情
  punchMoodLose: number;   // 动手输家心情
  moodFriend: number;      // 亲密相邻心情加成
  moodHostile: number;     // 敌对相邻心情损失
  relDeltaPositive: number;
  relDeltaNegative: number;
  relDeltaNeutral: number;
  relFloor: number;        // 好感钳制下限（绝对值）
  relCap: number;          // 好感钳制上限
  moodPositive: number;
  moodNegative: number;
  charmBase: number;       // 魅力加成基准（APP - 此值）/div
  charmDiv: number;
  toneHighAt: number;      // 双方心情都 > 此值 → 积极基调概率高
  toneLowAt: number;       // 任一心情 < 此值 → 消极基调概率高
  tonePosChance: number;   // 高心情 → 积极概率
  toneNegChance: number;   // 低心情 → 消极概率
  toneNeutralChance: number; // 中性基调下先 roll 消极的概率
  logChance: number;       // 中性互动写日志概率
  preachChance: number;    // 高信仰者传教概率
  preachFaithAt: number;   // 传教信仰门槛
  preachSucceedFaith: number;
  preachAppDiv: number;    // 传教攻击力 = APP/此除数 + faith/此除数
  preachFaithDiv: number;
  preachResistFaith: number; // 守方现有信仰的抵抗系数
  preachSelfFaith: number; // 传教成功传教者自身信仰 + 此值
  preachFailRel: number;
  preachSucceedRel: number;
  preachFailMood: number;  // 传教失败传教者心情
}

export interface DesireTuning {
  initMin: number;
  envyFulfillPerWork: number;   // 嫉妒满足：完成一次劳动 +此值（存在更强同伴时）         // 欲望初始满足度下限
  initRange: number;       // 欲望初始满足度随机区间
  sinInitMin: number;      // 罪孽先天倾向初始下限
  sinInitRange: number;    // 罪孽先天倾向初始随机区间
  sinFloor: number;        // 罪孽倾向下限（天赋消极修正保底）
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
  powResistBase: number;
  powResistMid: number;    // POW 抗恶意公式中点
  powResistScale: number;  // POW 抗恶意公式分母
  stealThreshold: number;  // 偷窃资源需库存超过此值
  stealAmount: number;     // 偷窃取走量
  fulfillGluttony: number; // 进食卡对暴食的满足量
  fulfillSloth: number;    // 休息卡对懒惰的满足量
  fulfillWrath: number;    // 暴怒发泄对暴怒的满足量
  wrathSmashDmg: number;   // 暴怒砸建筑伤害
  wrathSpinMood: number;   // 暴怒原地转圈心情
  lustMood: number;        // 色欲/嫉妒/傲慢匮乏心情
}

export interface FactionTuning {
  warAt: number;           // 双向看法 ≤ 此值 = 开战
  tradeAt: number;         // 双向看法 ≥ 此值 = 贸易
  deficitAt: number;       // 逆差 ≤ 此值 = 怨恨
  tradeRateNormal: number; // 正常汇率（1 木 = x 食）
  tradeRateShort: number;  // 缺粮时汇率
  tradeWood: number;       // 每次贸易交换的木量
  tradeFoodScarceAt: number; // 缺粮判定库存阈值（< 此值 → 高汇率）
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
  opinionMsgFriendly: number; // 友善传话看法增量
  opinionRaid: number;     // 袭击看法损失
  opinionTrade: number;    // 贸易看法变化（顺差方）
  namePrefixes?: string[]; // 部落/派系名前缀覆盖（缺省用 defs/factionNames.ts 内置表）
  nameSuffixes?: string[];
  opinionTradeRecipient: number; // 贸易看法变化（逆差方）
  opinionThreat: number;   // 威胁传话看法变化
  opinionDeficit: number;  // 逆差怨恨看法下滑
  trustTimer: number;      // 信任评估周期
  priorityTimer: number;   // 派系工作优先级评估周期（秒）
  upgradeNearDist: number; // 升级判定：教堂附近多少格内的篝火单位可升级
  unitStartResources: Record<string, number>; // 派系初始库存
  trustMeetDist: number;   // 跨单位成员协作相遇距离
  unitCapChurch: number;   // 教堂单位成员上限（客户端 UI 也读它）
  unitCapCampfire: number; // 篝火单位成员上限
  unitReassignMargin: number;   // 成员归属切换门槛：新单位比旧归属明显更近（格）才切换（防开局假团灭）
}

export interface PopulationTuning {
  maxPawns: number;        // 人口上限
  recruitInterval: number; // 招募间隔
  foodThreshold: number;   // 招募食物门槛
  recruitRetryAfter: number; // 食物不足重试
  startStockpile: Record<string, number>; // 开局库存（营地初始资源）
  spawnRingMin: number;    // 招募/流浪者生成环半径下限
  spawnRingMax: number;    // 生成环半径上限
}

export interface CraftTuning {
  costFallback: number;     // recipes 表 input 缺 amount 时的兜底
  outputFallback: number;   // recipes 表 output 缺 amount 时的兜底
  intervalFallback: number; // recipes 表缺 interval 时的兜底
}

export interface RepairTuning {
  workTime: number;        // 修理耗时
  repairAmount: number;    // 每次修复量
  searchRadius: number;    // 找受损建筑半径
  inPlaceDist: number;     // 原地直接修理距离（格）
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
  churchTarget: number;    // 教堂目标数
  farmWood: number;        // 各计划起建木材门槛
  workbenchWood: number;
  caveWood: number;
  churchWood: number;
  wallWood: number;        // 围墙余木阈值
  wallTarget: number;
  spotRingMin: number;     // 找建造位环半径下限
  spotRingMax: number;
  spotAttempts: number;    // 找位尝试次数
  costWoodPerCell: number; // 建筑缺省成本：size²×此值
  costWoodFallback: number; // 建筑缺省成本兜底
  costOreFallback: number; // 建筑缺省矿石成本兜底
  starterBuilding: string; // 出生点自动建造的建筑（默认 campfire）
  fallbackBuilding: string; // 玩家建造命令缺省建筑（默认 wall）
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
  dayLength: number;       // 一天秒数
  nightStart: number;      // dayTime > 此值 = 夜晚开始
  nightEnd: number;        // dayTime < 此值 = 夜晚结束
}

export interface PawnTuning {
  baseSpeed: number;       // 小人移动速度（格/秒）
  hpBase: number;          // 血量基础值（+ (con+siz)/2）
  scanRadius: number;      // 目标搜索半径（找树/矿/建筑等，近距快扫）
  farScanRadius: number;   // 近距未命中后的远距回扫半径（防营地周边资源采空后停产）
  maxWorkDist: number;     // 工作目标最大距离（超距不寻路——寻路风暴修复，用户要求"不要太远"）
  attrMin: number;         // 八属性生成下限
  attrMax: number;         // 八属性生成上限
  traitCountMin: number;   // 天赋数量下限
  traitCountMax: number;   // 天赋数量上限
  maxSlotsMin: number;     // 卡槽基础数
  maxSlotsRand: number;    // 卡槽随机增量（0..N）
  moodSpeedBase: number;   // 移动速度心情系数 = base + mood/100 × scale
  moodSpeedScale: number;
  skillIntFrom: number;    // 技能初始公式：INT 基准/除数
  skillIntDiv: number;
  skillEduFrom: number;    // EDU 基准/除数
  skillEduDiv: number;
  skillInit: Record<string, number>; // 五技能初始值（skillId → 起点）
  intBonusFrom: number;    // 检定 INT 加成 = floor((int - from)/div)
  intBonusDiv: number;
  skillBonusFrom: number;  // 检定技能加成 = floor((skill - from)/div)
  skillBonusDiv: number;
}

export interface WorldTuning {
  spawnClearRadius: number; // 出生点清场半径（正整数，清 (2r+1)²）
  spawnTries: number;      // 出生点资源撒布尝试次数
  spawnDistMin: number;    // 资源撒布距离下限
  spawnDistRand: number;   // 资源撒布距离随机区间
  spawnCounts: Record<string, number>; // 出生点资源构成：tileId → 数量
}

export type HeuristicId = 'chebyshev' | 'manhattan' | 'euclidean';

export interface EconomyTuning {
  alpha: number;        // 预期滚动平滑率（EWA：新预期 = (1-α)·旧 + α·实际）
  goodMul: number;      // 产出 ≥ 预期 × 此值 = 超预期
  badMul: number;       // 产出 ≤ 预期 × 此值 = 失望
  moodGood: number;     // 超预期心情增量
  moodBad: number;      // 失望心情减量
  expectBase: number;   // 预期收益基准（权重调制参照：预期 ≥ 基准 → 该工作权重升）
  expectMul: number;    // 预期收益权重倍率上限（× (1 + (预期-基准)/基准 × expectMul)）
}

export interface TechTuning {
  poolInterval: number; // 科技抽卡间隔（秒）：独立池每轮抽一次
  poolChance: number;   // 每轮抽出概率（留空档，渐进）
}

export interface PathTuning {
  pathCd: number;         // 寻路节流（秒）：小人两次寻路最小间隔（防每帧重寻路风暴）
  maxIter: number;        // A* 迭代上限（防爆）：无篝火中转时的基准上限
  waypointMaxIter: number; // 有篝火中转时可放宽的上限（航点路径段短、质量好）
  maxWaypoints: number;   // 参与中转的篝火/锚点数量上限（防全图扫描）
  waypointRadius: number; // 锚点中转范围上限（起点/终点距锚点超此值不中转）
  darkCost: number;  // 未照亮格代价倍率（倾向走篝火照明路）
  heuristic: HeuristicId; // 启发式策略（chebyshev 对角/ manhattan / euclidean）
}

export interface CardTuning {
  commandCooldown: number; // 玩家命令后不自动决策秒数
  oracleGoalMul: number;   // 神谕目标对应工作系列权重倍率（神谕引导强度）
  defyCd: number;          // 违抗冷却
  defyLazy: number;        // 懒惰违抗基础概率
  defyMoodLow: number;     // 心情差违抗加成
  defyMoodAt: number;      // 心情阈值
  faithReducePerFaith: number; // 信仰降低违抗
  eatAmount: number;       // 进食补充量
  eatAmountUrgent: number;
  restAmount: number;
  restAmountUrgent: number;
  eatCost: number;         // 一次进食消耗的食物
  drawCount: number;       // 每次抽卡张数
  guaranteedBase: number;  // 基础卡保底张数
  desireHungerAt: number;  // 欲望驱动：满足度缺口 > 此值(占100) → 权重升
  desireDriveDiv: number;  // 欲望驱动公式分母（1 + hunger/此值）
  jobCardMul: number;      // 指派职业：主导工作卡权重倍率
  jobOthersMul: number;    // 指派职业：其他工作卡权重倍率
  envWorkRainMul: number;  // 环境调制：下雨户外工作倍率
  envWorkExtremeMul: number; // 环境调制：酷暑/严寒户外工作倍率
  envLeisureRainMul: number; // 环境调制：下雨娱乐倍率
  envPhysioExtremeMul: number; // 环境调制：极端天气生理卡倍率
  lean: LeanParams;        // 行为结果学习（EWA 吸引模型）：见 core/lean.ts
  priority: PriorityRule[]; // 派系工作优先级规则（数据驱动：短缺资源 → 对应工作卡权重提高）
}

export interface LeanParams {
  learnRate: number;   // 学习率 φ
  temperature: number; // 温度 β
  minMul: number;      // 权重倍率下限
  maxMul: number;      // 权重倍率上限
  maxA: number;        // 吸引力钳制
}

export interface PriorityRule {
  cardId: string;          // 受影响的工作卡 id（factionPriority 的 key）
  resource: 'food' | 'wood' | 'ore' | 'queue'; // 'queue' = 用 buildQueue 长度
  lowAt: number;           // 库存低于此值 → boost
  boost: number;           // 短缺时权重倍率
  urgentAt?: number;       // 库存低于此值 → urgentBoost
  urgentBoost?: number;
  flowAt?: number;         // 经济账本：资源净支出率（spend/earn）≥ 此值 → boost（账本优先）
}

export interface EventTuning {
  interval: number;        // 事件 roll 基础间隔
  intervalJitter: number;  // 间隔随机抖动上限
  wandererMood: number;    // 流浪者加入心情
  wandererRingMin: number; // 流浪者生成环半径
  wandererRingMax: number;
  bountyFood: number;      // 丰收食物量
  oreFind: number;         // 发现矿脉矿石量
  plagueHpDmg: number;     // 瘟疫伤害
  plagueHpFloor: number;   // 瘟疫 HP 下限
  plagueMood: number;      // 瘟疫心情
  merchantWood: number;    // 游商交换量
  merchantFood: number;
  moodBoost: number;       // 庆典心情
  wildCampAttempts: number; // 野生营地刷新尝试次数
  wildCampRingMin: number; // 野生营地距主营地半径下限
  wildCampRingRand: number; // 野生营地半径随机区间
  eventCap: number;        // 事件资源量钳制上限
  wandererFoodAt: number;  // 流浪者条件：余粮阈值
  plagueMinPawns: number;  // 瘟疫条件：最少人数
  merchantGoodsAt: number; // 游商条件：物资阈值
  moodBoostAt: number;     // 庆典条件：平均心情阈值
  llmResourceBound: number; // LLM 事件资源效果幅度上限
  llmMoodBound: number;    // LLM 事件心情/HP 效果幅度上限
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
  craft: CraftTuning;
  repair: RepairTuning;
  autobuild: AutobuildTuning;
  env: EnvTuning;
  pawn: PawnTuning;
  world: WorldTuning;
  event: EventTuning;
  card: CardTuning;
  path: PathTuning; // 寻路策略表（参数数据化，算法本体保留 A* 代码）
  tech: TechTuning; // 科技抽卡池
  economy: EconomyTuning; // 个人经济预期（赚/花心理账本）
}

// 默认平衡基线（全系统唯一数值源头；mod 经 ModRegistry.overrideTuning 部分覆盖，见 docs/DATA_DRIVEN.md §3.4）
export const TUNING: TuningConfig = {
  needs: {
    initFood: 80,
    initRest: 90,
    initMood: 60,
    initSan: 100,
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
    auraScanRadius: 6,
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
    crazyFleeAfter: 60,
    powResistMid: 40,        // POW ≥ 此值开始抗压
    powResistScale: 100,
    shockDistFloor: 0.4,     // 死亡冲击距离衰减下限
    resistFloor: 0.4,        // POW 抵抗下限（再弱也有 40% 承受力）
    crazyWanderRange: 6,
    crazyWanderAttempts: 8,
  },
  gather: {
    toolBonus: 1.3,
    strBonusPerPoint: 0.01,
    strBase: 40,
    carryBase: 4,
    carryPerSiz: 0.5,
    caveMoodWin: 2,
    caveMoodLose: -2,
    mineMoodWin: 3,
    mineMoodLose: -4,
    chopMoodWin: 2,
    chopMoodLose: -3,
    harvestInterval: 4,
    harvestDc: 70,
    harvestSkill: 'work',
    harvestYield: 2,
    harvestFailYield: 1,
    harvestItem: 'ore',
    harvestTime: 3,
    chopTime: 2.5,
    chopDc: 55,
    chopSkill: 'work',
    chopYield: 5,
    chopFailYield: 2,
    chopItem: 'wood',
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
    oracleMoodHalfDiv: 2,    // 神谕即时心情 = 基数/2 × 信任
    oracleFaith: 3,
    oracleTrustAt: 0.3,
  },
  combat: {
    raidEnemy: 'wolf',
    unitRaidEnemy: 'raider',
    wolfSpeed: 3.5,
    wolfLootItem: 'ore',
    wolfLootAmount: 2,
    pawnDmg: 8,
    initialRaidDelay: 90,
    baseInterval: 75,
    pressureCap: 2,
    pressureScale: 3,
    raidCountBase: 2,
    raidCountPerPawn: 0.35,
    meleeRange: 5,
    buildingDmg: 6,   // 建筑抗拆：篝火 80HP ≈ 13s 拆（原 15/s 五秒拆火 → 无火 SAN 崩 → 死亡循环）
    buildingRadius: 6,
    minDodge: 0.05,
    dodgeBase: 30,
    dodgePerPoint: 0.01,
  },
  social: {
    tickInterval: 2,         // 全系统社交节流
    lustFulfillPerInteract: 1, // 色欲满足：一次成功社交互动 +1
    gossipTtl: 60,           // 话题传播有效期：听到后 60s 内可转述
    gossipChance: 0.7,       // 互动聊起听到话题的概率
    meetDist: 1.6,           // 相遇距离
    interactCdMin: 15,
    interactCdMax: 25,
    friendAt: 40,
    hostileAt: -20,
    punchChanceBase: 0.08,
    punchChancePerHostility: 0.004,
    punchChanceMin: 0.08,
    punchChanceMax: 0.4,
    punchDmg: 8,
    punchRelLoss: 10,        // 动手后好感损失
    punchRelFloor: -50,      // 动手后好感钳制下限
    punchMoodWin: 3,
    punchMoodLose: -5,
    moodFriend: 0.5,
    moodHostile: -0.5,
    relDeltaPositive: 3,
    relDeltaNegative: -4,
    relDeltaNeutral: 1,
    relFloor: -50,           // 好感钳制下限
    relCap: 100,             // 好感钳制上限
    moodPositive: 1,
    moodNegative: -2,
    charmBase: 30,           // 魅力 = (APP - 此值)/div
    charmDiv: 100,
    toneHighAt: 65,          // 双方心情都 > 此值
    toneLowAt: 25,           // 任一心情 < 此值
    tonePosChance: 0.7,
    toneNegChance: 0.7,
    toneNeutralChance: 0.5,
    logChance: 0.4,          // 中性互动写日志概率
    preachChance: 0.25,
    preachFaithAt: 30,
    preachSucceedFaith: 4,
    preachAppDiv: 2,         // 传教 ATT = APP/div + faith/div
    preachFaithDiv: 2,
    preachResistFaith: 0.4,  // 守方信仰抵抗系数
    preachSelfFaith: 1,      // 成功传教者自身信仰 + 此值
    preachFailRel: -5,
    preachSucceedRel: 6,
    preachFailMood: -2,      // 传教失败心情
  },
  desire: {
    initMin: 50,             // 欲望初始满足度
    initRange: 25,
    sinInitMin: 0.2,         // 罪孽先天倾向初始
    sinInitRange: 0.5,
    sinFloor: 0.1,           // 罪孽倾向下限
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
    powResistBase: 0.3,
    powResistMid: 40,        // POW 抗恶意：POW ≥ 此值开始减抗
    powResistScale: 100,
    stealThreshold: 10,
    stealAmount: 5,
    fulfillGluttony: 12,     // 进食卡对暴食的满足量
    fulfillSloth: 10,        // 休息卡对懒惰的满足量
    fulfillWrath: 8,         // 暴怒发泄满足量
    wrathSmashDmg: 10,       // 砸建筑伤害
    wrathSpinMood: 5,        // 原地转圈心情
    lustMood: -2,            // 色欲/嫉妒/傲慢匮乏心情
    envyFulfillPerWork: 2,   // 嫉妒满足：完成一次劳动 +2（存在更强同伴时）
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
    priorityTimer: 10,
    upgradeNearDist: 4,      // 附近多少格内的篝火单位可升级为教堂
    unitStartResources: { wood: 30, ore: 5, food: 25, tools: 0 },
    trustMeetDist: 4,        // 跨单位成员协作相遇距离
    unitCapChurch: 10,
    unitCapCampfire: 3,
    unitReassignMargin: 10,  // 成员归属切换门槛：新单位比旧归属明显更近（格）才切换
    //（防开局假团灭 + 防误伤：小人日常工作走开 10 格 + 邻居营地建成 → 不能算迁徙；
    //  必须 > autobuild 营间距上限（spotRingMax 6）的平方差；真迁徙者站在新营地旁必切）
    opinionMsgFriendly: 1,   // 友善传话看法增量
    tradeFoodScarceAt: 40,   // 缺粮判定库存阈值
  },
  population: {
    maxPawns: 12,
    recruitInterval: 45,
    foodThreshold: 60,
    recruitRetryAfter: 30,
    startStockpile: { wood: 50, ore: 0, food: 30, tools: 0 },
    spawnRingMin: 2,
    spawnRingMax: 6,
  },
  craft: {
    costFallback: 5,
    outputFallback: 1,
    intervalFallback: 6,
  },
  repair: {
    workTime: 1.5,
    repairAmount: 20,
    searchRadius: 15,
    inPlaceDist: 1.5,        // 原地直接修理距离
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
    churchTarget: 1,         // 教堂目标数
    farmWood: 12,
    workbenchWood: 20,
    caveWood: 15,
    churchWood: 25,
    wallWood: 60,
    wallTarget: 6,
    spotRingMin: 2,          // 找建造位环半径
    spotRingMax: 6,
    spotAttempts: 12,
    costWoodPerCell: 2,      // 建筑缺省成本：size²×此值
    costWoodFallback: 1,
    costOreFallback: 0,
    starterBuilding: 'campfire',
    fallbackBuilding: 'wall',
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
    dayLength: 120,          // 一天秒数
    nightStart: 0.72,
    nightEnd: 0.22,
  },
  pawn: {
    baseSpeed: 4,
    hpBase: 40,
    scanRadius: 15,
    farScanRadius: 36, // 与 maxWorkDist 一致：远扫的目标超距会被拒，避免白扫
    maxWorkDist: 36,
    attrMin: 30,             // 八属性生成区间
    attrMax: 70,
    traitCountMin: 1,        // 天赋数量
    traitCountMax: 3,
    maxSlotsMin: 2,          // 卡槽基础数
    maxSlotsRand: 2,         // 卡槽随机增量
    moodSpeedBase: 0.6,      // 移动速度心情系数
    moodSpeedScale: 0.6,
    skillIntFrom: 30,        // 技能初始公式（INT/EDU 基准与除数）
    skillIntDiv: 4,
    skillEduFrom: 30,
    skillEduDiv: 8,
    skillInit: { work: 20, fight: 15, craft: 15, social: 10, faith: 10 },
    intBonusFrom: 50,        // 检定 INT 加成
    intBonusDiv: 10,
    skillBonusFrom: 10,      // 检定技能加成
    skillBonusDiv: 10,
  },
  world: {
    spawnClearRadius: 3,     // 出生点清场半径（7x7）
    spawnTries: 24,          // 资源撒布尝试次数
    spawnDistMin: 3,         // 撒布距离环
    spawnDistRand: 5,
    spawnCounts: { tree: 4, ore: 3, stone: 3 },
  },
  tech: {
    poolInterval: 120, // 科技独立抽卡池：每 120s 抽一轮
    poolChance: 0.6,   // 60% 抽出（"往后抽卡"渐进解锁）
  },
  economy: {
    alpha: 0.15,   // 预期平滑：单次产出/消费对预期的权重
    goodMul: 1.2,  // 赚 ≥ 预期×1.2 → 满足
    badMul: 0.5,   // 赚 ≤ 预期×0.5 → 失望
    moodGood: 3,
    moodBad: -3,
    expectBase: 5, // 预期收益基准（基准 5 木/次左右）
    expectMul: 1.0,// 预期驱动：预期 ≥ 基准 → 权重 +（预期-基准）/基准 × mul
  },
  path: {
    pathCd: 0.5,            // 寻路节流：0.5s 内不重复寻路（寻路风暴修复）
    maxIter: 15000,         // 无篝火中转：迭代上限（防爆；锚点少时路径短，够用）
    waypointMaxIter: 40000, // 有篝火中转：放宽（航点分段短，允许探更多格）
    maxWaypoints: 8,        // 参与中转的锚点数量上限
    waypointRadius: 60,     // 锚点中转范围上限
    darkCost: 3,            // 未照亮格代价倍率（倾向走篝火照明路）
    heuristic: 'chebyshev', // 启发式策略（chebyshev 对角/ manhattan / euclidean）
  },
  event: {
    interval: 45,
    intervalJitter: 30,
    wandererMood: 10,        // 流浪者加入心情
    wandererRingMin: 4,      // 流浪者生成环半径
    wandererRingMax: 8,
    bountyFood: 20,          // 丰收食物量
    oreFind: 15,             // 发现矿脉矿石量
    plagueHpDmg: 15,         // 瘟疫伤害
    plagueHpFloor: 10,       // 瘟疫 HP 下限
    plagueMood: -5,          // 瘟疫心情
    merchantWood: 10,        // 游商交换量
    merchantFood: 10,
    moodBoost: 8,            // 庆典心情
    wildCampAttempts: 40,    // 野生营地刷新尝试次数
    wildCampRingMin: 20,     // 野生营地距主营地半径
    wildCampRingRand: 20,
    llmResourceBound: 20,    // LLM 事件资源效果幅度上限
    llmMoodBound: 10,        // LLM 事件心情/HP 幅度上限
    eventCap: 500,           // 事件资源量钳制上限
    wandererFoodAt: 10,      // 流浪者条件：余粮阈值
    plagueMinPawns: 3,       // 瘟疫条件：最少人数
    merchantGoodsAt: 5,      // 游商条件：物资阈值
    moodBoostAt: 55,         // 庆典条件：平均心情阈值
  },
  card: {
    commandCooldown: 3,
    oracleGoalMul: 3,
    defyCd: 30,
    defyLazy: 0.25,
    defyMoodLow: 0.3,
    defyMoodAt: 20,
    faithReducePerFaith: 0.005,
    // 行为结果学习（EWA 吸引模型，docs/DATA_DRIVEN.md §3.4）：φ/β/钳制全数据驱动
    lean: {
      learnRate: 0.2,      // 学习率 φ；大=反应快（多疑善变），小=记性好（顽固守旧）
      temperature: 1.0,    // 温度 β；大=收益差急剧放大权重，小=平滑
      minMul: 0.2,         // 权重倍率下限（失败再多也不绝迹，总留一丝可能）
      maxMul: 5,           // 权重倍率上限（上限封顶防单一化）
      maxA: 3,             // 吸引力钳制（3 个单位 scale 的记忆上限）
    },
    eatAmount: 40,
    eatAmountUrgent: 50,
    restAmount: 40,
    restAmountUrgent: 40,
    eatCost: 1,              // 一次进食消耗食物
    drawCount: 3,            // 每次抽卡张数
    guaranteedBase: 3,       // 基础卡保底张数
    desireHungerAt: 40,      // 欲望缺口 > 此值 → 权重升
    desireDriveDiv: 100,
    jobCardMul: 6,           // 指派职业主导卡倍率
    jobOthersMul: 0.1,       // 指派职业其他卡倍率
    envWorkRainMul: 0.5,
    envWorkExtremeMul: 0.6,
    envLeisureRainMul: 1.6,
    envPhysioExtremeMul: 1.3,
    priority: [
      { cardId: 'farm', resource: 'food', lowAt: 60, boost: 1.6, urgentAt: 20, urgentBoost: 2.4, flowAt: 1.2 },
      { cardId: 'chop', resource: 'wood', lowAt: 40, boost: 1.5, flowAt: 1.2 },
      { cardId: 'mine', resource: 'ore', lowAt: 15, boost: 1.4, flowAt: 1.2 },
      { cardId: 'caveMine', resource: 'ore', lowAt: 15, boost: 1.4, flowAt: 1.2 },
      { cardId: 'build', resource: 'queue', lowAt: 0, boost: 1.8 },
    ],
  },
};
