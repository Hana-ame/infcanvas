/**
 * world.ts —— 无限确定性地图 + 建筑层（双图层：地形/构筑，技术规格承诺）。
 *
 * 为什么不存整表：
 *  - 地图无限（负坐标、任意远），只能按需推导。tile/feature 由 hash2(x,y,salt) 现场算出，
 *    同坐标永远同结果 = 确定性；出生安全区内清空水/石/特征保证开局可用。
 *  - 特征的"剩余量"是运行态（会被采），存 featureLeft 增量表；采空进入再生冷却
 *    （harvestCd），到期自动满血——tile 哈希本身永不被改写（旧项目踩坑结论：
 *    砍树不能改 tile，只能加冷却/增量层）。
 *  - 建筑是真实持久状态，存 Map<string, BuildingState>。
 *
 * 查询复杂度说明：nearestFeature 用环形扫描（r 从小到大），本阶段鼠群规模与感知半径
 * （≤15 格）下足够快；空间索引留到性能回归再加，接口不变。
 */
import { hash2 } from './rng';
import type { BuildingState, FeatureHit, Pos } from './types';
import type { Tuning } from './tuning';

/** 本模块瓦片缓存键（与寻路编码同式） */
function key2(x: number, y: number): number {
  return (x + 32768) * 65536 + (y + 32768);
}

const SALT_ELEV = 0x7a11; // 分形海拔基准盐（各八度 +i*101 派生）
const SALT_MOIST = 0x3f7d; // 林地密度场盐
const SALT_TILE = 0x51ed;
const SALT_WATER = 0xa1b2; // 水面值噪声晶格盐
const SALT_STONE = 0xc3d4;
const SALT_TREE = 0xe5f6;
const SALT_BERRY = 0x0718;
const SALT_BERRY_AMT = 0x1920;
const SALT_TREE_AMT = 0x2122;

export type TileKind = 'grass' | 'dirt' | 'stone' | 'water';

export class World {
  /** 建筑 id 自增；建筑占用格索引 key "x,y" → buildingId（占位查询 O(1)） */
  readonly buildings = new Map<string, BuildingState>();
  private occupied = new Map<string, string>();
  /** 被开采特征的剩余量增量表：key "x,y" → 剩份数 */
  private featureLeft = new Map<string, number>();
  /** 采空再生冷却：key "x,y" → 恢复时刻。到期视为重新长满 */
  private harvestCd = new Map<string, number>();
  private nextBuildingId = 1;

  constructor(
    public tuning: Tuning,
    readonly seed: number,
    readonly spawn: Pos,
  ) {}

  /**
   * 值噪声（晶格哈希 + 平滑双线性插值）：把"每格独立掷骰"的椒盐散点升级为
   * 连贯成片的湖泊/岩层。确定性不变——晶格节点仍是 hash2，同坐标恒同结果。
   */
  private noise(ix: number, iy: number, salt: number, cell: number): number {
    const gx = Math.floor(ix / cell);
    const gy = Math.floor(iy / cell);
    const fx = ix / cell - gx;
    const fy = iy / cell - gy;
    const sx = fx * fx * (3 - 2 * fx); // smoothstep
    const sy = fy * fy * (3 - 2 * fy);
    const h00 = hash2(gx, gy, salt);
    const h10 = hash2(gx + 1, gy, salt);
    const h01 = hash2(gx, gy + 1, salt);
    const h11 = hash2(gx + 1, gy + 1, salt);
    return (h00 * (1 - sx) + h10 * sx) * (1 - sy) + (h01 * (1 - sx) + h11 * sx) * sy;
  }

  /** 负坐标安全的 mod 2（树锚点按 2×2 对齐栅格，保证树冠互不重叠） */
  private mod2(n: number): number {
    return ((n % 2) + 2) % 2;
  }

  /**
   * 分形海拔场 E(x,y) ∈ 0..1：多八度值噪声加权和。
   * E 直接量化出每格独立的 z 值（不再绑在地形类型上）。
   */
  private elev(ix: number, iy: number): number {
    const cells = this.tuning.world.elevCells;
    const weights = this.tuning.world.elevWeights;
    let sum = 0;
    let wsum = 0;
    for (let i = 0; i < cells.length; i++) {
      sum += this.noise(ix, iy, SALT_ELEV + i * 101, cells[i]) * weights[i];
      wsum += weights[i];
    }
    return sum / wsum;
  }

