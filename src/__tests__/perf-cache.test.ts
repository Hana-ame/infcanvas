/**
 * perf-cache.test.ts —— 性能线缓存的**正确性**对拍（2026-10-06 新增）。
 *
 * 为什么这些用例必须存在：性能线引入了 4 张记忆化表 + 1 张 tag 倒排索引
 * （world.ts）与 1 份锚点表缓存（sim.ts）。记忆化的天敌不是"慢"，是
 * **陈旧**——缓存没跟着失效点更新，表现是"看得见的建筑消失/采过的丛又满血/
 * 新篝火没人去"，而且这类 bug 不会抛异常，只会让游戏悄悄变蠢。
 *
 * 本文件的核心手法（对拍，不是重跑）：
 *   建**两个** World（同 seed、同 tuning），一个跑原始推导路径，另一个靠
 *   缓存路径反复查询，然后断言两者逐格一致。
 * 具体做法：先用"不触发缓存写入"的顺序查一轮当基准，再以打乱/重复顺序
 *   大量查询后逐格复比——若缓存写错了键或没失效，复比必然出现分歧。
 *
 * 覆盖：
 *   ① tileCache / treeAnchorCache / featureKindCache 三表：乱序重复查询一致
 *   ② tag 倒排：增建筑后立刻可见、删建筑后立刻消失（幽灵建筑 = 索引漏摘）
 *   ③ importState 读档整表替换后索引重建（增量维护漏"清空"这一路 → 幽灵）
 *   ④ tagVersion 递增 → Sim 侧火堆锚点表会重建
 *   ⑤ 记忆化不改变确定性：同 seed 两世界逐格一致（与时间/调用次序无关）
 */
import { describe, expect, it } from 'vitest';
import { World } from '../sim/world';
import { DEFAULT_TUNING } from '../sim/tuning';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';

function mkWorld(): World {
  const w = new World(structuredClone(DEFAULT_TUNING), 42, { x: 0, y: 0 });
  w.tuning.buildings['campfire'] = { name: '篝火', cost: {}, hp: 80, tags: ['fire'], passable: true };
  w.tuning.buildings['hut'] = { name: '棚屋', cost: {}, hp: 200, tags: ['shelter'], passable: false, w: 2, h: 2 };
  w.tuning.buildings['store'] = { name: '仓库', cost: {}, hp: 150, tags: ['storage'], passable: false, w: 2, h: 2 };
  return w;
}

/** 采一块格子附近的所有特征/地形/通行状态，做成可比对的快照数组 */
function sampleRegion(w: World, cx: number, cy: number, r: number): string[] {
  const out: string[] = [];
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const f = w.featureAt(x, y);
      out.push(
        [
          x,
          y,
          w.tileAt(x, y),
          w.zAt(x, y),
          w.canStand(x, y) ? 1 : 0,
          w.treeBlockAt(x, y) ? 1 : 0,
          f ? `${f.kind}:${f.amount}` : '-',
        ].join(','),
      );
    }
  }
  return out;
}

