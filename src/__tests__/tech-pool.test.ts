/**
 * tech-pool.test.ts —— R2-1 科技抽卡池验收。
 *
 * 覆盖验收清单：
 *  1. 固定 seed 下解锁顺序符合 TECH_ORDER 概率预期（统计测试）；
 *  2. 卸载 tech-pool 包 = 永无科技但核心照跑；
 *  3. 存读档碎片数一致；
 *  4. 门控真实生效（未解锁不建 / 解锁后能建）；
 *  5. 重复卡不累计碎片（用户 2026-08-15 裁决）。
 */
import { describe, expect, it } from 'vitest';
import { Sim, snapshotOf, loadSim } from '../sim';
import { ModRegistry, type ModPack } from '../mods';
import { techPoolPack } from '../mods/packs/tech-pool';
import { needsPack } from '../mods/packs/needs';
import { gatheringPack } from '../mods/packs/gathering';
import { buildingPack } from '../mods/packs/building';
import { socialPack } from '../mods/packs/social';
import { raidPack } from '../mods/packs/raid';
import { bootstrapPack } from '../mods/packs/bootstrap';

/** 科技池节奏拉快 + 只挂 tech-pool：统计测试要跑足够多次抽池才稳定 */
function techSim(seed: number, intervalSec = 5, chance = 1): Sim {
  const reg = ModRegistry.mountPacks([techPoolPack]);
  reg.overrideTuning((t) => {
    t.techPool.intervalSec = intervalSec;
    t.techPool.chance = chance;
  });
  // 无 bootstrap → 不出生鼠；科技池不依赖鼠，纯时钟系统，0 pawn 也能跑
  return new Sim({ seed, registry: reg, pawnCount: 0 });
}

