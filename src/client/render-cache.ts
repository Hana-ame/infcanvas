/**
 * client/render-cache.ts —— RimWorld 原版风格哑光大地色系地形区块渲染缓存层
 *  - 山体 (Solid Mountain) 采用与墙体一致的八向（含四对角内角）无缝连接算法：相邻山体格内部消除接缝边框，拼合成连绵一体的厚重岩层，仅在外露边缘与内拐角绘制深色轮廓线与南侧 3D 立体岩壁斜切面；
 *  - 草地 (Grass) 采用湿度平滑聚簇算法：肥沃湿润草地呈现深浅交替的草甸色块与成簇多叶草丛，消除网格化噪点。
 */
import { type Container, Graphics } from 'pixi.js';
import { CHUNK_SIZE } from '../shared/chunks';
import type { ChunkTerrain as TerrainChunkView } from './view';

interface CachedChunk {
  cx: number;
  cy: number;
  g: Graphics;
  lastSeen: number;
}

function cellHash(x: number, y: number, salt: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b9)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function smoothNoise(x: number, y: number, salt: number, scale: number): number {
  const gx = Math.floor(x / scale);
  const gy = Math.floor(y / scale);
  const fx = x / scale - gx;
  const fy = y / scale - gy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = cellHash(gx, gy, salt);
  const n10 = cellHash(gx + 1, gy, salt);
  const n01 = cellHash(gx, gy + 1, salt);
  const n11 = cellHash(gx + 1, gy + 1, salt);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
}

export class RenderCache {
  private chunks = new Map<string, CachedChunk>();
  private frameN = 0;
  readonly maxChunks: number;
  readonly chunkSize: number;
  tilePx: number;
  readonly maxZ: number;
  private hasSlopeFn?: (x: number, y: number) => boolean;

  constructor(
    private terrainSource: {
      terrainChunk(cx: number, cy: number): TerrainChunkView;
      tileAt?(x: number, y: number): string;
      zAt?(x: number, y: number): number;
    },
    private terrainLayer: Container,
    opts: {
      maxChunks?: number;
      chunkSize?: number;
      tilePx?: number;
      maxZ?: number;
      hasSlopeAt?: (x: number, y: number) => boolean;
    } = {},
  ) {
    this.maxChunks = opts.maxChunks ?? 256;
    this.chunkSize = opts.chunkSize ?? CHUNK_SIZE;
    this.tilePx = opts.tilePx ?? 24;
    this.maxZ = opts.maxZ ?? 4;
    this.hasSlopeFn = opts.hasSlopeAt;
  }

