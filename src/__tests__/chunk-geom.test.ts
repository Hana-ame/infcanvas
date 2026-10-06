/**
 * chunk-geom.test.ts —— 分区块几何与 World 区块索引（line/net 2026-10-06）。
 *
 * 这些是**纯函数级**守护用例，跑得极快（毫秒级），是整个区块化的地基：
 * 键编解码一旦错位，线上的症状是"桥不修/篝火不迁"这种沉默的功能损坏
 * （归档实现在 2026-08-14 漏改 17 处内联解码后的真实后果）。
 * 所以这里对**负坐标 + 异号组合**做穷举，而不是只测几个好看的正数样例——
 * 旧实现的测试只覆盖 (-5,-7) 同号负坐标，异号 (-2^31 偏移) 被掩盖，就是这个坑的成因。
 */
import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  chunkBounds,
  chunkKey,
  chunkKeyToXY,
  chunkOffset,
  chunksForInterest,
  fromChunkCoords,
  parseTileKey,
  tileChunk,
  tileChunkKey,
  tileKey,
  toChunkCoords,
  TILES_PER_CHUNK,
} from '../shared/chunks';

describe('chunk 键编解码（唯一入口纪律）', () => {
  it('往返：覆盖负坐标与异号组合（旧实现 17 处漏改的那一类）', () => {
    const cases: [number, number][] = [
      [0, 0],
      [1, 1],
      [-1, -1],
      [-1, 1], // 异号：% 截断余数被偏移 2^16 的经典触发条件
      [1, -1],
      [-5, -7],
      [-32768, -32768],
      [32767, 32767],
      [-32768, 32767],
      [32767, -32768],
      [100, -200],
      [-200, 100],
    ];
    for (const [cx, cy] of cases) {
      const { cx: rx, cy: ry } = chunkKeyToXY(chunkKey(cx, cy));
      expect({ cx: rx, cy: ry }, `(${cx},${cy}) 往返失败`).toEqual({ cx, cy });
    }
  });

  it('穷举 4×4 邻域全象限（含 0 附近），确保没有符号相关的隐藏错位', () => {
    for (let cx = -3; cx <= 3; cx++) {
      for (let cy = -3; cy <= 3; cy++) {
        expect(chunkKeyToXY(chunkKey(cx, cy))).toEqual({ cx, cy });
      }
    }
  });

  it('解码不产生 -0（JSON 序列化看不出差异，但 ===/toEqual 会判不等——存档对拍踩坑）', () => {
    for (const [cx, cy] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [-1, 0],
      [0, -1],
    ] as [number, number][]) {
      const r = chunkKeyToXY(chunkKey(cx, cy));
      expect(Object.is(r.cx, -0)).toBe(false);
      expect(Object.is(r.cy, -0)).toBe(false);
    }
  });

  it('键唯一：不同区块坐标绝不撞键（撞键=两处地形互相覆盖，且症状极难查）', () => {
    const seen = new Map<number, string>();
    for (let cx = -40; cx <= 40; cx++) {
      for (let cy = -40; cy <= 40; cy++) {
        const k = chunkKey(cx, cy);
        const id = `${cx},${cy}`;
        expect(seen.has(k), `键冲突：${seen.get(k)} vs ${id}`).toBe(false);
        seen.set(k, id);
      }
    }
  });
});

describe('chunk 内偏移与 tile 定位', () => {
  it('CHUNK_SIZE 与 TILES_PER_CHUNK 自洽（64×64=4096）', () => {
    expect(CHUNK_SIZE).toBe(64);
    expect(TILES_PER_CHUNK).toBe(4096);
    expect(chunkOffset(CHUNK_SIZE - 1, CHUNK_SIZE - 1)).toBe(TILES_PER_CHUNK - 1);
  });

  it('tile→chunk 对负坐标正确取整（floor 而非 trunc——负数截断会让 -1 落进 -0 号块）', () => {
    // 负坐标下 Math.floor(-1/64) = -1（块 -1 的最后一格），而 (-1/64)|0 = 0（错）
    const r = tileChunk(-1, -1);
    expect(r.cx).toBe(-1);
    expect(r.cy).toBe(-1);
    expect(r.lx).toBe(63);
    expect(r.ly).toBe(63);
    expect(r.offset).toBe(4095);
  });

  it('tileChunk 与 tileChunkKey 给出同一个 key/offset（两个入口不许漂移）', () => {
    for (const [x, y] of [
      [0, 0],
      [63, 63],
      [64, 64],
      [-1, 64],
      [-65, -64],
      [1000, -1000],
    ] as [number, number][]) {
      const a = tileChunk(x, y);
      const b = tileChunkKey(x, y);
      expect(b.key).toBe(chunkKey(a.cx, a.cy));
      expect(b.offset).toBe(a.offset);
    }
  });

  it('chunkBounds 与 tileChunk 自洽（包围盒覆盖该块全部格）', () => {
    const { cx, cy } = tileChunk(-70, 33);
    const b = chunkBounds(cx, cy);
    expect(b.x0).toBeLessThanOrEqual(-70);
    expect(b.x1).toBeGreaterThanOrEqual(-70);
    expect(b.y0).toBeLessThanOrEqual(33);
    expect(b.y1).toBeGreaterThanOrEqual(33);
    expect(b.x1 - b.x0).toBe(CHUNK_SIZE - 1);
  });
});

