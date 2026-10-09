/**
 * chunk-index-direct.test.ts —— ChunkIndex 脱离 World 的直接单测（2026-10-08 chunk 维度）。
 *
 * 为什么要有这份"重复"的测试：
 *   - `chunk-index.test.ts` 走的是 World 门面（`w.buildingsInChunks` …），
 *     它验证的是**契约没破**（调用方不受影响）；
 *   - 但那份测试证明不了"索引已经从 World 拆出来了"——如果有一天有人把
 *     ChunkIndex 又塞回 World 里，chunk-index.test.ts 依然全绿。
 *   - 这份测试用**假的三张真源表**（普通 Map，不含任何 World/tuning/rng 依赖）
 *     直接驱动 ChunkIndex，因此只有当 ChunkIndex 真的只依赖 `ChunkSources`
 *     这个形状时才编译通过。它是"依赖方向"的编译期证据，不是行为证据。
 *
 * 顺带把两个只在 World 路径下才碰得到的坑测出来：
 *   1. **整包替换真源表**（对应 World.importState 的 `this.featureLeft = new Map(...)`）：
 *      索引必须读到**新表**。这正是 ChunkIndex 取"访问器函数"而不是构造期捕获
 *      Map 引用的原因——捕获引用会让读档后的索引指向旧世界。
 *   2. **惰性建立的增量守卫**：索引未建立前的 addBuilding/takeOne 是 no-op
 *      （`ensure()` 首次访问会按真源表全量派生，覆盖掉之前的增量），
 *      建立后才走增量维护。这条守卫收口在 ChunkIndex 内部，
 *      World 那 7 处 `if (chunkIndexReady)` 因此可以消失。
 */
import { describe, expect, it } from 'vitest';
import { ChunkIndex, type ChunkSources } from '../sim/chunk-index';
import type { BuildingState } from '../sim/types';
import { tileChunkKey } from '../shared/chunks';

/** 造一个假建筑：ChunkIndex 只读 id 与 pos，其余字段不参与。 */
function bld(id: string, x: number, y: number): BuildingState {
  return { id, defId: 'hut', pos: { x, y }, hp: 100 } as BuildingState;
}

/**
 * 三张真源表装进一个小盒子。
 * `tables` 持有真正的 Map（测试直接读写）；`sources` 是 ChunkIndex 拿到的
 * 访问器视图。`replaceAll` 整体替换引用，模拟 World.importState 的
 * `this.featureLeft = new Map(...)`。
 */
function makeSources(): {
  sources: ChunkSources;
  tables: {
    buildings: Map<string, BuildingState>;
    featureLeft: Map<string, number>;
    harvestCd: Map<string, number>;
  };
  replaceAll(next: {
    buildings?: Map<string, BuildingState>;
    featureLeft?: Map<string, number>;
    harvestCd?: Map<string, number>;
  }): void;
} {
  const tables = {
    buildings: new Map<string, BuildingState>(),
    featureLeft: new Map<string, number>(),
    harvestCd: new Map<string, number>(),
  };
  return {
    tables,
    sources: {
      buildings: () => tables.buildings,
      featureLeft: () => tables.featureLeft,
      harvestCd: () => tables.harvestCd,
    },
    replaceAll(next) {
      if (next.buildings) tables.buildings = next.buildings;
      if (next.featureLeft) tables.featureLeft = next.featureLeft;
      if (next.harvestCd) tables.harvestCd = next.harvestCd;
    },
  };
}

/** 触发惰性建立；之后的增量调用才真正生效。 */
function warm(idx: ChunkIndex): void {
  idx.activeChunkKeys();
}

describe('ChunkIndex：派生（假表，脱离 World）', () => {
  it('首次访问时从真源表全量派生（建筑/余量/冷却三类各自成桶）', () => {
    const s = makeSources();
    s.tables.buildings.set('b1', bld('b1', 5, 6));
    s.tables.buildings.set('b2', bld('b2', 70, 6)); // 隔壁区块（CHUNK_SIZE = 64）
    s.tables.featureLeft.set('3,4', 2);
    s.tables.harvestCd.set('80,5', 120);

    const idx = new ChunkIndex(s.sources);
    const k1 = tileChunkKey(5, 6).key;
    const k2 = tileChunkKey(70, 6).key;
    expect(k1).not.toBe(k2);

    expect(idx.buildingsInChunk(k1).map((b) => b.id)).toEqual(['b1']);
    expect(idx.buildingsInChunk(k2).map((b) => b.id)).toEqual(['b2']);
    expect(idx.featureLeftInChunks([tileChunkKey(3, 4).key])).toEqual([['3,4', 2]]);
    expect(idx.harvestCdInChunks([tileChunkKey(80, 5).key])).toEqual([['80,5', 120]]);
    expect(new Set(idx.activeChunkKeys())).toEqual(
      new Set([
        tileChunkKey(5, 6).key,
        tileChunkKey(70, 6).key,
        tileChunkKey(3, 4).key,
        tileChunkKey(80, 5).key,
      ]),
    );
  });

  it('buildingsInChunks 跨边界去重（同一栋只出现一次，避免客户端重复投影）', () => {
    const s = makeSources();
    s.tables.buildings.set('b1', bld('b1', 5, 6));
    const idx = new ChunkIndex(s.sources);
    const k = tileChunkKey(5, 6).key;
    // 同一区块键重复传入：去重后仍只有一栋
    expect(idx.buildingsInChunks([k, k, k]).map((b) => b.id)).toEqual(['b1']);
    // 空区块键不报错、不产生空条目
    expect(idx.buildingsInChunks([k, tileChunkKey(999, 999).key])).toHaveLength(1);
  });

  it('导出确定性：区块键升序 + id 排序（存档对拍 / git diff 可用的前提）', () => {
    const s = makeSources();
    s.tables.buildings.set('b3', bld('b3', 100, 5));
    s.tables.buildings.set('b1', bld('b1', 5, 6));
    s.tables.buildings.set('b2', bld('b2', 5, 7));
    const a = new ChunkIndex(s.sources).exportChunks();
    const b = new ChunkIndex(s.sources).exportChunks();
    expect(a).toEqual(b);
    const keys = a.map((c) => c.key);
    expect(keys).toEqual([...keys].sort((x, y) => x - y));
    for (const c of a) expect(c.buildingIds).toEqual([...c.buildingIds].sort());
    expect(a.find((c) => c.key === tileChunkKey(5, 6).key)?.buildingIds).toEqual(['b1', 'b2']);
  });

  it('唯一不变量：读取面不产生幽灵实体（桶里 id 必须回查真源表）', () => {
    const s = makeSources();
    s.tables.buildings.set('b1', bld('b1', 5, 6));
    const idx = new ChunkIndex(s.sources);
    const k = tileChunkKey(5, 6).key;
    idx.buildingAdded('b1');
    // 直接删真源表里的建筑（绕过增量 API）：索引桶会残留 id。
    // 正常的 removeBuilding 一定走 buildingRemoved，所以这只是防御性检查——
    // 但"残留 id 不能被当成有效实体返回"值得单独钉住。
    s.tables.buildings.delete('b1');
    expect(idx.buildingsInChunk(k)).toEqual([]);
    expect(idx.buildingsInChunks([k])).toEqual([]);
    expect(idx.harvestCdInChunks([k])).toEqual([]);
  });
});

