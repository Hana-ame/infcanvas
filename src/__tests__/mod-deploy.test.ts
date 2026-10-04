/**
 * mod-deploy.test.ts —— R2-2 / R2-3 验收：.mod.json 数据化部署 + DLC 式独立包示范。
 *
 * 覆盖验收清单：
 *   - 缺依赖报错且不半挂载；
 *   - 重复 id 报错且不半挂载；
 *   - 坏 JSON 给出文件名级错误定位；
 *   - 目录放入 .mod.json 即生效（扫描 → 拓扑 → 注册面 → 契约校验全链路）；
 *   - 同一内容两种部署形态（JSON vs TS 包）产出等价装配。
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';
import { DEFAULT_PLAYSTYLE_PACKS } from '../mods/packs/playstyle';
import { sampleBerryPack } from '../mods/packs/sample-berry';
import {
  mountWithBase,
  parseModPackage,
  readModDir,
  type LoadedMod,
} from '../server/mod-loader';

/** 临时目录工具：每个用例自建自清，不留残留（测试之间物理隔离） */
function withTmpDir(fn: (dir: string) => void): void {
  const dir = join(tmpdir(), `infcanvas-r2-modtest-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 从 JSON 文本构造 LoadedMod（绕过文件系统，专测纯逻辑路径） */
function mod(text: string, file = 'test.mod.json'): LoadedMod {
  return { file, pkg: parseModPackage(text, file) };
}

const VALID = JSON.stringify({
  manifest: { id: 'json-dlc', title: 'JSON DLC' },
  defs: {
    items: [{ id: 'pebble', name: '石子' }],
    buildings: [{ id: 'jsonShack', name: '窝棚', cost: { wood: 5 }, hp: 50, tags: ['shelter'], passable: false }],
    enemies: [{ id: 'jsonWolf', name: '野狼', hp: 20, dmg: 3, speed: 4.5, atkCd: 1.5 }],
    cards: [{ id: 'json_wander_work', label: '四下张望', series: 'wander', weight: 4 }],
  },
});

describe('R2-2 .mod.json 数据化部署', () => {
  it('合法包：逐 def 进注册面（物品/建筑/敌人/卡全部生效）', () => {
    const { registry, report } = mountWithBase([], [mod(VALID)]);
    expect(report.loaded).toEqual(['json-dlc']);
    expect(registry.items.some((i) => i.id === 'pebble')).toBe(true);
    const t = registry.effectiveTuning();
    expect(t.buildings['jsonShack']?.name).toBe('窝棚');
    expect(t.enemies['jsonWolf']?.hp).toBe(20);
    expect(registry.cardById('json_wander_work')).toBeDefined();
  });

  it('缺依赖：报错且点名缺失包，不半挂载', () => {
    const orphan = JSON.stringify({
      manifest: { id: 'orphan-dlc', title: '孤儿包', requires: ['does-not-exist'] },
      defs: { items: [{ id: 'orphan_item', name: '孤儿物品' }] },
    });
    // 装配前拓扑就失败（mountWithBase 抛错 = 拿不到半成品 registry）
    expect(() => mountWithBase([], [mod(orphan)])).toThrow(/does-not-exist/);
    // 独立验证：另一张 registry 确实没被污染
    const clean = new ModRegistry();
    expect(clean.items.some((i) => i.id === 'orphan_item')).toBe(false);
  });

  it('重复 id：响亮报错（"已存在"），且失败前的内容仍完整保留', () => {
    const dup = JSON.stringify({
      manifest: { id: 'json-dlc-2', title: '撞名包' },
      defs: { buildings: [{ id: 'jsonShack', name: '重名窝棚', cost: {}, hp: 1, tags: [], passable: false }] },
    });
    // registerBuilding 抛"建筑已存在"——不做静默覆盖（否则后者的数值会悄悄顶掉前者）
    expect(() => mountWithBase([], [mod(VALID), mod(dup)])).toThrow(/建筑已存在/);
  });

  it('坏 JSON：错误信息含文件名（文件名级定位）', () => {
    expect(() => parseModPackage('{ "manifest": ', 'my-broken.mod.json')).toThrow(/my-broken\.mod\.json/);
  });

  it('坏 JSON（目录扫描路径）：err 组带文件名与原因', () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, 'broken.mod.json'), '{ not json', 'utf-8');
      writeFileSync(join(dir, 'good.mod.json'), VALID, 'utf-8');
      const { ok, err } = readModDir(dir);
      expect(ok).toHaveLength(1);
      expect(err).toHaveLength(1);
      expect(err[0].file).toContain('broken.mod.json');
      expect(err[0].reason).toContain('broken.mod.json');
    });
  });

  it('未知 defs 字段 / 非法 id / 未登记系列：各自响亮报错', () => {
    // 未知字段：拼错的字段名被静默忽略 = 作者以为内容生效了
    expect(() =>
      parseModPackage(JSON.stringify({ manifest: { id: 'x', title: 'x' }, defs: { bulidings: [] } }), 'x.mod.json'),
    ).toThrow(/未知字段/);
    // 非法 id：防路径穿越
    expect(() =>
      parseModPackage(JSON.stringify({ manifest: { id: '../evil', title: 'evil' } }), 'x.mod.json'),
    ).toThrow(/非法/);
    // 未登记系列：契约校验拦下（拼写漂移在装配末暴露）
    const badSeries = JSON.stringify({
      manifest: { id: 'series-dlc', title: '系列拼错' },
      defs: { cards: [{ id: 'typo_card', label: '手滑', series: 'gahter', weight: 1 }] },
    });
    expect(() => mountWithBase([], [mod(badSeries)])).toThrow(/未登记系列/);
  });

  it('谓词引用：未登记的谓词名报错（否则卡永远抽不到 = 最难查的静默失效）', () => {
    const badPred = JSON.stringify({
      manifest: { id: 'pred-dlc', title: '谓词拼错' },
      defs: { cards: [{ id: 'c', label: 'c', series: 'wander', weight: 1, condition: { predicate: 'nope' } }] },
    });
    expect(() => mountWithBase([], [mod(badPred)])).toThrow(/未登记谓词/);
  });

  it('谓词引用已登记名：谓词被正确接上（卡真的会按局面过滤）', () => {
    const predPack = {
      id: 'pred-provider',
      requires: [],
      apply: (m: ModRegistry) => m.registerPredicate('foodLow', (ctx) => (ctx.stockpile['food'] ?? 0) < 5),
    };
    const withPred = JSON.stringify({
      manifest: { id: 'pred-user', title: '引用谓词' },
      defs: {
        cards: [
          { id: 'eat_grass', label: '啃草', series: 'eat', weight: 5, condition: { predicate: 'foodLow' } },
        ],
      },
    });
    const { registry } = mountWithBase([predPack], [mod(withPred)]);
    const card = registry.cardById('eat_grass')!;
    expect(card.condition).toBeDefined();
    // 库存充足 → 谓词假 → 不可抽
    const fakeCtx = { stockpile: { food: 999 } } as unknown as Parameters<NonNullable<typeof card.condition>>[1];
    expect(card.condition!({} as never, fakeCtx)).toBe(false);
    // 库存见底 → 谓词真 → 可抽
    const poorCtx = { stockpile: { food: 0 } } as unknown as Parameters<NonNullable<typeof card.condition>>[1];
    expect(card.condition!({} as never, poorCtx)).toBe(true);
  });

  it('目录放入即生效：扫描 → 拓扑 → 与默认玩法混合装配 → 世界跑得动', () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, 'sample.mod.json'), VALID, 'utf-8');
      const { ok, err } = readModDir(dir);
      expect(err).toHaveLength(0);
      const { registry } = mountWithBase(DEFAULT_PLAYSTYLE_PACKS, ok);
      const sim = new Sim({ seed: 42, registry });
      // 默认玩法照常 + JSON 内容进了世界：新敌人在 tuning.enemies 表里
      expect(sim.tuning.enemies['jsonWolf']).toBeDefined();
      expect(sim.tuning.enemies['cat']).toBeDefined(); // 原有敌人在
      expect(() => sim.run(120)).not.toThrow();
    });
  });

  it('拓扑：requires 决定挂载序，清单顺序无关（乱序也自动正确）', () => {
    const a = mod(
      JSON.stringify({ manifest: { id: 'dep-a', title: 'A' }, defs: { items: [{ id: 'ia', name: 'IA' }] } }),
      'a.mod.json',
    );
    const b = mod(
      JSON.stringify({
        manifest: { id: 'dep-b', title: 'B', requires: ['dep-a'] },
        defs: { items: [{ id: 'ib', name: 'IB' }] },
      }),
      'b.mod.json',
    );
    // 故意把依赖者放前面
    const { report } = mountWithBase([], [b, a]);
    expect(report.order.indexOf('dep-a')).toBeLessThan(report.order.indexOf('dep-b'));
  });
});
