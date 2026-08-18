// 征召战斗玩法包（RW-1 M2，2026-08-15）
// 目标：像 RimWorld 征召一样，玩家直接指挥小人作战——征召 = 小人停止自主（不抽卡/不工作/
//   不休闲/不吃不睡不治疗），完全听玩家；攻击 = 移动到目标敌人附近并交战。
// 为什么做成玩法包而非内核：指挥属于玩法层；内核只动两处极小协议面（都走契约键 + 注释）：
//   ① behavior 决策门（K_DRAFTED=true → 跳过自决，见 cardSystem.ts 注释）——
//      原因是抽卡决策是引擎内部循环，纯插件无法在不改引擎的前提下阻止它；
//   ② raidSystem 指定攻击者优先（读 K_ATTACK，见 raidSystem.ts 注释）——
//      战斗公式（伤害/闪避/掉落）不复制，只把"谁接敌"从纯最近改为主选指定者。
// 数据模型：PawnState.extra[K_DRAFTED] = boolean（征召中）、PawnState.extra[K_ATTACK] =
//   { hostileIndex, x, y }（指定目标 + 快照位置；JSON-safe 随档）。见 contracts.ts。
// 被动衰减（饥饿/精力/心情/理智）不豁免：征召只豁免"自主行动"，不豁免世界对身体的消耗
// （任务明确要求；needs/san 系统照跑，本包不碰它们）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { Sim } from '../../sim/sim';
import type { GameSystem } from '../../sim/systems/registry';
import type { SimContext } from '../../sim/systems/context';
import type { PawnState } from '../../sim/sim';
import type { ModPack } from '../pack';
import { K_DRAFTED, K_ATTACK, K_TACTICS } from '../../sim/mods/contracts';

// 本包数值（玩法包自治，注释数值意图；DATA_DRIVEN §13 包内 CFG）
const CFG = {
  autoEngageRadius: 14, // 无指定目标时，征召小人自动接敌半径（格）。默认 14 格 ≈ 半屏，
  //   与 raid 索敌/篝火温暖半径同量级：营地内敌人一靠近就会被征召队截住。
  repathInterval: 0.4,  // 追击重寻路节流（秒）。寻路风暴修复（moveTo 每次 A*）：追击目标
  //   每 0.4s 重寻一次足够（敌人移速 ~2 格/s，0.4s 移动 <1 格，方向感不丢）。
  stopDist: 0.8,        // 距目标多近停止追击（格）。raid 接敌判定是 meleeRange（~1 格），
  //   留 0.2 格余量防"够不着"抖动（路末端误差）。
  targetLostRadius: 8,  // 目标消失（被击杀 splice 下标错位）后，按快照位置就近找回的半径（格）。
  //   超过此半径 = 目标真没了/换了一拨，放弃追击（原地待命）。
  sameTargetDrift: 1.5, // "下标处仍是原目标"的位置容差（格）。敌人移速 ~2 格/s，一 tick(0.05s)
  //   位移 <0.2 格；splice 顶替的敌人若与快照距离 > 此值 → 判定下标被顶替，走找回逻辑。
  //   取 1.5 格兼顾大 dt（0.1s/帧时位移 ~0.4 格）与顶替区分（顶替者通常站在别处）。
};

// ---- 状态读写 helper（命令/系统/raidSystem/HUD 共用同一语义；K_* 键走常量）----
export function draftedOf(st: { extra?: Record<string, unknown> } | undefined): boolean {
  return st?.extra?.[K_DRAFTED] === true;
}

// 攻击目标（指定敌对单位）：{ hostileIndex, x, y } 或 null。
// hostileIndex = 敌人数组下标（与协议快照 hostiles.i 对齐，客户端右键目标即快照下标）；
// x/y = 指定时的位置快照——敌人每 tick 移动，追击靠每帧刷新（见 resolveTarget）。
// 类型防御：extra 是运行时 JSON 数据，可能被手写档写成非预期形状，收窄后容错。
export function attackTargetOf(st: { extra?: Record<string, unknown> } | undefined): { hostileIndex: number; x: number; y: number } | null {
  const a = st?.extra?.[K_ATTACK];
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const o = a as Record<string, unknown>;
  if (typeof o.hostileIndex !== 'number' || typeof o.x !== 'number' || typeof o.y !== 'number') return null;
  return { hostileIndex: o.hostileIndex, x: o.x, y: o.y };
}

export function setDrafted(st: { extra?: Record<string, unknown> }, on: boolean): void {
  st.extra = st.extra ?? {};
  if (on) st.extra[K_DRAFTED] = true;
  else delete st.extra[K_DRAFTED];
}

export function setAttackTarget(st: { extra?: Record<string, unknown> }, hostileIndex: number, x: number, y: number): void {
  st.extra = st.extra ?? {};
  st.extra[K_ATTACK] = { hostileIndex, x, y };
}

export function clearAttackTarget(st: { extra?: Record<string, unknown> }): void {
  delete st.extra?.[K_ATTACK];
}

