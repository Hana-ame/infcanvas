// 服务端 mod 管理器（modManager.ts）测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Sim } from '../../sim/sim';
import { ModRegistry } from '../../sim/mods/registry';
import { loadModsFromDir } from '../modManager';
import { validateContracts } from '../../sim/mods/contracts';

const good = readFileSync(join(process.cwd(), 'mods/demo-berry.mod.json'), 'utf-8');

let dir = '';
beforeEach(() => {
  dir = join(tmpdir(), `infcanvas-modtest-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('服务端 mod 管理器（loadModsFromDir）', () => {
  it('目录不存在 = 无 mod，不算错', () => {
    const r = loadModsFromDir(join(dir, 'nope'), ModRegistry.default());
    expect(r).toEqual({ ok: true, mods: [], errors: [] });
  });

  it('正常包：挂载进注册表 → 交给 Sim 后卡/世界可见', () => {
    writeFileSync(join(dir, 'demo-berry.mod.json'), good);
    const reg = ModRegistry.default();
    const r = loadModsFromDir(dir, reg);
    expect(r.ok).toBe(true);
    expect(r.mods).toEqual(['demo-berry']);
    const sim = new Sim({ seed: 7, pawnCount: 1, registry: reg });
    expect(sim.mods.cards.get('berryFeast')).toBeDefined();
    expect(sim.mods.tilesMap.get('berryBush')).toBeDefined();
    const ids = [...sim.systemIds];
    expect(ids.indexOf('berrySpoil')).toBeGreaterThan(-1);
  });

  it('坏包（scripts 语法错误）：ok=false + 错误明细，好包照常加载', () => {
    writeFileSync(join(dir, 'bad.mod.json'), JSON.stringify({
      manifest: { id: 'badmod', name: '坏包', version: '1' },
      scripts: 'const = 1;',
    }));
    writeFileSync(join(dir, 'demo-berry.mod.json'), good);
    const reg = ModRegistry.default();
    const r = loadModsFromDir(dir, reg);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain('bad.mod.json');
    expect(r.errors[0]).toContain('编译失败');
    expect(r.mods).toEqual(['demo-berry']); // 好包不受影响
  });

  it('目录内有非包文件被忽略', () => {
    writeFileSync(join(dir, 'readme.txt'), 'hi');
    const r = loadModsFromDir(dir, ModRegistry.default());
    expect(r).toEqual({ ok: true, mods: [], errors: [] });
  });

  // ---- 2026-08-16 修复回归：跨文件依赖（requires.mods 拓扑挂载）+ DLC 契约校验补跑 ----

  it('跨文件依赖：依赖方后于被依赖方挂载（按拓扑序，非文件名序）', () => {
    // alpha 依赖 beta：文件名序 alpha 在前（若按文件名序挂载 → alpha 先挂会因缺 beta 失败）
    writeFileSync(join(dir, 'alpha.mod.json'), JSON.stringify({
      manifest: { id: 'alpha', name: '后依赖', version: '1', requires: { mods: ['beta'] } },
      defs: { items: [{ id: 'alphaGem', name: '阿尔法宝石' }] },
    }));
    writeFileSync(join(dir, 'beta.mod.json'), JSON.stringify({
      manifest: { id: 'beta', name: '被依赖', version: '1' },
      defs: { items: [{ id: 'betaOre', name: '贝塔矿' }] },
    }));
    const reg = ModRegistry.default();
    const r = loadModsFromDir(dir, reg);
    expect(r.ok).toBe(true);
    expect(r.mods).toEqual(['beta', 'alpha']); // 拓扑序：被依赖方在前
    expect(reg.itemsMap.get('betaOre')).toBeDefined();
    expect(reg.itemsMap.get('alphaGem')).toBeDefined();
  });

  it('跨文件依赖缺失：报错跳过（不半挂载）', () => {
    writeFileSync(join(dir, 'alpha.mod.json'), JSON.stringify({
      manifest: { id: 'alpha', name: '缺依赖', version: '1', requires: { mods: ['ghost'] } },
      defs: { items: [{ id: 'alphaGem', name: '阿尔法宝石' }] },
    }));
    const reg = ModRegistry.default();
    const r = loadModsFromDir(dir, reg);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('ghost'); // 明确列出缺失依赖
    expect(r.mods).toEqual([]); // alpha 未挂载（无半挂载的悬空 def）
    expect(reg.itemsMap.get('alphaGem')).toBeUndefined();
  });

  it('requires.mods 非法（非数组/非法 id）：parse 失败报错', () => {
    writeFileSync(join(dir, 'bad-dep.mod.json'), JSON.stringify({
      manifest: { id: 'baddep', name: '坏依赖', version: '1', requires: { mods: 'not-array' } },
    }));
    const r = loadModsFromDir(dir, ModRegistry.default());
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('requires.mods');
  });

  it('DLC 契约路径：挂载 DLC 后 validateContracts 补跑能抓到违例（写方漏写契约键）', () => {
    // DLC 声明一件"可穿但无 warmth"的衣物 → 与 in-code 包同一条防线应报 item.meta.warmth 违例
    //（此前 validateContracts 只在 ModRegistry.default() 内部跑、先于 loadModsFromDir → DLC 漏校验）
    writeFileSync(join(dir, 'badcloth.mod.json'), JSON.stringify({
      manifest: { id: 'badcloth', name: '坏衣物', version: '1' },
      defs: { items: [{ id: 'badShirt', name: '问题衣物', meta: { wearable: true } }] },
    }));
    const reg = ModRegistry.default();
    const r = loadModsFromDir(dir, reg);
    expect(r.ok).toBe(true); // 挂载本身成功
    // server/index.ts 在 loadModsFromDir 后补跑 validateContracts（此处复现该步骤）
    const errs = validateContracts(reg);
    expect(errs.some((e) => e.includes('item.meta.warmth'))).toBe(true); // 违例被抓住
  });
});
