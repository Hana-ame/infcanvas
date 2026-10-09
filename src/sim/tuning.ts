/**
 * tuning.ts —— 薄包装层（模块化审查 T3 拆分后保留向后兼容）。
 *
 * 所有调用方 import from '../sim/tuning' 或 './tuning' 继续工作——
 * 本文件 re-export ./tuning/index 的全部导出。
 * 结构扫描测试（time-source.test.ts）读本文件的源码做正则检查。
 *
 * §0 运行常数真相源在本文件中保持可读性（SIM_DT_SEC / DEFAULT_SEED / DEFAULT_PORT），
 * 因为 time-source.test.ts 对 tuning.ts 做文本扫描验证"dt 不再分裂"。
 */

// §0 运行常数真相源（re-export，保持 time-source.test.ts 的文本扫描可找到）
export {
  SIM_DT_SEC,
  CLIENT_STEP_MULT,
  CLIENT_STEP_SEC,
  RENDER_DT_CLAMP_SEC,
  SERVER_TICK_MS,
  DEFAULT_SEED,
  DEFAULT_PORT,
} from './tuning/index';

// §1+§2 类型（re-export）
export type {
  TileTuningEntry,
  BuildingTuningEntry,
  TechTuningEntry,
  EnemyTuningEntry,
  Tuning,
} from './tuning/index';

// §3 出厂数值（re-export）
export { DEFAULT_TUNING } from './tuning/index';
