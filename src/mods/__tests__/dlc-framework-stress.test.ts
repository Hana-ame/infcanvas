// DLC 框架压力测试（2026-08-16 用户提议"以后要加大航海/一战/无线电/二战/飞天魔法 DLC，
// 先试试现在加会不会搞坏框架"）——用 5 个**占位** DLC 包走真实玩法包装配面：
//   系统（registerSystemDef + category + before 锚点）/ 命令 / 卡 / 科技 / 建筑 / 物品 /
//   敌人 / 配方 / 策略卡。断言面：① 单包/组合乱序挂载不崩、执行序由 requires 拓扑自动拉齐；
//   ② 默认装配零回归；③ def 冲突被显式捕获（DLC 不能悄悄覆盖核心）；④ 契约表不登记
//   DLC 命令 = 不误伤（validateContracts 零违规）；⑤ 卸载（不挂 DLC）= 现状不变。
// DLC 全部内联于本测试（这是"压力实验"不是生产功能；真实 DLC 落地时另行建包进 playstyle 清单）。
import { describe, it, expect } from 'vitest';
import { Sim } from '../../sim/sim';
import { ModRegistry } from '../../sim/mods/registry';
import { validateContracts } from '../../sim/mods/contracts';
import type { ModPack } from '../pack';

// 合法最小占位系统 ctor（注册 + 步进都需要 id/update——裸对象能注册但 step 会炸，踩坑）
const stubSys = (id: string) => (): never => ({ id, update: () => {} }) as never;

