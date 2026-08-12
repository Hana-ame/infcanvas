// 服务端 mod 管理器（modManager.ts）测试
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Sim } from '../../sim/sim';
import { ModRegistry } from '../../sim/mods/registry';
import { loadModsFromDir } from '../modManager';

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
});
