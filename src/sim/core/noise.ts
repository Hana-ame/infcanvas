// 值噪声（value noise）—— Minecraft-like 地形生成的核心
// 确定性：同 seed 同坐标同输出（基于 SimRng 哈希）

import { SimRng } from './rng';

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

// 生成地形图：返回 width*height 的 TileId 数组（确定性）
// 双轴：海拔 + 湿度 → 生物群系
export function generateBiomeMap(width: number, height: number, seed: number): string[] {
  const rng = new SimRng(seed);
  const elevSeed = rng.int(1, 2 ** 31 - 1);
  const moistSeed = rng.int(1, 2 ** 31 - 1);
  const detailSeed = rng.int(1, 2 ** 31 - 1);
  const out: string[] = new Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 海拔（低/中/高 三频叠加 → 大陆轮廓 + 山脉）
      const elevation = fbm(x, y, elevSeed, 4, 0.018);
      // 湿度（决定森林/沙漠/草地）
      const moisture = fbm(x + 500, y + 500, moistSeed, 3, 0.02);
      // 细节噪声（树/矿点缀）
      const detail = valueNoise(x * 0.3, y * 0.3, detailSeed);

      let tile: string;
      if (elevation < -0.32) {
        tile = 'water'; // 深海
      } else if (elevation < -0.2) {
        tile = 'water'; // 浅海
      } else if (elevation < -0.14) {
        tile = 'sand'; // 海滩
      } else if (elevation < 0.28) {
        // 低地平原：湿度决定草地/沙漠/森林
        if (moisture > 0.25) tile = 'tree'; // 湿润 → 森林
        else if (moisture < -0.35) tile = 'desert'; // 干燥 → 沙漠
        else tile = 'grass';
      } else if (elevation < 0.5) {
        // 丘陵
        if (moisture > 0.3 && detail > 0.2) tile = 'tree';
        else tile = 'grass';
      } else if (elevation < 0.62) {
        // 山地边缘：石头 + 矿
        tile = detail > 0.35 ? 'ore' : 'stone';
      } else {
        tile = 'mountain'; // 高山
      }
      out[y * width + x] = tile;
    }
  }
  return out;
}
