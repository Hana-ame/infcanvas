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
 *   npx tsx scripts/bench.ts [秒数] [seed] [--json]
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
const seconds = Number(args.find((a) => /^\d+$/.test(a)) ?? 900);
const seed = Number(args.filter((a) => /^-?\d+$/.test(a))[1] ?? 42);
const asJson = args.includes('--json');

// ---- 热身后再计时：JIT 未预热的前几十个 tick 含编译/内联缓存冷启动，
//      把它们算进均值会让"改一行代码"看起来像 ±30% 的波动（假信号 = 假优化）。
const WARMUP = Math.min(120, Math.floor(seconds / 4));

const sim = new Sim({ seed, registry: ModRegistry.default() });
const initialPawns = [...sim.pawns()].length;

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
  console.log(`=== infcanvas 性能基准（seed=${seed} ${seconds} tick，预热 ${WARMUP}）===`);
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