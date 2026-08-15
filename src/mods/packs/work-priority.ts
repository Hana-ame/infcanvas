// 工作优先级玩法包（RW-1 M1，2026-08-15）
// 目标：像 RimWorld Work Tab 一样，玩家给每个小人每项工作设 0(禁止)/1(最高)/2/3/4(最低)
//   优先级，留空 = 自动。小人的自主抽卡/欲望/违抗仍是底层，优先级只是调制"常规抽卡权重"。
// 为什么做成玩法包而非塞内核：这是玩法（管理界面 + 优先级调制），不是引擎骨架；数据模型
//   走 PawnState.extra 存档扩展点（随档原样还原，DATA_DRIVEN §14），跨包键走 K_* 常量。
// 接入点（纯插件，零内核改动）：
//   ① registerWeightRule('workPriority', before:'job')——权重合成调制工作卡；
//   ② registerCommand('set-work-priority')——玩家设优先级；
//   ③ helper 函数供 HUD/存档迁移/协议透传共用（workPrioritiesOf/setJobPriority/migrate）。
// 紧急需求（吃/睡/治疗/SAN 崩溃）在 BehaviorSystem 里先于 decide() 执行、不经过权重合成，
//   天然不受优先级抑制（回归测试锁定）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { Sim } from '../../sim/sim';
import type { PawnState } from '../../sim/sim';
import type { WeightRule } from '../../sim/defs/weightRules';
import { weightRulesOf } from '../../sim/mods/query';
import { JOBS, JOB_CARD } from '../../sim/defs/jobs';
import type { ModPack } from '../pack';
// 跨包键常量（2026-08-15 一致性：写方/读方引用同一权威常量，拼错 = 编译期错误）
import { K_WORK_PRIORITIES } from '../../sim/mods/contracts';

// 本包数值（玩法包自治，注释数值意图）
const CFG = {
  // 优先级 → 工作卡权重倍率（0 = 禁止；1 最高倍率 → 4 最低）。1 用 6 对齐原 assignedJob
  // jobCardMul（jobs.ts 主导卡倍率），逐级递减：2 近似常规（3x）、3 偏少、4 很少（0.7x）。
  // 数值封在包内 CFG（DATA_DRIVEN §13 包内 CFG = 新玩法包私有平衡表），不塞内核 tuning。
  weightMuls: { 0: 0, 1: 6, 2: 3, 3: 1.5, 4: 0.7 } as Record<number, number>,
};

// ---- helper（写/读/迁移，HUD/服务端/存档迁移共用同一份语义）----
// 允许的优先级值集合（cmdValidate 也要据此校验，导出复用——避免两层各写各的魔数集合）
export const WORK_PRIORITY_ALLOWED = [0, 1, 2, 3, 4] as const;

