// 世界 chunk 生成 —— P0 用种子生成有限地图（含 chunk 结构，后期扩无限）
import { SimRng } from './rng';
import { TILES, BUILDINGS } from '../defs';
import { generateBiomeMap } from './noise';

export const CHUNK_SIZE = 32; // 每 chunk 的 tile 数（32x32）
export const WORLD_CHUNKS = 6; // P0 世界 = 6x6 chunks = 192x192 tiles

export type TileId = string;

// 世界地形数组：chunkId -> Uint8Array（存 tile 索引），建筑用 Map 单独存
export class World {
  readonly chunkCols: number;
  readonly chunkRows: number;
  readonly width: number; // 总 tile 宽
  readonly height: number;
  private tileIndex: Uint8Array; // width * height，存 TILES 的键索引
  private readonly tileKeys: string[]; // index -> tile id
  light: Uint8Array; // 光照图：1=亮（篝火覆盖），0=黑暗
  private readonly seed: number;
  rng: SimRng;

  constructor(seed: number, chunksX: number = WORLD_CHUNKS, chunksY: number = WORLD_CHUNKS) {
    this.seed = seed;
    this.rng = new SimRng(seed);
    this.chunkCols = chunksX;
    this.chunkRows = chunksY;
    this.width = chunksX * CHUNK_SIZE;
    this.height = chunksY * CHUNK_SIZE;
    this.tileKeys = Object.keys(TILES);
    this.tileIndex = new Uint8Array(this.width * this.height);
    this.light = new Uint8Array(this.width * this.height);
    this.generate();
  }

  private tileIdToIndex(id: string): number {
    return this.tileKeys.indexOf(id);
  }

  // 确定性地形生成（Minecraft-like）：值噪声 + 海拔/湿度双轴 → 生物群系
  private generate(): void {
    const biomeMap = generateBiomeMap(this.width, this.height, this.seed);
    for (let i = 0; i < biomeMap.length; i++) {
      this.tileIndex[i] = this.tileIdToIndex(biomeMap[i]);
    }
    // 保证出生点是一块草地
    const cx = Math.floor(this.width / 2);
    const cy = Math.floor(this.height / 2);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        this.setTile(cx + dx, cy + dy, 'grass');
      }
    }
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  private idx(x: number, y: number): number {
    return y * this.width + x;
  }

  getTile(x: number, y: number): string {
    if (!this.inBounds(x, y)) return 'mountain';
    const id = this.tileKeys[this.tileIndex[this.idx(x, y)]];
    return id ?? 'grass';
  }

  setTile(x: number, y: number, tileId: string): void {
    if (!this.inBounds(x, y)) return;
    this.tileIndex[this.idx(x, y)] = this.tileIdToIndex(tileId);
  }

  // 序列化：导出全部 tile id + 建筑（存档用）
  serializeTiles(): string[] {
    const out: string[] = new Array(this.width * this.height);
    for (let i = 0; i < this.tileIndex.length; i++) {
      out[i] = this.tileKeys[this.tileIndex[i]];
    }
    return out;
  }

  loadTiles(tiles: string[]): void {
    if (tiles.length !== this.width * this.height) return;
    for (let i = 0; i < tiles.length; i++) {
      const id = TILES[tiles[i]] ? tiles[i] : 'grass';
      this.tileIndex[i] = this.tileIdToIndex(id);
    }
  }

  serializeBuildings(): { key: number; defId: string; hp: number; faction: string }[] {
    return [...this.buildings.entries()].map(([key, b]) => ({ key, defId: b.def.id, hp: b.hp, faction: b.faction }));
  }

  loadBuildings(data: { key: number; defId: string; hp: number; faction: string }[]): void {
    this.buildings.clear();
    for (const d of data) {
      const def = BUILDINGS[d.defId];
      if (!def) continue;
      const x = d.key % this.width;
      const y = Math.floor(d.key / this.width);
      this.buildings.set(this.buildKey(x, y), { def, hp: d.hp, faction: d.faction });
    }
    this.buildingVersion++;
    this.recomputeLight();
  }

  getTileDef(x: number, y: number): (typeof TILES)[string] {
    return TILES[this.getTile(x, y)];
  }

  isPassable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    // 地形可走性
    if (!this.getTileDef(x, y).passable) return false;
    // 建筑阻挡（墙等 passable=false 的建筑挡住）
    const b = this.buildings.get(this.buildKey(x, y));
    if (b && !b.def.passable) return false;
    return true;
  }

  // P0 简化：建筑占位，直接存 Map（后期进 ECS）
  buildings = new Map<number, { def: (typeof BUILDINGS)[string]; hp: number; faction: string }>();
  buildingVersion = 0; // 建筑版本号，渲染层据此重绘

  buildKey(x: number, y: number): number {
    return y * this.width + x;
  }

  getBuilding(x: number, y: number): { def: (typeof BUILDINGS)[string]; hp: number; faction: string } | null {
    return this.buildings.get(this.buildKey(x, y)) ?? null;
  }

  hasBuilding(defId: string): boolean {
    for (const [, b] of this.buildings) {
      if (b.def.id === defId) return true;
    }
    return false;
  }

  // 建筑受损（袭击/火灾），返回是否被摧毁
  damageBuilding(x: number, y: number, dmg: number): { destroyed: boolean; building: { def: (typeof BUILDINGS)[string]; hp: number; faction: string } | null } {
    const b = this.buildings.get(this.buildKey(x, y));
    if (!b) return { destroyed: false, building: null };
    b.hp -= dmg;
    this.buildingVersion++;
    if (b.hp <= 0) {
      this.buildings.delete(this.buildKey(x, y));
      this.buildingVersion++;
      this.recomputeLight();
      return { destroyed: true, building: b };
    }
    return { destroyed: false, building: b };
  }

  repairBuilding(x: number, y: number, amount: number): void {
    const b = this.buildings.get(this.buildKey(x, y));
    if (!b) return;
    const max = b.def.hp;
    if (b.hp >= max) return;
    b.hp = Math.min(max, b.hp + amount);
    this.buildingVersion++;
  }

  isBuildingDamaged(x: number, y: number): boolean {
    const b = this.buildings.get(this.buildKey(x, y));
    return b ? b.hp < b.def.hp : false;
  }

  canBuildAt(x: number, y: number): boolean {
    const def = this.getTileDef(x, y);
    if (!def.buildable) return false;
    if (this.getBuilding(x, y)) return false;
    return true;
  }

  placeBuilding(x: number, y: number, defId: string, faction: string): boolean {
    if (!this.canBuildAt(x, y)) return false;
    const def = BUILDINGS[defId];
    if (!def) return false;
    this.buildings.set(this.buildKey(x, y), { def, hp: def.hp, faction });
    this.buildingVersion++;
    this.recomputeLight();
    return true;
  }

  // 光照图：篝火覆盖 radius 内为亮，其余黑暗
  recomputeLight(): void {
    this.light.fill(0);
    const RADIUS = 4;
    for (const [key, b] of this.buildings) {
      if (b.def.id !== 'campfire') continue;
      const bx = key % this.width;
      const by = Math.floor(key / this.width);
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          const x = bx + dx, y = by + dy;
          if (!this.inBounds(x, y)) continue;
          if (dx * dx + dy * dy <= RADIUS * RADIUS) {
            this.light[y * this.width + x] = 1;
          }
        }
      }
    }
  }

  isLit(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.light[this.idx(x, y)] === 1;
  }
}
