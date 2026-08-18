// 长局性能分析（2026-08-16 热路径 profile 第二轮工具）
// 用法：npx tsx scripts/profile-long-run.ts [模拟秒数]
// 打印各系统累计耗时/调用次数/单次最大耗时的降序表——定位系统级热点后，
// 再进目标系统内部找行级热路径（第一轮即用此法定位 findNearFar 15 半径环扫与
// needs 写回等热点）。纯诊断工具，无副作用（不写文件）。
import { Sim } from '../src/sim/sim';
import { ModRegistry } from '../src/sim/mods/registry';

const seconds = Number(process.argv[2] ?? 600);
const TICK = 0.2; // tickHz 5（与默认一致）
const sim = new Sim({
  registry: ModRegistry.default(),
  pawnCount: 40, // 长局中期人口量级
  seed: 42,
});
sim.registry.enableProfiling(true); // 系统级计时（默认关：不分析时零开销）
const ticks = seconds / TICK;
for (let i = 0; i < ticks; i++) sim.step(TICK);

const rows = [...sim.registry.profileStats.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
console.log(`\n=== 长局 ${seconds}s（${ticks} ticks，40 小人，seed 42）系统耗时 top20 ===`);
console.log('系统'.padEnd(22), 'totalMs'.padStart(9), 'count'.padStart(8), 'avgMs'.padStart(9), 'maxMs'.padStart(9));
for (const [id, s] of rows.slice(0, 20)) {
  const avg = s.totalMs / Math.max(1, s.count);
  console.log(id.padEnd(22), s.totalMs.toFixed(1).padStart(9), String(s.count).padStart(8), avg.toFixed(4).padStart(9), s.maxMs.toFixed(3).padStart(9));
}
console.log(`\n系统数 ${rows.length}，累计 ${rows.reduce((a, [, s]) => a + s.totalMs, 0).toFixed(0)}ms 主持 sim.step`);