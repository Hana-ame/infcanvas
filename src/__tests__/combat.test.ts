/**
 * combat.test.ts —— 战术包：据守 / 集火 / 迂回 / 集结四卡。
 *
 * 来历：2026-10-07 R4-GEN 种子轮「野外生存 + 社会模拟」的战术层。raid 包只有
 *   fight/flee 两卡 = 「打不打」；本包补「怎么打、从哪打、和谁一起打」。
 *   子代理写了包本体（407 行，注释质量高）但上下文耗尽没写测试，本文件补上。
 *
 * 测试策略：
 *   - condition 直接从 registry.cards 取 CardDef 调用（`(p, ctx) => boolean`），
 *     比 debugForceCard + 观察行为更直接、更便宜。
 *   - 磁铁范式的行为断言用 debugForceCard + step(1)（照 raid.test.ts 范式）。
 *   - 伤害倍率用「伤害差值」断言：focus 打出的伤害 ≈ raid.fight 的 focusMul 倍。
 *
 * 装配：最小装配 = buildingPack（据点）+ raidPack（刷敌人 + damageHostile 语义）
 *   + combatPack。SOLO 装配不挂 bootstrap，否则 pawnCount 会变 5。
 */
import { describe, expect, it } from 'vitest';
import { Sim, snapshotOf, loadSim } from '../sim';
import { ModRegistry } from '../mods';
import { combatPack } from '../mods/packs/combat';
import { buildingPack } from '../mods/packs/building';
import { raidPack } from '../mods/packs/raid';
import { SER_DEFEND, SER_FIGHT } from '../mods/contracts';
import type { CardDef } from '../sim/cards';
import type { PawnState } from '../sim/types';
import type { SimContext } from '../sim/context';

/** 最小装配：有建筑（据点）+ 有敌人（刷 cat）+ 有战术卡。 */
function combatSim(seed = 7, opts: { pawnCount?: number } = {}): Sim {
  const reg = ModRegistry.mountPacks([buildingPack, raidPack, combatPack]);
  // 关掉 raid 的叙事压力（否则它会自动刷猫，和测试里的精确布置打架）
  reg.overrideTuning((t) => {
    t.raid.pressurePerSec = 0;
  });
  const s = new Sim({ seed, registry: reg, pawnCount: opts.pawnCount ?? 2 });
  // 给个火堆当据点（campfire 带 K_TAG_FIRE + K_TAG_WAYPOINT）
  s.addBuilding('campfire', 0, 0);
  return s;
}

/** 取某张卡的 CardDef（含 condition）。 */
function card(reg: ModRegistry, id: string): CardDef {
  const c = reg.cardById(id);
  if (!c) throw new Error(`卡不存在：${id}`);
  return c;
}

/** 把一只 cat 放在 (x,y)。 */
function cat(s: Sim, x: number, y: number) {
  return s.spawnHostile('cat', x, y);
}

describe('combat 战术包 —— 数据种子', () => {
  it('4 张卡全部注册，series 都是 SER_DEFEND（与 raid 的 SER_FIGHT/FLEE 三条系列同台）', () => {
    const reg = ModRegistry.mountPacks([buildingPack, raidPack, combatPack]);
    for (const id of ['hold', 'focus', 'flank', 'rally']) {
      const c = reg.cardById(id);
      expect(c, `${id} 卡应存在`).toBeDefined();
      expect(c!.series).toBe(SER_DEFEND);
    }
    // raid 的两卡仍在（卸载 combat 不影响 raid）
    expect(reg.cardById('fight')?.series).toBe(SER_FIGHT);
  });

  it('数值全部在 tuning.combat 上（零硬编码哨兵）', () => {
    const s = combatSim();
    const c = s.tuning.combat;
    // 磁铁半径 > 攻击半径（大半径找、小半径打）—— 这是本项目已踩坑 5 次的范式的形状
    expect(c.defendMagnetRadius).toBeGreaterThan(c.attackRange);
    expect(c.defendMagnetRadius).toBeGreaterThan(c.holdRadius);
    // 伤害倍率排序：迂回 > 集火 > 单打（1.0）
    expect(c.flankMul).toBeGreaterThan(c.focusMul);
    expect(c.focusMul).toBeGreaterThan(1);
    // 侧翼偏移非零（否则「迂回」退化成「正面冲锋」，卡失去意义）
    expect(c.flankOffset).toBeGreaterThan(0);
    // 集结阈值 ≥ 2（1 只敌人不需要聚拢）
    expect(c.rallyMinEnemies).toBeGreaterThanOrEqual(2);
  });
});

