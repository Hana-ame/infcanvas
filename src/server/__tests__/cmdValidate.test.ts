// server 命令权威校验（P2 联机安全）：形状/范围/pawnId/频率；执行合法性由 sim 把关
import { describe, it, expect } from 'vitest';
import { Sim } from '../../sim/sim';
import { validateCommand, allowRate, type CmdGuardState } from '../cmdValidate';

function fresh() {
  const sim = new Sim({ seed: 5, pawnCount: 2 });
  const guard: CmdGuardState = { lastCmdAt: 0, budget: 30 };
  return { sim, guard };
}

describe('validateCommand（P2 权威校验）', () => {
  it('合法命令放行（build/oracle/assign 带坐标，move/mine 带 pawnId）', () => {
    const { sim, guard } = fresh();
    expect(validateCommand(sim, { type: 'build', x: 5, y: 5, buildingId: 'campfire' }, guard, 1000).ok).toBe(true);
    expect(validateCommand(sim, { type: 'oracle', x: 3, y: 3 }, guard, 1100).ok).toBe(true);
    expect(validateCommand(sim, { type: 'assign', job: 'lumberjack', pawnId: sim.pawns[0] }, guard, 1200).ok).toBe(true);
    expect(validateCommand(sim, { type: 'assign', job: '', pawnId: sim.pawns[1] }, guard, 1300).ok).toBe(true);
    expect(validateCommand(sim, { type: 'move', x: 2, y: 2, pawnId: sim.pawns[0] }, guard, 1400).ok).toBe(true);
    expect(validateCommand(sim, { type: 'mine', x: 2, y: 2, pawnId: sim.pawns[1] }, guard, 1500).ok).toBe(true);
  });

  it('非法类型/形状/坐标越界拒绝', () => {
    const { sim, guard } = fresh();
    expect(validateCommand(sim, { type: 'DROP TABLE' }, guard, 1000).ok).toBe(false);
    expect(validateCommand(sim, { type: 'oracle', x: -1, y: 0 }, guard, 1100).ok).toBe(false);
    expect(validateCommand(sim, { type: 'build', x: 99999, y: 0, buildingId: 'campfire' }, guard, 1200).ok).toBe(false);
    expect(validateCommand(sim, { type: 'move', x: 'a', y: 0, pawnId: sim.pawns[0] }, guard, 1300).ok).toBe(false);
    expect(validateCommand(sim, { type: 'move', x: 0, y: 0, pawnId: 999 }, guard, 1400).ok).toBe(false); // 不存在 pawn
    expect(validateCommand(sim, { type: 'build', x: 0, y: 0, buildingId: 'not-a-building' }, guard, 1500).ok).toBe(false);
    expect(validateCommand(sim, { type: 'assign', job: 'hack', pawnId: sim.pawns[0] }, guard, 1600).ok).toBe(false);
  });

  it('move/mine 必须显式 pawnId（观察模式无 selected 镜像）', () => {
    const { sim, guard } = fresh();
    // 不传 pawnId → 拒绝（否则 server 端 selected 为空，命令静默无效，属协议漏洞）
    expect(validateCommand(sim, { type: 'move', x: 1, y: 1 }, guard, 1000).ok).toBe(false);
    expect(validateCommand(sim, { type: 'mine', x: 1, y: 1 }, guard, 1100).ok).toBe(false);
  });

  it('频率闸：每秒最多 30 条，超出拒绝', () => {
    const { sim, guard } = fresh();
    for (let i = 0; i < 30; i++) {
      expect(validateCommand(sim, { type: 'move', x: 1, y: 1, pawnId: sim.pawns[0] }, guard, 5000 + i).ok).toBe(true);
    }
    expect(validateCommand(sim, { type: 'move', x: 1, y: 1, pawnId: sim.pawns[0] }, guard, 5030).ok).toBe(false);
    // 令牌按时间线性回收：1ms 只回 0.03 → 仍拒绝
    const g2: CmdGuardState = { lastCmdAt: 0, budget: 30 };
    for (let i = 0; i < 30; i++) validateCommand(sim, { type: 'move', x: 1, y: 1, pawnId: sim.pawns[0] }, g2, 100 + i);
    expect(validateCommand(sim, { type: 'move', x: 1, y: 1, pawnId: sim.pawns[0] }, g2, 100 + 30 + 1).ok).toBe(false); // 桶空 + 1ms 未恢复 → 拒
    const g3: CmdGuardState = { lastCmdAt: 0, budget: 30 };
    for (let i = 0; i < 30; i++) validateCommand(sim, { type: 'move', x: 1, y: 1, pawnId: sim.pawns[0] }, g3, 200 + i);
    expect(validateCommand(sim, { type: 'move', x: 1, y: 1, pawnId: sim.pawns[0] }, g3, 200 + 30 * 1000).ok).toBe(true); // 30s 后恢复放行
  });

  it('allowRate 独立刷新令牌', () => {
    const guard: CmdGuardState = { lastCmdAt: 0, budget: 0 };
    expect(allowRate(guard, 0)).toBe(false); // 空桶立刻拒绝
    guard.lastCmdAt = 0;
    guard.budget = 0;
    expect(allowRate(guard, 2000)).toBe(true); // 2s 未用 → 恢复 30+，放行
  });
});