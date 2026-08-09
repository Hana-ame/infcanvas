// tick delta（P2 增量）纯函数测试：diff 只含变化、身份对齐、增删、null 无变化
import { describe, it, expect } from 'vitest';
import { buildDelta } from '../diff';
import type { SnapshotMsg, DeltaMsg } from '../../shared/protocol';

function snap(over: Partial<SnapshotMsg> = {}): SnapshotMsg {
  return {
    type: 'snapshot', t: 100, paused: false, speed: 1, isNight: false, day: 2,
    weather: { raining: false, temperature: 18 },
    stockpile: { wood: 10 },
    pawns: [{ eid: 1, x: 5, y: 5, hp: 50, maxHp: 50, job: '伐木', faith: 0.2, attrs: { str: 10, con: 10, siz: 10, dex: 10, int: 10, pow: 10, app: 10, edu: 10 }, skills: { work: 20 }, traits: [], maxSlots: 3, slots: [{ id: 'eat', name: '进食' }], desires: { gluttony: 0 } }],
    hostiles: [{ i: 0, x: 20, y: 20, hp: 10, maxHp: 10 }],
    buildings: [{ defId: 'campfire', x: 3, y: 3, hp: 100, maxHp: 100, faction: 'a', footprint: [{ x: 3, y: 3 }] }],
    buildQueue: [], buildingVersion: 1,
    ...over,
  };
}

describe('buildDelta（P2 增量）', () => {
  it('无变化 → null（不发空包）', () => {
    expect(buildDelta(snap(), snap())).toBeNull();
  });

  it('pawn 位置变化 → 只带该 pawn 的 x/y（其它字段不出现）', () => {
    const cur = snap();
    cur.pawns[0]!.x = 6;
    cur.pawns[0]!.y = 7;
    cur.t = 100.5;
    const d = buildDelta(snap(), cur)!;
    expect(d.type).toBe('delta');
    expect(d.pawns).toHaveLength(1);
    expect(d.pawns![0]).toEqual({ eid: 1, x: 6, y: 7 });
    expect(d.pawns![0]).not.toHaveProperty('hp');
    expect(d.pawns![0]).not.toHaveProperty('job');
    expect(d.hostiles).toBeUndefined();
    expect(d.buildings).toBeUndefined();
    expect(d.stockpile).toBeUndefined();
  });

  it('全局字段/需求/欲望变化各自携带', () => {
    const cur = snap({ isNight: true, day: 3, stockpile: { wood: 10, food: 5 } });
    cur.pawns[0]!.needs = { food: 30, rest: 40, mood: 70, san: 80 };
    cur.pawns[0]!.desires = { gluttony: 0.4 };
    const d = buildDelta(snap(), cur)!;
    expect(d.isNight).toBe(true);
    expect(d.day).toBe(3);
    expect(d.stockpile).toEqual({ wood: 10, food: 5 });
    expect(d.pawns![0]!.needs).toEqual({ food: 30, rest: 40, mood: 70, san: 80 });
    expect(d.pawns![0]!.desires).toEqual({ gluttony: 0.4 });
    expect(d.pawns![0]).not.toHaveProperty('x');
  });

  it('新 pawn → 必带 attrs 全量；死亡 pawn → removed + pawnList', () => {
    const cur = snap();
    cur.pawns.push({ eid: 2, x: 1, y: 1, hp: 40, maxHp: 50, job: '闲逛', faith: 0, attrs: { str: 12, con: 11, siz: 10, dex: 9, int: 10, pow: 11, app: 8, edu: 12 }, skills: {}, traits: [], maxSlots: 3, slots: [], desires: {} });
    const d = buildDelta(snap(), cur)!;
    expect(d.pawns!.find((p) => p.eid === 2)!.attrs!.str).toBe(12);
    expect(d.pawns!.find((p) => p.eid === 2)!.hp).toBe(40);
    expect(d.pawnList).toEqual([1, 2]);
    // 死亡：新 pawn 从世界消失
    const gone = snap();
    const d2 = buildDelta(cur, gone)!;
    expect(d2.pawns!.find((p) => p.eid === 2)!.removed).toBe(true);
    expect(d2.pawnList).toEqual([1]);
  });

  it('建筑：hp 变化带整条；拆除 → removed；无变化不带', () => {
    const cur = snap();
    cur.buildings[0]!.hp = 60;
    cur.buildingVersion = 2;
    const d = buildDelta(snap(), cur)!;
    expect(d.buildings![0]).toMatchObject({ key: 3 + 3 * 1000000, defId: 'campfire', hp: 60 });
    expect(d.buildingVersion).toBe(2);
    // 拆除：建筑从世界消失
    const gone = { ...snap(), buildings: [] as SnapshotMsg['buildings'] };
    const d2 = buildDelta(cur, gone)!;
    expect(d2.buildings!.find((b) => b.key === 3 + 3 * 1000000)!.removed).toBe(true);
  });

  it('首份快照（prev=null）→ fullDelta 全量收敛', () => {
    const s = snap();
    const d = buildDelta(null, s)!;
    expect(d.pawns!.find((p) => p.eid === 1)!.attrs).toBeDefined();
    expect(d.pawnList).toEqual([1]);
    expect(d.buildings![0]!.key).toBe(3 + 3 * 1000000);
    expect(d.hostiles).toHaveLength(1);
  });

  it('hostiles 变化 → 整体覆盖（数量少，不逐条 diff）', () => {
    const cur = snap();
    cur.hostiles[0]!.hp = 3;
    const d = buildDelta(snap(), cur)!;
    expect(d.hostiles).toEqual(cur.hostiles);
  });
});