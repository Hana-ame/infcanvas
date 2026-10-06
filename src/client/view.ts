/**
 * client/view.ts —— 渲染层与模拟层之间的视图契约。
 *
 * 为什么：本地模式直接读 Sim，联机模式读"服务端快照合入层"（RemoteSim）——
 * 两者必须对渲染/HUD 长同一张脸，render/hud 才能零分支复用（技术规格：双端复用）。
 * 视图是**只读快照**：渲染层不持任何逻辑状态（原则：色值等表现数据归本层，逻辑层数据归 sim）。
 */
import type { BuildingState, Hostile, LogEvent, PawnState } from '../sim/types';
import type { BuildingTuningEntry, Tuning } from '../sim/tuning';

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

/** 卡牌 → 图标+短标签：表现层数据，客户端唯一权威（逻辑层的 card.label 不下发也够用，
 *  这里本地化图标让画面更可读）。 */
export const CARD_LABEL: Record<string, string> = {
  gather_berry: '🍓采野果',
  chop_tree: '🪓砍树',
  eat: '🍎吃饭',
  sleep: '😴睡觉',
  wander: '🚶闲逛',
  chat: '💬闲聊',
  fight: '⚔迎战',
  flee: '🏃撤退',
  build_campfire: '🔥搭篝火',
  build_hut: '🏠盖棚屋',
  _stun: '…愣住',
};

/** 特质 → 显示色（表现层数据；逻辑层特质表只有 name 与 seriesMul 权重） */
export const TRAIT_COLOR: Record<string, string> = {
  strong: '#c96f4a',
  lazy: '#7d9c5a',
  owl: '#8a7fc9',
  workaholic: '#c9b24a',
  cheerful: '#d98aa6',
};

export const TERRAIN_NAME: Record<string, string> = {
  grass: '草地',
  dirt: '泥地',
  stone: '岩层',
  water: '水域',
};

export function cardLabel(id: string | null | undefined): string {
  if (!id) return '';
  return CARD_LABEL[id] ?? id;
}