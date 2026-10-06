/**
 * hunting.test.ts —— R3-3 狩猎包验收。
 *
 * 覆盖验收清单：
 *  1. 挂载/卸载：hunting 包挂载不报错，卸载不破坏核心（原则④）；
 *  2. 定向狩猎：force hunt 卡打兔 → meat +1（deterministic 方向性验证）；
 *  3. 鹿掉落：杀鹿 → meat +2, herb +1（材料链：肉→草药→医疗）；
 *  4. 吃肉：force eat + 只有肉 → meat -1, food need 上升（meatGain 生效）；
 *  5. 卸载回退：无 hunting 时 needs.eat 用生食、无报错（可选访问验证）；
 *  6. 存读档：spawnAcc 随档（scratch 键持久化）。
 *
 * 测试风格：最小装配 + debugForceCard（照 cooking/farming 范式）。
 * SOLO = [needsPack, buildingPack, huntingPack]（不挂 bootstrap → 单鼠确定性）。
 * ⚠ 纪律：debugForceCard + 手动摆坐标在验证假想世界——但狩猎是静态目标（手动刷动物），
 *   所以方向性断言是合理的；涌现层面（动物刷出来、鼠自己抽 hunt 卡）不在本测试范围。
 */
import { describe, expect, it } from 'vitest';
import { Sim, loadSim, snapshotOf } from '../sim';
import { ModRegistry, type ModPack } from '../mods';
import { K_STOCK_FOOD, K_STOCK_MEAT, K_STOCK_HERB, K_STOCK_MEAL, SER_HUNT } from '../mods/contracts';
import { needsPack } from '../mods/packs/needs';
import { buildingPack } from '../mods/packs/building';
import { huntingPack } from '../mods/packs/hunting';
import { gatheringPack } from '../mods/packs/gathering';
import { bootstrapPack } from '../mods/packs/bootstrap';

/** 单鼠最小装配：不挂 bootstrap → 确定性单鼠。 */
const SOLO: ModPack[] = [needsPack, buildingPack, huntingPack];

/** 完整装配（含 hunting）：用于挂载/卸载对照。 */
const WITH_HUNTING: ModPack[] = [
  needsPack,
  gatheringPack,
  buildingPack,
  bootstrapPack,
  huntingPack,
];

/** 完整装配但摘掉 hunting：对照"卸载不破坏核心"。 */
const WITHOUT_HUNTING: ModPack[] = [
  needsPack,
  gatheringPack,
  buildingPack,
  bootstrapPack,
];

/** 创建最小装配 Sim（单鼠、seed 1） */
function soloSim(seed = 1): Sim {
  return new Sim({ seed, registry: ModRegistry.mountPacks(SOLO), pawnCount: 1 });
}

