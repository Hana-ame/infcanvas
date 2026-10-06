/** 度量：被咬时抽「战斗行为卡」的比例（区分只算 fight/flee vs 算全部战斗系列）。 */
import { Sim } from '../src/sim';
import { ModRegistry } from '../src/mods';

const seeds = [42, 7, 99, 2026, 8888, 31337, 101, 202, 555, 8080];
const COMBAT_WIDE = ['fight', 'flee', 'hold', 'focus', 'flank', 'rally'];
const WORK = ['gather_berry', 'chop_tree', 'build_campfire', 'build_hut', 'build_store', 'build_field', 'sow', 'harvest', 'cook', 'sleep', 'rest', 'chat', 'wander', 'trade', 'heal', 'hunt', 'build_bed'];

let bites = 0, strict = 0, wide = 0, work = 0;
const perCard: Record<string, number> = {};
for (const seed of seeds) {
  const sim = new Sim({ seed, registry: ModRegistry.default() });
  for (let t = 0; t < 900; t++) {
    const hpBefore = new Map([...sim.pawns()].map((p) => [p.eid, p.hp]));
    sim.step(1);
    for (const p of sim.pawns()) {
      const before = hpBefore.get(p.eid);
      if (before === undefined || p.hp >= before) continue;
      bites++;
      const id = p.cardId ?? '(none)';
      perCard[id] = (perCard[id] ?? 0) + 1;
      if (id === 'fight' || id === 'flee') strict++;
      if (COMBAT_WIDE.includes(id)) wide++;
      if (WORK.includes(id)) work++;
    }
  }
}
console.log(`bites=${bites}`);
console.log(`strict (fight|flee)   = ${strict}  (${(100 * strict / bites).toFixed(2)}%)`);
console.log(`wide (含 SER_DEFEND)  = ${wide}  (${(100 * wide / bites).toFixed(2)}%)`);
console.log(`work (采集/建造/睡…)  = ${work}  (${(100 * work / bites).toFixed(2)}%)`);
console.log('--- 被咬 tick 的逐卡分布 ---');
for (const [k, v] of Object.entries(perCard).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${String(v).padStart(5)}  ${(100 * v / bites).toFixed(2)}%`);
}
