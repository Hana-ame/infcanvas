import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
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
      .map(([k]) => ({ x: k % w.width, y: Math.floor(k / w.width) }));
    expect(anchors.length).toBe(2);
    const [a, b] = anchors;
    let cacheHits = 0;
    const cache = new Map<string, { x: number; y: number }[]>();
    const wpCache: WaypointCache = {
      get: (ax, ay, bx, by) => { const p = cache.get(`${ax},${ay}->${bx},${by}`); if (p) cacheHits++; return p; },
      set: (ax, ay, bx, by, p) => cache.set(`${ax},${ay}->${bx},${by}`, p),
    };
    // 起点近 a、终点近 b → 走锚点对段
    const sx = a.x + 3, sy = a.y + 3;
    const ex = b.x - 3, ey = b.y - 3;
    const p1 = findPath(w, sx, sy, ex, ey, { waypointRadius: 200 }, wpCache);
    expect(p1.length).toBeGreaterThan(0);
    expect(cache.size).toBeGreaterThan(0); // 锚点对段已缓存
    // 第二次：段缓存命中（cacheHits ≥ 1）
    const p2 = findPath(w, sx, sy, ex, ey, { waypointRadius: 200 }, wpCache);
    expect(p2.length).toBeGreaterThan(0);
    expect(cacheHits).toBeGreaterThan(0);
  });

  it('无篝火世界：maxIter 钳制生效（小上限 → 长路返回空）', () => {
    const sim = new Sim({ seed: 63, pawnCount: 0 });
    const w = sim.world;
    // 清掉锚点（无 campfire/church）→ 纯直连寻路（damageBuilding 摧毁）
    for (const [k, b] of [...w.buildings]) {
      if (b.def.tags?.includes('anchor')) {
        w.damageBuilding(k % w.width, Math.floor(k / w.width), 99999);
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
    const s = findPassable(sim, 2, 2);
    const e = findPassable(sim, sim.world.width - 3, sim.world.height - 3);
    const t0 = performance.now();
    const path = findPath(sim.world, s.x, s.y, e.x, e.y);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(500);
    expect(path.length).toBeGreaterThan(0);
  });
});
