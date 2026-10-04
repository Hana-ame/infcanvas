/**
 * pack.ts —— ModPack 契约 + 依赖拓扑排序。
 *
 * 一切皆插件（原则④）：玩法 = ModPack { id, requires, apply }。
 * - requires 显式声明硬依赖；挂载序由 Kahn 拓扑从 requires 自动推导，
 *   清单顺序不承担图约束（乱序也自动正确）——旧项目踩坑结论：靠清单顺序维护
 *   挂载序迟早漂移，显式依赖才是唯一事实。
 * - 无依赖必须写 requires: []（显式无依赖，与"忘了写"区分）。
 */

export interface ModPack {
  id: string;
  requires?: string[];
  apply(m: import('./registry').ModRegistry): void;
}

/**
 * Kahn 拓扑排序：稳定（同层保持输入顺序 → 确定性装配）；
 * 缺依赖 / 环 → 抛错（挂载失败要响亮，静默半挂载是事故源头）。
 */
export function topoSort(packs: ModPack[]): ModPack[] {
  const byId = new Map<string, ModPack>();
  for (const p of packs) {
    if (byId.has(p.id)) throw new Error(`包 id 重复：${p.id}`);
    byId.set(p.id, p);
  }
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // depId → 依赖它的包 id 列表
  for (const p of packs) {
    const reqs = p.requires ?? [];
    indeg.set(p.id, reqs.length);
    for (const r of reqs) {
      if (!byId.has(r)) throw new Error(`包 ${p.id} 依赖的 ${r} 不在挂载清单中`);
      const arr = dependents.get(r);
      if (arr) arr.push(p.id);
      else dependents.set(r, [p.id]);
    }
  }
  // 队列种子按输入序 → 同层稳定
  const queue = packs.filter((p) => (indeg.get(p.id) ?? 0) === 0).map((p) => p.id);
  const out: ModPack[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(byId.get(id)!);
    for (const nxt of dependents.get(id) ?? []) {
      const left = (indeg.get(nxt) ?? 0) - 1;
      indeg.set(nxt, left);
      if (left === 0) queue.push(nxt);
    }
  }
  if (out.length !== packs.length) {
    const cyclic = packs.map((p) => p.id).filter((id) => !out.some((o) => o.id === id));
    throw new Error(`包依赖成环：${cyclic.join(', ')}`);
  }
  return out;
}
