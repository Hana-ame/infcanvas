/**
 * env 包 —— 环境（昼夜 / 温度 / 天气）+ 冻伤中暑（SEED「寒冬 / 野外」）。
 *
 * ---------------------------------------------------------------------------------
 * ---- 红线①（一切皆抽卡）：本包**不做任何新卡** ----
 * ---------------------------------------------------------------------------------
 * 环境不是一种行为，是**世界自己转出来的事实**。它只有两条施压路径：
 *   ① 权重钩子（cardWeight）——天冷 / 下雨时把「休息」与「户外工作」系列的天平倾斜；
 *   ② 掉血（ctx.damagePawn）——无庇护的极端温度直接扣血。
 * 鼠怎么应对（躲到火旁、雨天不出工）**完全由抽卡池自己涌现**：
 * 没有「冷了就强制走向火堆」的 if-else 行为树，没有任务队列，没有强制指令。
 * 抽不到休息卡就继续挨冻——冻死也是故事（原则②：输就是好玩）。
 *
 * 冻伤/中暑为什么可以走 damagePawn 而不算违反红线①：
 * 掉血是**世界事实**（像敌人的掉落写进内核 stockpile 一样），不是行为规则。
 * 红线①约束的是「鼠该做什么」，而温度扣血是「世界对它做了什么」——
 * 前者必须由抽卡决定，后者天然是系统。死亡原因字符串固定为 '冻伤' / '中暑'
 * （进日志与指纹，不能因文案微调而漂移）。
 *
 * ---------------------------------------------------------------------------------
 * ---- 存档纪律：跨 tick 状态全走 ctx.scratch（键前缀 "env."）----
 * ---------------------------------------------------------------------------------
 * 昼夜相位、当前温度、是否下雨、天气掷骰累积器、播报去抖标志——全部是
 * 跨 tick 状态，一律进 scratch 随档；**禁止闭包存状态**，否则存档无法还原
 * （这是本项目已踩过的坑：闭包状态在读档后凭空丢失，世界悄悄分叉）。
 *
 * 卸载语义（原则④）：不挂本包 → 无 env-tick 系统、无环境权重钩子，
 * 世界照跑且 rng 消耗序列**完全不受影响**（雨骰只在 env 系统里消耗）。
 *
 * 数值：全部读 tuning.env，本文件零魔法数字（原则③）。
 */
import type { ModPack } from '../pack';
import { K_TAG_FIRE, K_TAG_SHELTER, SER_GATHER, SER_REST, SER_WOOD } from '../contracts';
import type { SimContext } from '../../sim/context';
import type { PawnState } from '../../sim/types';
import type { Tuning } from '../../sim/tuning';

/** tuning.env 的简称（仅供本文件内部签名用；类型导入，零运行时耦合） */
type EnvTuning = Tuning['env'];

// ---- scratch 键（随档）----
const K_DAY_PHASE = 'env.dayPhase';

/**
 * 温度三键契约 —— ⚠ 跨包写方隔离，这是本文件最容易被改坏的约定。
 *
 *  - `env.tempBase`：env 自己按昼夜循环算出的**周期基准温度**。只有 env 写。
 *  - `env.tempMod`：事件侧的**修饰量**（additive）。只有 events 包写（缺省 0）。
 *  - `env.temp`：**最终温度 = tempBase + tempMod**。只有 env 写；
 *    所有下游（冻伤/中暑判定、播报、权重钩子，以及 events 包自己的 tempShift）
 *    **只读这一个键**。
 *
 * ⚠ 纪律：**绝不允许两个包写同一个键**。后写的赢，而冲突不报错。
 * 已发生的事故：env 每 tick 覆写 env.temp，而 events 的 coldsnap 事件写
 * `env.temp -= 12` ⇒ coldsnap 的降温在下一个 tick 就被昼夜循环抹掉，
 * 寒潮事件是**完全无效的静默 no-op**——events 的测试只预设 scratch、没挂真的
 * env 包，所以测不出来。现在写方分离：env 写 tempBase 与 temp（合成），
 * events 只写 tempMod；env.test.ts ⑨ 是专门钉这条契约的跨包测试。
 */
