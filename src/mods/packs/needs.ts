/**
 * needs 包 —— 需求衰减 + 吃/睡种子卡 + 饥饿疲惫权重调制 + 欲望层（R3-1）。
 *
 * 原则①②的落点：饥饿不构成"必须吃"的规则——它只是把 eat/gather 系列卡的权重推高；
 * 抽不到就继续饿（饿出故事）。衰减速率全部读 tuning.needs，零硬编码。
 *
 * ---- 欲望层（R3-1）：欲望 = 缓慢积累的**第二类权重输入** ----
 * 与 needs（衰减型：从 100 往下掉、匮乏导向）相反，desires 是**积累型**（从 0 慢慢长、
 * 渴望导向）：每条欲望有自己的"积累源"（久留不动 / 独处 / 摸鱼），憋到 highAt 就抬对应
 * 系列的权重，**执行对应系列卡就消解**。实现与数值全部读 `tuning.desires` 数据表
 * （机制立论见那张表的注释），本文件只提供源谓词的实现 + 一个统一权重钩子 + 一个系统。
 * 红线：欲望是念力（权重调制），不是指令——没有任何 if 让鼠"必须去闲逛"，
 * 抽不到就继续憋着，与"抽不到 eat 就继续饿"同构。
 */
import type { ModPack } from '../pack';
import { K_STOCK_FOOD, K_STOCK_MEAL } from '../contracts';
import { SER_EAT, SER_REST, SER_GATHER, SER_SOCIAL, SER_WANDER, SER_FIGHT } from '../contracts';
import { SER_WOOD, SER_BUILD, SER_FARM, SER_COOK } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { PawnState } from '../../sim/types';
import type { DesireTuningEntry } from '../../sim/tuning';

/** 生产系列集合（劳动欲的"摸鱼"判据反集）：干这些=在干活，不干=在摸鱼。
 *  语义：凡是往库存/建筑里添东西的都算"生产"（采集/伐木/建造/农耕/烹饪）。 */
const PROD_SERIES = new Set<string>([SER_GATHER, SER_WOOD, SER_BUILD, SER_FARM, SER_COOK]);

/** 欲望值 scratch 键：`needs.d.<欲望id>.<鼠eid>` → 0..100（随档，见系统注释） */
function desireKey(eid: number, desireId: string): string {
  return `needs.d.${desireId}.${eid}`;
}
/** 仍然静止累计秒数键（source='still' 的 bookkeeping）：`needs.ds.<鼠eid>` → 秒（随档） */
function stillKey(eid: number): string {
  return `needs.ds.${eid}`;
}
/** 读欲望值（缺省 0；不写回——写回只发生在欲望系统里，保持单点写） */
function desireOf(ctx: SimContext, eid: number, desireId: string): number {
  return ctx.scratch[desireKey(eid, desireId)] ?? 0;
}