describe('combat 战术包 —— condition 判据', () => {
  it('hold：附近有火堆（K_TAG_FIRE）才成立；无据点时假', () => {
    const reg = ModRegistry.mountPacks([buildingPack, raidPack, combatPack]);
    const s = new Sim({ seed: 7, registry: reg, pawnCount: 1 });
    const c = card(reg, 'hold');
    const p = [...s.pawns()][0];
    p.pos = { x: 3, y: 3 };
    const ctx = s as unknown as SimContext;
    // 无据点
    expect(c.condition!(p as unknown as PawnState, ctx)).toBe(false);
    // 有火堆（0,0），鼠在 (3,3) 距离 4.24 < magnetRadius 24
    s.addBuilding('campfire', 0, 0);
    expect(c.condition!(p as unknown as PawnState, ctx)).toBe(true);
  });

  it('hold：距离超出磁铁半径时假（24 格外的火堆不算「附近」）', () => {
    const reg = ModRegistry.mountPacks([buildingPack, raidPack, combatPack]);
    const s = new Sim({ seed: 7, registry: reg, pawnCount: 1 });
    s.addBuilding('campfire', 0, 0);
    const p = [...s.pawns()][0];
    p.pos = { x: 100, y: 100 };
    expect(card(reg, 'hold').condition!(p as unknown as PawnState, s as unknown as SimContext)).toBe(false);
  });

  it('flank：需要敌人 + 据点两条同时成立（缺一即假）', () => {
    const reg = ModRegistry.mountPacks([buildingPack, raidPack, combatPack]);
    const s = new Sim({ seed: 7, registry: reg, pawnCount: 1 });
    const p = [...s.pawns()][0];
    p.pos = { x: 0, y: 0 };
    const c = card(reg, 'flank').condition!;
    const ctx = s as unknown as SimContext;
    // 无据点无敌人
    expect(c(p as unknown as PawnState, ctx)).toBe(false);
    // 只有据点、没有敌人
    s.addBuilding('campfire', 2, 2);
    expect(c(p as unknown as PawnState, ctx)).toBe(false);
    // 敌人 + 据点都在
    cat(s, 5, 0);
    expect(c(p as unknown as PawnState, ctx)).toBe(true);
  });

  it('rally：敌人 < rallyMinEnemies 时假；达到阈值时真', () => {
    const reg = ModRegistry.mountPacks([buildingPack, raidPack, combatPack]);
    const s = combatSim(7, { pawnCount: 1 });
    const p = [...s.pawns()][0];
    p.pos = { x: 0, y: 0 };
    const c = card(reg, 'rally').condition!;
    const ctx = s as unknown as SimContext;
    const min = s.tuning.combat.rallyMinEnemies;
    expect(c(p as unknown as PawnState, ctx)).toBe(false);
    cat(s, 3, 0); // 1 只 < min(2)
    expect(c(p as unknown as PawnState, ctx)).toBe(false);
    cat(s, -3, 0); // 2 只 ≥ min
    expect(c(p as unknown as PawnState, ctx)).toBe(true);
  });

  it('focus：需要同伴在打同一只敌人（独自面对敌人时假）', () => {
    const reg = ModRegistry.mountPacks([buildingPack, raidPack, combatPack]);
    const s = new Sim({ seed: 7, registry: reg, pawnCount: 2 });
    const [a, b] = [...s.pawns()];
    a.pos = { x: 0, y: 0 };
    b.pos = { x: 1, y: 0 };
    const h = cat(s, 3, 0); // 一只敌人，离两只鼠都近
    const ctx = s as unknown as SimContext;
    const cond = card(reg, 'focus').condition!;
    // 两只鼠都不在打任何卡（cardId=null）→ 没有「同伴在打同一只」
    a.cardId = null;
    b.cardId = null;
    expect(cond(a as unknown as PawnState, ctx)).toBe(false);
    // b 在打 fight（目标近似 = 最近的敌人 = h）⇒ 对 a 而言 b 是「正在打同一只的同伴」
    b.cardId = 'fight';
    expect(cond(a as unknown as PawnState, ctx)).toBe(true);
    // b 改去伐木 → 不再有同伴在打 ⇒ 不成立
    b.cardId = 'chop_tree';
    expect(cond(a as unknown as PawnState, ctx)).toBe(false);
    // b 改抽战术卡 hold 也算同伴（COMBAT_CARDS 列表含 hold）
    b.cardId = 'hold';
    expect(cond(a as unknown as PawnState, ctx)).toBe(true);
    // 自己 cardId 是什么不影响「有没有同伴在打」——只查同伴
    a.cardId = 'wander';
    expect(cond(a as unknown as PawnState, ctx)).toBe(true);
    void h;
  });
});

