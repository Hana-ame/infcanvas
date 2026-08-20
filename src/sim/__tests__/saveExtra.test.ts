// 存档扩展点：mod 自定义字段随档持久（2026-08-14）
// 背景：插件化大系统（电力/温度/医疗/囚犯等）需要自由读写 pawnStates 与建筑实体的
// 自定义字段，而 save() 只序列化显式字段表——mod 状态一存档就丢（如伤口列表、电网账户）。
// 修复：① PawnState.extra / BuildingData.extra（Record<string, unknown>，JSON-safe 契约）；
// ② save() 原样序列化、load() 原样还原；③ placeBuilding 可选 extra 参数。
// 本文件即该扩展点的回归保护：mod 字段必须能跨 save→load 往返，且旧档（无 extra）不崩。
import { describe, it, expect } from 'vitest';
import { Sim, SAVE_VERSION, SAVE_MIGRATIONS } from '../sim';
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

  // ---- 2026-08-20 审查修复回归 ----

  it('读档：pawn 在原坐标不可走（越界/水上/被建筑覆盖）→ 就近可走格安置，不静默失踪', () => {
    // 发现背景：load() 里 spawnPawn 返 -1 直接 continue——存档坐标漂移（站在水上/
    // 旧档坐标溢出/建筑重建后脚下被占）的小人读档后静默消失，玩家无任何提示。
    const sim = new Sim({ registry: ModRegistry.default(), pawnCount: 2, seed: 8 });
    sim.step(1);
    const data = sim.save();
    // 把两个小人都挪到不可走位置：越界格 + 水上格（找一块水面）
    const app = data.pawns as unknown as { x: number; y: number }[];
    app[0].x = -50; app[0].y = -50; // 越界
    let wx = 0, wy = 0;
    for (let x = 0; x < sim.world.width; x++) for (let y = 0; y < sim.world.height; y++) {
      if (sim.world.getTileDef(x, y).id === 'water') { wx = x; wy = y; break; }
    }
    app[1].x = wx; app[1].y = wy; // 水上（不可走）
    const sim2 = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 96 });
    sim2.load(data);
    // 救援成功：人数不丢、位置都在可走格上
    expect(sim2.pawns.length).toBe(2);
    for (const eid of sim2.pawns) {
      const pos = sim2.readPosition(eid)!;
      expect(sim2.world.inBounds(pos.x, pos.y)).toBe(true);
      expect(sim2.world.isPassable(pos.x, pos.y, undefined, sim2.tuning.pawn.climb)).toBe(true);
    }
    // 无"无处安置"告警（都能救回）
    expect(sim2.events.some((e) => e.text.includes('无处安置'))).toBe(false);
  });

  it('读档：pawn 完全无处安置（救援半径内无可走格）→ 带告警跳过，不静默', () => {
    const sim = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 9 });
    sim.step(1);
    const data = sim.save();
    // pawn 放在越界坐标（|x| > MAX_TILE → inBounds false）：spawnPawn 与救援 findNearest
    // 都以 inBounds 为前提 → 无可救 → 跳过但带告警。
    // 注意：不能用水域覆盖层模拟（load 会 loadChunks 清掉手工 setTile），也不能用 (-1,-1)
    // （无限地图 inBounds 恒 true，负坐标是合法的）；MAX_TILE 是唯一边界
    const app = data.pawns as unknown as { x: number; y: number }[];
    app[0].x = 2 ** 21 + 500; app[0].y = 2 ** 21 + 500; // 地图边界之外
    const sim2 = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 95 });
    sim2.load(data);
    // 该小人被跳过，但**带日志告警**（不静默失踪）
    expect(sim2.pawns.length).toBe(0);
    expect(sim2.events.some((e) => e.text.includes('无处安置'))).toBe(true);
  });

  // ---- 2026-08-20 架构优化：存档版本化回归 ----

  it('存档版本：save 写入 SAVE_VERSION，load 往返保留', () => {
    const sim = new Sim({ registry: ModRegistry.default(), pawnCount: 2, seed: 10 });
    sim.step(1);
    const data = sim.save();
    // 当前版本写入存档（版本字段 = save 的组成部分）
    expect(data.saveVersion).toBe(SAVE_VERSION);
    // 往返：load 新实例后 save 仍是同一版本
    const sim2 = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 94 });
    sim2.load(data);
    expect(sim2.save().saveVersion).toBe(SAVE_VERSION);
  });

  it('存档版本：saveVersion 缺省视为 0（旧档照常可载，各缺省语义生效）', () => {
    const sim = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 11 });
    sim.step(1);
    const data = sim.save() as { saveVersion?: number } & ReturnType<Sim['save']>;
    delete data.saveVersion; // 模拟 2026-08-20 前的旧档（无版本字段）
    const sim2 = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 93 });
    // 旧档不崩、小人照常还原（兼容逻辑 = 缺省语义处理，见 SAVE_MIGRATIONS 注释）
    expect(() => sim2.load(data)).not.toThrow();
    expect(sim2.pawns.length).toBe(1);
  });

  it('存档版本：未来版本（> SAVE_VERSION）拒载——防新格式被旧版读损坏', () => {
    // 背景：此前存档无版本概念，未来格式一旦变更，旧版读取 = 静默错读（字段错位/
    // 半解析）。版本化后旧版拒载并显式报错——宁可打不开也不损坏。
    const sim = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 12 });
    sim.step(1);
    const data = sim.save() as { saveVersion?: number } & ReturnType<Sim['save']>;
    data.saveVersion = SAVE_VERSION + 1; // 模拟未来版本存档
    const sim2 = new Sim({ registry: ModRegistry.default(), pawnCount: 1, seed: 92 });
    expect(() => sim2.load(data)).toThrow(/高于本构建支持的/);
  });

  it('存档版本：迁移表索引与版本号对齐（登记性）', () => {
    // SAVE_MIGRATIONS[i] = "版本 i → i+1" 的迁移；load 循环 for (v = loadVersion; v <
    // SAVE_VERSION; v++) 取 SAVE_MIGRATIONS[v]。必须有挂载位（可为显式 no-op）——
    // 防"号涨了但迁移没挂"的静默降级（每个空位都是一次无重写迁移的诚实声明）
    expect(SAVE_MIGRATIONS.length).toBe(SAVE_VERSION);
  });
});