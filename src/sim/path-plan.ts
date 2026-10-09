/**
 * path-plan.ts —— 路径规划策略：航点缓存 + 双档迭代预算 + 有限范围 A* 分段导航。
 *
 * ## 2026-10-08 sim 维度拆分：为什么从 sim.ts 里出来
 *
 * 此前这三个东西（`fireAnchors` / `fireAnchorsVersion` / `routeCache` +
 * `fireAnchorsList()` + `setPath()`）与"实体容器"（pawnMap / hostilesList /
 * stockpile / events / scratch / techsUnlocked）挤在一个 `Sim` 类里。
 * 两类代码的性质相反：
 *   - 实体容器是**状态**（存档认它、命令改它、玩法包通过 SimContext 读它）；
 *   - 规划策略是**纯计算**（输入 = 可走判定 + 起终点，输出 = 路径序列），
 *     它有自己私有的缓存，与"谁是实体"无关。
 * 混在一起的代价是：`Sim` 620 行里能单测的纯函数只有 `moveStep`/`adjacent`，
 * 而真正需要单独审视的东西——"长距为什么走标志位"、"8000 迭代的边界在哪"——
 * 埋在实体的增删查改中间。拆开后本文件不 import Sim、不 import World（只认
 * `AnchorSource` 这个形状），可以用假的 canStep/canStand 直接单测规划决策。
 *
 * ## 策略本体（R4-Battle 有限范围 A* + 标志位导航）
 *
 * 用户架构指令 2026-10-06：「使用有限范围的 A* 为了无限地图支撑。
 * 地图上会设置大坐标标志位置点」。
 *
 * 原缺陷（现象/根因）：长距（> 24 格）时直连 A* 用 8000 迭代上限——实测
 *   长距单次 1.6ms（64 鼠下 setPath 占 45% 耗时），且 8000 迭代上限意味着
 *   搜索范围随地图变大而变贵 = **依赖地图尺寸**，撑不起无限地图。
 * 修法：**长距默认走标志位导航**（planRoute：起点→最近标志位→…→目标的分段
 *   有限 A*，每段 1500 迭代），直连 A* 只用于短距（≤ 24 格）。
 *   标志位 = 火堆锚点（fire 桶 ∪ waypoint 桶，见 contracts K_TAG_WAYPOINT）。
 *   行为差异：长距路径会绕标志位（分段最优 ≠ 全局直连最优），属架构性变更，
 *   golden 换血时记录。
 *
 * ## 与 pathfinding.ts 的分工
 *
 * `pathfinding.ts` 是**算法**（A* + 二叉堆 + 斜角禁切 + planRoute 的拼接规则），
 * 本文件是**策略**（用什么预算、什么时候走锚点、锚点从哪来、缓存怎么失效）。
 * 算法可以原地优化而不改策略，策略可以调预算而不动算法。
 *
 * ## 缓存纪律（两个缓存，失效条件不同）
 *
 *   - `routeCache`：起终点对 → 路径。**建筑增删即清空**——火堆网络变了旧段作废。
 *   - `anchorList`：锚点列表本身。**跟着 tagVersion 走**（低频重建）。
 * 后者是"高频读 / 低频写"的典型（900 tick 只变 7~14 次），
 * 旧项目回退空间索引的原因正是"索引构建开销 > 节省"，这里的差别是构建频率
 * 差两个数量级。
 *
 * ## 依赖方向
 *
 * path-plan → pathfinding（算法）+ types（类型）+ mods/contracts（航点标签）。
 * **不**依赖 Sim、World、tuning、rng。
 */
import { findPath, planRoute } from './pathfinding';
import type { BuildingState, Pos } from './types';
import { K_TAG_WAYPOINT } from '../mods/contracts';

/** 短距/长距阈值（Manhattan 距离）：> 24 格视为长距，改走标志位分段导航。 */
export const LONG_DIST = 24;
/** 短距直连 A* 的搜索预算。 */
export const SHORT_MAX_ITER = 1500;
/** 长距直连 A* 的搜索预算（仅在长距且无锚点时作兜底）。 */
export const LONG_MAX_ITER = 8000;
/** 分段导航每段的 A* 预算。 */
export const SEGMENT_MAX_ITER = 1500;

/**
 * 航点来源的最小形状。
 *
 * 方法名**刻意与 World 的既有名字一致**（`tagVersionNow` / `buildingsByTag`），
 * 这样 `new RoutePlanner(sim.world)` 零适配器即可——加一层适配反而制造出
 * 第二处需要同步的命名。测试用假来源时也照样可读。
 */
