// 神谕卡式工作引导玩法包（RW-1 M1 修订版，2026-08-15）
// 背景：第一轮 M1 实现为"Work Tab 1-4 数字优先级表"（39dfe29），用户裁决撤回——
//   玩家直接设置每小人的行为优先级 = "直接管理意图进入选择链"，违背项目核心设计
//   一切皆抽卡 / 神谕不碰选择链（see docs/RW_SPRINT2.md）。旧档 extra 里的残留键无害
//   （无人消费 = 卸载不破坏核心，契约键已删）。
// 本包 = 修订方案：玩家经"神谕/策略面板"下发策略卡（伐木令/采矿令/垦田令/拓荒令…），
//   一切效果走既有的神谕通道，零新增 pawn 状态键、零协议字段：
//   ① setOracleGoal（目标层）：对应工作类型抽卡权重 ×tuning.card.oracleGoalMul（=3），
//      不插小人卡槽、不碰选择链——小人仍抽 3 选 1，可能不抽到、被欲望/收益顶掉、违抗；
//   ② 蓝图副作用（策略卡 blueprint 声明，垦田令→农田、拓荒令→营地）：走 build 命令入队
//      （与 dummyLlm.applyBlueprint 同构路径；dummyLlm 是 LLM 层禁改（任务 §8），故本包
//      自带落点扫描，队列去重保证"只入队一次"）；
//   ③ 可选"目标卡/习惯卡"：有选中小人时经 printCard 把策略卡插入其槽位（空槽优先、
//      满则顶掉 weight 最低卡）——插入后仍走抽卡池，小人可能不抽到/违抗。
//   冷却 + 持续时间（CFG）防止面板变成遥控器。
// 为什么命令跟着玩法包而非内核：面板/命令/卡片全是玩法层数据；内核仅一处接口扩展 =
//   SimContext.printCard（Sim 早已实现 = LLM 印卡通道，纯插件不可达小人槽位）。
import type { ModRegistry } from '../../sim/mods/registry';
import type { SimContext } from '../../sim/systems/context';
import type { BehaviorCardDef } from '../../sim/ai/pawn';
import type { StrategyCardDef } from '../../sim/defs/strategyCards';
import { World } from '../../sim/core/world';
import type { ModPack } from '../pack';

// 本包数值（玩法包自治；DATA_DRIVEN §13 包内 CFG——数据驱动铁律：不写魔法数）
const CFG = {
  cooldownSeconds: 45, // 降旨冷却（秒）：面板/命令的节流闸，避免连点 = 遥控器。
  //   与 commandCooldown（3s）同设计：冷却为瞬态不随档（有意轻量存档，见 DATA_DRIVEN §14）。
  defaultDuration: 120, // 目标持续（秒）：缺省与随机神谕（dummyLlm）的目标周期一致——
  //   玩家降旨与神谕降旨是同一目标槽（sim.oracleGoal 单槽），周期统一避免行为跳变。
};

// 降旨冷却表：按 SimContext 实例隔离（WeakMap 键 = 对象身份，GC 安全）。
// 为什么不用系统实例字段：命令处理器是 apply 闭包，拿不到注册系统实例；
//   模块级 Map 会跨 Sim 串扰（多实例同跑时冷却互相污染）——WeakMap 按 ctx 精确隔离。
const cooldownUntil = new WeakMap<SimContext, number>();

// 策略卡 → 习惯卡 def（printCard 用）：id 前缀 'strategy:' 供 HUD 识别"身上策略卡"。
// 与 dummyLlm.strategyToDef 同构（satisfies 微量满足贪欲 = 卡自带满足声明，数据驱动）；
// utilityFixed 固定 20 = 与随机神谕一致（插入卡不因 utility 脱靶）。
function strategyToHabit(c: StrategyCardDef): BehaviorCardDef {
  return {
    id: `strategy:${c.id}`,
    name: c.label,
    series: c.series ?? 'work',
    weight: c.weight,
    utilityFixed: 20,
    action: c.action,
    workType: c.workType,
    label: c.label,
    reason: c.reason,
    satisfies: [{ desire: 'greed', amount: 1 }],
  } as BehaviorCardDef;
}

