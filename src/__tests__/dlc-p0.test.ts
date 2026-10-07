/**
 * dlc-p0.test.ts —— DLC 分层 P0 地基（见 notes/proj-infcanvas-dlc-design-2026-10-07.md）。
 *
 * 覆盖三块地基（**不拆任何现有包、不碰 R1-R6 约束**）：
 *  ① `SimContext.hasDlc(id)` 缺省恒 false，只对带 `dlc` 声明的已挂载包答 true；
 *  ② `ModRegistry.default({ dlc, exclude })`：
 *     - 不传参 = 只挂本体（原版能玩）；
 *     - 排除级联（依赖被排除包的包一并排除，不让"关一个包"变成"起不来"）；
 *     - 未知 DLC id = 装配期响亮报错（拼错不该静默变"没装"）；
 *  ③ `dlc_load.json` 读取：**文件不存在 = 只挂本体**；坏配置带文件名抛错。
 *
 * 为什么把 P0 单独立文件而不塞进 assembly.test.ts：P0 是"门控地基"，与
 * 组装/执行序是两层关注点；分文件后将来 P1（拆 DLC 内容包）能直接在这里扩。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sim } from '../sim';
import { ModRegistry, type ModPack } from '../mods';
import { resolvePacks } from '../mods/registry';
import { DEFAULT_PLAYSTYLE_PACKS, DLC_PACKS } from '../mods/packs/playstyle';
import { emptyDlcLoad, parseDlcLoad, readDlcLoad, DLC_LOAD_FILE } from '../server/dlc-load';

/** 测试用 DLC：只注册一条无副作用的谓词——P0 验的是"装没装"，不是"装了什么" */
const fakeDlc: ModPack = {
  id: 'fake-dlc',
  requires: [],
  dlc: { title: '假 DLC（测试用）', order: 1 },
  apply(m) {
    m.registerPredicate('fake-dlc.probe', () => true);
  },
};

/** 依赖本体 building 的测试 DLC（验"排除级联"对 DLC 同样生效） */
const fakeDlcOnBuilding: ModPack = {
  id: 'fake-dlc-building',
  requires: ['building'],
  dlc: { title: '依赖 building 的假 DLC' },
  apply() {},
};

describe('DLC P0 · hasDlc 基线（原版体验）', () => {
  it('默认装配：hasDlc 对任何 id 都答 false（缺省恒 false = 原版能玩）', () => {
    const s = new Sim({ seed: 1, registry: ModRegistry.default() });
    expect(s.hasDlc('fake-dlc')).toBe(false);
    expect(s.hasDlc('medicine')).toBe(false); // 本体包即使挂着也不当 DLC
    expect(s.hasDlc('')).toBe(false);
    expect(s.hasDlc('拼错的 id')).toBe(false); // 未知 id 答 false 而非抛错
  });

  it('挂上带 dlc 声明的包后，只有它答 true；同批的本体包仍 false', () => {
    const reg = ModRegistry.mountPacks([...DEFAULT_PLAYSTYLE_PACKS, fakeDlc]);
    const s = new Sim({ seed: 1, registry: reg });
    expect(s.hasDlc('fake-dlc')).toBe(true);
    expect(s.hasDlc('medicine')).toBe(false);
    expect(s.hasDlc('needs')).toBe(false);
    // registry 侧同口径（Sim.hasDlc 是 registry 视图，不另存一份）
    expect(reg.enabledDlcIds()).toEqual(['fake-dlc']);
    expect(reg.dlcMeta('fake-dlc')?.title).toBe('假 DLC（测试用）');
  });

  it('未挂载的 DLC 答 false —— "没装 = 不跑"（且 apply 失败时不登记，不出现半挂载幽灵）', () => {
    // 只挂本体：表里存在的 DLC 一个没装
    const reg = ModRegistry.default();
    expect(reg.isMounted('fake-dlc')).toBe(false);
    expect(reg.dlcEnabled('fake-dlc')).toBe(false);
    expect(reg.enabledDlcIds()).toEqual([]);

    // apply 抛错 → 不登记（mounted 与 dlcDecls 都干净）：否则会出现"以为装了"的幽灵
    const boom: ModPack = {
      id: 'boom-dlc',
      requires: [],
      dlc: { title: '挂载即炸' },
      apply(m) {
        m.registerSystemDef({ id: 'boom-dlc', category: 'world', ctor: () => ({ id: 'boom-dlc', update() {} }) });
        throw new Error('boom');
      },
    };
    const reg2 = new ModRegistry();
    expect(() => reg2.mountPack(boom)).toThrow('boom');
    expect(reg2.dlcEnabled('boom-dlc')).toBe(false);
    expect(reg2.isMounted('boom-dlc')).toBe(false);
  });
});