export const needsPack: ModPack = {
  id: 'needs',
  requires: [],
  apply(m) {
    // ---- 系统：需求随时间衰减（类别 needs → 先于决策引擎执行）----
    m.registerSystemDef({
      id: 'needs',
      category: 'needs',
      ctor: (ctx: SimContext) => ({
        id: 'needs',
        update(dt) {
          const n = ctx.tuning.needs;
          for (const p of ctx.pawns()) {
            p.needs.food = clamp(p.needs.food - n.foodDecay * dt);
            p.needs.rest = clamp(p.needs.rest - n.restDecay * dt);
            p.needs.mood = clamp(p.needs.mood - n.moodDecay * dt);
            p.needs.san = clamp(p.needs.san - n.sanDecay * dt);
          }
        },
      }),
    });

    // ---- 系统：欲望积累/消解（R3-1，类别 needs → 仍先于决策引擎，与衰减同拍）----
    //
    // 为什么状态放 ctx.scratch 而不是闭包/PawnState 字段：欲望是跨 tick 的玩法包
    // 运行态，存档纪律（DLC_PACKS_v3 / DESIGN §存档）要求随档可还原——scratch 整份
    // 进 SaveData 且进 golden 指纹；闭包状态存档无法还原。键带鼠 eid（欲望是个体的，
    // 不是营地的）。
    //
    // 为什么积累源是"读当前世界状态"而不是"闭包计时"：每条欲望的源谓词
    // （见 desireSourceHolds）从 pawn 的可观测状态（path/cardId/同伴距离）直接推导，
    // 唯一需要跨 tick 记的是"连续静止秒数"（stillKey）——它同样进 scratch。
    m.registerSystemDef({
      id: 'needs-desires',
      category: 'needs',
      ctor: (ctx: SimContext) => ({
        id: 'needs-desires',
        update(dt) {
          for (const p of ctx.pawns()) updateDesires(ctx, p, dt);
        },
      }),
    });

    // ---- 权重钩子：需求只是权重输入（原则①：禁止 if-else 行为树）----
    m.registerHook('cardWeight', (p, card) => {
      const f = p.needs.food;
      if (card.series === SER_EAT) return f < 30 ? 4 : f < 55 ? 1.8 : 1;
      if (card.series === SER_GATHER) return f < 30 ? 2.5 : f < 55 ? 1.4 : 1;
      return 1;
    });
    m.registerHook('cardWeight', (p, card) => {
      const r = p.needs.rest;
      if (card.series !== SER_REST) return 1;
      return r < 25 ? 5 : r < 50 ? 2 : 1;
    });
    m.registerHook('cardWeight', (p, card) => {
      if (p.needs.mood >= 35) return 1;
      if (card.series === SER_SOCIAL) return 2; // 低落找同伴
      if (card.series === SER_WANDER) return 1.5;
      return 1;
    });
    m.registerHook('cardWeight', (p, card) => {
      if (p.needs.san >= 20) return 1;
      // 崩溃边缘：不想打架、只想缩起来
      if (card.series === SER_FIGHT) return 0.5;
      if (card.series === SER_REST) return 1.5;
      return 1;
    });

    // ---- 欲望权重钩子（R3-1）：欲望达到 highAt → 把对应系列乘 weightMul。
    //     与既有 needs 钩子相乘叠加（管线本来就是 base × 钩子1 × 钩子2 × …）。
    //     只抬不压：欲望是"想做什么"，不是"不敢做什么"（压制留给 raid 的威胁钩子）。----
    m.registerHook('cardWeight', (p, card, ctx) => {
      const table = ctx.tuning.desires;
      let w = 1;
      for (const [id, def] of Object.entries(table)) {
        if (!def.series.includes(card.series)) continue; // 只调制本欲望管的系列
        if (desireOf(ctx, p.eid, id) >= def.highAt) w *= def.weightMul;
      }
      return w;
    });

    // ---- 卡：闲逛（无活可干时的种子行为：随机小步走 + 微心情恢复。
    //      没有它，"什么卡都抽不中"的鼠只能吃引擎兜底——闲逛是玩法不是引擎职责）----
    m.registerCard({
      id: 'wander',
      label: '闲逛',
      series: SER_WANDER,
      weight: 3,
      duration: 3,
      action(p, ctx, dt) {
        if (p.path.length === 0) {
          // 随机方向 1~2 格，最多试 4 次挑可通行落点（随机源 = ctx.rng，同 seed 同闲逛史）；
          // 此前盲选常落在水上 → setPath 失败 → 鼠在水边呆立一整个卡期
          for (let i = 0; i < 4; i++) {
            const ang = ctx.rng() * Math.PI * 2;
            const dist = 1 + Math.floor(ctx.rng() * 2);
            const tx = Math.round(p.pos.x + Math.cos(ang) * dist);
            const ty = Math.round(p.pos.y + Math.sin(ang) * dist);
            if (ctx.passable(tx, ty)) {
              ctx.setPath(p, tx, ty);
              break;
            }
          }
        }
        p.needs.mood = clamp(p.needs.mood + 0.5 * dt); // 散步的微小治愈
      },
    });

    // ---- 卡：吃东西（营地仓库抽象；运货工作卡是未来玩法，不预设机制链）
    //
    // 【R3-4 订正：先吃熟食再吃生食】熟食是**并列的第二种食物**（contracts K_STOCK_MEAL），
    // 每份换到的饱食更多（tuning.cooking.eatCookedFoodGain > tuning.needs.eatFoodGain）。
    // 为什么必须在这里改而不是让 cooking 包自己新增一张"吃熟食"卡：
    //  - 一张"吃熟食"卡会让同一件事分裂成两张卡互相争权重，并让"先吃哪个"变成
    //    抽签结果（明明熟食严格更优，鼠却可能先啃一口生食）——那不是涌现，是 bug；
    //  - 吃是**同一个动作**（取一份食物、结算饱食），只是"取哪一份"不同，所以
    //    "优先熟食"是一条确定性的取值规则，不是行为规则（原则① 只约束自主行为）。
    // 卸载纪律：cooking 包不在时 stockpile.meal 恒 undefined → 退化成纯生食，行为同改动前。
    m.registerCard({
      id: 'eat',
      label: '吃东西',
      series: SER_EAT,
      weight: 8,
      condition: (p, ctx) => p.needs.food < 95 && hasAnyFood(ctx),
      action: (p, ctx) => {
        // 即时结算卡：效果一次 + finishCard 防止 duration 内重复进食
        const meal = ctx.stockpile[K_STOCK_MEAL] ?? 0;
        const raw = ctx.stockpile[K_STOCK_FOOD] ?? 0;
        if (meal <= 0 && raw <= 0) {
          ctx.finishCard(p);
          return;
        }
        const c = ctx.tuning;
        if (meal > 0) {
          // 熟食优先：同等"花一次吃的工夫"换更多饱食，鼠没有理由挑差的
          ctx.stockpile[K_STOCK_MEAL] = meal - 1;
          p.needs.food = clamp(p.needs.food + c.cooking.eatCookedFoodGain);
        } else {
          ctx.stockpile[K_STOCK_FOOD] = raw - 1;
          p.needs.food = clamp(p.needs.food + c.needs.eatFoodGain);
        }
        p.needs.mood = clamp(p.needs.mood + c.needs.eatMoodGain);
        ctx.finishCard(p);
      },
    });

    // ---- 卡：睡觉（火旁睡得又快又安稳——火的价值观由数值自然表达）----
    //
    // ---- 缺陷订正（2026-10-06）：睡觉卡从"硬编码 8 格找火"改成"磁铁" ----
    //
    // 【原缺陷·现象】实测（4 seed × 900s）：睡眠卡执行的 573 个 tick 里，
    //   **只有 14.5%** 火在 8 格内、真正贴到火边（2.5 格）的只有 **12.7%**。
    //   ⇒ 85.5% 的睡眠是"野外打盹"。
    // 【原缺陷·根因】`nearestBuildingByTag('fire', ..., 8)` 把"8 格"同时当成了
    //   **"值不值得走过去"** 与 **"贴到火边"** 两个语义。而实测鼠到最近火堆的
    //   距离**中位数 12.1 格**（全局 ≤8 格只有 23.6%）——搜不到火时 else 分支
    //   直接 `sleepRestWild` 并且**永不尝试去找火**，于是"火=安全感的锚点"
    //   这条设计（sleepRestNearFire / sleepSanNearFire / 棚屋回心情）全部落空。
    //   这是 chat / farming 同一个根因的第三个实例：**硬闸半径被当成贴身距离**。
    // 【修法】拆成两个半径，同一张卡内完成"走过去 + 躺下"：
    //   - 找火用 **sleepMagnetRadius（24 格）** = 值得为之走过去的距离；
    //   - 走到 **火边半径（2.5 格）**内才结算火旁数值与棚屋心情；
    //   - 路上照常以 sleepRestWild 缓慢恢复（不站在原地发呆，也不无理由不走）；
    //   - 不可达就 finishCard 收工（否则"火看得见却永远到不了"⇒ 原地空转）。
    // 【推翻路径】若实测导致鼠群过度向火堆扎堆（采集半径被压缩），
    //   把 `needs.sleepMagnetRadius` 调小即可回退，不必改代码结构。
    m.registerCard({
      id: 'sleep',
      label: '睡觉',
      series: SER_REST,
      weight: 6,
      duration: 10,
      condition: (p) => p.needs.rest < 70,
      action(p, ctx, dt) {
        const n = ctx.tuning.needs;
        // 磁铁半径内最近的火堆（= "愿意为之走过去"）；找不到就真的只能野外睡
        const fire = ctx.nearestBuildingByTag('fire', p.pos.x, p.pos.y, n.sleepMagnetRadius);
        if (!fire) {
          // 营地里一处火都没有（或火都在磁铁圈外）：野外打盹，不站桩
          p.needs.rest = clamp(p.needs.rest + n.sleepRestWild * dt);
          if (p.needs.rest >= 98) ctx.finishCard(p);
          return;
        }
        if (!ctx.adjacent(p, fire.pos.x, fire.pos.y, FIRE_SIDE_R)) {
          // 还不够近——**走过去**。路上也恢复一点体力（睡得慢，但不在原地罚站）
          if (p.path.length === 0 && !ctx.setPath(p, fire.pos.x, fire.pos.y)) {
            ctx.finishCard(p); // 火被水/岩隔断：不可达就收工，防恒真空转
          }
          p.needs.rest = clamp(p.needs.rest + n.sleepRestWild * dt);
          if (p.needs.rest >= 98) ctx.finishCard(p);
          return;
        }
        p.path = []; // 躺下停走
        p.needs.rest = clamp(p.needs.rest + n.sleepRestNearFire * dt);
        p.needs.san = clamp(p.needs.san + n.sleepSanNearFire * dt);
        // 棚屋旁边睡：额外回心情（家的安全感——shelter 标签终于有功能了）
        const shelter = ctx.nearestBuildingByTag('shelter', p.pos.x, p.pos.y, 3);
        if (shelter) p.needs.mood = clamp(p.needs.mood + 1 * dt);
        if (p.needs.rest >= 98) ctx.finishCard(p); // 睡饱即醒
      },
    });
  },
};