describe('性能线 · 记忆化缓存正确性', () => {
  it('① tile/treeAnchor/featureKind 三表：乱序重复查询与单次查询逐格一致', () => {
    const a = mkWorld(); // 只查一遍 = 未受缓存写入影响
    const b = mkWorld(); // 先乱序大量查询（写入缓存）再查
    const straight = sampleRegion(a, 0, 0, 22);
    // 乱序预热：反向 + 跳步 + 重复，制造与直线扫描完全不同的访问次序
    for (let i = 0; i < 4000; i++) {
      const x = ((i * 7919) % 45) - 22;
      const y = ((i * 104729) % 45) - 22;
      b.featureAt(x, y);
      b.canStand(x, y);
      b.treeBlockAt(x, y);
    }
    expect(sampleRegion(b, 0, 0, 22)).toEqual(straight);
  });

  it('⑤ 记忆化不破坏确定性：同 seed 两世界逐格一致（与调用次序无关）', () => {
    const w1 = mkWorld();
    const w2 = mkWorld();
    w1.now = 999;
    w2.now = 999;
    // w2 先被另一个完全不同的时间点与访问顺序"污染"过
    for (let i = 0; i < 500; i++) w2.featureAt(1000 - i, 500 + i);
    expect(sampleRegion(w2, 0, 0, 18)).toEqual(sampleRegion(w1, 0, 0, 18));
  });

  it('② tag 倒排：新增建筑立即可见、移除后立即消失（不留幽灵）', () => {
    const w = mkWorld();
    // 空表时查不到
    expect(w.nearestBuildingByTag('fire', 0, 0)).toBeUndefined();
    const spot = findFree(w, 0, 0);
    const b = w.addBuilding('campfire', spot.x, spot.y)!;
    expect(b).toBeTruthy();
    // 立即可见（不许"下一 tick 才看得见"）
    expect(w.nearestBuildingByTag('fire', spot.x, spot.y)?.id).toBe(b.id);
    expect(w.nearestBuildingByTag('fire', spot.x + 1, spot.y)?.id).toBe(b.id);
    // 距离上限仍然生效
    expect(w.nearestBuildingByTag('fire', spot.x + 50, spot.y, 1)).toBeUndefined();
    // 移除后立刻消失（幽灵建筑 = 熄灭火堆后鼠仍奔向旧坐标 = 静默玩法回归）
    w.removeBuilding(b.id);
    expect(w.nearestBuildingByTag('fire', spot.x, spot.y)).toBeUndefined();
    // 换 tag 查也查不到（篝火不该出现在 shelter 桶）
    expect(w.nearestBuildingByTag('shelter', spot.x, spot.y)).toBeUndefined();
  });

  it('②b 倒排索引与全表扫描结果一致（多座同 tag 时最近者相同）', () => {
    const w = mkWorld();
    const s1 = findFree(w, -30, -30);
    const s2 = findFree(w, 20, 20);
    w.addBuilding('campfire', s1.x, s1.y);
    w.addBuilding('campfire', s2.x, s2.y);
    w.addBuilding('hut', s1.x + 6, s1.y);
    // 参考实现：朴素全表扫描（倒排的语义基准）
    const naive = (tag: string, x: number, y: number, maxR = Infinity): string | null => {
      let best: string | null = null;
      let bestD = maxR;
      for (const b of w.buildings.values()) {
        if (!w.tuning.buildings[b.defId].tags.includes(tag)) continue;
        const d = Math.hypot(b.pos.x - x, b.pos.y - y);
        if (d <= bestD) {
          best = b.id;
          bestD = d;
        }
      }
      return best;
    };
    for (const tag of ['fire', 'shelter', 'storage']) {
      for (const [px, py] of [
        [0, 0],
        [s1.x, s1.y],
        [s2.x, s2.y],
        [s1.x + 1, s2.y - 1],
        [-25, 25],
      ] as [number, number][]) {
        expect(w.nearestBuildingByTag(tag, px, py)?.id ?? null).toBe(naive(tag, px, py));
      }
    }
  });

  it('③ importState 读档整表替换后索引重建（增量维护漏"清空"→幽灵建筑）', () => {
    const w = mkWorld();
    const s1 = findFree(w, -20, -20);
    const s2 = findFree(w, 20, 20);
    const b1 = w.addBuilding('campfire', s1.x, s1.y)!;
    const b2 = w.addBuilding('campfire', s2.x, s2.y)!;
    const state = w.exportState();
    // 读档到一个**没有篝火**的空档：旧桶必须整个清掉，
    // 否则幽灵篝火会留在索引里（鼠跑向一个存档里已不存在的坐标）
    const empty = mkWorld();
    empty.importState({ ...state, buildings: [], nextBuildingId: state.nextBuildingId });
    expect(empty.nearestBuildingByTag('fire', s1.x, s1.y)).toBeUndefined();
    expect(empty.nearestBuildingByTag('fire', s2.x, s2.y)).toBeUndefined();
    // 换成一个完全不同的存档：只能看到新档里的那两座，看不到 world 自己的旧建筑
    // ⚠ 哨兵坐标必须离 s1/s2 **足够远**（> nearestBuildingByTag 的默认搜索半径），
    //   否则"最近的那座恰好是存档里的 b1/b2"，断言会假失败。
    //   （本轮首版把哨兵写死 (40,40)，而 findFree 在 (20,20) 附近找到的 s2 可能
    //   就在半径内 → 断言的是"存进去的那座"而不是"旧建筑已消失"，语义错了。）
    const SENTINEL = 9999;
    const other = mkWorld();
    const old = other.addBuilding('campfire', SENTINEL, SENTINEL)!;
    other.importState(state);
    expect(other.nearestBuildingByTag('fire', s1.x, s1.y)?.id).toBe(b1.id);
    expect(other.nearestBuildingByTag('fire', s2.x, s2.y)?.id).toBe(b2.id);
    // 旧建筑已不在表里 → 倒排里也不该能被查到（幽灵建筑）
    expect(other.buildings.has(old.id)).toBe(false);
    expect(other.nearestBuildingByTag('fire', SENTINEL, SENTINEL, 1)).toBeUndefined();
  });

  it('③b importState 后索引里的对象就是 buildings 表里的那一个（身份一致）', () => {
    // 这条锁的是本轮实测抓到的真 bug：importState 里曾写成
    //   `buildings.set(b.id, structuredClone(b)); pushIndex(b)`
    // 索引指向入参、buildings 表指向 clone —— 两者不是同一对象。
    // 症状不会立刻报错，只在"按对象身份/改坐标后重查"这类地方出偏差，
    // 属于"静默到很难查"的那一类，所以必须有专门的回归锁住。
    const w = mkWorld();
    const spot = findFree(w, 0, 0);
    w.addBuilding('campfire', spot.x, spot.y);
    const saved = w.exportState();
    const restored = mkWorld();
    restored.importState(saved);
    const hit = restored.nearestBuildingByTag('fire', spot.x, spot.y);
    expect(hit).toBeTruthy();
    // 同一座建筑必须能从表和索引两侧拿到**同一个对象引用**
    expect(hit).toBe(restored.buildings.get(hit!.id));
  });

  it('④ tagVersion 随建筑增删递增（Sim 侧锚点表靠它判过期）', () => {
    const w = mkWorld();
    const v0 = w.tagVersionNow();
    const spot = findFree(w, 0, 0);
    const b = w.addBuilding('campfire', spot.x, spot.y)!;
    const v1 = w.tagVersionNow();
    expect(v1).toBeGreaterThan(v0);
    w.removeBuilding(b.id);
    expect(w.tagVersionNow()).toBeGreaterThan(v1);
  });

  it('⑥ 缓存不改变寻路结果：同 seed 同目标的 A* 路径在大量查询前后一致', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const w = sim.world;
    const from = { x: 0, y: 0 };
    const to = { x: 14, y: 9 };
    const pathOf = (): string => {
      // 借 Sim 的移动服务：setPath 写入 p.path，直接比路径
      const p = [...sim.pawns()][0];
      const before = p.path.length;
      sim.setPath(p, to.x, to.y);
      const s = JSON.stringify(p.path);
      p.path = [];
      void before;
      return s;
    };
    const first = pathOf();
    // 大量无关查询把缓存填满/填溢出（触发整表清空路径）
    for (let i = 0; i < 20000; i++) w.canStand((i % 401) - 200, ((i * 31) % 401) - 200);
    expect(pathOf()).toBe(first);
  });
});

/** 在以 (cx,cy) 为心的区域里找一块可放 1×1 的空地（错开让开安全区与树） */
function findFree(w: World, cx: number, cy: number): { x: number; y: number } {
  // ⚠ 注意篝火是 passable 的，所以"能放篝火"≠"w.passable 为真"就能区分已占用；
  //   这里只求"一块可放 1×1 的空地"，是否已被别的建筑占用由调用方保证。
  //   但仍要避开**出生安全区**（安全区内 addBuilding 会被拒）。
  const clear = w.tuning.world.spawnClearRadius;
  for (let r = clear + 2; r < 80; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (w.passable(x, y)) return { x, y };
      }
    }
  }
  throw new Error('测试区找不到可放建筑的格');
}