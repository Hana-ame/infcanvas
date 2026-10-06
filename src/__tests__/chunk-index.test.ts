/**
 * chunk-index.test.ts —— World 的区块索引正确性与增量维护（line/net 2026-10-06）。
 *
 * 核心风险不是"索引算错"，而是**真源表改了而索引没跟上**：
 * 那会让区块快照漏发某个实体（客户端那边表现为"建筑凭空消失"）或多发
 * （幽灵建筑）。两种都是沉默故障，所以这里对**每条写入路径**单独断言，
 * 而不是只在跑完一局后看总数（总数对得上不代表归属对）。
 */
import { describe, expect, it } from 'vitest';
import { World } from '../sim/world';
import { DEFAULT_TUNING } from '../sim/tuning';
import { chunkKey, tileChunkKey } from '../shared/chunks';

/** 造一个干净 World：不出生、不走玩法，只测索引。
 *  tuning 用出厂值（地形/建筑定义齐全），spawn 放原点。 */
function bareWorld(): World {
  return new World(DEFAULT_TUNING, 4242, { x: 0, y: 0 });
}

/** 在世界某坐标找一块可落建筑的空地（addBuilding 要求全 footprint 可通行） */
function findSpot(w: World, nearX: number, nearY: number): { x: number; y: number } {
  for (let r = 0; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = nearX + dx;
        const y = nearY + dy;
        if (w.addBuilding('campfire', x, y)) return { x, y };
      }
    }
  }
  throw new Error(`(${nearX},${nearY}) 附近找不到可落建筑的空地`);
}

describe('World 区块索引', () => {
  it('空世界：所有区块查询返回空（不是 null 也不是抛错）', () => {
    const w = bareWorld();
    expect(w.buildingsInChunk(chunkKey(0, 0))).toEqual([]);
    expect(w.buildingsInChunks([chunkKey(0, 0), chunkKey(-1, -1)])).toEqual([]);
    expect(w.activeChunkKeys()).toEqual([]);
  });

  it('建筑落入正确区块（建在 (70,10) → 块 1,0）', () => {
    const w = bareWorld();
    // 出生安全区内禁止建筑，绕开：spawnClearRadius 内 addBuilding 会被地形拒
    const spot = findSpot(w, 200, 10);
    const expectKey = tileChunkKey(spot.x, spot.y).key;
    expect(w.buildingsInChunk(expectKey).length).toBeGreaterThanOrEqual(1);
    // 不在相邻块里
    const neighbour = tileChunkKey(spot.x + CHUNK_OFFSET, spot.y).key;
    if (neighbour !== expectKey) expect(w.buildingsInChunk(neighbour)).toEqual([]);
    expect(w.activeChunkKeys()).toContain(expectKey);
  });

  it('删除后出桶：移除的建筑不再出现在任何区块快照里', () => {
    const w = bareWorld();
    const spot = findSpot(w, 200, 10);
    const key = tileChunkKey(spot.x, spot.y).key;
    const before = w.buildingsInChunk(key);
    expect(before.length).toBe(1);
    const b = before[0]!;
    w.removeBuilding(b.id);
    expect(w.buildingsInChunk(key)).toEqual([]);
    expect(w.activeChunkKeys()).not.toContain(key);
  });

  it('负坐标区块一样正确（玩家往西南扩张是常态）', () => {
    const w = bareWorld();
    const spot = findSpot(w, -300, -260);
    const key = tileChunkKey(spot.x, spot.y).key;
    const { cx, cy } = { cx: Math.floor(spot.x / 64), cy: Math.floor(spot.y / 64) };
    expect(cx).toBeLessThan(0);
    expect(cy).toBeLessThan(0);
    expect(w.buildingsInChunk(key).length).toBeGreaterThanOrEqual(1);
    // 解码必须与查询用的 key 一致（走唯一解码入口 chunkKeyToXY）
    expect(chunkKey(cx, cy)).toBe(key);
  });

  it('buildingsInChunks 多块去重：同一栋建筑不因跨区块重复出现', () => {
    const w = bareWorld();
    const spot = findSpot(w, 200, 10);
    const key = tileChunkKey(spot.x, spot.y).key;
    // 传同一个块 5 次，结果必须与传 1 次相同（否则客户端会收到重复实体）
    const once = w.buildingsInChunks([key]);
    const five = w.buildingsInChunks([key, key, key, key, key]);
    expect(five.length).toBe(once.length);
    expect(new Set(five.map((b) => b.id)).size).toBe(five.length);
  });

  it('跨块索引查询 = 各自单块查询的并集（无遗漏、无重复）', () => {
    const w = bareWorld();
    const spots = [findSpot(w, 200, 10), findSpot(w, -200, 30), findSpot(w, 10, -200)];
    const keys = [...new Set(spots.map((s) => tileChunkKey(s.x, s.y).key))];
    const union = w.buildingsInChunks(keys);
    const expectIds = new Set(spots.map((s) => {
      // 反查：单块查询拿到 id
      const list = w.buildingsInChunk(tileChunkKey(s.x, s.y).key);
      return list.find((b) => b.pos.x === s.x && b.pos.y === s.y)!.id;
    }));
    expect(new Set(union.map((b) => b.id))).toEqual(expectIds);
  });
});