  /** 林地密度场 0..1：moisture 高处树锚点率乘 groveBoost——森林成片而非均匀撒点 */
  private moist(x: number, y: number): number {
    return this.noise(x, y, SALT_MOIST, this.tuning.world.moistCell);
  }

  /** 瓦片缓存：渲染/A* 对 tileAt 的调用量极大，分形海拔比单哈希贵一个量级，
   *  必须 memoize。容量封顶防长局漫游内存无界（清空即重新推导，确定性无损）。 */
  private tileCache = new Map<number, TileKind>();
  private zCache = new Map<number, number>();
  private static TILE_CACHE_CAP = 150000;

  tileAt(ix: number, iy: number): TileKind {
    const x = Math.round(ix);
    const y = Math.round(iy);
    const k = key2(x, y);
    const hit = this.tileCache.get(k);
    if (hit !== undefined) return hit;
    const kind = this.genTileKind(x, y);
    if (this.tileCache.size > World.TILE_CACHE_CAP) this.tileCache.clear();
    this.tileCache.set(k, kind);
    return kind;
  }

  /**
   * 地形类型（视觉/名称）：与 z 无关的独立判定。
   * 水=海拔低于水位；岩斑=独立噪声通道；其余草地/泥地。
   */
  private genTileKind(x: number, y: number): TileKind {
    const t = this.tuning.world;
    if (Math.abs(x - this.spawn.x) <= t.spawnClearRadius && Math.abs(y - this.spawn.y) <= t.spawnClearRadius) {
      return (x + y) % 5 === 0 ? 'dirt' : 'grass';
    }
    const e = this.elev(x, y);
    if (e < t.waterLevel) return 'water';
    // 岩斑：独立噪声通道，可在任何海拔出现
    if (this.noise(x, y, SALT_STONE, t.stoneCell) < t.stoneLevel) return 'stone';
    return hash2(x, y, SALT_TILE) < t.dirtChance ? 'dirt' : 'grass';
  }

  /**
   * 每格独立 z 值：连续海拔场量化为整数层级。
   * 与地形类型解耦——同一片草地上可以有 z=0 和 z=3 的格子，
   * 岩石也可以出现在低地。移动合法性 = |Δz| ≤ climb。
   */
  private genZ(x: number, y: number): number {
    const e = this.elev(x, y);
    const maxZ = this.tuning.world.maxZ;
    return Math.min(maxZ, Math.floor(e * (maxZ + 1)));
  }

  /** 地形层可立足（不含树冠/建筑——那是 canStand/canStep 的职责） */
  standableTile(x: number, y: number): boolean {
    return !this.tuning.tiles[this.tileAt(x, y)].liquid;
  }

  /** 海拔查询（悬停卡/移动判定共用）。 */
  zAt(ix: number, iy: number): number {
    const x = Math.round(ix);
    const y = Math.round(iy);
    const k = key2(x, y) + 1000000000; // 偏移避免和 tileCache 冲突
    const hit = this.zCache.get(k);
    if (hit !== undefined) return hit;
    const z = this.genZ(x, y);
    if (this.zCache.size > World.TILE_CACHE_CAP) this.zCache.clear();
    this.zCache.set(k, z);
    return z;
  }

  /** 可立足 = 非液体 且 不被树冠覆盖 且 无阻挡建筑。
   *  （旧名 passable 的二元语义已废除——上下高低差由 canStep 用 climb 判定。） */
  canStand(x: number, y: number): boolean {
    if (this.tuning.tiles[this.tileAt(x, y)].liquid) return false;
    if (this.treeBlockAt(Math.round(x), Math.round(y))) return false;
    const b = this.occupied.get(`${Math.round(x)},${Math.round(y)}`);
    if (b === undefined) return true;
    const def = this.buildings.get(b);
    return def ? this.tuning.buildings[def.defId].passable : true;
  }