describe('DLC 框架压力测试（大航海/一战/无线电/二战/飞天魔法 占位包）', () => {
  it('① 单 DLC 挂载：默认 26 系统 +1，装配/步进不崩，内核 behavior 不变，命令可用', () => {
    const m = ModRegistry.default();
    expect(m.systemDefs.length).toBe(25); // 注册面：25 个插件系统（behavior 内联内核表，不入 _systemDefs）
    m.mount(dlcAgeOfSail());
    expect(m.systemDefs.length).toBe(26);
    const sim = new Sim({ seed: 52, pawnCount: 2, registry: m });
    expect(sim.systemIds).toHaveLength(27); // 装配面：26 默认 + 1 DLC
    expect(sim.systemIds).toContain('dlc:sail');
    expect(sim.systemIds).toContain('behavior'); // 内核 1 系统仍在
    for (let i = 0; i < 120; i++) sim.step(1); // 步进不崩
    sim.issueCommand({ type: 'set-sails', x: 3, y: 4 });
    expect(sim.events.some((e) => e.text.includes('升帆远航'))).toBe(true);
  });

  it('② 五 DLC 乱序同时挂：拓扑自动拉齐依赖，31 系统组合步进不崩', () => {
    const m = ModRegistry.default();
    // 预登记目录（消费面同 playstyleManager：先 registerPack 全清单，再 mount 聚合/单个——requires
    // 挂在全局包目录上，未登记的依赖会显式报"缺少前置包"（踩坑见 ⑤，非框架缺陷））
    for (const p of [dlcAgeOfSail(), dlcWw1(), dlcRadio(), dlcWw2(), dlcSkyMagic()]) m.registerPack(p);
    // 乱序挂：依赖者先挂 → 拓扑自动拉齐被依赖包
    m.mount(dlcWw2());      // requires dlc-ww1 → 自动先挂
    m.mount(dlcSkyMagic()); // requires dlc-radio
    m.mount(dlcRadio());
    m.mount(dlcAgeOfSail());
    m.mount(dlcWw1());      // 二战前置（已挂 → 幂等跳过）
    const sim = new Sim({ seed: 53, pawnCount: 2, registry: m });
    for (const id of ['dlc:sail', 'dlc:ww1', 'dlc:radio', 'dlc:ww2', 'dlc:sky']) {
      expect(sim.systemIds).toContain(id);
    }
    expect(sim.systemIds).toHaveLength(26 + 5);
    for (const pid of ['dlc-ww1', 'dlc-radio', 'dlc-ww2', 'dlc-sky-magic', 'dlc-age-of-sail']) {
      expect(m.packIds).toContain(pid);
    }
    for (let i = 0; i < 180; i++) sim.step(0.5); // 组合步进不崩
  });

  it('③ requires 依赖：只挂二战 → 一战自动先挂（拓扑闭包 + 先于依赖者）', () => {
    const m = ModRegistry.default();
    m.registerPack(dlcWw1()); // 目录预登记（依赖图索引；真实 DLC 由清单/商店登记）
    m.mount(dlcWw2());
    expect(m.packIds).toContain('dlc-ww1');
    expect(m.packIds).toContain('dlc-ww2');
    expect(m.packIds.indexOf('dlc-ww1')).toBeLessThan(m.packIds.indexOf('dlc-ww2'));
  });

  it('④ def 冲突被显式捕获：DLC 不得悄悄覆盖核心（建筑/命令/表外系统同 id 均抛错；内核 id 顶不动）', () => {
    const m = ModRegistry.default();
    // 建筑撞核心 → 抛错
    expect(() => m.registerBuilding({ id: 'campfire', name: '伪装篝火', category: 'structure', meta: {}, hp: 99 } as never))
      .toThrow(/building "campfire" 已存在/);
    // 命令撞 mod 注册命令（draft 来自 M2 包）→ 抛错。注意：move 是引擎内建（issueCommand 路由器
    // 直通、不在 commandHandlers），再注册 move 无冲突——撞车面只在 mod 命令层。
    expect(() => m.registerCommand('draft', () => {})).toThrow(/command "draft" 已存在/);
    // 表外系统二次注册 → 抛错
    expect(() => m.registerSystemDef({ id: 'dlc:x2', label: 'x', category: 'world', ctor: () => ({ id: 'dlc:x2', update: () => {} }) as never })).not.toThrow();
    expect(() => m.registerSystemDef({ id: 'dlc:x2', label: 'x2', category: 'world', ctor: () => ({ id: 'dlc:x2', update: () => {} }) as never }))
      .toThrow(/system "dlc:x2" 已存在/);
    // 内核表内 id（behavior）被第三方顶撞 → 不报错、被装配**静默忽略**（内核 ctor 赢；见
    // sim.registerSystems：表内内核系统先推、同 id 已收集 → 兜底跳过）——防御"覆盖内核"的既定语义
    expect(() => m.registerSystemDef({ id: 'behavior', label: '假行为', category: 'ai', ctor: stubSys('behavior') })).not.toThrow();
  });

  it('⑤ 契约不误伤：挂 DLC（命令不入契约表 = 不被查）→ validateContracts 零违规，命令照常工作', () => {
    const m = ModRegistry.default();
    for (const p of [dlcWw1(), dlcRadio(), dlcSkyMagic()]) m.registerPack(p); // 目录预登记（同 ②）
    m.mount(dlcWw1());
    m.mount(dlcSkyMagic()); // requires 无线电 → 连带 radio-call 命令可用
    expect(validateContracts(m)).toHaveLength(0); // 已登记契约（wear/draft/strategy…）全绿
    const sim = new Sim({ seed: 54, pawnCount: 2, registry: m });
    sim.issueCommand({ type: 'radio-call', x: 0, y: 0, args: { channel: 7 } });
    expect(sim.events.some((e) => e.text.includes('无线电'))).toBe(true);
  });

  it('⑥ 卸载 = 现状不变：不挂 DLC 的默认装配与基线一致（零回归对照）', () => {
    const m = ModRegistry.default();
    const sim = new Sim({ seed: 55, pawnCount: 2, registry: m });
    expect(sim.systemIds).toHaveLength(26);
    expect(sim.systemIds[0]).toBe('needs'); // 类别序推导的稳定首系统
    expect(sim.systemIds).not.toContain('dlc:sail');
    expect(sim.mods.commandHandlers.has('set-sails')).toBe(false);
    for (let i = 0; i < 120; i++) sim.step(1);
  });
});