const K_TEMP_BASE = 'env.tempBase';
const K_TEMP_MOD = 'env.tempMod';
const K_TEMP = 'env.temp';

const K_RAIN = 'env.rain';
const K_CYCLE_ACC = 'env.cycleAcc';
/** 播报去抖：上次已播报过的雨状态（0/1），防止同一状态每 tick 刷一条 */
const K_RAIN_REPORTED = 'env.rainReported';
/** 播报去抖：当前是否处于"已播报过的寒潮"状态（0/1） */
const K_COLD_ON = 'env.coldOn';
/** 播报去抖：当前是否处于"已播报过的酷暑"状态（0/1） */
const K_HOT_ON = 'env.hotOn';

/**
 * 食物衰减乘数的**接入口键**（导出供 needs 包按名读取，避免两边各写一遍字符串）。
 *
 * 语义：env 系统每 tick 写 `env.foodDecayMul`（下雨 = rainFoodDecayMul，晴天 = 1）。
 * needs 包若要消费，在自己的需求衰减处读 `ctx.scratch['env.foodDecayMul'] ?? 1` 即可。
 * **本包不交叉修改 needs 的衰减逻辑**——needs 包自己衰减，env 只提供乘数事实；
 * needs 不挂时这个键只是无人读的残留数据（随档、不报错，符合卸载纪律）。
 */
export const K_ENV_FOOD_DECAY_MUL = 'env.foodDecayMul';

/**
 * 事件修饰量键（导出供 events 包按名引用，避免两处各写一遍字符串导致拼写漂移）。
 * events 的 coldsnap 事件写它，env 只读它并合成进 env.temp。
 */
export const K_ENV_TEMP_MOD = K_TEMP_MOD;

/** 相位偏移：把「正午最热」锚在 dayPhase = 0.25（规格要求），深夜自然落在 0.75。 */
const NOON_PHASE = 0.25;

export const envPack: ModPack = {
  id: 'env',
  requires: [],
  apply(m) {
    m.registerSystemDef({
      id: 'env-tick',
      category: 'world',
      ctor: (ctx: SimContext) => ({
        id: 'env-tick',
        init() {
          seedState(ctx);
        },
        update(dt) {
          tickEnv(ctx, dt);
        },
      }),
    });

    // ---- 权重钩子：环境只倾斜抽卡池的天平，不替鼠做决定 ----
    m.registerHook('cardWeight', (_p, card, ctx) => envWeightMul(card, ctx));
  },
};

/**
 * 初始化环境状态（仅新档调用；读档走 scratch 还原，不重建）。
 * 幂等守卫：key 已存在就不覆盖——防止未来若有人二次调用 init 把已推进的相位清零。
 */
function seedState(ctx: SimContext): void {
  const e = ctx.scratch;
  if (e[K_DAY_PHASE] !== undefined) return;
  const cfg = ctx.tuning.env;
  e[K_DAY_PHASE] = 0;
  e[K_TEMP_BASE] = temperatureOf(0, cfg);
  e[K_TEMP_MOD] = 0;
  e[K_TEMP] = temperatureOf(0, cfg);
  e[K_RAIN] = 0;
  e[K_CYCLE_ACC] = 0;
  e[K_RAIN_REPORTED] = 0;
  e[K_COLD_ON] = 0;
  e[K_HOT_ON] = 0;
  e[K_ENV_FOOD_DECAY_MUL] = 1;
}

