// 玩法包（2026-08-21 从零重写·精简插件化）
// 一切可装卸玩法 = ModPack。内核只提供：==注册表 + 挂载拓扑 + 执行序推导==。

import type { Sim } from './sim';
import type { GameSystem } from './systems';

export type Category = 'needs' | 'ai' | 'society' | 'production' | 'raid' | 'world' | 'boot';

/** 系统定义（包注册，Sim 装配） */
export interface SystemDef {
  id: string;
  category: Category;
  ctor: (sim: Sim) => GameSystem;
}

/** 玩法包：注册 def + 声明依赖 */
export interface ModPack {
  id: string;
  name?: string;
  /** 前置包 id（挂载拓扑：先挂依赖） */
  requires?: string[];
  /** 子包（DLC 里加 DLC：父包自动先挂子包） */
  subpacks?: ModPack[];
  apply(m: ModRegistry): void;
}

/** 类别执行序（唯一人工语义） */
export const CATEGORY_ORDER: Category[] = ['needs', 'ai', 'society', 'production', 'raid', 'world', 'boot'];

// ---- 包目录 + 拓扑 ----

const directory = new Map<string, ModPack>();

export function registerPack(pack: ModPack): void {
  if (!directory.has(pack.id)) directory.set(pack.id, pack);
}

export function getPack(id: string): ModPack | undefined {
  return directory.get(id);
}

/** Kahn 拓扑：闭包收集（pack + requires + subpacks）+ 依赖排序 */
export function topoSort(packs: ModPack[]): ModPack[] {
  const seen = new Set<string>();
  const closure: ModPack[] = [];
  const queue = [...packs];
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    closure.push(p);
    for (const req of p.requires ?? []) {
      const dep = getPack(req);
      if (!dep) throw new Error(`玩法包 ${p.id} 缺前置包 ${req}`);
      queue.push(dep);
    }
    for (const sub of p.subpacks ?? []) queue.push(sub);
  }
  const byId = new Map(closure.map((p) => [p.id, p]));
  const indeg = new Map<string, number>();
  for (const p of closure) {
    const deps = [...(p.requires ?? []), ...(p.subpacks ?? []).map((s) => s.id)];
    indeg.set(p.id, deps.filter((d) => byId.has(d)).length);
  }
  const ready = closure.filter((p) => (indeg.get(p.id) ?? 0) === 0).map((p) => p.id);
  const out: ModPack[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    for (const p of closure) {
      if (p.id === id || out.includes(p)) continue;
      const deps = [...(p.requires ?? []), ...(p.subpacks ?? []).map((s) => s.id)];
      if (deps.includes(id)) {
        indeg.set(p.id, (indeg.get(p.id) ?? 0) - 1);
        if ((indeg.get(p.id) ?? 0) === 0) ready.push(p.id);
      }
    }
  }
  if (out.length !== closure.length) throw new Error('玩法包依赖成环');
  return out;
}