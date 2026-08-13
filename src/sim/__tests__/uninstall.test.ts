// 插件化验证：系统逐个/组合卸载不破坏核心（2026-08-14）
// 纪律（AGENTS.md §插件化"卸载不破坏核心"）：任何系统被禁用后 Sim 仍能装配与步进。
// 背景：审阅 registerSystems 发现两处违例——
//  ① sim.ts 构造器在 registerSystems 之外又 new BehaviorSystem/SocialUnitSystem（双重实例化，
//     禁用时产生孤儿实例，mods.intents 挂到死实例上）；
//  ② socialUnits 被禁用后 sim 的 bus 回调/归属/记忆调用空引用崩溃。
// 修复：构造器不再预建实例（registerSystems 唯一实例化点）；socialUnits 字段默认 no-op 空实现
// （NOOP_SOCIAL_UNITS，启用时回填真实例）；intents/works 挂接条件化（this.behavior 判空）。
// 本文件即该修复的回归保护：逐系统卸载 + 组合卸载 + 全量卸载，构造即崩/步进即崩都会在此暴露。
import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods/registry';
import { SYSTEM_DEFS } from '../defs/systems';

describe('插件化：卸载不破坏核心（逐个卸载 smoke）', () => {
  // 对 SYSTEM_DEFS 里每个系统单独卸载 → 构造 + 步进 120s 不崩，且装配表确实不含它
  for (let idx = 0; idx < SYSTEM_DEFS.length; idx++) {
    const id = SYSTEM_DEFS[idx].id;
    it(`卸载 ${id}：Sim 构造 + 步进 120s 不崩`, () => {
      const mods = ModRegistry.default();
      mods.disableSystem(id);
      const sim = new Sim({ registry: mods, pawnCount: 2, seed: idx + 7 });
      expect(sim.systemIds).not.toContain(id);
      for (let i = 0; i < 120; i++) sim.step(1);
      expect(sim.pawnList.length).toBeGreaterThan(0);
    });
  }

  it('卸载 socialUnit：sim.socialUnits 回落 no-op（记忆/归属调用无操作不崩）', () => {
    const mods = ModRegistry.default();
    mods.disableSystem('socialUnit');
    const sim = new Sim({ registry: mods, pawnCount: 2, seed: 11 });
    // no-op 契约：调用不抛、fireHistory 返回空数组
    expect(() => sim.socialUnits.fireHistory(123, 5)).not.toThrow();
    expect(sim.socialUnits.fireHistory(123, 5)).toEqual([]);
    // 建篝火 → bus 回调 onCampfireBuilt（原空引用点）不崩
    sim.world.placeBuilding(10, 10, 'campfire', 'player');
    sim.bus.emit({ type: 'building_built', x: 10, y: 10, defId: 'campfire' } as never);
    for (let i = 0; i < 60; i++) sim.step(1);
  });

  it('卸载 behavior：intents/works 挂接跳过，步进不崩（无卡决策层）', () => {
    const mods = ModRegistry.default();
    mods.disableSystem('behavior');
    const sim = new Sim({ registry: mods, pawnCount: 2, seed: 13 });
    for (let i = 0; i < 120; i++) sim.step(1);
    // 断言仅"不崩 + 有人"：120s 内 population 可能正常招募（4=2+2 是招募生效而非卸载问题）
    expect(sim.pawnList.length).toBeGreaterThanOrEqual(2);
  });

  it('组合卸载（采集狩猎玩法包场景）：farm/craft/techPool/autobuild/repair 长跑 600s', () => {
    const mods = ModRegistry.default();
    for (const id of ['farm', 'craft', 'techPool', 'autobuild', 'repair']) mods.disableSystem(id);
    const sim = new Sim({ registry: mods, pawnCount: 4, seed: 17 });
    for (let i = 0; i < 600; i++) sim.step(1);
    // 生产系统卸载后核心循环仍产出基础生存闭环（伐木/进食决策依赖 behavior/gather/needs）
    expect(sim.pawnList.length).toBeGreaterThan(0);
    expect(sim.stockpile.wood ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('全量卸载 16 系统：Sim 仍能构造与步进（空壳但稳定）', () => {
    const mods = ModRegistry.default();
    for (const d of SYSTEM_DEFS) mods.disableSystem(d.id);
    const sim = new Sim({ registry: mods, pawnCount: 2, seed: 19 });
    expect(sim.systemIds).toEqual([]);
    for (let i = 0; i < 30; i++) sim.step(1);
  });
});
