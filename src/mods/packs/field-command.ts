// 战场指挥 DLC（field-command 玩法包，2026-08-20）
// 目标（用户需求）：通过**训练编排战术动作**培养小队 → **控制指挥官**下发战术 →
// **小队作战** → **多层指挥**（军团长 → 队长 → 兵）实现**大兵团作战**。
// 与 drafting（单个征召战斗）的关系：drafting = 玩家逐人指挥；本包 = 指挥官批量指挥
//   （战术命令）。复用 drafting 两条内核挂钩（零新引擎改动）：
//   ① 征召门（K_DRAFTED 契约键）——受命小人 = 征召（不自主决策、听指挥）；
//   ② 指定攻击（K_ATTACK 契约键）——drafting 追击拖动（集火/冲锋 = 批量设指定目标）。
// 战术执行权顺序：本包系统注册在 drafting **之后**（raid 组内注册序）——drafting 的
//   自动接敌追击对'固守/撤退/集结'小人跳过（见 drafting.ts tacticOf 门），战术移动由
//   本包驱动；冲锋/集火 = 设 attackTarget 后交给 drafting 追击（公式零复制原则）。
// 数据模型（PawnState.extra，随档透传，K_* 常量 + CONTRACTS 登记）：
//   [K_COMMANDER] = { role: 'officer'|'general', subordinates: number[] }——指挥官身份+编制树
//     （general = 军团长，可辖队长与兵；officer = 队长，只辖兵；树 = 多层指挥）。
//   [K_TACTICS] = { learned: string[], active: string|null, underOrder: {...}|null }
//     ——训练掌握列表 / 编排位（commander 命令写：持久预设，无临战命令时按编排执行，随档）
//     / 指挥官临战下达（覆盖 active，受命 = 征召；收兵/解除后回落到编排执行）。
// 死亡语义：指挥官死亡 → 级联解除整树（受命小人恢复自主）；受命者死亡 → 从树中摘除。
// 玩家优先：受命小人被玩家解除征召 → 战术命令失效（尊重玩家，不拉回）。
// 被动衰减（饥饿/精力/心情/理智）不豁免：与征召一致（needs/san 照跑，本包不碰）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { Sim } from '../../sim/sim';
import type { GameSystem } from '../../sim/systems/registry';
import type { SimContext } from '../../sim/systems/context';
import type { PawnState } from '../../sim/sim';
import type { ModPack } from '../pack';
import { K_COMMANDER, K_TACTICS } from '../../sim/mods/contracts';
import { setDrafted, draftedOf, setAttackTarget, clearAttackTarget } from './drafting';

// ---- 战术动作表（数据驱动：动作语义 = move 分类 + 数值；HUD/测试/命令共用）----
export interface TacticDef {
  id: string;
  label: string;      // 中文名（HUD/日志）
  desc: string;       // 效果说明（HUD 悬浮/日志）
  move: 'engage' | 'hold' | 'focus' | 'retreat' | 'regroup';
  engageRadius?: number; // 仅 engage：主动接敌半径（格）
}
export const TACTICS: Record<string, TacticDef> = {
  charge: {
    id: 'charge', label: '冲锋',
    desc: '主动出击：向半径内最近敌人进军（接敌半径大于自动索敌——先敌接战），追击交给征召驱动',
    move: 'engage', engageRadius: 20,
  },
  hold: {
    id: 'hold', label: '固守',
    desc: '原地固守：不追击不移动（战术优先级高于自动索敌，防"令行不止"）',
    move: 'hold',
  },
  focus: {
    id: 'focus', label: '集火',
    desc: '指挥官指定目标 → 全队集中攻击（dispatch 需带 hostileIndex；目标死亡战术自动解除）',
    move: 'focus',
  },
  retreat: {
    id: 'retreat', label: '撤退',
    desc: '远离最近敌人向安全方向转移（目标点随敌人移动周期重算）',
    move: 'retreat',
  },
  regroup: {
    id: 'regroup', label: '集结',
    desc: '向指挥官身边集结（指挥官死亡自动解除）',
    move: 'regroup',
  },
};

