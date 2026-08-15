// server 命令权威校验（P2 联机安全）：client 命令只做形状/范围/身份检查，
// 实际执行合法性（可建性/资源/矿物）由 sim 自身把关（queueBuild/oracleInfluence/mineAt 已校验）。
// 校验失败 → 丢弃并记录（不踢连接，容忍乱发）。
// 2026-08-15 命令协议开放（Command.type 开放字符串 + 玩法包 registerCommand）后：
// 命令白名单 = sim.mods.commandHandlers（引擎内建 move + 玩法包注册 build/mine/wear…），
// 不再硬编码 CMD_TYPES 表——此前 wear（clothing 玩法包）被硬编码表拒绝 = 远程无法穿衣（审计发现）
import type { Sim } from '../sim/sim';
import { JOB_CARD } from '../sim/ai/pawn';
import { MAX_TILE } from '../sim/core/world';

export interface CmdGuardState {
  lastCmdAt: number;
  budget: number; // 令牌桶剩余
}

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
  // 命令面 = 注册表 ∪ 引擎内建 move（issueCommand 对 move 走硬编码分支，不进注册表）
  // （2026-08-15 命令协议开放后不再硬编码命令表；wear 等玩法包命令动态可用）
  const known = (type: string): boolean => type === 'move' || sim.mods.commandHandlers.has(type);
  if (typeof c.type !== 'string' || !known(c.type)) {
    return { ok: false, reason: `unknown command type` };
  }

  const fail = (r: string) => ({ ok: false, reason: r });
  // 坐标校验支持负坐标（2026-08-15 无限地图双图层：命令可作用负区，范围 = ±MAX_TILE；
  // 此前 `v >= 0 && v < width` 拒绝负坐标 = 负区无法远程指挥）
  const isCoord = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
    && v >= -MAX_TILE && v <= MAX_TILE;
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
  // move/mine：坐标类命令强制合法坐标 + 显式 pawnId（观察模式 server 无 selected 镜像，
  // 命令只允许指挥存在的 pawn——pawnId 缺失/非法 = 协议漏洞静默无效，必须拒绝）
  if (c.type === 'move' || c.type === 'mine') {
    if (!isCoord(c.x) || !isCoord(c.y)) return fail('bad coords');
    if (!isPawn(c.pawnId)) return fail('bad pawnId');
    return { ok: true };
  }
  // 其余命令（wear 等玩法包命令，无坐标约定；hud 发 wear 带 x:0/y:0 占位）：校验 pawnId
  // 存在（若有该字段）即可，args/参数由处理器自身把关
  if (c.pawnId !== undefined && !isPawn(c.pawnId)) return fail('bad pawnId');
  return { ok: true };
}