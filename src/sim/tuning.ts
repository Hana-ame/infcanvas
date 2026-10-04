/**
 * tuning.ts —— 数据驱动数值总表（原则③：一切数值进表，系统只读，禁止硬编码魔法数字）。
 *
 * 语义：
 *  - DEFAULT_TUNING 是"出厂种子数据"，ModRegistry.overrideTuning 可按路径覆盖（mod/DLC 调参不改内核）。
 *  - 数值单位统一：时间 = 秒（step(dt) 的 dt），距离 = 格，需求/血量 = 0..100。
 *  - 调参依据：保证"0 操作生存闭环"成立——采集产出 > 消耗速率，敌袭强度在
 *    "战或逃都有戏"的区间（全灭太易=没有故事，永无威胁=没有故事）。
 */

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
}

export interface EnemyTuningEntry {
  name: string;
  hp: number;
  dmg: number;
  speed: number; // 格/秒
  atkCd: number; // 攻击间隔秒
  /** 攀爬：可跨越的高度差（缺省 1）。猫会爬岩层追猎 */
  climb?: number;
}

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
  };
  build: {
    /** 同类建筑最小间距（格）：涌现式疏散，不做硬性数量上限 */
    minSpacing: number;
    searchRadius: number; // 找可建格的搜索半径
    /** 分设新火堆的三门槛：身边 18 格无火 + 至少 2 只鼠离所有火超过 12 格。
     *  此前单鼠走远就随手生火 → 火堆铺满地图（2026-08-21 用户反馈） */
    newFireRadius: number;
    spreadRadius: number;
    spreadMice: number;
    hutRatio: number; // 棚屋/人口刚需比例（不够住才盖，不是有木就盖）
    storeRatio: number; // 仓库/人口比例
    maxForageDist: number; // 采集射程
  };
  gathering: {
    senseRadius: number; // 采集感知半径（比出生安全区略大，逼鼠群走出去）
  };
  social: {
    chatRadius: number;
    chatMoodGain: number;
    chatRelGain: number;      // 关系值增量（-100..100）
    quarrelChance: number;    // 口角概率（低心情时闲聊翻脸——事件从局面触发）
    lowMoodQuarrelAt: number; // 心情低于此值才可能口角
    quarrelMoodHit: number;
    quarrelRelHit: number;
  };
  raid: {
    kind: string;             // 敌人表键（tuning.enemies）
    pressurePerSec: number;   // 叙事压力积累速率（压力满 → 来敌；纯局面驱动，无脚本波次）
    pressureThreshold: number;
    spawnDistMin: number;     // 距营地出生环带
    spawnDistMax: number;
    leashRadius: number;      // 敌人索敌半径（之外游荡）
    attackRange: number;
    /** 迎战/逃跑卡的感知半径与恐惧线（血量低于该比例更倾向逃跑） */
    senseRadius: number;
    fleeHpRatio: number;
  };
  bootstrap: {
    pawnCount: number; // 出生引导：开局鼠数（玩法包数据，可被 override）
  };
  events: {
    maxLog: number; // 事件环缓冲上限（防长局内存膨胀）
  };
  tiles: Record<string, TileTuningEntry>;
  /** 建筑/敌人定义不在出厂表里——它们是玩法包的种子数据（registerBuilding/registerEnemy）。
   *  内核数据表保持零玩法内容。 */
  buildings: Record<string, BuildingTuningEntry>;
  enemies: Record<string, EnemyTuningEntry>;
  traits: Record<string, { name: string; seriesMul?: Record<string, number> }>;
}

/** 出厂数值。所有注释即语义来源，mod 可整体或按路径 overrideTuning 覆盖。 */
export const DEFAULT_TUNING: Tuning = {
  world: {
    maxZ: 4,            // 海拔层级 0~4
    waterLevel: 0.33,   // E 低于此值 → 水
    stoneLevel: 0.35,   // 岩斑噪声阈值
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
  },
  pawn: {
    speed: 4.5,
    climb: 1,
    hp: 100,
    defaultCardSec: 4,
    masteryGain: 1.5,
    masteryDecayPerSec: 0.02,
    atkCd: 1.2,
    dmg: 6,
    traitDmgMul: { strong: 1.5 },
  },
  needs: {
    foodDecay: 0.15,
    restDecay: 0.15,
    moodDecay: 0.05,
    sanDecay: 0.03,
    eatFoodGain: 40,
    eatMoodGain: 2,
    sleepRestNearFire: 6,
    sleepRestWild: 3,
    sleepSanNearFire: 1,
  },
  build: {
    minSpacing: 5,
    searchRadius: 6,
    newFireRadius: 24,
    spreadRadius: 16,
    spreadMice: 3,
    /** 棚屋刚需比例：shelters < ceil(pawns × hutRatio) 才允许盖（不然 4 只鼠狂盖 28 座） */
    hutRatio: 0.5,
    storeRatio: 0.25,
    maxForageDist: 30,
    /** 采集射程（格）：离最近火堆超过此距离的特征不作为采集目标。
     *  防止鼠群无限扩散——火堆是活动范围的锚点，新火堆=扩展边疆 */
  },
  gathering: { senseRadius: 10 },
  social: {
    chatRadius: 2.5,
    chatMoodGain: 8,
    chatRelGain: 2,
    quarrelChance: 0.08,
    lowMoodQuarrelAt: 30,
    quarrelMoodHit: 4,
    quarrelRelHit: 3,
  },
  raid: {
    kind: 'cat',
    pressurePerSec: 0.55, // ≈ 每 180s 一波（threshold 100），随局自然推进
    pressureThreshold: 100,
    spawnDistMin: 16,
    spawnDistMax: 24,
    leashRadius: 11,
    attackRange: 1.25,
    senseRadius: 18, // 集结迎敌的感知圈：太小会被各个击破
    fleeHpRatio: 0.6,
  },
  bootstrap: { pawnCount: 4 },
  events: { maxLog: 200 },
  tiles: {
    // z 不在这里——每格独立 z 由分形海拔场量化（world.maxZ 控制上限）
    grass: { name: '草地' },
    dirt: { name: '泥地' },
    hill: { name: '丘陵' }, // 视觉变体：z 1~2 区域渲染为丘陵色
    stone: { name: '岩层' },
    water: { name: '水域', liquid: true },
  },
  buildings: {}, // 玩法包种子：building 包注册 campfire(1×1)/hut(2×2)
  enemies: {}, // 玩法包种子：raid 包注册 cat
  traits: {
    // 特质 = 权重倾向数据，不是行为规则：owl 夜猫子多干活、lazy 懒鬼多休息……
    strong: { name: '壮硕', seriesMul: {} },
    lazy: { name: '懒散', seriesMul: { rest: 1.4, gather: 0.9 } },
    owl: { name: '夜猫子', seriesMul: { wood: 1.2, rest: 0.9 } },
    workaholic: { name: '工作狂', seriesMul: { gather: 1.2, wood: 1.2, rest: 0.8 } },
    cheerful: { name: '乐天派', seriesMul: { social: 1.5 } },
  },
};