/** 一 tick 的环境推进：相位 → 温度 → 天气掷骰 → 播报 → 冻伤/中暑。 */
function tickEnv(ctx: SimContext, dt: number): void {
  const e = ctx.scratch;
  const cfg = ctx.tuning.env;

  // ---- ① 昼夜相位：0..1 环形推进（负数兜底防 dt 异常导致的 -0.xx）----
  let phase = (e[K_DAY_PHASE] ?? 0) + dt / cfg.dayLengthSec;
  phase %= 1;
  if (phase < 0) phase += 1;
  e[K_DAY_PHASE] = phase;

  // ---- ② 温度合成：周期基准（env 算）+ 事件修饰（events 写）= 最终温度 ----
  // 写方分离见 K_TEMP_* 契约注释：这里覆写 env.temp 是**有意为之**，
  // 因为修饰量已经被合成进来了；events 不会写 env.temp（它写 env.tempMod）。
  const base = temperatureOf(phase, cfg);
  e[K_TEMP_BASE] = base;
  const mod = e[K_TEMP_MOD] ?? 0;
  const temp = base + mod;
  e[K_TEMP] = temp;

  // ---- ③ 天气掷骰：累积到 weatherCycleSec 才掷一次（不是每 tick 掷）----
  let acc = (e[K_CYCLE_ACC] ?? 0) + dt;
  while (acc >= cfg.weatherCycleSec) {
    acc -= cfg.weatherCycleSec;
    e[K_RAIN] = ctx.rng() < cfg.rainChance ? 1 : 0;
  }
  e[K_CYCLE_ACC] = acc;
  const rain = e[K_RAIN] ?? 0;

  // ---- ④ 暴露给 needs 包的食物衰减乘数（接入口；needs 不挂时无读者）----
  e[K_ENV_FOOD_DECAY_MUL] = rain === 1 ? cfg.rainFoodDecayMul : 1;

  // ---- ⑤ 播报：只在状态翻转 / 刚超阈值时 log（去抖，防刷屏）----
  reportEnv(ctx, temp, rain, cfg);

  // ---- ⑥ 冻伤 / 中暑：无庇护 + 极端温度 → 掉血（世界事实，非行为规则）----
  const sheltered = isSheltered(ctx, cfg);
  for (const p of ctx.pawns()) {
    if (sheltered(p)) continue; // 火旁/棚旁：极端天气不伤
    if (temp < cfg.coldThreshold) ctx.damagePawn(p.eid, cfg.freezeDmgPerSec * dt, '冻伤');
    if (temp > cfg.hotThreshold) ctx.damagePawn(p.eid, cfg.heatDmgPerSec * dt, '中暑');
  }
}

/**
 * 温度曲线（正弦）。
 *
 * 夜晚深度 ∈ [0,1]：用 `(1 - cos(2π·(phase - 0.25))) / 2` 实现
 *   - phase = 0.25（正午）→ cos(0) = 1 → depth 0 → temp = baseTemp（最热）
 *   - phase = 0.75（深夜）→ cos(π) = -1 → depth 1 → temp = baseTemp + nightOffset（最冷）
 * 连续且光滑（导数不为零跳变），保证 dayPhase 走一圈时温度**不会突跳**
 * （env.test.ts 有连续性断言）。振幅完全由 nightOffset 决定。
 */
function temperatureOf(dayPhase: number, cfg: EnvTuning): number {
  const nightDepth = (1 - Math.cos(2 * Math.PI * (dayPhase - NOON_PHASE))) / 2;
  return cfg.baseTemp + cfg.nightOffset * nightDepth;
}

/**
 * 播报去抖：只在**状态翻转或刚越过阈值**时报一条。
 *
 * 雨：与 `env.rainReported` 比，变了才报（🌧/☀）。
 * 寒潮/酷暑：边沿检测（edge detection）——从"未越线"翻到"越线"才报一次，
 * 而不是每秒一条。越线后的每一 tick 温度都在阈值外，但只记一条。
 * 用 scratch 记状态（随档），禁止闭包存标志（存档纪律）。
 *
 * ⚠ 与 events 包的分工（**不是重复日志 bug，不要"修"掉**）：
 * 这里报的「🥶 寒潮来袭」是**自然昼夜/气候**把温度压到阈值下（温和带需要 override
 * tuning 才可能）；events 包的 coldsnap 事件也会 log 一条寒潮。两者语义不同——
 * 一个是「世界变冷了」，一个是「寒潮事件发生了」；当事件修饰量（env.tempMod）
 * 把合成温度压过阈值时，两条都会出现，这是**预期行为**（事件驱动的寒潮理应
 * 有自己的播报）。去抖只保证"同一个状态不重复报"，不保证"不同来源只报一次"。
 */
