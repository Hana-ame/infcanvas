/**
 * scripts/_desire-probe.mts —— R3-1 欲望层基线探针。
 *
 * 测什么：
 *  1. 各卡抽签占比（终局一次采样：uses 是累计值，只在终局读一次，不每 tick 累加）；
 *  2. 候选池平均大小（与 card-liveness 同一口径：只数带 condition 且通过的卡 +
 *     无条件卡也数进去——wander/eat/… 无 condition 的卡永远是候选，这是 drawCard 的真实口径）；
 *  3. 世界统计：鼠「静止」（path 空）的抽样占比、鼠「独处」（approachRadius 内无同伴）
 *     的抽样占比、「非工作」（当前卡不属于生产系列）的抽样占比——直接为欲望的
 *     积累源定稿提供读数；
 *  4. 每 seed 存活、终局库存/建筑/科技。
 *
 * 纪律：dt 固定 1（变步长会分叉）；uses 只在终局读一次。
 * 用法：npx tsx scripts/_desire-probe.mts [seed...]（默认 card-liveness 同款 10 seed）
 */
import { Sim } from '../src/sim/index.js';
import { ModRegistry } from '../src/mods/index.js';
import { SER_GATHER, SER_WOOD, SER_BUILD, SER_FARM, SER_COOK } from '../src/mods/contracts.js';

const DEFAULT_SEEDS = [42, 7, 99, 2026, 8888, 31337, 101, 202, 555, 8080];
const args = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const SEEDS = args.length ? args : DEFAULT_SEEDS;
const TICKS = 900;
const DT = 1;

const PROD_SERIES = new Set([SER_GATHER, SER_WOOD, SER_BUILD, SER_FARM, SER_COOK]);

interface Agg {
  uses: Record<string, number>;
  draws: number;
  poolSizes: number[];
  stationarySamples: number;
  aloneSamples: number;
  idleWorkSamples: number;
  samples: number;
  alive: number[];
  survivalOf: number;
  stockFood: number[];
  stockWood: number[];
  buildings: number[];
  techs: number[];
}

const agg: Agg = {
  uses: {},
  draws: 0,
  poolSizes: [],
  stationarySamples: 0,
  aloneSamples: 0,
  idleWorkSamples: 0,
  samples: 0,
  alive: [],
  survivalOf: 0,
  stockFood: [],
  stockWood: [],
  buildings: [],
  techs: [],
};

for (const seed of SEEDS) {
  const sim = new Sim({ seed, registry: ModRegistry.default() });
  const of = [...sim.pawns()].length;
  for (let t = 0; t < TICKS; t++) {
    if (t % 7 === 0) {
      for (const p of sim.pawns()) {
        let n = 0;
        for (const c of sim.cards()) {
          if (c.condition) {
            try {
              if (c.condition(p, sim)) n++;
            } catch {
              /* 与 drawCard 一致：抛错视为不通过 */
            }
          } else {
            n++; // 无条件卡 = 恒在候选池（drawCard 真实口径）
          }
        }
        agg.poolSizes.push(n);
        // 静止 / 独处 / 非工作 抽样（条件成立时欲望会积累）
        if (p.path.length === 0) agg.stationarySamples++;
        let peer = Infinity;
        for (const o of sim.pawns()) {
          if (o.eid === p.eid) continue;
          const d = Math.hypot(o.pos.x - p.pos.x, o.pos.y - p.pos.y);
          if (d < peer) peer = d;
        }
        if (peer > sim.tuning.social.approachRadius) agg.aloneSamples++;
        const card = p.cardId !== null ? sim.cardById(p.cardId) : undefined;
        if (card && !PROD_SERIES.has(card.series)) agg.idleWorkSamples++;
        agg.samples++;
      }
    }
    sim.step(DT);
  }
  // 终局一次性采样
  const uses: Record<string, number> = {};
  for (const p of sim.pawns()) {
    for (const [id, c] of Object.entries(p.uses)) uses[id] = (uses[id] ?? 0) + c;
  }
  for (const [id, c] of Object.entries(uses)) agg.uses[id] = (agg.uses[id] ?? 0) + c;
  agg.alive.push([...sim.pawns()].length);
  agg.survivalOf += of;
  agg.stockFood.push(sim.stockpile['food'] ?? 0);
  agg.stockWood.push(sim.stockpile['wood'] ?? 0);
  agg.buildings.push([...sim.buildingsAll()].length);
  agg.techs.push(sim.techUnlocked().size);
}

const total = Object.values(agg.uses).reduce((a, b) => a + b, 0);
console.log(`# 欲望层基线探针：${SEEDS.length} seed [${SEEDS.join(',')}] × ${TICKS} tick × dt=${DT}`);
console.log(`存活 ${agg.alive.join('/')} → 合计 ${agg.alive.reduce((a, b) => a + b, 0)}/${agg.survivalOf}`);
console.log(`终局库存 🍎 ${agg.stockFood.join(',')}（均值 ${(agg.stockFood.reduce((a, b) => a + b, 0) / SEEDS.length).toFixed(0)}）`);
console.log(`        🪵 ${agg.stockWood.join(',')}`);
console.log(`建筑数 ${agg.buildings.join(',')}；科技解锁 ${agg.techs.join(',')}`);
console.log(`总抽签 ${total}；存活鼠 uses 合计 ${total}`);
console.log('\n## 各卡抽签占比（终局采样）');
for (const [id, c] of Object.entries(agg.uses).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${id.padEnd(16)} ${((c / total) * 100).toFixed(2).padStart(6)}%  (${c} 次)`);
}
const avgPool = agg.poolSizes.reduce((a, b) => a + b, 0) / agg.poolSizes.length;
console.log(`\n候选池平均 ${avgPool.toFixed(2)} 张（${agg.poolSizes.length} 次抽样）`);
const N = agg.samples;
console.log('## 欲望积累源的世界占比（抽样 = 每 7 tick × 每鼠）');
console.log(`  静止（path 空）      ${((agg.stationarySamples / N) * 100).toFixed(1)}% (${agg.stationarySamples}/${N})`);
console.log(`  独处（>approach 无伴） ${((agg.aloneSamples / N) * 100).toFixed(1)}% (${agg.aloneSamples}/${N})`);
console.log(`  非生产卡执行中       ${((agg.idleWorkSamples / N) * 100).toFixed(1)}% (${agg.idleWorkSamples}/${N})`);