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

export const SAVE_VERSION = 2;

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
  };
  /** 玩法包运行态（ctx.scratch）原样随档 */
  scratch: Record<string, number>;
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