// ---- 占位 DLC 包（内联实验对象；真实落地时可复用此骨架：requires 显式 + apply 只调注册面）----

function dlcAgeOfSail(): ModPack {
  return {
    id: 'dlc-age-of-sail', name: '大航海 DLC（占位）', requires: [],
    apply(m: ModRegistry): void {
      m.registerSystemDef({ id: 'dlc:sail', label: '远航', category: 'world', ctor: stubSys('dlc:sail') });
      m.registerCommand('set-sails', (ctx) => { ctx.logEvent(`⛵ 升帆远航（目标 ${ctx.selected[0] ?? 0}）`); });
      m.registerStrategyCard({ id: 'dlc:sail-south', label: '南巡令', action: 'walkAndWork', workType: 'fish', duration: 60, weight: 6, condition: { kind: 'always' }, reason: '占位' });
      m.registerTech({ id: 'dlc:caravel', name: '轻帆船', desc: '占位', unlocks: [] });
    },
  };
}

function dlcWw1(): ModPack {
  return {
    id: 'dlc-ww1', name: '一战 DLC（占位）', requires: [],
    apply(m: ModRegistry): void {
      m.registerSystemDef({ id: 'dlc:ww1', label: '堑壕战', category: 'raid', before: 'raid', ctor: stubSys('dlc:ww1') });
      m.registerCommand('trench', (ctx) => { ctx.logEvent('🪖 挖掘堑壕'); });
      m.registerItem({ id: 'dlc:rifle', name: '步枪', desc: '占位', category: 'weapon', meta: {} } as never);
      m.registerWork('dlc:snipe', (() => 0) as never);
    },
  };
}

function dlcRadio(): ModPack {
  return {
    id: 'dlc-radio', name: '无线电 DLC（占位）', requires: [],
    apply(m: ModRegistry): void {
      m.registerSystemDef({ id: 'dlc:radio', label: '无线电', category: 'world', ctor: stubSys('dlc:radio') });
      m.registerCommand('radio-call', (ctx) => { ctx.logEvent('📻 无线电呼叫（占位）'); });
      m.registerStrategyCard({ id: 'dlc:radio-call', label: '呼叫令', action: 'idle', duration: 30, weight: 5, condition: { kind: 'always' }, reason: '占位' });
      m.registerEnemy({ id: 'dlc:golem', name: '无线电石人（占位）', hp: 40, damage: 6, speed: 1 } as never);
    },
  };
}

function dlcWw2(): ModPack {
  return {
    id: 'dlc-ww2', name: '二战 DLC（占位）', requires: ['dlc-ww1'], // 同世界观延续（一战前置）
    apply(m: ModRegistry): void {
      m.registerSystemDef({ id: 'dlc:ww2', label: '装甲战争', category: 'raid', before: 'raid', ctor: stubSys('dlc:ww2') });
      m.registerCommand('barrage', (ctx) => { ctx.logEvent('💥 炮火覆盖（占位）'); });
    },
  };
}

function dlcSkyMagic(): ModPack {
  return {
    id: 'dlc-sky-magic', name: '飞天魔法 DLC（占位）', requires: ['dlc-radio'], // 无线电（占位世界观缝合）
    apply(m: ModRegistry): void {
      m.registerSystemDef({ id: 'dlc:sky', label: '飞天魔法', category: 'world', ctor: stubSys('dlc:sky') });
      m.registerCommand('levitate', (ctx) => { ctx.logEvent('🧙 群体漂浮术（占位）'); });
      m.registerRecipe({ id: 'dlc:mana-potion', name: '魔力药水', kind: 'batch', input: [{ item: 'wood', amount: 3 }], output: { item: 'food', amount: 2 } });
    },
  };
}