function reportEnv(ctx: SimContext, temp: number, rain: number, cfg: EnvTuning): void {
  const e = ctx.scratch;

  if (rain !== (e[K_RAIN_REPORTED] ?? 0)) {
    ctx.log(rain === 1 ? '🌧 下雨了' : '☀ 雨停了');
    e[K_RAIN_REPORTED] = rain;
  }

  const coldNow = temp < cfg.coldThreshold ? 1 : 0;
  if (coldNow === 1 && (e[K_COLD_ON] ?? 0) === 0) {
    ctx.log(`🥶 寒潮来袭，气温跌破 ${Math.round(temp)}`);
    e[K_COLD_ON] = 1;
  } else if (coldNow === 0) {
    e[K_COLD_ON] = 0;
  }

  const hotNow = temp > cfg.hotThreshold ? 1 : 0;
  if (hotNow === 1 && (e[K_HOT_ON] ?? 0) === 0) {
    ctx.log('🥵 酷暑');
    e[K_HOT_ON] = 1;
  } else if (hotNow === 0) {
    e[K_HOT_ON] = 0;
  }
}

/**
 * 庇护判定工厂：返回一个 per-pawn 的谓词。
 *
 * 火堆（K_TAG_FIRE）与棚屋（K_TAG_SHELTER）**分开查**，两者任一命中即算有庇护：
 *   - fire = 热源语义（取暖/烹饪/火旁恢复的锚点）
 *   - shelter = 遮蔽语义（挡雨/挡风）
 * 刻意不复用同一个标签：否则 nearestBuildingByTag 的跨包语义会被污染
 * （见 contracts.ts K_TAG_* 注释——哨塔不能靠挂 'fire' 标签蹭航点，同理）。
 *
 * 为什么用工厂而不是每次调 nearestBuildingByTag 两次：
 * 这里对每只鼠都要判一次，工厂把"读一次 cfg.warmRadius"提到循环外。
 */
function isSheltered(ctx: SimContext, cfg: EnvTuning): (p: PawnState) => boolean {
  const r = cfg.warmRadius;
  return (p: PawnState): boolean =>
    ctx.nearestBuildingByTag(K_TAG_FIRE, p.pos.x, p.pos.y, r) !== undefined ||
    ctx.nearestBuildingByTag(K_TAG_SHELTER, p.pos.x, p.pos.y, r) !== undefined;
}

/**
 * 环境权重钩子：返回乘数（≥1 抬升，<1 压制）。
 *
 * 三条规则（全部只调天平，不替鼠做决定）：
 *  - 寒冷（temp < coldThreshold + coldRestBand）→ SER_REST × coldRestMul（想躲进火旁）
 *  - 酷暑（temp > hotThreshold）→ SER_REST × hotRestMul（想找个阴凉歇着）
 *  - 下雨（rain = 1）→ SER_GATHER / SER_WOOD × rainWorkMul（<1，户外工作不划算）
 *
 * 不在命中系列时 return 1（不影响其它卡；多个钩子相乘，互不干扰）。
 *
 * 【首 tick 的缺键兜底】env 系统是 category 'world'，排在 behavior('ai') **之后**
 * （CATEGORY_ORDER = needs/ai/society/production/raid/world/boot），
 * 所以第一拍抽卡时 env 还没跑过、scratch 里没有 env.temp。
 * 按"温和白天、无雨"的出厂态回落，保证钩子永远返回有限乘数、永不返回 undefined。
 * （env.test.ts 的存读档用例覆盖了"键已存在"的路径；这里覆盖"键缺失"的路径。）
 */
function envWeightMul(card: { series: string }, ctx: SimContext): number {
  const e = ctx.scratch;
  const cfg = ctx.tuning.env;
  const temp = e[K_TEMP] ?? cfg.baseTemp;
  const rain = e[K_RAIN] ?? 0;

  if (card.series === SER_REST) {
    let mul = 1;
    if (temp < cfg.coldThreshold + cfg.coldRestBand) mul *= cfg.coldRestMul;
    if (temp > cfg.hotThreshold) mul *= cfg.hotRestMul;
    return mul;
  }
  if (card.series === SER_GATHER || card.series === SER_WOOD) {
    return rain === 1 ? cfg.rainWorkMul : 1;
  }
  return 1;
}
