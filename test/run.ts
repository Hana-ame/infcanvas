/**
 * test/run.ts
 *
 * 运行最小核心 demo。
 * 用法：npx tsx test/run.ts [ticks] [seed]
 * 例如：npx tsx test/run.ts 60 20260816
 */
import { TinySim, type CardId } from './minimal-core';

const ticks = Number(process.argv[2] ?? 60);
const seed = Number(process.argv[3] ?? 20260816);

const sim = new TinySim({ seed, log: true });
sim.run(ticks);

const allIds = [...new Set(sim.pawns.flatMap((p) => Object.keys(p.uses)))] as CardId[];
console.log('\n===== 最小核心运行结果 =====');
console.log(`模拟 ${ticks} tick`);
console.log(`存活鼠鼠：${sim.pawns.length}`);
console.log(`库存：🍎${sim.stockpile.food} 🪵${sim.stockpile.wood} 🔥${sim.world.campfires.length}`);
console.log('\n卡牌触发分布：');
for (const id of allIds) {
  const total = sim.pawns.reduce((sum, p) => sum + (p.uses[id] ?? 0), 0);
  const avgMastery = Math.round(sim.pawns.reduce((sum, p) => sum + (p.mastery[id] ?? 0), 0) / Math.max(1, sim.pawns.length));
  console.log(`  ${id.padEnd(14)} 触发 ${String(total).padStart(4)} 次，平均熟练度 ${String(avgMastery).padStart(3)}`);
}
console.log('\n每个鼠鼠最终状态：');
for (const p of sim.pawns) {
  console.log(`  ${p.name} #${p.id} @(${p.x},${p.y}) 🍗${Math.round(p.food)} 😴${Math.round(p.rest)} 😊${Math.round(p.mood)} 🧠${Math.round(p.san)}`);
}
console.log('\n事件前 20 条：');
for (const e of sim.events.slice(0, 20)) console.log(' ', e);