// 读取 pawn 的工作优先级表（缺省 undefined = 全部未设置 = 自主）。
// 类型防御：extra[K_WORK_PRIORITIES] 是 JSON-safe 运行时数据，可能被旧档/手写数据写成
// 非 Record 形状，这里收窄为合法形状（非法值按无处理，不抛——容忍脏数据，UI 仍可覆盖）。
export function workPrioritiesOf(st: { extra?: Record<string, unknown> } | undefined): Record<string, number> | undefined {
  const p = st?.extra?.[K_WORK_PRIORITIES];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (typeof v === 'number' && WORK_PRIORITY_ALLOWED.includes(v as (typeof WORK_PRIORITY_ALLOWED)[number])) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// 校验一个 job 是否为当前职业表内的合法职业（cmdValidate 复用，防 HUD/上层误传任意字符串）
export const isKnownJob = (job: string): boolean => job in JOBS;

// 写某工作的优先级；priority=undefined 表示清除为未设置（= 自主）。
// 全部清空后删除整个键（保持"缺键 = 未设置"的单一语义，协议/遍历更干净）。
export function setJobPriority(st: { extra?: Record<string, unknown> }, job: string, priority?: number): void {
  const cur = workPrioritiesOf(st) ?? {};
  if (priority === undefined) delete cur[job];
  else cur[job] = priority;
  st.extra = st.extra ?? {};
  if (Object.keys(cur).length) st.extra[K_WORK_PRIORITIES] = cur;
  else delete st.extra[K_WORK_PRIORITIES];
}

// 旧机制迁移（load 时，幂等）：把"单主职业"演化为优先级表。
// 主职业 = 1（最想做），其余 JOBS = 0（禁止）——与任务"指派职业改为优先级快捷方式"一致。
// 幂等：已有优先级则不动（新 save 优先，不覆盖玩家已细调的多档优先级）。
export function migrateFromAssignedJob(st: PawnState): void {
  if (!st.assignedJob) return;
  if (workPrioritiesOf(st) !== undefined) return; // 已有细调优先级，不覆盖
  writeAssignedJobPriorities(st);
}

// assign 快捷方式（命令处理器用，强制）：跟迁移同语义（主职业=1、其他=0），但无条件覆盖。
// 为什么强制：玩家在选中面板点"指派职业"按钮 = 显式"只干这行"指令（RW-1 快捷方式语义），
// 此时覆盖已有的细调优先级是预期行为；而 load 迁移必须幂等（不能掩盖玩家存过档的细调）。
// 取消指派（assignedJob 清空）：清掉整个优先级键（回到全自动）。
export function applyAssignedJobShortcut(st: PawnState): void {
  if (!st.assignedJob) { delete st.extra?.[K_WORK_PRIORITIES]; return; }
  writeAssignedJobPriorities(st);
}

function writeAssignedJobPriorities(st: PawnState): void {
  const p: Record<string, number> = {};
  for (const job of Object.keys(JOBS)) p[job] = job === st.assignedJob ? 1 : 0;
  st.extra = st.extra ?? {};
  st.extra[K_WORK_PRIORITIES] = p;
}

// 某个工作优先级 → 对应工作卡权重倍率档位（workPriority 规则用）。
// 返回 undefined = 该卡**无任何对应 job 设置优先级**（不调制，保持自主）；
// 返回 0 = 所有相关 job 均设为禁止（该卡被禁用）；返回 1..4 = 取"最有利"档位
// （多个 job 映射同卡时，如 farmer/crafter→build，任一 job 允许即视为可做，取最高档
// ——最低数字 = 最优先，即最有利）。禁止(0)只在"相关 job 全禁"时封死该卡。
function priorityOf(cardId: string, pri: Record<string, number>): number | undefined {
  let matched = false; // 是否有任一 job 显式设置了该卡的优先级
  let best: number | undefined; // 最有利（最高优先 = 数字最小）的非禁止档
  for (const [job, p] of Object.entries(pri)) {
    if (JOB_CARD[job] !== cardId) continue; // 跳过不属于该卡的 job
    matched = true;
    if (p === 0) continue;              // 跳过禁止项（先记录 matched，最后判定是否全禁）
    if (best === undefined || p < best) best = p;
  }
  if (!matched) return undefined;       // 该卡无任何优先级设置 → 不调制（自主）
  return best ?? 0;                     // 有设置但全 0 → 全禁（返回 0）；否则返回最有利档
}

// 工作优先级权重规则：常规抽卡权重按 pawn 的每工作优先级调制。
// 0（全部相关 job 都禁）→ 权重归零（该工作卡不可抽中）；1/2/3/4 → CFG 倍率从强到弱；
// 未设置 → 不改动（保持自主）。放在抽卡权重流水线 'job' 规则之前（before:'job'），
// 优先于旧的单职业 assign 规则（旧规则已让位，见 weightRules.ts ruleJob 注释）。
const ruleWorkPriority: WeightRule = {
  id: 'workPriority',
  label: '工作优先级',
  apply(w, card, _pawn, ctx) {
    const pri = ctx?.view.workPriorities;
    if (!pri || Object.keys(pri).length === 0) return w;
    const p = priorityOf(card.id, pri);
    if (p === undefined) return w; // 该卡无对应优先级 → 不调制（非工作卡或未设置）
    return w * CFG.weightMuls[p];  // p=0（全禁）→ ×0 归零；p=1..4 → 对应档位倍率
  },
};

export const workPriorityPack: ModPack = {
  id: 'work-priority',
  // 依赖：无硬前置。读 JOBS 表（内核 defs）+ 权重规则表（内核），都是既有面，无玩法包依赖。
  requires: [],
  apply(m: ModRegistry): void {
    // 行为接入：权重规则表插到 'job' 前（先后 = 优先级先调制，旧单职业规则让位）。
    // 幂等：weightRuleStore 是模块级跨 Sim 实例共享表（query.ts），同一进程多个
    // ModRegistry.default() 各自跑本包 apply 会重复注册 → 同 id 抛错。规则是纯函数
    //（只读 ctx.view.workPriorities），全局注册一次即可正确作用于所有实例，故已存在则跳过
    //（非覆盖：同 id 同 def，跳过无害——与 registerTech 对跨实例表的幂等处理一致）。
    if (!weightRulesOf().some((r) => r.id === ruleWorkPriority.id)) {
      m.registerWeightRule(ruleWorkPriority, 'job');
    }
    // 命令：set-work-priority —— 玩家设某小人某工作优先级。
    // 参数 { pawnId?, job, priority }；priority 缺省/undefined = 清除为未设置（自主）。
    // 合法性（job ∈ JOBS、priority ∈ 0..4）在 cmdValidate 把关，处理器仍防御性校验一次
    // （本地单机不走 cmdValidate，直接 issueCommand，防御性校验防脏参数写脏 extra）。
    m.registerCommand('set-work-priority', (ctx, cmd) => {
      const job = cmd.job as string | undefined;
      if (!job || !isKnownJob(job)) { ctx.logEvent(`⚠ 未知工作：${job}`); return; }
      // priority 走命令 args 通用位（内核不解释；wear 命令的 itemId 先例）——命令协议开放后
      // 命令专属参数不新增内核字段，防"内核为什么扩展"回潮。缺省 undefined = 清除为未设置。
      const pv = cmd.args?.priority as number | undefined;
      if (pv !== undefined && !WORK_PRIORITY_ALLOWED.includes(pv as (typeof WORK_PRIORITY_ALLOWED)[number])) {
        ctx.logEvent(`⚠ 非法优先级：${pv}（应为 0~4）`); return;
      }
      const eids = cmd.pawnId ? [cmd.pawnId] : ctx.selected;
      for (const eid of eids) {
        const st = ctx.pawnStates.get(eid);
        if (!st) continue;
        // 防御性防御：extra 可能是旧档/手写脏数据（非对象），先兜底为空对象再写
        if (!st.extra || typeof st.extra !== 'object') st.extra = {};
        setJobPriority(st, job, pv);
        ctx.logEvent(pv === undefined
          ? `📋 #${eid} ${job} 恢复自动`
          : `📋 #${eid} ${job} 优先级 = ${pv === 0 ? '禁止' : pv}`);
      }
    });
  },
};
