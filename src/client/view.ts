/**
 * client/view.ts —— 渲染层与模拟层之间的视图契约。
 *
 * 为什么：本地模式直接读 Sim，联机模式读"服务端快照合入层"（RemoteSim）——
 * 两者必须对渲染/HUD 长同一张脸，render/hud 才能零分支复用（技术规格：双端复用）。
 * 视图是**只读快照**：渲染层不持任何逻辑状态（原则：色值等表现数据归本层，逻辑层数据归 sim）。
 *
 * 本文件只放**契约**：WorldView 接口 + 展示模型（ColonySummary / PawnDetail /
 * BuildingDetail / HostileDetail / TechProgressRow / TileInspect / HudSlot）。
 * 表现数据表（CARD_LABEL / TRAIT_COLOR / TERRAIN_NAME / cardLabel）在 ./presentation.ts——
 * 契约与"画成什么样"分文件，新增卡片图标不必改接口文件（2026-10-08 hud 维度拆分）。
 */
import type { BuildingState, Hostile, LogEvent, PawnState } from '../sim/types';
import type { BuildingTuningEntry, Tuning } from '../sim/tuning';

/** HUD 面板挂载位：结构化分区（style.css 按 slot 定屏幕位置与视觉层级）。
 *  为什么是枚举而不是散落的 DOM id：HUD 要有明确的信息层级，且**可扩展**——
 *   新玩法包能声明自己的面板并挂到既有分区，而不用改 hud.ts 硬编码（见 hud/panels.ts）。 */
export type HudSlot = 'status' | 'vitals' | 'colony' | 'threat' | 'detail' | 'log';

export interface WorldView {
  readonly time: number;
  readonly stockpile: Record<string, number>;
  /** 最近事件（尾部窗口，HUD feed 用） */
  events(): LogEvent[];
  pawns(): Iterable<PawnState>;
  hostiles(): readonly Hostile[];
  buildings(): BuildingState[];
  buildingDef(defId: string): BuildingTuningEntry | undefined;
  readonly tuning: Tuning;
  /** 表现层文案目录（客户端自持中文标签；未知 id 回落原样显示） */
  traitName(trait: string): string;
  /** 无限地形查询：本地直读 World；远程用"同 seed 本地推导 World + 服务端增量表"回答
   *  （地形是纯函数，客户端自推零流量；余量/冷却状态由全量快照随档同步）。 */
  tileAt(x: number, y: number): string;
  featureAt(x: number, y: number): { kind: 'tree' | 'berry'; amount: number } | null;
  zAt(x: number, y: number): number;
  /** 悬停属性卡：一格的完整可读信息（实现方拼装好文案，HUD 只管展示） */
  inspect(x: number, y: number): TileInspect;
  /**
   * **可选**的渲染层坐标（R1-3）。给不给都行：
   *  - 联机（RemoteSim）实现它 → renderer 画插值后的平滑位置；
   *  - 本地（LocalView）不实现 → renderer 回退用 p.pos（本地本来就是连续模拟，不需要插值）。
   *
   * 为什么单开一个口而不是让 pawns() 返回插值后的对象：pawns() 是**权威快照**，
   * 点选命中、框选范围、HUD 选中面板全靠它。若连它一起插值，就会出现
   * 「看到的鼠」和「被选中的鼠」对不上——批量指挥会指挥错对象。
   * 插值只能是画出来的那一份，逻辑判定永远读权威值。
   */
  renderPos?(eid: number, nowMs: number): { x: number; y: number } | undefined;
  /**
   * 科技抽卡池进度（R2-1）：已组装好的展示模型。
   * 为什么是"拼装好的对象"而不是 (techs表, 碎片, 已解锁集合) 三个原始面：
   * HUD 只管展示，联机模式下这三个原始面还得各自从协议字段重建——放实现方拼，
   * render/hud 才能零分支复用（与 inspect 同一设计动机）。
   */
  techProgress(): readonly TechProgressRow[];
  /**
   * 殖民地汇总面（R3-HUD，2026-10-06）：**已经存在但玩家看不见**的那些世界事实，
   * 一次性拼成展示模型交给 HUD。
   *
   * 为什么是"拼装好的对象"而不是让 HUD 自己遍历 pawns()/buildings()/stockpile：
   *  ① **联机同构**——这些量的原始面在 LocalView 与 RemoteSim 里语义相同但取数路径不同
   *     （本地遍历 Sim、联机读快照投影），放实现方拼，HUD 才能零分支复用（与 inspect/techProgress 同动机）；
   *  ② **性能**——HUD 每帧被调，面层可以在实现方做一次遍历并产出**定长字符串 key**，
   *     HUD 拿 key 做差分即可跳过 DOM 重建。散落的原始面会强迫 HUD 每帧重算整棵聚合。
   *
   * 覆盖：人口与平均需求（食/眠/情/智）、建筑按种类计数、敌袭压力与最近威胁。
   * 注意 `raidPressure` 读的是 ctx.scratch 的真实值（raid 包写），不是 HUD 自己编的假进度条。
   */
  colony(): ColonySummary;
  /**
   * 单体详情面（R3-HUD）：选中一只鼠 / 一座建筑 / 一只敌袭单位时的完整档案。
   *
   * 与 colony() 同一设计动机（拼装好的展示模型 + 定长 key），
   * 额外解决"选中面板每帧重算"：HUD 拿 `key` 比对，未变则完全不碰 DOM。
   */
  inspectPawn(eid: number): PawnDetail | null;
  inspectBuilding(id: string): BuildingDetail | null;
  inspectHostile(id: number): HostileDetail | null;
}