describe('combat 战术包 —— 行为与磁铁范式', () => {
  it('hold 磁铁：不在 holdRadius 内时 setPath 走去据点 + return（path 非空、不结算伤害）', () => {
    const s = combatSim(7, { pawnCount: 1 });
    const p = [...s.pawns()][0];
    p.pos = { x: 20, y: 0 }; // 距火堆 (0,0) 20 格 > holdRadius 2
    const h = cat(s, 21, 0);
    s.debugForceCard(p.eid, 'hold');
    const hpBefore = h.hp;
    s.step(1);
    // 磁铁：路径指向据点方向（x 减小）
    expect(p.pos.x).toBeLessThan(20);
    expect(p.path.length).toBeGreaterThan(0);
    // 且没有出手（还太远了）
    expect(h.hp).toBe(hpBefore);
  });

  it('hold 到位后站定不动并出手（这是 hold 与 fight 的核心区别：fight 追、hold 等）', () => {
    const s = combatSim(7, { pawnCount: 1 });
    const p = [...s.pawns()][0];
    p.pos = { x: 1.5, y: 0 }; // 距火堆 1.5 < holdRadius 2
    p.path = [];
    p.atkCd = 0;
    const h = cat(s, 2.5, 0); // 敌人在 attackRange 1.75 内
    s.debugForceCard(p.eid, 'hold');
    s.step(1);
    expect(h.hp).toBeLessThan(100); // 出手了
    // 站定不动：path 被清空（不追敌人）
    expect(p.path).toHaveLength(0);
  });

  it('focus 伤害 = 基伤 × focusMul（集火加成真的生效）', () => {
    const s = combatSim(7, { pawnCount: 2 });
    const [a, b] = [...s.pawns()];
    a.pos = { x: 0, y: 0 };
    b.pos = { x: 1, y: 0 };
    const h = cat(s, 1, 0);
    a.cardId = 'fight'; // 让 focus 的 condition 成立（同伴在打同一只）
    a.atkCd = 0;
    b.atkCd = 0;
    // 基线：raid.fight 的伤害
    const base = s.tuning.pawn.dmg;
    s.debugForceCard(a.eid, 'focus');
    const hp0 = h.hp;
    s.step(1);
    const dealt = hp0 - h.hp;
    // focus 的伤害 ≈ base × focusMul（trait 乘数可能 ≠1，所以用区间断言）
    expect(dealt).toBeGreaterThanOrEqual(Math.round(base * 1.2)); // 明显高于单打
    expect(dealt).toBeLessThanOrEqual(Math.round(base * 1.4 * 1.5) + 1); // 不夸张
  });

  it('多敌人权重钩子：≥ multiEnemyThreshold 只敌人时 SER_DEFEND 权重被抬高', () => {
    const s = combatSim(7, { pawnCount: 1 });
    const p = [...s.pawns()][0];
    p.pos = { x: 0, y: 0 }; // 钉住位置，保证下方布置的敌人在 magnetRadius 内
    const c = s.tuning.combat;
    const threshold = c.multiEnemyThreshold;
    const hooks = s.weightHooks();
    const mul = () => hooks.reduce((m, h) => m * h(p, { series: SER_DEFEND, id: 'hold' }, s), 1);

    // ⚠ 差量对比而非绝对值：raid 的钩子对「非 SER_FIGHT/FLEE 且有敌」的卡一律乘
    // threatWorkMul(0.35)，它跟 SER_DEFEND 正交地压在同一个乘积上。若用「无敌人」做
    // 基线，raid 从 1.0 变成 0.35，把 combat 的抬权完全淹没。
    // 做法：先放 1 只敌人（< threshold，threat 已成立但 combat 未触发），
    // 再补足到 threshold 只，两边 raid 乘数都恒定在 0.35，比值就纯净地是 combat 的贡献。
    cat(s, 3, 0);
    const before = mul();
    for (let i = 1; i < threshold; i++) cat(s, 3 + i, 0);
    const after = mul();

    // 两边都有威胁（raid 乘数恒定），所以比值 = combat 的抬权倍数
    expect(after / before).toBeCloseTo(c.defendMulMultiEnemy, 5);
    expect(after).toBeGreaterThan(before); // 方向性：多敌人确实抬高，不是压低

    // 非 SER_DEFEND 系列不受本钩子影响（combat 钩子开头就 return 1）
    const fightMul = hooks.reduce((m, h) => m * h(p, { series: SER_FIGHT, id: 'fight' }, s), 1);
    // SER_FIGHT 走 raid 的血量分支（满血 return 1），不经过 combat 钩子
    expect(fightMul).toBeCloseTo(1, 5);
  });
});