// 本包数值（玩法包自治，注释数值意图；DATA_DRIVEN §13 包内 CFG）
const CFG = {
  trainCooldown: 15,    // 训练冷却（秒/小人）。战术学习 = 即时掌握 + 冷却：训练是"培养"
  //   行为的仪式化入口，不是资源消耗（本包零资源面）；冷却防连点刷屏、给"训练中"节奏感。
  engageRadius: 20,     // 冲锋接敌半径（格）。drafting 自动接敌 14 格（半屏）；冲锋 20 格 =
  //   主动出击先敌接战（"打仗靠冲"的代价：脱离营地战线向前压）。
  retreatDistance: 40,  // 撤退转移距离（格）。敌人移速 ~2 格/s × 撤退节流 0.5s = 每次
  //   重算目标点足够远；钳制到地图边界内（无限地图 ±MAX_TILE，命令坐标同范围）。
  moveInterval: 0.5,    // 战术移动重算节流（秒）。retreat 目标随敌人位置动、regroup 随
  //   指挥官位置动——0.5s 重寻一次足够（寻路风暴防护，与 drafting 追击节流同量级）。
  refreshInterval: 0.8, // 冲锋/集火指定刷新节流（秒）。drafting 追击节流 0.4s 已拉起追击，
  //   战术指定目标慢一档即可（敌人 splice 后 attackTarget 回落逻辑在 drafting）。
  regroupSpread: 2,     // 集结落位散布（格）。全队聚一起会互相挤（walk 排队），
  //   向指挥官八方向偏移 2 格落位（按 eid 取方向，稳定不抖）。
};

// ---- 状态写回 helper ----
// tacticsOf() 每次都从 extra 重建对象（读面快照——防外部持有的旧引用污染存档）；
// 因此**写回必须经 extra 原对象**，禁止改读面副本（dispatchTree/clearTree 曾踩此坑：
// 对副本赋 underOrder/learned 不落盘 → 命令表面成功、状态纹丝不动）。
// 读取/创建 pawn.extra[K_TACTICS]（战术状态对象）；不存在返回 null
function mutateTactics(st: { extra?: Record<string, unknown> }): TacticsShape | null {
  const real = st.extra?.[K_TACTICS] as TacticsShape | undefined;
  if (!real) return null;
  return real;
}
// 确保 extra[K_TACTICS] 存在（不存在则创建），返回战术状态对象
function ensureTacticsExtra(st: PawnState): TacticsShape {
  const real = st.extra?.[K_TACTICS] as TacticsShape | undefined;
  if (real) return real;
  const t: TacticsShape = { learned: [], active: null, underOrder: null };
  st.extra = st.extra ?? {};
  st.extra[K_TACTICS] = t;
  return t;
}
// 清单个小人的战术命令（受命态保留与否由调用方决定）
// 清除单个小人的 underOrder（收兵 = 解除战术命令，恢复自主决策）
function clearOrderIn(st: { extra?: Record<string, unknown> }): void {
  const real = mutateTactics(st);
  if (real) real.underOrder = null;
}

// ---- 状态读写 helper（命令/系统/HUD 共用同一语义；K_* 键走常量）----
export interface CommanderShape { role: 'officer' | 'general'; subordinates: number[] }
export interface OrderShape { tactic: string; from: number; target?: number }
export interface TacticsShape {
  learned: string[];
  active: string | null;
  underOrder: OrderShape | null;
}

// 读取指挥官状态（role + subordinates）；非指挥官返回 null
export function commanderOf(st: { extra?: Record<string, unknown> } | undefined): CommanderShape | null {
  const c = st?.extra?.[K_COMMANDER];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const o = c as Record<string, unknown>;
  if ((o.role !== 'officer' && o.role !== 'general') || !Array.isArray(o.subordinates)) return null;
  return { role: o.role, subordinates: o.subordinates.filter((v) => typeof v === 'number') };
}

