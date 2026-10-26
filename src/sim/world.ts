/**
 * world.ts —— 无限确定性地图 + 建筑层（双图层：地形/构筑 + RimWorld 单格唯一占位与植物蔓延层）。
 */
import { hash2 } from './rng';
import { ChunkIndex } from './chunk-index';
import type { BuildingState, FeatureHit, Pos } from './types';
import type { Tuning } from './tuning';

/** 本模块瓦片缓存键（与寻路编码同式） */
function key2(x: number, y: number): number {
  return (x + 32768) * 65536 + (y + 32768);
}

/** 30-bit Smi 整数坐标哈希键（|x|,|y| < 16384 时零堆分配，超出范围回退 key2） */
function smiKey2(x: number, y: number): number {
  if (x >= -16384 && x < 16384 && y >= -16384 && y < 16384) {
    return ((x + 16384) << 15) | ((y + 16384) & 0x7fff);
  }
  return key2(x, y);
}

const SALT_ELEV = 0x7a11;
const SALT_MOIST = 0x3f7d;
const SALT_TILE = 0x51ed;
const SALT_STONE = 0xc3d4;
const SALT_TREE = 0xe5f6;
const SALT_BERRY = 0x0718;
const SALT_BERRY_AMT = 0x1920;
const SALT_TREE_AMT = 0x2122;
const SALT_NATURAL_SLOPE = 0x49e1;

export type TileKind = 'grass' | 'dirt' | 'stone' | 'water';

export interface SpreadPlantEntry {
  kind: FeatureHit['kind'];
  amount: number;
  plantedAt: number;
}

export class World {
  readonly buildings = new Map<string, BuildingState>();
  private occupied = new Map<number, string>();
  private allOccupied = new Map<number, BuildingState>();
  private featureLeft = new Map<string, number>();
  private harvestCd = new Map<string, number>();
  readonly clearedFeatures = new Set<string>();
  readonly spreadFeatures = new Map<string, SpreadPlantEntry>();
  rimWorldSingleOccupancy = false;
  private nextBuildingId = 1;

  readonly chunkIndex = new ChunkIndex({
    buildings: () => this.buildings,
    featureLeft: () => this.featureLeft,
    harvestCd: () => this.harvestCd,
  });

  private tagIndex = new Map<string, BuildingState[]>();
  private tagVersion = 0;
  private featureVersion = 0;
  private nextRegenTime = Infinity;
  private nearestFeatureCache = new Map<string, FeatureHit | null>();
  private nearestFeatureCacheVer = -1;

  constructor(
    public tuning: Tuning,
    readonly seed: number,
    readonly spawn: Pos,
  ) {}

  private bumpFeatureVersion(): void {
    this.featureVersion++;
  }

  private refreshRegenCheck(): void {
    if (this.harvestCd.size === 0) {
      this.nextRegenTime = Infinity;
      return;
    }
    if (this.now >= this.nextRegenTime) {
      let minT = Infinity;
      for (const [k, readyAt] of this.harvestCd) {
        if (this.now >= readyAt) {
          this.harvestCd.delete(k);
          this.chunkIndex.featureRegrown(k);
          this.featureVersion++;
        } else if (readyAt < minT) {
          minT = readyAt;
        }
      }
      this.nextRegenTime = minT;
    }
  }

  private noise(ix: number, iy: number, salt: number, cell: number): number {
    const gx = Math.floor(ix / cell);
    const gy = Math.floor(iy / cell);
    const fx = ix / cell - gx;
    const fy = iy / cell - gy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const h00 = hash2(gx, gy, salt);
    const h10 = hash2(gx + 1, gy, salt);
    const h01 = hash2(gx, gy + 1, salt);
    const h11 = hash2(gx + 1, gy + 1, salt);
    return (h00 * (1 - sx) + h10 * sx) * (1 - sy) + (h01 * (1 - sx) + h11 * sx) * sy;
  }

  mod2(n: number): number {
    return ((n % 2) + 2) % 2;
  }