/** 殖民地汇总（R3-HUD）。所有数值都是**已存在**的世界事实的聚合，不引入新模拟。 */
export interface ColonySummary {
  pawnCount: number;
  /** 需求均值 0..100（四维；玩家此前只能逐只点开看，看不到全局分布） */
  avgNeeds: { food: number; rest: number; mood: number; san: number };
  /** 血量均值 0..100 */
  avgHpPct: number;
  /** 建筑按 defId 分组计数（种类 + 数量，HUD 直接列表化） */
  buildingKinds: { defId: string; name: string; count: number; fuelSec?: number }[];
  /** 在场敌袭单位数 */
  hostileCount: number;
  /**
   * 叙事压力 0..1（raid 包的 scratch 真实值 / 阈值）。
   * **纯读**：HUD 只显示，不复位也不写入——压力归 raid 包所有。
   * 无 raid 包（卸载）时为 null，HUD 显式隐藏威胁面板而不是显示假 0%。
   */
  raidPressure: number | null;
  /** 距下一波敌袭的估算秒数（满阈值即刷，压力回落保留余量 → 是估算不是承诺） */
  raidEtaSec: number | null;
}

/** 选中一只鼠时的档案（R3-HUD） */
export interface PawnDetail {
  eid: number;
  name: string;
  trait: string;
  traitName: string;
  cardLabel: string;
  needs: { food: number; rest: number; mood: number; san: number };
  hpPct: number;
  /** 距最近火堆的格数（HUD 判断"取暖中/在外过夜"）；无火为 null */
  nearFireDist: number | null;
  /** 熟练度条目（卡 = 习惯的建模：看得见的习惯养成） */
  mastery: { cardId: string; label: string; v: number }[];
  /** 该鼠已用各卡的次数（抽卡历史，让"抽卡驱动"可见） */
  uses: { cardId: string; label: string; n: number }[];
}

/** 选中一座建筑时的档案（R3-HUD）：种类 / 数量 / 耐久 / 燃料节奏 */
export interface BuildingDetail {
  id: string;
  defId: string;
  name: string;
  hp: number;
  maxHp: number;
  /** 占地 w×h（玩家此前完全看不到建筑尺寸） */
  w: number;
  h: number;
  tags: string[];
  /** 每 fuelSec 秒烧一份 wood；缺省 = 免维护 */
  fuelSec?: number;
  /** 造价（R3-HUD 新增可见项：建造决策需要知道代价） */
  cost: Record<string, number>;
  /** 同类建筑总数（"我有几座篝火"是玩家反复要问的问题） */
  sameKindCount: number;
}

/** 选中敌袭单位时的档案（R3-HUD）：玩家此前只能看到血条，不知道它是什么、还剩多少血 */
export interface HostileDetail {
  id: number;
  kind: string;
  name: string;
  hp: number;
  maxHp: number;
  /** 距最近一只鼠的格数（决定它是否真的在威胁营地） */
  distToNearestPawn: number;
  /** 是否已进营地警戒圈（tuning.raid.senseRadius） */
  engaging: boolean;
}

/** 科技面板一行（🔩 have/need + 是否已解锁） */
export interface TechProgressRow {
  id: string;
  name: string;
  have: number;   // 已攒碎片数
  need: number;   // 攒齐所需
  unlocked: boolean;
}

export interface TileInspect {
  x: number;
  y: number;
  terrainId: string;
  terrainName: string;
  /** 海拔（z 高度模型：移动合法性 = |Δz| ≤ 单位攀爬，不再有二元可通行） */
  z: number;
  /** 液体水面：无法立足 */
  liquid: boolean;
  /** 可立足（非液体/无树冠/无阻挡建筑） */
  standable: boolean;
  treeCanopy: boolean;
  feature: { kind: 'tree' | 'berry'; amount: number; label: string } | null;
  buildingName: string | null;
}
