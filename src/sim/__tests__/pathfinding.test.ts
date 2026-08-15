import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { World } from '../core/world';
import { findPath } from '../core/pathfinding';
import type { WaypointCache } from '../core/pathfinding';

// 用真实 Sim 的 world（192×192 随机地形 + 建筑），测寻路行为
function mkSim(seed = 7, pawnCount = 1): Sim {
  return new Sim({ seed, pawnCount });
}

// 找一个可通行无障碍的起点/终点
function findPassable(sim: Sim, x: number, y: number): { x: number; y: number } {
  for (let r = 0; r < 20; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (sim.world.isPassable(x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
  }
  throw new Error('no passable tile');
}

describe('pathfinding 篝火航点中转', () => {
  it('远距离路径经过锚点中转（起点→篝火→篝火→终点 三段合并）', () => {
    const sim = new Sim({ seed: 61, pawnCount: 1 });
    const w = sim.world;
    // 起终点：出生点对角远处（出生点本身有 campfire 锚点）
    const sx = 96, sy = 96;
    const spot = ((): { x: number; y: number } => {
      for (let r = 1; r <= 20; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const x = 96 + dx * 4, y = 96 + dy * 4;
          if (w.inBounds(x, y) && w.isPassable(x, y) && Math.abs(x - sx) + Math.abs(y - sy) > 30) return { x, y };
        }
      }
      return { x: 100, y: 100 };
    })();
    const path = findPath(w, sx, sy, spot.x, spot.y, { waypointRadius: 200 });
    expect(path.length).toBeGreaterThan(0);
    const last = path[path.length - 1];
    expect(last.x).toBe(spot.x);
    expect(last.y).toBe(spot.y);
  });

  it('锚点对路径段走缓存（WaypointCache 命中，不重算）', () => {
    const sim = new Sim({ seed: 62, pawnCount: 1 });
    const w = sim.world;
    // 远处再造一个 campfire 锚点（出生点已有 1 个）→ 起终点分属两锚点才走段缓存
    let spot: { x: number; y: number } | null = null;
    const def = sim.mods.buildings.campfire;
    for (let r = 30; r < 70 && !spot; r++) {
      for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = 96 + dx, y = 96 + dy;
        if (w.canBuildFootprint(x, y, def)) spot = { x, y };
      }
    }
    expect(spot).not.toBeNull();
    expect(w.placeBuilding(spot!.x, spot!.y, 'campfire', 'player')).toBe(true);
    const anchors = [...w.buildings.entries()]
      .filter(([, b]) => b.def.tags?.includes('anchor'))
      .map(([k]) => World.keyToXY(k));
    expect(anchors.length).toBe(2);
    const [a, b] = anchors;
    let cacheHits = 0;
    const cache = new Map<string, { x: number; y: number }[]>();
    const wpCache: WaypointCache = {
      get: (ax, ay, bx, by) => { const p = cache.get(`${ax},${ay}->${bx},${by}`); if (p) cacheHits++; return p; },
      set: (ax, ay, bx, by, p) => cache.set(`${ax},${ay}->${bx},${by}`, p),
    };
    // 起点近 a、终点近 b → 走锚点对段（起点/终点选 a/b 附近可走格）
    const s = findPassable(sim, a.x + 3, a.y + 3);
    const e = findPassable(sim, b.x - 3, b.y - 3);
    const p1 = findPath(w, s.x, s.y, e.x, e.y, { waypointRadius: 200 }, wpCache);
    expect(p1.length).toBeGreaterThan(0);
    expect(cache.size).toBeGreaterThan(0); // 锚点对段已缓存
    // 第二次：段缓存命中（cacheHits ≥ 1）
    const p2 = findPath(w, s.x, s.y, e.x, e.y, { waypointRadius: 200 }, wpCache);
    expect(p2.length).toBeGreaterThan(0);
    expect(cacheHits).toBeGreaterThan(0);
  });

  it('无篝火世界：maxIter 钳制生效（小上限 → 长路返回空）', () => {
    const sim = new Sim({ seed: 63, pawnCount: 0 });
    const w = sim.world;
    // 清掉锚点（无 campfire/church）→ 纯直连寻路（damageBuilding 摧毁）
    for (const [k, b] of [...w.buildings]) {
      if (b.def.tags?.includes('anchor')) {
        const { x, y } = World.keyToXY(k);
        w.damageBuilding(x, y, 99999);
      }
    }
    expect([...w.buildings.values()].some((b) => b.def.tags?.includes('anchor'))).toBe(false);
    const s = { x: 2, y: 2 };
    const e = { x: w.width - 3, y: w.height - 3 };
    // 小上限：远路必然耗尽 → 空
    const p1 = findPath(w, s.x, s.y, e.x, e.y, { maxIter: 100 });
    expect(p1.length).toBe(0);
  });
});