describe('combat 战术包 —— 卸载与共存', () => {
  it('卸载 combat：无 4 卡、SER_DEFEND 系列从抽卡池消失，世界照跑', () => {
    const reg = ModRegistry.mountPacks([buildingPack, raidPack]);
    for (const id of ['hold', 'focus', 'flank', 'rally']) {
      expect(reg.cardById(id), `${id} 应不存在`).toBeUndefined();
    }
    const s = new Sim({ seed: 42, registry: reg, pawnCount: 2 });
    expect(() => s.run(200)).not.toThrow();
    expect([...s.pawns()].length).toBeGreaterThan(0);
  });

  it('卸载 combat 后 raid 的 fight/flee 仍在池里（战术层是可拆卸的加层）', () => {
    const reg = ModRegistry.mountPacks([buildingPack, raidPack]);
    expect(reg.cardById('fight')).toBeDefined();
    expect(reg.cardById('flee')).toBeDefined();
  });

  it('卸载 fortify（无哨塔）时 hold/flank 仍能用火堆兜底（跨包语义：据点 = K_TAG_FIRE ∨ K_TAG_TOWER）', () => {
    const reg = ModRegistry.mountPacks([buildingPack, raidPack, combatPack]);
    const s = new Sim({ seed: 7, registry: reg, pawnCount: 1 });
    s.addBuilding('campfire', 0, 0);
    const p = [...s.pawns()][0];
    p.pos = { x: 3, y: 3 };
    expect(card(reg, 'hold').condition!(p as unknown as PawnState, s as unknown as SimContext)).toBe(true);
    cat(s, 5, 0);
    expect(card(reg, 'flank').condition!(p as unknown as PawnState, s as unknown as SimContext)).toBe(true);
  });

  it('哨塔（K_TAG_TOWER）也能当据点（fortify 包挂载后）', () => {
    // 手动注册一个带 K_TAG_TOWER 的建筑，模拟 fortify 包的效果
    const reg = ModRegistry.mountPacks([buildingPack, raidPack, combatPack]);
    reg.registerBuilding({
      id: 'test_tower',
      name: '测试哨塔',
      cost: { wood: 8 },
      w: 1,
      h: 1,
      hp: 60,
      passable: true,
      tags: ['tower'],
    });
    const s = new Sim({ seed: 7, registry: reg, pawnCount: 1 });
    s.addBuilding('test_tower', 0, 0);
    const p = [...s.pawns()][0];
    p.pos = { x: 3, y: 3 };
    expect(card(reg, 'hold').condition!(p as unknown as PawnState, s as unknown as SimContext)).toBe(true);
  });

  it('存读档：本包全状态走 scratch（本包实际零 scratch 键），续跑不报错', () => {
    const reg = ModRegistry.mountPacks([buildingPack, raidPack, combatPack]);
    const s = new Sim({ seed: 7, registry: reg, pawnCount: 1 });
    s.addBuilding('campfire', 0, 0);
    s.run(50);
    const snap = snapshotOf(s);
    const s2 = loadSim(snap, reg);
    expect(() => s2.run(50)).not.toThrow();
  });
});