// 征召系统：每 tick 驱动被征召小人的追击（指定目标优先，其次半径内自动接敌）。
// 为什么需要独立系统：征召小人被 behavior 门禁用自决后没有任何代码会让他们动；追击 = 每
// tick 的"移动驱动"，必须有一个系统持续发 moveTo（节流复用引擎寻路，不复制移动逻辑）。
export class DraftSystem implements GameSystem {
  id = 'drafting';
  private lastRepath = new Map<number, number>();

  constructor(private ctx: SimContext) {}

  init(): void {}

  update(dt: number): void {
    for (const eid of this.ctx.pawnList) {
      const st = this.ctx.pawnStates.get(eid);
      if (!st || !draftedOf(st)) continue;
      // 战场指挥 DLC（2026-08-16 field-command 包）：受命小人的'固守/撤退/集结'战术
      // 优先级高于自动接敌——追击会顶掉战术移动（固守被拉走/撤退被拉回），由战术系统
      // 驱动移动；冲锋/集火经 attackTarget 走本条追击逻辑（指定目标优先于自动接敌）。
      // 跨包读 K_TACTICS（契约登记 reader drafting，见 contracts.ts）。
      const cmdTactic = st.extra?.[K_TACTICS] as { underOrder?: { tactic: string } } | undefined;
      const ut = cmdTactic?.underOrder?.tactic;
      if (ut === 'hold' || ut === 'retreat' || ut === 'regroup') continue;
      const pos = this.ctx.pawnPositions.get(eid);
      if (!pos) continue;
      // 玩家刚发过手动命令（moveTo 设置 commandCooldown）→ 本 tick 不抢（尊重玩家指挥，
      // 例如玩家想让征召小人绕开火线。3s 后无新命令恢复自主追击）。
      if ((st.commandCooldown ?? 0) > 0) continue;
      const target = this.pickTarget(st, pos);
      if (!target) continue; // 无目标：原地待命（征召语义，保持站位）
      const d = Math.hypot(target.x - pos.x, target.y - pos.y);
      if (d <= CFG.stopDist) continue; // 已贴近：接敌结算交给 raidSystem（不复制公式）
      // 追击寻路节流：目标每 tick 在动，但 0.4s 内重寻一次即可（防止每帧 A* 风暴）
      const last = this.lastRepath.get(eid) ?? 0;
      if (this.ctx.time - last < CFG.repathInterval) continue;
      this.lastRepath.set(eid, this.ctx.time);
      // markCommand:false = 系统行为移动，不标记玩家命令（2026-08-16 修复：此前 moveTo
      // 无条件设 commandCooldown=3，追击一次后自锁 3s；配合 cardSystem 征召门内递减，
      // 现在玩家手动命令仍受尊重，系统追击不再自锁）
      this.ctx.moveTo(eid, Math.round(target.x), Math.round(target.y), { markCommand: false });
    }
  }

