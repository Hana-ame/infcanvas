/**
 * chunk-index.ts —— 分区块派生索引（line/net 2026-10-06，2026-10-08 从 world.ts 拆出）。
 *
 * ## 这块代码在做什么
 *
 * **不改动地形推导模型**：地形仍是 hash 纯函数（零存储），区块化只作用在
 * *落在地上的实体状态*上——建筑、被采过的特征余量、再生冷却。
 * 理由：v3 的 hash 推导已经是 O(1) 空间无限地图，给它套一层"生成层+覆盖层"
 * 双图层（归档旧实现的做法）只会把 O(1) 变成 O(已访问面积)，是倒退而非进步。
 * 双图层的价值在"地形可被建造/挖掘改写"的玩法里——v3 没有那条路径（砍树只加冷却，
 * 绝不改 tile 哈希，见 world.ts 文件头"旧项目踩坑结论"），所以这里只需要**索引**，
 * 不需要**存储**。
 *
 * 索引是**惰性派生 + 增量维护**的：
 *  - 派生：从 buildings / featureLeft / harvestCd 三个真源表按区块分组；
 *  - 增量：addBuilding/removeBuilding/takeOne 各自更新所属区块的桶。
 * 真源表仍是唯一事实（存档/确定性续跑只认它们），索引丢了可随时重建——
 * 索引**不得**成为状态的第二来源，否则索引与真源不一致时行为不可复现。
 *
 * ## 为什么从 world.ts 拆出来（2026-10-08，chunk 维度）
 *
 * 此前这段 ~150 行与"地形哈希推导 + 建筑真源表 + 占位索引 + tag 倒排索引"
 * 挤在一个 World 类里，读者很难判断"我在读哪一层"：读 tileAt 以为是纯函数推导，
 * 读到 buildingsInChunks 才发现是**派生索引 + 增量维护协议**（有 7 个调用点，
 * 每处一个 `if (ready)` 守卫）。两类职责的性质相反：
 *   - 地形/真源表是**状态**（存档认它、读档还它）；
 *   - 区块索引是**可丢弃的派生视图**（错了就重建，永不需要随档）。
 * 拆开后增量维护协议（`if (ready)` 守卫）收口在 ChunkIndex 内部，World 只剩
 * 一行调用，"哪个写入点忘了同步索引"这类沉默故障的攻击面从 7 处缩到 1 处。
 *
 * ## 唯一不变量
 *
 * **索引不得成为第二事实来源**：桶里出现的每一个 id/键，都必须在对应真源表里
 * 存在（`buildingsInChunk` 对每个 id 回查真源表，查不到就跳过而不是崩）。
 * 这条不变量保证索引即使漏维护/被污染也不会产生"幽灵实体"，最坏只是漏发一块。
 *
 * ## 依赖方向
 *
 * ChunkIndex → shared/chunks（几何）+ sim/types（类型）。**不**依赖 World、
 * 不依赖 tuning、不依赖 sim——它只对"三张真源表"这个形状负责，
 * 所以能用假表在 node 里直接单测（见 src/__tests__/chunk-index-direct.test.ts）。
 */
import { tileChunkKey, tileKeyChunk } from '../shared/chunks';
import type { BuildingState } from './types';

/**
 * 三张真源表的访问面。用**函数**而不是 Map 引用：
 * `World.importState` 会整包**替换** featureLeft / harvestCd 对象
 * （`this.featureLeft = new Map(...)`），构造时捕获的引用会在读档后指向旧表，
 * 表现为"读档后某些区块收不到同步"。按调用时取就天然免疫这一类缺陷。
 */
export interface ChunkSources {
  buildings(): Map<string, BuildingState>;
  featureLeft(): Map<string, number>;
  harvestCd(): Map<string, number>;
}

export class ChunkIndex {
  private readonly sources: ChunkSources;
  /** chunkKey → 该块内的建筑 id 集合。decode 只走 tileChunkKey（见 shared/chunks 纪律段）。 */
  private buildingChunks = new Map<number, Set<string>>();
  /** chunkKey → 该块内 featureLeft 的 "x,y" 键集合 */
  private featureChunks = new Map<number, Set<string>>();
  /** chunkKey → 该块内 harvestCd 的 "x,y" 键集合 */
  private harvestChunks = new Map<number, Set<string>>();
  /** 建筑 id → 它所属的 chunkKey（移动/删除时反查用，避免重算坐标） */
  private buildingChunkOf = new Map<string, number>();
  /** 惰性建立索引：首次访问区块视图时从真源表全量派生一次，之后走增量维护 */
  private ready = false;

