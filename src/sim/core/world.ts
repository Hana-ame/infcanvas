// 世界 chunk 生成 —— P0 用种子生成有限地图（含 chunk 结构，后期扩无限）
import { SimRng } from './rng';
import { TILES, BUILDINGS, type TileDef, type BuildingDef } from '../defs';
import { generateBiomeMap } from './noise';
import { TUNING, type WorldTuning } from '../defs/tuning';

// 世界生成参数（数据驱动：默认取 tuning.world；Sim 构造时传入可被 mod 覆盖的副本）
type WorldGenTuning = Pick<WorldTuning, 'spawnClearRadius' | 'spawnTries' | 'spawnDistMin' | 'spawnDistRand' | 'spawnCounts'>;
const DEFAULT_WORLD_GEN: WorldGenTuning = {
  spawnClearRadius: TUNING.world.spawnClearRadius,
  spawnTries: TUNING.world.spawnTries,
  spawnDistMin: TUNING.world.spawnDistMin,
  spawnDistRand: TUNING.world.spawnDistRand,
  spawnCounts: TUNING.world.spawnCounts,
};

export const CHUNK_SIZE = 32; // 每 chunk 的 tile 数（32x32）
export const WORLD_CHUNKS = 6; // P0 世界 = 6x6 chunks = 192x192 tiles

export type TileId = string;

// 世界地形数组：chunkId -> Uint8Array（存 tile 索引），建筑用 Map 单独存
export class World {
  readonly gen: WorldGenTuning;
  readonly chunkCols: number;
  readonly chunkRows: number;
  readonly width: number; // 总 tile 宽
  readonly height: number;
  private tileIndex: Uint8Array; // width * height，存 TILES 的键索引
  private readonly tileKeys: string[]; // index -> tile id
  private readonly tilesDefs: Record<string, TileDef>; // mod 可注入（覆盖后生效）
  private readonly buildingsDefs: Record<string, BuildingDef>;
  light: Uint8Array; // 光照图：1=亮（篝火覆盖），0=黑暗
  private readonly seed: number;
  rng: SimRng;

  constructor(
    seed: number,
    defs: { tiles?: Record<string, TileDef>; buildings?: Record<string, BuildingDef> } = {},
    chunksX: number = WORLD_CHUNKS,
    chunksY: number = WORLD_CHUNKS,
    gen?: WorldGenTuning,
  ) {
    this.seed = seed;
    this.rng = new SimRng(seed);
    this.gen = gen ?? DEFAULT_WORLD_GEN;
    this.chunkCols = chunksX;
    this.chunkRows = chunksY;
    this.width = chunksX * CHUNK_SIZE;
    this.height = chunksY * CHUNK_SIZE;
    this.tilesDefs = defs.tiles ?? TILES;
    this.buildingsDefs = defs.buildings ?? BUILDINGS;
    this.tileKeys = Object.keys(this.tilesDefs);
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
    // 保证出生点是一块草地（spawnClearRadius 可通行，四周仍是树林/资源）
    const cx = Math.floor(this.width / 2);
    const cy = Math.floor(this.height / 2);
    const clr = this.gen.spawnClearRadius;
    for (let dy = -clr; dy <= clr; dy++) {
      for (let dx = -clr; dx <= clr; dx++) {
        this.setTile(cx + dx, cy + dy, 'grass');
      }
    }
    // 出生点近圈资源保证（饥荒式开局）：树/矿/石/水，确定性
    this.ensureSpawnResources(cx, cy);
    // 出生点连通性保证：BFS 从出生点算可达面积，被水域/森林环围时破口为草地
    this.ensureSpawnConnectivity(cx, cy);
  }

