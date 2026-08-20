// 无限地图（2026-08-14 用户要求 + DESIGN §205-214/§355-385）：双图层 chunk 回归保护
// 覆盖：① 懒生成确定性（同 seed 同坐标同地形，chunk 不预先存在也即得）；
// ② 负坐标 chunk（整数对键，区外可走/可建）；③ 覆盖层差异（setTile 与生成层一致时无覆盖）；
// ④ 旧档兼容（loadTiles 全量字符串格式 / loadBuildings 旧 y*width+x key 迁移）。
// 发现背景：稀疏化 hash 化 + ensureSpawnConnectivity 出界视为连通前，BFS 会顺着可达大陆
// 无限外扩生成海量 chunk（构造 >30s、npm test 240s 超时）——所有测试/系统遍历必须限制
// 在出生区 width×height 内或显式出界即停。
import { describe, it, expect } from 'vitest';
import { World, CHUNK_SIZE } from '../core/world';

describe('无限地图：双图层 chunk', () => {
  it('懒生成确定性：同 seed 任意坐标 getTile 即得，且两次取值一致（不落盘、即取即算）', () => {
    const a = new World(777);
    const b = new World(777);
    // 出生区外的坐标（负坐标 + 远坐标）——chunk 未预生成也应确定
    for (const [x, y] of [[-1, -1], [-64, -128], [300, -50], [192, 192], [1000, 1000]]) {
      expect(a.getTile(x, y)).toBe(b.getTile(x, y)); // 同 seed 确定性
      expect(a.getTile(x, y)).toBe(a.getTile(x, y)); // 幂等
    }
  });

  it('负坐标 chunk：chunkKey 整数对支持负坐标，区外可走/可建不崩溃', () => {
    const w = new World(778);
    const key = w.buildKey(-5, -7);
    expect(World.keyToXY(key)).toEqual({ x: -5, y: -7 }); // 负坐标编码往返
    // 区外建 campfire（负坐标附近可建则建）
    let placed = false;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      if (w.placeBuilding(-8 + dx, -8 + dy, 'campfire', 'player')) { placed = true; break; }
    }
    expect(placed).toBe(true); // 负坐标区可正常建（世界无限，无边界拒绝）
    // 建筑 key 解码正确（正负都能还原）
    for (const [k] of [...w.buildings]) {
      const { x, y } = World.keyToXY(k);
      expect(w.buildKey(x, y)).toBe(k);
    }
  });

  it('keyToXY 全象限往返：异号负坐标也必须还原（review 修复回归）', () => {
    // 发现背景（review 2026-08-14）：JS % 是截断余数，x 与 y 异号时余数被偏移 2^31——
    // 实测 (5,-7)→(-2^31+5,-6)、(1,-1)→(-2^31+1,0)；此前测试只用 (-5,-7) 同号
    // 负坐标，异号组合被掩盖。修复后四象限 + 轴边界全部往返一致。
    const cases: [number, number][] = [
      [-5, -7], [5, -7], [-5, 7], [5, 7],       // 四象限
      [-1, 1], [1, -1], [-64, -128], [300, -50], // 小负/大负异号
      [0, -1], [-1, 0], [0, 7], [7, 0],          // 轴边界
      [1000, -2000], [192, 192], [-2, 2],        // 混合
    ];
    for (const [x, y] of cases) {
      const k = x + y * World.COORD_K;
      expect(World.keyToXY(k)).toEqual({ x, y });
      expect(World.keyToXY(k).y).toBe((k - World.keyToXY(k).x) / World.COORD_K); // y 为整数
    }
  });

  it('覆盖层差异：setTile 与生成层一致 → 不存覆盖（loadChunks 后等同生成层）', () => {
    const w = new World(779);
    const x = 70, y = 3; // 出生区内
    const before = w.getTile(x, y);
    w.setTile(x, y, before); // 与生成层一致 → 该格无覆盖记录（出生区破口可能写过其他格，只查本格）
    const ck = (1 + 32768) + (0 + 32768) * 65536; // (70,3) → chunk(1,0)
    const ov = (w as unknown as { overlay: Map<number, Map<number, number>> }).overlay;
    expect(ov.get(ck)?.has((3 % 64) * 64 + (70 % 64)) ?? false).toBe(false);
    w.setTile(x, y, 'dirt'); // 真实改动 → 覆盖层出现
    const chunks = w.serializeChunks();
    expect(chunks.some((c) => c.tiles.some((t) => t !== ''))).toBe(true);
    const w2 = new World(779);
    w2.loadChunks(chunks);
    expect(w2.getTile(x, y)).toBe('dirt');
  });

  it('序列化往返：serializeTerrainChunks 完整地形（生成层+覆盖合成，无空位）→ loadChunks 还原', () => {
    const w = new World(780);
    w.setTile(3, 3, 'water');
    w.setTile(70, 70, 'stone');
    const full = w.serializeTerrainChunks();
    // 完整地形：每个 chunk 无空位（''）
    for (const c of full) expect(c.tiles.every((t) => t !== '')).toBe(true);
    const w2 = new World(781); // 不同 seed：仅靠快照还原（生成层不同也应还原）
    w2.loadChunks(full);
    expect(w2.getTile(3, 3)).toBe('water');
    expect(w2.getTile(70, 70)).toBe('stone');
  });

  it('旧档兼容：loadTiles 全量字符串 192×192 → 覆盖层写入，且与生成层一致的格不产生覆盖', () => {
    const w = new World(782);
    const tiles: string[] = [];
    for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) tiles.push('grass');
    tiles[5 + 5 * w.width] = 'dirt'; // 模拟旧档：几乎全 grass + 一格外改
    w.loadTiles(tiles);
    expect(w.getTile(5, 5)).toBe('dirt');
    // 与生成层一致的 grass 不落覆盖（覆盖层只存差异）
    const ov = (w as unknown as { overlay: Map<number, Map<number, number>> }).overlay;
    let ovCount = 0;
    for (const m of ov.values()) ovCount += m.size;
    expect(ovCount).toBeLessThan(w.width * w.height); // 远少于全图
  });

  it('旧档兼容：loadBuildings 旧 key（y*width+x）自动迁移到新编码', () => {
    const w = new World(783);
    // 模拟旧档加载路径：Sim.load 对全量 tiles 格式档设置 legacyKeyDecode=true，
    // loadBuildings 据此用 y*width+x 解码并迁移到新 key
    (w as unknown as { legacyKeyDecode: boolean }).legacyKeyDecode = true;
    const legacy = [
      { defId: 'campfire', x: 10, y: 20, key: 10 + 20 * w.width, hp: 100, maxHp: 100, faction: 'player', footprint: [{ x: 10, y: 20 }] },
    ];
    w.loadBuildings(legacy as never);
    const b = w.getBuilding(10, 20);
    expect(b).toBeTruthy();
    expect(b!.def.id).toBe('campfire');
    // 新 key = x + y*2^31（旧 key 已迁移）
    expect(w.buildings.has(w.buildKey(10, 20))).toBe(true);
  });

  it('出生区连通性 BFS 出界即停：不顺着大陆外扩（构造快 + chunk 数受控）', () => {
    const t0 = performance.now();
    const w = new World(784);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(500); // 原 bug：构造 >30s（BFS 无限外扩生成海量 chunk）
    expect((w as unknown as { genChunks: Map<number, unknown> }).genChunks.size).toBeLessThanOrEqual(16);
    void CHUNK_SIZE;
  });
});
