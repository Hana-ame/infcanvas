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
  /**
   * farming —— 农耕包数值（ROADMAP R3-2）。出厂值是**保守基线**：
   * 农耕的定位是"采不到野果时的第二口粮"，不是替代采集——
   * 一茬 yieldFood(3) ≈ 一丛浆果全采(3~5)，刻意不让它碾压野果线。
   */
  farming: {
    /** 农田建造搜索半径（格）：必须大于 build.minSpacing，否则内核同类间距判定
     *  会让第二块田永远放不下（田=1×1 密植物，包内靠 addBuilding 逐候选试位绕开） */
    searchRadius: number;
    /** 农田/人口比例：每 N 只鼠保有 1 块田（田太多=产量过剩野果线崩塌，太少=总饿死） */
    fieldRatio: number;
    /** 生长冷却（秒）：播种 → 到期可收。**世界自转，不需要人在场**——
     *  这是"作物生长=地块冷却的变体"的落点：与 world.harvestCd 同构，但走包私有表 */
    growSec: number;
    /** 单块田收获食物份数（每次收一整茬，不是每 tick 一份） */
    yieldFood: number;
    /** 找得到可耕格的搜索半径（格）：找田时环扫的上限 */
    senseRadius: number;
    /** 饥饿低于此值时 farm 系列权重放大倍数（涌现点：没播种就饿肚子，饿才想去种地） */
    hungryBelow: number;
    hungryWeightMul: number;
  };
  social: {
    chatRadius: number;
    /** 磁铁半径：同伴在此半径内**看得见**，闲聊卡才可能被抽上。
     *  与 chatRadius 的区别是语义：chatRadius = 开口说话的贴身距离，
     *  approachRadius = 愿意为之走过去看一眼的距离。**两者必须同时作用于同一张卡**，
     *  否则会出现「看得见却永远到不了」的空转——这正是本轮修掉的缺陷，见 social.ts 头部。 */
    approachRadius: number;
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
    /** 遇敌时非战斗卡的权重乘数（<1 让"正在伐木"不再压过战或逃；依据见默认值处证据段） */
    threatWorkMul: number;
  };
  /**
   * techs —— 科技抽卡池数据表（R2-1，2026-08-21 追加：ROADMAP「科技 = 独立抽卡池，碎片制」）。
   *
   * 为什么进表而不是硬编码（原则③）：科技条目既是抽卡池的**候选集合**，又是建筑门控的
   * **查表键**，两个消费方都必须能读到同一份事实；mod 追加科技 = 往这张表加条目。
   *
   * 字段语义：
   *  - fragments：解锁该科技所需碎片数（碎片制——抽卡池每次只发一块碎片，不是直发整卡）。
   *  - order：抽卡池顺序位（0 = 最靠前 = 权重最高 = 最先攒齐），线性递减见 tech-pool 包。
   *  - unlocks：本科技解锁的建筑 defId 列表（信息性登记，门控以建筑自身 tech 字段为准）。
   */
  techs: Record<string, TechTuningEntry>;
  /** 科技抽卡池自身的节奏参数（tech-pool 包消费） */
  techPool: {
    /** 发碎片间隔（秒）：每隔这么久抽一次科技池 */
    intervalSec: number;
    /** 每次抽池真正发出碎片的概率（0..1）：其余轮次空转，制造"科技不来"的节奏感 */
    chance: number;
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
  farming: {
    // 搜索半径必须 > build.minSpacing(5)：内核 addBuilding 对同类建筑套全局间距，
    // 田又是 1×1 密植物，半径不够大就永远只开得出第一块田（第二块必被间距拒）。
    searchRadius: 8,   // 农田在营地旁就地找格（太小推不开，太大会圈水）
    fieldRatio: 2,     // 2 只鼠 1 块田：产出当口粮而非主粮，比例高了会淹没采集线
    growSec: 120,      // 一茬 2 分钟：比一轮采集周期略长，逼出"种了就要等"的规划感
    yieldFood: 3,      // 一茬 3 份 ≈ 一丛浆果全采（3~5）：不碾压野果线
    senseRadius: 12,   // 找田感知半径：与营地散布半径同量级
    hungryBelow: 45,   // 饥饿线（与 needs 包的 f<55 档重叠但更低——种植更"重决策"）
    hungryWeightMul: 2.2,
  },
  social: {
    chatRadius: 2.5,
    // 磁铁半径 26：实测鼠群两两距离平均 46.4 / 中位 40.2 格，≤2.5 的只有 1.1%，
    // ⇒ 闲聊卡 condition 常年 false（失败率 97.0%），社交事实上是死代码。
    // 取 26 = 略低于中位距离的一半，保证「总有一只同伴在磁铁圈内」但不遍地搭话。
    approachRadius: 26,
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
    /**
     * 遇敌时非战斗卡的权重压制（2026-10-06 平衡实测定位）。
     *
     * 现象（12 seed × 900s 实测）：平均存活 2.75/4，12 个 seed 里 5 个低于
     * 门槛 3；全部死因都是野猫，**没有一例是饿死**（最低库存 🍎592，远高于需求）。
     *
     * 根因（不是数值不够大，是**反应链条断了**，实测证据）：
     * 436 个"鼠被咬"的 tick 里，**388 个（89%）鼠正在抽普通工作卡**
     * （gather_berry 160 / chop_tree 160 / sleep 25 / sow_field 9…），
     * 只有 61 个在抽战斗卡。原因是节奏不对：
     *   - 工作卡 duration 6~8s（gathering.ts），一次抽签要执行完才重抽；
     *   - 猫 3 伤害 / 1.5s ≈ **2 DPS**，于是一个 8s 卡周期里必掉 16 血；
     *   - 而 fight 权重 9 对 chop_tree 10、gather_berry 9 ≈ 三方掷骰，
     *     下次抽到战斗卡的期望还要再等一两个周期。
     * 也就是说：猫已经在咬了，鼠还在**把这一卡伐完木**。战或逃根本没进入抽签。
     *
     * 为什么用"权重压制"而不是"遇敌立刻打断当前卡"：
     * 红线是「一切皆抽卡」，不能加 if 强插一条硬规则（那是 Work-Tab 式越权）。
     * 压制权重让"遇敌时更可能立刻抽到迎战/撤退"——**结果仍是抽签决定的**，
     * 只是抽签的天平被局势倾斜，符合既有恐惧钩子（按血量倾斜）的同一手法。
     * 旧卡的 duration 不动：让工作卡"做一半被打断"需要内核改抽卡时机，
     * 那会动到全部卡的时间语义，代价远大于收益。
     *
     * 锚点：threatWorkMul=0.18 让遇敌时普通卡只剩 ~1.8 权重，
     * 面对 fight 9 + flee 6 几乎必抽战斗卡——但不是 0，
     * 保留"慌到没反应过来继续干活"的少数情况，战或逃的随机性不被抹平。
     */
    threatWorkMul: 0.35,
  },
  // 科技表**出厂为空**：科技是玩法包种子（同 buildings/enemies 的纪律——内核零玩法内容）。
  // tech-pool 包挂载时 registerTech 注入条目。
  techs: {},
  techPool: {
    // 节奏锚点：约每 120s 抽一次科技池，其中 55% 真的发出一块碎片
    // → 期望 ~218s 一块碎片；首个科技 3 块 ≈ 11 分钟（短于一场 900s 的生存循环，
    // 玩家能看到"科技真的来了"，又不至于开局就通）。
    intervalSec: 120,
    chance: 0.55,
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