export function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** 营地里有没有任何可入口的东西（生食或熟食，R3-4 起熟食也算）。
 *  抽成函数是为了 condition 与 action 用**同一份**判据——两处各写一遍必然漂移，
 *  而漂移的后果是"卡被抽中却吃不到东西"（空转一整个 duration）。 */
function hasAnyFood(ctx: SimContext): boolean {
  return (ctx.stockpile[K_STOCK_FOOD] ?? 0) > 0 || (ctx.stockpile[K_STOCK_MEAL] ?? 0) > 0;
}

/** 火边半径（格）：贴到火这么近才结算"火旁睡"的高档数值。
 *  为什么不进 tuning：它是**"躺下"的伸手范围**，与"值不值得走过去"（磁铁半径，
 *  进 tuning 的 needs.sleepMagnetRadius）是两种语义，量级差 10 倍；
 *  留成本文件常量是刻意的——它不属于"可被 mod 调平衡的玩法数值"，
 *  语义等同 gathering 里的 AVOID_SEC（实现参数，非玩法数值）。 */
const FIRE_SIDE_R = 2.5;

// ==================== 欲望层（R3-1）实现 ====================

/** 每 tick 每鼠更新全部欲望：源条件成立 → 积累；执行被调制系列卡 → 消解。
 *  数值全从 tuning.desires 表读（原则③），键进 scratch 随档。 */
