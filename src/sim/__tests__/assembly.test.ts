// 正向组装验证：最终模拟器 = 内核引擎 + 玩法包叠加（2026-08-14 → 2026-08-15）
// 用户裁决："最终通过 mod/插件一个个添加玩法最终变成最终模拟器"。
// 架构演进：玩法系统（gather/farm/craft/repair/techPool/autobuild）迁出为玩法包；
//   default() 通过 playstyle 聚合包挂载全部 = 完整模拟器。
// 2026-08-14 大系统实验：新增 5 个玩法包（medicine/power/thermo/trade/prison）默认挂载——
// 默认装配 22 系统（内核 10 + 玩法包 12），纯内核仍 10。
// 2026-08-14 cooking 玩法包（篝火烹饪）：默认装配 22 系统（内核 10 + 玩法包 12）。
// 2026-08-14 完全插件化：gather 迁出内核为 gathering 玩法包（内核 11→10，玩法包 11→12，
// 总数 22 不变），默认包清单外置为数据（playstyle.ts），本文件 PACK_IDS 须随清单同步。
// 2026-08-15 内核纯引擎（Stage1）：原 8 个"社会骨架"系统（needs/san/desire/social/build/
// raid/population/events）全部迁出为玩法包——内核只剩 behavior/socialUnit 两个引擎系统，
// 总数 22 不变；**执行序**由 defs/systems.ts BASE_SYSTEM_ORDER 数据清单声明（不再依赖
// before 锚点，锚点目标自己成了包）。
// 2026-08-15 内核纯引擎（Stage B+C+D）：behavior/socialUnit/economy/bootstrap 也迁出为
// 玩法包（能力让渡：provide/getCap），BASE_SYSTEM_ORDER 扩为 24 系统、**无任何内联 ctor**，
// 内核 = 0 系统纯演算框架——"纯引擎可跑"断言从 2 系统降为 0 系统。
// 2026-08-15 clothing 制衣玩法包（用户需求：服装制作/染料/设计=科技抽卡/材质）：
// BASE_SYSTEM_ORDER 扩为 25 系统（clothing 在产出组末尾 cook 后、raid 前）。
// 2026-08-15 RW-1 玩法包（M2 drafting 征召战斗；M1 工作优先级已按用户裁决撤回）：
// drafting 注册系统 id 'drafting'（category 'raid'，清单末位 → raid 组内 raid 后），
// 默认装配 25→26 系统；oracle-guidance（神谕卡式引导）无系统（命令 + 策略卡 + 冷却，
// 不进系统装配面；see docs/RW_SPRINT2.md）。
// 2026-08-15 一致性重构（用户裁决：插件/mod 不要有不一致行为）：行为决策引擎本质是引擎
// 服务，从玩法包迁回内核（SYSTEM_DEFS 内联 ctor = 内核 1 系统）；执行序改为**类别语义序
// （CATEGORY_ORDER）× 组内注册序推导**（sim.registerSystems），默认装配执行序与旧表
// 逐位一致（下方 EXPECTED_ORDER 显式期望即文档）。本文件 PACK_IDS 去掉 behavior（归内核）。
// 本文件验证：① 默认装配 = 引擎+玩法包，执行序稳定；② 玩法包可独立加减；
//             ③ 玩法包系统注册来源是 mod 装配面而非内核表。
import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods/registry';
import { SYSTEM_DEFS, KERNEL_SYSTEM_IDS } from '../defs/systems';
import { DEFAULT_PLAYSTYLE_PACKS } from '../../mods/packs/playstyle';

// 内核（引擎）系统 id：2026-08-15 一致性重构 = 1 个（behavior 决策引擎 = 引擎服务归内核）
const KERNEL_IDS = KERNEL_SYSTEM_IDS;
// 玩法包系统 id 全集（默认清单 DEFAULT_PLAYSTYLE_PACKS 里各包注册的系统）：
// 改装配面时此处须与 playstyle.ts 清单同步（防清单改动后断言失真）
const PACK_IDS = ['needs', 'san', 'desire', 'economy', 'socialUnit', 'social', 'gather', 'build', 'farm', 'craft', 'repair', 'medicine', 'power', 'thermo', 'trade', 'prison', 'cook', 'clothing', 'raid', 'drafting', 'population', 'events', 'techPool', 'autobuild', 'bootstrap'];

// 期望执行序（2026-08-15 起由类别序 × 组内注册序推导；本数组 = 推导结果快照 = 测试文档）：
// needs(数值修正) → ai(behavior 决策引擎) → society(socialUnit/social) → production
// (产出 12 系统，clothing 组内末位 = 清单末位) → raid → world(population/events/techPool/
// autobuild——清单序调整后与旧 BASE_SYSTEM_ORDER 一致) → boot(bootstrap 恒表尾)
const EXPECTED_ORDER = ['needs', 'san', 'desire', 'economy', 'behavior', 'socialUnit', 'social', 'gather', 'build', 'farm', 'craft', 'repair', 'medicine', 'power', 'thermo', 'trade', 'prison', 'cook', 'clothing', 'raid', 'drafting', 'population', 'events', 'techPool', 'autobuild', 'bootstrap'];

