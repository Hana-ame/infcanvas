// server 命令权威校验（P2 联机安全）：client 命令只做形状/范围/身份检查，
// 实际执行合法性（可建性/资源/矿物）由 sim 自身把关（queueBuild/oracleInfluence/mineAt 已校验）。
// 校验失败 → 丢弃并记录（不踢连接，容忍乱发）。
import type { Sim } from '../sim/sim';
import { JOB_CARD } from '../sim/ai/pawn';

export interface CmdGuardState {
  lastCmdAt: number;
  budget: number; // 令牌桶剩余
}

const CMD_TYPES = new Set(['build', 'oracle', 'assign', 'move', 'mine']);
const MAX_RATE = 30; // 每 client 每秒命令数上限（令牌桶）
const RATE_WINDOW = 1000;

// 频率闸：返回是否放行（每秒 MAX_RATE 条）
export function allowRate(st: CmdGuardState, now: number): boolean {
  const elapsed = now - st.lastCmdAt;
  st.budget = Math.min(MAX_RATE, st.budget + (elapsed / RATE_WINDOW) * MAX_RATE);
  st.lastCmdAt = now;
  if (st.budget < 1) return false;
  st.budget -= 1;
  return true;
}

export function validateCommand(sim: Sim, raw: unknown, guard: CmdGuardState, now: number): { ok: boolean; reason?: string } {
  if (!allowRate(guard, now)) return { ok: false, reason: 'rate limited' };
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'not an object' };
  const c = raw as Record<string, unknown>;
  if (typeof c.type !== 'string' || !CMD_TYPES.has(c.type)) return { ok: false, reason: `unknown command type` };

  const fail = (r: string) => ({ ok: false, reason: r });
  const isCoord = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
    && v >= 0 && v < sim.world.width && v < sim.world.height;
  const isPawn = (v: unknown): boolean => typeof v === 'number' && sim.pawnList.includes(v);

  if (c.type === 'build' || c.type === 'oracle') {
    if (!isCoord(c.x) || !isCoord(c.y)) return fail('bad coords');
    if (c.type === 'build' && !(typeof c.buildingId === 'string' && c.buildingId in sim.mods.buildings)) {
      return fail('unknown buildingId');
    }
    return { ok: true };
  }
  if (c.type === 'assign') {
    if (c.job !== '' && !(typeof c.job === 'string' && c.job in JOB_CARD)) return fail('unknown job');
    return { ok: true };
  }
  // move / mine：必须显式 pawnId（观察模式 server 无 selected 镜像，命令只允许指挥存在的 pawn）
  if (!isCoord(c.x) || !isCoord(c.y)) return fail('bad coords');
  if (!isPawn(c.pawnId)) return fail('bad pawnId');
  return { ok: true };
}