// 世界 chunk 生成 —— DESIGN §370 双图层无限地图：
//   chunk(64×64 tile) = 生成层(确定性地形, 不落盘) + 覆盖层(玩家/AI 改动, 才存储)
//   - 生成层：tileAt(x,y) 纯函数（坐标化 hash，任意坐标可独立生成；惰性 getChunk）
//   - 覆盖层：Map<chunkKey, Map<offset, tileIndex>> 只存"与生成层的差异"
//     （setTile 与生成层一致 → 删覆盖记录）——稀疏存储 + 负坐标（DESIGN §384 P0）
//   - 建筑 key：x + y*2^31（支持负坐标，|x|<2^31 无碰撞；旧档 key = y*192+x 加载时迁移）
//   - 光照：按已生成 chunk 存（无限地图全图 light 数组不可行）
import { SimRng } from './rng';
import { TILES, BUILDINGS, type TileDef, type BuildingDef } from '../defs';
import { generateBiomeMap, deriveBiomeSeeds, tileAt, buildSparsePatches, type BiomeSeeds, type SparsePatch } from './noise';
import { TUNING, type WorldTuning } from '../defs/tuning';

// 世界生成参数（数据驱动：默认取 tuning.world；Sim 构造时传入可被 mod 覆盖的副本）
type WorldGenTuning = Pick<WorldTuning, 'spawnClearRadius' | 'caveCount' | 'spawnTries' | 'spawnDistMin' | 'spawnDistRand' | 'spawnCounts'>;
const DEFAULT_WORLD_GEN: WorldGenTuning = {
  spawnClearRadius: TUNING.world.spawnClearRadius,
  caveCount: TUNING.world.caveCount,
  spawnTries: TUNING.world.spawnTries,
  spawnDistMin: TUNING.world.spawnDistMin,
  spawnDistRand: TUNING.world.spawnDistRand,
  spawnCounts: TUNING.world.spawnCounts,
};

export const CHUNK_SIZE = 64; // DESIGN §370：chunk 64×64 tile
export const WORLD_CHUNKS = 3; // 出生区 = 3×3 chunks = 192×192 tiles（P0 初始视口；世界可无限外扩）
// 坐标防御上限（±2^21 tile）：hash 精度内（x*374761393 不超 2^53）；正常探索达不到
export const MAX_TILE = 2 ** 21;

export type TileId = string;

// 世界地形数组：chunkId -> Uint8Array（存 tile 索引），建筑用 Map 单独存
// 建筑实体（2026-08-14 存档扩展点：extra = mod 系统自定义字段——电力/温度/伤情/囚犯等，
// 经 serializeBuildings/loadBuildings 随存档持久，解决"mod 字段一存档就丢"）
export interface BuildingData {
  def: BuildingDef;
  hp: number;
  faction: string;
  extra?: Record<string, unknown>;
}

// 覆盖层导出格式（DESIGN §382 chunkData 的 P0 落地：只发/存有改动的 chunk）
export interface ChunkData {
  x: number;  // chunk 坐标（可负）
  y: number;
  tiles: string[];
}

