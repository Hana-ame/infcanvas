// DLC 加载器（2026-08-20，用户「写个加载器」）：
// 从本地目录批量加载 .mod.json 玩法包 → 依赖排序 → 挂载 + 契约校验 → 报告。
// 用法：
//   CLI: npx tsx scripts/loader.ts [目录] [--sim]  （--sim = 加载后跑 100 tick 冒烟）
//   程序: loadModsFromDir(dir) → { loaded, skipped, m }
// 设计：复用 src/mods/loader.ts 的 parseModPackage/mountModPackage + server 的
// mods/ 扫描逻辑；本脚本把它做成独立可复用的加载器（CLI + 库双面）。
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { ModRegistry } from '../src/sim/mods/registry';
import { Sim } from '../src/sim/sim';
import { parseModPackage, mountModPackage, packModPackage } from '../src/mods/loader';
import { validateContracts } from '../src/sim/mods/contracts';
import type { ModPackage } from '../src/mods/loader';
import type { ModPack } from '../src/mods/pack';

export interface LoadResult {
  dir: string;
  found: string[];          // 发现的所有 .mod.json
  loaded: string[];         // 成功挂载的包 id
  skipped: { id: string; reason: string }[]; // 跳过（重复/依赖缺失/解析失败）
  order: string[];          // 挂载序（依赖排序后）
  contractViolations: string[];
  m: ModRegistry;
}

// 扫描目录 → 解析全部 .mod.json → 依赖排序 → 挂载 → 报告
// 依赖排序：Kahn 拓扑（复用 pack.ts topoSort 的语义——此处自己实现，因为
// ModPackage 在 loader 层还没转成 ModPack；直接按 requires 做一次稳定拓扑）。
export function loadModsFromDir(dir: string, opts?: { sim?: Sim; log?: (s: string) => void }): LoadResult {
  const log = opts?.log ?? console.log;
  const result: LoadResult = { dir, found: [], loaded: [], skipped: [], order: [], contractViolations: [], m: opts?.sim ? (opts.sim as unknown as { mods: ModRegistry }).mods : ModRegistry.default() };

  if (!existsSync(dir)) {
    log(`⚠ 目录不存在: ${dir}`);
    return result;
  }

  // 1. 扫描 + 解析
  const files = readdirSync(dir).filter((f) => f.endsWith('.mod.json')); // extname 只取最后扩展名('.json')，用 endsWith 匹配 '.mod.json'
  result.found = files;
  if (files.length === 0) { log(`📭 ${dir} 无 .mod.json（空目录）`); return result; }

  const parsed: { file: string; pkg: ModPackage; id: string }[] = [];
  for (const f of files) {
    try {
      const pkg = parseModPackage(readFileSync(join(dir, f), 'utf-8'));
      parsed.push({ file: f, pkg, id: pkg.manifest.id });
    } catch (e) {
      result.skipped.push({ id: basename(f, '.mod.json'), reason: `解析失败: ${(e as Error).message}` });
      log(`❌ ${f}: ${(e as Error).message}`);
    }
  }

  // 2. 稳定拓扑排序（Kahn：requires 依赖，无依赖先挂；环 → 跳过并记录）
  // manifest.requires 是 { coreVersion?, mods?: string[] }（见 loader.ts ModManifest）——
  // mods 数组才是 DLC 间依赖（服务端按此拓扑喂序的同类语义）
  const depsOf = (p: { pkg: ModPackage }) => (p.pkg.manifest.requires?.mods ?? []);
  const byId = new Map(parsed.map((p) => [p.id, p]));
  const indegree = new Map<string, number>();
  for (const p of parsed) {
    indegree.set(p.id, depsOf(p).filter((r) => byId.has(r)).length);
  }
  const ready = parsed.filter((p) => (indegree.get(p.id) ?? 0) === 0).map((p) => p.id);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const p of parsed) {
      if (p.id === id || order.includes(p.id)) continue;
      if (depsOf(p).includes(id)) {
        const d = (indegree.get(p.id) ?? 0) - 1;
        indegree.set(p.id, d);
        if (d === 0) ready.push(p.id);
      }
    }
  }
  // 剩余未排 = 环或依赖缺失
  for (const p of parsed) {
    if (!order.includes(p.id)) {
      const missing = depsOf(p).filter((r) => !byId.has(r));
      result.skipped.push({ id: p.id, reason: missing.length ? `依赖缺失: ${missing.join(',')}` : '依赖成环' });
    }
  }

  // 3. 按序挂载
  for (const id of order) {
    const p = byId.get(id)!;
    const res = mountModPackage(p.pkg, result.m);
    if (res.ok) {
      result.loaded.push(id);
      log(`✅ ${id}${p.pkg.manifest.name ? ' (' + p.pkg.manifest.name + ')' : ''}`);
    } else {
      result.skipped.push({ id, reason: res.error });
      log(`❌ ${id}: ${res.error}`);
    }
  }
  result.order = order;

  // 4. 契约校验（挂载后——新包可能引入跨包键）
  const violations = validateContracts(result.m);
  result.contractViolations = violations;
  if (violations.length) log(`⚠ 契约违例 ${violations.length} 条:`);
  for (const v of violations) log(`   ${v}`);

  log(`\n📦 加载 ${result.loaded.length}/${files.length} 个包，跳过 ${result.skipped.length}，序: ${order.join(' → ')}`);
  return result;
}

// CLI 入口（ESM：import.meta.url 判断主模块——tsx 直接运行 = 入口）
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const dir = process.argv[2] ?? 'mods';
  const useSim = process.argv.includes('--sim');
  const log = (s: string) => console.log(s);

  log(`🔍 加载器扫描目录: ${dir}\n`);
  const result = loadModsFromDir(dir, { log });

  if (useSim) {
    log(`\n🚀 --sim 冒烟：构造 Sim + 40 pawn 跑 100 tick…`);
    const sim = new Sim({ seed: 42, pawnCount: 40, registry: result.m });
    sim.step(1);
    for (let i = 0; i < 99; i++) sim.step(1);
    log(`✅ 冒烟通过：${sim.pawns.length} 存活 / ${sim.systemIds.length} 系统 / 建筑 ${Object.keys(result.m.buildings).length}`);
  }
}