  constructor(sources: ChunkSources) {
    this.sources = sources;
  }

  private ensure(): void {
    if (this.ready) return;
    this.ready = true;
    const { buildings, featureLeft, harvestCd } = this.sources;
    for (const id of buildings().keys()) this.indexBuilding(id);
    for (const k of featureLeft().keys()) this.bucket(this.featureChunks, tileKeyChunk(k), k);
    for (const k of harvestCd().keys()) this.bucket(this.harvestChunks, tileKeyChunk(k), k);
  }

  private bucket(map: Map<number, Set<string>>, ck: number, member: string): void {
    let s = map.get(ck);
    if (!s) {
      s = new Set();
      map.set(ck, s);
    }
    s.add(member);
  }

  private unbucket(map: Map<number, Set<string>>, ck: number, member: string): void {
    const s = map.get(ck);
    if (!s) return;
    s.delete(member);
    if (s.size === 0) map.delete(ck);
  }

  private indexBuilding(id: string): void {
    const b = this.sources.buildings().get(id);
    if (!b) return;
    const { key } = tileChunkKey(b.pos.x, b.pos.y);
    this.bucket(this.buildingChunks, key, id);
    this.buildingChunkOf.set(id, key);
  }

  // ================= 读取面（派生视图，调用方只读） =================

  /** 单个区块的建筑视图（按需派生，不缓存数组——每帧调用会重复分配） */
  buildingsInChunk(ck: number): BuildingState[] {
    this.ensure();
    const ids = this.buildingChunks.get(ck);
    if (!ids) return [];
    const out: BuildingState[] = [];
    const buildings = this.sources.buildings();
    for (const id of ids) {
      const b = buildings.get(id);
      if (b) out.push(b);
    }
    return out;
  }