// World = 无限地图引擎（chunk 64x64 按需生成 + 负坐标 + ±2^21 边界）
// 包含：tile 生成/缓存、建筑管理、寻路通行判定(z/climb)、光照图、chunk 序列化
export class World {
  readonly gen: WorldGenTuning;
  readonly chunkCols: number;
  readonly chunkRows: number;
  readonly width: number; // 出生区总 tile 宽（192；世界本身无限）
  readonly height: number;
  private readonly tileKeys: string[]; // index -> tile id
  private readonly tilesDefs: Record<string, TileDef>; // mod 可注入（覆盖后生效）
  private buildingsDefs: Record<string, BuildingDef>; // 可变：Sim.mountPack 运行时热挂载新建筑
  private readonly biomeSeeds: BiomeSeeds; // 生成层三轴种子（seed 确定性派生）
  private readonly seed: number;
  rng: SimRng;
  // 生成层缓存（懒生成；不落盘。P2 活跃半径驱逐时丢这些缓存即可）
  private genChunks = new Map<number, Uint8Array>();
  // 覆盖层（只存与生成层的差异——DESIGN §370；P0 内存 Map，P2 落盘）
  private overlay = new Map<number, Map<number, number>>();
  // 光照按 chunk（只有探索过的 chunk 有 light 数组）
  private lightChunks = new Map<number, Uint8Array>();
  // 玩法点缀表（TileDef.sparse 声明收集；构造时固定种子，懒生成确定性）
  private sparsePatches: SparsePatch[] = [];
  // 旧档标记：loadTiles 收到旧格式 string[]（192×192 全量）→ 建筑 key 按旧公式解码
  private legacyKeyDecode = false;

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
    this.biomeSeeds = deriveBiomeSeeds(seed);
    // 玩法点缀表（2026-08-15 数据化：TileDef.sparse 声明 → 轴种子在构造时固定，
    // chunk 懒生成查表仍确定性；defs 快照进 World 是既定设计——Sim 构造后注册的
    // 建筑/地形进不了此表，与 buildingsDefs 同姿势，不做动态支持）
    this.sparsePatches = buildSparsePatches(seed, this.tilesDefs);
    this.generate();
  }

  private tileIdToIndex(id: string): number {
    return this.tileKeys.indexOf(id);
  }

  // ---- chunk 双图层核心 ----
  // chunk 键编码（支持负坐标，DESIGN §362）：范围 ±2^15 chunk（=±2M tile）
  private chunkKey(cx: number, cy: number): number {
    return (cx + 32768) + (cy + 32768) * 65536;
  }

  private ensureChunk(cx: number, cy: number): Uint8Array {
    const ck = this.chunkKey(cx, cy);
    let c = this.genChunks.get(ck);
    if (!c) {
      // 生成层：确定性地形（tileAt 坐标化 → 任意 chunk 独立生成，DESIGN §375 seededRng 即得）
      c = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
      const ox = cx * CHUNK_SIZE;
      const oy = cy * CHUNK_SIZE;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          c[ly * CHUNK_SIZE + lx] = this.tileIdToIndex(tileAt(ox + lx, oy + ly, this.biomeSeeds, this.sparsePatches));
        }
      }
      this.genChunks.set(ck, c);
    }
    return c;
  }

  private ensureLightChunk(cx: number, cy: number): Uint8Array {
    const ck = this.chunkKey(cx, cy);
    let c = this.lightChunks.get(ck);
    if (!c) {
      c = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
      this.lightChunks.set(ck, c);
    }
    return c;
  }

  // 确定性出生区生成 + 特判（清场/资源/洞穴/连通性——写覆盖层，作为"程序化预置覆盖"）
  private generate(): void {
    const cx = Math.floor(this.width / 2);
    const cy = Math.floor(this.height / 2);
    // 出生点清场：spawnClearRadius 可通行草地（四周仍按生成层）
    const clr = this.gen.spawnClearRadius;
    for (let dy = -clr; dy <= clr; dy++) {
      for (let dx = -clr; dx <= clr; dx++) {
        this.setTile(cx + dx, cy + dy, 'grass');
      }
    }
    // 出生点近圈资源保证（饥荒式开局）：树/矿/石/水，确定性
    this.ensureSpawnResources(cx, cy);
    // 天然洞穴：石头/山地附近确定性撒布（shelter 地形——洞穴有天然庇护属性，可被改造科技利用）
    this.ensureCaves(cx, cy);
    // 出生点连通性保证：BFS 从出生点算可达面积，被水域/森林环围时破口为草地
    this.ensureSpawnConnectivity(cx, cy);
  }

  // 出生点必须通向大陆（树/水不可通行 + 平滑噪声成片 → 曾实测出生点可达仅 0.1%：
  // 全图 192² 只剩出生圈几十格可走，玩法空间被封锁）。
  // 做法：BFS 测可达面积；不足 15% 全图时，把出生域边界的水/树/石丘（stone z2 高地）
  // 改成草地，逐轮扩张。
  // 2026-08-14 高差地图：BFS 走鼠人实际通过能力（climb 1 + z 判定）——
  // 石丘（z2）对鼠人是"上不去"的障碍，若石丘带围住出生低地必须破口（否则开局被困）
  // 2026-08-14 无限地图：BFS 限制在出生区（width×height）内——**出出生区边界 = 已连通
  // 外部世界（生成层纯噪声自由生成）**，直接视为可达返回；否则 BFS 会顺着大陆外扩
  // 生成成百上千 chunk（无限地图无边界，大陆可能无限大）——构造时间爆炸
  private ensureSpawnConnectivity(cx: number, cy: number): void {
    const minArea = this.width * this.height * 0.15; // 有船后可造船渡水，破口只需保证开局不困
    for (let pass = 0; pass < 30; pass++) {
      // BFS 可达面积（climb 1：鼠人通过能力；出生点 grass z0）
      // key 用无限坐标编码（x+y*2^31）——出生区外格由边界分支直接加入（不展开）
      const keyOf = (x: number, y: number) => x + y * World.COORD_K;
      const seen = new Set<number>([keyOf(cx, cy)]);
      const frontier = [keyOf(cx, cy)];
      let head = 0;
      while (head < frontier.length) {
        const k = frontier[head++];
        const x = k % World.COORD_K;
        const y = Math.floor(k / World.COORD_K);
        const zHere = this.getTileDef(x, y).z ?? 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          const nk = keyOf(nx, ny);
          if (seen.has(nk)) continue;
          // 出生区外 = 自由世界（生成层）→ 视为连通，直接算可达
          if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) {
            seen.add(nk);
            continue;
          }
          if (this.isPassable(nx, ny, zHere, 1)) {
            seen.add(nk);
            frontier.push(nk);
          }
        }
      }
      if (seen.size >= minArea) return;
      // 破口：把可达域边界上的不可通行/不可攀格（水/树/石丘）变草地（最近圈优先，BFS 层序即近→远）
      // 只处理出生区内的格（区外格 = 边界分支加入的"已连通"标记，不破口）
      for (const k of seen) {
        const x = k % World.COORD_K;
        const y = Math.floor(k / World.COORD_K);
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
        const zHere = this.getTileDef(x, y).z ?? 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          const nk = keyOf(nx, ny);
          if (seen.has(nk)) continue;
          const id = this.getTile(nx, ny);
          if (id === 'water' || id === 'tree' || id === 'stone') this.setTile(nx, ny, 'grass');
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

  // 天然洞穴生成：以石头/山地格为锚点，邻格撒 cave tile（shelter）
  // 数量/距离读 tuning.world（caveCount），确定性（SimRng）
  private ensureCaves(cx: number, cy: number): void {
    const g = this.gen;
    const rng = new SimRng(this.seed ^ 0xcafe);
    let placed = 0;
    for (let y = 4; y < this.height - 4 && placed < g.caveCount; y++) {
      for (let x = 4; x < this.width - 4 && placed < g.caveCount; x++) {
        const t = this.getTile(x, y);
        if (t !== 'stone' && t !== 'mountain') continue;
        // 锚点邻格随机选一个放洞穴（不覆盖出生圈）
        const dx = rng.int(-1, 1);
        const dy = rng.int(-1, 1);
        const nx = x + dx;
        const ny = y + dy;
        if (Math.abs(nx - cx) < 3 && Math.abs(ny - cy) < 3) continue; // 出生圈附近不撒
        if (this.getTile(nx, ny) === 'grass' || this.getTile(nx, ny) === 'dirt' || this.getTile(nx, ny) === 'sand') {
          this.setTile(nx, ny, 'cave');
          placed++;
        }
      }
    }
  }

  // 无限地图无边界：inBounds 恒 true（调用点语义 = "坐标是否可访问"——无限下都可）
  // 真正的防御是 MAX_TILE（getTile/setTile 越限返回 mountain/忽略）
  inBounds(x: number, y: number): boolean {
    return Math.abs(x) <= MAX_TILE && Math.abs(y) <= MAX_TILE;
  }

  // 建筑 key 编码：x + y*2^31（支持负坐标；|x|<2^31 无碰撞；y < 2^22 不超安全整数）
  static readonly COORD_K = 2 ** 31;

  // 负坐标安全解码（2026-08-14 review 修复）：Math.floor(key / COORD_K) 对负 key 有
  // 浮点误差（-7.0000000000000023 → -8），故先用 % 取余、再减 x 求 y。
  // ⚠️ 修复背景：JS % 是截断余数，x 与 y 异号时余数被偏移 2^31——
  // 实测 (5,-7)→(-2^31+5,-6)、(1,-1)→(-2^31+1,0)，负区建筑全部解码错位；
  // （此前测试只覆盖了 (-5,-7) 同号负坐标，异号被掩盖。）
  // 正确性依据：世界坐标被 MAX_TILE(±2^21) 钳制，而偏移量是 2^31 量级——二者
  // 永不重叠，故 |余数| > MAX_TILE 即判定为偏移，回拨一格 COORD_K 并修正 y。
  static keyToXY(key: number): { x: number; y: number } {
    let x = key % World.COORD_K;
    // -0 归一（JS % 对 -COORD_K 倍数返回 -0，toEqual 会区分 +0/-0，测试失败暴露）
    if (x === 0) x = 0;
    if (x > MAX_TILE) {
      x -= World.COORD_K; // 余数偏向正端（x<0 且 y>0 的组合，如 -1+1*2^31）
    } else if (x < -MAX_TILE) {
      x += World.COORD_K; // 余数偏向负端（x>0 且 y<0 的组合，如 1-1*2^31）
    }
    const y = (key - x) / World.COORD_K; // x 修正后 key-x 必为 COORD_K 整数倍（2 的幂，除法精确）
    return { x, y };
  }

  getTile(x: number, y: number): string {
    // 越界防御：±MAX_TILE 外 → mountain（不可走；hash 精度保护，正常探索达不到）
    if (!this.inBounds(x, y)) return 'mountain';
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const offset = (y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE);
    // 覆盖层优先（DESIGN §370：改动 = 与生成层的差异）
    const ov = this.overlay.get(this.chunkKey(cx, cy));
    if (ov) {
      const o = ov.get(offset);
      if (o !== undefined) return this.tileKeys[o] ?? 'grass';
    }
    const c = this.ensureChunk(cx, cy);
    return this.tileKeys[c[offset]] ?? 'grass';
  }

  // 瓦片变更监听（采集/事件改地形 → server 推送增量；null = 不监听）
  onTileChange: ((x: number, y: number, tileId: string) => void) | null = null;

  // 建筑摧毁监听（2026-08-20 审查修复：清算/袭击/怒砸摧毁锚点 → sim 需清航点段缓存；
  // 此前仅"建成"清缓存（buildSystem），"摧毁"路径不触发 → 被拆篝火/教堂的锚点对路由
  // 仍被 trailCache 复用（小人借道已消失的锚点）。tile 变更不覆盖此处：拆建筑不改瓦片。）
  onBuildingDestroyed: ((key: number) => void) | null = null;

  setTile(x: number, y: number, tileId: string): void {
    if (!this.inBounds(x, y)) return;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const offset = (y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE);
    const idx = this.tileIdToIndex(tileId);
    if (idx < 0) return;
    const ck = this.chunkKey(cx, cy);
    const genIdx = this.ensureChunk(cx, cy)[offset];
    const ov = this.overlay.get(ck);
    if (ov) {
      if (idx === genIdx) {
        // 改回生成层默认 → 删覆盖记录（双图层：只存差异）
        ov.delete(offset);
        if (ov.size === 0) this.overlay.delete(ck);
      } else if (ov.get(offset) === idx) {
        return; // 覆盖层同值：无变化（不触发 onTileChange）
      } else {
        ov.set(offset, idx);
      }
    } else {
      if (idx === genIdx) return; // 与生成层一致 → 无覆盖，无变化
      this.overlay.set(ck, new Map([[offset, idx]]));
    }
    this.onTileChange?.(x, y, tileId);
  }

  // 序列化：只导出覆盖层（DESIGN §375：覆盖层才需要持久化和网络传输）——chunk 级
  serializeChunks(): ChunkData[] {
    const out: ChunkData[] = [];
    for (const [ck, ov] of this.overlay) {
      const cx = (ck % 65536) - 32768;
      const cy = Math.floor(ck / 65536) - 32768;
      const tiles: string[] = new Array(CHUNK_SIZE * CHUNK_SIZE);
      for (const [offset, idx] of ov) tiles[offset] = this.tileKeys[idx];
      // 稀疏数组 → 紧凑数组（空位 = 生成层默认，客户端/存档端缺省即生成层）
      const compact: string[] = [];
      for (let i = 0; i < tiles.length; i++) compact.push(tiles[i] ?? '');
      out.push({ x: cx, y: cy, tiles: compact });
    }
    return out;
  }

  // 全部已生成 chunk 的完整地形（生成层+覆盖层合成）——初始快照/客户端渲染用
  //（P2 流式协议 chunkData.terrain 同形状；P0 快照全量下发已生成区）
  serializeTerrainChunks(): ChunkData[] {
    const out: ChunkData[] = [];
    for (const [ck, c] of this.genChunks) {
      const cx = (ck % 65536) - 32768;
      const cy = Math.floor(ck / 65536) - 32768;
      const ov = this.overlay.get(ck);
      const tiles: string[] = new Array(c.length);
      for (let i = 0; i < c.length; i++) {
        const o = ov?.get(i);
        tiles[i] = this.tileKeys[o !== undefined ? o : c[i]] ?? 'grass';
      }
      out.push({ x: cx, y: cy, tiles });
    }
    return out;
  }

  // 覆盖层导入（新档 chunk 格式）
  loadChunks(data: ChunkData[]): void {
    for (const c of data) {
      const ck = this.chunkKey(c.x, c.y);
      const ov = new Map<number, number>();
      for (let i = 0; i < c.tiles.length; i++) {
        const id = c.tiles[i];
        if (!id) continue; // 空 = 无差异（生成层默认）
        const idx = this.tileIdToIndex(this.tilesDefs[id] ? id : 'grass');
        ov.set(i, idx);
      }
      if (ov.size > 0) this.overlay.set(ck, ov);
      this.ensureChunk(c.x, c.y); // 确保生成层存在（后续 getTile 的 diff 判定基准）
    }
    this.legacyKeyDecode = false;
  }

  // 旧档兼容：全量 string[]（192×192）→ 覆盖写入出生区
  loadTiles(tiles: string[]): void {
    if (tiles.length !== this.width * this.height) return;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const id = this.tilesDefs[tiles[y * this.width + x]] ? tiles[y * this.width + x] : 'grass';
        this.setTile(x, y, id);
      }
    }
    this.legacyKeyDecode = true;
  }

  serializeBuildings(): { key: number; defId: string; hp: number; faction: string; extra?: Record<string, unknown> }[] {
    return [...this.buildings.entries()].map(([key, b]) => ({
      key, defId: b.def.id, hp: b.hp, faction: b.faction,
      extra: b.extra && Object.keys(b.extra).length > 0 ? b.extra : undefined, // mod 自定义字段（电力/温度/伤情存档扩展点）
    }));
  }

  loadBuildings(data: { key: number; defId: string; hp: number; faction: string; extra?: Record<string, unknown> }[]): void {
    this.buildings.clear();
    this.gridToBuilding.clear();
    this.buildingFootprint.clear();
    this.buildingChunks.clear();
    for (const d of data) {
      const def = this.buildingsDefs[d.defId];
      if (!def) continue;
      // 旧档（全量 tiles 格式）key = y*width+x；新档 = x + y*2^31 —— 加载时迁移
      const xy = this.legacyKeyDecode
        ? { x: d.key % this.width, y: Math.floor(d.key / this.width) }
        : World.keyToXY(d.key);
      const mainKey = this.buildKey(xy.x, xy.y);
      this.buildings.set(mainKey, { def, hp: d.hp, faction: d.faction, extra: d.extra });
      const footprint = this.footprintKeys(xy.x, xy.y, def);
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

  // 通行判定（2026-08-14 起带 z 维度）：
  //   - 地形/建筑可走性（原判定）
  //   - 高差判定（用户设计：地形有 z 值，高差过大无法上去）：|Δz| > climb → 不通；
  //     fromZ 缺省 = 不判高差（旧调用面行为不变）
  //   - 道路豁免：目标格是 road（坡道垫平）→ 忽略高差；地道入口恒可通行
  //     （另一维度，与地表判定无关——但入口本身是地表格，人需从地表走到入口）
  isPassable(x: number, y: number, fromZ?: number, climb?: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const b = this.getBuilding(x, y);
    // 地道入口：本身可通行（地表可走到洞口；入口间穿行走寻路虚拟边，不走地表）
    if (b && b.def.tags?.includes('tunnel')) return true;
    // 地形可走性
    if (!this.getTileDef(x, y).passable) return false;
    // 建筑阻挡（墙等 passable=false 的建筑挡住，含 footprint 辅助格）
    if (b && !b.def.passable) return false;
    // 高差判定：|Δz| > 通过能力 → 无法上下（道路格豁免 = 修路垫平陡坡）
    if (fromZ !== undefined && climb !== undefined && !(b && b.def.tags?.includes('road'))) {
      const zHere = this.getTileDef(x, y).z ?? 0;
      if (Math.abs(zHere - fromZ) > climb) return false;
    }
    return true;
  }

  // P0 简化：建筑占位，直接存 Map（后期进 ECS）
  buildings = new Map<number, BuildingData>();
  // 篝火区域记忆（2026-08-14 重构：派系实体层删除后，区域历史改挂在 campfire 建筑上；
  // key = 篝火主格，供交流篝火情况读取。无派系单位 id 可指）
  fireMemory = new Map<number, { time: number; text: string }[]>();
  buildingVersion = 0; // 建筑版本号，渲染层据此重绘
  // 格子 → 建筑主格 key（多格 footprint 反向索引）
  private gridToBuilding = new Map<number, number>();
  // 建筑主格 key → footprint 全部格子（多格）
  private buildingFootprint = new Map<number, number[]>();

  buildKey(x: number, y: number): number {
    return x + y * World.COORD_K;
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
  getBuilding(x: number, y: number): BuildingData | null {
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
    const { x: mx, y: my } = World.keyToXY(main);
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
      // 通知 sim 清航点缓存（锚点销毁后旧路由不可用；2026-08-20 审查修复）
      this.onBuildingDestroyed?.(main);
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

  // 建筑分区键（无限坐标）：cx + cy*1e6（|cx|<5e5 无碰撞；8×8 分区下 tile ±2^21 → cx ±2^18）
  private chunkKeyOf(key: number): number {
    const { x: gx, y: gy } = World.keyToXY(key);
    return Math.floor(gx / World.CHUNK) + Math.floor(gy / World.CHUNK) * 1000000;
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
        const cell = this.buildingChunks.get(cx + cy * 1000000);
        if (!cell) continue;
        for (const mk of cell) {
          if (seen.has(mk)) continue;
          seen.add(mk);
          let minD = Infinity;
          for (const fk of this.buildingFootprint.get(mk) ?? [mk]) {
            const { x: fx, y: fy } = World.keyToXY(fk);
            const d = (fx - x) ** 2 + (fy - y) ** 2;
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

  // 半径内带 tag 建筑的**最近一栋**（2026-08-20 热路径优化：决策谓词 campfireDist 等
  // 原用 queryBuildingsNear(…, 64) 每小人每帧构建全部近邻建筑数组（对象分配 + 排序
  // 遍历），profiler 采样 world 查询为热点前列——专用查询免数组分配、共享 chunk 遍历、
  // 命中即可比较早退；返回 null = 半径内无该 tag 建筑）
  nearestBuildingWithTag(x: number, y: number, radius: number, tag: string): { key: number; dist: number } | null {
    const r2 = radius * radius;
    let best: { key: number; dist: number } | null = null;
    let bestD2 = Infinity;
    const seen = new Set<number>();
    const c0x = Math.floor((x - radius) / World.CHUNK);
    const c1x = Math.floor((x + radius) / World.CHUNK);
    const c0y = Math.floor((y - radius) / World.CHUNK);
    const c1y = Math.floor((y + radius) / World.CHUNK);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const cell = this.buildingChunks.get(cx + cy * 1000000);
        if (!cell) continue;
        for (const mk of cell) {
          if (seen.has(mk)) continue;
          seen.add(mk);
          const b = this.buildings.get(mk);
          if (!b || !b.def.tags?.includes(tag)) continue;
          let minD = Infinity;
          for (const fk of this.buildingFootprint.get(mk) ?? [mk]) {
            // 内联 World.keyToXY（热路径：每 footprint 格解码一次，省对象分配）
            let fx = fk % World.COORD_K;
            if (fx === 0) fx = 0;
            if (fx > MAX_TILE) fx -= World.COORD_K;
            else if (fx < -MAX_TILE) fx += World.COORD_K;
            const fy = (fk - fx) / World.COORD_K;
            const d = (fx - x) ** 2 + (fy - y) ** 2;
            if (d < minD) minD = d;
          }
          if (minD < bestD2) { bestD2 = minD; best = { key: mk, dist: Math.sqrt(minD) }; }
        }
      }
    }
    return bestD2 <= r2 ? best : null;
  }

  canBuildFootprint(x: number, y: number, def: (typeof BUILDINGS)[string]): boolean {
    if (def.onTunnel) {
      // 地道入口：挖在**地表可通行格**（grass/泥/沙/石等——人得先走到洞口才能进地道；
      // 树上/水中/山里开洞无意义，不可建）。"和地图不产生关联"指**地道维度**的通行判定
      //（入口之间地下直连、无视地表地形/高差），入口位置本身仍要地表可达
      const keys = this.footprintKeys(x, y, def);
      for (const key of keys) {
        const { x: gx, y: gy } = World.keyToXY(key);
        if (!this.inBounds(gx, gy)) return false;
        if (!this.getTileDef(gx, gy).passable) return false;
        if (this.getBuilding(gx, gy)) return false;
      }
      return true;
    }
    // 水上建筑（竹筏/渡船/木桥）：footprint 全为水面 + 至少一格邻接陆地或已有水上建筑
    //（从岸边/筏链逐步铺 → 渡水玩法闭环；孤水中央不可凭空建）
    if (def.onCave) {
      // 洞穴改造（caveHouse）：footprint 全为天然洞穴格
      for (const key of this.footprintKeys(x, y, def)) {
        const { x: gx, y: gy } = World.keyToXY(key);
        if (!this.inBounds(gx, gy)) return false;
        if (this.getTile(gx, gy) !== 'cave') return false;
        if (this.getBuilding(gx, gy)) return false;
      }
      return true;
    }
    if (def.onWater) {
      const keys = this.footprintKeys(x, y, def);
      for (const key of keys) {
        const { x: gx, y: gy } = World.keyToXY(key);
        if (!this.inBounds(gx, gy)) return false;
        if (this.getTileDef(gx, gy).id !== 'water') return false;
        if (this.getBuilding(gx, gy)) return false;
      }
      for (const key of keys) {
        const { x: gx, y: gy } = World.keyToXY(key);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = gx + dx;
          const ny = gy + dy;
          const nk = this.buildKey(nx, ny);
          if (keys.includes(nk)) continue; // 邻居在 footprint 内不算（自身不能撑自己）
          const nB = this.getBuilding(nx, ny);
          if (nB && nB.def.onWater) return true;  // 邻筏
          if (this.getTileDef(nx, ny).id !== 'water') return true; // 邻陆地
        }
      }
      return false;
    }
    for (const key of this.footprintKeys(x, y, def)) {
      const { x: gx, y: gy } = World.keyToXY(key);
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
  // extra = mod 自定义字段（存档扩展点：电网温度等随建筑持久）；缺省 undefined
  // 2026-08-20「DLC 里加 DLC」：运行时注册建筑 def（mountPack 热挂载后调用，
  // 否则运行中挂载的新建筑因 buildingsDefs 是构造时快照而无法放置）。
  registerBuildingDef(id: string, def: BuildingDef): void {
    this.buildingsDefs[id] = def;
  }
  hasBuildingDef(id: string): boolean {
    return id in this.buildingsDefs;
  }

  placeBuilding(x: number, y: number, defId: string, faction: string, extra?: Record<string, unknown>): boolean {
    const def = this.buildingsDefs[defId];
    if (!def) return false;
    if (!this.canBuildFootprint(x, y, def)) return false;
    const mainKey = this.buildKey(x, y);
    this.buildings.set(mainKey, { def, hp: def.hp, faction, extra });
    const footprint = this.footprintKeys(x, y, def);
    this.buildingFootprint.set(mainKey, footprint);
    for (const fk of footprint) this.gridToBuilding.set(fk, mainKey);
    this.indexBuilding(mainKey);
    this.buildingVersion++;
    this.recomputeLight();
    return true;
  }

  // 升级落点校验（2026-08-20 审查修复）：升级会扩展 footprint（如 1×1 篝火 → 2×2 教堂），
  // 新 footprint 中超出旧 footprint 的格子必须可建且未被其他建筑占用。此前 upgradeBuilding
  // 无条件覆盖 gridToBuilding → 相邻建筑的格子归属被后升级者顶掉（建筑索引错乱：两座相邻
  // 篝火各升教堂，后者的 2×2 覆盖前者格）。旧 footprint 格豁免（本来就是自己的）。
  // 返回 false = 不可升级（buildSystem 应放弃蓝图且不扣资源）。
  canUpgradeAt(x: number, y: number, def: (typeof BUILDINGS)[string]): boolean {
    const main = this.mainKey(x, y);
    if (!this.buildings.has(main)) return false;
    const old = this.buildingFootprint.get(main) ?? [main];
    for (const key of this.footprintKeys(x, y, def)) {
      if (old.includes(key)) continue; // 旧 footprint 格豁免（自身占用）
      const { x: gx, y: gy } = World.keyToXY(key);
      if (!this.inBounds(gx, gy)) return false;
      if (!this.getTileDef(gx, gy).buildable) return false;
      if (this.getBuilding(gx, gy)) return false;
    }
    return true;
  }

  // 升级建筑（如篝火→教堂，Q9 即时指令：教堂=篝火升级）
  upgradeBuilding(x: number, y: number, defId: string, faction: string): boolean {
    const main = this.mainKey(x, y);
    if (!this.buildings.has(main)) return false;
    const def = this.buildingsDefs[defId];
    if (!def) return false;
    // 落点校验（2026-08-20 审查修复）：新 footprint 超出旧 footprint 的格子被占/不可建
    // → 拒绝升级（此前无条件覆盖 gridToBuilding，相邻建筑归属错乱）
    if (!this.canUpgradeAt(x, y, def)) return false;
    // 旧 footprint 释放
    const old = this.buildingFootprint.get(main) ?? [main];
    for (const fk of old) this.gridToBuilding.delete(fk);
    this.buildings.set(main, { def, hp: def.hp, faction, extra: this.buildings.get(main)?.extra });
    // 新 footprint 建立
    const { x: x0, y: y0 } = World.keyToXY(main);
    const footprint = this.footprintKeys(x0, y0, def);
    this.buildingFootprint.set(main, footprint);
    for (const fk of footprint) this.gridToBuilding.set(fk, main);
    this.unindexBuilding(main);
    this.indexBuilding(main);
    this.buildingVersion++;
    this.recomputeLight();
    return true;
  }

  // 光照：按已生成 chunk 存（无限地图全图 light 数组不可行——只点亮有光源建筑
  // 的覆盖 chunk；远处未探索 chunk isLit 恒 false）
  recomputeLight(): void {
    for (const c of this.lightChunks.values()) c.fill(0);
    for (const [key, b] of this.buildings) {
      const RADIUS = b.def.emitsLight ?? 0;
      if (RADIUS <= 0) continue;
      const { x: bx, y: by } = World.keyToXY(key);
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          const x = bx + dx, y = by + dy;
          if (dx * dx + dy * dy > RADIUS * RADIUS) continue;
          if (!this.inBounds(x, y)) continue;
          const cx = Math.floor(x / CHUNK_SIZE);
          const cy = Math.floor(y / CHUNK_SIZE);
          const offset = (y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE);
          this.ensureLightChunk(cx, cy)[offset] = 1;
        }
      }
    }
  }

  isLit(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const c = this.lightChunks.get(this.chunkKey(cx, cy));
    if (!c) return false;
    return c[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)] === 1;
  }
}
