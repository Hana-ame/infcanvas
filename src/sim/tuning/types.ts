/**
 * types.ts —— §1+§2 全部 interface（从 tuning.ts 提取，纯类型定义，零运行时依赖）。
 *
 * 调用方：import type { Tuning } from './tuning'（通过 index.ts re-export）。
 * 本文件不导出任何运行时值。
 */

// ===== §1 条目接口 =====

export interface TileTuningEntry {
  name: string;
  /** 液体（水面）：不可立足，无论 z 与攀爬 */
  liquid?: boolean;
}

export interface BuildingTuningEntry {
  name: string;
  cost: Record<string, number>; // 造价：<资源键, 数量>（资源键见 contracts.ts K_STOCK_*）
  hp: number;
  tags: string[]; // 功能标签（K_TAG_*），供跨包查询（取暖/庇护/锚点）
  passable: boolean; // 是否阻挡通行（棚屋阻挡、篝火不阻挡）
  /** 占地 w×h 格（pos 为左上角；缺省 1×1）。多格建筑整体落子/拆除/阻挡 */
  w?: number;
  h?: number;
  /** 维护燃料：每 fuelSec 秒消耗一份 wood；断薪时建筑熄灭移除。
   *  缺省=免维护。语义：篝火是与寻路组合的营地核心，需要持续投入形成
   *  木料经济闭环（2026-08-21 用户裁定加维护成本）。 */
  fuelSec?: number;
  /**
   * 科技门控（R2-1，2026-08-21 追加）：本建筑需要先解锁的科技 id（tuning.techs 表键）。
   * 缺省 = 无门控（开局就能造）。**门控不是"直控解锁"**——解锁权只属于科技抽卡池
   * （tech-pool 包发碎片，玩家碰不到）；这里只是消费端读表判断。
   * 语义：空数组 = 科技表里没有任何科技（tech-pool 包未挂）→ 一律放行，
   * 保证"卸载科技包 = 永无科技但核心照跑"（卸载不破坏核心纪律）。
   */
  tech?: string[];
}

/**
 * 科技条目（R2-1）：抽卡池候选 + 建筑门控查表键。纯数据，无逻辑。
 * order = 抽卡权重位（0 最靠前）；fragments = 攒齐所需碎片数。
 */
export interface TechTuningEntry {
  name: string;      // 科技名（HUD 面板与事件文案）
  fragments: number; // 攒齐所需碎片数（≥1）
  order: number;     // TECH_ORDER 位次（0 = 权重最高）
  unlocks: string[]; // 该科技解锁的建筑 defId（信息登记，门控看 BuildingTuningEntry.tech）
  /**
   * 科技解锁后对卡牌权重的乘数调制（series → mul）。
   * 与 traits 的 seriesMul 同构：解锁 = "技能提升"，让该系列卡更常抽中。
   * 不填或空表 = 纯进度标记（无权重影响）。
   */
  cardSeriesMul?: Record<string, number>;
}

export interface EnemyTuningEntry {
  name: string;
  hp: number;
  dmg: number;
  speed: number; // 格/秒
  atkCd: number; // 攻击间隔秒
  /** 攀爬：可跨越的高度差（缺省 1）。猫会爬岩层追猎 */
  climb?: number;
  /**
   * 掉落表（R3-3 狩猎，2026-10-07）：`<资源键, 份数>`，死亡时写入 `ctx.stockpile`。
   *
   * 为什么进内核而不是 hunting 包自己记账：掉落是**世界事实**（随档、进协议、
   * 离线也成立），不是行为规则——把它做成"拾取卡"需要尸体实体系统，成本远高于收益。
   * 缺省 undefined = 不掉落，**行为与改动前完全一致**（golden 基线不动）。
   * 键必须是 contracts.ts 的 K_STOCK_* 常量（跨包词汇）。
   */
  drops?: Record<string, number>;
  /**
   * 被动动物（R3-3）：不主动追猎鼠，受击才反应（hunting 包自己的系统驱动其逃跑）。
   * raid 包的 tickCats 会跳过 `passive` 敌人——否则猫的追猎逻辑会把兔子也变成猎手。
   * 缺省 undefined = false = 掠食者（原有行为）。
   */
  passive?: boolean;
  /**
   * 主动索敌半径倍率（R3-3，缺省 1）：raid/hunting 包按 `leashRadius × aggro` 判索敌。
   * >1 = 更主动（狼群），<1 = 更迟钝（石壳兽）。数值语义归调用方，内核只存数。
   */
  aggro?: number;
}