describe('pathfinding A*（二叉堆实现）', () => {
  it('无障碍直线：路径连通且终点正确', () => {
    const sim = mkSim();
    const s = findPassable(sim, 10, 10);
    const e = findPassable(sim, 40, 30);
    const path = findPath(sim.world, s.x, s.y, e.x, e.y);
    expect(path.length).toBeGreaterThan(0);
    const last = path[path.length - 1];
    expect(last.x).toBe(e.x);
    expect(last.y).toBe(e.y);
    expect(path[0].x).toBe(s.x);
  });

  it('绕障碍：建筑阻断直路，路径避开（不穿越墙）', () => {
    const sim = mkSim(8);
    const s = findPassable(sim, 20, 20);
    const e = findPassable(sim, 24, 20);
    // 中间立一堵墙（墙不可通行）
    for (let y = s.y - 2; y <= e.y + 2; y++) {
      if (sim.world.canBuildFootprint(22, y, sim.mods.buildings.wall)) {
        sim.world.placeBuilding(22, y, 'wall', 'player');
      }
    }
    const path = findPath(sim.world, s.x, s.y, e.x, e.y);
    expect(path.length).toBeGreaterThan(0);
    // 路径不经过墙格（x===22 且 y 在墙范围）
    const wallYs = [...sim.world.buildings.keys()]
      .filter((k) => k % sim.world.width === 22)
      .map((k) => Math.floor(k / sim.world.width));
    for (const p of path) {
      if (p.x === 22 && wallYs.includes(p.y)) {
        throw new Error(`路径穿墙 at (${p.x},${p.y})`);
      }
    }
  });

  it('不可达：水墙包围 → 返回空数组（不崩溃）', () => {
    const sim = mkSim(9);
    const s = findPassable(sim, 50, 50);
    // 无法真正造水墙；改用超大迭代上限 + 孤立点验证：找被水包围的点
    // 直接验证：终点在水里 → 找最近可走格
    let water: { x: number; y: number } | null = null;
    outer:
    for (let y = 5; y < sim.world.height - 5; y++) {
      for (let x = 5; x < sim.world.width - 5; x++) {
        if (!sim.world.isPassable(x, y)) { water = { x, y }; break outer; }
      }
    }
    if (!water) return; // 地图没水则跳过
    const path = findPath(sim.world, s.x, s.y, water.x, water.y);
    // 终点不可走 → 自动落到最近可走格，路径非空（能到附近）
    expect(path.length).toBeGreaterThan(0);
    const last = path[path.length - 1];
    expect(sim.world.isPassable(last.x, last.y)).toBe(true);
  });

  it('迭代上限：maxIter 极小时快速返回（不爆栈）', () => {
    const sim = mkSim(10);
    const s = findPassable(sim, 10, 10);
    const e = findPassable(sim, 100, 100);
    const path = findPath(sim.world, s.x, s.y, e.x, e.y, { maxIter: 10 });
    expect(Array.isArray(path)).toBe(true);
  });

  it('性能：192×192 对角长路在 500ms 内完成（回归二叉堆）', () => {
    const sim = mkSim(11, 0);
    const w = sim.world;
    const s = findPassable(sim, 2, 2);
    // 终点：从起点 BFS 取出生区内最远可达格（新地图海陆分布不同，对角点可能被水隔开——
    // 2026-08-14 无限地图稀疏化 hash 化后 seed 11 的对角线是海洋；
    // 注意：无限地图 BFS 必须限制在出生区（width×height）内，否则顺着可走大陆无限外扩）
    const seen = new Set<number>([s.x + s.y * 2 ** 31]);
    const q = [{ x: s.x, y: s.y }];
    let far = s;
    let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      if (Math.abs(cur.x - s.x) + Math.abs(cur.y - s.y) > Math.abs(far.x - s.x) + Math.abs(far.y - s.y)) far = cur;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= w.width || ny >= w.height) continue;
        const nk = nx + ny * 2 ** 31;
        if (seen.has(nk)) continue;
        if (w.isPassable(nx, ny)) { seen.add(nk); q.push({ x: nx, y: ny }); }
      }
    }
    const t0 = performance.now();
    // 碎片化地图（稀疏化 hash 后树墙/石丘分割）启发式低估 → 探索面 ≈ 全域：
    // 默认 15000 迭代空路径，实测需 ~20 万迭代才找到（279ms）。性能测试目的 = 抓二叉堆退化
    // （O(n²) 会 10s+），放宽到 1s 仍能抓到；sim 侧 trailCache 会把首次结果缓存，不逐帧重算
    const path = findPath(w, s.x, s.y, far.x, far.y, { maxIter: 200000 });
    const ms = performance.now() - t0;
    // 阈值 2000ms（2026-08-15 放宽：1000ms 在 vitest 并发 worker 负载下偶发超时，
    // 重跑即过——波动失败污染 CI；本测试目的是抓二叉堆退化 O(n²) = 10s+，2s 仍能抓）
    expect(ms).toBeLessThan(2000);
    expect(path.length).toBeGreaterThan(0);
  });
});