  setTilePx(newTilePx: number): void {
    if (Math.abs(newTilePx - this.tilePx) < 0.001) return;
    this.tilePx = newTilePx;
    this.clear();
  }

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  sync(x0: number, y0: number, x1: number, y1: number): void {
    this.frameN++;
    const cx0 = Math.floor(x0 / CHUNK_SIZE);
    const cx1 = Math.floor(x1 / CHUNK_SIZE);
    const cy0 = Math.floor(y0 / CHUNK_SIZE);
    const cy1 = Math.floor(y1 / CHUNK_SIZE);

    const want = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    if (want > this.maxChunks) return;

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = this.key(cx, cy);
        const existing = this.chunks.get(k);
        if (existing) {
          existing.lastSeen = this.frameN;
          continue;
        }
        const t = this.terrainSource.terrainChunk(cx, cy);
        const g = this.bakeChunk(t, cx, cy);
        this.terrainLayer.addChild(g);
        this.chunks.set(k, { cx, cy, g, lastSeen: this.frameN });
      }
    }

    if (this.chunks.size > this.maxChunks) {
      const sorted = [...this.chunks.values()].sort((a, b) => a.lastSeen - b.lastSeen);
      const toEvict = this.chunks.size - this.maxChunks;
      for (let i = 0; i < toEvict && i < sorted.length; i++) {
        const e = sorted[i];
        if (e.lastSeen === this.frameN) break;
        this.evict(this.key(e.cx, e.cy));
      }
    }

    const inView = new Set<string>();
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) inView.add(this.key(cx, cy));
    }
    for (const [k, cache] of this.chunks) {
      if (!inView.has(k) && cache.lastSeen < this.frameN) {
        this.evict(k);
      }
    }
  }

  reposition(_camX: number, _camY: number, _tilePx: number): { x: number; y: number } {
    return { x: 0, y: 0 };
  }

  clear(): void {
    for (const cache of this.chunks.values()) {
      this.terrainLayer.removeChild(cache.g);
      cache.g.destroy();
    }
    this.chunks.clear();
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  private bakeChunk(t: TerrainChunkView, cx: number, cy: number): Graphics {
    const g = new Graphics();
    const size = t.size;
    const tilePx = this.tilePx;
    const gAny = g as unknown as {
      _bitmapBounds?: { x: number; y: number; w: number; h: number };
    };
    gAny._bitmapBounds = {
      x: cx * size * tilePx,
      y: cy * size * tilePx,
      w: size * tilePx + 1,
      h: size * tilePx + 1,
    };

    const isMtnAt = (lx: number, ly: number): boolean => {
      if (lx >= 0 && lx < size && ly >= 0 && ly < size) {
        const idx = ly * size + lx;
        return t.kinds[idx] === 'stone' && t.zs[idx] >= 3;
      }
      const wx = cx * size + lx;
      const wy = cy * size + ly;
      if (this.terrainSource.tileAt && this.terrainSource.zAt) {
        return this.terrainSource.tileAt(wx, wy) === 'stone' && this.terrainSource.zAt(wx, wy) >= 3;
      }
      return false;
    };

    const isLocalSlope = (lx: number, ly: number): boolean => {
      const tx = cx * size + lx;
      const ty = cy * size + ly;
      if (this.hasSlopeFn && this.hasSlopeFn(tx, ty)) return true;
      if (lx < 0 || lx >= size || ly < 0 || ly >= size) return false;
      const idx = ly * size + lx;
      const k = t.kinds[idx];
      const z = t.zs[idx];
      if (k === 'water' || (k === 'stone' && z >= 3) || z >= 3) return false;
      const zN = ly > 0 ? t.zs[idx - size] : z;
      const zS = ly < size - 1 ? t.zs[idx + size] : z;
      const zW = lx > 0 ? t.zs[idx - 1] : z;
      const zE = lx < size - 1 ? t.zs[idx + 1] : z;
      const hasStep =
        Math.abs(z - zN) === 1 ||
        Math.abs(z - zS) === 1 ||
        Math.abs(z - zW) === 1 ||
        Math.abs(z - zE) === 1;
      return hasStep && ((tx * 7 + ty * 13) & 7) === 0;
    };

    for (let ly = 0; ly < size; ly++) {
      const y = cy * size + ly;
      const row = ly * size;
      for (let lx = 0; lx < size; lx++) {
        const i = row + lx;
        const x = cx * size + lx;
        const worldX = x * tilePx;
        const worldY = y * tilePx;
        const kind = t.kinds[i];
        const z = t.zs[i];
        const h1 = cellHash(x, y, 0x101);
        const h2 = cellHash(x, y, 0x202);
        const h3 = cellHash(x, y, 0x303);

        let baseColor = '#565c40';
        let detailColor = '#4c5238';
        let speckleColor = '#616849';
        const isSolidMtn = kind === 'stone' && z >= 3;
        const meadowNoise = smoothNoise(x, y, 0x3f7d, 5.5);

        if (kind === 'water') {
          const nearLand =
            (lx > 0 && t.kinds[i - 1] !== 'water') ||
            (lx < size - 1 && t.kinds[i + 1] !== 'water') ||
            (ly > 0 && t.kinds[i - size] !== 'water') ||
            (ly < size - 1 && t.kinds[i + size] !== 'water');
          baseColor = nearLand ? '#385e78' : '#26455c';
          detailColor = nearLand ? '#466f8c' : '#1d3647';
          speckleColor = '#5884a3';
        } else if (isSolidMtn) {
          baseColor = '#54565a';
          detailColor = '#282b30';
          speckleColor = '#484c54';
        } else if (kind === 'stone') {
          baseColor = '#5c5e61';
          detailColor = '#4e5053';
          speckleColor = '#6b6d70';
        } else if (kind === 'dirt') {
          const dirtPatch = smoothNoise(x, y, 0x51ed, 4.5);
          if (z >= 2) {
            baseColor = '#635c51';
            detailColor = '#544e44';
            speckleColor = '#736b5e';
          } else if (dirtPatch < 0.34 && Math.abs(x) + Math.abs(y) > 8) {
            baseColor = '#917f5e';
            detailColor = '#827152';
            speckleColor = '#a18e6b';
          } else {
            baseColor = '#76644a';
            detailColor = '#67563f';
            speckleColor = '#857155';
          }
        } else {
          if (meadowNoise > 0.6 && z <= 1) {
            baseColor = '#3f4a2e';
            detailColor = '#343e26';
            speckleColor = '#52613b';
          } else if (z >= 2) {
            baseColor = '#5c5b45';
            detailColor = '#4e4d3a';
            speckleColor = '#6a6950';
          } else if (meadowNoise > 0.38) {
            baseColor = '#4d5639';
            detailColor = '#424a30';
            speckleColor = '#5e6946';
          } else {
            baseColor = '#565d40';
            detailColor = '#4b5137';
            speckleColor = '#656d4c';
          }
        }

        g.rect(worldX, worldY, tilePx + 0.5, tilePx + 0.5).fill(baseColor);

        if (tilePx >= 14) {
          if (isSolidMtn) {
            const mtnN = isMtnAt(lx, ly - 1);
            const mtnS = isMtnAt(lx, ly + 1);
            const mtnW = isMtnAt(lx - 1, ly);
            const mtnE = isMtnAt(lx + 1, ly);
            const mtnNW = mtnN && mtnW && isMtnAt(lx - 1, ly - 1);
            const mtnNE = mtnN && mtnE && isMtnAt(lx + 1, ly - 1);
            const mtnSW = mtnS && mtnW && isMtnAt(lx - 1, ly + 1);
            const mtnSE = mtnS && mtnE && isMtnAt(lx + 1, ly + 1);

            if (!mtnS) {
              g.rect(worldX, worldY + tilePx, tilePx + (mtnE ? 0.6 : 0), Math.max(2.5, tilePx * 0.12)).fill({
                color: 0x000000,
                alpha: 0.35,
              });
            }

            g.rect(worldX, worldY, tilePx + (mtnE ? 0.6 : 0), tilePx + (mtnS ? 0.6 : 0)).fill('#36393f');

            const bevelH = Math.max(3.8, Math.round(tilePx * 0.22));
            const inset = Math.max(2.5, Math.round(tilePx * 0.14));
            if (!mtnS) {
              g.rect(worldX, worldY + tilePx - bevelH, tilePx + (mtnE ? 0.6 : 0), bevelH).fill('#22252a');
            } else {
              if (mtnW && !mtnSW) g.rect(worldX, worldY + tilePx - bevelH, inset + 0.6, bevelH).fill('#22252a');
              if (mtnE && !mtnSE) g.rect(worldX + tilePx - inset, worldY + tilePx - bevelH, inset + 0.6, bevelH).fill('#22252a');
            }

            // 八向自适应山体顶面受光岩层
            const sTopInset = mtnS ? inset : bevelH;
            const cW = Math.max(2, tilePx - inset * 2);
            const cH = Math.max(2, tilePx - inset - sTopInset);
            g.rect(worldX + inset, worldY + inset, cW, cH).fill('#454952');
            if (mtnN) g.rect(worldX + inset, worldY, cW, inset + 0.6).fill('#454952');
            if (mtnS) g.rect(worldX + inset, worldY + tilePx - sTopInset, cW, sTopInset + 0.6).fill('#454952');
            if (mtnW) g.rect(worldX, worldY + inset, inset + 0.6, Math.max(2, tilePx - inset - bevelH)).fill('#454952');
            if (mtnE) g.rect(worldX + tilePx - inset, worldY + inset, inset + 0.6, Math.max(2, tilePx - inset - bevelH)).fill('#454952');
            if (mtnNW) g.rect(worldX, worldY, inset + 0.6, inset + 0.6).fill('#454952');
            if (mtnNE) g.rect(worldX + tilePx - inset, worldY, inset + 0.6, inset + 0.6).fill('#454952');
            if (mtnSW) g.rect(worldX, worldY + tilePx - bevelH, inset + 0.6, bevelH + 0.6).fill('#454952');
            if (mtnSE) g.rect(worldX + tilePx - inset, worldY + tilePx - bevelH, inset + 0.6, bevelH + 0.6).fill('#454952');

            if (h1 < 0.32 && tilePx >= 18) {
              const crX = worldX + tilePx * (0.28 + h2 * 0.4);
              const crY = worldY + tilePx * (0.28 + h3 * 0.35);
              g.moveTo(crX - 3, crY)
                .lineTo(crX + 1.5, crY + 2)
                .lineTo(crX + 4.5, crY - 0.5)
                .stroke({ width: 1.1, color: '#2b2e34', alpha: 0.65 });
            }

            const lineCol = '#141619';
            if (!mtnN) g.moveTo(worldX, worldY).lineTo(worldX + tilePx + (mtnE ? 0.5 : 0), worldY).stroke({ width: 1.8, color: lineCol });
            if (!mtnS) g.moveTo(worldX, worldY + tilePx).lineTo(worldX + tilePx + (mtnE ? 0.5 : 0), worldY + tilePx).stroke({ width: 2.0, color: lineCol });
            if (!mtnW) g.moveTo(worldX, worldY).lineTo(worldX, worldY + tilePx + (mtnS ? 0.5 : 0)).stroke({ width: 1.8, color: lineCol });
            if (!mtnE) g.moveTo(worldX + tilePx, worldY).lineTo(worldX + tilePx, worldY + tilePx + (mtnS ? 0.5 : 0)).stroke({ width: 1.8, color: lineCol });
            if (mtnN && mtnW && !mtnNW) g.rect(worldX, worldY, 2.2, 2.2).fill(lineCol);
            if (mtnN && mtnE && !mtnNE) g.rect(worldX + tilePx - 2.2, worldY, 2.2, 2.2).fill(lineCol);
            if (mtnS && mtnW && !mtnSW) g.rect(worldX, worldY + tilePx - 2.2, 2.2, 2.2).fill(lineCol);
            if (mtnS && mtnE && !mtnSE) g.rect(worldX + tilePx - 2.2, worldY + tilePx - 2.2, 2.2, 2.2).fill(lineCol);
          } else if (kind === 'water') {
            if (h1 < 0.35) {
              g.ellipse(
                worldX + tilePx * 0.5,
                worldY + tilePx * (0.38 + h2 * 0.25),
                tilePx * 0.24,
                tilePx * 0.06,
              ).fill({ color: detailColor, alpha: 0.45 });
            }
          } else if (kind === 'grass') {
            if (meadowNoise > 0.36 && h1 < meadowNoise * 0.72) {
              g.ellipse(
                worldX + tilePx * (0.3 + h2 * 0.4),
                worldY + tilePx * (0.32 + h3 * 0.38),
                tilePx * 0.14,
                tilePx * 0.09,
              ).fill({ color: detailColor, alpha: 0.3 });
            }
            const tuftChance = meadowNoise > 0.56 ? 0.62 : meadowNoise > 0.38 ? 0.32 : 0.12;
            if (h2 < tuftChance && tilePx >= 18) {
              const tuftCount = meadowNoise > 0.58 && h3 > 0.45 ? 2 : 1;
              for (let tc = 0; tc < tuftCount; tc++) {
                const gx = worldX + tilePx * (tc === 0 ? 0.24 + h1 * 0.48 : 0.62 - h2 * 0.35);
                const gy = worldY + tilePx * (tc === 0 ? 0.34 + h3 * 0.42 : 0.68 - h1 * 0.32);
                const bh = tilePx * (meadowNoise > 0.55 ? 0.19 : 0.14);
                g.moveTo(gx, gy)
                  .lineTo(gx - bh * 0.65, gy - bh * 0.88)
                  .moveTo(gx, gy)
                  .lineTo(gx + bh * 0.1, gy - bh * 1.1)
                  .moveTo(gx, gy)
                  .lineTo(gx + bh * 0.72, gy - bh * 0.82)
                  .stroke({ width: 1.25, color: speckleColor, alpha: 0.78 });
              }
            }
          } else {
            if (h1 < 0.48) {
              g.circle(
                worldX + tilePx * (0.25 + h2 * 0.5),
                worldY + tilePx * (0.25 + h3 * 0.5),
                tilePx * 0.075,
              ).fill({ color: detailColor, alpha: 0.38 });
            }
            if (h2 < 0.36) {
              g.circle(
                worldX + tilePx * (0.65 - h1 * 0.4),
                worldY + tilePx * (0.68 - h2 * 0.4),
                tilePx * 0.055,
              ).fill({ color: speckleColor, alpha: 0.36 });
            }
          }
        }

        if (kind !== 'water' && !isSolidMtn) {
          const waterN = ly > 0 ? t.kinds[i - size] === 'water' : false;
          const waterS = ly < size - 1 ? t.kinds[i + size] === 'water' : false;
          const waterW = lx > 0 ? t.kinds[i - 1] === 'water' : false;
          const waterE = lx < size - 1 ? t.kinds[i + 1] === 'water' : false;
          const bankW = Math.max(2.5, tilePx * 0.16);
          if (waterN) g.rect(worldX, worldY, tilePx, bankW).fill('#756750');
          if (waterS) g.rect(worldX, worldY + tilePx - bankW, tilePx, bankW).fill('#756750');
          if (waterW) g.rect(worldX, worldY, bankW, tilePx).fill('#756750');
          if (waterE) g.rect(worldX + tilePx - bankW, worldY, bankW, tilePx).fill('#756750');
        }

        const zN = ly > 0 ? t.zs[i - size] : z;
        const zS = ly < size - 1 ? t.zs[i + size] : z;
        const zW = lx > 0 ? t.zs[i - 1] : z;
        const zE = lx < size - 1 ? t.zs[i + 1] : z;

        const selfSlope = isLocalSlope(lx, ly);
        const slopeN = isLocalSlope(lx, ly - 1);
        const slopeS = isLocalSlope(lx, ly + 1);
        const slopeW = isLocalSlope(lx - 1, ly);
        const slopeE = isLocalSlope(lx + 1, ly);

        if (z > 0 && !selfSlope && !isSolidMtn) {
          const cliffThick = Math.max(2.2, tilePx * 0.15);
          if (z > zN && !slopeN) g.rect(worldX, worldY, tilePx, cliffThick * 0.8).fill({ color: 0xd8d2c5, alpha: 0.22 });
          if (z > zW && !slopeW) g.rect(worldX, worldY, cliffThick * 0.8, tilePx).fill({ color: 0xd8d2c5, alpha: 0.18 });
          if (z > zS && !slopeS) g.rect(worldX, worldY + tilePx - cliffThick, tilePx, cliffThick).fill({ color: 0x161816, alpha: 0.58 });
          if (z > zE && !slopeE) g.rect(worldX + tilePx - cliffThick, worldY, cliffThick, tilePx).fill({ color: 0x161816, alpha: 0.48 });
        }

        if (selfSlope && tilePx >= 14) {
          const band1 = Math.max(1.5, tilePx * 0.09);
          const band2 = Math.max(3.0, tilePx * 0.18);
          const band3 = Math.max(4.5, tilePx * 0.28);

          g.rect(worldX, worldY, tilePx, band1).fill({ color: detailColor, alpha: 0.24 });
          g.rect(worldX, worldY + tilePx - band1, tilePx, band1).fill({ color: detailColor, alpha: 0.24 });
          g.rect(worldX, worldY, band1, tilePx).fill({ color: detailColor, alpha: 0.24 });
          g.rect(worldX + tilePx - band1, worldY, band1, tilePx).fill({ color: detailColor, alpha: 0.24 });

          g.rect(worldX + band1, worldY + band1, tilePx - band1 * 2, band2 - band1).fill({ color: detailColor, alpha: 0.14 });
          g.rect(worldX + band1, worldY + tilePx - band2, tilePx - band1 * 2, band2 - band1).fill({ color: detailColor, alpha: 0.14 });
          g.rect(worldX + band1, worldY + band1, band2 - band1, tilePx - band1 * 2).fill({ color: detailColor, alpha: 0.14 });
          g.rect(worldX + tilePx - band2, worldY + band1, band2 - band1, tilePx - band1 * 2).fill({ color: detailColor, alpha: 0.14 });

          g.rect(worldX + band2, worldY + band2, tilePx - band2 * 2, band3 - band2).fill({ color: speckleColor, alpha: 0.08 });
          g.rect(worldX + band2, worldY + tilePx - band3, tilePx - band2 * 2, band3 - band2).fill({ color: speckleColor, alpha: 0.08 });
        }

        if (tilePx >= 18 && !selfSlope && !isSolidMtn) {
          g.rect(worldX, worldY, tilePx, 0.7).fill({ color: 0x000000, alpha: 0.05 });
          g.rect(worldX, worldY, 0.7, tilePx).fill({ color: 0x000000, alpha: 0.05 });
        }
      }
    }
    return g;
  }

  private evict(key: string): void {
    const cache = this.chunks.get(key);
    if (!cache) return;
    this.terrainLayer.removeChild(cache.g);
    cache.g.destroy();
    this.chunks.delete(key);
  }
}
