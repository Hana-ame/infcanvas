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
    // 负坐标合法（2026-08-15 无限地图：命令可作用负区，范围 ±MAX_TILE）——越界只拒超范围
    expect(validateCommand(sim, { type: 'oracle', x: -5, y: 3 }, guard, 1100).ok).toBe(true);
    expect(validateCommand(sim, { type: 'build', x: 3_000_000_000, y: 0, buildingId: 'campfire' }, guard, 1200).ok).toBe(false); // 超 ±MAX_TILE
    expect(validateCommand(sim, { type: 'move', x: 'a', y: 0, pawnId: sim.pawns[0] }, guard, 1300).ok).toBe(false);
    expect(validateCommand(sim, { type: 'move', x: 0, y: 0, pawnId: 999 }, guard, 1400).ok).toBe(false); // 不存在 pawn
    expect(validateCommand(sim, { type: 'build', x: 0, y: 0, buildingId: 'not-a-building' }, guard, 1500).ok).toBe(false);
    expect(validateCommand(sim, { type: 'assign', job: 'hack', pawnId: sim.pawns[0] }, guard, 1600).ok).toBe(false);
  });

  it('命令面动态化：玩法包命令（wear）放行、未注册命令拒绝（2026-08-15 审计）', () => {
    // 发现背景（2026-08-15 审计）：validateCommand 曾硬编码 CMD_TYPES
    // （build/oracle/assign/move/mine）——命令协议开放后 clothing 的 wear 命令被服务端
    // 拒绝 = 远程联机无法穿衣。修复：白名单 = sim.mods.commandHandlers（引擎内建 +
    // 玩法包 registerCommand 动态面）。
    const { sim, guard } = fresh();
    // wear 由 clothing 玩法包注册（默认装配）；hud 发 wear 带 x:0/y:0 占位
    expect(validateCommand(sim, { type: 'wear', x: 0, y: 0, pawnId: sim.pawns[0], args: { itemId: 'peltShirt' } }, guard, 1000).ok).toBe(true);
    expect(validateCommand(sim, { type: 'wear', x: 0, y: 0, pawnId: sim.pawns[0], args: { itemId: 'red_peltShirt' } }, guard, 1100).ok).toBe(true);
    // 未注册命令 → 拒绝
    expect(validateCommand(sim, { type: 'hack-the-planet' }, guard, 1200).ok).toBe(false);
    // wear 不存在的 pawn → 拒绝
    expect(validateCommand(sim, { type: 'wear', x: 0, y: 0, pawnId: 999, args: { itemId: 'peltShirt' } }, guard, 1300).ok).toBe(false);
  });

  it('负坐标命令（move/build/mine）放行（2026-08-15 无限地图负区）', () => {
    const { sim, guard } = fresh();
    expect(validateCommand(sim, { type: 'move', x: -10, y: -8, pawnId: sim.pawns[0] }, guard, 1000).ok).toBe(true);
    expect(validateCommand(sim, { type: 'build', x: -3, y: 2, buildingId: 'campfire' }, guard, 1100).ok).toBe(true);
    expect(validateCommand(sim, { type: 'mine', x: 0, y: -5, pawnId: sim.pawns[1] }, guard, 1200).ok).toBe(true);
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