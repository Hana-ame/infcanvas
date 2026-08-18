// 服务端 mod 管理器：扫描 MODS 目录的 .mod.json 包 → 先挂载到预建注册表再交给 Sim
// 用法（server/index.ts 构造 Sim 前）：
//   const reg = ModRegistry.default();
//   loadModsFromDir(MODS_DIR, reg);   // 失败返回 { ok:false }（由调用方决定是否拒服）
//   sim = new Sim({ registry: reg, ... });
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModRegistry } from '../sim/mods/registry';
import { parseModPackage, buildModMount, type ModPackage } from '../mods/loader';

export interface ModLoadResult {
  ok: boolean;
  mods: string[];       // 已加载 mod id（按依赖拓扑序）
  errors: string[];     // 失败明细（ok=false 时原因）
}

// 跨文件依赖挂载（2026-08-16 修复）：manifest.requires.mods 声明依赖，按拓扑序喂入注册表
// ——与 in-code ModPack 的 requires/topoSort DAG 对齐（此前按文件名序独立挂载，依赖方
// 可能先于被依赖方挂载 → DLC 引用缺失 def 静默失败/半挂载）。缺失依赖 = 报错跳过该包
// （不半挂载——defs 引用悬空的包比不加载更危险）。环依赖按"依赖未就绪即跳过"处理，
// 依赖链不闭合的包由调用方看到 errors。
export function loadModsFromDir(dir: string, reg: ModRegistry): ModLoadResult {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.mod.json')).sort();
  } catch {
    return { ok: true, mods: [], errors: [] }; // 目录不存在 = 无 mod，不算错
  }
  // 解析所有包（parse 失败 = 报错跳过）
  const pkgs: { file: string; pkg: ModPackage }[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      pkgs.push({ file: f, pkg: parseModPackage(readFileSync(join(dir, f), 'utf-8')) });
    } catch (e) {
      errors.push(`mod "${f}": ${(e as Error).message}`);
    }
  }
  // 拓扑喂序：反复扫描未挂载包，依赖（requires.mods）全部已挂载才挂；一轮无进展 =
  // 剩余包依赖缺失/成环 → 报错（有明确错误信息，不静默丢包）
  const loaded = new Set<string>();
  const mods: string[] = [];
  const pending = [...pkgs];
  while (pending.length > 0) {
    let progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const { file, pkg } = pending[i];
      const deps = pkg.manifest.requires?.mods ?? [];
      if (!deps.every((d) => loaded.has(d))) continue; // 依赖未就绪：留下轮
      const id = pkg.manifest.id;
      try {
        buildModMount(pkg)(reg);
        loaded.add(id);
        mods.push(id);
        pending.splice(i, 1);
        progressed = true;
      } catch (e) {
        errors.push(`mod "${file}": ${(e as Error).message}`);
        pending.splice(i, 1);
      }
    }
    if (!progressed) break; // 剩余包依赖缺失或成环
  }
  for (const { file, pkg } of pending) {
    const missing = (pkg.manifest.requires?.mods ?? []).filter((d) => !loaded.has(d));
    errors.push(`mod "${file}"（${pkg.manifest.id}）依赖未满足，跳过：${missing.join(', ')}`);
  }
  return { ok: errors.length === 0, mods, errors };
}