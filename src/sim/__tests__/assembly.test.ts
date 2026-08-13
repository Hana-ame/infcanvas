// 正向组装验证：最终模拟器 = 内核 + 玩法包叠加（2026-08-14）
// 用户裁决："最终通过 mod/插件一个个添加玩法最终变成最终模拟器"。
// 架构：SYSTEM_DEFS 内核只剩 11 基础系统；玩法系统（farm/craft/repair/techPool/autobuild）
// 迁出为独立玩法包（src/mods/packs/），ModRegistry.default() 挂载全部 = 完整模拟器。
// 本文件验证：① 默认装配 = 内核+玩法包 = 原 16 系统且顺序不变；
//             ② 玩法包可独立加减（只加生产不加科技等）；
//             ③ 玩法包系统注册来源是 mod 装配面而非内核表。
import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods/registry';
import { SYSTEM_DEFS } from '../defs/systems';

const KERNEL_IDS = SYSTEM_DEFS.map((d) => d.id);
const PACK_IDS = ['farm', 'craft', 'repair', 'techPool', 'autobuild'];

function systemOrder(seed = 3): string[] {
  return [...new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed }).systemIds];
}

describe('插件化：正向组装（内核 + 玩法包 = 最终模拟器）', () => {
  it('内核只有基础系统（11 个，不含玩法系统）', () => {
    expect(KERNEL_IDS).toHaveLength(11);
    for (const p of PACK_IDS) expect(KERNEL_IDS).not.toContain(p);
    // 内核 = 需求/决策/社交/采集/建造/敌袭/人口/事件（纪律"不往内核塞玩法"）
    expect(KERNEL_IDS).toContain('needs');
    expect(KERNEL_IDS).toContain('behavior');
    expect(KERNEL_IDS).toContain('gather');
    expect(KERNEL_IDS).toContain('build');
  });

  it('默认装配 = 内核 11 + 玩法包 5 = 16 系统，且执行序与原 16 系统表一致', () => {
    const order = systemOrder();
    expect(order).toHaveLength(16);
    // 产出位序：farm→craft→repair 必须位于 raid 前且按此序（同锚点保序）
    const raidIdx = order.indexOf('raid');
    expect(order.indexOf('farm')).toBeLessThan(raidIdx);
    expect(order.indexOf('craft')).toBeLessThan(raidIdx);
    expect(order.indexOf('repair')).toBeLessThan(raidIdx);
    expect(order.indexOf('farm')).toBeLessThan(order.indexOf('craft'));
    expect(order.indexOf('craft')).toBeLessThan(order.indexOf('repair'));
    // 科技/扩张在敌袭/补员后（原表序末尾）
    expect(order.indexOf('techPool')).toBeGreaterThan(raidIdx);
    expect(order.indexOf('autobuild')).toBeGreaterThan(raidIdx);
  });

  it('玩法包可独立加减：只挂生产包（farm/craft/repair）→ 无科技无自主扩张', () => {
    const mods = ModRegistry.default();
    mods.disableSystem('techPool');
    mods.disableSystem('autobuild');
    const sim = new Sim({ registry: mods, pawnCount: 2, seed: 5 });
    expect(sim.systemIds).not.toContain('techPool');
    expect(sim.systemIds).not.toContain('autobuild');
    expect(sim.systemIds).toContain('farm');
    expect(sim.systemIds).toContain('craft');
    expect(sim.systemIds).toContain('repair');
    for (let i = 0; i < 120; i++) sim.step(1); // 无科技无扩张仍稳定运转
    expect(sim.pawnList.length).toBeGreaterThan(0);
  });

  it('玩法包来源：注册进 systemDefs（mod 装配面），非内核表', () => {
    const mods = ModRegistry.default();
    const packIds = mods.systemDefs.map((d) => d.id);
    for (const p of PACK_IDS) expect(packIds).toContain(p);
  });

  it('纯内核模拟器（不挂任何玩法包）→ 11 系统可运行', () => {
    const mods = ModRegistry.default();
    for (const p of PACK_IDS) mods.disableSystem(p); // 卸掉全部玩法包 = 纯内核
    const sim = new Sim({ registry: mods, pawnCount: 2, seed: 7 });
    expect(sim.systemIds).toHaveLength(11);
    for (let i = 0; i < 60; i++) sim.step(1);
    expect(sim.pawnList.length).toBeGreaterThan(0);
  });
});