  /** 一批区块的建筑（**热路径**：delta 500ms 一次 × 连接数；先去重再取，避免
   *  同一栋建筑在边界区块被算两次——既省 structuredClone 也防客户端重复投影） */
  buildingsInChunks(cks: Iterable<number>): BuildingState[] {
    this.ensure();
    const seen = new Set<string>();
    const out: BuildingState[] = [];
    const buildings = this.sources.buildings();
    for (const ck of cks) {
      const ids = this.buildingChunks.get(ck);
      if (!ids) continue;
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const b = buildings.get(id);
        if (b) out.push(b);
      }
    }
    return out;
  }

  /** 一批区块的特征余量增量（featureLeft 同样要分区同步：采过的树在远端也要显示"剩 2 木"） */
  featureLeftInChunks(cks: Iterable<number>): [string, number][] {
    this.ensure();
    const seen = new Set<string>();
    const out: [string, number][] = [];
    const featureLeft = this.sources.featureLeft();
    for (const ck of cks) {
      const ks = this.featureChunks.get(ck);
      if (!ks) continue;
      for (const k of ks) {
        if (seen.has(k)) continue;
        seen.add(k);
        const v = featureLeft.get(k);
        if (v !== undefined) out.push([k, v]);
      }
    }
    return out;
  }

  /** 一批区块的再生冷却（决定 featureAt 返回 null——不同步则客户端会显示已采空的树） */
  harvestCdInChunks(cks: Iterable<number>): [string, number][] {
    this.ensure();
    const seen = new Set<string>();
    const out: [string, number][] = [];
    const harvestCd = this.sources.harvestCd();
    for (const ck of cks) {
      const ks = this.harvestChunks.get(ck);
      if (!ks) continue;
      for (const k of ks) {
        if (seen.has(k)) continue;
        seen.add(k);
        const v = harvestCd.get(k);
        if (v !== undefined) out.push([k, v]);
      }
    }
    return out;
  }

  /** 当前所有"有内容的区块"的键集合（服务器调度/tick 分片要用的调度单位集合） */
  activeChunkKeys(): number[] {
    this.ensure();
    const out = new Set<number>();
    for (const ck of this.buildingChunks.keys()) out.add(ck);
    for (const ck of this.featureChunks.keys()) out.add(ck);
    for (const ck of this.harvestChunks.keys()) out.add(ck);
    return [...out];
  }

  /**
   * 区块归属导出（存档 diff 面）：每块只记"该块有哪些实体 id"。
   *
   * 与归档旧实现 serializeChunks 的差别（有意为之）：旧实现导出的是**覆盖层
   * tile 索引**，因为旧世界模型里玩家能改写地形，必须把差异存下来。
   * v3 没有那条路径（砍树只加冷却，见 world.ts 文件头），所以这里没有 tile 差异可存，
   * 导出 tile 只会得到"每块 4096 个数字"的巨档（64×64 布局下 3×3 块 = 36864 项），
   * 而信息量与全量 buildings 段完全重复。故只记实体归属。
   *
   * 输出**确定性**：按 key 升序（Map 插入序依赖历史，会让同一世界导出两种字节序，
   * 存档对拍与 git diff 会变得不可用）。
   */
  exportChunks(): { key: number; buildingIds: string[] }[] {
    this.ensure();
    const out: { key: number; buildingIds: string[] }[] = [];
    for (const ck of [...this.buildingChunks.keys()].sort((a, b) => a - b)) {
      const ids = this.buildingChunks.get(ck);
      if (!ids || ids.size === 0) continue;
      // id 排序：建筑表是 Map，插入序=建造序；跨存档对比需要稳定序
      out.push({ key: ck, buildingIds: [...ids].sort() });
    }
    return out;
  }

  // ================= 增量维护面（World 的每个写入点调一处） =================

  /**
   * 索引尚未建立时全部是 no-op：`ensure()` 首次访问会按真源表全量派生，
   * 那时"之前漏维护的增量"已经被覆盖掉了。这是此前 World 里那 7 处
   * `if (this.chunkIndexReady)` 守卫的收口——守卫留在索引内部，调用方不再需要知道它。
   */

  /** addBuilding 之后调用：登记新建筑所属区块。 */
  buildingAdded(id: string): void {
    if (!this.ready) return;
    this.indexBuilding(id);
  }

  /** removeBuilding 之后调用：从所属区块摘除（id 反查桶，避免重算坐标）。 */
  buildingRemoved(id: string): void {
    if (!this.ready) return;
    const ck = this.buildingChunkOf.get(id);
    if (ck !== undefined) this.unbucket(this.buildingChunks, ck, id);
    this.buildingChunkOf.delete(id);
  }

  /** takeOne 之后 featureLeft 仍有值时调用：入余量桶（首次开采也会走到这里）。 */
  featureTaken(k: string): void {
    if (!this.ready) return;
    this.bucket(this.featureChunks, tileKeyChunk(k), k);
  }

  /**
   * 特征采空时调用：余量出桶 + 冷却入桶，**两个桶必须成对维护**。
   * 漏任何一侧的后果不同但同样沉默——只删余量→远端仍显示"剩 N 份"；
   * 只加冷却→远端显示树不见了（其实只是进冷却）。故两行必须成对。
   */
  featureDepleted(k: string): void {
    if (!this.ready) return;
    const ck = tileKeyChunk(k);
    this.unbucket(this.featureChunks, ck, k);
    this.bucket(this.harvestChunks, ck, k);
  }

  /** 冷却到期惰性清除后调用：出冷却桶。
   *  索引同步出桶：不同步的话该块会一直挂着一个空壳成员，
   *  客户端同步 harvestCd 时会收到一条指向已删除 key 的记录（无害但脏，且掩盖真 bug）。 */
  featureRegrown(k: string): void {
    if (!this.ready) return;
    this.unbucket(this.harvestChunks, tileKeyChunk(k), k);
  }

  /**
   * 丢弃派生索引（读档/整包替换后调用，下次访问自动重建）。
   *
   * 读档整包替换：派生索引必然与新真源表不一致，必须整体丢弃重建。
   * 逐条"增量修补"在这里是陷阱——存档里的键可能来自任意区块集合，
   * 修补逻辑一旦漏一条，索引就会静默指向旧世界（表现为"读档后某些区块收不到同步"）。
   */
  invalidate(): void {
    this.ready = false;
    this.buildingChunks.clear();
    this.featureChunks.clear();
    this.harvestChunks.clear();
    this.buildingChunkOf.clear();
  }
}
