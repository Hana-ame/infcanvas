/**
 * schema.ts —— 存档数据结构的纯类型定义（叶子模块：不依赖 sim / sim-save）。
 *
 * 为什么独立：SaveData 同时被 sim.ts（restore 参数）与 sim-save.ts（序列化目标）
 * 引用，放在 sim-save.ts 里造成 type-level 双向（SCC）。拆到叶子后 SCC 减少一个。
 * 本文件只 import types.ts 的共享类型，零运行时依赖。
 */
import type { BuildingState, Hostile, LogEvent, PawnState } from './types';

/** 存档结构（JSON 直接可序列化）。字段语义见各归属模块。 */
export interface SaveData {
  saveVersion: number;
  seed: number;
  time: number;
  rngState: number;
  nextEid: number;
  nextHostileId: number;
  pawns: PawnState[];
  hostiles: Hostile[];
  stockpile: Record<string, number>;
  relations: [string, number][];
  events: LogEvent[];
  world: {
    buildings: BuildingState[];
    featureLeft: [string, number][];
    harvestCd: [string, number][];
    nextBuildingId: number;
    /**
     * 按区块归类的世界增量（v4 新增，line/net）。
     *
     * **形状 = diff**（对齐归档旧实现 test/src/sim/core/world.ts 的 serializeChunks
     * 思路：只记"与生成层/默认态的差异"，不记全量）。这里没有"生成层"可言——
     * v3 的地形是 hash 推导，所以 diff 的基准是"空"：每条记录是某区块内
     * **被改动过的实体 id 列表**，配合全量段即可重建：
     *   buildings = concat(worldChunks[].buildingIds)
     *
     * 保留它而不直接删掉的三个理由：
     *  1. **分区块读取**：`loadChunksOf(key)` 让你只读某几块的存档（未来的
     *     局部加载/存档分片）；没有它，想按区块存就只能重解析整个 JSON。
     *  2. **可校验**：区块归属是"每个 id 恰好出现在一块"的强不变量，
     *     实测（chunk-save 测试）比不变量一旦被破坏，说明增量维护漏了一条路径。
     *  3. **向前兼容**：实体状态将来下沉到区块（真正的双图层）时，
     *     存档形状不用再改一次。
     *
     * 空数组 = 无索引（等价于旧档）：读档侧只做校验不做裁剪。
     */
    worldChunks?: {
      /** chunk 键（编码见 shared/chunks.ts；**不要自己写解码**） */
      key: number;
      /** 该块的建筑 id（与全量段 buildings 一一对应，不复制实体体） */
      buildingIds: string[];
    }[];
  };
  /** 玩法包运行态（ctx.scratch）原样随档 */
  scratch: Record<string, number>;
  /**
   * 科技抽卡池状态（R2-1，v3 新增）：
   *  - techs：已解锁科技 id 列表（tuning.techs 表键）；
   *  - techFragments：各科技已攒碎片数 techId → 碎片数（已解锁的科技会清零）。
   * 两字段缺省 = 空进度（旧档迁移/新开档），语义等价，无需区分"缺失"与"空"。
   */
  techs: string[];
  techFragments: Record<string, number>;
}