  /** 一步移动判定：目标可立足 且 高差 |Δz| ≤ climb。
   *  from 坐标会被取整（鼠站格心之间时以所在格海拔为准）。 */
  canStep(fx: number, fy: number, tx: number, ty: number, climb: number): boolean {
    if (!this.canStand(tx, ty)) return false;
    const dz = Math.abs(this.zAt(tx, ty) - this.zAt(Math.round(fx), Math.round(fy)));
    return dz <= climb;
  }

  /** 兼容别名 = canStand（历史调用面：建造落点/闲逛落点/测试）。
   *  注意语义变化：岩层(z=2)现在是"可立足"的——能否真的站上去由 canStep/climb 决定。 */
  passable(x: number, y: number): boolean {
    return this.canStand(x, y);
  }

  /** 树是否以 (ax,ay) 为 2×2 锚点（对齐栅格 + 草地 + 通过率；安全区排除）。
   *  通过率受林地密度场调制：moisture 高处 ×groveBoost → 成片森林；低处稀疏。 */
  private treeAnchorAt(ax: number, ay: number): boolean {
    const w = this.tuning.world;
    if (Math.abs(ax - this.spawn.x) <= w.spawnClearRadius && Math.abs(ay - this.spawn.y) <= w.spawnClearRadius) {
      return false;
    }
    if (this.tileAt(ax, ay) !== 'grass') return false;
    const grove = 1 + this.moist(ax, ay) * (w.groveBoost - 1);
    return hash2(ax, ay, SALT_TREE) < w.treeRate * grove;
  }

  /** (x,y) 是否被某棵树的 2×2 树冠覆盖（阻挡通行）。
   *  反推所在对齐块的左上锚点再判定——纯函数，供 passable 高频调用。 */
  treeBlockAt(x: number, y: number): boolean {
    const ax = x - this.mod2(x);
    const ay = y - this.mod2(y);
    return this.treeAnchorAt(ax, ay);
  }

  /** 特征种类推导：只返回"锚点格"的种类——树的非锚点覆盖格返回 null，
   *  这样 nearestFeature/渲染都以锚点为唯一代表（收割/避让键一致）。
   *  浆果丛保持 1×1 逐格撒点。纯函数，供快照与收割共用。 */
  private featureKind(ix: number, iy: number): FeatureHit['kind'] | null {
    const x = Math.round(ix);
    const y = Math.round(iy);
    const w = this.tuning.world;
    if (Math.abs(x - this.spawn.x) <= w.spawnClearRadius && Math.abs(y - this.spawn.y) <= w.spawnClearRadius) {
      return null; // 安全区无特征：开局资源在圈外，逼鼠群走出去（也保证闭环测试可控）
    }
    if (this.tileAt(x, y) !== 'grass') return null;
    if (this.mod2(x) === 0 && this.mod2(y) === 0 && hash2(x, y, SALT_TREE) < w.treeRate) return 'tree';
    // 浆果不与树冠重叠（两套撒点原本互不知情，会在树干格上长出灌木）
    if (this.treeBlockAt(x, y)) return null;
    if (hash2(x, y, SALT_BERRY) < w.berryRate) return 'berry';
    return null;
  }

  /** 特征满额产量（由哈希决定：同一丛每次长出来一样多——确定性的"这丛很大"）。
   *  树升级为 2×2 大树后产量同步放大（4~6 木）。 */
  private fullAmount(kind: FeatureHit['kind'], x: number, y: number): number {
    const w = this.tuning.world;
    if (kind === 'tree') return 4 + Math.floor(hash2(x, y, SALT_TREE_AMT) * 3); // 4~6 木
    return (
      w.berryAmountMin +
      Math.floor(hash2(x, y, SALT_BERRY_AMT) * (w.berryAmountMax - w.berryAmountMin + 1))
    );
  }

  /** 特征占地矩形（树=锚点起 2×2；浆果=单点）。收割邻接/寻路目标换算用它。 */
  featureRect(f: { kind: FeatureHit['kind']; x: number; y: number }): { x0: number; y0: number; x1: number; y1: number } {
    const size = f.kind === 'tree' ? this.tuning.world.treeSize : 1;
    return { x0: f.x, y0: f.y, x1: f.x + size - 1, y1: f.y + size - 1 };
  }

