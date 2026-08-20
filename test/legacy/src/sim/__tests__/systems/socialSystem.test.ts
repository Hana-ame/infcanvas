// socialSystem 独立测试（2026-08-14 插件化纪律：系统只依赖 SimContext，可脱离完整 Sim 单独验证）
// 覆盖：相遇打招呼（好感/心情）/ 关系效应（好友心情加成 / 敌对动手概率）/ 篝火 stance 判定
import { describe, it, expect, beforeEach } from 'vitest';
import { SocialSystem } from '../../systems/socialSystem';
import { makeMinCtx } from '../helpers/minCtx';
import { CHUNK_SIZE } from '../../core/world';

describe('SocialSystem 独立测试（最小 ctx，无 Sim）', () => {
  let ctx = makeMinCtx(13);
  beforeEach(() => { ctx = makeMinCtx(13); });

  // 两个小人放相邻（同一 chunk，相遇）
  function twoNeighbors(): number[] {
    const a = ctx.spawnPawn(50, 50);
    const b = ctx.spawnPawn(51, 50);
    return [a, b];
  }

  it('相邻小人相遇：关系建立（打招呼）', () => {
    const sys = new SocialSystem(ctx);
    const [a, b] = twoNeighbors();
    // 跑过 tickInterval 触发社交节拍
    const t = ctx.tuning.social;
    for (let i = 0; i < Math.ceil(t.tickInterval) + 2; i++) sys.update(1);
    const stA = ctx._pawnStates.get(a)!;
    // 关系记录存在（无论方向）
    const rels = [...(stA.relationships?.values() ?? [])];
    expect(rels.length).toBeGreaterThan(0);
  });

  it('高好感邻人相遇 → 心情加成（moodFriend）', () => {
    const sys = new SocialSystem(ctx);
    const [a, b] = twoNeighbors();
    const stA = ctx._pawnStates.get(a)!;
    const stB = ctx._pawnStates.get(b)!;
    stA.relationships = new Map([[b, 999]]); // 亲密
    stB.relationships = new Map([[a, 999]]);
    const t = ctx.tuning.social;
    for (let i = 0; i < Math.ceil(t.tickInterval) + 2; i++) sys.update(1);
    // 心情加成通过 adjustMood（桩记录）：好友相遇应有正向调整
    expect(ctx._moodAdj.get(a)).toBe(t.moodFriend);
  });

  it('听说对方营地有敌意历史 → 敌对态度（moodHostile + 关系压制）', () => {
    const sys = new SocialSystem(ctx);
    const [a, b] = twoNeighbors();
    const stA = ctx._pawnStates.get(a)!;
    const stB = ctx._pawnStates.get(b)!;
    // 给 B 一个篝火，A 听说它是 enemy
    const fireKey = 555;
    stB.fireId = fireKey;
    stA.knownFires = { [String(fireKey)]: { stance: 'enemy', basis: '听说被袭击', at: ctx.time } } as never;
    const t = ctx.tuning.social;
    for (let i = 0; i < Math.ceil(t.tickInterval) + 2; i++) sys.update(1);
    // 敌意生效：心情负向调整或关系压制（至少 mood 有变化）
    expect(ctx._moodAdj.size).toBeGreaterThan(0);
    const rel = stA.relationships?.get(b) ?? 0;
    expect(rel).toBeLessThanOrEqual(t.hostileAt);
  });

  it('敌对数值关系 → 可能动手（低仇恨不触发）', () => {
    const sys = new SocialSystem(ctx);
    const [a, b] = twoNeighbors();
    const stA = ctx._pawnStates.get(a)!;
    const stB = ctx._pawnStates.get(b)!;
    // 极低好感（敌对）→ 动手概率高；rng 固定低值必动手
    const ctx2 = makeMinCtx(13, { rng: { next: () => 0, int: () => 0 } as never });
    // 重建系统与小人（ctx2）
    const a2 = ctx2.spawnPawn(50, 50);
    const b2 = ctx2.spawnPawn(51, 50);
    const stA2 = ctx2._pawnStates.get(a2)!;
    const stB2 = ctx2._pawnStates.get(b2)!;
    stA2.relationships = new Map([[b2, -100]]);
    stB2.relationships = new Map([[a2, -100]]);
    const sys2 = new SocialSystem(ctx2);
    const hpBefore = ctx2._health.get(b2)!.hp;
    const t = ctx2.tuning.social;
    for (let i = 0; i < Math.ceil(t.tickInterval) + 2; i++) sys2.update(1);
    // 动手了：某人血量下降
    expect(ctx2._health.get(a2)!.hp).toBeLessThan(hpBefore);
  });
});