// 读取战术状态（active 编排位 + underOrder 生效命令）；无战术返回 null
export function tacticsOf(st: { extra?: Record<string, unknown> } | undefined): TacticsShape | null {
  const t = st?.extra?.[K_TACTICS];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const o = t as Record<string, unknown>;
  const learned = Array.isArray(o.learned) ? o.learned.filter((v) => typeof v === 'string') : [];
  const active = typeof o.active === 'string' ? o.active : null;
  let underOrder: OrderShape | null = null;
  const u = o.underOrder;
  if (u && typeof u === 'object' && !Array.isArray(u)) {
    const uo = u as Record<string, unknown>;
    if (typeof uo.tactic === 'string' && typeof uo.from === 'number') {
      underOrder = { tactic: uo.tactic, from: uo.from, target: typeof uo.target === 'number' ? uo.target : undefined };
    }
  }
  return { learned, active, underOrder };
}

// 当前生效战术：临战命令（underOrder）覆盖编排位（active）——指挥官指令 > 玩家预设
export function tacticOf(st: { extra?: Record<string, unknown> } | undefined): string | null {
  const t = tacticsOf(st);
  if (!t) return null;
  if (t.underOrder) return t.underOrder.tactic;
  return t.active;
}

// ---- 训练冷却表（WeakMap<SimContext>：命令处理器与系统实例共享同一冷却；
// SimContext = Sim 实现接口，同一 Sim 的 ctx 是同一对象——oracle 冷却先例）----
const trainCd = new WeakMap<SimContext, Map<number, number>>();
// 读取上次训练时间戳（训练冷却 15s——训练是培养仪式，不能频繁刷）
function lastTrainOf(ctx: SimContext, eid: number): number {
  return trainCd.get(ctx)?.get(eid) ?? 0;
}
// 写入训练时间戳（train 命令调用）
function stampTrain(ctx: SimContext, eid: number, t: number): void {
  let m = trainCd.get(ctx);
  if (!m) { m = new Map(); trainCd.set(ctx, m); }
  m.set(eid, t);
}

// ---- 树操作（free 函数：命令处理器（注册时无系统实例）与系统共享同一实现）----

// 从指挥官 eid 起递归解除整树：清战术命令 + 清征召（恢复自主）。防环 visited。
// 用途：指挥官死亡/解编/收兵（dispatch 'none'）——命令源没了 = 小队恢复自主。
// 死指挥官树快照：killPawn 同步删除 pawnStates（含 extra 编制表）——死亡级联只能
// 读 FieldCommandSystem 上帧缓存（见 refreshTree）。rootSubs 缺省 = 回读活人 extra。
// 指挥官死亡 -> 级联解除整棵指挥树（递归清除所有下属的 underOrder + 征召）
// 背景：killPawn 同步删 extra，死后编制表读不到 -> 需用上帧树快照递归
function clearTree(ctx: SimContext, eid: number, log?: string | null, rootSubs?: number[]): void {
  if (log) ctx.logEvent(log);
  const stack: number[] = [eid];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const st = ctx.pawnStates.get(cur);
    if (st) {
      clearOrderIn(st); // 经 extra 原对象写回（读面副本不可写——见 mutateTactics 注释）
      if (draftedOf(st)) setDrafted(st, false);
    }
    // 下属列表：根 = 缓存快照（可能已死/已删）；其余 = 活人 extra 回读
    const subs = cur === eid && rootSubs
      ? rootSubs
      : (commanderOf(st)?.subordinates ?? []);
    for (const sub of subs) stack.push(sub);
  }
}

// 级联下发战术：从指挥官 eid 起递归遍历编制树（含自己——指挥官自身也执行战术），
// 全员设置 underOrder + 征召（受命 = 听指挥）。target = 集火目标的 hostileIndex（其余战术无）。
// 返回受命人数（日志/测试用）。防环 visited（玩家手编的树形状可能有环）。
// 战术下达：递归遍历指挥树设置 underOrder.tactic + 征召（'none' = 收兵全解除）
// 返回受命人数
function dispatchTree(ctx: SimContext, eid: number, tactic: string, target: number | undefined): number {
  let count = 0;
  const stack: number[] = [eid];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const st = ctx.pawnStates.get(cur);
    if (!st) continue;
    const t = ensureTacticsExtra(st); // 经 extra 原对象写回（读面副本不可写）
    t.underOrder = { tactic, from: eid, target };
    setDrafted(st, true);
    // 非集火战术：清掉旧的攻击指定（冲锋/固守/撤退/集结由自身逻辑或 drafting 管理目标）
    if (tactic !== 'focus') clearAttackTarget(st);
    count++;
    const c = commanderOf(st);
    if (c) for (const sub of c.subordinates) stack.push(sub);
  }
  return count;
}