describe('R3-3 狩猎包', () => {
  it('挂载：hunting 包注册成功（敌人/卡/系统/系列全部登记）', () => {
    const s = soloSim();
    // 敌人数据表
    expect(s.tuning.enemies['rabbit']).toBeDefined();
    expect(s.tuning.enemies['rabbit']?.passive).toBe(true);
    expect(s.tuning.enemies['rabbit']?.drops?.[K_STOCK_MEAT]).toBe(1);
    expect(s.tuning.enemies['deer']).toBeDefined();
    expect(s.tuning.enemies['deer']?.passive).toBe(true);
    expect(s.tuning.enemies['deer']?.drops?.[K_STOCK_MEAT]).toBe(2);
    expect(s.tuning.enemies['deer']?.drops?.[K_STOCK_HERB]).toBe(1);
    // hunt 卡
    expect(s.cards().some((c) => c.id === 'hunt')).toBe(true);
    const huntCard = s.cards().find((c) => c.id === 'hunt')!;
    expect(huntCard.series).toBe(SER_HUNT);
    expect(huntCard.weight).toBe(6);
    expect(huntCard.duration).toBe(6);
    // 系统
    expect(s.systems.some((sys) => sys.id === 'hunting')).toBe(true);
    // 数值表
    expect(s.tuning.hunting).toBeDefined();
    expect(s.tuning.hunting.meatGain).toBe(50);
    expect(s.tuning.hunting.huntMagnetRadius).toBe(24);
    expect(s.tuning.hunting.huntWorkRadius).toBe(2.0);
  });

  it('卸载不破坏核心：无 hunting 时世界照跑、eat 退化成纯生食', () => {
    const s = new Sim({ seed: 2, registry: ModRegistry.mountPacks(WITHOUT_HUNTING), pawnCount: 1 });
    // 没有 hunt 卡
    expect(s.cards().some((c) => c.id === 'hunt')).toBe(false);
    // 没有被动动物
    expect(s.tuning.enemies['rabbit']).toBeUndefined();
    expect(s.tuning.enemies['deer']).toBeUndefined();
    // 但 tuning.hunting 仍在出厂表（数值存在但不可用——可选访问）
    expect(s.tuning.hunting.meatGain).toBe(50);
    // 跑 100 tick 不报错
    s.run(100);
    expect(true).toBe(true); // 没抛错就行
  });

  it('定向狩猎打兔：force hunt → 兔死 → meat +1（方向性断言）', () => {
    const s = soloSim(3);
    const p = [...s.pawns()][0];
    // 把兔刷在鼠旁边（workRadius 2.0 内）
    s.spawnHostile('rabbit', p.pos.x, p.pos.y);
    const h = s.hostiles()[0];
    expect(h.hp).toBe(8);
    // 强制 hunt 卡循环执行，直到兔死或超过 30 tick
    let killed = false;
    for (let i = 0; i < 30 && !killed; i++) {
      s.debugForceCard(p.eid, 'hunt');
      s.step(1);
      killed = !s.hostiles().some((x) => x.id === h.id);
    }
    expect(killed).toBe(true); // 兔被杀
    expect(s.stockpile[K_STOCK_MEAT]).toBe(1); // 掉肉 +1
    // 日志
    expect(s.events.some((e) => e.text.includes('野兔'))).toBe(true);
  });

  it('杀鹿掉落：force hunt → 鹿死 → meat +2, herb +1（材料链）', () => {
    const s = soloSim(4);
    const p = [...s.pawns()][0];
    // 把鹿刷在鼠旁边
    s.spawnHostile('deer', p.pos.x, p.pos.y);
    const h = s.hostiles()[0];
    expect(h.hp).toBe(22);
    // 强制 hunt 卡循环执行，直到鹿死或超过 50 tick
    let killed = false;
    for (let i = 0; i < 50 && !killed; i++) {
      s.debugForceCard(p.eid, 'hunt');
      s.step(1);
      killed = !s.hostiles().some((x) => x.id === h.id);
    }
    expect(killed).toBe(true); // 鹿被杀
    expect(s.stockpile[K_STOCK_MEAT]).toBe(2); // 掉肉 +2
    expect(s.stockpile[K_STOCK_HERB]).toBe(1); // 掉草药 +1
  });

  it('eat 吃肉：force eat + 只有肉 → meat -1, food need 上升（meatGain 生效）', () => {
    const s = soloSim(5);
    const p = [...s.pawns()][0];
    // 清空仓库，只留肉
    s.stockpile[K_STOCK_MEAT] = 3;
    delete s.stockpile[K_STOCK_FOOD];
    delete s.stockpile[K_STOCK_MEAL];
    const food0 = p.needs.food;
    expect(food0).toBeLessThan(95); // 确保饿（condition 要求 food < 95）
    // 强制 eat 卡
    s.debugForceCard(p.eid, 'eat');
    s.step(1);
    expect(s.stockpile[K_STOCK_MEAT]).toBe(2); // 肉 -1
    expect(p.needs.food).toBeGreaterThan(food0); // 食欲上升
    // 肉满血：meatGain 50（大于生食 40，小于熟食 55）
    const meatGain = s.tuning.hunting.meatGain;
    expect(meatGain).toBe(50);
    expect(meatGain).toBeGreaterThan(s.tuning.needs.eatFoodGain); // > 生食 40
    expect(meatGain).toBeLessThan(s.tuning.cooking.eatCookedFoodGain); // < 熟食 55
  });

  it('卸载回退：无 hunting 时 eat 用生食、可选访问不报错', () => {
    const s = new Sim({ seed: 6, registry: ModRegistry.mountPacks(WITHOUT_HUNTING), pawnCount: 1 });
    const p = [...s.pawns()][0];
    // 放一些生食
    s.stockpile[K_STOCK_FOOD] = 3;
    // 清空肉（确保不会吃不到东西）
    delete s.stockpile[K_STOCK_MEAT];
    delete s.stockpile[K_STOCK_MEAL];
    const food0 = p.needs.food;
    // 强制 eat 卡
    s.debugForceCard(p.eid, 'eat');
    s.step(1);
    // 生食被吃、食欲上升
    expect(s.stockpile[K_STOCK_FOOD]).toBe(2);
    expect(p.needs.food).toBeGreaterThan(food0);
    // tuning.hunting 仍在出厂表（可选访问不报错）
    expect(s.tuning.hunting).toBeDefined();
    // 肉不存在 → 可选访问返回 0
    const meatGain = s.tuning.hunting?.meatGain ?? 0;
    expect(meatGain).toBe(50); // 即使 hunting 包没挂，数值仍在出厂表
  });

  it('存读档：spawnAcc 随档（scratch 键持久化）', () => {
    const s = soloSim(7);
    // 跑一些 tick 让 spawnAcc 积累
    s.run(30); // spawnIntervalSec = 25，30 tick 后应该刷过一次
    const spawnAcc = s.scratch['hunting.spawnAcc'];
    expect(spawnAcc).toBeDefined();
    expect(spawnAcc).toBeGreaterThan(0); // 至少跑了一些 tick
    // 保存
    const save = snapshotOf(s);
    // 加载到新 Sim
    const s2 = loadSim(save, ModRegistry.mountPacks(SOLO));
    // spawnAcc 应被保留
    const spawnAcc2 = s2.scratch['hunting.spawnAcc'];
    expect(spawnAcc2).toBeDefined();
    expect(spawnAcc2).toBeCloseTo(spawnAcc, 1); // 近似相等（浮点精度）
  });
});