function systemOrder(seed = 3): string[] {
  return [...new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed }).systemIds];
}

describe('插件化：正向组装（内核引擎 + 玩法包 = 最终模拟器）', () => {
  it('内核 = 1 系统（behavior 决策引擎 = 引擎服务归内核），玩法全在包', () => {
    expect(KERNEL_IDS).toEqual(['behavior']);
    for (const p of PACK_IDS) expect(KERNEL_IDS).not.toContain(p);
    // 决策引擎归内核（用户 2026-08-15 裁决修复"0 系统过纯"）；派系/经济/引导仍是玩法包
    expect(KERNEL_IDS).not.toContain('socialUnit');
    expect(KERNEL_IDS).not.toContain('economy');
    expect(KERNEL_IDS).not.toContain('bootstrap');
  });

  it('默认装配 = 26 系统（RW-1 drafting 征召 2026-08-15 加入），且执行序 = 类别推导序（EXPECTED_ORDER 快照）', () => {
    const order = systemOrder();
    expect(order).toHaveLength(26);
    // 产出位序：farm→craft→repair→medicine→power→thermo→trade→prison→cook→clothing 必须位于 raid 前
    const raidIdx = order.indexOf('raid');
    expect(order.indexOf('farm')).toBeLessThan(raidIdx);
    expect(order.indexOf('craft')).toBeLessThan(raidIdx);
    expect(order.indexOf('repair')).toBeLessThan(raidIdx);
    expect(order.indexOf('farm')).toBeLessThan(order.indexOf('craft'));
    expect(order.indexOf('craft')).toBeLessThan(order.indexOf('repair'));
    // 大系统包结算在敌袭前（濒死敌人先被 prison 俘获、伤口在伤害后评估）
    for (const p of ['medicine', 'power', 'thermo', 'trade', 'prison', 'cook', 'clothing']) {
      expect(order.indexOf(p)).toBeLessThan(raidIdx);
    }
    // 征召驱动系统与 raid 同期（category 'raid'，清单末位 → 组内 raid 之后）
    expect(order.indexOf('drafting')).toBeGreaterThan(raidIdx);
    // 科技/扩张在敌袭/补员后（world 类别：population/events/techPool/autobuild）
    expect(order.indexOf('techPool')).toBeGreaterThan(raidIdx);
    expect(order.indexOf('autobuild')).toBeGreaterThan(raidIdx);
    // 经济评估在行为决策前（派系优先级当帧生效）、引导在表尾（出生刷人在系统 init 后）
    expect(order.indexOf('economy')).toBeLessThan(order.indexOf('behavior'));
    expect(order.indexOf('bootstrap')).toBe(order.length - 1);
    // 执行序 = 类别推导结果快照（推导规则见 sim.registerSystems；本断言防推导规则回归）
    expect(order).toEqual(EXPECTED_ORDER);
  });

  it('玩法包可独立加减：只挂生产包（farm/craft/repair）→ 无科技无扩张无大系统', () => {
    const mods = ModRegistry.default();
    mods.disableSystem('techPool');
    mods.disableSystem('autobuild');
    for (const p of ['medicine', 'power', 'thermo', 'trade', 'prison']) mods.disableSystem(p);
    const sim = new Sim({ registry: mods, pawnCount: 2, seed: 5 });
    expect(sim.systemIds).not.toContain('techPool');
    expect(sim.systemIds).not.toContain('autobuild');
    expect(sim.systemIds).not.toContain('medicine');
    expect(sim.systemIds).not.toContain('power');
    expect(sim.systemIds).not.toContain('thermo');
    expect(sim.systemIds).not.toContain('trade');
    expect(sim.systemIds).not.toContain('prison');
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
    // behavior 是内核系统（表内联 ctor），不在 mod 装配面
    expect(packIds).not.toContain('behavior');
  });

  it('纯引擎模拟器（卸掉全部玩法包）→ 内核 1 系统（behavior 决策引擎）可装配可步进', () => {
    const mods = ModRegistry.default();
    for (const p of PACK_IDS) mods.disableSystem(p); // 卸掉全部玩法包 = 纯引擎
    const sim = new Sim({ registry: mods, pawnCount: 2, seed: 7 });
    expect(sim.systemIds).toEqual(['behavior']);
    // "卸载不破坏核心"契约：装配 + 步进不崩（纯引擎无需求/采集 = 无生存闭环，只断言能跑不崩
    // ——生存玩法由默认清单的玩法包提供）
    for (let i = 0; i < 30; i++) sim.step(1);
  });
});