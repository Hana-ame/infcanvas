/**
 * assembly.test.ts —— 插件化装配：默认装配清单 / 执行序 / 卸载安全 / 拓扑 / 防御性报错。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry, topoSort, type ModPack } from '../mods';
import { needsPack } from '../mods/packs/needs';
import { gatheringPack } from '../mods/packs/gathering';
import { buildingPack } from '../mods/packs/building';
import { socialPack } from '../mods/packs/social';
import { raidPack } from '../mods/packs/raid';
import { bootstrapPack } from '../mods/packs/bootstrap';

describe('插件装配', () => {
  it('默认装配 = 内核 behavior + 6 玩法系统，类别序正确', () => {
    const s = new Sim({ seed: 1, registry: ModRegistry.default() });
    const ids = s.systems.map((x) => x.id);
    expect(ids).toContain('behavior'); // 内核决策引擎
    for (const id of ['needs', 'raid', 'bootstrap']) expect(ids).toContain(id);
    // 类别序：needs 先于 ai(behavior) 先于 raid 先于 boot(bootstrap)
    const rank = (id: string) => s.systems.findIndex((x) => x.id === id);
    expect(rank('needs')).toBeLessThan(rank('behavior'));
    expect(rank('behavior')).toBeLessThan(rank('raid'));
    expect(rank('raid')).toBeLessThan(rank('bootstrap')); // bootstrap 恒表尾
  });

  it('出生引导：默认局开局即有鼠有火（bootstrap 在 init 落地）', () => {
    const s = new Sim({ seed: 1, registry: ModRegistry.default() });
    expect([...s.pawns()].length).toBe(s.tuning.bootstrap.pawnCount);
    expect([...s.world.buildings.values()].some((b) => b.defId === 'campfire')).toBe(true);
  });

  it('拓扑排序：清单乱序自动拉齐（requires 是唯一事实）', () => {
    // 故意把 bootstrap 放最前、building 放最后——拓扑必须纠正
    const shuffled: ModPack[] = [bootstrapPack, raidPack, socialPack, needsPack, gatheringPack, buildingPack];
    const order = topoSort(shuffled).map((p) => p.id);
    expect(order.indexOf('building')).toBeLessThan(order.indexOf('bootstrap'));
  });

  it('缺依赖 / 成环 / 重复 id → 挂载期响亮报错（静默半挂载是事故源头）', () => {
    const orphan: ModPack = { id: 'orphan', requires: ['不存在'], apply: () => {} };
    expect(() => topoSort([orphan])).toThrow(/不在挂载清单/);
    const a: ModPack = { id: 'a', requires: ['b'], apply: () => {} };
    const b: ModPack = { id: 'b', requires: ['a'], apply: () => {} };
    expect(() => topoSort([a, b])).toThrow(/成环/);
    const reg = new ModRegistry();
    const dup: ModPack = { id: 'dup', requires: [], apply: (m) => m.registerCard({ id: 'c1', label: '', series: 'wander', weight: 1, action: () => {} }) };
    const dup2: ModPack = { id: 'dup2', requires: [], apply: (m) => m.registerCard({ id: 'c1', label: '', series: 'wander', weight: 1, action: () => {} }) };
    reg.mountPack(dup);
    expect(() => reg.mountPack(dup2)).toThrow(/已存在/);
  });

  it('卸载敌袭包：无猫无战卡，营地照常生活（卸载不破坏核心）', () => {
    const withoutRaid: ModPack[] = [needsPack, gatheringPack, buildingPack, socialPack, bootstrapPack];
    const s = new Sim({ seed: 42, registry: ModRegistry.mountPacks(withoutRaid) });
    expect(s.systems.some((x) => x.id === 'raid')).toBe(false);
    expect(s.cards().some((c) => c.series === 'fight' || c.series === 'flee')).toBe(false);
    expect(() => s.run(300)).not.toThrow();
    expect([...s.pawns()].length).toBeGreaterThan(0); // 生活继续
    // move 是引擎内建——卸载包后没有任何玩法注册的命令残留
    expect(ModRegistry.mountPacks(withoutRaid).commands.size).toBe(0);
  });

  it('disableSystem(behavior)：无人行动但引擎可跑（纯演算模式）', () => {
    const reg = ModRegistry.default();
    reg.disableSystem('behavior');
    const s = new Sim({ seed: 7, registry: reg });
    const p0uses = JSON.stringify([...s.pawns()].map((p) => p.uses));
    expect(() => s.run(50)).not.toThrow();
    expect(JSON.stringify([...s.pawns()].map((p) => p.uses))).toBe(p0uses); // 没抽过卡
  });

  it('纯内核零玩法包：Sim 可装配可步进（内核不含任何玩法内容）', () => {
    const reg = ModRegistry.mountPacks([]);
    const s = new Sim({ seed: 3, registry: reg, pawnCount: 4 });
    expect(s.systems.map((x) => x.id)).toEqual(['behavior']); // 只有决策引擎
    expect(s.cards()).toHaveLength(0); // 无卡可抽 → 全员兜底发呆，但世界在走
    expect(() => s.run(20)).not.toThrow();
  });

  it('DLC 式独立包：mountPacks 追加注册面内容且不影响默认装配', () => {
    const dlc: ModPack = {
      id: 'dlc-toy',
      requires: [], // DLC = 独立包
      apply(m) {
        m.registerItem({ id: 'toy_gizmo', name: '小玩意' });
        // 删除 oracle 包后 registerCommand 面无默认使用者——用玩具 DLC 补回归覆盖
        m.registerCommand('toy_ping', (ctx) => ctx.log('pong'));
        m.registerEnemy({ id: 'toy_duck', name: '橡皮鸭', hp: 5, dmg: 0, speed: 1, atkCd: 99 });
        m.registerCard({
          id: 'play_toy',
          label: '玩玩具',
          series: 'wander',
          weight: 2,
          action: (p, ctx) => ctx.log(`${p.name} 玩了一会儿小玩意`),
        });
      },
    };
    const reg = ModRegistry.mountPacks([...[needsPack, gatheringPack, buildingPack, socialPack, raidPack, bootstrapPack], dlc]);
    expect(reg.items.some((i) => i.id === 'toy_gizmo')).toBe(true);
    expect(reg.commands.has('toy_ping')).toBe(true); // 注册面：命令可挂载
    expect(reg.cardById('play_toy')).toBeDefined();
    const s = new Sim({ seed: 9, registry: reg });
    expect(() => s.run(30)).not.toThrow(); // 新敌人/新卡进入世界不炸
  });
});
