// 敌人生成共享入口（2026-08-20 审计 L6）：raidSystem/wildmouse/hunter-gatherer
// 原各自手工快照 EnemyDef 字段构造 hostiles.push——EnemyDef 增字段（如 predator/
// climb/carrySpeedMul）不会自动透传，各处敌人行为静默漂移。统一收口到本函数：
// enemy 表增字段只需改这一处构造。纯函数、只依赖 SimContext——任何包可 import，
// 不构成系统/包级耦合。
import type { SimContext } from './context';
import type { EnemyDef } from '../defs/enemies';

export interface SpawnHostileOpts {
  targetX?: number;   // 目标点（缺省 = 出生点原地）
  targetY?: number;
  hpMul?: number;     // 血量倍率（叙事压力用：压力越高越凶猛）
}

// 敌人生成统一入口（spread EnemyDef 自动透传新字段 + hpMul/target 换算）
// 背景：原 raid/wildmouse/hg 三处手工快照 → 收口到此
export function pushHostile(ctx: SimContext, enemy: EnemyDef, x: number, y: number, opts: SpawnHostileOpts = {}): void {
  const mul = opts.hpMul ?? 1;
  // 先整体 spread enemy（L6 核心：EnemyDef 增字段——predator/climb/carrySpeedMul——
  // 自动透传进 hostile 快照，改一处即可；显式字段覆盖命中字段与换算）
  ctx.hostiles.push({
    ...enemy, // EnemyDef 新字段自动透传（审计 L6：此前 raid/wildmouse/hg 各挑字段
              // 重抄一份 = 增字段静默丢；现在一处收口，改 helper 即全包生效）
    x, y,
    hp: enemy.hp * mul, maxHp: enemy.hp * mul,
    targetX: opts.targetX ?? x, targetY: opts.targetY ?? y,
    enemyId: enemy.id, dmgPerSec: enemy.dmg,
    // 2026-08-20 修复首帧冲刺：dashCd 初始设为 cd（首次冲刺在 cd 秒后触发，而非首帧 0→立即冲）
    dashCd: enemy.dash?.cd,
  });
}
