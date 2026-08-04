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
    // 保证出生点是一块草地（5x5 可通行，四周仍是树林/资源）
    const cx = Math.floor(this.width / 2);
    const cy = Math.floor(this.height / 2);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setTile(cx + dx, cy + dy, 'grass');
      }
    }
    // 出生点近圈资源保证（饥荒式开局）：树/矿/石/水，确定性
    this.ensureSpawnResources(cx, cy);
  }

  // 出生点近圈撒资源：保证开局可采集（树、矿、石、水）
  private ensureSpawnResources(cx: number, cy: number): void {
    const rng = new SimRng(this.seed ^ 0x5eed);
    const place = (id: string) => {
      for (let tries = 0; tries < 24; tries++) {
        const r = 3 + rng.int(0, 5); // 距离 3-7
        const a = rng.next() * Math.PI * 2;
        const x = cx + Math.round(Math.cos(a) * r);
        const y = cy + Math.round(Math.sin(a) * r);
        if (!this.inBounds(x, y)) continue;
        const cur = this.getTile(x, y);
        if (cur === 'grass' || cur === 'tree' || cur === 'dirt') {
          this.setTile(x, y, id);
          return;
        }
      }
    };
    // 至少各放几处，保证开局资源不枯竭
    for (let i = 0; i < 4; i++) place('tree');
    for (let i = 0; i < 3; i++) place('ore');
    for (let i = 0; i < 3; i++) place('stone');
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
    this.gridToBuilding.clear();
    this.buildingFootprint.clear();
    for (const d of data) {
      const def = BUILDINGS[d.defId];
      if (!def) continue;
      const x = d.key % this.width;
      const y = Math.floor(d.key / this.width);
      const mainKey = d.key;
      this.buildings.set(mainKey, { def, hp: d.hp, faction: d.faction });
      const footprint = this.footprintKeys(x, y, def);
      this.buildingFootprint.set(mainKey, footprint);
      for (const fk of footprint) this.gridToBuilding.set(fk, mainKey);
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
    // 建筑阻挡（墙等 passable=false 的建筑挡住，含 footprint 辅助格）
    const b = this.getBuilding(x, y);
    if (b && !b.def.passable) return false;
    return true;
  }

  // P0 简化：建筑占位，直接存 Map（后期进 ECS）
  buildings = new Map<number, { def: (typeof BUILDINGS)[string]; hp: number; faction: string }>();
  buildingVersion = 0; // 建筑版本号，渲染层据此重绘
  // 格子 → 建筑主格 key（多格 footprint 反向索引）
  private gridToBuilding = new Map<number, number>();
  // 建筑主格 key → footprint 全部格子（多格）
  private buildingFootprint = new Map<number, number[]>();

  buildKey(x: number, y: number): number {
    return y * this.width + x;
  }

  // 建筑 footprint 覆盖的格子 key 列表（从锚点展开）
  private footprintKeys(x: number, y: number, def: (typeof BUILDINGS)[string]): number[] {
    const keys: number[] = [];
    for (let dy = 0; dy < def.size.y; dy++) {
      for (let dx = 0; dx < def.size.x; dx++) {
        keys.push(this.buildKey(x + dx, y + dy));
      }
    }
    return keys;
  }

  // 获取某格所属建筑（含 footprint 辅助格）
  getBuilding(x: number, y: number): { def: (typeof BUILDINGS)[string]; hp: number; faction: string } | null {
    const key = this.buildKey(x, y);
    const main = this.gridToBuilding.get(key);
    if (main !== undefined) return this.buildings.get(main) ?? null;
    return this.buildings.get(key) ?? null;
  }

  // 建筑主格 key（含辅助格 → 主格）
  mainKey(x: number, y: number): number {
    const key = this.buildKey(x, y);
    return this.gridToBuilding.get(key) ?? key;
  }

  // 建筑 footprint 格子列表（主格 x,y 为中心）
  footprintOf(x: number, y: number): { x: number; y: number }[] {
    const main = this.mainKey(x, y);
    const def = this.buildings.get(main)?.def;
    if (!def) return [{ x, y }];
    const mx = main % this.width;
    const my = Math.floor(main / this.width);
    const out: { x: number; y: number }[] = [];
    for (let dy = 0; dy < def.size.y; dy++) {
      for (let dx = 0; dx < def.size.x; dx++) {
        out.push({ x: mx + dx, y: my + dy });
      }
    }
    return out;
  }

  hasBuilding(defId: string): boolean {
    for (const [, b] of this.buildings) {
      if (b.def.id === defId) return true;
    }
    return false;
  }

  // 建筑受损（袭击/火灾），返回是否被摧毁
  damageBuilding(x: number, y: number, dmg: number): { destroyed: boolean; building: { def: (typeof BUILDINGS)[string]; hp: number; faction: string } | null } {
    const main = this.mainKey(x, y);
    const b = this.buildings.get(main);
    if (!b) return { destroyed: false, building: null };
    b.hp -= dmg;
    this.buildingVersion++;
    if (b.hp <= 0) {
      // 摧毁：移除整个 footprint
      const footprint = this.buildingFootprint.get(main) ?? [main];
      this.buildings.delete(main);
      this.buildingFootprint.delete(main);
      for (const fk of footprint) this.gridToBuilding.delete(fk);
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

  // 检查整个 footprint 是否可建（多格）
  canBuildFootprint(x: number, y: number, def: (typeof BUILDINGS)[string]): boolean {
    for (const key of this.footprintKeys(x, y, def)) {
      const gx = key % this.width;
      const gy = Math.floor(key / this.width);
      if (!this.inBounds(gx, gy)) return false;
      const tdef = this.getTileDef(gx, gy);
      if (!tdef.buildable) return false;
      if (this.getBuilding(gx, gy)) return false;
    }
    return true;
  }

  placeBuilding(x: number, y: number, defId: string, faction: string): boolean {
    const def = BUILDINGS[defId];
    if (!def) return false;
    if (!this.canBuildFootprint(x, y, def)) return false;
    const mainKey = this.buildKey(x, y);
    this.buildings.set(mainKey, { def, hp: def.hp, faction });
    const footprint = this.footprintKeys(x, y, def);
    this.buildingFootprint.set(mainKey, footprint);
    for (const fk of footprint) this.gridToBuilding.set(fk, mainKey);
    this.buildingVersion++;
    this.recomputeLight();
    return true;
  }

  // 升级建筑（如篝火→教堂，Q9 即时指令：教堂=篝火升级）
  upgradeBuilding(x: number, y: number, defId: string, faction: string): boolean {
    const main = this.mainKey(x, y);
    if (!this.buildings.has(main)) return false;
    const def = BUILDINGS[defId];
    if (!def) return false;
    // 旧 footprint 释放
    const old = this.buildingFootprint.get(main) ?? [main];
    for (const fk of old) this.gridToBuilding.delete(fk);
    this.buildings.set(main, { def, hp: def.hp, faction });
    // 新 footprint 建立
    const x0 = main % this.width;
    const y0 = Math.floor(main / this.width);
    const footprint = this.footprintKeys(x0, y0, def);
    this.buildingFootprint.set(main, footprint);
    for (const fk of footprint) this.gridToBuilding.set(fk, main);
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
