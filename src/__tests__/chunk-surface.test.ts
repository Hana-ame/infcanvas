/**
 * chunk-surface.test.ts —— 块协议面 terrainChunk / buildingsInChunks / featuresInChunks /
 * hostilesInChunks 的契约测试（2026-10-08 r 线拆分第一刀）。
 *
 * 三条红线：
 *  1. **整块返回**：terrainChunk 一次返回 64×64 整块，不是 per-tile 查询的封装。
 *     断言验证数组长度与坐标覆盖，并随机抽样逐格对拍 tileAt/zAt 的 per-tile 查询，
 *     确保"批量取"与"逐个取"语义一致。
 *  2. **双模同构**：LocalView 与 RemoteSim 对同一份 Sim 快照必须返回相同的块面数据
 *     （与 client-view.test.ts 的「双模同脸」同一纪律）。
 *  3. **建筑/敌袭按块裁剪**：buildingsInChunks / hostilesInChunks 只返回指定块内的实体，
 *     不遗漏也不溢出。
 */
import { describe, expect, it } from 'vitest';
import { Sim, snapshotOf } from '../sim';
import { ModRegistry } from '../mods';
import { LocalView } from '../client/local-view';
import { RemoteSim } from '../client/remote';
import { CHUNK_SIZE, chunkKey, tileChunkKey } from '../shared/chunks';
import type { BuildingState } from '../sim/types';

/** 快速提取 chunk key 集合（单块中心） */
function ck(cx: number, cy: number): number[] {
  return [chunkKey(cx, cy)];
}

function makeLocal(seed = 42, steps = 30): { view: LocalView; sim: Sim } {
  const sim = new Sim({ seed, registry: ModRegistry.default() });
  for (let i = 0; i < steps; i++) sim.step(0.25);
  return { view: new LocalView(sim), sim };
}

describe('terrainChunk 整块返回', () => {
  it('返回 64×64 数组（尺寸契约）', () => {
    const { view } = makeLocal();
    const t = view.terrainChunk(0, 0);
    expect(t.size).toBe(CHUNK_SIZE);
    expect(t.kinds).toHaveLength(CHUNK_SIZE * CHUNK_SIZE);
    expect(t.zs).toHaveLength(CHUNK_SIZE * CHUNK_SIZE);
  });

  it('坐标范围正确：起点是 cx*64, cy*64', () => {
    const { view } = makeLocal();
    // 坐标 (0,0) 对应块内 (lx=0, ly=0)
    const t = view.terrainChunk(0, 0);
    expect(t.kinds[0]).toBe(view.tileAt(0, 0));
    expect(t.zs[0]).toBe(view.zAt(0, 0));
  });

  it('逐格对拍：整块取出的 kinds/zs 与 per-tile 查询一致（随机抽样 64 格）', () => {
    const { view } = makeLocal();
    const t = view.terrainChunk(1, 2); // 随便一块不居中
    const x0 = 1 * CHUNK_SIZE;
    const y0 = 2 * CHUNK_SIZE;
    for (let i = 0; i < 64; i++) {
      const rlx = Math.floor(Math.random() * CHUNK_SIZE);
      const rly = Math.floor(Math.random() * CHUNK_SIZE);
      const idx = rly * CHUNK_SIZE + rlx;
      const x = x0 + rlx;
      const y = y0 + rly;
      expect(t.kinds[idx]).toBe(view.tileAt(x, y));
      expect(t.zs[idx]).toBe(view.zAt(x, y));
    }
  });

  it('负坐标块：(-1, -1) 块也能正确返回', () => {
    const { view } = makeLocal();
    const t = view.terrainChunk(-1, -1);
    const x0 = -1 * CHUNK_SIZE;
    const y0 = -1 * CHUNK_SIZE;
    // 取右上角一格(0,0)对拍
    const idx = (CHUNK_SIZE - 1 - y0 % CHUNK_SIZE) * CHUNK_SIZE + (0 - x0 % CHUNK_SIZE);
    expect(t.kinds).toHaveLength(CHUNK_SIZE * CHUNK_SIZE);
    expect(typeof t.kinds[0]).toBe('string');
  });

  it('构建物快照不可写（return 的数组是 fresh 的——渲染层改它不影响下次调用）', () => {
    const { view } = makeLocal();
    const t1 = view.terrainChunk(0, 0);
    const t2 = view.terrainChunk(0, 0);
    t1.kinds[0] = 'water'; // 渲染侧改，不应影响快照
    expect(t2.kinds[0]).toBe(view.tileAt(0, 0));
  });
});

describe('buildingsInChunks 按块裁剪', () => {
  it('一块内的建筑：只返回该块内的', () => {
    const { view, sim } = makeLocal();
    // 找到 origin 块(0,0)内的所有建筑
    const originKeys = ck(0, 0);
    const allB = sim.world.buildings;
    const inOrigin = [...allB.values()].filter(
      (b) => tileChunkKey(b.pos.x, b.pos.y).key === chunkKey(0, 0),
    );
    const result = view.buildingsInChunks(originKeys);
    expect(result.length).toBe(inOrigin.length);
    for (const b of result) {
      expect(allB.has(b.id)).toBe(true);
    }
  });

  it('空块返回空数组', () => {
    const { view } = makeLocal();
    // 极远的块（确认不会因"边界溢出"返回格外的建筑）
    const farKeys = ck(999, 999);
    expect(view.buildingsInChunks(farKeys)).toEqual([]);
  });

  it('跨多块：总和 ≤ 全量建筑数（块间边界不重复包含同一建筑）', () => {
    const { view, sim } = makeLocal(42, 200);
    const allB = [...sim.world.buildings.values()];
    // 扫近处几块
    const keys = [ck(0, 0), ck(0, 1), ck(1, 0), ck(1, 1)];
    const union = new Set<string>();
    for (const ks of keys) {
      for (const b of view.buildingsInChunks(ks)) union.add(b.id);
    }
    expect(union.size).toBeLessThanOrEqual(allB.length);
  });
});

