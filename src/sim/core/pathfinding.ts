// A* 寻路 —— 图块网格，P0 简单实现（无优化，后续可加 JPS/分块）
import type { World } from './world';

interface Node {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: Node | null;
}

export function findPath(world: World, startX: number, startY: number, endX: number, endY: number): { x: number; y: number }[] {
  if (!world.inBounds(endX, endY)) return [];
  // 终点不可走（如站在建筑上），找最近可走格
  const target = world.isPassable(endX, endY) ? { x: endX, y: endY } : nearestPassable(world, endX, endY);
  if (!target) return [];
  const open: Node[] = [];
  const closed = new Set<string>();
  const start: Node = { x: startX, y: startY, g: 0, h: heuristic(startX, startY, target.x, target.y), f: 0, parent: null };
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
  const MAX_ITER = 20000;

  while (open.length > 0 && iterations++ < MAX_ITER) {
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
      const lightCost = world.isLit(nx, ny) ? 1 : 3;
      const g = current.g + moveCost * tileCost * lightCost;

      const existing = cost.get(key(nx, ny));
      if (existing !== undefined && existing <= g) continue;

      cost.set(key(nx, ny), g);
      const n: Node = {
        x: nx, y: ny,
        g,
        h: heuristic(nx, ny, target.x, target.y),
        f: g + heuristic(nx, ny, target.x, target.y),
        parent: current,
      };
      open.push(n);
    }
  }
  return [];
}

function heuristic(x: number, y: number, ex: number, ey: number): number {
  const dx = Math.abs(x - ex);
  const dy = Math.abs(y - ey);
  return Math.max(dx, dy); // 对角移动可接受
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
