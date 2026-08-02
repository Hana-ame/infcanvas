// 世界 chunk 生成 —— P0 用种子生成有限地图（含 chunk 结构，后期扩无限）
import { SimRng } from './rng';
import { TILES, BUILDINGS } from '../defs';

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
    this.generate();
  }

  private tileIdToIndex(id: string): number {
    return this.tileKeys.indexOf(id);
  }

  // 确定性：按 chunk 顺序生成，每个 chunk 用固定坐标 seed
  private generate(): void {
    const perChunkRng = new SimRng(this.seed);
    for (let cy = 0; cy < this.chunkRows; cy++) {
      for (let cx = 0; cx < this.chunkCols; cx++) {
        const chunkSeed = perChunkRng.int(1, 2 ** 31 - 1);
        this.generateChunk(cx, cy, chunkSeed);
      }
    }
    // 保证出生点是一块草地
    const cx = Math.floor(this.width / 2);
    const cy = Math.floor(this.height / 2);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setTile(cx + dx, cy + dy, 'grass');
      }
    }
  }

  private generateChunk(cx: number, cy: number, chunkSeed: number): void {
    const rng = new SimRng(chunkSeed);
    const baseX = cx * CHUNK_SIZE;
    const baseY = cy * CHUNK_SIZE;
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const wx = baseX + x;
        const wy = baseY + y;
        const r = rng.next();
        let tile: string;
        if (r < 0.55) tile = 'grass';
        else if (r < 0.75) tile = 'dirt';
        else if (r < 0.85) tile = 'stone';
        else if (r < 0.92) tile = 'ore';
        else if (r < 0.96) tile = 'water';
        else tile = 'mountain';
        this.setTile(wx, wy, tile);
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

  getTileDef(x: number, y: number): (typeof TILES)[string] {
    return TILES[this.getTile(x, y)];
  }

  isPassable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.getTileDef(x, y).passable;
  }

  // P0 简化：建筑占位，直接存 Map（后期进 ECS）
  buildings = new Map<number, { def: (typeof BUILDINGS)[string]; hp: number; faction: string }>();

  buildKey(x: number, y: number): number {
    return y * this.width + x;
  }

  getBuilding(x: number, y: number): { def: (typeof BUILDINGS)[string]; hp: number; faction: string } | null {
    return this.buildings.get(this.buildKey(x, y)) ?? null;
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
    return true;
  }
}