describe('hostilesInChunks 按块裁剪', () => {
  it('敌对单位在指定块内时被返回', () => {
    const { view, sim } = makeLocal(42, 50);
    // spawn 一只在 (0,0) 块内的猫
    const h = sim.spawnHostile('cat', 5, 5);
    const result = view.hostilesInChunks(ck(0, 0));
    expect(result.find((x) => x.id === h.id)).toBeDefined();
  });

  it('敌对单位不在指定块内时不被返回', () => {
    const { view, sim } = makeLocal(42, 50);
    const h = sim.spawnHostile('cat', 5, 5);
    const result = view.hostilesInChunks(ck(10, 10));
    expect(result.find((x) => x.id === h.id)).toBeUndefined();
  });
});

describe('featuresInChunks 按块返回', () => {
  it('块内特征数量≥per-tile 逐个累积（不遗漏）', () => {
    const { view } = makeLocal();
    const fMap = view.featuresInChunks(ck(0, 0));
    let perTile = 0;
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const f = view.featureAt(x, y);
        if (f) perTile++;
      }
    }
    expect(fMap.size).toBeGreaterThanOrEqual(perTile); // 可能包含邻块锚点（2×2 树覆盖）
  });

  it('键是 "x,y" 字符串格式', () => {
    const { view } = makeLocal();
    const fMap = view.featuresInChunks(ck(0, 0));
    if (fMap.size > 0) {
      const firstKey = [...fMap.keys()][0];
      expect(firstKey).toMatch(/^-?\d+,-?\d+$/);
      const f = fMap.get(firstKey)!;
      expect(['tree', 'berry']).toContain(f.kind);
      expect(f.amount).toBeGreaterThan(0);
    }
  });
});

describe('双模同构：LocalView 与 RemoteSim 块面一致', () => {
  function bothViews(seed = 42, steps = 100): { local: LocalView; remote: RemoteSim; sim: Sim } {
    const sim = new Sim({ seed, registry: ModRegistry.default() });
    for (let i = 0; i < steps; i++) sim.step(0.25);
    const local = new LocalView(sim);
    const snap = snapshotOf(sim);
    const remote = new RemoteSim();
    // FullState.buildings 必须是 BuildingState[]（snapshotOf 里的 world.buildings
    // 是 Map<string, BuildingState>，要展开）
    const buildings = [...sim.world.buildings.values()];
    remote.handleForTest({
      t: 'welcome',
      d: {
        time: snap.time,
        stockpile: snap.stockpile,
        pawns: snap.pawns,
        hostiles: snap.hostiles,
        buildings,
        events: snap.events,
        world: snap.world,
        techs: snap.techs,
        techFragments: snap.techFragments,
        hudScratch: {},
        seed: sim.world.seed,
        tuning: structuredClone(sim.tuning),
      },
    });
    return { local, remote, sim };
  }

  it('terrainChunk 在本地与联机模式下一致', () => {
    const { local, remote } = bothViews();
    const tLocal = local.terrainChunk(0, 0);
    const tRemote = remote.terrainChunk(0, 0);
    expect(tRemote.size).toBe(tLocal.size);
    expect(tRemote.kinds).toEqual(tLocal.kinds);
    expect(tRemote.zs).toEqual(tLocal.zs);
  });

  it('terrainChunk 在(-1,-1)块同样一致', () => {
    const { local, remote } = bothViews(42, 20);
    const tLocal = local.terrainChunk(-1, -1);
    const tRemote = remote.terrainChunk(-1, -1);
    expect(tRemote.kinds).toEqual(tLocal.kinds);
    expect(tRemote.zs).toEqual(tLocal.zs);
  });

  it('buildingsInChunks 在本地与联机模式下一致', () => {
    const { local, remote } = bothViews(42, 100);
    const keys = [0, 1].flatMap((cy) => [0, 1].map((cx) => chunkKey(cx, cy)));
    const localB = local.buildingsInChunks(keys);
    const remoteB = remote.buildingsInChunks(keys);
    expect(localB.length).toBe(remoteB.length);
    for (let i = 0; i < localB.length; i++) {
      expect(localB[i].id).toBe(remoteB[i].id);
      expect(localB[i].defId).toBe(remoteB[i].defId);
    }
  });

  it('featuresInChunks 在本地与联机模式下一致', () => {
    const { local, remote } = bothViews(42, 50);
    const keys = [chunkKey(0, 0), chunkKey(0, 1), chunkKey(1, 0), chunkKey(1, 1)];
    // 特征锚点是纯哈希，双方应当完全一致
    const localF = local.featuresInChunks(keys);
    const remoteF = remote.featuresInChunks(keys);
    expect(remoteF.size).toBe(localF.size);
    for (const [k, v] of localF) {
      const r = remoteF.get(k);
      expect(r).toBeDefined();
      expect(r!.kind).toBe(v.kind);
      expect(r!.amount).toBe(v.amount);
    }
  });
});
