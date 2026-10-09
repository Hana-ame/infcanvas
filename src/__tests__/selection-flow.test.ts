/**
 * selection-flow.test.ts —— 选择态不可变快照契约测试（flow 线：单向数据流）。
 *
 * 测试项：
 *  1. EMPTY_SELECTION 初始态
 *  2. selectPawns 生成只含鼠的快照（清空建筑/敌袭）
 *  3. selectBuilding 生成只含建筑的快照（清鼠选）
 *  4. selectHostile 生成只含敌袭的快照（清鼠选）
 *  5. 快照不可变性（snapshot.pawns.add 应被 TS 阻止；运行时用 Object.isFrozen 验证）
 *  6. selectPawns 接收空集合 → pawns 为空
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, selectPawns, selectBuilding, selectHostile } from '../client/selection';

describe('SelectionSnapshot 不可变快照', () => {
  it('EMPTY_SELECTION 三空', () => {
    expect(EMPTY_SELECTION.pawns.size).toBe(0);
    expect(EMPTY_SELECTION.buildingId).toBeNull();
    expect(EMPTY_SELECTION.hostileId).toBeNull();
  });

  it('selectPawns 生成只含鼠的快照', () => {
    const snap = selectPawns([1, 2, 3]);
    expect(snap.pawns.has(1)).toBe(true);
    expect(snap.pawns.has(2)).toBe(true);
    expect(snap.pawns.has(3)).toBe(true);
    expect(snap.pawns.size).toBe(3);
    expect(snap.buildingId).toBeNull();
    expect(snap.hostileId).toBeNull();
  });

  it('selectBuilding 清鼠选 + 设建筑', () => {
    const snap = selectBuilding('campfire_42');
    expect(snap.pawns.size).toBe(0);
    expect(snap.buildingId).toBe('campfire_42');
    expect(snap.hostileId).toBeNull();
  });

  it('selectBuilding(null) 清鼠选 + 清建筑', () => {
    const snap = selectBuilding(null);
    expect(snap.pawns.size).toBe(0);
    expect(snap.buildingId).toBeNull();
    expect(snap.hostileId).toBeNull();
  });

  it('selectHostile 清鼠选 + 设敌袭', () => {
    const snap = selectHostile(7);
    expect(snap.pawns.size).toBe(0);
    expect(snap.buildingId).toBeNull();
    expect(snap.hostileId).toBe(7);
  });

  it('selectHostile(null) 清鼠选 + 清敌袭', () => {
    const snap = selectHostile(null);
    expect(snap.pawns.size).toBe(0);
    expect(snap.buildingId).toBeNull();
    expect(snap.hostileId).toBeNull();
  });

  it('selectPawns 空集合 → pawns 为空', () => {
    const snap = selectPawns([]);
    expect(snap.pawns.size).toBe(0);
    expect(snap.buildingId).toBeNull();
    expect(snap.hostileId).toBeNull();
  });

  it('每次调用返回新对象（不可变语义）', () => {
    const a = selectPawns([1]);
    const b = selectPawns([1]);
    // 不等（每次生成新的，不是缓存返回）
    expect(Object.is(a, b)).toBe(false);
    // 但值相等
    expect(a).toEqual(b);
  });

  it('EMPTY_SELECTION 是被冻结的（运行时不可修改）', () => {
    // Set 没有被冻结（JS 不允许冻结 Set），但对象本身是被冻住的
    // 对不可变快照的契约靠 TS 编译期保证；这里只验证结构
    const snap = EMPTY_SELECTION;
    expect(Object.isFrozen(snap)).toBe(true);
  });
});