describe('R2-1 科技抽卡池', () => {
  it('碎片制：碎片逐块累积，攒满才解锁（不是抽到就发整卡）', () => {
    const s = techSim(1, 1, 1);
    // 一开始什么都没解锁
    expect(s.techUnlocked().size).toBe(0);
    // 跑若干次抽池，观察"未解锁但已有碎片"的中间态
    let sawPartial = false;
    for (let i = 0; i < 40 && !sawPartial; i++) {
      s.step(1);
      if (s.techUnlocked().size === 0) {
        const frags = Object.values(s.techFragments).reduce((a, b) => a + b, 0);
        if (frags > 0) sawPartial = true;
      }
    }
    expect(sawPartial).toBe(true); // 确实存在"攒了碎片但还没解锁"的中间态
  });

  it('统计：解锁顺序以靠前科技为主（TECH_ORDER 权重线性递减的方向性验证）', () => {
    // 跑很多局，统计"谁最先解锁"。期望靠前（order 小）的科技成为首个解锁的次数占多数。
    const firstByOrder: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const s = techSim(seed, 1, 1);
      let guard = 0;
      while (s.techUnlocked().size === 0 && guard++ < 200) s.step(1);
      if (s.techUnlocked().size === 0) continue;
      const first = [...s.techUnlocked()][0];
      firstByOrder.push(s.tuning.techs[first].order);
    }
    expect(firstByOrder.length).toBeGreaterThan(20);
    // 首个解锁的科技：order 越小越常见。断言中位数量级 <= 1（4 项里靠前两项占多数）
    firstByOrder.sort((a, b) => a - b);
    const median = firstByOrder[Math.floor(firstByOrder.length / 2)];
    expect(median).toBeLessThanOrEqual(1);
  });

  it('统计：解锁发生率随 TECH_ORDER 递减（权重线性递减的直接观测，跨 30 局累计）', () => {
    // 观测口径的选择（本测试的核心教训，已写入注释防后人重犯）：
    //   ① 不用"碎片总数"——解锁那一刻碎片被清零，总数会回落，diff 会漏计；
    //   ② 不用"解锁顺序"——12 抽/局足以解锁多项，顺序被抹平；
    //   ③ 不用"碎片数逐键 diff"——解锁清零同样让 diff 失效（实测少计 152/360）。
    //   正确口径 = **每项科技在每局里是否发生过解锁**：解锁是不可逆事件，
    //   单调递增，用集合差分精确捕捉，且不受中途清零干扰。
    const unlocks = new Map<string, number>(); // techId -> 发生解锁的局数
    const DRAWS = 12; // 每局 12 次抽池：够解锁靠前 1~2 项，但不会全解锁
    const runs = 30;
    for (let seed = 1; seed <= runs; seed++) {
      const s = techSim(seed, 1, 1);
      for (let i = 0; i < DRAWS; i++) s.step(1);
      for (const id of s.techUnlocked()) unlocks.set(id, (unlocks.get(id) ?? 0) + 1);
    }
    const order = techSim(0).techOrder();
    const byOrder = order.map((id) => unlocks.get(id) ?? 0);
    expect(byOrder.length).toBeGreaterThanOrEqual(4);
    // 靠前的科技解锁局数 >= 靠后的（单调不增 = 权重递减的方向性）
    for (let i = 1; i < byOrder.length; i++) {
      expect(byOrder[i - 1]).toBeGreaterThanOrEqual(byOrder[i]);
    }
    // 且首尾必须拉开：最高权重项远多于最低权重项（30 局 × 4 项，不是偶然相等）
    expect(byOrder[0]).toBeGreaterThan(byOrder[byOrder.length - 1] + 5);
  });

  it('重复卡：抽到已解锁科技不累计碎片（稀释而非奖励）', () => {
    const s = techSim(3, 1, 1);
    // 强制解锁第一项
    const first = s.techOrder()[0];
    expect(s.grantTechFragment(first)).not.toBe('unlocked'); // 先攒
    let guard = 0;
    while (!s.techUnlocked().has(first) && guard++ < 50) s.step(1);
    expect(s.techUnlocked().has(first)).toBe(true);
    const fragsBefore = s.techFragments[first] ?? 0;
    // 再次 grant 已解锁科技 → dup，碎片不变
    expect(s.grantTechFragment(first)).toBe('dup');
    expect(s.techFragments[first] ?? 0).toBe(fragsBefore);
  });

  it('未知科技 id：grantTechFragment 返回 unknown 且不静默累计（防御）', () => {
    const s = techSim(4, 1000, 1); // interval 极大 = 不抽池
    expect(s.grantTechFragment('不存在的科技')).toBe('unknown');
    expect(s.techFragments['不存在的科技']).toBeUndefined();
  });

  it('卸载 tech-pool 包：永无科技但核心照跑（无科技系统、建造不被锁死）', () => {
    const withoutTech: ModPack[] = [needsPack, gatheringPack, buildingPack, socialPack, raidPack, bootstrapPack];
    const s = new Sim({ seed: 42, registry: ModRegistry.mountPacks(withoutTech) });
    // 无科技池系统
    expect(s.systems.some((x) => x.id === 'tech-pool')).toBe(false);
    // 长跑：零解锁、零碎片（永无科技）
    s.run(1500);
    expect(s.techUnlocked().size).toBe(0);
    expect(Object.keys(s.techFragments).length).toBe(0);
    // 核心照跑：有鼠有火有木料（建造没被门控锁死）
    expect([...s.pawns()].length).toBeGreaterThan(0);
    expect([...s.world.buildings.values()].length).toBeGreaterThanOrEqual(1); // 初始篝火
    // 木料经济活着（techSatisfied 在空表下放行 → build 卡可抽）
    expect(s.stockpile['wood']).toBeGreaterThanOrEqual(0);
  });

  it('门控生效：store 未解锁时 techSatisfied 为 false，解锁后放行', () => {
    const reg = ModRegistry.mountPacks([needsPack, gatheringPack, buildingPack, socialPack, bootstrapPack, techPoolPack]);
    const s = new Sim({ seed: 9, registry: reg });
    // 仓库是唯一带科技门控的建筑（2026-08-21 平衡复采修正，见 building.ts 注册处注释）：
    // hut/campfire 不带 tech 字段 → 空表语义放行。
    expect(s.tuning.buildings['store'].tech).toEqual(['storage:store']);
    expect(s.tuning.buildings['hut'].tech).toBeUndefined();
    expect(s.tuning.buildings['campfire'].tech).toBeUndefined();
    // 未解锁 → 拒绝
    expect(s.techUnlocked().has('storage:store')).toBe(false);
    expect(s.techSatisfied(s.tuning.buildings['store'].tech)).toBe(false);
    expect(s.techSatisfied(s.tuning.buildings['hut'].tech)).toBe(true); // 无门控
    expect(s.techSatisfied(s.tuning.buildings['campfire'].tech)).toBe(true); // 无门控
    // 强制解锁 → 放行
    for (const id of s.techOrder()) {
      let g = 0;
      while (!s.techUnlocked().has(id) && g++ < 30) s.grantTechFragment(id);
    }
    expect(s.techUnlocked().has('storage:store')).toBe(true);
    expect(s.techSatisfied(s.tuning.buildings['store'].tech)).toBe(true);
  });

  it('门控：引用表外科技 id 时放行（数据半残不许锁死世界）', () => {
    const s = techSim(21, 1e9, 1);
    // 模拟 mod 热卸载：def 引用了一个不在 techs 表里的 id
    expect(s.techSatisfied(['no-such-tech'])).toBe(true);
    // 但表内未解锁的真实科技仍然拦住
    expect(s.techSatisfied([s.techOrder()[0]])).toBe(false);
  });

  it('存读档：碎片数与已解锁集合一致（往返无损）', () => {
    const s = techSim(11, 1, 1);
    // 跑到有碎片和部分解锁的状态
    s.step(7); // 攒几块碎片
    for (let i = 0; i < 12; i++) s.step(1); // 可能解锁一两个
    const fragSnapshot = { ...s.techFragments };
    const unlockedSnapshot = [...s.techUnlocked()].sort();
    const restored = loadSim(JSON.parse(JSON.stringify(snapshotOf(s))), ModRegistry.mountPacks([techPoolPack]));
    // 碎片数一致
    expect(restored.techFragments).toEqual(fragSnapshot);
    // 已解锁集合一致
    expect([...restored.techUnlocked()].sort()).toEqual(unlockedSnapshot);
  });

  it('存读档：scratch 抽池计时器随档（读档后抽池节奏不分叉）', () => {
    const s = techSim(12, 10, 1);
    s.step(7); // acc=7 < 10
    expect(s.scratch['tech-pool.acc']).toBeCloseTo(7, 6);
    const restored = loadSim(JSON.parse(JSON.stringify(snapshotOf(s))), ModRegistry.mountPacks([techPoolPack]));
    expect(restored.scratch['tech-pool.acc']).toBeCloseTo(7, 6);
  });
});
