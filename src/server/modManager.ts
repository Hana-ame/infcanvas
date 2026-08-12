// 服务端 mod 管理器：扫描 MODS 目录的 .mod.json 包 → 先挂载到预建注册表再交给 Sim
// 用法（server/index.ts 构造 Sim 前）：
//   const reg = ModRegistry.default();
//   loadModsFromDir(MODS_DIR, reg);   // 失败返回 { ok:false }（由调用方决定是否拒服）
//   sim = new Sim({ registry: reg, ... });
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModRegistry } from '../sim/mods/registry';
import { parseModPackage, buildModMount } from '../mods/loader';

export interface ModLoadResult {
  ok: boolean;
  mods: string[];       // 已加载 mod id（按文件名序）
  errors: string[];     // 失败明细（ok=false 时原因）
}

export function loadModsFromDir(dir: string, reg: ModRegistry): ModLoadResult {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.mod.json')).sort();
  } catch {
    return { ok: true, mods: [], errors: [] }; // 目录不存在 = 无 mod，不算错
  }
  const mods: string[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      const pkg = parseModPackage(readFileSync(join(dir, f), 'utf-8'));
      buildModMount(pkg)(reg);
      mods.push(pkg.manifest.id);
    } catch (e) {
      errors.push(`mod "${f}": ${(e as Error).message}`);
    }
  }
  return { ok: errors.length === 0, mods, errors };
}