// ===== §2 Tuning 接口：按玩法域分节（域顺序 = §3 DEFAULT_TUNING 的键顺序）=====

export interface Tuning {
  world: {
    /**
     * 分形海拔场 E(x,y) ∈ 0..1 驱动两个独立维度：
     *   z = floor(E × (maxZ+1))，每格独立高度（与地形类型解耦）
     *   地形类型 = 水位线 + 岩斑噪声 + 碎土撒点（E 只用于水位判定）
     */
    maxZ: number; // 最大海拔层级
    waterLevel: number; // E 低于此值 → 水
    stoneLevel: number; // 岩斑噪声阈值
    stoneCell: number;
    elevCells: number[]; // 分形海拔八度晶格尺寸
    elevWeights: number[]; // 对应权重
    dirtChance: number;
    /** 特征：树为 2×2 树冠、阻挡通行；浆果丛 1×1 可穿行。
     *  林地密度场：moisture 噪声高的区域树锚点率乘 groveBoost——成片森林而非均匀撒点 */
    treeRate: number; // 基准通过率
    groveBoost: number; // 密集林地倍率上限（moisture 高处）
    moistCell: number; // moisture 晶格尺寸
    treeSize: number;
    berryRate: number;
    berryAmountMin: number;
    berryAmountMax: number;
    /** 出生安全区半径：区内不出水/石/特征，保证开局闭环不被地形卡死 */
    spawnClearRadius: number;
    /** 特征采集后的再生冷却秒（无限地图 tile 只读 → 用冷却集合表达"被采空"） */
    harvestRegenSec: number;
  };
  pawn: {
    speed: number; // 格/秒
    /** 攀爬：可跨越的地形高差（草地 0 / 岩层 2 → 缺省 1 上不去岩层，猫可以） */
    climb: number;
    hp: number;
    /** 卡持续时间缺省值（秒）：到期重新抽卡。各卡可覆盖 */
    defaultCardSec: number;
    /** 熟练度演化：触发 +gain（上限 100），未触碰按 decayPerSec 惰性衰减（下限 0）。
     *  权重 ×(0.5 + mastery/100) —— 卡 = 习惯的建模 */
    masteryGain: number;
    masteryDecayPerSec: number;
    /** 近战攻击间隔秒与基础伤害（迎战卡用；strong 特质在此之上乘系数） */
    atkCd: number;
    dmg: number;
    traitDmgMul: Record<string, number>; // 特质 → 伤害系数
  };
  needs: {
    // 每秒衰减速率。食物最紧（约 8 分钟从满到空），睡眠次之，心情/理智缓慢
    foodDecay: number;
    restDecay: number;
    moodDecay: number;
    sanDecay: number;
    eatFoodGain: number;   // 吃一次恢复的食欲
    eatMoodGain: number;
    sleepRestNearFire: number; // 火旁每秒回睡眠
    sleepRestWild: number;     // 野外打盹每秒回睡眠（慢）
    sleepSanNearFire: number;  // 火旁每秒回理智（火=安全感）
    /** 睡觉卡的磁铁半径（格）：火堆在此半径内**值得为之走过去**再睡。 */
    sleepMagnetRadius: number;
  };
  build: {
    /** 同类建筑最小间距（格）：涌现式疏散，不做硬性数量上限 */
    minSpacing: number;
    searchRadius: number; // 找可建格的搜索半径
    /** 分设新火堆的三门槛：身边 18 格无火 + 至少 2 只鼠离所有火超过 12 格。 */
    newFireRadius: number;
    spreadRadius: number;
    spreadMice: number;
    hutRatio: number; // 棚屋/人口刚需比例（不够住才盖，不是有木就盖）
    storeRatio: number; // 仓库/人口比例
    storeFoodDecayMul: number; // 仓库食物保鲜乘数（<1 = 更慢）
    maxForageDist: number; // 采集射程
  };
  gathering: {
    senseRadius: number; // 采集感知半径（比出生安全区略大，逼鼠群走出去）
  };
  farming: {
    searchRadius: number;
    fieldRatio: number;
    growSec: number;
    yieldFood: number;
    workRadius: number;
    magnetRadius: number;
    hungryBelow: number;
    hungryWeightMul: number;
  };
  cooking: {
    cookRawCost: number;
    cookYield: number;
    eatCookedFoodGain: number;
    magnetRadius: number;
    workRadius: number;
    cookRawMaxStock: number;
    cookSec: number;
    rawStockMin: number;
    cookWeightNearFire: number;
  };
  medicine: {
    woundedBelow: number;
    healPerSec: number;
    bedBonus: number;
    bedWorkRadius: number;
    herbCost: number;
    healWorkRadius: number;
    healMagnetRadius: number;
    naturalHealPerSec: number;
    healWeightWounded: number;
    healRequireHerb: number;
    restWeightWounded: number;
    bedSearchRadius: number;
    bedRatio: number;
  };
  social: {
    chatRadius: number;
    approachRadius: number;
    chatMoodGain: number;
    chatRelGain: number;
    affinityDenom: number;
    quarrelChance: number;
    lowMoodQuarrelAt: number;
    quarrelMoodHit: number;
    quarrelRelHit: number;
  };
  raid: {
    kind: string;
    pressurePerSec: number;
    pressureThreshold: number;
    spawnDistMin: number;
    spawnDistMax: number;
    leashRadius: number;
    attackRange: number;
    senseRadius: number;
    fleeHpRatio: number;
    threatWorkMul: number;
  };
  hunting: {
    meatGain: number;
    huntSenseRadius: number;
    huntMagnetRadius: number;
    huntWorkRadius: number;
    spawnIntervalSec: number;
    spawnRadius: number;
    maxAnimals: number;
    leaveRadius: number;
    wanderStepMin: number;
    wanderStepMax: number;
    fleeRadius: number;
  };
  combat: {
    attackRange: number;
    defendMagnetRadius: number;
    holdRadius: number;
    focusMul: number;
    flankMul: number;
    flankOffset: number;
    rallySenseRadius: number;
    rallyMinEnemies: number;
    defendMulMultiEnemy: number;
    multiEnemyThreshold: number;
  };
  env: {
    dayLengthSec: number;
    baseTemp: number;
    nightOffset: number;
    coldThreshold: number;
    hotThreshold: number;
    warmRadius: number;
    weatherCycleSec: number;
    rainChance: number;
    rainFoodDecayMul: number;
    rainWorkMul: number;
    freezeDmgPerSec: number;
    heatDmgPerSec: number;
    coldRestBand: number;
    coldRestMul: number;
    hotRestMul: number;
  };
  factions: {
    repInit: number;
    friendlyThresh: number;
    hostileThresh: number;
    tradeRatio: number;
    tradeMagnetRadius: number;
    tradeWorkRadius: number;
    tradeWoodCost: number;
    checkSec: number;
    repGainTrade: number;
    repLossRaid: number;
    repMeanRev: number;
    repDriftMag: number;
    gossipDecayPerSec: number;
    gossipPerRaid: number;
    socialPenalty: number;
    maxRaiderWave: number;
    raidCooldownSec: number;
    spawnRadius: number;
  };
  fortify: {
    trapDmgPerSec: number;
    trapHitRadius: number;
    wallMinGap: number;
    trapDurabilitySec: number;
  };
  techs: Record<string, TechTuningEntry>;
  techPool: {
    intervalSec: number;
    chance: number;
  };
  bootstrap: {
    pawnCount: number;
  };
  events: {
    maxLog: number;
    checkSec: number;
    cooldownSec: number;
    thresholds: {
      harvestFoodBelow: number;
      coldsnapMinPawns: number;
      plagueMinPawns: number;
      strangerFoodAbove: number;
      festivalFoodAbove: number;
      fecundFoodAbove: number;
    };
  };
  tiles: Record<string, TileTuningEntry>;
  buildings: Record<string, BuildingTuningEntry>;
  enemies: Record<string, EnemyTuningEntry>;
  traits: Record<string, { name: string; seriesMul?: Record<string, number> }>;
}