export interface AnchorSource {
  /** 建筑增删版本（每次增删 +1），用于判定锚点缓存是否过期。 */
  tagVersionNow(): number;
  /** 某 tag 下的全部建筑（只读；调用方不得改数组）。 */
  buildingsByTag(tag: string): readonly BuildingState[];
}

/** 一次规划请求。起终点已整数量化（见 Sim.setPath 的注释）。 */
export interface PlanInput {
  /** 边可走判定（含该鼠的攀爬门控）。 */
  canStep(fx: number, fy: number, ax: number, ay: number): boolean;
  /** 终点可站判定。 */
  canStand(ax: number, ay: number): boolean;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

export class RoutePlanner {
  private readonly src: AnchorSource;
  /**
   * 火堆锚点列表缓存 + 它对应的 tagVersion。
   *
   * 顺序刻意固定为「fire 先、waypoint 后」，各自保持插入序：planRoute 内部按到
   * 起点/终点的距离排序，等距时 Array.sort 稳定保留输入序 ⇒ 输入序必须确定。
   * fire 排在前面保证**无 waypoint 建筑时与改动前逐位相同**（golden 基线不动）。
   * 去重：篝火同时挂两个标签，会在两个桶各出现一次。
   *
   * 字段名用 anchorList 而不是 anchors——它和读取方法同名会让 TS 报
   * "Duplicate identifier"（类字段与类方法共享命名空间）。
   */
  private anchorList: Pos[] = [];
  private anchorVersion = -1;
  /** 锚点对段缓存：键 = 起终点，值 = 拼好的路径或 null（不可达）。 */
  private routeCache = new Map<string, Pos[] | null>();

  constructor(src: AnchorSource) {
    this.src = src;
  }

  /** 建筑增删后调用：火堆网络变了，所有航点段落作废。 */
  clearRoutes(): void {
    this.routeCache.clear();
  }

  /** 航点列表（fire ∪ waypoint，按 tagVersion 缓存）。
   *  返回的是缓存数组本体（不给副本）：planRoute 只读它
   *  （`[...anchors].sort()` 自己会拷），给副本等于把这次优化又抵消掉。 */
  anchors(): readonly Pos[] {
    const v = this.src.tagVersionNow();
    if (v !== this.anchorVersion) {
      const out: Pos[] = [];
      const seen = new Set<string>();
      for (const b of this.src.buildingsByTag('fire')) {
        const k = `${b.pos.x},${b.pos.y}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ x: b.pos.x, y: b.pos.y });
        }
      }
      for (const b of this.src.buildingsByTag(K_TAG_WAYPOINT)) {
        const k = `${b.pos.x},${b.pos.y}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ x: b.pos.x, y: b.pos.y });
        }
      }
      this.anchorList = out;
      this.anchorVersion = v;
    }
    return this.anchorList;
  }

  /**
   * 规划一条路径（见文件头的策略段）。
   *
   * **返回的数组不得直接被调用方改写或跨调用复用**：长距命中 routeCache 时
   * 返回的是缓存本体，`shift()` 之类的原地推进会把缓存掏空。
   * 调用方（Sim.setPath）负责在写入实体状态前取副本。
   */
  plan(inp: PlanInput): Pos[] {
    const { canStep, canStand, sx, sy, tx, ty } = inp;
    const anchors = this.anchors();
    const isLong = Math.abs(tx - sx) + Math.abs(ty - sy) > LONG_DIST;
    if (isLong && anchors.length > 0) {
      // 长距 + 有标志位：直接走分段导航（不再先试 8000 迭代直连）
      return planRoute(canStep, canStand, sx, sy, tx, ty, anchors, SEGMENT_MAX_ITER, SEGMENT_MAX_ITER, this.routeCache);
    }
    const maxIter = isLong ? LONG_MAX_ITER : SHORT_MAX_ITER;
    let path = findPath(canStep, canStand, sx, sy, tx, ty, maxIter);
    // 直连失败 → 借火堆锚点分段中转（远距离/隔地形时是唯一可行路径）
    if (path.length === 0 && !(sx === tx && sy === ty)) {
      path = planRoute(canStep, canStand, sx, sy, tx, ty, anchors, maxIter, SEGMENT_MAX_ITER, this.routeCache);
    }
    return path;
  }
}
