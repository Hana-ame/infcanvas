// 玩法包契约与包目录（2026-08-14，插件前置依赖 + 远程加载）
// 背景：玩法包原先是无名函数（packs/*.ts 各导出 apply 函数，registry.default() 手动逐个调用），
// 无法表达"这个包依赖另一个包"，也无法用 URL 动态加载第三方包。
// 本文件引入 ModPack：id + requires[]（前置依赖，有向图）+ apply；包目录全局共享
// （与 leanStore 同策略：跨 ModRegistry 实例，同一包只需加载一次）。
// 2026-08-15 自动组 DAG：挂载序不再依赖手写清单顺序——topoSort 把包 + 全部 requires
//   闭包收集后做 Kahn 拓扑排序，框架自动推导"前置先 apply"的挂载序（环/缺前置检出）。
//   清单（playstyle）只是"要挂哪些包"的选择器，数组顺序仅作同层（无 requires 关系的包）
//   的稳定初始序，不承担图约束。
// 用法：
//   import { modA } from './a';           // 前端 import 型（本地源码包）
//   m.registerPack(modA); m.mount(modA);  // 或只 mount（自动入目录 + 拓扑解析）
//   await m.loadRemote('https://.../mod.js'); // 远程型：fetch → ES module → 挂载
import type { ModRegistry } from '../sim/mods/registry';

// 玩法包契约：id 全局唯一（依赖引用 key）；requires 列出前置包 id；
// apply 阶段可调用 registry 全部注册/覆盖 API。
export interface ModPack {
  id: string;
  name?: string;          // 展示名（远程商店/列表用）
  version?: string;       // 包版本（远程包建议带）
  requires?: string[];    // 前置包 id（有向图边：本包 → 依赖）
  apply(m: ModRegistry): void;
}

// 包目录条目：包对象 + 来源（本地/远程 URL 描述，报错时能指出出处）
interface PackEntry {
  pack: ModPack;
  source: string;
}

// 全局包目录（跨 ModRegistry）：mount 时自动登记；远程包加载后也进目录，
// 后续包可依赖它。同一包在多个 registry 上挂载 = 幂等跳过（apply 只跑一次）。
const packDirectory = new Map<string, PackEntry>();

export function registerPack(pack: ModPack, source = 'local'): void {
  const old = packDirectory.get(pack.id);
  if (old) {
    if (old.pack === pack) return; // 同一包对象重复注册幂等（服务端多 registry 共用安全）
    // 同 id 不同对象：warn + 替换（last wins）而非抛错。理由：
    // ① vite HMR / 重新构建后模块重新求值 → 同 id 新对象，抛错会让 dev 挂载必挂；
    // ② 包目录只是"依赖图索引"（requires 引用 id），真实冲突由 def 级注册
    //    （registerBuilding/registerItem…assertNew 抛错）兜底，此处硬抛反而双保险失效。
    console.warn(
      `mod: 包 "${pack.id}" 以新定义重新注册（旧来源 ${old.source}${old.pack.version ? ` v${old.pack.version}` : ''}` +
      `${pack.version ? `，新 v${pack.version}` : ''}），已替换旧条目`,
    );
  }
  packDirectory.set(pack.id, { pack, source });
}

export function packExists(id: string): boolean {
  return packDirectory.has(id);
}

export function getPack(id: string): PackEntry | undefined {
  return packDirectory.get(id);
}

// 自动组 DAG（2026-08-15）：拓扑排序推导挂载序
// 输入任意包集合（通常是 playstyle 聚合包/单个第三方包）→ ① 闭包收集（包 + 全部可达
// requires，requires 指向目录外 = 缺前置抛错）；② Kahn 拓扑排序——入度 0 出队 apply，
// 前置必在依赖者之前（自动组图，无需调用方维护顺序）；③ 队列清空仍有剩余 = 环（报错
// 并给出环链，apply 不半挂）。同层（无 requires 关系）相对序 = 闭包收集序（输入序稳定）。
export function topoSort(packs: ModPack[]): ModPack[] {
  // 闭包收集（BFS，FIFO 保持输入序 = 同层稳定初始序）
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
      if (!dep) {
        throw new Error(
          `mod: 玩法包 "${p.id}" 缺少前置包 "${req}"（未注册/未加载）——` +
          `请先 registerPack 或 loadRemote 它`,
        );
      }
      queue.push(dep.pack);
    }
  }
  // Kahn：入度 = 闭包内被依赖数；入度 0 = 无前置可立即 apply
  const byId = new Map(closure.map((p) => [p.id, p]));
  const indegree = new Map<string, number>();
  for (const p of closure) {
    indegree.set(p.id, (p.requires ?? []).filter((r) => byId.has(r)).length);
  }
  const out: ModPack[] = [];
  const ready = closure.filter((p) => indegree.get(p.id) === 0).map((p) => p.id);
  while (ready.length) {
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    for (const p of closure) {
      if ((p.requires ?? []).includes(id)) {
        const d = indegree.get(p.id)! - 1;
        indegree.set(p.id, d);
        if (d === 0) ready.push(p.id);
      }
    }
  }
  if (out.length !== closure.length) {
    // 剩余 = 环上节点（闭包收集序）；补环尾便于阅读（与旧 DFS 报错同格式）
    const left = closure.filter((p) => !out.includes(p)).map((p) => p.id);
    throw new Error(`mod: 玩法包循环依赖 ${[...left, left[0]].join(' → ')}`);
  }
  return out;
}

// 动态加载远程包：给 URL 就行（fetch ES module 文本 → data URL import）。
// 浏览器端受 CORS 约束（跨源需服务端允许）；Node 端任意 URL。
// 安全边界（诚实声明）：远程代码以本进程权限执行，无沙箱隔离——只应加载可信来源；
// 沙箱加载器（JSON defs + scripts 白名单）见 mods/loader.ts，远程源码包不在其列。
export async function loadRemote(url: string): Promise<ModPack> {
  const src = await (await fetch(url)).text();
  // data URL 编码：encodeURIComponent 双端可用（此前 Buffer.from 是 Node-only，
  // 浏览器端直接 ReferenceError）。@vite-ignore 让 vite 不解析该动态 import，
  // 浏览器/vitest/tsx 都走 JS 引擎原生 data: scheme 导入——此前 new Function
  // 包装在 vitest(CJS 转换)下报 "dynamic import callback was not specified"，
  // 模块作用域直接 import() 由 vite-node 转换器正确接管。
  const mod = await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(src));
  const pack = (mod && (mod.default ?? mod.pack)) as ModPack | undefined;
  if (!pack || typeof pack.id !== 'string' || typeof pack.apply !== 'function') {
    throw new Error(`mod: 远程包 ${url} 导出无效——需 default export 提供 { id, apply }（ModPack）`);
  }
  return pack;
}