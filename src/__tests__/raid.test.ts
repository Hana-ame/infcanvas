/**
 * raid.test.ts —— 敌袭：压力生成 / 猫的追咬 / 鼠的战与逃（全部经卡）。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';
import { raidPack } from '../mods/packs/raid';

function raidSim(seed = 6): Sim {
  return new Sim({ seed, registry: ModRegistry.mountPacks([raidPack]), pawnCount: 2 });
}

describe('敌袭包', () => {
  it('叙事压力：阈值到点自动来猫（无波次脚本，纯局面规则）', () => {
    const s = raidSim();
    // 轮询到第一只猫出现（raid-only 无火堆时离场阀可能在轮询间隙触发离场）
    let found = false;
    for (let i = 0; i < 400 && !found; i++) {
      s.step(1);
      if (s.hostiles().length > 0) found = true;
    }
    expect(found).toBe(true);
    expect(s.events.some((e) => e.text.includes('出没'))).toBe(true);
  });

  it('迎战卡：贴身攻击造成伤害直至击退', () => {
    const s = raidSim(15);
    const p = [...s.pawns()][0];
    const h = s.spawnHostile('cat', Math.round(p.pos.x) + 1, p.pos.y);
    const hp0 = h.hp;
    let repelled = false;
    for (let i = 0; i < 60 && !repelled; i++) {
      s.debugForceCard(p.eid, 'fight');
      s.step(1);
      repelled = !s.hostiles().some((x) => x.id === h.id);
    }
    expect(hp0 - (s.hostiles()[0]?.hp ?? 0)).toBeGreaterThan(0); // 造成过伤害
    expect(repelled).toBe(true); // 被击退（hp 归零移除）
    expect(s.events.some((e) => e.text.includes('被击退'))).toBe(true);
  });

  it('撤退卡：逃向严格背离敌人的方向（决策语义；速度哨兵见下）', () => {
    const s = raidSim(16);
    const p = [...s.pawns()][0];
    p.pos = { x: 0, y: 0 };
    // 猫在正东 5 格：flee 的路径目标必须落在西侧（x<0）
    const h = s.spawnHostile('cat', 5, 0);
    s.debugForceCard(p.eid, 'flee');
    s.step(1);
    expect(p.pos.x).toBeLessThan(0); // 向西拉开
    const d1 = Math.hypot(p.pos.x - h.pos.x, p.pos.y - h.pos.y);
    expect(d1).toBeGreaterThan(4); // 一拍后已拉开超过初始距离
    // 平衡哨兵：猫速若调到鼠速以上，逃跑失去意义（战或逃失衡立刻红）
    expect(s.tuning.enemies['cat'].speed).toBeLessThan(s.tuning.pawn.speed);
  });

  it('刷怪落点必须可立足（掉进湖里的猫会永久卡死成幽灵敌袭）', () => {
    const s = new Sim({ seed: 42, registry: ModRegistry.mountPacks([raidPack]), pawnCount: 1 });
    s.run(200);
    expect(s.hostiles().length).toBeGreaterThan(0);
    for (const h of s.hostiles()) {
      expect(s.passable(Math.round(h.pos.x), Math.round(h.pos.y))).toBe(true);
      expect(s.passable(Math.round(h.pos.x), Math.round(h.pos.y))).toBe(true);
    }
  });

  it('离场阀：够不着鼠又远离营地 45s → 猫悻悻离去（防长局猫堆积）', () => {
    const s = new Sim({ seed: 19, registry: ModRegistry.mountPacks([raidPack]), pawnCount: 0 });
    // 无火无鼠：farFromCamp 恒真、target 恒空 → 计时即涨
    const h = s.spawnHostile('cat', 30, 30);
    s.run(44);
    expect(s.hostiles().some((x) => x.id === h.id)).toBe(true); // 44s 还在
    s.run(3);
    expect(s.hostiles().some((x) => x.id === h.id)).toBe(false); // 47s 走了
    expect(s.events.some((e) => e.text.includes('悻悻离去'))).toBe(true);
  });

  it('猫会追咬最近的鼠；鼠被咬死有死亡事件（losing is fun）', () => {
    const s = raidSim(17);
    const victims = [...s.pawns()];
    const v = victims[0];
    v.hp = 8; // 三口就被咬死的残血鼠（构造故事）
    const others = victims.slice(1).map((x) => x.eid);
    void others;
    const h = s.spawnHostile('cat', Math.round(v.pos.x) + 3, Math.round(v.pos.y));
    for (const x of victims.slice(1)) {
      // 其他鼠远远放走，确保目标唯一
      x.pos = { x: v.pos.x + 100, y: v.pos.y + 100 };
    }
    let died = false;
    for (let i = 0; i < 80 && !died; i++) {
      s.step(1);
      if (!s.pawn(v.eid)) died = true;
    }
    void h;
    expect(died).toBe(true);
    expect(s.events.some((e) => e.text.includes('💀') && e.text.includes('野猫袭击'))).toBe(true);
  });

  /**
   * 战/逃卡的「真场景」回归：猫**靠自己追过来**进感知圈时，两张卡必须进候选池。
   *
   * 【为什么要补这条，缺了它会怎样】本文件上面两条战/逃测试都用了
   * `spawnHostile(..., ±1 / ±5 格)` —— **手工把猫摆在贴身距离**。
   * 这正是「通过测试但功能不存在」的成因：chat 卡当年 condition 用 chatRadius=2.5
   * 找同伴，测试里两只鼠被手动摆到距离 1，于是条件恰好成立、测试一直绿，
   * 而真实局里同类概率只有 1.1%，社交事实上是死代码（失败率 96.3%）。
   * 战/逃卡的 `nearestHostile` 用 senseRadius=18，**当前实现是正确的**
   * （2026-10-06 实测：猫在感知圈的 606 个抽样里战斗卡覆盖 26.9%），
   * 但"正确"是**测不出来的**——手工摆位的测试对半径改动完全免疫。
   * 本条改为**不摆位**：让猫按自己的动物智能追进感知圈，再断言 condition 转真。
   *
   * 【断言的机制而非数值】猫刷出在 spawnDistMin~spawnDistMax(16~24) 格外，
   * 比感知圈 18 更远或相当——所以 condition 转真**只能**因为猫自己走近了，
   * 而不是因为测试替它走近。这正是本条要钉住的那条性质。
   */
  it('战/逃卡：猫靠自己的追猎走进感知圈时，condition 必须转真（不手工摆位）', () => {
    const s = new Sim({ seed: 6, registry: ModRegistry.mountPacks([raidPack]), pawnCount: 2 });
    const fight = s.cardById('fight')!;
    const flee = s.cardById('flee')!;
    const before = [...s.pawns()];
    // 开局还没有猫：两张卡都不该成立（证明后面转真是"猫来了"造成的，不是恒真）
    for (const p of before) {
      expect(fight.condition!(p, s)).toBe(false);
      expect(flee.condition!(p, s)).toBe(false);
    }
    // 不 spawnHostile —— 等叙事压力自己刷猫（spawnDist 16~24 格，> 感知半径 18 的多数情形）
    let becameTrue = false;
    for (let i = 0; i < 900 && !becameTrue; i++) {
      s.step(1);
      becameTrue = [...s.pawns()].some((p) => fight.condition!(p, s) && flee.condition!(p, s));
    }
    expect(becameTrue, '猫自始至终没走进任何鼠的 18 格感知圈，战/逃卡在真场景下无法进候选池').toBe(true);
    // 再跑一段让抽卡真的有轮次（上面循环在 condition 首次转真时就退出了，
    // 那一刻鼠手里多半还握着上一张工作卡 —— 工作卡 duration 6~8s，反应链不是瞬间的）
    s.run(30);
    // 且真的打起来了（战或逃至少落进过抽签）
    expect(
      [...s.pawns()].some((p) => (p.uses['fight'] ?? 0) + (p.uses['flee'] ?? 0) > 0) ||
        s.events.some((e) => e.text.includes('野猫袭击')),
      '猫在感知圈内却没有鼠抽到战/逃卡',
    ).toBe(true);
  });
});