  // 该征召小人的追击目标：1) 指定目标（刷新位置/找回下标）；2) 半径内最近敌人（自动接敌）
  private pickTarget(st: PawnState, pos: { x: number; y: number }): { x: number; y: number } | null {
    const atk = attackTargetOf(st);
    if (atk) {
      const resolved = this.resolveTarget(st, atk);
      if (resolved) return resolved;
    }
    // 自动接敌：无指定目标（或指定目标已消失）→ 半径内最近的敌人（任务 M2）
    let best: HostileLike | null = null;
    let bestD = CFG.autoEngageRadius * CFG.autoEngageRadius;
    for (const h of this.ctx.hostiles) {
      const d = (h.x - pos.x) ** 2 + (h.y - pos.y) ** 2;
      if (d < bestD) { bestD = d; best = h; }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  // 刷新指定目标：敌人每 tick 在动，且击杀会 splice 数组（下标错位）。
  // 修复 2026-08-16 审查问题 ①：此前 attackTargetOf 每 tick 从 extra 新建快照对象，
  // resolveTarget 只改局部对象、从不写回 → 找回的新下标永不落盘；且 splice 后
  // hs[staleIndex] 指向"别的敌人"时无条件返回其坐标 → 追错目标。
  // 现在：命中即 setAttackTarget 写回（快照刷新 + 下标修正），并用位置距离校验
  // "下标处是否仍是原目标"——敌人一 tick 位移很小，距离骤变 = 下标已被顶替 → 走找回。
  // 1) 原下标存活且位置合理 → 视为同一目标，写回最新坐标（顺带刷新快照）；
  // 2) 原下标无效/被顶替 → 按快照位置在 targetLostRadius 内就近找回（视为同一目标追丢），
  //    并回写新下标（raidSystem 指定者判定依赖正确下标）；
  // 3) 找不到 → 目标已死/换批 → 清指定（攻击完成，回到自动接敌或待命）。
  private resolveTarget(st: PawnState, atk: { hostileIndex: number; x: number; y: number }): { x: number; y: number } | null {
    const hs = this.ctx.hostiles;
    const h = hs[atk.hostileIndex];
    if (h) {
      // 位置校验：敌人移速 ~2 格/s，一 tick(0.05s) 位移 <0.2 格；快照与现位置距离若
      // 超过 CFG.sameTargetDrift 格，说明该下标已被 splice 顶替为别的敌人（原目标死了
      // 或被挤走）→ 不能直接当原目标，走找回逻辑
      const drift = Math.hypot(h.x - atk.x, h.y - atk.y);
      if (drift <= CFG.sameTargetDrift) {
        // 同一目标：写回最新坐标（快照刷新——此前只改局部对象，快照永不更新）
        setAttackTarget(st, atk.hostileIndex, h.x, h.y);
        return { x: h.x, y: h.y };
      }
    }
    const r2 = CFG.targetLostRadius * CFG.targetLostRadius;
    for (let j = 0; j < hs.length; j++) {
      const d = (hs[j].x - atk.x) ** 2 + (hs[j].y - atk.y) ** 2;
      if (d < r2) {
        // 找回成功：回写新下标 + 位置（此前只改局部对象，下标修正永不落盘）
        setAttackTarget(st, j, hs[j].x, hs[j].y);
        return { x: hs[j].x, y: hs[j].y };
      }
    }
    // 目标确认消失：清指定（只清当前小人的指定——按下标全清会误伤其他征召小人
    // 指向的不同目标；每个征召小人各自 resolveTarget 各自清理）
    clearAttackTarget(st);
    return null;
  }
}

interface HostileLike { x: number; y: number }

// 征召玩法包装配（2026-08-15 M2）
export const draftingPack: ModPack = {
  id: 'drafting',
  // 依赖：无硬前置。读 raidSystem 的战斗结算（K_ATTACK 契约键）与行为引擎的征召门
  //（K_DRAFTED）——都靠契约键解耦，不构成挂载依赖；卸载 raid 本包仍可征召站位。
  requires: [],
  apply(m: ModRegistry): void {
    // 驱动系统：category 'raid'（与 raid 同期，注册在 raid 之后 → 每 tick 先结算接敌再续追）
    m.registerSystemDef({ id: 'drafting', label: '征召', category: 'raid', ctor: (s: Sim) => new DraftSystem(s) });

    // draft 命令：{ pawnId?, drafted }——征召/解除征召（batch 走 selected；单机/远程通用）。
    // 征召时打断当前工作/路径（RimWorld：征召取消手头活）；解除时清攻击指定（回自主）。
    m.registerCommand('draft', (ctx, cmd) => {
      const on = cmd.args?.drafted === true;
      const eids = cmd.pawnId !== undefined ? [cmd.pawnId] : ctx.selected;
      for (const eid of eids) {
        const st = ctx.pawnStates.get(eid);
        if (!st) continue;
        setDrafted(st, on);
        if (!on) clearAttackTarget(st);
        // 打断当前进行中的工作/路径——与 moveTo 清的一致（work-in-progress 标志集会
        // 让 behavior 提前 continue，征召后必须清掉否则"残卷"继续读条）
        st.path = []; st.pathIndex = 0; // path 非可选字段：空数组 = 无路径（打断当前移动）
        st.mineTarget = undefined; st.mining = undefined;
        st.chopTarget = undefined; st.chopXY = undefined; st.chopProgress = undefined;
        st.prayTarget = undefined; st.praying = undefined;
        st.healTarget = undefined; st.healing = undefined;
        st.caveWork = undefined;
        ctx.logEvent(on
          ? `⚔ 征召 #${eid}（不自主行事，听你指挥；右键敌人 = 攻击）`
          : `☮ 解除征召 #${eid}（恢复自主行事）`);
      }
    });

    // attack 命令：{ pawnId, hostileIndex }——指定征召小人攻击某敌人（移动到近旁并交战）。
    // 交战公式（伤害/闪避/掉落）零复制：贴近后 raidSystem 的 updateCombat 自动结算
    //（征召小人也在 pawnList，敌对单位在 meleeRange 内即互相伤害）；本命令只负责"移动过去"。
    // cmdValidate 已拦非法 pawnId/hostileIndex；这里再防御一次（本地单机不走校验）。
    m.registerCommand('attack', (ctx, cmd) => {
      const eids = cmd.pawnId !== undefined ? [cmd.pawnId] : ctx.selected;
      for (const eid of eids) {
        const st = ctx.pawnStates.get(eid);
        if (!st) continue;
        const hIdx = (cmd.args?.hostileIndex as number | undefined) ?? -1;
        const h = ctx.hostiles[hIdx];
        if (!h) { ctx.logEvent(`⚠ #${eid} 攻击目标已不存在（${hIdx}）`); continue; }
        if (!draftedOf(st)) {
          ctx.logEvent(`⚠ #${eid} 未征召，无法指定攻击（先征召再右键敌人）`);
          continue;
        }
        setAttackTarget(st, hIdx, h.x, h.y);
        // 初始逼近（贴脸前先走起来；后续追击由 DraftSystem 节流续推）
        ctx.moveTo(eid, Math.round(h.x), Math.round(h.y));
        ctx.logEvent(`⚔ #${eid} 攻击目标 ${h.name ?? h.enemyId ?? '敌人'}（征召指挥）`);
      }
    });
  },
};