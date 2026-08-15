// 玩法包依赖解析 / 远程加载测试（2026-08-14）
// 用户需求：① 插件有前置包（有向图依赖）② 给 URL 就能远程加载包。
// 覆盖：前置缺失抛错 / 自动先挂前置（拓扑）/ 循环依赖抛错 / 幂等 / 远程 data URL 加载。
// 发现背景（2026-08-14 框架审查）：初版 8 用例 5 失败——① 循环依赖用例没测到循环路径
// （mount(A) 先因缺前置抛错），且检测本身是死代码（push 在 deps 之后 → 真环会无限递归
// 栈溢出，实测 "Maximum call stack size exceeded"），修复后补真环路径 + 断言不半挂；
// ② 各用例复用 id 'b'/'x'，撞全局包目录 → 互相污染，改为每用例唯一 id；
// ③ 远程用例当时全挂（new Function 动态 import 在 vitest CJS 下不可用），
// loadRemote 改为模块作用域直接 import(data URL) 后恢复。
import { describe, it, expect, vi } from 'vitest';
import { ModRegistry } from '../../sim/mods/registry';
import { TUNING } from '../../sim/defs/tuning';
import { TILES, BUILDINGS, ITEMS } from '../../sim/defs';
import { BASE_CARDS } from '../../sim/ai/pawn';
import { ENEMIES } from '../../sim/defs/enemies';
import { RECIPES } from '../../sim/defs/recipes';
import { DEFAULT_PLAYSTYLE_PACKS, PLAYSTYLE_PACKS } from '../packs/playstyle';
import type { ModPack } from '../pack';

// 最小组装 registry（构造 seed 只带必填项，tuning 用全量默认——与 modpack.test.ts 同法）
function bare(): ModRegistry {
  return new ModRegistry({ tiles: {}, buildings: {}, items: {}, enemies: {}, cards: [], recipes: {}, tuning: structuredClone(TUNING), intents: [], works: [] });
}

// 带内核种子数据的 registry（default() 同款 seed）：玩法包 overrideDef 的对象
//（cat/campfire/workbench…）来自内核 defs 表——裸 seed 挂清单会抛"覆盖目标不存在"
function seeded(): ModRegistry {
  return new ModRegistry({ tiles: TILES, buildings: BUILDINGS, items: ITEMS, enemies: ENEMIES, cards: BASE_CARDS, recipes: RECIPES, tuning: structuredClone(TUNING), intents: [], works: [] });
}

