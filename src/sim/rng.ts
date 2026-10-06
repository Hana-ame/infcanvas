/**
 * rng.ts —— 确定性随机数（mulberry32）。
 *
 * 为什么自己造：模拟必须可复现（同 seed 同历史），Math.random 不可复现也不可注入。
 * mulberry32 体量小、分布均匀、无依赖；旧项目（test/ 归档）验证过同一实现。
 * 铁律：src/sim 与玩法包内禁止直接使用 Math.random，一切随机走 ctx.rng()。
 */
export type Rng = () => number;

/** 可保存状态的随机流：确定性续跑（存档→读档→继续）要求随机数发生器的内部状态随档。
 *  RngFn 仍是普通可调用函数（兼容 Rng 类型），额外挂 state 存取。 */
export interface RngFn {
  (): number;
  /** 当前内部状态（读档时回填即可无损续跑） */
  getState(): number;
  setState(s: number): void;
}

/** 由整数种子构造确定性随机流（种子可为任意 32 位整数，负数取无符号） */
export function mulberry32(seed: number): RngFn {
  let a = seed >>> 0;
  const f = (() => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as RngFn;
  f.getState = () => a >>> 0; // 规范化无符号：|0 运算会让 a 带符号，同一位型存出两种数字（真实踩坑）
  f.setState = (s: number) => {
    a = s >>> 0;
  };
  return f;
}

/** 世界生成用的坐标哈希：把 (x,y,salt) 混成 0..1 的确定性值。
 *  无限地图不存整表，tile/feature 全靠它现场推导——必须与坐标一一对应且稳定。 */
export function hash2(x: number, y: number, salt: number): number {
  // >>> 保证无符号移位（曾踩坑：算术右移 >> 会产生负值破坏值域）
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b9)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  // 归一化必须先 >>>0：上一步异或是带符号 int32 运算，负值会让输出落在
  // (-0.5,0.5]，下游所有"按值域切分"的阈值全部被扭曲（真实踩坑：湖泊覆盖率虚高）
  return (h >>> 0) / 4294967296; // 0..1
}