// ---- 战场指挥系统：树维护（死亡级联/玩家解除）+ 战术驱动 ----
export class FieldCommandSystem implements GameSystem {
  id = 'field-command';
  private repath = new Map<number, number>(); // 战术移动/指定重算节流（瞬态不随档）
  // 指挥官 → 编制树快照（每帧刷新）。为什么：killPawn 同步删除 pawnStates（连带 extra
  // 编制表），死亡级联若等"看到死者"再读树 = 树早已没了——必须用上帧快照清树。
  private treeSnapshot = new Map<number, number[]>();

  constructor(private ctx: SimContext) {}

  init(): void {}

  update(dt: number): void {
    // 不节流（战斗系统需每帧精度）：战术执行 1s 评估一次
    this.refreshTree();
    this.driveTactics();
  }

  // ---- 树维护 ----
  // 每 tick：① 指挥官死亡（上帧快照有、本帧 alive 无）→ 用快照级联解除整树（受命小人
  // 恢复自主——指挥官没了命令源就没了）；② 编制里死亡的下属摘除；③ 玩家解除受命小人的
  // 征召 → 战术命令失效（尊重玩家指挥优先）。活指挥官的快照每帧重写。
  private refreshTree(): void {
    const ctx = this.ctx;
    const alive = new Set<number>(ctx.pawnList);
    // ① 死亡检测走快照（不要遍历 pawnStates 找死者——它们已不在集合里）
    if (this.treeSnapshot.size > 0) {
      for (const [cid, subs] of this.treeSnapshot) {
        if (!alive.has(cid)) {
          clearTree(ctx, cid, `⚰ 指挥官 #${cid} 阵亡——小队解除征召恢复自主`, subs);
          this.treeSnapshot.delete(cid);
        }
      }
    }
    for (const [eid, st] of ctx.pawnStates) {
      const c = commanderOf(st);
      if (c) {
        // 编制清理：死亡/消失的下属摘除（树引用不得指向不存在的人）。
        // 注意 commanderOf 返回读面副本——写回必须经 extra 原对象（同 mutateTactics 坑）
        const real = st.extra?.[K_COMMANDER] as CommanderShape | undefined;
        if (real) {
          const subs = c.subordinates.filter((s) => alive.has(s));
          if (subs.length !== c.subordinates.length) real.subordinates = subs;
          this.treeSnapshot.set(eid, [...real.subordinates]); // 快照覆盖装配态（死亡回读用）
        }
      }
      // 受命失效检查：玩家解除征召（drafted=false）→ 战术命令不再有效（尊重玩家）
      if (tacticsOf(st)?.underOrder && !draftedOf(st)) {
        clearOrderIn(st);
        ctx.logEvent(`#${eid} 解除征召——战术命令失效（玩家优先）`);
      }
    }
  }

