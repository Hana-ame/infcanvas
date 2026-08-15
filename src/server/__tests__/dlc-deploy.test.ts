// DLC 自动部署集成测试（2026-08-16 用户「这些 dlc 可以随便写一点什么。然后你再看一下怎么部署，
// 应该有自动的」）——部署机制 = 服务端 `loadModsFromDir(MODS_DIR='mods', registry)`（server/index.ts
// 启动时自动扫描 mods/*.mod.json → parseModPackage + buildModMount 挂载，MODS_DIR 可用环境变量
// 覆盖）：**把 .mod.json 放进 mods/ 目录即完成部署**。本测试对真实 mods/ 目录做全量加载验证：
// 8 个 dlc-*.mod.json 自动挂载、内容（物品/建筑/科技/策略卡/敌人/事件）注册、Sim 装配步进不崩。
// 注：纯 defs 声明不注册系统/命令（defs 白名单只有内容表；系统/命令需 scripts 函数式扩展，
//   见 demo-berry），因此声明式 DLC 不改系统装配——默认 26 系统保持不变。
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ModRegistry } from '../../sim/mods/registry';
import { Sim } from '../../sim/sim';
import { loadModsFromDir } from '../modManager';

const MODS_DIR = join(process.cwd(), 'mods');
// 8 个 DLC 占位包（与 src/mods/__tests__/dlc-framework-stress.test.ts 的框架压力面互补：
// 那边验"TS 内联包装配面"，这里验"真实 .mod.json 自动部署面"）
const DLC_IDS = ['dlc-2077', 'dlc-age-of-sail', 'dlc-empire', 'dlc-radio', 'dlc-sky-magic', 'dlc-theocracy', 'dlc-ww1', 'dlc-ww2'];

describe('DLC 自动部署（mods/ 目录扫描）', () => {
  it('8 个 DLC .mod.json 全量自动挂载：内容注册 + 装配步进不崩', () => {
    const reg = ModRegistry.default();
    const r = loadModsFromDir(MODS_DIR, reg);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    for (const id of DLC_IDS) expect(r.mods).toContain(id);

    // 2077 内容（用户点名：斯安威斯坦义体 / 义体医生诊所）
    expect(reg.items['dlc:sandevistan']?.name).toContain('斯安威斯坦');
    expect(reg.buildings['dlc:ripperdoc']).toBeDefined();
    expect(reg.enemies['dlc:dron']).toBeDefined();

    // 抽查其余 DLC 内容：飞天魔法扫帚 / 帝国皇宫 / 教国圣战令策略卡 / 无线电事件
    expect(reg.items['dlc:broom']).toBeDefined();
    expect(reg.buildings['dlc:palace']).toBeDefined();
    expect(reg.strategyCards.some((c) => c.id === 'dlc:crusade')).toBe(true);
    expect(reg.strategyCards.some((c) => c.id === 'dlc:chrome-up')).toBe(true);

    // 全量 mods/ 装配 = 26 默认 + demo-berry(berrySpoil) + 2077(dlc:cyber) = 28;
    // 其余 7 个 DLC 纯 defs 零系统——活的分界演示:内容声明不改装配,系统/命令必须 scripts
    const sim = new Sim({ seed: 8, pawnCount: 2, registry: reg });
    expect(sim.systemIds).toHaveLength(28);
    expect(sim.systemIds).toContain('dlc:cyber'); // 2077 scripts 系统(before:craft 锚点进 production 组)
    for (const absent of ['dlc:sail', 'dlc:ww1', 'dlc:radio', 'dlc:ww2', 'dlc:sky', 'dlc:empire', 'dlc:church']) {
      expect(sim.systemIds).not.toContain(absent); // 纯 defs DLC 零系统
    }
    for (let i = 0; i < 120; i++) sim.step(1); // 全量 DLC 内容 + 默认装配步进不崩

    // 2077 scripts 命令:装义体 → 事件 + pawn.extra.cyber 随档扩展点
    const eid = sim.pawns[0];
    sim.issueCommand({ type: 'dlc:install-cyber', x: 0, y: 0, pawnId: eid });
    expect(sim.events.some((e) => e.text.includes('斯安威斯坦'))).toBe(true);
    expect(sim.pawnStates.get(eid)?.extra?.cyber).toBe('dlc:sandevistan');
  });
});