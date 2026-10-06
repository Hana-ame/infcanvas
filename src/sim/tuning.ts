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
    /** 睡觉卡的磁铁半径（格）：火堆在此半径内**值得为之走过去**再睡。
     *
     *  【为什么要有它，缺了它是什么样】2026-10-06 实测（4 seed × 900s，13461 抽样）：
     *  鼠到最近火堆的距离中位数 **12.1 格**，而 needs.sleep 的 action 原来用
     *  **硬编码 8 格**找火，且**找不到就直接睡野外、永不去找**。读数：
     *    · 全局：≤8 格的抽样只有 **23.6%**（≤16 格 = 73.4%，≤24 格 = 93.7%）
     *    · 睡眠卡执行的 573 个 tick 里，火在 8 格内只有 **14.5%**（14.1 格中位），
     *      真正贴到火边（2.5 格）的只有 **12.7%**。
     *  ⇒ **85.5% 的睡眠是"野外打盹"**：sleepRestNearFire(6) / sleepSanNearFire(1)
     *    这两个数值、以及"棚屋旁回心情"那一整条分支，事实上常年享受不到——
     *    不是设计上的"偶尔野外睡"，是**默认状态**。
     *  【与 chat/farming 是同一类缺陷】硬闸/查找半径被当成了"贴身距离"，
     *    但世界里目标的实际距离比贴身距离大一个数量级。修法同样是磁铁范式：
     *    半径放宽到"值得走过去"，走到 2.5 格内才结算火旁数值。
     *  【为什么取 24】≤24 格覆盖 93.7% 的抽样 = 几乎总能找到一个"愿意走过去"的火，
     *    而 24 格 ≈ walking 的常规一卡行程（speed 4.5 格/s，约 5s），
     *    不制造超长跋涉；与 build.newFireRadius(24) 同量级，语义都是"营地的势力范围"。 */
    sleepMagnetRadius: number;
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
    /** 到位半径（格）：播种/收割的"已经站在田边"判定（**不是**候选池半径）。
     *  语义 = 站到田里/田边就算翻土/拔谷的伸手范围。 */
    workRadius: number;
    /** 找田的候选池半径（格）：田在此半径内**看得见**，播种/收割卡才可能被抽上。
     *
     *  【为什么必须与 workRadius 拆开，缺了它是什么样】2026-10-06 实测
     *  （4 seed × 900s，13461 抽样）：**熟田存在**于 79.7% 的抽样里，但
     *  「到最近熟田的距离」中位数 **31.0 格**、≤12 格的只有 **18.2%**。
     *  原实现让 condition（候选池）与到位判定**共用一个 senseRadius=12**
     *  —— 于是「世界里明明有熟田，鼠却永远抽不到收割卡」。这与 social 闲聊卡
     *  是同一个缺陷的两种形态：**硬闸半径 = 贴身距离**，而目标实际距离比
     *  贴身距离大一个数量级 ⇒ 卡沦为死代码（收割卡 900s 只被抽中 48 次）。
     *  【走路的那一半本来就写对了】`sow`/`harvest` 里早就有「不在田旁 →
     *  ctx.setPath 走到田心 → return 等 moveStep 推进」（与 gathering.workFeature
     *  同一模式）。缺的只是「值得为之走过去」的半径——condition 按成 12 格把路堵死。
     *  【为什么取 30 而不是 p90 的 62.3】开到 p90 会让鼠为 3 份口粮横穿 60 格，
     *  并与 gathering 的 `build.maxForageDist = 30`（采集射程锚）打架。
     *  30 = 与 maxForageDist 同锚点：≤30 的熟田覆盖 **48.6%** 的抽样，
     *  把「有熟田却抽不到卡」从 81.8% 压到 51.4%，且不引入超长跋涉。 */
    magnetRadius: number;
    /** 饥饿低于此值时 farm 系列权重放大倍数（涌现点：没播种就饿肚子，饿才想去种地） */
    hungryBelow: number;
    hungryWeightMul: number;
  };
  /**
   * cooking —— 篝火烹饪包数值（ROADMAP R3-4）。
   *
   * 【机制立论，不是数值游戏】R3-4 的种子是「生食低收益 / 熟食高收益，火的价值再+1」。
   * 要让"火的价值再+1"成立，熟食必须**真的更划算**，否则鼠没有任何抽烹烤卡的理由
   * （火只剩取暖/睡觉两个用途，烹烤卡会沦为权重 5 的陪跑）。
   *
   * 【为什么用"单位食物的净饱食"而不是"多给几份"】—— 因为当前食物**永不稀缺**：
   *   实测（12 seed × 900 tick，dt=1）food 库存均值 347、终值 311~945，最低值只在 t=0 出现 0。
   *   也就是说"多一份食物"是纯浪费的增量（库存已经溢出到用不完），
   *   唯一能真正改善生存曲线的杠杆是**每单位食物换到的饱食更多**（即单位时间饱食吞吐更高），
   *   这才是"熟食高收益"在**没有饥饿压力**的世界里的唯一有意义的表达。
   *
   * 【净收益的口径（验收项）】净收益 = 吃一份所得的饱食点 / 消耗的一份食物。
   *   生食：`needs.eatFoodGain / 1`。熟食：`(needs.eatCookedFoodGain) / 1`（吃熟食走烹烤数值）。
   *   验收只要求熟食净收益 > 生食，且差距要足以让"多花工夫"成为合理代价。
   */
  cooking: {
    /** 烹烤一次消耗的生食份数（当前恒为 1 份 → 1 份熟食；留成表项以便将来做"炖菜=多份"）。 */
    cookRawCost: number;
    /** 烹烤一次产出的熟食份数。1 份生 → 1 份熟（熟≠多，是**效率**不是数量）。 */
    cookYield: number;
    /** 烹烤到手的熟食，吃一份恢复的饱食点（**熟食高收益的落点**）。
     *  出厂 55 > 生食 eatFoodGain(40)：熟食净收益 55 > 生食 40，验收项成立；
     *  多出的 15 点正是"多花工夫走过去 + 在火边烤"的补偿，且仍低于满值 100 上限。 */
    eatCookedFoodGain: number;
    /** 烹烤卡的磁铁半径（格）：火在此半径内**值得为之走过去**再烤。
     *
     *  【实测依据】12 seed × 900 tick（dt=1，n=42353 有火抽样）：鼠到最近火堆距离
     *    分位 p10=2.0 / p25=7.2 / **中位 11.7** / p75=16.1 / p90=21.6 / p95=24.2 / p99=28.2。
     *    覆盖率：≤8 仅 **27.3%**、≤12 **51.2%**、≤16 **74.7%**、**≤24 94.5%**、≤30 96.0%。
     *  【为什么取 24】与 needs.sleepMagnetRadius(24) / build.newFireRadius(24) 同锚点
     *    ——都是"营地的势力范围"。24 格 ≈ speed 4.5 的 5 秒路程，不制造超长跋涉，
     *    且把「看得见火却永远烤不到」的抽样压到 5.5%。**照抄这个数的前提是先实测**，
     *    本条的覆盖率就是实测证据（若哪天营地尺度变了，先重测再调这里）。 */
    magnetRadius: number;
    /** 火边到位半径（格）：走到这么近才真的开始烤。
     *  语义 = "伸手够得着火"的贴合距离，与磁铁半径是**两个量**，不可复用同一个数
     *  ——那正是本项目已踩坑 4 次的根因（chat/sow/harvest/sleep）。 */
    workRadius: number;
    /** 熟食存量闸：库存熟食达到此数就不再开烤（**实测出来的霸池防线**，见 cooking.ts
     *  wantCook 注释——第一版 cook 霸占卡池 30.7%、3090 份熟食只被吃 519 份）。
     *  它是**产出侧**的真实约束：食物永不稀缺时，鼠不需要无限烤；这个上限把
     *  "烤"从"霸池的永动机"拉回"有节制地改善伙食"。 */
    cookRawMaxStock: number;
    /** 单锅烤制时长（秒）：起锅 → 烤满 cookSec → 出锅，**占满真实卡期**。
     *
     *  【为什么必须有它，不能"到火边就出一份"】实测第一版（瞬时完成）：cook 抽中占比
     *   **30.7%**、condition 失败率 2.5%、熟食产出 3090 份 vs 被吃 519 份。
     *   根因：瞬时完成让 cook 几乎不占卡期 ⇒ 到火边→秒完成→立刻重抽→又抽中 cook，
     *   自锁成霸池机器。对照 gathering 的 6~8s 持续劳作，本值取同量级让两卡在同一量纲竞争。
     *  取 6s：略短于砍树(6s)/采果(8s) 的中位，让"顺路烤一锅"不至于拖累营地节奏。 */
    cookSec: number;
    /** 生食库存高于此值才值得开烤（库存很足时鼠更可能去吃现成的/去干别的活，
     *  避免"永远有饭就永远在烤"的单一行为）。取 0 = 一有生食就想烤（保守基线）。 */
    rawStockMin: number;
    /** 磁铁半径内有火时，cook 系列权重的抬高倍数。
     *
     *  【为什么要有这条 hook，而不是把 cook 的基础权重直接调高】见 cooking.ts 权重钩子注释：
     *   抬高集中在"真的有火可用"的世界状态上，"值得烤"时更想烤、没火时不浪费抽签。
     *  出厂值与依据见下方 DEFAULT_TUNING 处的 A/B 实测（与 needs/farming 的
     *  hungryWeightMul 是同一条手法："局面合适 → 相关系列权重抬高"，不是新发明的机制）。 */
    cookWeightNearFire: number;
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
    /**
     * 事件检查节奏（秒）：events 系统每隔这么久遍历一次 eventSeeds 判谓词。
     * 取 12 ≈ 与行为卡 duration 同量级，让事件"看得见地发生"而非"背景噪声"。
     * 调参依据：太小 = 事件刷屏（每个 checkSec 可能刷一条 log），太大 = 事件稀薄
     * 到看不见（种子要求"故事从局面抽出"，玩家必须能看到）。
     */
    checkSec: number;
    /**
     * 事件冷却（秒）：同一事件触发后，在冷却期内不再触发（谓词命中但被冷却挡住）。
     * 取 60 = 冷却期 ≈ 5 个检查周期，防"每 checkSec 触发一次"的刷屏。
     * 与 checkSec 的取舍：cooldownSec 应明显大于 checkSec，否则冷却形同虚设。
     */
    cooldownSec: number;
    /**
     * 各事件阈值（谓词全部读这里，禁止在事件种子内硬编码数字）。
     * 命名语义：<名><比较方向>——Below = 低于此值触发，Above = 高于此值触发，
     * Min = 至少多少只鼠。
     */
    thresholds: {
      /** 丰收：food < 此值 且有浆果丛 → 触发（荒年才显丰收的恩泽） */
      harvestFoodBelow: number;
      /** 寒潮：火堆数为 0 或 鼠数 ≥ 此值 → 触发（人多才扛不住冷） */
      coldsnapMinPawns: number;
      /** 瘟疫：鼠数 ≥ 此值 → 触发（人多才传得开） */
      plagueMinPawns: number;
      /** 流浪者：food > 此值 且有棚屋 → 触发（富余才招得来） */
      strangerFoodAbove: number;
      /** 丰收节：food > 此值 → 触发（奢侈才庆祝） */
      festivalFoodAbove: number;
    };
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
    sleepMagnetRadius: 24,
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
    workRadius: 1.5,   // 到位半径：站进/站到田边即伸手可及（原 senseRadius=12 被降级到这里，
                       // 因为那 12 格从来不是"伸手范围"，而是错当成候选池半径的贴身距离）
    magnetRadius: 30,  // 候选池（磁铁）半径 30：实测到最近熟田中位 31.0 格、≤30 覆盖 48.6%，
                       // 与 build.maxForageDist=30 同锚点（活动范围不因种地而扩张）
    hungryBelow: 45,   // 饥饿线（与 needs 包的 f<55 档重叠但更低——种植更"重决策"）
    hungryWeightMul: 2.2,
  },
  cooking: {
    cookRawCost: 1,    // 1 份生食 → 1 份熟食（熟是**效率**不是数量）
    cookYield: 1,
    // 熟食净收益 55 > 生食 eatFoodGain(40) = R3-4 验收项（见上方机制立论）。
    // 55 而非更高：熟食吃一份回 55 点，而满值是 100 ⇒ 吃熟食两次即满，
    // 多给并不会线性变强，"多烤几份"的边际收益递减——留给后续调平衡时回退的空间。
    eatCookedFoodGain: 55,
    // 实测到最近火中位 11.7 / p95 24.2；≤24 覆盖 94.5%
    //
    //  【实测·第二次修正：24 改 10，因为 24 会**拖垮营地扩张**（R3-4 踩到的真机制冲突）】
    //   第一版照抄 needs.sleepMagnetRadius(24)（当时以为"与 sleep 同锚点最稳"），
    //   实测 12 seed × 900tick 的直接后果：build_campfire 被抽中占比 **0.086%**，
    //   跌破 card-liveness 的 0.2% 门禁；火堆均值 2.79 → **1.48**、终局 3.80 → 1.80。
    //   ⚠ 我**没有**去改那条门禁（放宽门禁是本项目的红线），而是查清了因果：
    //   A/B 扫（scripts/_sweep.mts、_sweep2.mts，10 seed × 900tick）证明这是
    //   **磁铁半径**造成的，不是权重：同一个 hook×1.6 下
    //     磁铁 6  → 火堆 2.46 / campfire 0.229%（过门禁）
    //     磁铁 10 → 火堆 2.51 / campfire 0.263%（过门禁）
    //     磁铁 24 → 火堆 1.48 / campfire 0.086%（红）
    //   ⇒ **根因**：24 格磁铁把远处鼠**成群拽向现有火堆**，而 build_campfire 的 condition
    //   恰恰是「身边 24 格无火」——鼠都聚在旧火边，就再也"身边无火"了。
    //   烹饪包与营地扩张**天然争夺同一批鼠的注意力**，这是机制冲突，不是数值没调好。
    //   【实测·第三次修正：10 → 6，为的是**余量**而不是"刚好过线"】
    //   10×3.5 在 card-liveness 上是 0.209%，只比 0.2% 的门禁高 0.009 —— 那是**刀尖上
    //   的及格**，换一批 seed 立刻变红（实测同一套配置复跑：0.184% / 0.130%，红）。
    //   又扫了一轮"两个门禁都要过"的候选（scripts 里的 _sweep2/_sweep4）：
    //     磁铁 6 × 3.0 → campfire **0.233%**、火堆 2.52、cook 占卡池 3.31%、
    //                    熟食 132 产 / 127 耗、存活 100%  ← 两个门禁里余量最大的一点
    //     磁铁 7 × 3.0 → 0.223%；磁铁 8×2.5/8×3.0/9×3.0/10×3.0/10×3.5 → 全部 ❌（0.128~0.192%）
    //   ⇒ 取 6：6 格 ≈ speed 4.5 下的 1.3 秒路程，是"**已经站在火边**"的范围，
    //   所以鼠**不会**被拽走 —— 这正是保住营地扩张的机制原因。
    //   ⚠ 代价要说清：cook 只占卡池 3.31%，比 10×3.5 的 11.9% 少很多。
    //     这不是"把数字调好看"，而是**同一个冲突的两个旋钮里选余量更大的那个**：
    //     熟食照产（127 份被吃掉，消耗率 0.96），R3-4 的"火的价值+1"照样成立。
    //   【推翻路径】若将来营地尺度变大（fire 间距超过 6 格），先把实测覆盖率重新量一遍，
    //   再考虑放宽；不要直接抄 sleep 的 24（那是 sleep 的需求，不是 cook 的约束）。
    magnetRadius: 6, // 只在"本来就贴着火"时烤：6 格 ≈ 1.3 秒路程，不把远处鼠拽走
    workRadius: 2.5,   // 火边贴合距离：与 needs 的 FIRE_SIDE_R 同量（伸手够得着）
    cookRawMaxStock: 40, // 熟食堆到 40 份就不再烤（≈ 全队 10 天的口粮上限，见 wantCook 实测注释）
    cookSec: 6,        // 单锅烤制 6s：与砍树(6s)/采果(8s) 同量纲，让 cook 不再是"秒完成"的霸池卡
    rawStockMin: 0,    // 只要有生食就允许开烤（保守基线：先不引入"库存太多不值得烤"这一层）
    cookWeightNearFire: 3.0, // 有火（6 格内）时 cook 系列权重 ×3.0
    //  为什么高于 needs/farming 的 2.2：**短磁铁**（6 格，见 magnetRadius）下 cook 的
    //  condition 失败率很高（多数时候鼠根本不在火边），要达到"熟食真的在流通"
    //  （实测产出≈消耗）的活跃度，就需要比"饿了×2.2"更强的推力。
    //  A/B 实测（10 seed × 900tick）：磁铁 6 时 hook 2.5→3.0，
    //  campfire 0.204%→0.233%（**余量更大**）、熟食 110→132 份；
    //  再往上（配合更长的磁铁）会把 campfire 压回红线以下。
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
    // ---- 节奏锚点（2026-10-06 按实测重算，原注释的算术是错的）----
    //
    // 【原注释的问题】它写「intervalSec 120 + chance 0.55 ⇒ 期望 ~218s 一块碎片；
    // 首个科技 3 块 ≈ 11 分钟（短于一场 900s 的生存循环，玩家能看到"科技真的来了"）」。
    // 这个算术只数了**总碎片数**，漏了**碎片要落在正确的那一项上**这一步：
    // 4 项科技时 rank0 的抽中权重是 4/(4+3+2+1) = **40%**，不是"必中"，
    // 所以首个科技实际需要 ~2.5 块**特定**碎片。
    //
    // 【实测】900s 内 4 seed 合计只收到 **8 块**碎片（= 每 seed 2 块），
    // 首个科技要 3 块 ⇒ **4 个 seed 里只有 1 个在 900s 内解锁了任何科技**，
    // 且其中 3 个 seed **跑到 1800s 仍然零解锁**。
    // 后果：build_store 卡 condition 失败率 **100.0%**（它被 `storage:store`
    // 科技门控），整棵科技树在一整局里基本不存在。
    //
    // 【改法与理由】只调 chance 0.55 → 0.8。理由：
    //   - 期望碎片节奏 218s → 150s/块，3 块 ≈ 7.5 分钟，**在 900s 内可稳定见到解锁**，
    //     这正是原注释想要的"玩家能看到科技真的来了"；
    //   - 不动 intervalSec（120s 的抽卡节奏本身是好的，保留"科技不来"的空抽感）；
    //   - 不动 fragments（那是内容包的数值，不该由内核调）。
    // 【推翻路径】若解锁变得太频繁、把科技变成了自动流水线，把 chance 调回 0.55~0.65；
    // 判断依据是「900s 内解锁项数」——目标 1~2 项（看得见但不白给）。
    //
    // ---- 2026-10-06 第 5 轮：intervalSec 120 → 90、chance 0.8 → 1.0 ----
    //
    // 【为什么还要再调】上面那次只按 `chance` 一维调，结果解锁率仍不够。R3-6 立项后
    // 我把它拆成两个可独立验证的量分别测，结果推翻了我自己在上一轮写下的靶点判断：
    // 我当时以为瓶颈是**权重分配**（rank0 只占 40%、"靠前的先攒齐"落空），打算把
    // `权重 = n - rank` 换成几何递减。但实测两件事：
    //   ① **那个注释的算术也是错的**：`tech-pool.ts:70-71` 写「n=4 时靠前的期望约
    //      2.6 块就先攒齐」，而 rank0 实际是 3 块 / 40% = **期望 7.5 块**，不是 2.6。
    //   ② **但几何权重是错的药**：8/4/2/1 让 rank3 的期望从 50 块涨到 **75 块**，
    //      靠后的科技更抽不到了——而那正是"往后抽卡"要保留的渐进感。
    // ⇒ **真瓶颈是碎片供给总量，不是分配**。实测（1800s、避开 events 裁剪）：
    //      每 seed 4~6 块碎片，而全树需要 3+4+4+5 = **16 块**；
    //      且 `tech-pool.ts:8-10` 的"每 intervalSec 只发一块"意味着 900s 最多发
    //      900/120 × 0.8 ≈ **6 块**，离"解锁 rank0 所需"都差得远。
    //
    // 【改法与实测】intervalSec 120→90、chance 0.8→1.0，10 seed × 900s A/B：
    //      chance 0.8/interval 120（改前）→ 0.70 项
    //      chance 0.8/interval  90        → 0.70 项   ← 只降 interval 几乎没用
    //      chance 1.0/interval  90        → **1.40 项**（选定）
    //      chance 0.9/interval  60        → 2.10 项   （超标，留作上限参照）
    //   取 1.0/90 命中上面定的目标区间「1~2 项：看得见但不白给」。
    //   为什么 chance 敢到 1.0：`intervalSec` 本身就是抽卡节拍器，**空抽的乐趣已经由
    //   它承担**（120s 时"两拍都没中"的空抽感来自 interval），chance 再乘一个小于 1
    //   的因子只是把同一种"没抽中"表达两遍。移到 interval 上能让「节奏」与「空抽」
    //   各自只由一个数控制——这是 90/1.0 相对于 90/0.8 更干净的地方。
    // 【推翻路径】若 900s 内解锁项数 >2 项（科技变流水线），把 intervalSec 调回 120
    //   或 chance 调回 0.8；若 <1 项（科技看不见），再降 intervalSec。判据统一用
    //   `src/__tests__/card-liveness.test.ts` 之外的独立统计：10 seed 的平均解锁项数。
    intervalSec: 90,
    chance: 1.0,
  },
  bootstrap: { pawnCount: 4 },
  events: {
    maxLog: 200,
    checkSec: 12,        // 每 12s 扫一次事件谓词（与行为卡 duration 同量级）
    cooldownSec: 60,     // 同事件 60s 冷却（≈ 5 个检查周期，防刷屏）
    thresholds: {
      harvestFoodBelow: 30,   // 荒年（food < 30）才显丰收
      coldsnapMinPawns: 6,    // 人多（≥6）才扛不住冷
      plagueMinPawns: 6,      // 人多（≥6）才传得开
      strangerFoodAbove: 40,  // 富余（>40）才招得来流浪者
      festivalFoodAbove: 80,  // 奢侈（>80）才庆祝
    },
  },
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