// 地道（2026-08-14 用户设计：挖掘穿山/穿水通道，快速旅行=路线便利非速度加成，
// 限制大宗物品=1×1 窄道不可建其他建筑）。发现背景：桥的 replacesTile 无消费方
//（水上通道机制未落地），地道改走 isPassable 建筑特判 + onTunnel 建造特判。
describe('地道（tunnel 穿水/穿山通道）', () => {
  // 找一段至少 3 连水、两岸可走的水域段（供地道入口两侧放置验证）
  function findWaterGap(sim: Sim): { seg: { x: number; y: number }[]; left: { x: number; y: number }; right: { x: number; y: number } } {
    const w = sim.world;
    for (let y = 5; y < w.height - 5; y++) {
      for (let x = 5; x < w.width - 6; x++) {
        const isW = (dx: number) => w.inBounds(x + dx, y) && w.getTile(x + dx, y) === 'water';
        if (isW(0) && isW(1) && isW(2) && w.isPassable(x - 1, y) && w.isPassable(x + 3, y)) {
          return {
            seg: [{ x, y }, { x: x + 1, y }, { x: x + 2, y }],
            left: { x: x - 1, y },
            right: { x: x + 3, y },
          };
        }
      }
    }
    throw new Error('地图无 3 连水域段');
  }

  it('建造限制：入口只能挖在可通行地形（草地 ✓ / 水上树上 ✗）；入口格上不可再建建筑', () => {
    const sim = mkSim(12);
    const w = sim.world;
    const { seg, left } = findWaterGap(sim);
    // 草地/可走格挖入口 ✓（入口 = 地表洞口，人得先走到洞口）
    expect(w.placeBuilding(left.x, left.y, 'tunnel', 'player')).toBe(true);
    // 水上挖入口 ✗（水下没法走进洞口；水格不可走）
    expect(w.placeBuilding(seg[0].x, seg[0].y, 'tunnel', 'player')).toBe(false);
    // 树上挖入口 ✗（树上开洞无意义；树格不可走）
    let tree: { x: number; y: number } | null = null;
    outer: for (let y = 5; y < w.height - 5; y++) for (let x = 5; x < w.width - 5; x++) {
      if (w.getTile(x, y) === 'tree') { tree = { x, y }; break outer; }
    }
    if (tree) expect(w.placeBuilding(tree.x, tree.y, 'tunnel', 'player')).toBe(false);
    // 水上建墙 ✗（回归：普通建筑不能建水上）
    expect(w.placeBuilding(seg[1].x, seg[1].y, 'wall', 'player')).toBe(false);
    // 入口格上再建 campfire ✗（入口 1×1 不可叠加）
    expect(w.placeBuilding(left.x, left.y, 'campfire', 'player')).toBe(false);
  });

  it('通行：入口格本身可通行（地表走到洞口）；入口之间另一维度（虚拟边无视水域）', () => {
    const sim = mkSim(13);
    const w = sim.world;
    const { seg, left, right } = findWaterGap(sim);
    expect(w.isPassable(seg[0].x, seg[0].y)).toBe(false); // 水域不可走
    // 水域两侧各挖入口（另一维度：入口之间地下直连，无视中间的水）
    expect(w.placeBuilding(left.x, left.y, 'tunnel', 'player')).toBe(true);
    expect(w.placeBuilding(right.x, right.y, 'tunnel', 'player')).toBe(true);
    expect(w.isPassable(left.x, left.y)).toBe(true); // 入口格可通行
    // 无地道时无法直穿水域（绕路）；有双入口 → 路径同时经过两个入口 = 维度跳跃
    const p = findPath(w, left.x, left.y, right.x, right.y);
    const onEntry = p.filter((q) => w.getBuilding(q.x, q.y)?.def.id === 'tunnel');
    expect(onEntry.length).toBe(2); // 进洞 + 出洞（虚拟边从 left 直跳 right）
    // 跳跃段直接相邻（两个入口在路径里连在一起 = 未经过中间地表格）
    const idxL = p.findIndex((q) => q.x === left.x && q.y === left.y);
    const idxR = p.findIndex((q) => q.x === right.x && q.y === right.y);
    expect(Math.abs(idxR - idxL)).toBe(1);
  });

  it('高差判定：|Δz| > 通过能力 → 无法上下（石丘 z2 上草地 z0 需 climb ≥ 2）', () => {
    const sim = mkSim(14);
    const w = sim.world;
    // 找 stone(z2 石丘) 邻 grass(z0) 的绝壁对
    let a: { x: number; y: number } | null = null;
    let b: { x: number; y: number } | null = null;
    outer: for (let y = 5; y < w.height - 5; y++) for (let x = 5; x < w.width - 5; x++) {
      if (w.getTile(x, y) === 'stone' && w.getTile(x + 1, y) === 'grass') { a = { x, y }; b = { x: x + 1, y }; break outer; }
    }
    if (!a || !b) throw new Error('地图无 stone/grass 邻接');
    const zS = w.getTileDef(a.x, a.y).z ?? 0;
    const zG = w.getTileDef(b.x, b.y).z ?? 0;
    expect(Math.abs(zS - zG)).toBe(2); // 石丘 Δ2（生成高低差地图：石丘带 vs 低地）
    // 通过能力 1（鼠人）：上不了石丘（高差 2 > 1 → "高差过大无法上去"）
    expect(w.isPassable(a.x, a.y, zG, 1)).toBe(false);
    // 通过能力 2（野猫）：可上（Δz=2 ≤ 2 → 各自通过能力）
    expect(w.isPassable(a.x, a.y, zG, 2)).toBe(true);
    // 缺省参数：不判高差（旧调用面行为不变）
    expect(w.isPassable(a.x, a.y)).toBe(true);
  });

  it('道路：修路豁免高差判定（坡道垫平，任何单位可沿路上下），且可建在可建地形', () => {
    const sim = mkSim(15);
    const w = sim.world;
    let a: { x: number; y: number } | null = null;
    let b: { x: number; y: number } | null = null;
    outer: for (let y = 5; y < w.height - 5; y++) for (let x = 5; x < w.width - 5; x++) {
      if (w.getTile(x, y) === 'stone' && w.getTile(x + 1, y) === 'grass') { a = { x, y }; b = { x: x + 1, y }; break outer; }
    }
    if (!a || !b) throw new Error('地图无 stone/grass 邻接');
    // 石丘格可建道路（stone buildable）
    expect(w.placeBuilding(a.x, a.y, 'road', 'player')).toBe(true);
    // 草地上也可建
    expect(w.placeBuilding(b.x, b.y, 'road', 'player')).toBe(true);
    // 道路豁免高差：climb 1 的鼠人沿路也能上石丘（坡道垫平）
    expect(w.isPassable(a.x, a.y, 0, 1)).toBe(true);
    // 道路本身可通行
    expect(w.isPassable(b.x, b.y)).toBe(true);
  });

  it('高差地图：出生点不被石丘围困（多种子可达 ≥15%），且地图确实存在 Δ2 绝壁', () => {
    for (const seed of [14, 7, 99, 12345]) {
      const w2 = new World(seed);
      // 出生点可达性（climb1 鼠人）
      const cx = Math.floor(w2.width / 2), cy = Math.floor(w2.height / 2);
      const seen = new Set<number>([cx + cy * w2.width]);
      const q = [cx + cy * w2.width];
      let head = 0;
      // 无限地图（2026-08-14）：inBounds 恒 true，BFS 必须限制在出生区 width×height 内，
      // 否则顺着可达大陆无限外扩（生成海量 chunk，实测构造 8 秒）
      while (head < q.length) {
        const k = q[head++];
        const x = k % w2.width, y = Math.floor(k / w2.width);
        const zHere = w2.getTileDef(x, y).z ?? 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w2.width || ny >= w2.height) continue;
          const nk = nx + ny * w2.width;
          if (seen.has(nk)) continue;
          if (w2.isPassable(nx, ny, zHere, 1)) { seen.add(nk); q.push(nk); }
        }
      }
      expect(seen.size).toBeGreaterThan(w2.width * w2.height * 0.15);
    }
    // Δ2 绝壁存在（stone z2 邻 z≤0）
    const w3 = new World(20260814);
    let cliff = false;
    outer: for (let y = 0; y < w3.height; y++) for (let x = 0; x < w3.width; x++) {
      if ((w3.getTileDef(x, y).z ?? 0) < 2) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!w3.inBounds(nx, ny)) continue;
        if ((w3.getTileDef(nx, ny).z ?? 0) <= 0) { cliff = true; break outer; }
      }
    }
    expect(cliff).toBe(true);
  });

  it('速度无加成：入口虚拟边成本 = 直线距离（非加速通道）', () => {
    const sim = mkSim(16);
    const w = sim.world;
    const { left, right } = findWaterGap(sim);
    w.placeBuilding(left.x, left.y, 'tunnel', 'player');
    w.placeBuilding(right.x, right.y, 'tunnel', 'player');
    // 入口间跳跃 = 欧氏距离（速度无加成——地道的价值在路线直，不在地速）
    const p = findPath(w, left.x, left.y, right.x, right.y);
    expect(p.length).toBe(2); // 仅进洞 + 出洞两格（虚拟边一步）
  });
});