describe('World 特征增量按区块', () => {
  it('采过的特征进入 featureLeft 桶，且只在自己的区块里', () => {
    const w = bareWorld();
    const spot = findSpot(w, 300, 300); // 保证有建筑（索引被触发）
    void spot;
    // 找一棵树：featureAt 返回 kind==='tree' 的第一格
    let tree: { x: number; y: number } | null = null;
    outer: for (let y = 60; y < 600; y += 1) {
      for (let x = 60; x < 600; x += 1) {
        if (w.featureAt(x, y)?.kind === 'tree') {
          tree = { x, y };
          break outer;
        }
      }
    }
    expect(tree, 'seed 4242 下 600×600 内应能找到树').not.toBeNull();
    const t = tree!;
    const ck = tileChunkKey(t.x, t.y).key;
    const left = w.takeOne(t.x, t.y);
    expect(left).toBeGreaterThanOrEqual(0); // 采了一份，剩 ≥0（0 = 刚好采空）
    const rows = w.featureLeftInChunks([ck]);
    // 若这一下没采空，桶里应有该键；若采空则进冷却桶
    if (left > 0) {
      expect(rows.find((r) => r[0] === `${t.x},${t.y}`)?.[1]).toBe(left);
    } else {
      expect(w.harvestCdInChunks([ck]).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('不同区块互不串味：远端区块查不到本地采过的余量', () => {
    const w = bareWorld();
    findSpot(w, 300, 300); // 触发索引建立
    let tree: { x: number; y: number } | null = null;
    outer: for (let y = 60; y < 600; y += 1) {
      for (let x = 60; x < 600; x += 1) {
        if (w.featureAt(x, y)?.kind === 'tree') {
          tree = { x, y };
          break outer;
        }
      }
    }
    const t = tree!;
    w.takeOne(t.x, t.y);
    const local = tileChunkKey(t.x, t.y).key;
    const far = tileChunkKey(t.x + 5000, t.y + 5000).key;
    const farRows = w.featureLeftInChunks([far]);
    expect(farRows.find((r) => r[0] === `${t.x},${t.y}`)).toBeUndefined();
    void local;
  });
});

describe('World 存档区块导出（diff 面）', () => {
  it('空世界导出空数组（不是 null——null 会在 JSON 里变 null 破坏字段语义）', () => {
    const w = bareWorld();
    expect(w.exportChunks()).toEqual([]);
  });

  it('导出的区块归属与 buildings 一一对应，且不重复', () => {
    const w = bareWorld();
    findSpot(w, 200, 10);
    findSpot(w, -200, 30);
    const chunks = w.exportChunks();
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const ids = chunks.flatMap((c) => c.buildingIds);
    expect(new Set(ids).size).toBe(ids.length); // 无重复
    expect(new Set(ids)).toEqual(new Set([...w.buildings.keys()])); // 与真源表相等
    for (const c of chunks) {
      for (const id of c.buildingIds) {
        const b = w.buildings.get(id)!;
        expect(tileChunkKey(b.pos.x, b.pos.y).key).toBe(c.key); // 归属正确
      }
    }
  });

  it('导出确定性：同一世界导出两次字节序相同（Map 插入序不能泄漏进存档）', () => {
    const w = bareWorld();
    for (let i = 0; i < 4; i++) findSpot(w, 200 + i * 70, 10 + i * 40);
    expect(JSON.stringify(w.exportChunks())).toBe(JSON.stringify(w.exportChunks()));
  });
});

const CHUNK_OFFSET = 64; // 用于"邻块"断言（chunkKey 与 tile 偏移同名易混，显式标注）