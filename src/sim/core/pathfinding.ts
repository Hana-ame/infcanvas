// A* 寻路 —— 图块网格，P0 简单实现（无优化，后续可加 JPS/分块）
// 数据驱动：策略参数（迭代上限/暗区代价/启发式）进表（tuning.path），算法本体保留代码
import type { World } from './world';
import type { HeuristicId } from '../defs/tuning';

// 启发式策略表（寻路策略数据化：换启发式 = 改表，不碰算法）
const HEURISTICS: Record<HeuristicId, (dx: number, dy: number) => number> = {
  chebyshev: (dx, dy) => Math.max(dx, dy), // 对角移动可接受（默认）
  manhattan: (dx, dy) => dx + dy,           // 四方向网格
  euclidean: (dx, dy) => Math.hypot(dx, dy), // 直线距离
};

export interface PathConfig {
  maxIter?: number;    // 迭代上限（防爆）
  darkCost?: number;   // 未照亮格代价倍率
  heuristic?: HeuristicId;
}

interface Node {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: Node | null;
}

export function findPath(world: World, startX: number, startY: number, endX: number, endY: number, cfg?: PathConfig): { x: number; y: number }[] {
  const maxIter = cfg?.maxIter ?? 20000;
  const darkCost = cfg?.darkCost ?? 3;
  const h = HEURISTICS[cfg?.heuristic ?? 'chebyshev'];
  if (!world.inBounds(endX, endY)) return [];
  // 终点不可走（如站在建筑上），找最近可走格
  const target = world.isPassable(endX, endY) ? { x: endX, y: endY } : nearestPassable(world, endX, endY);
  if (!target) return [];
  const open: Node[] = [];
  const closed = new Set<string>();
  const start: Node = { x: startX, y: startY, g: 0, h: h(Math.abs(startX - target.x), Math.abs(startY - target.y)), f: 0, parent: null };
  start.f = start.g + start.h;
  open.push(start);

  const key = (x: number, y: number) => `${x},${y}`;
  const cost = new Map<string, number>();
  cost.set(key(startX, startY), 0);

  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  let iterations = 0;

  while (open.length > 0 && iterations++ < maxIter) {
    // 取 f 最小
    let minIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[minIdx].f) minIdx = i;
    }
    const current = open.splice(minIdx, 1)[0];

    if (current.x === target.x && current.y === target.y) {
      return reconstruct(current);
    }

    closed.add(key(current.x, current.y));

    for (const [dx, dy] of dirs) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (!world.isPassable(nx, ny)) continue;
      if (closed.has(key(nx, ny))) continue;

      const diag = dx !== 0 && dy !== 0;
      const moveCost = diag ? 1.414 : 1;
      const tileCost = world.getTileDef(nx, ny).moveCost ?? 1;
      // 黑暗区高代价权重：尽量走篝火照亮的路
      const lightCost = world.isLit(nx, ny) ? 1 : darkCost;
      const g = current.g + moveCost * tileCost * lightCost;

      const existing = cost.get(key(nx, ny));
      if (existing !== undefined && existing <= g) continue;

      cost.set(key(nx, ny), g);
      const hh = h(Math.abs(nx - target.x), Math.abs(ny - target.y));
      const n: Node = {
        x: nx, y: ny,
        g,
        h: hh,
        f: g + hh,
        parent: current,
      };
      open.push(n);
    }
  }
  return [];
}

function reconstruct(node: Node): { x: number; y: number }[] {
  const path: { x: number; y: number }[] = [];
  let cur: Node | null = node;
  while (cur) {
    path.unshift({ x: cur.x, y: cur.y });
    cur = cur.parent;
  }
  return path;
}

function nearestPassable(world: World, x: number, y: number): { x: number; y: number } | null {
  for (let r = 1; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (world.isPassable(nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  return null;
}
