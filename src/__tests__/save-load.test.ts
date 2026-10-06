/**
 * save-load.test.ts —— 阶段④存档：往返完整 / 确定性续跑对拍 / 版本化拒载 / 运行态随档。
 */
import { describe, expect, it } from 'vitest';
import { Sim, snapshotOf, loadSim, migrate, SAVE_VERSION, SAVE_MIGRATIONS } from '../sim';
import { ModRegistry } from '../mods';

function defaultSim(seed = 42): Sim {
  return new Sim({ seed, registry: ModRegistry.default() });
}

describe('存档/读档', () => {
  it('确定性续跑：读档后继续跑 ≡ 不中断一直跑（逐字段对拍）', () => {
    // 连续跑 500s
    const continuous = defaultSim(7);
    continuous.run(500);
    // 分段：跑 200s → 存档 → 读档 → 续 300s
    const split = defaultSim(7);
    split.run(200);
    const saved = snapshotOf(split);
    const restored = loadSim(JSON.parse(JSON.stringify(saved)), ModRegistry.default());
    restored.run(300);

    expect(restored.time).toBe(continuous.time);
    expect(restored.stockpile).toEqual(continuous.stockpile);
    expect(restored.pawnMap.size).toBe(continuous.pawnMap.size);
    for (const p of continuous.pawns()) {
      const q = restored.pawn(p.eid)!;
      expect(q).toBeDefined();
      expect(q.pos).toEqual(p.pos);
      expect(q.needs).toEqual(p.needs);
      expect(q.uses).toEqual(p.uses); // 抽卡历史一致 = 决策路径一致
      expect(q.mastery).toEqual(p.mastery);
    }
    expect(restored.hostiles().map((h) => h.id)).toEqual(continuous.hostiles().map((h) => h.id));
    expect(restored.events.map((e) => e.text)).toEqual(continuous.events.map((e) => e.text));
    // 敌袭压力运行态随档：读档后再跑，出猫时刻与连续局一致
    expect(restored.scratch['raid.pressure']).toBeCloseTo(continuous.scratch['raid.pressure'], 10);
  });

  it('特征再生状态随档：采空冷却中的浆果丛读档后依然在冷却', () => {
    const s = defaultSim(8);
    const f = s.nearestFeature('berry', 0, 0, 40)!;
    // 直接采空制造冷却
    while (s.takeOne(f.x, f.y) > 0);
    expect(s.featureAt(f.x, f.y)).toBeNull();
    const restored = loadSim(JSON.parse(JSON.stringify(snapshotOf(s))), ModRegistry.default());
    expect(restored.featureAt(f.x, f.y)).toBeNull(); // 冷却未丢
    restored.world.now += restored.tuning.world.harvestRegenSec + 1;
    expect(restored.featureAt(f.x, f.y)).not.toBeNull(); // 到期照常再生
  });

  it('版本化：拒载未来版本；迁移表长度=当前版本号（登记性）', () => {
    const raw = { ...snapshotOf(defaultSim(1)), saveVersion: SAVE_VERSION + 99 };
    expect(() => migrate(raw)).toThrow(/版本过新/);
    expect(SAVE_MIGRATIONS).toHaveLength(SAVE_VERSION);
  });

  it('坏档拒载：缺 saveVersion 直接抛错不静默', () => {
    expect(() => migrate({ foo: 1 })).toThrow(/saveVersion/);
  });

  it('JSON 往返无损：snapshot → stringify → parse → load 字段全等', () => {
    const s = defaultSim(9);
    s.run(120);
    const round = JSON.parse(JSON.stringify(snapshotOf(s)));
    const r = loadSim(round, ModRegistry.default());
    expect(snapshotOf(r)).toEqual(snapshotOf(s));
  });
});