  // 出生点必须通向大陆（树/水不可通行 + 平滑噪声成片 → 曾实测出生点可达仅 0.1%：
  // 全图 192² 只剩出生圈几十格可走，玩法空间被封锁）。
  // 做法：BFS 测可达面积；不足 30% 全图时，把出生域边界的水/树改成草地，逐轮扩张。
  private ensureSpawnConnectivity(cx: number, cy: number): void {
    const w = this.width;
    const minArea = this.width * this.height * 0.15; // 有船后可造船渡水，破口只需保证开局不困
    for (let pass = 0; pass < 30; pass++) {
      // BFS 可达面积
      const seen = new Set<number>([cx + cy * w]);
      const frontier = [cx + cy * w];
      let head = 0;
      while (head < frontier.length) {
        const k = frontier[head++];
        const x = k % w;
        const y = Math.floor(k / w);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inBounds(nx, ny)) continue;
          const nk = nx + ny * w;
          if (seen.has(nk)) continue;
          if (this.getTileDef(nx, ny).passable) {
            seen.add(nk);
            frontier.push(nk);
          }
        }
      }
      if (seen.size >= minArea) return;
      // 破口：把可达域边界上的不可通行格（水/树）变草地（最近圈优先，BFS 层序即近→远）
      for (const k of seen) {
        const x = k % w;
        const y = Math.floor(k / w);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (!this.inBounds(nx, ny)) continue;
          const nk = nx + ny * w;
          if (seen.has(nk)) continue;
          const id = this.tileKeys[this.tileIndex[nk]];
          if (id === 'water' || id === 'tree') this.setTile(nx, ny, 'grass');
        }
      }
    }
  }

  // 出生点近圈撒资源：保证开局可采集（树、矿、石、水）—— 参数全读 world gen 表
  private ensureSpawnResources(cx: number, cy: number): void {
    const g = this.gen;
    const rng = new SimRng(this.seed ^ 0x5eed);
    const place = (id: string) => {
      for (let tries = 0; tries < g.spawnTries; tries++) {
        const r = g.spawnDistMin + rng.int(0, g.spawnDistRand); // 距离 min ~ min+rand
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
    // 至少各放几处，保证开局资源不枯竭（数量表驱动）
    for (const [id, n] of Object.entries(g.spawnCounts)) {
      for (let i = 0; i < n; i++) place(id);
    }
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  private idx(x: number, y: number): number {
    return y * this.width + x;
  }

  getTile(x: number, y: number): string {
    // 越界 → mountain（不可走，防寻路/扫描越界读入空地）；未知索引 → grass 兜底（防御性）
    if (!this.inBounds(x, y)) return 'mountain';
    const id = this.tileKeys[this.tileIndex[this.idx(x, y)]];
    return id ?? 'grass';
  }

  // 瓦片变更监听（采集/事件改地形 → server 推送增量；null = 不监听）
  onTileChange: ((x: number, y: number, tileId: string) => void) | null = null;

  setTile(x: number, y: number, tileId: string): void {
    if (!this.inBounds(x, y)) return;
    if (this.tileIndex[this.idx(x, y)] === this.tileIdToIndex(tileId)) return;
    this.tileIndex[this.idx(x, y)] = this.tileIdToIndex(tileId);
    this.onTileChange?.(x, y, tileId);
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
      const id = this.tilesDefs[tiles[i]] ? tiles[i] : 'grass';
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
    this.buildingChunks.clear();
    for (const d of data) {
      const def = this.buildingsDefs[d.defId];
      if (!def) continue;
      const x = d.key % this.width;
      const y = Math.floor(d.key / this.width);
      const mainKey = d.key;
      this.buildings.set(mainKey, { def, hp: d.hp, faction: d.faction });
      const footprint = this.footprintKeys(x, y, def);
      this.buildingFootprint.set(mainKey, footprint);
      for (const fk of footprint) this.gridToBuilding.set(fk, mainKey);
      this.indexBuilding(mainKey);
    }
    this.buildingVersion++;
    this.recomputeLight();
  }

  getTileDef(x: number, y: number): TileDef {
    return this.tilesDefs[this.getTile(x, y)];
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
  footprintKeys(x: number, y: number, def: (typeof BUILDINGS)[string]): number[] {
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

  // 数据驱动：按语义标签查建筑（mod 新建筑打 tags 即接入）
  hasBuildingWithTag(tag: string): boolean {
    for (const [, b] of this.buildings) {
      if (b.def.tags?.includes(tag)) return true;
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
      this.unindexBuilding(main);
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
  // ---- 建筑空间分区（chunk 索引）----
  // 性能：篝火光环/修理/袭击等"半径找建筑"原为 O(r²) 全格扫描 × 每小人 × 每 tick
  //（实测 san/needs 占模拟耗时 60%+）；改为按 8×8 chunk 登记建筑 footprint 格，
  // 半径查询只扫覆盖的 3×3 chunk，命中后按 footprint 最近格精确判距
  private static CHUNK = 8;
  private buildingChunks = new Map<number, Set<number>>(); // chunkKey -> mainKey 集合

  private chunkKeyOf(key: number): number {
    const gx = key % this.width;
    const gy = Math.floor(key / this.width);
    return Math.floor(gx / World.CHUNK) + Math.floor(gy / World.CHUNK) * 1000;
  }

  // footprint 每个格登记到所在 chunk（2×2 跨 chunk 的建筑两边都能查到）
  private indexBuilding(mainKey: number): void {
    for (const fk of this.buildingFootprint.get(mainKey) ?? [mainKey]) {
      const ck = this.chunkKeyOf(fk);
      let cell = this.buildingChunks.get(ck);
      if (!cell) { cell = new Set(); this.buildingChunks.set(ck, cell); }
      cell.add(mainKey);
    }
  }

  private unindexBuilding(mainKey: number): void {
    for (const cell of this.buildingChunks.values()) cell.delete(mainKey);
  }

  // 半径内建筑查询（O(覆盖 chunk 数 + 命中数)；距离按 footprint 最近格）
  queryBuildingsNear(x: number, y: number, radius: number): { key: number; def: (typeof BUILDINGS)[string]; hp: number; faction: string; dist: number }[] {
    const r2 = radius * radius;
    const out: { key: number; def: (typeof BUILDINGS)[string]; hp: number; faction: string; dist: number }[] = [];
    const seen = new Set<number>();
    const c0x = Math.floor((x - radius) / World.CHUNK);
    const c1x = Math.floor((x + radius) / World.CHUNK);
    const c0y = Math.floor((y - radius) / World.CHUNK);
    const c1y = Math.floor((y + radius) / World.CHUNK);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const cell = this.buildingChunks.get(cx + cy * 1000);
        if (!cell) continue;
        for (const mk of cell) {
          if (seen.has(mk)) continue;
          seen.add(mk);
          let minD = Infinity;
          for (const fk of this.buildingFootprint.get(mk) ?? [mk]) {
            const d = ((fk % this.width) - x) ** 2 + (Math.floor(fk / this.width) - y) ** 2;
            if (d < minD) minD = d;
          }
          if (minD <= r2) {
            const b = this.buildings.get(mk)!;
            out.push({ key: mk, def: b.def, hp: b.hp, faction: b.faction, dist: Math.sqrt(minD) });
          }
        }
      }
    }
    return out;
  }

  canBuildFootprint(x: number, y: number, def: (typeof BUILDINGS)[string]): boolean {
    // 水上建筑（竹筏/渡船/木桥）：footprint 全为水面 + 至少一格邻接陆地或已有水上建筑
    //（从岸边/筏链逐步铺 → 渡水玩法闭环；孤水中央不可凭空建）
    if (def.onWater) {
      const keys = this.footprintKeys(x, y, def);
      for (const key of keys) {
        const gx = key % this.width;
        const gy = Math.floor(key / this.width);
        if (!this.inBounds(gx, gy)) return false;
        if (this.getTileDef(gx, gy).id !== 'water') return false;
        if (this.getBuilding(gx, gy)) return false;
      }
      for (const key of keys) {
        const gx = key % this.width;
        const gy = Math.floor(key / this.width);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (!this.inBounds(nx, ny)) continue;
          const nk = nx + ny * this.width;
          if (keys.includes(nk)) continue; // 邻居在 footprint 内不算（自身不能撑自己）
          const nB = this.getBuilding(nx, ny);
          if (nB && nB.def.onWater) return true;  // 邻筏
          if (this.getTileDef(nx, ny).id !== 'water') return true; // 邻陆地
        }
      }
      return false;
    }
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

  // 落点 + footprint 写入建筑表，重算光照；返回 false = 不可建。
  // 注意：资源扣减在 buildSystem 完成蓝图时进行——调用方必须判返回值，
  // 否则会出现"资源已扣、建筑没建"的资源蒸发（此前 bug，见 buildSystem 注释）
  placeBuilding(x: number, y: number, defId: string, faction: string): boolean {
    const def = this.buildingsDefs[defId];
    if (!def) return false;
    if (!this.canBuildFootprint(x, y, def)) return false;
    const mainKey = this.buildKey(x, y);
    this.buildings.set(mainKey, { def, hp: def.hp, faction });
    const footprint = this.footprintKeys(x, y, def);
    this.buildingFootprint.set(mainKey, footprint);
    for (const fk of footprint) this.gridToBuilding.set(fk, mainKey);
    this.indexBuilding(mainKey);
    this.buildingVersion++;
    this.recomputeLight();
    return true;
  }

  // 升级建筑（如篝火→教堂，Q9 即时指令：教堂=篝火升级）
  upgradeBuilding(x: number, y: number, defId: string, faction: string): boolean {
    const main = this.mainKey(x, y);
    if (!this.buildings.has(main)) return false;
    const def = this.buildingsDefs[defId];
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
    this.unindexBuilding(main);
    this.indexBuilding(main);
    this.buildingVersion++;
    this.recomputeLight();
    return true;
  }

  // 光照图：emitsLight 声明半径内为亮（数据驱动，mod 加灯笼/火把即接入）
  recomputeLight(): void {
    this.light.fill(0);
    for (const [key, b] of this.buildings) {
      const RADIUS = b.def.emitsLight ?? 0;
      if (RADIUS <= 0) continue;
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