describe('玩法包前置依赖（有向图）', () => {
  it('mount 缺前置包 → 抛错提示先注册', () => {
    const m = bare();
    const packB: ModPack = { id: 'dep-missing', requires: ['dep-nope'], apply: vi.fn() };
    expect(() => m.mount(packB)).toThrow(/缺少前置包 "dep-nope"/);
  });

  it('requires 未挂载的前置 → 自动从目录先挂（拓扑序遍历）', () => {
    const m = bare();
    const order: string[] = [];
    const packA: ModPack = { id: 'topo-a', requires: ['topo-b'], apply: () => order.push('a') };
    const packB: ModPack = { id: 'topo-b', apply: () => order.push('b') };
    m.registerPack(packB); // 先入目录（相当于之前已加载过/内置）
    m.mount(packA);        // 只挂 A → B 自动先挂
    expect(order).toEqual(['b', 'a']);
    expect(m.packIds).toEqual(['topo-b', 'topo-a']);
  });

  it('循环依赖（A→B→A）→ 抛错且不半挂（双方 apply 都不执行）', () => {
    const m = bare();
    const applyA = vi.fn();
    const applyB = vi.fn();
    const packA: ModPack = { id: 'cyc-a', requires: ['cyc-b'], apply: applyA };
    const packB: ModPack = { id: 'cyc-b', requires: ['cyc-a'], apply: applyB };
    // 两个包都先入目录（真实循环：挂在谁身上都会撞回来）
    m.registerPack(packB);
    m.registerPack(packA);
    expect(() => m.mount(packA)).toThrow(/循环依赖 cyc-a → cyc-b → cyc-a/);
    expect(applyA).not.toHaveBeenCalled();
    expect(applyB).not.toHaveBeenCalled();
    expect(m.packIds).toEqual([]); // 无半挂
  });

  it('循环依赖抛错后挂载栈干净：后续正常包仍可挂', () => {
    const m = bare();
    const applyA = vi.fn();
    const packA: ModPack = { id: 'cyc2-a', requires: ['cyc2-b'], apply: applyA };
    m.registerPack({ id: 'cyc2-b', requires: ['cyc2-a'], apply: vi.fn() });
    m.registerPack(packA);
    expect(() => m.mount(packA)).toThrow(/循环依赖/);
    const ok = { id: 'cyc2-clean', apply: vi.fn() };
    m.mount(ok);
    expect(m.packIds).toEqual(['cyc2-clean']); // 栈未残留，否则会误报循环
  });

  it('同包 mount 两次 → 幂等（apply 只跑一次）', () => {
    const m = bare();
    const apply = vi.fn();
    const pack: ModPack = { id: 'idem-x', apply };
    m.mount(pack);
    m.mount(pack);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('同 id 不同对象重新注册 → warn 并替换（HMR 场景），新定义生效', () => {
    const m = bare();
    const v1 = vi.fn();
    const v2 = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.registerPack({ id: 'over-y', version: '1.0.0', apply: v1 });
    m.registerPack({ id: 'over-y', version: '1.1.0', apply: v2 }); // 模拟 HMR 重新 import
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    m.mount({ id: 'over-y', version: '1.1.0', apply: v2 });
    expect(v2).toHaveBeenCalledTimes(1); // 挂载的是新定义
    expect(v1).not.toHaveBeenCalled();
  });
});

describe('玩法包远程加载（给 URL）', () => {
  it('loadRemote(data URL 包) → 挂载生效（注册内容可见）', async () => {
    const m = bare();
    // data URL 里的最小玩法包：注册一个新物品（远程包能力 = 与本地包同 API）。
    // 发现背景：原用例用 overrideDef('building','campfire')，但 bare() 注册表
    // 无任何建筑 seed → 必抛"覆盖目标不存在"；此缺陷被初版 import 层错误掩盖。
    const src = `
      export default {
        id: 'httpPack',
        version: '1.0.0',
        apply(m) {
          m.registerItem({ id: 'remoteTrinket', name: '远方小玩意' });
        },
      };`;
    // fetch data URL（Node ≥ 18 原生支持）
    const url = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
    await m.loadRemote(url);
    expect(m.packIds).toContain('httpPack');
    expect(m.items.remoteTrinket?.name).toBe('远方小玩意');
  });

  it('远程包 requires 指向未加载前置 → 在注册时明确抛错', async () => {
    const m = bare();
    const src = `export default { id: 'needy', requires: ['missingRemote'], apply() {} };`;
    const url = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
    await expect(m.loadRemote(url)).rejects.toThrow(/缺少前置包 "missingRemote"/);
  });

  it('远程包无有效导出 → 抛错', async () => {
    const m = bare();
    const url = 'data:text/javascript;base64,' + Buffer.from('export default 42;', 'utf8').toString('base64');
    await expect(m.loadRemote(url)).rejects.toThrow(/导出无效/);
  });
});

describe('默认清单依赖显式化（2026-08-15）', () => {
  // 用户要求"每个包需要前置包，显式写出 + 框架自动组成有向无环图"——① 所有内置包必须
  // 显式声明 requires；② 挂载序由框架 topoSort 自动推导：**清单顺序不承担图约束**，
  // 乱序清单挂载后前置仍自动先 apply（同层相对序 = 清单序，稳定初始序）。
  const packs = DEFAULT_PLAYSTYLE_PACKS.map((id) => PLAYSTYLE_PACKS[id]);

  it('默认清单内每个包都显式声明 requires（无依赖 = 空数组）', () => {
    for (const p of packs) {
      expect(p.requires, `包 ${p.id} 缺 requires 声明`).toBeDefined();
    }
  });

  it('乱序清单 → 框架自动组 DAG：apply 序中每包前置必在自身之前', () => {
    const m = seeded();
    // 清单故意打乱（reverse）：挂载序必须由 requires 推导，而非清单书写序
    const shuffled = [...DEFAULT_PLAYSTYLE_PACKS].reverse();
    for (const id of shuffled) m.registerPack(PLAYSTYLE_PACKS[id]);
    m.mount({ id: 'shuffled-default', requires: shuffled, apply: () => {} });
    const order = m.packIds.filter((id) => DEFAULT_PLAYSTYLE_PACKS.includes(id));
    const at = new Map(order.map((id, i) => [id, i]));
    for (const p of packs) {
      for (const req of p.requires ?? []) {
        expect(at.get(req)! < at.get(p.id)!, `依赖序被破坏：${req} 应在 ${p.id} 之前（apply 序 ${order.join(' → ')}）`).toBe(true);
      }
    }
  });

  it('乱序清单挂载序确定性：同输入两次挂载结果一致', () => {
    const shuffled = [...DEFAULT_PLAYSTYLE_PACKS].reverse();
    const mountOnce = (): string[] => {
      const m = seeded();
      for (const id of shuffled) m.registerPack(PLAYSTYLE_PACKS[id]);
      m.mount({ id: `det-${shuffled.length}`, requires: shuffled, apply: () => {} });
      return m.packIds;
    };
    expect(mountOnce()).toEqual(mountOnce());
  });
});
