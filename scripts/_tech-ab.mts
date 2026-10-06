/**
 * scripts/_tech-ab.mts —— build_store 断言变红的 A/B 归因探针。
 *
 * 同一 seed 集、同一 dt=1、同 900 tick，只在「要不要挂欲望层」上做 A/B：
 *   A = origin/main（无欲望层，需要 --baseline 开关走另一个 worktree）
 *   B = 本 worktree（欲望层已挂）
 *
 * 读什么：
 *   - 每 seed 在 900s 内 storage:store 是否解锁 + 解锁时刻；
 *   - 每 seed 科技解锁总项数（平均解锁项数——判断"科技是否真的变快"的唯一口径）；
 *   - 每 seed 碎片总数；
 *   - build_store 被抽中次数（存活鼠 uses，与 card-liveness 同口径）。
 * 用法：cd <tree> && npx tsx scripts/_tech-ab.mts
 */
import { Sim } from '../src/sim/index.js';
import { ModRegistry } from '../src/mods/index.js';

const SEEDS = [42, 7, 99, 2026, 8888, 31337, 101, 202, 555, 8080];
const TICKS = 900;

interface SeedRow {
  seed: number;
  storeUnlockedAt: number | null;
  techCount: number;
  fragments: number;
  buildStoreDraws: number;
}

const rows: SeedRow[] = [];
for (const seed of SEEDS) {
  const sim = new Sim({ seed, registry: ModRegistry.default() });
  let storeAt: number | null = null;
  for (let t = 0; t < TICKS; t++) {
    sim.step(1);
    if (storeAt === null && sim.techUnlocked().has('storage:store')) storeAt = t;
  }
  let frags = 0;
  for (const f of Object.values(sim.techFragments)) frags += f;
  frags += [...sim.techUnlocked()].length * 3; // 解锁的科技按 3 块折算（fragments 清零了）
  let bsd = 0;
  for (const p of sim.pawns()) bsd += p.uses['build_store'] ?? 0;
  const { techCount } = { techCount: sim.techUnlocked().size };
  rows.push({ seed, storeUnlockedAt: storeAt, techCount, fragments: frags, buildStoreDraws: bsd });
}

const storeCount = rows.filter((r) => r.storeUnlockedAt !== null).length;
const avgTech = rows.reduce((a, b) => a + b.techCount, 0) / rows.length;
const avgFrag = rows.reduce((a, b) => a + b.fragments, 0) / rows.length;
const bs = rows.reduce((a, b) => a + b.buildStoreDraws, 0);
console.log('# 科技节奏 A/B 读数（本 worktree）');
for (const r of rows) {
  console.log(
    `  seed ${String(r.seed).padStart(5)}: storage:store 解锁@${r.storeUnlockedAt === null ? '——' : r.storeUnlockedAt + 's'} | 解锁 ${r.techCount} 项 | 碎片约 ${r.fragments} | build_store 被抽 ${r.buildStoreDraws} 次`,
  );
}
console.log(`\n汇总：storage:store 解锁 ${storeCount}/10 seed；平均解锁 ${avgTech.toFixed(2)} 项；平均碎片 ${avgFrag.toFixed(1)}；build_store 合计 ${bs} 次`);