// 蓝图副作用（策略卡 blueprint 声明 → build 命令入队）：
// 与 dummyLlm.applyBlueprint 同名同构（落点扫描 nearCamp=营地旁环扫 / far=远处环扫，
// 半径由近及远回退），但跑在 SimContext 上（LLM 层禁改，不 import 服务端函数）。
// 队列去重：buildQueue 已有同 defId 蓝图 → 跳过（"蓝图副作用只入队一次"，见测试 #4）。
// 垦田令→farm、拓荒令→campfire 建成后自动形成产出/新营地（引擎既有建造闭环）。
function blueprintToQueue(ctx: SimContext, card: StrategyCardDef): void {
  const bp = card.blueprint;
  if (!bp) return;
  const def = ctx.mods.buildings[bp.defId];
  if (!def) return;
  if (ctx.buildQueue.some((b) => b.defId === bp.defId)) return; // 已在队列 → 不重复入队
  let camp: { x: number; y: number } | null = null;
  for (const [key, b] of ctx.world.buildings) {
    if (b.def.id === 'campfire') { camp = World.keyToXY(key); break; }
  }
  const findEmpty = (radius: number): { x: number; y: number } | null => {
    if (!camp) return null;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = camp.x + dx;
        const y = camp.y + dy;
        if (ctx.world.canBuildFootprint(x, y, def)) return { x, y };
      }
    }
    return null;
  };
  const chain = bp.spot === 'nearCamp' ? [3, 4, 5] : [12, 10, 8];
  for (const r of chain) {
    const spot = findEmpty(r);
    if (spot) {
      ctx.issueCommand({ type: 'build', x: spot.x, y: spot.y, buildingId: bp.defId });
      return;
    }
  }
}

// 神谕指引玩法包装配（RW-1 M1 修订）
export const oracleGuidancePack: ModPack = {
  id: 'oracle-guidance',
  // 无硬前置：只走引擎协议面（setOracleGoal/printCard/issueCommand/build 命令）与
  // 策略卡数据（registry 内置表）；卸载本包 = 面板消失 + 伐木令/采矿令卡消失，
  // 不影响其他包（契约键为零新增）。
  requires: [],
  apply(m: ModRegistry): void {
    // strategy 命令：{ pawnId?, args:{ cardId } }——玩家降下某张策略卡（神谕指引）。
    // 单机/远程通用（远程 = 服务端权威执行，cmdValidate 走通用通道，卡 id 由本处理器把关）。
    m.registerCommand('strategy', (ctx, cmd) => {
      const cardId = (cmd.args as Record<string, unknown> | undefined)?.cardId;
      const card = typeof cardId === 'string'
        ? ctx.mods.strategyCards.find((c) => c.id === cardId)
        : undefined;
      if (!card) { ctx.logEvent('❓ 没有这张策略卡'); return; }
      // 冷却闸（权威）：面板侧是本地估算展示，这里才是真闸——冷却中拒绝并反馈倒计时。
      const now = ctx.time;
      const cdAt = cooldownUntil.get(ctx) ?? -Infinity;
      if (now < cdAt) {
        ctx.logEvent(`🕯 神谕仍在沉思（${Math.ceil(cdAt - now)}s 后可再降旨）`);
        return;
      }
      blueprintToQueue(ctx, card); // ② 蓝图副作用（幂等）
      // ① 目标层：只放大对应工作抽卡权重（×oracleGoalMul），不碰选择链、不插卡槽
      const duration = card.duration ?? CFG.defaultDuration;
      ctx.setOracleGoal({ workType: card.workType, label: card.label, duration });
      cooldownUntil.set(ctx, now + CFG.cooldownSeconds);
      ctx.logEvent(`🎯 玩家降旨「${card.label}」（目标 ${duration}s，冷却 ${CFG.cooldownSeconds}s）`);
      // ③ 可选插卡：有选中小人 → printCard 插入"目标卡/习惯卡"（槽满顶低权重 = 引擎
      // 既有语义）。插入后仍走抽 3 选 1——小人不保证抽到、不保证执行（大纲要求）。satisfies
      // 文本随 label：侧写"遵循策略卡"的小人更可能抽到对应工作卡（习惯卡雏形）。
      for (const eid of ctx.selected) {
        if (!ctx.pawnStates.has(eid)) continue;
        ctx.printCard(strategyToHabit(card), { target: eid, note: `遵循「${card.label}」` });
      }
    });

    // 新增策略卡 2 张（2026-08-13 定案："伐木令退位为可选神谕目标"落库）：
    // 只作引导（目标持续期内对应工作权重 ×3），不做经济平衡（经济调节归 economy 包
    // factionPriority 账本）——与内置卡同构，面板/随机神谕都读同一张表。
    // 阈值读 tuning（population.foodThreshold = 通用"资源低线"，mod 可覆盖）。
    m.registerStrategyCard({
      id: 'oracle:chop', label: '伐木令', action: 'walkAndWork', workType: 'chop',
      weight: 8, condition: { kind: 'stockLow', item: 'wood', below: { tuning: 'population.foodThreshold' } },
      reason: '木料紧张，伐木去',
    });
    m.registerStrategyCard({
      id: 'oracle:mine', label: '采矿令', action: 'walkAndWork', workType: 'mine',
      weight: 7, condition: { kind: 'stockLow', item: 'ore', below: { tuning: 'population.foodThreshold' } },
      reason: '矿石告急，开矿去',
    });
  },
};