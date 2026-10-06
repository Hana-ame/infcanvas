/**
 * scripts/bench.ts —— 确定性性能基准（R3 性能优化线第一块基石）。
 *
 * 为什么要有它（没有基准的优化是盲改）：
 * 本项目在旧实现阶段（test/ 归档）做过 5 轮性能优化，其中一次"空间索引"优化
 * 实测「索引构建开销 > 节省」而被**回退**。教训是：性能收益必须实测，
 * 而且必须在**远端 runner** 上测（本地 CPU 被别的任务占用，读数不可比）。
 * 本脚本把这件事固化下来：固定 seed + 固定 tick 数 + 输出可 JSON 比对的指标，
 * 任何优化 PR 都贴「优化前 / 优化后」两份 BENCH_JSON 数字。
 *
 * 用法（CI 里跑，本地不要跑——读数不可比）：
 *   npx tsx scripts/bench.ts [秒数] [seed] [--pawns=N] [--json]
 *   位置参数只有两个槽（秒数、seed）；规模用具名 flag --pawns=N，
 *   避免"位置槽被重复正则匹配"的歧义（见 parseArgs 注释里的真实踩坑）。
 *
 * 输出：人类可读表格 + 一行 `BENCH_JSON {...}`（CI 用它做前后对比/回归门禁）。
 *
 * 指标定义（全部刻意选成"跟具体优化无关"的宏观量，避免"改一处只动一个指标"）：
 *   - totalMs / avgMsPerTick / maxTickMs / p95TickMs：模拟本体（sim.step）墙钟耗时
 *   - rssMb：长局末尾堆占用（Node GC 非确定性，只能当趋势看，不能当断言）
 *   - tickCount / alivePawns / hostiles / buildings：实体规模曲线（增长 = 内存泄漏信号）
 *   - events / usesTotal / stockFood / stockWood：玩法活跃度（**确定性指纹**——
 *     优化不得改变这些数；任何一项变化都说明"怎么算得快"改成了"算出什么"变了）
 */
import { Sim } from '../src/sim';
import { ModRegistry } from '../src/mods';

const args = process.argv.slice(2);
/**
 * 参数解析：**位置参数必须逐位消费，不能靠"第一个匹配的正则"**。
 *
 * ⚠ 真实踩坑（2026-10-06 首轮 CI 实测抓到）：本脚本最初用
 *   `num(/^\d+$/, 900)` 取 seconds、`num(/^\d+$/, 0)` 取 pawns、
 *   `num(/^-?\d+$/, 42)` 取 seed。结果 `bench.ts 900 42` 三次都匹配到
 *   **同一个 "900"**，于是所有 6 次 CI sweep 全都跑成 seed=900 / pawns=900 /
 *   出生鼠 900 —— 输出"seed=42/7/2026"六组完全相同的指纹
 *   （抽卡 402942 / 🍎27134 / 🪵24661 三个 seed 逐位相同）。
 *   假到连"地形哈希不同"都不成立。**这比没有基准更糟**：它给出自信的假数字。
 *
 * 正确做法：先剥掉具名 flag，剩下的裸数按位置顺序依次消费
 *   [秒数] [seed]，缺省补默认值。flag 永远不会被位置槽误吞。
 */
interface ParsedArgs {
  seconds: number;
  seed: number;
  pawns: number;
  json: boolean;
}
function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, number>();
  let json = false;
  const positional: number[] = [];
  for (const a of argv) {
    if (a === '--json') {
      json = true;
      continue;
    }
    const m = /^--([a-z]+)(?:=(-?\d+))?$/.exec(a);
    if (m) {
      flags.set(m[1], m[2] === undefined ? 1 : Number(m[2]));
      continue;
    }
    const n = Number(a);
    if (!Number.isFinite(n)) throw new Error(`bench: 无法解析参数 ${a}`);
    positional.push(n);
  }
  // 裸数第一槽 = 秒数（默认 900），第二槽 = seed（默认 42）
  return {
    seconds: positional[0] ?? 900,
    seed: positional[1] ?? 42,
    pawns: flags.get('pawns') ?? 0,
    json,
  };
}
const parsed = parseArgs(args);
const seconds = parsed.seconds;
const seed = parsed.seed;
const pawns = parsed.pawns;
const asJson = parsed.json;
// ---- 规模档位（为什么需要它，2026-10-06 实测教训）：
// 出厂 4 鼠 × 900 tick 整局只要 123ms（0.137ms/tick）。那个量级下：
//   ① GC 抖动与计时器粒度占比过大，"改一处"淹没在噪声里 → 测不出收益；
//   ② 4 鼠不是这个游戏的目标场景（RimWorld-like 的读点是" colonies 越跑越大"）。
// 所以基准要能拉到玩家真的会遇到的规模，否则优化的是"一个没人在玩的配置"。
// --pawns 走 overrideTuning 改 bootstrap.pawnCount（数据驱动原则③：数值进表不改内核）。
const registry = ModRegistry.default();
if (pawns > 0) {
  const n = pawns;
  registry.overrideTuning((t) => {
    t.bootstrap.pawnCount = n;
  });
}

