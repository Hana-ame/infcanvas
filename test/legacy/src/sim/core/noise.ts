// 值噪声（value noise）—— Minecraft-like 地形生成的核心
// 确定性：同 seed 同坐标同输出（基于 SimRng 哈希）

import { SimRng } from './rng';
import type { TileDef } from '../defs';

// 哈希函数（确定性伪随机：相同 x/y/seed → 相同值；用于 chunk tile 生成）
function hash(x: number, y: number, seed: number): number {
  // 整数哈希（确定性）
  let h = (x * 374761393 + y * 668265263 + seed * 974634511) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 平滑插值（平滑步阶）
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

// 单层值噪声：-1..1
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const v00 = hash(xi, yi, seed);
  const v10 = hash(xi + 1, yi, seed);
  const v01 = hash(xi, yi + 1, seed);
  const v11 = hash(xi + 1, yi + 1, seed);
  const ux = smooth(xf);
  const uy = smooth(yf);
  const a = v00 + (v10 - v00) * ux;
  const b = v01 + (v11 - v01) * ux;
  return (a + (b - a) * uy) * 2 - 1;
}

// 分形叠加（fBm）：多层噪声叠加，scale 控制波长
export function fbm(x: number, y: number, seed: number, octaves = 4, baseScale = 0.03): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * baseScale * freq, y * baseScale * freq, seed + o * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// 生物群系分段阈值（-0.25/-0.14/0.28/0.5/0.62 等）硬编码于本文件：分段表未数据化，
// 改动阈值须同步 tiles defs（可走性/资源）与 world.ts 的出生点保证逻辑（ensureSpawn*）

// 地形种子三元组（从全局 seed 确定性派生）：海拔/湿度/细节三轴
//（DESIGN §370 双图层：生成层 = seededRng(chunkX,chunkY) 即得、任何人重生成结果一致——
//  这里不按 chunk 派生种子，而是全局种子派生三轴 + 逐坐标 hash，同样满足"同 seed 同坐标同输出"）
// 2026-08-15 数据化：spice/flax/red/blue/yellow 点缀轴已迁出（玩法点缀 = TileDef.sparse
// 声明 + buildSparsePatches 派生轴种子）——内核 BiomeSeeds 只留引擎自身的地形骨架轴
export interface BiomeSeeds { elev: number; moist: number; detail: number; sparse: number }

// 从主种子派生子种子（各生物群系独立 noise 种子，避免沙漠和雪原用同一 noise）
export function deriveBiomeSeeds(seed: number): BiomeSeeds {
  const rng = new SimRng(seed);
  return {
    elev: rng.int(1, 2 ** 31 - 1),
    moist: rng.int(1, 2 ** 31 - 1),
    detail: rng.int(1, 2 ** 31 - 1),
    // 稀疏化种子独立派生：树墙破口是坐标化 hash（无限地图懒生成 chunk 时
    // 不能依赖"全图顺序 rng 流"——否则第 N 个 chunk 的破口依赖前面所有格子的消费序）
    sparse: rng.int(1, 2 ** 31 - 1),
  };
}

// 点缀规则条目（2026-08-15 数据驱动：玩法地形由包注册 TileDef.sparse 声明，
// World 构造时 buildSparsePatches 收集 + 按 defs 收集序从主 seed 派生轴种子——
// 懒生成确定性：种子在构造时固定，chunk 生成纯坐标 hash 查表）
export interface SparsePatch {
  tileId: string;
  seed: number;    // 独立点缀轴种子（改任一密度不影响其它点缀的坐标 hash）
  density: number; // 在 on 地形上点缀的概率
  on: string;      // 宿主地形 id（缺省 'grass'）
}

// 从 tiles defs 收集点缀声明（顺序 = defs 收集序，确定性；每个条目独立轴种子）
export function buildSparsePatches(seed: number, tiles: Record<string, TileDef>): SparsePatch[] {
  const rng = new SimRng(seed); // 独立 rng 实例：与 deriveBiomeSeeds 的派生互不影响
  const out: SparsePatch[] = [];
  for (const [id, d] of Object.entries(tiles)) {
    if (!d.sparse) continue;
    out.push({ tileId: id, seed: rng.int(1, 2 ** 31 - 1), density: d.sparse.density, on: d.sparse.on ?? 'grass' });
  }
  return out;
}

// 单格地形（无限地图 chunk 懒生成的核心纯函数）：任意坐标 → TileId，确定性
export function tileAt(x: number, y: number, s: BiomeSeeds, patches?: readonly SparsePatch[]): string {
  // 海拔（低/中/高 三频叠加 → 大陆轮廓 + 山脉）
  const elevation = fbm(x, y, s.elev, 4, 0.018);
  // 湿度（决定森林/沙漠/草地）
  const moisture = fbm(x + 500, y + 500, s.moist, 3, 0.02);
  // 细节噪声（树/矿点缀）
  const detail = valueNoise(x * 0.3, y * 0.3, s.detail);

  let tile: string;
  if (elevation < -0.25) {
    tile = 'water'; // 海洋
  } else if (elevation < -0.14) {
    tile = 'sand'; // 海滩
  } else if (elevation < 0.28) {
    // 低地平原：湿度决定草地/沙漠/森林
    if (moisture > 0.35) tile = 'tree'; // 湿润 → 森林
    else if (moisture < -0.35) tile = 'desert'; // 干燥 → 沙漠
    else tile = detail > 0.28 ? 'tree' : 'grass'; // 草地稀疏点缀树
  } else if (elevation < 0.5) {
    // 丘陵：草地丘陵 + 石头缓坡（z1，Δ1 鼠人可上——缓坡是低地到石丘 z2 的过渡带，
    // 2026-08-14 高差地图：生成高低层次 低地 z0 → 缓坡 z1 → 石丘 z2）
    if (detail > 0.6) tile = 'stone';
    else if (moisture > 0.35 || detail > 0.45) tile = 'tree';
    else tile = 'grass';
  } else if (elevation < 0.62) {
    // 山地边缘：石丘（stone z2，Δ2 高地——鼠人 climb1 上不去，需修路/地道翻越）+ 矿
    //（ore z1 在石丘带内：石丘上的矿脉，缓坡可爬）
    tile = detail > 0.35 ? 'ore' : 'stone';
  } else {
    tile = 'mountain'; // 高山
  }
  // 稀疏化：成片森林随机破口（树不可通行，否则平滑噪声的树墙会碎片化世界，
  // 实测出生点可达面积仅 0.1% —— 全图几乎无法探索）
  if (tile === 'tree' && hash(x, y, s.sparse) < 0.25) tile = 'grass';
  // 玩法点缀（2026-08-15 数据驱动）：tileAt 不再写死任何玩法地形——全部走
  // SparsePatch 表（TileDef.sparse 声明，World 构造收集）。宿主地形命中 + 坐标 hash
  // < 密度 → 换成本地形；每条目独立轴种子，互不干扰
  if (patches) {
    for (const p of patches) {
      if (tile === p.on && hash(x, y, p.seed) < p.density) { tile = p.tileId; break; }
    }
  }
  return tile;
}

// 生成地形图：返回 width*height 的 TileId 数组（确定性；有限区域批处理 = tileAt 批量版）
export function generateBiomeMap(width: number, height: number, seed: number, patches?: readonly SparsePatch[]): string[] {
  const s = deriveBiomeSeeds(seed);
  const out: string[] = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = tileAt(x, y, s, patches);
    }
  }
  return out;
}
