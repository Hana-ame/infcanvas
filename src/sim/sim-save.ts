/**
 * sim-save.ts —— 存档/读档（阶段④：纯 JSON，扩展点原样还原）。
 *
 * 设计要点：
 *  - **版本化**：saveVersion + SAVE_MIGRATIONS 迁移注册表；拒载"比当前更新"的档
 *    （防新格式被旧代码读坏），旧档逐级迁移后读入。
 *  - **确定性续跑**：rng 内部状态随档——读档后继续跑与"没存过档一直跑"逐帧一致
 *    （有专门对拍测试守护）。
 *  - **玩法包运行态**：系统跨 tick 状态必须放 ctx.scratch（键 "<包>.<名>"），
 *    闭包里的状态存档无法还原——raid 压力已按此改造。
 *  - World 只保存增量运行态（featureLeft/harvestCd/建筑自增）；地形特征由 seed 重推。
 */
import { Sim } from './sim';
import type { ModRegistry } from '../mods/registry';
import { mulberry32 } from './rng';
import type { Hostile, LogEvent, PawnState } from './types';

export const SAVE_VERSION = 4;

/** vN → vN+1 的迁移函数表；索引 i = 把 i 版档迁到 i+1 版。缺省迁移 = 显式 no-op。 */
export const SAVE_MIGRATIONS: ((d: Record<string, unknown>) => void)[] = [
  // [0→1] 首个版本化格式；v0 从未发布过其他形态，无需变换
  () => {},
  // [1→2] z 高度模型引入：旧档的鼠没有 climb 字段，统一回填缺省攀爬 1
  // （与 tuning.pawn.climb 出厂值一致；读档后 Sim 不再重算，保持存档事实优先）
  (d) => {
    const pawns = d.pawns as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(pawns)) for (const p of pawns) if (p.climb === undefined) p.climb = 1;
  },
  // [2→3] 科技抽卡池（R2-1）引入：旧档没有 techs / techFragments。
  // 缺省语义 = 空进度（还没抽到任何碎片），**不硬塞出厂科技表**——
  // 填表会把"旧局没科技"变成"旧局已解锁全部科技"，是数据事故。
  (d) => {
    if (d.techs === undefined) d.techs = [];
    if (d.techFragments === undefined) d.techFragments = {};
  },
  // [3→4] 分区块存档（line/net 2026-10-06）：world 段增 worldChunks。
  //
  // 迁移语义：**缺省 = 空索引 = 旧行为**。
  //   worldChunks = [] 意为"本档没有按区块归类的信息"，读档时不据此做任何裁剪，
  //   全量 world 段（buildings/featureLeft/harvestCd）仍是唯一事实。
  //
  // 为什么不给旧档"补算一份索引"：索引是**派生数据**（把 buildings/featureLeft/
  //   harvestCd 按区块分组而来），而读档时 World.ensureChunkIndex 会自动重建。
  //   把重建结果写回存档，等于让存档体积分块数增长，却换不来任何读档收益——
  //   且**派生数据落盘会产生"索引与真源不一致"的第二事实来源**，
  //   那正是确定性续跑最怕的东西。故迁移只声明"字段缺失"，派生留给读档现算。
  (d) => {
    const w = d.world as Record<string, unknown> | undefined;
    if (w && w.worldChunks === undefined) w.worldChunks = [];
  },
];

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
    buildings: import('./types').BuildingState[];
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

/** 深度把 -0 规范成 0：Math.round 会产生负零，JSON 序列化看不出差异，
 *  但严格相等比较（测试/对账）会判不等——存档出口统一清洗（真实踩坑）。 */
function zeroNorm<T>(v: T): T {
  if (v === 0) return 0 as unknown as T;
  if (Array.isArray(v)) return v.map(zeroNorm) as unknown as T;
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = zeroNorm(val);
    return out as unknown as T;
  }
  return v;
}

/** 对外入口：把 Sim 当前状态序列化为可 JSON.stringify 的对象 */
export function snapshotOf(sim: Sim): SaveData {
  return zeroNorm({
    saveVersion: SAVE_VERSION,
    seed: sim.world.seed,
    time: sim.time,
    rngState: sim.rngState(),
    nextEid: sim.nextEidValue(),
    nextHostileId: sim.nextHostileIdValue(),
    pawns: [...sim.pawns()].map((p) => structuredClone(p)),
    hostiles: sim.hostiles().map((h) => structuredClone(h)),
    stockpile: { ...sim.stockpile },
    relations: sim.exportRelations(),
    events: structuredClone(sim.events),
    world: sim.world.exportState(),
    scratch: { ...sim.scratch },
    techs: [...sim.techUnlocked()],
    techFragments: { ...sim.techFragments },
  });
}

/** 校验并迁移到当前版本。抛错 = 拒载（坏档不静默）。 */
export function migrate(raw: unknown): SaveData {
  if (typeof raw !== 'object' || raw === null || !('saveVersion' in raw)) {
    throw new Error('存档格式无效：缺少 saveVersion');
  }
  let d = raw as Record<string, unknown>;
  const v = d.saveVersion as number;
  if (v > SAVE_VERSION) {
    throw new Error(`存档版本过新：${v} > ${SAVE_VERSION}（请升级游戏后再读）`);
  }
  for (let i = v; i < SAVE_VERSION; i++) {
    SAVE_MIGRATIONS[i]?.(d);
  }
  d.saveVersion = SAVE_VERSION;
  return d as unknown as SaveData;
}

/** 读档便利入口：校验/迁移后构造恢复模式的 Sim */
export function loadSim(raw: unknown, registry: ModRegistry): Sim {
  return new Sim({ registry, restore: migrate(raw) });
}