function updateDesires(ctx: SimContext, p: PawnState, dt: number): void {
  const table = ctx.tuning.desires;
  for (const [id, def] of Object.entries(table)) {
    let v = desireOf(ctx, p.eid, id);
    if (desireSourceHolds(ctx, p, def, dt)) v += def.gainPerSec * dt;
    if (activeSatisfies(ctx, p, def)) v -= def.satisfyPerSec * dt;
    ctx.scratch[desireKey(p.eid, id)] = clamp(v);
  }
}

/** 源谓词：这条欲望的"憋着"条件是否成立（实现 = tuning 表里 source 枚举的有限集）。
 *  - still（闲逛欲）：连续静止超过 stillGateSec（bookkeeping 在 scratch 的 stillKey，
 *    移动即清零——"久留不动"是连续语义，不是累计语义）；
 *  - alone（陪伴欲）：senseRadius 内没有任何同伴（含自己）；
 *  - notworking（劳动欲）：当前执行的卡不属于生产系列（没在生产 = 在摸鱼；
 *    _stun 兜底卡 / 无卡也视为摸鱼——摸鱼的定义是"没有在产出"）。 */
function desireSourceHolds(ctx: SimContext, p: PawnState, def: DesireTuningEntry, dt: number): boolean {
  if (def.source === 'still') {
    return stillStreak(ctx, p, dt) >= (def.stillGateSec ?? 0);
  }
  if (def.source === 'alone') {
    const r = def.senseRadius ?? 26;
    for (const o of ctx.pawns()) {
      if (o.eid === p.eid) continue;
      if (Math.hypot(o.pos.x - p.pos.x, o.pos.y - p.pos.y) <= r) return false;
    }
    return true;
  }
  if (def.source === 'notworking') {
    const card = p.cardId !== null ? ctx.cardById(p.cardId) : undefined;
    return card === undefined || !PROD_SERIES.has(card.series);
  }
  return false;
}

/** 连续静止秒数（source='still' 的共享 bookkeeping）：path 空 → +dt，非空 → 清零。
 *  为什么清零而不是累计："久留不动"指的是**一段连续的**不动，中断重来。 */
function stillStreak(ctx: SimContext, p: PawnState, dt: number): number {
  const key = stillKey(p.eid);
  if (p.path.length === 0) {
    ctx.scratch[key] = (ctx.scratch[key] ?? 0) + dt;
    return ctx.scratch[key];
  }
  delete ctx.scratch[key];
  return 0;
}

/** 消解谓词：鼠当前正在执行被调制系列里的卡（闲逛了 → 闲逛欲消解）。 */
function activeSatisfies(ctx: SimContext, p: PawnState, def: DesireTuningEntry): boolean {
  if (p.cardId === null) return false;
  const card = ctx.cardById(p.cardId);
  return card !== undefined && def.series.includes(card.series);
}
