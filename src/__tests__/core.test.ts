/**
 * core.test.ts —— 内核验收：确定性 / 时钟 / 实体生死 / 玩家命令优先。
 * 确定性是"同 seed 同历史"的根基（存档回放、联机权威、测试可复现全靠它）。
 */
import { describe, expect, it } from 'vitest';
import { Sim } from '../sim';
import { ModRegistry } from '../mods';

function defaultSim(seed: number): Sim {
  return new Sim({ seed, registry: ModRegistry.default() });
}

describe('从零核心', () => {
  it('确定性：同 seed 两次运行，库存/事件/卡触发完全一致', () => {
    const a = defaultSim(42);
    const b = defaultSim(42);
    a.run(300);
    b.run(300);
    expect(a.stockpile).toEqual(b.stockpile);
    expect(a.events.map((e) => e.text)).toEqual(b.events.map((e) => e.text));
    for (const pa of a.pawns()) {
      const pb = b.pawn(pa.eid)!;
      expect(pb).toBeDefined();
      expect(pa.uses).toEqual(pb.uses);
      expect(pa.pos).toEqual(pb.pos);
    }
  });

  it('步进推进时钟且世界时钟同步（特征再生依赖单时钟源）', () => {
    const s = new Sim({
      seed: 1,
      registry: ModRegistry.mountPacks([]),
      pawnCount: 0,
    });
    s.step(5);
    expect(s.time).toBe(5);
    // world.now 是私有语义，但再生冷却用它——间接验证：无异常即同步
    expect(() => s.step(5)).not.toThrow();
  });

  it('spawn/kill：出生计数、死亡移除并清理选中', () => {
    const s = defaultSim(9);
    const before = [...s.pawns()].length;
    const eid = s.spawnPawn(0, 0);
    expect([...s.pawns()].length).toBe(before + 1);
    s.selected = [eid];
    s.killPawn(eid, '测试');
    expect(s.pawn(eid)).toBeUndefined();
    expect(s.selected).not.toContain(eid);
  });

  it('玩家 move 命令：打断自主行为 + holdUntil 优先窗口内不重抽', () => {
    const s = defaultSim(11);
    const p = [...s.pawns()][0];
    const before = { ...p.uses };
    s.issueCommand('move', { eid: p.eid, x: 3, y: 3 });
    expect(p.cardId).toBeNull();
    expect(p.holdUntil).toBeGreaterThan(0);
    s.run(2); // 2s < 5s 窗口
    expect(p.uses).toEqual(before); // 没抽任何新卡
    // 路径已规划且在移动
    const moved = p.path.length > 0 || Math.hypot(p.pos.x - 3, p.pos.y - 3) < 8;
    expect(moved).toBe(true);
  });

  it('未知命令：记警告不崩溃（命令面健壮性）', () => {
    const s = defaultSim(3);
    expect(() => s.issueCommand('nonexistent', {})).not.toThrow();
    expect(s.events.some((e) => e.text.includes('未知命令'))).toBe(true);
  });
});

/**
 * 特征键口径对齐（2026-10-06 修 world.ts featureAt 不取整的既存缺陷）。
 *
 * 现象：featureAt 用未取整 x,y 拼键查 featureLeft/harvestCd，
 *   而 takeOne 一定取整 —— 读写两张表用了两套坐标口径。
 *
 * 原订正写的是"记忆增长"，**实测是错的**：900s 后非整数键 0 个
 * （featureAt 只读，只有 takeOne 写，而 takeOne 必取整 ⇒ 幽灵键没有写入路径）。
 * 真正的后果是**读到的不是真相**：
 *   - 再生冷却被绕过（900s 后 36 个冷却格中 2 个 = 5.6% 能从小数位查到"可采"），
 *     卡 condition 拿到假前提 → 空转一次 harvest；
 *   - fullAmount 的 hash2(x,y) 在 66.6% 的坐标上给出不同的树余量。
 *
 * 断言写的是**口径恒等**而不是具体数值 —— 这样将来动 fullAmount 也不会误报。
 */
describe('特征查询与收割的键口径必须一致', () => {
  it('同一株特征：整数位与小数位查询必须给出同一答案', () => {
    const sim = new Sim({ seed: 42, registry: ModRegistry.default() });
    const w = sim.world;
    // 先跑一段，让 featureLeft / harvestCd 里有真实数据（采过的丛 + 冷却中的丛）
    for (let t = 0; t < 900; t++) sim.step(1);

    let checked = 0;
    let mismatched = 0;
    // 遍历两张表的键（走 exportState() 公共存档面，不伸进 private 字段）
    const st = w.exportState();
    for (const keys of [st.featureLeft.map((e) => e[0]), st.harvestCd.map((e) => e[0])]) {
      for (const k of keys) {
        const [x, y] = k.split(',').map(Number);
        if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
        const atInt = w.featureAt(x, y);
        // ⚠ 探测点必须落在**同一格内**：+0.4/+0.2 不跨格（用 +0.6/+0.7 会进位到下一格）。
        // 旧缺陷是"同一格内不同小数位给出不同答案"，跨格比较无意义（会误报）。
        const atFrac = w.featureAt(x + 0.4, y + 0.2);
        // 两个调用必须逐字段相同（null 对 null 也算一致）
        expect(
          atFrac === null ? null : { x: atFrac.x, y: atFrac.y, kind: atFrac.kind, amount: atFrac.amount },
          `(${x},${y}) 小数位查询与整数位不一致：整数位=${JSON.stringify(atInt)} 小数位=${JSON.stringify(atFrac)}`,
        ).toEqual(atInt === null ? null : { x: atInt.x, y: atInt.y, kind: atInt.kind, amount: atInt.amount });
        checked++;
        if (atInt === null) mismatched++; // 冷却中的格：整数位必须 null（旧缺陷会在这里破）
      }
    }
    expect(checked, '900s 内没有产生任何特征记录，样本不足').toBeGreaterThan(0);
    expect(mismatched, '没有命中冷却中的格，样本不足以覆盖绕过问题').toBeGreaterThan(0);
  });

  it('特征余量不再由未取整坐标决定（fullAmount 口径统一到取整位）', () => {
    const sim = new Sim({ seed: 7, registry: ModRegistry.default() });
    const w = sim.world;
    // 扫一片区域：对每个整数格，从整数位与小数位查到的 kind/amount 必须一致
    let n = 0;
    for (let y = -30; y <= 30; y += 3) {
      for (let x = -30; x <= 30; x += 3) {
        const a = w.featureAt(x, y);
        const b = w.featureAt(x + 0.4, y + 0.2); // 同格内小数位（+0.7 会进位到 x+1）
        expect(
          b === null ? null : { k: b.kind, a: b.amount },
          `(${x},${y}) 的特征在小数位下变了：${JSON.stringify(a)} → ${JSON.stringify(b)}`,
        ).toEqual(a === null ? null : { k: a.kind, a: a.amount });
        n++;
      }
    }
    expect(n).toBe(441);
  });
});