  /** 点到特征矩形的最近距离（欧氏）；站在这段距离内视为"在旁边" */
  distToFeatureRect(px: number, py: number, rect: { x0: number; y0: number; x1: number; y1: number }): number {
    const dxc = Math.max(rect.x0 - px, 0, px - rect.x1);
    const dyc = Math.max(rect.y0 - py, 0, py - rect.y1);
    return Math.hypot(dxc, dyc);
  }

  /** 特征周边一圈里最近的可行走格（多格特征的寻路落点） */
  nearestFreeAdjacent(rect: { x0: number; y0: number; x1: number; y1: number }, fromX: number, fromY: number): Pos | null {
    let best: Pos | null = null;
    let bestD = Infinity;
    for (let y = rect.y0 - 1; y <= rect.y1 + 1; y++) {
      for (let x = rect.x0 - 1; x <= rect.x1 + 1; x++) {
        const onEdge = x === rect.x0 - 1 || x === rect.x1 + 1 || y === rect.y0 - 1 || y === rect.y1 + 1;
        if (!onEdge) continue;
        if (!this.passable(x, y)) continue;
        const d = Math.hypot(x - fromX, y - fromY);
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
    return best;
  }

  /** 特征查询（当前快照）。null = 无特征 / 已采空冷却中 / 余量被采到 0 边缘 */
  featureAt(x: number, y: number): FeatureHit | null {
    const kind = this.featureKind(x, y);
    if (!kind) return null;
    const readyAt = this.harvestCd.get(`${x},${y}`);
    if (readyAt !== undefined) {
      if (this.now < readyAt) return null;
      this.harvestCd.delete(`${x},${y}`); // 到期惰性清除
    }
    const left = this.featureLeft.get(`${x},${y}`) ?? this.fullAmount(kind, x, y);
    if (left <= 0) return null;
    return { x, y, kind, amount: left };
  }
  /** 世界时钟由 Sim 回填（world 不自转，避免双时钟漂移） */
  now = 0;

  /** 环形扫描最近特征：先近后远，命中即回——自然获得"最近的"语义 */
  nearestFeature(kind: FeatureHit['kind'], x: number, y: number, maxR: number): FeatureHit | null {
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // 只看当前环
          const f = this.featureAt(x + dx, y + dy);
          if (f && f.kind === kind) return f;
        }
      }
    }
    return null;
  }

  /** 收割一份：返回剩余份数；0 = 采空（自动进入再生冷却）。-1 = 此格无特征/冷却中 */
  takeOne(ix: number, iy: number): number {
    const x = Math.round(ix);
    const y = Math.round(iy);
    const k = `${x},${y}`;
    // 冷却检查：featureAt 有查，但这里此前没查——两鼠同 tick 竞争同一丛时，
    // 后手会从已采空的丛里继续收割（幻影浆果复辟），必须同样尊重冷却。
    const readyAt = this.harvestCd.get(k);
    if (readyAt !== undefined) {
      if (this.now < readyAt) return -1;
      this.harvestCd.delete(k);
    }
    const kind = this.featureKind(x, y);
    if (!kind) return -1;
    const left = (this.featureLeft.get(k) ?? this.fullAmount(kind, x, y)) - 1;
    if (left <= 0) {
      this.featureLeft.delete(k); // 再生时从满额重新开始（增量表只记"被采过的"）
      this.harvestCd.set(k, this.now + this.tuning.world.harvestRegenSec);
      return 0;
    }
    this.featureLeft.set(k, left);
    return left;
  }

  /** 建筑占地（w×h，缺省 1×1）；pos = 左上角格。 */
  footprint(defId: string): { w: number; h: number } {
    const def = this.tuning.buildings[defId];
    return { w: def?.w ?? 1, h: def?.h ?? 1 };
  }

  /** 建筑中心（渲染锚点/距离计算用；左上角 + (w-1,h-1)/2） */
  buildingCenter(b: BuildingState): { x: number; y: number } {
    const { w, h } = this.footprint(b.defId);
    return { x: b.pos.x + (w - 1) / 2, y: b.pos.y + (h - 1) / 2 };
  }

  /** 放建筑（多格）：所有覆盖格可通行且无占位、同类矩形间距达标后整体落子。
   *  返回 null = 放不下（调用方决定是否换格重试，内核不替玩法做策略）。 */
  addBuilding(defId: string, x: number, y: number): BuildingState | null {
    const def = this.tuning.buildings[defId];
    if (!def) return null;
    const { w, h } = this.footprint(defId);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (!this.passable(x + dx, y + dy)) return null; // 地形/树冠/已有阻挡建筑任一不过即拒
      }
    }
    // 同类间距：把既有同类矩形按 minSpacing 外扩一圈，与本占地相交即拒
    // （涌现式疏散：营地不会叠成一个点，非数量上限）
    const pad = this.tuning.build.minSpacing - 1;
    for (const b of this.buildings.values()) {
      if (b.defId !== defId) continue;
      const f = this.footprint(b.defId);
      if (
        x <= b.pos.x + f.w - 1 + pad &&
        b.pos.x <= x + w - 1 + pad &&
        y <= b.pos.y + f.h - 1 + pad &&
        b.pos.y <= y + h - 1 + pad
      ) {
        return null;
      }
    }
    const nb: BuildingState = { id: `b${this.nextBuildingId++}`, defId, pos: { x, y }, hp: def.hp };
    this.buildings.set(nb.id, nb);
    if (!def.passable) {
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) this.occupied.set(`${x + dx},${y + dy}`, nb.id);
      }
    }
    return nb;
  }

  removeBuilding(id: string): void {
    const b = this.buildings.get(id);
    if (!b) return;
    const { w, h } = this.footprint(b.defId);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) this.occupied.delete(`${b.pos.x + dx},${b.pos.y + dy}`);
    }
    this.buildings.delete(id);
  }

  buildingAt(ix: number, iy: number): BuildingState | undefined {
    const x = Math.round(ix);
    const y = Math.round(iy);
    // 阻挡建筑走占位索引 O(1)；可通行建筑（篝火）不在索引里，线性兜底——
    // 建筑总量几十座，可接受；若未来过百再上第二张索引
    const id = this.occupied.get(`${x},${y}`);
    if (id) return this.buildings.get(id);
    for (const b of this.buildings.values()) {
      if (b.pos.x === x && b.pos.y === y) return b;
    }
    return undefined;
  }

  /** 存档面：建筑实体 + 运行态增量表随档（tile 哈希由 seed 重推，无需保存；
   *  occupied 占位索引由 buildings 派生重建——曾漏存建筑导致读档后营地蒸发，行为全分叉） */
  exportState(): {
    buildings: import('./types').BuildingState[];
    featureLeft: [string, number][];
    harvestCd: [string, number][];
    nextBuildingId: number;
  } {
    return {
      buildings: [...this.buildings.values()].map((b) => structuredClone(b)),
      featureLeft: [...this.featureLeft.entries()],
      harvestCd: [...this.harvestCd.entries()],
      nextBuildingId: this.nextBuildingId,
    };
  }
  importState(st: {
    buildings: import('./types').BuildingState[];
    featureLeft: [string, number][];
    harvestCd: [string, number][];
    nextBuildingId: number;
  }): void {
    this.buildings.clear();
    this.occupied.clear();
    for (const b of st.buildings) {
      this.buildings.set(b.id, structuredClone(b));
      const def = this.tuning.buildings[b.defId];
      if (def && !def.passable) {
        const { w, h } = this.footprint(b.defId);
        for (let dy = 0; dy < h; dy++) {
          for (let dx = 0; dx < w; dx++) this.occupied.set(`${b.pos.x + dx},${b.pos.y + dy}`, b.id);
        }
      }
    }
    this.featureLeft = new Map(st.featureLeft);
    this.harvestCd = new Map(st.harvestCd);
    this.nextBuildingId = st.nextBuildingId;
  }

  /** 最近指定标签建筑（火/庇护……标签见 contracts K_TAG_*）：线性扫建筑表，
   *  建筑数在本阶段几十量级；专用空间索引等热了再上。 */
  nearestBuildingByTag(tag: string, x: number, y: number, maxR = Infinity): BuildingState | undefined {
    let best: BuildingState | undefined;
    let bestD = maxR;
    for (const b of this.buildings.values()) {
      if (!this.tuning.buildings[b.defId].tags.includes(tag)) continue;
      const d = Math.hypot(b.pos.x - x, b.pos.y - y);
      if (d <= bestD) {
        best = b;
        bestD = d;
      }
    }
    return best;
  }
}
