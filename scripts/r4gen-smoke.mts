/**
 * scripts/r4gen-smoke.mts —— R4-GEN 种子轮全量装配冒烟脚本。
 *
 * 用法：npx tsx scripts/r4gen-smoke.mts [seed...]（默认 42/7/99/2026，dt 固定 1，1200 tick）
 *
 * 来历：2026-10-07 R4-GEN 轮。种子句驱动新增 7 个玩法包（hunting/env/medicine/fortify/
 * combat/factions/events）。单包测试只能证明「包本身没坏」，不能证明「7 个包同台时
 * 世界还是活的」。本脚本回答后者：
 *   1. 鼠群存活率（社会模拟的基本盘）
 *   2. 6 种库存的净产出（材料链是否串起来：木→墙/塔、鹿→肉/草药、草药→医疗）
 *   3. 全卡触发次数（p.uses 累计；新 15 张卡里哪些真的被抽到，哪些是死代码）
 *   4. 敌人击杀 / 派系数 / 事件条数（威胁与社会层是否活跃）
 *   5. HP 恢复证据（R3-5 之前项目**无任何 HP 恢复机制**，本轮必须看到 healUp 秒数 > 0）
 *
 * ⚠ dt 固定 1：sim.moveStep 按 speed*dt 推进，变步长会分叉（golden.test.ts 已钉住），
 *   一变步长读数就与任何其他跑法不可比。
 *
 * ⚠ p.uses 是**整局累计**（systems.ts:115 每次触发 +1），所以只在跑完后读一次，
 *   在循环里累加会得到「tick 数 × 真实次数」的虚高值（旧探针踩过这个坑，虚高 207146）。
 *
 * 它不改任何 src 行为：只读 + 只统计。
 */
import { Sim } from '../src/sim/index.js';
import { ModRegistry, type ModPack } from '../src/mods/index.js';
import { DEFAULT_PLAYSTYLE_PACKS } from '../src/mods/packs/playstyle.js';

// ---- R4-GEN 七个新包（导出名与 subagent 派单约定一致）----
import { huntingPack } from '../src/mods/packs/hunting.js';
import { envPack } from '../src/mods/packs/env.js';
import { medicinePack } from '../src/mods/packs/medicine.js';
import { fortifyPack } from '../src/mods/packs/fortify.js';
import { combatPack } from '../src/mods/packs/combat.js';
import { factionsPack } from '../src/mods/packs/factions.js';
import { eventsPack } from '../src/mods/packs/events.js';

const SEEDS = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const seeds = SEEDS.length ? SEEDS : [42, 7, 99, 2026];
const TICKS = 1200;
const DT = 1;

/** R4-GEN 全量装配 = 旧 9 包 + 新 7 包。清单顺序不承担依赖约束（requires 拓扑推导），
 *  但 factions 需在 raid 之后注册 —— raider 的追猎 AI 由 raid.tickCats 驱动。 */
const R4GEN: ModPack[] = [
  ...DEFAULT_PLAYSTYLE_PACKS,
  huntingPack,
  envPack,
  medicinePack,
  fortifyPack,
  combatPack,
  factionsPack,
  eventsPack,
];

function countTag(sim: Sim, tag: string): number {
  let n = 0;
  for (const b of sim.buildingsAll()) {
    if ((sim.tuning.buildings[b.defId]?.tags ?? []).includes(tag)) n++;
  }
  return n;
}

for (const seed of seeds) {
  const sim = new Sim({ seed, registry: ModRegistry.mountPacks(R4GEN) });

  let healUp = 0; // 全体 hp 之和上升的 tick 数 = 恢复机制在工作
  let lastHpSum = 0;
  let killCount = 0;
  let lastHostiles = 0;

  for (let t = 0; t < TICKS; t++) {
    sim.step(DT);
    const hpSum = [...sim.pawns()].reduce((s, p) => s + p.hp, 0);
    if (lastHpSum && hpSum > lastHpSum) healUp++;
    lastHpSum = hpSum;
    // 击杀数：hostiles 数组长度下降 = 有敌人被打死（掉落随死亡入库）
    const now = [...sim.hostiles()].length;
    if (now < lastHostiles) killCount += lastHostiles - now;
    lastHostiles = now;
  }

  const pawns = [...sim.pawns()];
  const stock = sim.stockpile;
  const cards = new Map<string, number>();
  for (const p of pawns) for (const [k, v] of Object.entries(p.uses)) cards.set(k, (cards.get(k) ?? 0) + v);
  // 按次数降序
  const cardRows = [...cards.entries()].sort((a, b) => b[1] - a[1]);
  const totalCards = cardRows.reduce((s, [, v]) => s + v, 0);

  const out = {
    seed,
    survive: `${pawns.filter((p) => p.hp > 0).length}/${pawns.length}`,
    food: Math.round(stock.food ?? 0),
    wood: Math.round(stock.wood ?? 0),
    meal: Math.round(stock.meal ?? 0),
    meat: Math.round(stock.meat ?? 0),
    herb: Math.round(stock.herb ?? 0),
    buildings: [...sim.buildingsAll()].length,
    wall: countTag(sim, 'wall'),
    tower: countTag(sim, 'tower'),
    trap: countTag(sim, 'trap'),
    bed: countTag(sim, 'bed'),
    hosts: lastHostiles,
    kills: killCount,
    healUp,
    factions: Object.keys(sim.scratch).filter((k) => k.startsWith('factions.name.')).length,
    raids: Object.keys(sim.scratch).filter((k) => k.startsWith('factions.raidCd.')).length,
    eventLog: sim.events.filter((e) => /📦|🥶|⚠ 瘟疫|流浪者|🎉/.test(e.text)).length,
    envTemp: sim.scratch['env.temp'] ?? null,
    cards: cardRows.map(([k, v]) => `${k}:${totalCards ? (100 * v) / totalCards : 0}%`),
  };
  console.log(JSON.stringify(out));
}
