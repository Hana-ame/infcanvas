/**
 * cards.test.ts —— 一切皆抽卡的引擎级验证（原则①）。
 * 用真实 Sim + 专用桩卡包：权重分布 / 谓词过滤 / 熟练度演化。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry, type ModPack } from '../mods';
import { effectiveMastery, touchMastery } from '../sim/cards';
import { commit } from '../sim/systems';
import type { DrawSurface, PawnState } from '../sim';

/** 桩卡包：三张卡覆盖权重悬殊/条件过滤/系列隔离，action 即时收工 */
const stubPack: ModPack = {
  id: 'stub',
  requires: [],
  apply(m) {
    m.registerCard({ id: 'heavy', label: '重卡', series: 'wander', weight: 9, action: (p, c) => c.finishCard(p) });
    m.registerCard({ id: 'light', label: '轻卡', series: 'social', weight: 1, action: (p, c) => c.finishCard(p) });
    m.registerCard({
      id: 'locked',
      label: '锁卡',
      series: 'rest',
      weight: 100,
      condition: () => false, // 永不可抽——谓词过滤验证
      action: () => {},
    });
  },
};

function stubSim(seed = 5): Sim {
  return new Sim({ seed, registry: ModRegistry.mountPacks([stubPack]), pawnCount: 1 });
}

describe('抽卡决策引擎', () => {
  it('权重分布：9:1 权重 → 重卡占比显著占优（桩卡即时收工=每 tick 一抽）', () => {
    const s = stubSim();
    const p = [...s.pawns()][0];
    s.run(400);
    const heavy = p.uses['heavy'] ?? 0;
    const light = p.uses['light'] ?? 0;
    expect(heavy + light).toBeGreaterThan(200);
    expect(heavy / (heavy + light)).toBeGreaterThan(0.8);
    expect(heavy / (heavy + light)).toBeLessThan(0.99);
  });

  it('谓词过滤：condition=false 的卡永远不被抽中', () => {
    const s = stubSim();
    const p = [...s.pawns()][0];
    s.run(100);
    expect(p.uses['locked']).toBeUndefined();
  });

  it('熟练度成长：反复触发同卡 → 有效熟练度上升且封顶 100（卡=习惯）', () => {
    const s = stubSim();
    const p = [...s.pawns()][0];
    for (let i = 0; i < 140 && (p.mastery['heavy']?.v ?? 0) < 100; i++) {
      s.debugForceCard(p.eid, 'heavy');
      s.step(1);
    }
    expect(p.mastery['heavy'].v).toBe(100);
  });

  it('熟练度惰性衰减：停止触碰后按流逝时间折算下降（卸载 behavior = 纯时钟）', () => {
    const reg = ModRegistry.mountPacks([stubPack]);
    reg.disableSystem('behavior'); // 卸载决策引擎：验证"卸载不破坏核心"且衰减是纯时间函数
    const s = new Sim({ seed: 2, registry: reg, pawnCount: 1 });
    const p = [...s.pawns()][0];
    p.mastery['heavy'] = { v: 50, t: 0 };
    s.step(100);
    expect(effectiveMastery(p, 'heavy', s)).toBeCloseTo(50 - 100 * s.tuning.pawn.masteryDecayPerSec, 5);
  });

});

/**
 * 抽卡引擎与棋盘的分离面（2026-10-07，DrawSurface）。
 *
 * 这组测试的价值不在于它测了什么行为，而在于**它怎么测**：下面的假对象只有
 * 5 个成员（DrawSurface 的全部），没有 Sim 的另外 45 个。如果引擎下层悄悄长出
 * 对棋盘的需求（比如 commit 哪天想读建筑表），这里会**编译不过**而不是静默耦合。
 */
describe('抽卡引擎与棋盘的分离面（DrawSurface）', () => {
  const t = new Sim({ seed: 1, registry: ModRegistry.default(), pawnCount: 0 }).tuning;

  /** 最小引擎面：5 个成员，无棋盘、无实体、无寻路。 */
  function surface(time: number): DrawSurface {
    return {
      time,
      tuning: t,
      rng: () => 0.5,
      cards: () => [],
      weightHooks: () => [],
    };
  }

  function pawn(): PawnState {
    return {
      eid: 1,
      name: 't',
      pos: { x: 0, y: 0 },
      needs: { food: 80, rest: 80, mood: 80, san: 80 },
      hp: 20,
      maxHp: 20,
      climb: 0,
      trait: 'calm',
      cardId: null,
      busyUntil: 0,
      holdUntil: 0,
      atkCd: 0,
      path: [],
      mastery: {},
      uses: {},
    };
  }

  it('commit / touchMastery / effectiveMastery 只吃 DrawSurface，不需要 Sim', () => {
    const s = surface(0);
    const p = pawn();
    commit(s, p, { id: 'heavy', label: '重卡', series: 'wander', weight: 9, action: () => {} });
    expect(p.cardId).toBe('heavy');
    expect(p.uses.heavy).toBe(1);
    expect(p.busyUntil).toBe(t.pawn.defaultCardSec);
    expect(p.mastery.heavy?.t).toBe(0);
    // 惰性衰减：time 前进后重读，值按流逝时间折算
    const decayed = effectiveMastery(p, 'heavy', surface(10));
    expect(decayed).toBe(t.pawn.masteryGain - 10 * t.pawn.masteryDecayPerSec);
    expect(decayed).toBeLessThan(p.mastery.heavy!.v);
  });

  it('引擎面成员可独立推进时钟而不触及世界', () => {
    const p = pawn();
    touchMastery(p, 'heavy', surface(0));
    touchMastery(p, 'heavy', surface(7));
    touchMastery(p, 'heavy', surface(9));
    // 三次触碰，中间只流逝 2s（0→7 那次在 t=7 被折算掉），不是三次满额
    expect(p.mastery.heavy!.v).toBeLessThan(3 * t.pawn.masteryGain);
    expect(p.mastery.heavy!.t).toBe(9);
  });
});
