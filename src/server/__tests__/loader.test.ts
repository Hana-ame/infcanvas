// DLC 加载器测试（2026-08-20，用户「写个加载器」）：
// scripts/loader.ts 的 loadModsFromDir —— 目录扫描/解析/依赖拓扑/挂载/契约校验/报告
import { describe, it, expect } from 'vitest';
import { loadModsFromDir } from '../../../scripts/loader';

describe('DLC 加载器（scripts/loader.ts）', () => {
  it('加载 mods/ 目录全部 .mod.json（10 个包全挂 + 依赖序）', () => {
    const logs: string[] = [];
    const r = loadModsFromDir('mods', { log: (s) => logs.push(s) });
    expect(r.found.length).toBeGreaterThan(0);
    expect(r.loaded.length).toBe(r.found.length); // 10/10 全挂
    expect(r.skipped.length).toBe(0);
    // 依赖序稳定：无 requires 的包在前（demo-berry 首个）
    expect(r.order[0]).toBe('demo-berry');
    // 契约零违例
    expect(r.contractViolations).toEqual([]);
  });

  it('目录不存在 → 不崩 + 返回空', () => {
    const r = loadModsFromDir('nonexistent-dir-xyz', { log: () => {} });
    expect(r.found).toEqual([]);
    expect(r.loaded).toEqual([]);
  });

  it('挂载后的 registry 可构造 Sim（含 DLC 建筑/系统）', () => {
    const r = loadModsFromDir('mods', { log: () => {} });
    expect(r.m.buildings).toBeDefined();
    // DLC 注册了建筑（2077/demo-berry 等有 defs）
    expect(Object.keys(r.m.tiles).length).toBeGreaterThan(0);
  });
});