  // ---- 战术驱动：逐受命小人按战术类别执行（冲锋/集火 = 设指定后交给 drafting 追击）----
  private driveTactics(): void {
    const ctx = this.ctx;
    const alive = new Set<number>(ctx.pawnList);
    for (const [eid, st] of ctx.pawnStates) {
      const t = tacticsOf(st);
      if (!t?.underOrder) continue;
      const order = t.underOrder;
      // 命令源（上级指挥官）死亡 → 战术失效（命令链断裂）。注意 tacticsOf 返回新对象，
      // 写回需经 extra 原对象：直接改 t 无效——用 extra 引用重设
      if (!alive.has(order.from)) {
        clearOrderIn(st);
        ctx.logEvent(`#${eid} 命令源（#${order.from}）阵亡——战术解除`);
        continue;
      }
      if ((st.commandCooldown ?? 0) > 0) continue; // 玩家手动命令优先（尊重指挥，同 drafting）
      const pos = ctx.pawnPositions.get(eid);
      if (!pos) continue;
      const def = TACTICS[order.tactic];
      if (!def) { // 未知战术 id（手写档脏数据）→ 清命令
        clearOrderIn(st);
        continue;
      }
      const now = ctx.time;
      switch (def.move) {
        case 'hold': {
          // 固守：清残余路径（若刚被 moveTo 设置过）原地待命；战术优先级高于自动索敌
          st.path = []; st.pathIndex = 0;
          break;
        }
        case 'engage': {
          // 冲锋：周期刷新指定目标 = 半径内最近敌人（engageRadius 20 > drafting 自动 14
          // → 主动出击先敌接战）；无敌人 → 清指定（drafting 回落自动接敌/待命）
          if (now - (this.repath.get(eid) ?? 0) < CFG.refreshInterval) break;
          const best = this.nearestHostile(pos, CFG.engageRadius);
          if (best) {
            this.repath.set(eid, now);
            setAttackTarget(st, best.idx, best.h.x, best.h.y);
          } else {
            clearAttackTarget(st);
          }
          break;
        }
        case 'focus': {
          // 集火：指挥官指定目标（dispatch 带 hostileIndex）→ 持续指定；目标消失（击杀
          // splice 下标错位/换批）→ 战术解除（集火对象没了，命令自然失效）
          if (order.target === undefined) {
            clearOrderIn(st);
            ctx.logEvent(`#${eid} 集火缺少目标——战术解除`);
            break;
          }
          const h = ctx.hostiles[order.target];
          if (!h) {
            clearOrderIn(st);
            ctx.logEvent(`#${eid} 集火目标已消失——战术解除`);
            break;
          }
          if (now - (this.repath.get(eid) ?? 0) < CFG.refreshInterval) break;
          this.repath.set(eid, now);
          setAttackTarget(st, order.target, h.x, h.y);
          break;
        }
        case 'retreat': {
          // 撤退：向最近敌人反方向转移（敌人动则目标点周期重算）；无敌人 = 安全，原地待命
          const foe = this.nearestHostile(pos, Infinity);
          if (!foe) break;
          if (now - (this.repath.get(eid) ?? 0) < CFG.moveInterval) break;
          this.repath.set(eid, now);
          const dx = pos.x - foe.h.x;
          const dy = pos.y - foe.h.y;
          const len = Math.hypot(dx, dy) || 1;
          this.moveScaled(eid, pos.x + (dx / len) * CFG.retreatDistance, pos.y + (dy / len) * CFG.retreatDistance);
          break;
        }
        case 'regroup': {
          // 集结：向指挥官身边聚集（八方向散布防挤成一团）；命令源死亡已在上方统一处理
          const cpos = ctx.pawnPositions.get(order.from);
          if (!cpos) break;
          if (now - (this.repath.get(eid) ?? 0) < CFG.moveInterval) break;
          this.repath.set(eid, now);
          const dir = ((eid % 8) / 8) * Math.PI * 2; // 稳定方向（按 eid 取，不随帧抖动）
          this.moveScaled(eid,
            cpos.x + Math.cos(dir) * CFG.regroupSpread,
            cpos.y + Math.sin(dir) * CFG.regroupSpread);
          break;
        }
      }
    }
  }

  // 半径内最近敌人（idx = hostiles 数组下标，与协议/attackTarget 对齐）
  private nearestHostile(pos: { x: number; y: number }, radius: number): { idx: number; h: { x: number; y: number } } | null {
    let best: { idx: number; h: { x: number; y: number } } | null = null;
    let bestD2 = radius * radius;
    for (let i = 0; i < this.ctx.hostiles.length; i++) {
      const h = this.ctx.hostiles[i];
      const d2 = (h.x - pos.x) ** 2 + (h.y - pos.y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = { idx: i, h }; }
    }
    return best;
  }

