// pushHostile 共享敌人生成入口测试（2026-08-20 审计 L6）：
// raid/wildmouse/hg 原各自手工快照 EnemyDef 字段 → 增字段静默漂移；
// 收口后 = 一处构造透传全字段。本测试守护 helper 语义。
import { describe, it, expect } from 'vitest';
import { makeMinCtx } from '../helpers/minCtx';
import { pushHostile } from '../../systems/hostiles';
import type { EnemyDef } from '../../defs/enemies';

const cat: EnemyDef = {
  id: 'cat', name: '野猫', hp: 40, speed: 3.5, climb: 1, dmg: 5,
  faction: 'wild', loot: { item: 'ore', amount: 2 },
};

describe('pushHostile（共享敌人生成入口，审计 L6，2026-08-20）', () => {
  it('默认：字段全部来自 enemy 快照，target 缺省 = 出生点', () => {
    const ctx = makeMinCtx(1);
    pushHostile(ctx, cat, 10, 20);
    expect(ctx.hostiles).toHaveLength(1);
    const h = ctx.hostiles[0]!;
    expect(h.enemyId).toBe('cat');
    expect(h.name).toBe('野猫');
    expect(h.speed).toBe(3.5);
    expect(h.dmgPerSec).toBe(5);
    expect(h.loot).toEqual({ item: 'ore', amount: 2 });
    expect(h.faction).toBe('wild');
    expect(h.x).toBe(10);
    expect(h.y).toBe(20);
    expect(h.targetX).toBe(10); // 缺省 target = x/y
    expect(h.targetY).toBe(20);
    expect(h.hp).toBe(40);
    expect(h.maxHp).toBe(40);
  });

  it('hpMul 放大（叙事压力）与 targetX/Y 指定', () => {
    const ctx = makeMinCtx(2);
    pushHostile(ctx, cat, 1, 2, { targetX: 5, targetY: 6, hpMul: 1.5 });
    const h = ctx.hostiles[0]!;
    expect(h.hp).toBe(60);
    expect(h.maxHp).toBe(60);
    expect(h.targetX).toBe(5);
    expect(h.targetY).toBe(6);
  });

  it('EnemyDef 增字段自动透传（L6 核心：不再逐处手工重抄字段）', () => {
    const ctx = makeMinCtx(3);
    const predator: EnemyDef = { ...cat, predator: true, carrySpeedMul: 2 };
    pushHostile(ctx, predator, 0, 0);
    const h = ctx.hostiles[0]! as unknown as Record<string, unknown>; // spread 后多余字段在 hostile 上
    expect(h.predator).toBe(true);
    expect(h.carrySpeedMul).toBe(2);
    expect(h.climb).toBe(1);
  });
});