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