describe('ChunkIndex：增量维护（索引建立后）', () => {
  it('buildingAdded / buildingRemoved 各自进桶与出桶', () => {
    const s = makeSources();
    const idx = new ChunkIndex(s.sources);
    warm(idx);

    const k = tileChunkKey(5, 6).key;
    s.tables.buildings.set('b1', bld('b1', 5, 6));
    idx.buildingAdded('b1');
    expect(idx.buildingsInChunk(k).map((b) => b.id)).toEqual(['b1']);

    s.tables.buildings.delete('b1');
    idx.buildingRemoved('b1');
    expect(idx.buildingsInChunk(k)).toEqual([]);
    expect(idx.activeChunkKeys()).toEqual([]); // 空桶不留壳
  });

  it('featureTaken / featureDepleted / featureRegrown 两桶成对维护', () => {
    const s = makeSources();
    const idx = new ChunkIndex(s.sources);
    warm(idx);

    const k = '9,10';
    const ck = tileChunkKey(9, 10).key;

    s.tables.featureLeft.set(k, 3);
    idx.featureTaken(k);
    expect(idx.featureLeftInChunks([ck])).toEqual([[k, 3]]);

    // 采空：余量出桶 + 冷却入桶，必须成对
    s.tables.featureLeft.delete(k);
    s.tables.harvestCd.set(k, 900);
    idx.featureDepleted(k);
    expect(idx.featureLeftInChunks([ck])).toEqual([]);
    expect(idx.harvestCdInChunks([ck])).toEqual([[k, 900]]);

    s.tables.harvestCd.delete(k);
    idx.featureRegrown(k);
    expect(idx.harvestCdInChunks([ck])).toEqual([]);
    expect(idx.activeChunkKeys()).not.toContain(ck);
  });
});

describe('ChunkIndex：惰性建立前的增量是 no-op（守卫已收口进索引内部）', () => {
  it('未建立时 buildingAdded/featureTaken 不报错，首次访问按真源表全量派生', () => {
    const s = makeSources();
    const idx = new ChunkIndex(s.sources);

    // 索引尚未建立：这些调用是 no-op（此前在 World 里是 7 处 if (chunkIndexReady) 守卫）
    s.tables.buildings.set('b1', bld('b1', 5, 6));
    idx.buildingAdded('b1');
    s.tables.featureLeft.set('3,4', 2);
    idx.featureTaken('3,4');

    expect(idx.buildingsInChunk(tileChunkKey(5, 6).key).map((b) => b.id)).toEqual(['b1']);
    expect(idx.featureLeftInChunks([tileChunkKey(3, 4).key])).toEqual([['3,4', 2]]);
  });

  it('invalidate 后重建：残留桶不会泄漏到新世界（读档场景）', () => {
    const s = makeSources();
    s.tables.buildings.set('old', bld('old', 5, 6));
    s.tables.harvestCd.set('5,6', 500);
    const idx = new ChunkIndex(s.sources);
    warm(idx);

    // 整包替换三张真源表 = World.importState 的核心动作
    s.replaceAll({
      buildings: new Map([['new', bld('new', 500, 500)]]), // 远得多的另一区块
      featureLeft: new Map(),
      harvestCd: new Map(),
    });
    idx.invalidate(); // 对应 World.importState 末尾

    expect(idx.buildingsInChunk(tileChunkKey(5, 6).key)).toEqual([]); // 旧世界的桶不残留
    expect(idx.buildingsInChunk(tileChunkKey(500, 500).key).map((b) => b.id)).toEqual(['new']);
    expect(idx.exportChunks()).toEqual([{ key: tileChunkKey(500, 500).key, buildingIds: ['new'] }]);
  });

  it('invalidate 后立刻读增量不会崩溃（no-op 路径）', () => {
    const s = makeSources();
    const idx = new ChunkIndex(s.sources);
    warm(idx);
    idx.invalidate();
    // 索引已清空且未重建：增量调用必须安全 no-op，不该抛错
    expect(() => idx.buildingAdded('ghost')).not.toThrow();
    expect(() => idx.featureTaken('1,1')).not.toThrow();
    expect(idx.activeChunkKeys()).toEqual([]);
  });
});