describe('DLC P0 · resolvePacks（启用/排除的唯一判定处）', () => {
  it('不传参 = 本体清单原样（顺序保留，零改动）', () => {
    const out = resolvePacks(DEFAULT_PLAYSTYLE_PACKS, DLC_PACKS, {});
    expect(out.map((p) => p.id)).toEqual(DEFAULT_PLAYSTYLE_PACKS.map((p) => p.id));
  });

  it('dlc 追加已登记的包（DLC_PACKS 为空时传参 = 响亮报错，不静默变"没装"）', () => {
    const table = { 'fake-dlc': fakeDlc };
    const out = resolvePacks(DEFAULT_PLAYSTYLE_PACKS, table, { dlc: ['fake-dlc'] });
    expect(out.map((p) => p.id)).toContain('fake-dlc');
    expect(out.length).toBe(DEFAULT_PLAYSTYLE_PACKS.length + 1);

    expect(() => resolvePacks(DEFAULT_PLAYSTYLE_PACKS, DLC_PACKS, { dlc: ['nope'] })).toThrow(/未知 DLC/);
  });

  it('exclude 移除本体包', () => {
    const out = resolvePacks(DEFAULT_PLAYSTYLE_PACKS, DLC_PACKS, { exclude: ['env'] });
    expect(out.some((p) => p.id === 'env')).toBe(false);
    expect(out.length).toBe(DEFAULT_PLAYSTYLE_PACKS.length - 1);
  });

  it('exclude 级联：依赖被排除包的包一并排除（依赖断裂安全）', () => {
    // building 是 medicine/farming/bootstrap/fortify/factions 等的硬依赖
    const out = resolvePacks(DEFAULT_PLAYSTYLE_PACKS, DLC_PACKS, { exclude: ['building'] });
    const ids = out.map((p) => p.id);
    expect(ids).not.toContain('building');
    expect(ids).not.toContain('medicine'); // requires building
    expect(ids).not.toContain('bootstrap'); // requires building
    expect(ids).not.toContain('farming'); // requires building
    // 无依赖的包必须留下（级联不是"全灭"）
    expect(ids).toContain('needs');
    expect(ids).toContain('gathering');
    expect(ids).toContain('social');
  });

  it('exclude 优先于 dlc（"买了也能停"，对位 HOI4 启动器）', () => {
    const table = { 'fake-dlc': fakeDlc };
    const out = resolvePacks(DEFAULT_PLAYSTYLE_PACKS, table, { dlc: ['fake-dlc'], exclude: ['fake-dlc'] });
    expect(out.some((p) => p.id === 'fake-dlc')).toBe(false);
  });

  it('exclude 级联对 DLC 也生效（DLC 依赖本体包被排除 → DLC 一并排除）', () => {
    const table = { 'fake-dlc-building': fakeDlcOnBuilding };
    const out = resolvePacks(DEFAULT_PLAYSTYLE_PACKS, table, {
      dlc: ['fake-dlc-building'],
      exclude: ['building'],
    });
    expect(out.some((p) => p.id === 'fake-dlc-building')).toBe(false);
  });

  it('default({dlc,exclude}) 装配出的系统数与 default() 相同（P0 零回归）', () => {
    const base = ModRegistry.default();
    const withEmpty = ModRegistry.default({ dlc: [], exclude: [] });
    expect(withEmpty.systemIds()).toEqual(base.systemIds());
    expect(base.systemIds().length).toBeGreaterThan(0);
  });
});

describe('DLC P0 · dlc_load.json 读取', () => {
  const tmp = (): string => mkdtempSync(join(tmpdir(), 'infcanvas-dlc-'));

  it('文件不存在 = 只挂本体（present:false，enabledDlc 空）', () => {
    const dir = tmp();
    try {
      const cfg = readDlcLoad(dir);
      expect(cfg.present).toBe(false);
      expect(cfg.enabledDlc).toEqual([]);
      expect(cfg.disabledDlc).toEqual([]);
      expect(emptyDlcLoad()).toEqual(cfg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('合法文件：解析 enabledDlc/disabledDlc/base，present:true', () => {
    const dir = tmp();
    try {
      writeFileSync(
        join(dir, DLC_LOAD_FILE),
        JSON.stringify({ base: '2026.10', enabledDlc: ['a', 'b'], disabledDlc: ['c'] }),
      );
      const cfg = readDlcLoad(dir);
      expect(cfg.present).toBe(true);
      expect(cfg.base).toBe('2026.10');
      expect(cfg.enabledDlc).toEqual(['a', 'b']);
      expect(cfg.disabledDlc).toEqual(['c']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缺省键 = 空数组（只写 enabledDlc 也合法）', () => {
    const cfg = parseDlcLoad('{"enabledDlc":["x"]}', 'dlc_load.json');
    expect(cfg.enabledDlc).toEqual(['x']);
    expect(cfg.disabledDlc).toEqual([]);
  });

  it('坏 JSON / 未知键 / 非数组 → 带文件名抛错（响亮失败，不静默忽略）', () => {
    expect(() => parseDlcLoad('{oops', 'mods/dlc_load.json')).toThrow(/不是合法 JSON.*dlc_load\.json/);
    expect(() => parseDlcLoad('[]', 'dlc_load.json')).toThrow(/必须是 JSON 对象/);
    expect(() => parseDlcLoad('{"enabledMods":["a"]}', 'dlc_load.json')).toThrow(/未知键 "enabledMods"/);
    expect(() => parseDlcLoad('{"enabledDlc":"a"}', 'dlc_load.json')).toThrow(/必须是字符串数组/);
    expect(() => parseDlcLoad('{"enabledDlc":[""]}', 'dlc_load.json')).toThrow(/非法项/);
    expect(() => parseDlcLoad('{"base":1}', 'dlc_load.json')).toThrow(/base 必须是字符串/);
  });
});