describe('兴趣区 → 区块集合', () => {
  it('r=0 只要中心所在那一块（单块视野调试用）', () => {
    const keys = chunksForInterest({ x: 10, y: 10, r: 0 });
    expect(keys).toEqual([chunkKey(0, 0)]);
  });

  it('中心排序：最近的块永远在前（tick 分帧调度靠这个"眼前优先"藏住延迟）', () => {
    const keys = chunksForInterest({ x: 200, y: 200, r: 192 });
    expect(keys.length).toBeGreaterThan(1);
    const xy = keys.map((k) => chunkKeyToXY(k));
    const cxCenter = Math.floor(200 / CHUNK_SIZE);
    const cyCenter = Math.floor(200 / CHUNK_SIZE);
    const d0 = Math.hypot(xy[0]!.cx - cxCenter, xy[0]!.cy - cyCenter);
    for (let i = 1; i < xy.length; i++) {
      const d = Math.hypot(xy[i]!.cx - cxCenter, xy[i]!.cy - cyCenter);
      // 允许并列相等，但不允许"后面的更近"
      expect(d).toBeGreaterThanOrEqual(d0 - 1e-9);
    }
  });

  it('确定性：同样输入两次结果逐位相同（调度顺序不确定 = 不可复现的 tick）', () => {
    const a = chunksForInterest({ x: -333, y: 777, r: 150 });
    const b = chunksForInterest({ x: -333, y: 777, r: 150 });
    expect(a).toEqual(b);
  });

  it('覆盖视口内每一格所属的块（少一块 = 玩家看到空白区块）', () => {
    const interest = { x: 96, y: 96, r: 100 };
    const keys = new Set(chunksForInterest(interest));
    for (let y = interest.y - interest.r; y <= interest.y + interest.r; y += 17) {
      for (let x = interest.x - interest.r; x <= interest.x + interest.r; x += 17) {
        expect(keys.has(tileChunkKey(x, y).key), `(${x},${y}) 的块不在订阅集合里`).toBe(true);
      }
    }
  });

  it('负坐标视口同样成立（玩家往西南走是最常见路径）', () => {
    const interest = { x: -200, y: -120, r: 90 };
    const keys = new Set(chunksForInterest(interest));
    for (let y = interest.y - interest.r; y <= interest.y + interest.r; y += 13) {
      for (let x = interest.x - interest.r; x <= interest.x + interest.r; x += 13) {
        expect(keys.has(tileChunkKey(x, y).key)).toBe(true);
      }
    }
  });
});

describe('ChunkCoord 转换（进协议用）', () => {
  it('toChunkCoords / fromChunkCoords 往返', () => {
    const keys = [chunkKey(0, 0), chunkKey(-1, 5), chunkKey(7, -9), chunkKey(-33, -44)];
    expect(fromChunkCoords(toChunkCoords(keys))).toEqual(keys);
  });

  it('toChunkCoords 输出可 JSON 往返（协议里传的就是它）', () => {
    const coords = toChunkCoords([chunkKey(-5, -6)]);
    expect(JSON.parse(JSON.stringify(coords))).toEqual(coords);
  });
});

describe('"x,y" 瓦片键解析', () => {
  it('parseTileKey / tileKey 往返（含负坐标与 0）', () => {
    for (const [x, y] of [
      [0, 0],
      [3, 4],
      [-3, 4],
      [3, -4],
      [-3, -4],
      [-128, 512],
    ] as [number, number][]) {
      expect(parseTileKey(tileKey(x, y))).toEqual({ x, y });
    }
  });

  it('坏键不抛错也不产生 NaN（坏键会污染 Map 键并静默永不被查到）', () => {
    expect(parseTileKey('')).toEqual({ x: 0, y: 0 });
    expect(parseTileKey('junk')).toEqual({ x: 0, y: 0 });
    const bad = parseTileKey('a,1');
    expect(Number.isFinite(bad.x)).toBe(true);
  });
});