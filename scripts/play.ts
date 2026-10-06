/**
 * scripts/play.ts —— 纯逻辑游玩/验收入口（阶段①交付标准：0 操作自主生存可跑）。
 *
 * 用法：npx tsx scripts/play.ts [秒数] [seed]
 *
 * 输出：终局状态 + 卡牌触发分布 + 平均熟练度 + 事件时间线样本。
 * 这是"一切皆抽卡 + 自主生存闭环"的人工验收窗口；回归判定以 vitest 为准。
 * （2026-08-21 用户裁定：--oracle 神谕对比演示随"××令"机制一并移除。）
 */
import { Sim } from '../src/sim';
import { ModRegistry } from '../src/mods';

const args = process.argv.slice(2);
const seconds = Number(args[0] ?? 600);
const seed = Number(args[1] ?? 20260821);
const sim = new Sim({ seed, registry: ModRegistry.default() });
const totalPawns = [...sim.pawns()].length;

console.log(`=== infcanvas 从零 v3 · 最小生存闭环 ===`);
console.log(`seed=${seed} 时长=${seconds}s 鼠数=${totalPawns} 系统=[${sim.systems.map((s) => s.id).join(', ')}]\n`);

for (let t = 0; t < seconds; t++) sim.step(1);

// ---- 统计 ----
const cardUses = new Map<string, number>();
const masterySum = new Map<string, number>();
const masteryN = new Map<string, number>();
for (const p of sim.pawns()) {
  for (const [id, n] of Object.entries(p.uses)) cardUses.set(id, (cardUses.get(id) ?? 0) + n);
  for (const [id, m] of Object.entries(p.mastery)) {
    masterySum.set(id, (masterySum.get(id) ?? 0) + m.v);
    masteryN.set(id, (masteryN.get(id) ?? 0) + 1);
  }
}
console.log(`存活 ${[...sim.pawns()].length}/${totalPawns} | 库存 🍎${sim.stockpile['food'] ?? 0} 🪵${sim.stockpile['wood'] ?? 0}`);
console.log(`建筑：${sim.world.buildings.size} 座 → ${[...sim.world.buildings.values()].map((b) => sim.tuning.buildings[b.defId].name).join(' ') || '无'}`);
console.log(`敌袭事件：${countEvents(sim, '出没')} 次 | 击退：${countEvents(sim, '击退')} | 死亡：${countEvents(sim, '💀')}`);

console.log(`\n卡牌触发分布（抽卡驱动证据）：`);
for (const [id, n] of [...cardUses.entries()].sort((a, b) => b[1] - a[1])) {
  const avgM = masterySum.has(id) ? Math.round((masterySum.get(id) ?? 0) / (masteryN.get(id) ?? 1)) : 0;
  console.log(`  ${id.padEnd(14)} ×${String(n).padStart(4)}  平均熟练度 ${String(avgM).padStart(3)}`);
}

console.log(`\n每只鼠终态：`);
for (const p of sim.pawns()) {
  console.log(
    `  ${p.name}[${sim.tuning.traits[p.trait].name}] @(${Math.round(p.pos.x)},${Math.round(p.pos.y)}) ` +
      `🍗${Math.round(p.needs.food)} 😴${Math.round(p.needs.rest)} 😊${Math.round(p.needs.mood)} 🧠${Math.round(p.needs.san)} ❤${p.hp} ` +
      `当前卡:${p.cardId}`,
  );
}

console.log(`\n事件时间线（最近 15 条）：`);
for (const e of sim.events.slice(-15)) console.log(`  [${String(e.time).padStart(4)}s] ${e.text}`);

function countEvents(sim: Sim, keyword: string): number {
  return sim.events.filter((e) => e.text.includes(keyword)).length;
}
