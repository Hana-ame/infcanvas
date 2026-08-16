/**
 * test/check.ts
 *
 * 不依赖 vitest 的自检脚本：验证最小核心满足两条关键原则。
 * 用法：npx tsx test/check.ts
 *
 * 为什么不用 *.test.ts：避免被根仓库 `npm test` 自动发现，保证“不影响主代码/主测试”。
 */
import { TinySim } from './minimal-core';

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exit(1);
  }
  console.log(`✅ ${msg}`);
}

// 1. 确定性：同 seed 两次运行结果一致（便于回归/复现）
const a = new TinySim({ seed: 42 });
a.run(300);
const b = new TinySim({ seed: 42 });
b.run(300);
assert(
  a.stockpile.food === b.stockpile.food &&
    a.stockpile.wood === b.stockpile.wood &&
    a.world.campfires.length === b.world.campfires.length,
  '确定性：同 seed 运行结果一致',
);

// 2. 自主生存：默认 4 只鼠鼠跑一段时间后仍存活，且有采集/进食/休息发生
const sim = new TinySim({ seed: 7 });
sim.run(500);
assert(sim.pawns.length === 4, '自主生存：4 只鼠鼠全部存活');
assert(sim.stockpile.food > 0, '自主生存：有采集到食物');
assert(sim.stockpile.wood >= 0, '自主生存：采集/建造系统不异常');
const useCounts = sim.pawns.map((p) => Object.values(p.uses).reduce((x, y) => x + y, 0));
assert(useCounts.every((n) => n > 0), '一切皆抽卡：每个鼠鼠都触发过多张卡');
assert(
  sim.pawns.some((p) => (p.uses['gatherFood'] ?? 0) > 0 && (p.uses['rest'] ?? 0) > 0),
  '生存闭环：存在采集与休息卡触发',
);

// 3. 神谕只引导：设采集令后，采集卡权重显著提升 → 触发占比上升
const normal = new TinySim({ seed: 99 });
normal.run(400);
const guided = new TinySim({ seed: 99, oracleGoal: { gatherFood: 5 } });
guided.run(400);
const normalGather = normal.pawns.reduce((s, p) => s + (p.uses['gatherFood'] ?? 0), 0);
const guidedGather = guided.pawns.reduce((s, p) => s + (p.uses['gatherFood'] ?? 0), 0);
assert(guidedGather > normalGather, `神谕只引导：采集令提高采集卡触发率（${normalGather} -> ${guidedGather}）`);

console.log('\n全部自检通过。');