  elev(ix: number, iy: number): number {
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

  moist(x: number, y: number): number {
    return this.noise(x, y, SALT_MOIST, this.tuning.world.moistCell);
  }

  private tileCache = new Map<number, TileKind>();
  private zCache = new Map<number, number>();
  private naturalSlopeCache = new Map<number, boolean>();
  private static TILE_CACHE_CAP = 150000;

  private treeAnchorCache = new Map<number, boolean>();
  private featureKindCache = new Map<number, FeatureHit['kind'] | null>();

  tileAt(ix: number, iy: number): TileKind {
    const x = Math.round(ix);
    const y = Math.round(iy);
    const k = smiKey2(x, y);
    const hit = this.tileCache.get(k);
    if (hit !== undefined) return hit;
    const kind = this.genTileKind(x, y);
    if (this.tileCache.size > World.TILE_CACHE_CAP) this.tileCache.clear();
    this.tileCache.set(k, kind);
    return kind;
  }

  private genTileKind(x: number, y: number): TileKind {
    const t = this.tuning.world;
    if (Math.abs(x - this.spawn.x) <= t.spawnClearRadius && Math.abs(y - this.spawn.y) <= t.spawnClearRadius) {
      return (x + y) % 5 === 0 ? 'dirt' : 'grass';
    }
    const e = this.elev(x, y);
    if (e < t.waterLevel) return 'water';
    if (this.noise(x, y, SALT_STONE, t.stoneCell) < t.stoneLevel) return 'stone';
    return hash2(x, y, SALT_TILE) < t.dirtChance ? 'dirt' : 'grass';
  }

  private genZ(x: number, y: number): number {
    const t = this.tuning.world;
    const e = this.elev(x, y);
    const kind = this.tileAt(x, y);
    if (kind === 'water' || e < t.waterLevel) {
      return e < t.waterLevel * 0.72 ? -2 : -1;
    }
    const moist = this.moist(x, y);
    if (e < t.waterLevel + 0.03 && moist > 0.65) {
      return -1;
    }
    const maxZ = this.tuning.world.maxZ;
    return Math.min(maxZ, Math.floor(e * (maxZ + 1)));
  }

  standableTile(x: number, y: number): boolean {
    return !this.tuning.tiles[this.tileAt(x, y)].liquid;
  }

  zAt(ix: number, iy: number): number {
    const x = Math.round(ix);
    const y = Math.round(iy);
    const k = smiKey2(x, y);
    const hit = this.zCache.get(k);
    if (hit !== undefined) return hit;
    const z = this.genZ(x, y);
    if (this.zCache.size > World.TILE_CACHE_CAP) this.zCache.clear();
    this.zCache.set(k, z);
    return z;
  }

  naturalSlopeAt(ix: number, iy: number): boolean {
    const x = Math.round(ix);
    const y = Math.round(iy);
    const k = smiKey2(x, y);
    const hit = this.naturalSlopeCache.get(k);
    if (hit !== undefined) return hit;
    const res = this.computeNaturalSlope(x, y);
    if (this.naturalSlopeCache.size > World.TILE_CACHE_CAP) this.naturalSlopeCache.clear();
    this.naturalSlopeCache.set(k, res);
    return res;
  }

  private computeNaturalSlope(x: number, y: number): boolean {
    const tile = this.tileAt(x, y);
    if (tile === 'water') return false;
    const z = this.zAt(x, y);
    if (z >= 3) return false;
    const zN = this.zAt(x, y - 1);
    const zS = this.zAt(x, y + 1);
    const zE = this.zAt(x + 1, y);
    const zW = this.zAt(x - 1, y);
    const hasStepNeighbor =
      Math.abs(z - zN) === 1 ||
      Math.abs(z - zS) === 1 ||
      Math.abs(z - zE) === 1 ||
      Math.abs(z - zW) === 1;
    if (!hasStepNeighbor) return false;
    return ((x * 7 + y * 13) & 7) === 0 || hash2(x, y, SALT_NATURAL_SLOPE) < 0.22;
  }

  canStand(x: number, y: number): boolean {
    if (this.tuning.tiles[this.tileAt(x, y)].liquid) return false;
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (this.treeBlockAt(rx, ry)) return false;
    if (this.occupied.size === 0) return true;
    const b = this.occupied.get(key2(rx, ry));
    if (b === undefined) return true;
    const def = this.buildings.get(b);
    if (def?.isBlueprint) return true;
    const defTune = def ? this.tuning.buildings[def.defId] : undefined;
    return defTune ? defTune.passable : true;
  }

  canStep(fx: number, fy: number, tx: number, ty: number, climb: number): boolean {
    if (!this.canStand(tx, ty)) return false;
    const dz = Math.abs(this.zAt(tx, ty) - this.zAt(Math.round(fx), Math.round(fy)));
    return dz <= climb;
  }

  passable(x: number, y: number): boolean {
    return this.canStand(x, y);
  }

  private treeAnchorAt(ax: number, ay: number): boolean {
    const k = smiKey2(ax, ay);
    const hit = this.treeAnchorCache.get(k);
    if (hit !== undefined) return hit;
    const v = this.genTreeAnchor(ax, ay);
    if (this.treeAnchorCache.size > World.TILE_CACHE_CAP) this.treeAnchorCache.clear();
    this.treeAnchorCache.set(k, v);
    return v;
  }

  private genTreeAnchor(ax: number, ay: number): boolean {
    const w = this.tuning.world;
    if (Math.abs(ax - this.spawn.x) <= w.spawnClearRadius && Math.abs(ay - this.spawn.y) <= w.spawnClearRadius) {
      return false;
    }
    if (this.tileAt(ax, ay) !== 'grass') return false;
    const grove = 1 + this.moist(ax, ay) * (w.groveBoost - 1);
    return hash2(ax, ay, SALT_TREE) < w.treeRate * grove;
  }

  treeBlockAt(x: number, y: number): boolean {
    const rx = Math.round(x);
    const ry = Math.round(y);

    // RimWorld 1×1 树木占地规则：树木仅阻挡其锚点所在的 1×1 格，不再阻挡 2×2 四格（但渲染贴图保留大树冠）
    if (this.rimWorldSingleOccupancy) {
      const k = `${rx},${ry}`;
      if (this.clearedFeatures.has(k)) return false;
      if (this.harvestCd.size > 0) {
        const readyAt = this.harvestCd.get(k);
        if (readyAt !== undefined && this.now < readyAt) return false;
      }
      if (this.spreadFeatures.size > 0) {
        const sp = this.spreadFeatures.get(k);
        if (sp?.kind === 'tree' && sp.amount > 0) return true;
      }
      if (this.buildingAt(rx, ry)) return false;
      return this.mod2(rx) === 0 && this.mod2(ry) === 0 && this.treeAnchorAt(rx, ry);
    }

    const ax = rx - this.mod2(rx);
    const ay = ry - this.mod2(ry);
    if (this.clearedFeatures.size > 0) {
      const ak = `${ax},${ay}`;
      if (this.clearedFeatures.has(ak) || this.clearedFeatures.has(`${rx},${ry}`)) {
        return false;
      }
    }
    if (this.spreadFeatures.size > 0) {
      const sp = this.spreadFeatures.get(`${ax},${ay}`);
      if (sp?.kind === 'tree' && sp.amount > 0) return true;
    }
    return this.treeAnchorAt(ax, ay);
  }

  clearFeatureAt(ix: number, iy: number): boolean {
    const x = Math.round(ix);
    const y = Math.round(iy);
    let cleared = false;
    const k = `${x},${y}`;
    if (this.spreadFeatures.has(k)) {
      this.spreadFeatures.delete(k);
      cleared = true;
    }
    if (this.featureKind(x, y) !== null) {
      this.clearedFeatures.add(k);
      this.featureLeft.delete(k);
      cleared = true;
    }
    if (!this.rimWorldSingleOccupancy) {
      const ax = x - this.mod2(x);
      const ay = y - this.mod2(y);
      const ak = `${ax},${ay}`;
      if (this.treeAnchorAt(ax, ay) || this.spreadFeatures.get(ak)?.kind === 'tree') {
        this.clearedFeatures.add(ak);
        this.spreadFeatures.delete(ak);
        this.featureLeft.delete(ak);
        cleared = true;
      }
    }
    if (cleared) this.bumpFeatureVersion();
    return cleared;
  }

  clearFeaturesInRect(x0: number, y0: number, x1: number, y1: number): number {
    let count = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (this.clearFeatureAt(x, y)) count++;
      }
    }
    return count;
  }

  addSpreadPlant(ix: number, iy: number, kind: FeatureHit['kind'], amount?: number): boolean {
    const x = Math.round(ix);
    const y = Math.round(iy);
    if (kind === 'tree') {
      if (this.rimWorldSingleOccupancy) {
        if (!this.standableTile(x, y) || this.buildingAt(x, y) || this.featureAt(x, y)) return false;
        const k = `${x},${y}`;
        this.clearedFeatures.delete(k);
        this.harvestCd.delete(k);
        this.spreadFeatures.set(k, {
          kind: 'tree',
          amount: amount ?? this.fullAmount('tree', x, y),
          plantedAt: this.now,
        });
        this.bumpFeatureVersion();
        return true;
      }
      const ax = x - this.mod2(x);
      const ay = y - this.mod2(y);
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const cx = ax + dx;
          const cy = ay + dy;
          if (!this.standableTile(cx, cy) || this.buildingAt(cx, cy) || this.featureAt(cx, cy)) return false;
        }
      }
      const ak = `${ax},${ay}`;
      this.clearedFeatures.delete(ak);
      this.harvestCd.delete(ak);
      this.spreadFeatures.set(ak, {
        kind: 'tree',
        amount: amount ?? this.fullAmount('tree', ax, ay),
        plantedAt: this.now,
      });
      this.bumpFeatureVersion();
      return true;
    }

    if (!this.standableTile(x, y) || this.buildingAt(x, y) || this.treeBlockAt(x, y) || this.featureAt(x, y)) {
      return false;
    }
    const k = `${x},${y}`;
    this.clearedFeatures.delete(k);
    this.harvestCd.delete(k);
    this.spreadFeatures.set(k, {
      kind: 'berry',
      amount: amount ?? this.fullAmount('berry', x, y),
      plantedAt: this.now,
    });
    this.bumpFeatureVersion();
    return true;
  }

  private featureKind(ix: number, iy: number): FeatureHit['kind'] | null {
    const x = Math.round(ix);
    const y = Math.round(iy);
    const k = smiKey2(x, y);
    const hit = this.featureKindCache.get(k);
    if (hit !== undefined) return hit;
    const v = this.genFeatureKind(x, y);
    if (this.featureKindCache.size > World.TILE_CACHE_CAP) this.featureKindCache.clear();
    this.featureKindCache.set(k, v);
    return v;
  }

  private genFeatureKind(x: number, y: number): FeatureHit['kind'] | null {
    const w = this.tuning.world;
    if (Math.abs(x - this.spawn.x) <= w.spawnClearRadius && Math.abs(y - this.spawn.y) <= w.spawnClearRadius) {
      return null;
    }
    if (this.tileAt(x, y) !== 'grass') return null;
    if (this.mod2(x) === 0 && this.mod2(y) === 0 && hash2(x, y, SALT_TREE) < w.treeRate) return 'tree';
    if (!this.rimWorldSingleOccupancy && this.treeBlockAt(x, y)) return null;
    if (hash2(x, y, SALT_BERRY) < w.berryRate) return 'berry';
    return null;
  }

  fullAmount(kind: FeatureHit['kind'], x: number, y: number): number {
    const w = this.tuning.world;
    if (kind === 'tree') return 4 + Math.floor(hash2(x, y, SALT_TREE_AMT) * 3);
    return (
      w.berryAmountMin +
      Math.floor(hash2(x, y, SALT_BERRY_AMT) * (w.berryAmountMax - w.berryAmountMin + 1))
    );
  }

  featureRect(f: { kind: FeatureHit['kind']; x: number; y: number }): { x0: number; y0: number; x1: number; y1: number } {
    const size = f.kind === 'tree' ? (this.rimWorldSingleOccupancy ? 1 : this.tuning.world.treeSize) : 1;
    return { x0: f.x, y0: f.y, x1: f.x + size - 1, y1: f.y + size - 1 };
  }

  distToFeatureRect(px: number, py: number, rect: { x0: number; y0: number; x1: number; y1: number }): number {
    const dxc = Math.max(rect.x0 - px, 0, px - rect.x1);
    const dyc = Math.max(rect.y0 - py, 0, py - rect.y1);
    return Math.hypot(dxc, dyc);
  }

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

  featureAt(x: number, y: number): FeatureHit | null {
    const tx = Math.round(x);
    const ty = Math.round(y);
    const kind = this.featureKind(tx, ty);
    if (kind === null && this.spreadFeatures.size === 0) {
      return null;
    }
    const k = `${tx},${ty}`;
    if (this.clearedFeatures.size > 0) {
      if (this.clearedFeatures.has(k)) return null;
      if (!this.rimWorldSingleOccupancy) {
        const ax = tx - this.mod2(tx);
        const ay = ty - this.mod2(ty);
        if (this.clearedFeatures.has(`${ax},${ay}`)) return null;
      }
    }
    if (this.rimWorldSingleOccupancy && this.buildingAt(tx, ty)) {
      return null;
    }
    if (this.spreadFeatures.size > 0) {
      const sp = this.spreadFeatures.get(k);
      if (sp) {
        if (sp.amount <= 0) {
          this.spreadFeatures.delete(k);
          this.bumpFeatureVersion();
          return null;
        }
        return { x: tx, y: ty, kind: sp.kind, amount: sp.amount };
      }
    }
    if (!kind) return null;
    if (this.harvestCd.size > 0) {
      const readyAt = this.harvestCd.get(k);
      if (readyAt !== undefined) {
        if (this.now < readyAt) return null;
        this.harvestCd.delete(k);
        this.chunkIndex.featureRegrown(k);
        this.bumpFeatureVersion();
      }
    }
    const left = (this.featureLeft.size > 0 ? this.featureLeft.get(k) : undefined) ?? this.fullAmount(kind, tx, ty);
    if (left <= 0) return null;
    return { x: tx, y: ty, kind, amount: left };
  }
  now = 0;

  nearestFeature(kind: FeatureHit['kind'], x: number, y: number, maxR: number): FeatureHit | null {
    this.refreshRegenCheck();
    if (this.nearestFeatureCacheVer !== this.featureVersion) {
      this.nearestFeatureCache.clear();
      this.nearestFeatureCacheVer = this.featureVersion;
    }
    const rx = Math.round(x);
    const ry = Math.round(y);
    const ck = `${kind}:${rx},${ry}:${maxR}`;
    const cached = this.nearestFeatureCache.get(ck);
    if (cached !== undefined) {
      if (cached === null) return null;
      const fresh = this.featureAt(cached.x, cached.y);
      if (fresh && fresh.kind === kind) return fresh;
    }

    for (let r = 0; r <= maxR; r++) {
      if (r === 0) {
        const f0 = this.featureAt(rx, ry);
        if (f0 && f0.kind === kind) {
          this.nearestFeatureCache.set(ck, f0);
          return f0;
        }
        continue;
      }
      for (let dy = -r; dy <= r; dy++) {
        if (dy === -r || dy === r) {
          for (let dx = -r; dx <= r; dx++) {
            const f = this.featureAt(rx + dx, ry + dy);
            if (f && f0OrMatch(f, kind)) {
              this.nearestFeatureCache.set(ck, f);
              return f;
            }
          }
        } else {
          const fLeft = this.featureAt(rx - r, ry + dy);
          if (fLeft && f0OrMatch(fLeft, kind)) {
            this.nearestFeatureCache.set(ck, fLeft);
            return fLeft;
          }
          const fRight = this.featureAt(rx + r, ry + dy);
          if (fRight && f0OrMatch(fRight, kind)) {
            this.nearestFeatureCache.set(ck, fRight);
            return fRight;
          }
        }
      }
    }
    this.nearestFeatureCache.set(ck, null);
    return null;
  }

  takeOne(ix: number, iy: number): number {
    const x = Math.round(ix);
    const y = Math.round(iy);
    const k = `${x},${y}`;
    if (this.spreadFeatures.has(k)) {
      const sp = this.spreadFeatures.get(k)!;
      sp.amount -= 1;
      if (sp.amount <= 0) {
        this.spreadFeatures.delete(k);
        this.bumpFeatureVersion();
        return 0;
      }
      return sp.amount;
    }
    const readyAt = this.harvestCd.get(k);
    if (readyAt !== undefined) {
      if (this.now < readyAt) return -1;
      this.harvestCd.delete(k);
      this.chunkIndex.featureRegrown(k);
    }
    const kind = this.featureKind(x, y);
    if (!kind) return -1;
    const left = (this.featureLeft.get(k) ?? this.fullAmount(kind, x, y)) - 1;
    if (left <= 0) {
      this.featureLeft.delete(k);
      const regenAt = this.now + this.tuning.world.harvestRegenSec;
      this.harvestCd.set(k, regenAt);
      if (regenAt < this.nextRegenTime) this.nextRegenTime = regenAt;
      this.chunkIndex.featureDepleted(k);
      this.bumpFeatureVersion();
      return 0;
    }
    this.featureLeft.set(k, left);
    this.chunkIndex.featureTaken(k);
    return left;
  }

  footprint(defId: string, rot?: 0 | 1 | 2 | 3): { w: number; h: number } {
    const def = this.tuning.buildings[defId];
    const bw = def?.w ?? 1;
    const bh = def?.h ?? 1;
    if (rot === 1 || rot === 3) return { w: bh, h: bw };
    return { w: bw, h: bh };
  }

  footprintOf(b: BuildingState): { w: number; h: number } {
    if (b.w !== undefined && b.h !== undefined) return { w: b.w, h: b.h };
    return this.footprint(b.defId, b.rot);
  }

  buildingRect(b: BuildingState): { x0: number; y0: number; x1: number; y1: number; w: number; h: number } {
    const { w, h } = this.footprintOf(b);
    return { x0: b.pos.x, y0: b.pos.y, x1: b.pos.x + w - 1, y1: b.pos.y + h - 1, w, h };
  }

  buildingCells(b: BuildingState): Pos[] {
    const { w, h } = this.footprintOf(b);
    const cells: Pos[] = [];
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        cells.push({ x: b.pos.x + dx, y: b.pos.y + dy });
      }
    }
    return cells;
  }

  distToBuilding(px: number, py: number, b: BuildingState): number {
    const rect = this.buildingRect(b);
    return this.distToFeatureRect(px, py, rect);
  }

  nearestBuildingAdjacent(b: BuildingState, fromX: number, fromY: number): Pos | null {
    const rect = this.buildingRect(b);
    return this.nearestFreeAdjacent(rect, fromX, fromY);
  }

  buildingCenter(b: BuildingState): { x: number; y: number } {
    const { w, h } = this.footprintOf(b);
    return { x: b.pos.x + (w - 1) / 2, y: b.pos.y + (h - 1) / 2 };
  }

  private indexBuildingCells(nb: BuildingState, w: number, h: number, passable: boolean): void {
    const bx = Math.round(nb.pos.x);
    const by = Math.round(nb.pos.y);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this.allOccupied.set(smiKey2(bx + dx, by + dy), nb);
        if (!passable && !nb.isBlueprint) {
          this.occupied.set(key2(nb.pos.x + dx, nb.pos.y + dy), nb.id);
        } else {
          this.occupied.delete(key2(nb.pos.x + dx, nb.pos.y + dy));
        }
      }
    }
  }

  finalizeBlueprintPassability(id: string): void {
    const b = this.buildings.get(id);
    if (!b) return;
    const def = this.tuning.buildings[b.defId];
    const { w, h } = this.footprintOf(b);
    this.indexBuildingCells(b, w, h, Boolean(def?.passable));
    this.tagVersion++;
  }

  addBuilding(defId: string, x: number, y: number): BuildingState | null {
    const def = this.tuning.buildings[defId];
    if (!def) return null;
    const { w, h } = this.footprint(defId);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (!this.passable(x + dx, y + dy)) return null;
        if (this.rimWorldSingleOccupancy && this.buildingAt(x + dx, y + dy)) return null;
      }
    }
    const pad = this.tuning.build.minSpacing - 1;
    for (const b of this.buildings.values()) {
      if (b.defId !== defId) continue;
      const f = this.footprintOf(b);
      if (
        x <= b.pos.x + f.w - 1 + pad &&
        b.pos.x <= x + w - 1 + pad &&
        y <= b.pos.y + f.h - 1 + pad &&
        b.pos.y <= y + h - 1 + pad
      ) {
        return null;
      }
    }
    if (this.rimWorldSingleOccupancy) {
      this.clearFeaturesInRect(x, y, x + w - 1, y + h - 1);
    }
    const nb: BuildingState = { id: `b${this.nextBuildingId++}`, defId, pos: { x, y }, hp: def.hp };
    this.buildings.set(nb.id, nb);
    this.pushIndex(nb);
    this.tagVersion++;
    this.bumpFeatureVersion();
    this.chunkIndex.buildingAdded(nb.id);
    this.indexBuildingCells(nb, w, h, Boolean(def.passable));
    return nb;
  }

  addArchitectBuilding(
    defId: string,
    x: number,
    y: number,
    opts: {
      rot?: 0 | 1 | 2 | 3;
      w?: number;
      h?: number;
      allowContiguous?: boolean;
      ignoreTerrain?: boolean;
      allowReplace?: boolean;
      isBlueprint?: boolean;
    } = {},
  ): BuildingState | null {
    const def = this.tuning.buildings[defId];
    if (!def) return null;
    const rot = opts.rot ?? 0;
    const baseFp = this.footprint(defId, rot);
    const w = opts.w ?? baseFp.w;
    const h = opts.h ?? baseFp.h;

    const toReplace = new Set<string>();
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = x + dx;
        const cy = y + dy;
        const existing = this.buildingAt(cx, cy);
        if (existing) {
          if (opts.allowReplace && canBuildingReplace(defId, existing)) {
            toReplace.add(existing.id);
          } else {
            return null;
          }
        }
        if (!opts.ignoreTerrain && defId !== 'power_conduit') {
          if (this.tuning.tiles[this.tileAt(cx, cy)].liquid) return null;
        }
      }
    }

    if (!opts.allowContiguous) {
      const pad = this.tuning.build.minSpacing - 1;
      for (const b of this.buildings.values()) {
        if (toReplace.has(b.id) || b.defId !== defId) continue;
        const f = this.footprintOf(b);
        if (
          x <= b.pos.x + f.w - 1 + pad &&
          b.pos.x <= x + w - 1 + pad &&
          y <= b.pos.y + f.h - 1 + pad &&
          b.pos.y <= y + h - 1 + pad
        ) {
          return null;
        }
      }
    }

    for (const oldId of toReplace) {
      this.removeBuilding(oldId);
    }

    this.clearFeaturesInRect(x, y, x + w - 1, y + h - 1);

    const nb: BuildingState = {
      id: `b${this.nextBuildingId++}`,
      defId,
      pos: { x, y },
      hp: def.hp,
      ...(opts.isBlueprint ? { isBlueprint: true } : {}),
      ...(rot !== 0 ? { rot } : {}),
      ...(w !== (def.w ?? 1) || h !== (def.h ?? 1) ? { w, h } : {}),
    };
    this.buildings.set(nb.id, nb);
    this.pushIndex(nb);
    this.tagVersion++;
    this.bumpFeatureVersion();
    this.chunkIndex.buildingAdded(nb.id);
    this.indexBuildingCells(nb, w, h, Boolean(def.passable || nb.isBlueprint));
    return nb;
  }

  removeBuilding(id: string): void {
    const b = this.buildings.get(id);
    if (!b) return;
    const { w, h } = this.footprintOf(b);
    const bx = Math.round(b.pos.x);
    const by = Math.round(b.pos.y);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this.occupied.delete(key2(b.pos.x + dx, b.pos.y + dy));
        const ck = smiKey2(bx + dx, by + dy);
        if (this.allOccupied.get(ck)?.id === id) {
          this.allOccupied.delete(ck);
        }
      }
    }
    this.buildings.delete(id);
    this.popIndex(b);
    this.tagVersion++;
    this.bumpFeatureVersion();
    this.chunkIndex.buildingRemoved(id);
  }

  buildingAt(ix: number, iy: number): BuildingState | undefined {
    if (this.buildings.size === 0) return undefined;
    const x = Math.round(ix);
    const y = Math.round(iy);
    const hit = this.allOccupied.get(smiKey2(x, y));
    if (hit !== undefined) {
      const { w, h } = this.footprintOf(hit);
      if (x >= hit.pos.x && x < hit.pos.x + w && y >= hit.pos.y && y < hit.pos.y + h) {
        return hit;
      }
    }
    return undefined;
  }

  exportState(): {
    buildings: import('./types').BuildingState[];
    featureLeft: [string, number][];
    harvestCd: [string, number][];
    nextBuildingId: number;
    worldChunks?: { key: number; buildingIds: string[] }[];
  } {
    return {
      buildings: [...this.buildings.values()].map((b) => structuredClone(b)),
      featureLeft: [...this.featureLeft.entries()],
      harvestCd: [...this.harvestCd.entries()],
      nextBuildingId: this.nextBuildingId,
      worldChunks: this.exportChunks(),
    };
  }

  importState(st: {
    buildings: import('./types').BuildingState[];
    featureLeft: [string, number][];
    harvestCd: [string, number][];
    nextBuildingId: number;
    worldChunks?: { key: number; buildingIds: string[] }[];
  }): void {
    this.buildings.clear();
    this.occupied.clear();
    this.allOccupied.clear();
    this.tagIndex.clear();
    for (const src of st.buildings) {
      const b = structuredClone(src);
      this.buildings.set(b.id, b);
      this.pushIndex(b);
      const def = this.tuning.buildings[b.defId];
      const { w, h } = this.footprintOf(b);
      this.indexBuildingCells(b, w, h, Boolean(def?.passable ?? true));
    }
    this.tagVersion++;
    this.bumpFeatureVersion();
    this.featureLeft = new Map(st.featureLeft);
    this.harvestCd = new Map(st.harvestCd);
    this.nextRegenTime = -Infinity;
    this.nextBuildingId = st.nextBuildingId;
    this.invalidateChunkIndex();
  }

  private pushIndex(b: BuildingState): void {
    const tags = this.tuning.buildings[b.defId]?.tags;
    if (!tags) return;
    for (const tag of tags) {
      let bucket = this.tagIndex.get(tag);
      if (!bucket) {
        bucket = [];
        this.tagIndex.set(tag, bucket);
      }
      bucket.push(b);
    }
  }

  private popIndex(b: BuildingState): void {
    const tags = this.tuning.buildings[b.defId]?.tags;
    if (!tags) return;
    for (const tag of tags) {
      const bucket = this.tagIndex.get(tag);
      if (!bucket) continue;
      const i = bucket.indexOf(b);
      if (i >= 0) bucket.splice(i, 1);
    }
  }

  tagVersionNow(): number {
    return this.tagVersion;
  }

  buildingsByTag(tag: string): readonly BuildingState[] {
    return this.tagIndex.get(tag) ?? EMPTY_BUILDINGS;
  }

  nearestBuildingByTag(tag: string, x: number, y: number, maxR = Infinity): BuildingState | undefined {
    const bucket = this.tagIndex.get(tag);
    if (bucket === undefined) return undefined;
    let best: BuildingState | undefined;
    let bestD = maxR;
    for (const b of bucket) {
      if (!this.tuning.buildings[b.defId]) continue;
      const d = Math.hypot(b.pos.x - x, b.pos.y - y);
      if (d <= bestD) {
        best = b;
        bestD = d;
      }
    }
    return best;
  }

  buildingsInChunk(ck: number): BuildingState[] {
    return this.chunkIndex.buildingsInChunk(ck);
  }

  buildingsInChunks(cks: Iterable<number>): BuildingState[] {
    return this.chunkIndex.buildingsInChunks(cks);
  }

  featureLeftInChunks(cks: Iterable<number>): [string, number][] {
    return this.chunkIndex.featureLeftInChunks(cks);
  }

  harvestCdInChunks(cks: Iterable<number>): [string, number][] {
    return this.chunkIndex.harvestCdInChunks(cks);
  }

  activeChunkKeys(): number[] {
    return this.chunkIndex.activeChunkKeys();
  }

  exportChunks(): { key: number; buildingIds: string[] }[] {
    return this.chunkIndex.exportChunks();
  }

  invalidateChunkIndex(): void {
    this.chunkIndex.invalidate();
  }
}

function f0OrMatch(f: FeatureHit, kind: FeatureHit['kind']): boolean {
  return f.kind === kind;
}

export function canBuildingReplace(newDefId: string, existing: BuildingState): boolean {
  if (existing.defId === 'slope' || newDefId === 'slope') return false;
  if (existing.isBlueprint) return true;
  if ((newDefId === 'door' && existing.defId === 'wall') || (newDefId === 'wall' && existing.defId === 'door')) {
    return true;
  }
  if ((newDefId === 'great_bonfire' || newDefId === 'stove') && existing.defId === 'campfire') {
    return true;
  }
  return false;
}

const EMPTY_BUILDINGS: BuildingState[] = [];
