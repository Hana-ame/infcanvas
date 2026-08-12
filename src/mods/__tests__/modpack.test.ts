// mod 打包/沙箱（loader.ts）测试
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sim } from '../../sim/sim';
import { DESIRES } from '../../sim/core/desires';
import {
  parseModPackage, buildModMount, mountModPackage, packModPackage, CORE_VERSION,
} from '../loader';

const pkgJson = readFileSync(join(process.cwd(), 'src/mods/packages/demo-berry.mod.json'), 'utf-8');
const pkg = parseModPackage(pkgJson);

describe('mod 包解析与校验（loader）', () => {
  it('解析合法包：manifest + defs + scripts', () => {
    expect(pkg.manifest.id).toBe('demo-berry');
    expect(pkg.manifest.name).toBe('浆果玩法');
    expect(pkg.manifest.requires?.coreVersion).toBe(CORE_VERSION);
    expect(pkg.defs?.tiles?.[0] as object).toMatchObject({ id: 'berryBush' });
    expect(pkg.defs?.cards?.[0] as object).toMatchObject({ id: 'berryFeast' });
    expect(pkg.scripts).toContain('registerPredicate');
  });

  it('非法 JSON / 缺 manifest / 非法 id / 版本不匹配 → 抛清晰错误', () => {
    expect(() => parseModPackage('not json')).toThrow('合法 JSON');
    expect(() => parseModPackage('{"name":"x"}')).toThrow('manifest');
    expect(() => parseModPackage('{"manifest":{"id":"bad id!","name":"x","version":"1"}}')).toThrow('manifest.id');
    expect(() => parseModPackage('{"manifest":{"id":"x","name":"x","version":"1","requires":{"coreVersion":"99.0.0"}}}')).toThrow('coreVersion 99.0.0');
  });

  it('defs 未知字段 / 卡含函数字段 / scripts 含 import → 拒绝', () => {
    const base = { manifest: { id: 'bad', name: '坏包', version: '1' } };
    expect(() => parseModPackage(JSON.stringify({ ...base, defs: { hack: [] } }))).toThrow('未知字段');
    expect(() => parseModPackage(JSON.stringify({ ...base, defs: { cards: [{ id: 'c', condition: 'x' }] } }))).toThrow('函数字段');
    expect(() => parseModPackage(JSON.stringify({ ...base, scripts: 'import x from "y"' }))).toThrow('不允许 import/require');
  });

  it('pack 往返：parse(pack(pkg)) 内容等价', () => {
    const back = parseModPackage(packModPackage(pkg));
    expect(back.manifest).toEqual(pkg.manifest);
    expect(back.defs).toEqual(pkg.defs);
    expect(back.scripts).toEqual(pkg.scripts);
  });
});

describe('mod 包挂载（defs 翻译 + scripts 沙箱）', () => {
  it('defs 纯 JSON 声明 → registry 注册（与源码 mod 等效）', () => {
    const sim = new Sim({ seed: 9, pawnCount: 2, mods: buildModMount(pkg) });
    expect(sim.mods.cards.get('berryFeast')).toBeDefined();
    expect(sim.mods.tilesMap.get('berryBush')).toBeDefined();
    expect(sim.mods.buildingsMap.get('berryStand')).toBeDefined();
    // 谓词：浆果 <5 不可抽；≥5 可抽
    const card = sim.mods.cards.get('berryFeast')!;
    const ctx = { eid: sim.pawns[0], view: sim } as never;
    sim.stockpile.berry = 3;
    expect(card.condition!(ctx)).toBe(false);
    sim.stockpile.berry = 5;
    expect(card.condition!(ctx)).toBe(true);
    // 系统按锚点插入：berrySpoil 在 autobuild 之前
    const ids = [...sim.systemIds];
    expect(ids.indexOf('berrySpoil')).toBeGreaterThan(-1);
    expect(ids.indexOf('berrySpoil')).toBeLessThan(ids.indexOf('autobuild'));
    // 变质系统：60s 后库存减半
    sim.stockpile.berry = 100;
    sim.step(60);
    expect(sim.stockpile.berry).toBe(50);
  });

  it('scripts 沙箱：可写全局残留/抛错被隔离，挂载失败不拖垮 sim', () => {
    const mk = (scripts: string) => parseModPackage(JSON.stringify({
      manifest: { id: 'badscript', name: '坏脚本', version: '1' },
      scripts,
    }));
    // 语法错误 → 编译失败（parse 阶段脚本只当字符串，编译在挂载）
    const simA = new Sim({ seed: 1, pawnCount: 1 });
    const res = mountModPackage(mk('const = 1;'), simA.mods);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('编译失败');
    // 运行期抛错 → 挂载失败但主 sim 不受影响（还能正常跑）
    const simB = new Sim({ seed: 2, pawnCount: 1 });
    const res2 = mountModPackage(mk('m.registerDesire("hack", "黑客"); throw new Error("boom")'), simB.mods);
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.error).toContain('执行失败');
    // 半挂载副作用仍生效（desire 已注册）——文档化行为：defs 先、scripts 后
    expect(DESIRES.hack.label).toBe('黑客');
    simB.step(1); // 主 sim 正常推进
  });

  it('scripts 能调用注入的 m/console（无 import 的纯函数式扩展）', () => {
    const sim = new Sim({
      seed: 5,
      pawnCount: 1,
      mods: buildModMount(parseModPackage(JSON.stringify({
        manifest: { id: 'consoletest', name: 'console 测试', version: '1' },
        scripts: 'm.registerDesire("curiosity", "好奇"); console.log("mod ok")',
      }))),
    });
    expect(sim.dnaOf(sim.pawns[0])).toBeDefined(); // sim 正常构造（脚本副作用注册成功）
  });
});

describe('mountModPackage 与 Sim 的集成路径', () => {
  it('重复挂载幂等：同包挂多个 Sim 不冲突（静态共享键保持首次定义）', () => {
    for (let i = 0; i < 3; i++) {
      const sim = new Sim({ seed: 40 + i, pawnCount: 1, mods: buildModMount(pkg) });
      expect(sim.mods.cards.get('berryFeast')).toBeDefined();
      sim.step(5);
    }

  });

  it('事后挂载（服务端运行时加 mod）：卡进表 + sim 照常跑', () => {
    const sim = new Sim({ seed: 3, pawnCount: 1 });
    const r = mountModPackage(pkg, sim.mods);
    expect(r.ok).toBe(true);
    expect(sim.mods.cards.get('berryFeast')).toBeDefined();
    expect(sim.mods.tilesMap.get('berryBush')).toBeDefined();
    sim.step(10); // 不崩
  });
});