// ---- 热身后再计时：JIT 未预热的前几十个 tick 含编译/内联缓存冷启动，
//      把它们算进均值会让"改一行代码"看起来像 ±30% 的波动（假信号 = 假优化）。
const WARMUP = Math.min(120, Math.floor(seconds / 4));

const sim = new Sim({ seed, registry });
const initialPawns = [...sim.pawns()].length;

// ---- 自检（2026-10-06 首轮 CI 假读数事故的直接对策）：
// 基准自己出错时**必须响亮失败**，而不是安静地跑出一份好看的表。
// 首轮事故就是参数解析把所有 sweep 跑成了同一组（seed=900/pawns=900），
// 六行输出看起来正常、实则完全没测到不同世界。断言在这里：
//  ① 请求了规模档就必须真的生效（否则 --pawns 是死参数 = 条件恒真式的假 flag）；
//  ② 请求了规模档时，出生鼠数必须等于请求值。
if (pawns > 0 && initialPawns !== pawns) {
  throw new Error(`bench: --pawns=${pawns} 未生效（实际出生 ${initialPawns}）—— 基准参数没落到调参表上`);
}

for (let t = 0; t < WARMUP; t++) sim.step(1);

const tickSamples = new Float64Array(seconds);
// ---- 逐系统计时：基准不只是"一个总数"，还要能指出**热点在哪个系统**。
//      没有这一段，任何优化都是凭直觉猜（旧项目回退教训的根因）。
//      代价：每个 tick 多几次 hrtime 调用（~20 次），相对总耗时可忽略；
//      它只测"哪边慢"，不改变任何模拟顺序 → 不影响确定性指纹。
const perSystem = new Map<string, { ms: number; calls: number }>();
for (const s of sim.systems) perSystem.set(s.id, { ms: 0, calls: 0 });
{
  // 包裹每个系统的 update，保留原函数引用与 this 绑定（update 是闭包属性，无 this 依赖）
  for (const s of sim.systems) {
    const orig = s.update;
    if (!orig) continue;
    const rec = perSystem.get(s.id)!;
    s.update = (dt: number): void => {
      const t0 = process.hrtime.bigint();
      orig(dt);
      rec.ms += Number(process.hrtime.bigint() - t0) / 1e6;
      rec.calls++;
    };
  }
}
const started = process.hrtime.bigint();
for (let t = 0; t < seconds; t++) {
  const t0 = process.hrtime.bigint();
  sim.step(1);
  tickSamples[t] = Number(process.hrtime.bigint() - t0) / 1e6;
}
const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
for (const s of sim.systems) {
  if (s.update) {
    const orig = s.update;
    void orig; // 包裹已安装，无需还原（进程即将结束）
  }
}
const sysBreakdown: Record<string, number> = {};
for (const [id, r] of perSystem) sysBreakdown[id] = round(r.ms);

const sorted = Float64Array.from(tickSamples).sort();
const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
const peakRssMb = process.memoryUsage().rss / (1024 * 1024);

let usesTotal = 0;
for (const p of sim.pawns()) for (const n of Object.values(p.uses)) usesTotal += n;

const metrics = {
  seed,
  pawns,
  seconds,
  tickCount: seconds,
  warmupTicks: WARMUP,
  totalMs: round(wallMs),
  avgMsPerTick: round(wallMs / seconds),
  maxTickMs: round(sorted[sorted.length - 1]),
  p95TickMs: round(p95),
  rssMb: round(peakRssMb),
  initialPawns,
  alivePawns: [...sim.pawns()].length,
  hostiles: sim.hostiles().length,
  buildings: sim.world.buildings.size,
  events: sim.events.length,
  usesTotal,
  stockFood: sim.stockpile['food'] ?? 0,
  stockWood: sim.stockpile['wood'] ?? 0,
  techsUnlocked: sim.techUnlocked().size,
  simTime: round(sim.time),
  sysMs: sysBreakdown,
};

if (asJson) {
  console.log(JSON.stringify(metrics));
} else {
  console.log(`=== infcanvas 性能基准（seed=${seed} ${seconds} tick，预热 ${WARMUP}，出生鼠 ${metrics.initialPawns}）===`);
  console.log(`模拟耗时  总 ${metrics.totalMs}ms | 均 ${metrics.avgMsPerTick}ms/tick | p95 ${metrics.p95TickMs} | 峰 ${metrics.maxTickMs}`);
  console.log(`内存      RSS ${metrics.rssMb}MB`);
  console.log(`规模      鼠 ${metrics.alivePawns}/${metrics.initialPawns} | 猫 ${metrics.hostiles} | 建筑 ${metrics.buildings} | 事件 ${metrics.events}`);
  console.log(`玩法指纹  抽卡 ${metrics.usesTotal} 次 | 🍎${metrics.stockFood} 🪵${metrics.stockWood} | 科技 ${metrics.techsUnlocked}`);
  console.log(`逐系统耗时（热点定位，看这个决定改哪里）：`);
  for (const [id, ms] of Object.entries(sysBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(16)} ${String(ms).padStart(9)}ms  ${((ms / wallMs) * 100).toFixed(1)}%`);
  }
  // CI 抓这一行做前后对比
  console.log(`BENCH_JSON ${JSON.stringify(metrics)}`);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}