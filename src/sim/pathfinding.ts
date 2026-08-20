// 简单 A*（2026-08-21 从零重写）——四方向 + 二叉堆，够用且简洁
// 不做 HPA*/锚点中转/缓存——从零阶段保持最小正确

interface Node { x: number; y: number; g: number; f: number; parent: Node | null }

function key(x: number, y: number): number { return x * 1000 + y; }

export function findPath(
  passable: (x: number, y: number) => boolean,
  sx: number, sy: number, ex: number, ey: number,
): { x: number; y: number }[] {
  if (sx === ex && sy === ey) return [];
  const open: Node[] = [{ x: sx, y: sy, g: 0, f: 0, parent: null }];
  const closed = new Set<number>();
  const gScore = new Map<number, number>();
  gScore.set(key(sx, sy), 0);

  const push = (n: Node) => {
    // 二叉堆（小顶堆，按 f）
    open.push(n);
    let i = open.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (open[p]!.f <= open[i]!.f) break;
      [open[p], open[i]] = [open[i]!, open[p]!];
      i = p;
    }
  };
  const pop = (): Node | undefined => {
    const top = open[0]!;
    const last = open.pop()!;
    if (open.length > 0) {
      open[0] = last;
      let i = 0;
      // 下沉
      for (;;) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let m = i;
        if (l < open.length && open[l]!.f < open[m]!.f) m = l;
        if (r < open.length && open[r]!.f < open[m]!.f) m = r;
        if (m === i) break;
        [open[i], open[m]] = [open[m]!, open[i]!];
        i = m;
      }
    }
    return top;
  };

  const DIR = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let iterations = 0;
  while (open.length > 0 && iterations++ < 5000) {
    const cur = pop()!;
    if (cur.x === ex && cur.y === ey) {
      // 回溯路径
      const path: { x: number; y: number }[] = [];
      let n: Node | null = cur;
      while (n && n.parent) { path.push({ x: n.x, y: n.y }); n = n.parent; }
      return path.reverse();
    }
    const ck = key(cur.x, cur.y);
    if (closed.has(ck)) continue;
    closed.add(ck);
    for (const [dx, dy] of DIR) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!passable(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = cur.g + 1;
      if (ng >= (gScore.get(nk) ?? Infinity)) continue;
      const h = Math.abs(nx - ex) + Math.abs(ny - ey); // 曼哈顿
      gScore.set(nk, ng);
      push({ x: nx, y: ny, g: ng, f: ng + h, parent: cur });
    }
  }
  return []; // 无路
}