  // 目标点钳制到地图内再寻路（无限地图 ±MAX_TILE；撤退向量可能指向界外）
  private moveScaled(eid: number, tx: number, ty: number): void {
    const MAX = 20000; // ±MAX_TILE（world 常量；避免引入依赖循环，数值同源）
    const x = Math.max(-MAX, Math.min(MAX, Math.round(tx)));
    const y = Math.max(-MAX, Math.min(MAX, Math.round(ty)));
    this.ctx.moveTo(eid, x, y, { markCommand: false });
  }
}

// ---- 玩法包装配 ----
export const fieldCommandPack: ModPack = {
  id: 'field-command',
  // 依赖 drafting：复用征召门（K_DRAFTED）与指定攻击（K_ATTACK）语义——受命 = 征召、
  // 集火/冲锋 = 批量 setAttackTarget。本包是"指挥官层"：没有征召机制则战术命令无处执行。
  requires: ['drafting'],
  apply(m: ModRegistry): void {
    // 驱动系统：category 'raid'（与 raid 同期，注册在 drafting 之后 → 每 tick 先征召追击
    // 结算（冲锋/集火拖动）再战术修正（固守清路径/撤退改道/集结引导））
    m.registerSystemDef({ id: 'field-command', label: '战场指挥', category: 'raid', ctor: (s: Sim) => new FieldCommandSystem(s) });

    // commander 命令：{ pawnId, role?: 'officer'|'general'|'none', subordinates?: number[],
    //                    active?: 战术 id|'none' }
    // 册封/编队/解编 + 战术编排（active 槽 = 持久预设：无临战命令时按编排执行，随档）。
    // role 缺省自动推导：subordinates 含队长（officer）→ 军团长 general，否则队长 officer
    //（玩家只描述"谁归谁管"，层级自动——多层指挥零配置）。
    m.registerCommand('commander', (ctx, cmd) => {
      const eid = cmd.pawnId;
      if (eid === undefined) { ctx.logEvent('⚠ 册封失败：小人不存在'); return; }
      const st = ctx.pawnStates.get(eid);
      if (!st) { ctx.logEvent('⚠ 册封失败：小人不存在'); return; }
      const args = (cmd.args ?? {}) as Record<string, unknown>;
      const subs = Array.isArray(args.subordinates)
        ? args.subordinates.filter((v): v is number => typeof v === 'number' && v !== eid)
        : [];
      if (args.role === 'none') {
        clearTree(ctx, eid, `☮ 解编指挥官 #${eid}（小队恢复自主）`);
        delete st.extra?.[K_COMMANDER];
        ctx.logEvent(`☮ 解编 #${eid}`);
        return;
      }
      const isCommander = (s: number): boolean => commanderOf(ctx.pawnStates.get(s)) !== null;
      let role: 'officer' | 'general' = args.role === 'general' ? 'general' : 'officer';
      if (role === 'officer' && subs.some(isCommander)) {
        // 自动升级：辖下有队长 = 军团长（层级由结构推导，不靠手填——多层指挥零配置）
        role = 'general';
        ctx.logEvent(`#${eid} 辖下有队长——自动晋升为军团长（general）`);
      }
      st.extra = st.extra ?? {};
      st.extra[K_COMMANDER] = { role, subordinates: subs };
      // 战术编排槽（active）：commander 命令可选携带（'none'/缺省 = 清编排）。
      // 语义 = 持久预设位：临战下达（underOrder）优先于编排，收兵后回到编排执行。
      const av = args.active;
      if (av !== undefined) {
        const t = ensureTacticsExtra(st);
        // 形状收窄：非字符串/'none'/战术表外 id 一律清编排（宽容入参，脏数据不自毁）
        if (av === 'none' || typeof av !== 'string' || !(av in TACTICS)) t.active = null;
        else t.active = av;
      }
      ctx.logEvent(`${role === 'general' ? '🏳 军团长' : '⚔ 队长'} #${eid} 就任，编组 ${subs.length} 人`);
    });

    // train 命令：{ pawnId, tactic }——训练战术动作（learned 列表即时掌握 + 个人冷却）。
    // "通过训练编排战术动作"：训练 = 学习（learned 永久掌握，随档）；之后指挥官下发
    // 战术时以 learned 为可选范围（HUD 训练按钮 + 战术列表）——兵团的核心培养循环。
    m.registerCommand('train', (ctx, cmd) => {
      const eid = cmd.pawnId;
      if (eid === undefined) { ctx.logEvent('⚠ 训练失败：小人不存在'); return; }
      const st = ctx.pawnStates.get(eid);
      if (!st) { ctx.logEvent('⚠ 训练失败：小人不存在'); return; }
      const aid = (cmd.args ?? {}).tactic as string | undefined;
      const def = aid ? TACTICS[aid] : undefined;
      if (!def) { ctx.logEvent(`⚠ 未知战术「${aid}」（战术表：${Object.keys(TACTICS).join('/')}）`); return; }
      // 冷却：time 从 0 起步——"从未训练"（表内无记录）才是放行条件，不能用
      // time - 0 < 15 判断（开局首次训练会被误拒）。
      const cdMap = trainCd.get(ctx);
      const cd = cdMap?.get(eid);
      if (cd !== undefined && ctx.time - cd < CFG.trainCooldown) {
        ctx.logEvent(`⏳ #${eid} 训练中（${Math.ceil(CFG.trainCooldown - (ctx.time - cd))}s 后可再训练）`);
        return;
      }
      const t = ensureTacticsExtra(st); // 经 extra 原对象写回（读面副本不可写）
      if (t.learned.includes(def.id)) { ctx.logEvent(`#${eid} 已掌握「${def.label}」（重复训练无额外收益）`); return; }
      t.learned.push(def.id);
      stampTrain(ctx, eid, ctx.time);
      ctx.logEvent(`🎓 #${eid} 训练掌握「${def.label}」：${def.desc}`);
    });

    // dispatch 命令：{ pawnId（指挥官）, tactic: 战术 id | 'none', hostileIndex? }
    // 战术下达：指挥官 → 级联整树（军团长命令 → 队长 → 兵 = 多层指挥）；
    // 'none' = 收兵（全树战术解除 + 恢复自主）；focus 需要 hostileIndex（集火目标）。
    m.registerCommand('dispatch', (ctx, cmd) => {
      const eid = cmd.pawnId;
      if (eid === undefined) { ctx.logEvent('⚠ 指挥失败：小人不存在'); return; }
      const st = ctx.pawnStates.get(eid);
      if (!st) { ctx.logEvent('⚠ 指挥失败：小人不存在'); return; }
      if (!commanderOf(st)) { ctx.logEvent(`⚠ #${eid} 不是指挥官（先册封：commander 命令）`); return; }
      const args = (cmd.args ?? {}) as Record<string, unknown>;
      const aid = typeof args.tactic === 'string' ? args.tactic : undefined;
      if (aid === undefined || aid === 'none') {
        clearTree(ctx, eid, `☕ #${eid} 下达收兵——小队解除征召恢复自主`);
        return;
      }
      const def = TACTICS[aid];
      if (!def) { ctx.logEvent(`⚠ 未知战术「${aid}」（战术表：${Object.keys(TACTICS).join('/')}）`); return; }
      const target = typeof args.hostileIndex === 'number' ? args.hostileIndex : undefined;
      if (def.move === 'focus' && (target === undefined || !ctx.hostiles[target])) {
        ctx.logEvent('⚠ 集火需要有效的 hostileIndex（右键敌人后下达）');
        return;
      }
      if (target !== undefined && !ctx.hostiles[target]) {
        ctx.logEvent(`⚠ 目标敌人已不存在（${target}）`);
        return;
      }
      const count = dispatchTree(ctx, eid, def.id, target);
      ctx.logEvent(`📣 #${eid} 下达「${def.label}」→ ${count} 人受命（${def.desc}）`);
    });
  },
};