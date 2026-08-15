// 存档扩展点：mod 自定义字段随档持久（2026-08-14）
// 背景：插件化大系统（电力/温度/医疗/囚犯等）需要自由读写 pawnStates 与建筑实体的
// 自定义字段，而 save() 只序列化显式字段表——mod 状态一存档就丢（如伤口列表、电网账户）。
// 修复：① PawnState.extra / BuildingData.extra（Record<string, unknown>，JSON-safe 契约）；
// ② save() 原样序列化、load() 原样还原；③ placeBuilding 可选 extra 参数。
// 本文件即该扩展点的回归保护：mod 字段必须能跨 save→load 往返，且旧档（无 extra）不崩。
import { describe, it, expect } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods/registry';

describe('存档扩展点：mod 自定义字段随档', () => {
  it('pawn extra：save→load 往返原样还原（嵌套 JSON 结构）', () => {
    const sim = new Sim({ registry: ModRegistry.default(), pawnCount: 2, seed: 5 });
    sim.step(1);
    const eid = sim.pawnList[0];
    const st = sim.pawnStates.get(eid)!;
    // mod 系统写入任意 JSON-safe 结构（仿伤口列表：数组套对象 + 数值）
    st.extra = { wounds: [{ type: 'cut', hp: 30 }, { type: 'infection', hp: 12 }], noted: 1 };
    sim.step(1);
    const data = sim.save();
    const saved = data.pawns.find((p) => p.eid === eid)!;
    expect(saved.extra).toEqual({ wounds: [{ type: 'cut', hp: 30 }, { type: 'infection', hp: 12 }], noted: 1 });
    // 新实例 load 后 extra 逐字段还原（注意：load 重生成 eid，按列表顺序对应）
    const sim2 = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 99 });
    sim2.load(data);
    const st2 = sim2.pawnStates.get(sim2.pawnList[0])!;
    expect(st2.extra).toEqual(saved.extra);
    expect(st2.extra!.wounds).toHaveLength(2);
  });

  it('建筑 extra：save→load 往返 + placeBuilding 带 extra 建入', () => {
    const sim = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 6 });
    // 直接用一个已知可建点放测试建筑（placeBuilding 带 extra）
    const cx = Math.floor(sim.world.width / 2);
    const cy = Math.floor(sim.world.height / 2);
    expect(sim.world.placeBuilding(cx, cy, 'campfire', 'auto', { grid: { charge: 12.5 }, tags: ['test'] })).toBe(true);
    // 新 key 编码（2026-08-14 无限地图）：必须 buildKey（x + y*2^31，负坐标支持），
    // 不能用旧 y*width+x 编码——save/load 的 buildings 都用新 key
    const key = sim.world.buildKey(cx, cy);
    const b = sim.world.buildings.get(key)!;
    expect(b.extra).toEqual({ grid: { charge: 12.5 }, tags: ['test'] });
    const data = sim.save();
    const saved = data.buildings.find((x) => x.key === key)!;
    expect(saved.extra).toEqual({ grid: { charge: 12.5 }, tags: ['test'] });
    const sim2 = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 98 });
    sim2.load(data);
    expect(sim2.world.buildings.get(key)!.extra).toEqual({ grid: { charge: 12.5 }, tags: ['test'] });
  });

  it('旧档兼容：extra 缺失时 load 不崩、extra 为 undefined（不伪造 mod 状态）', () => {
    const sim = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 7 });
    sim.step(1);
    const data = sim.save() as unknown as { pawns: ({ extra?: never } & Record<string, unknown>)[] };
    for (const p of data.pawns) delete p.extra; // 模拟旧档无 extra 字段
    const sim2 = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 97 });
    expect(() => sim2.load(data as never)).not.toThrow();
    for (const eid of sim2.pawnList) {
      expect(sim2.pawnStates.get(eid)!.extra).toBeUndefined();
    }
  });
});