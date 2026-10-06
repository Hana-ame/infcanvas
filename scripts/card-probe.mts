/**
 * scripts/card-probe.mts —— 正式诊断工具：逐卡量化「condition 失败率」与「子谓词失败构成」。
 *
 * 用法：npx tsx scripts/card-probe.mts [seed...] （默认 42/7/2026/8888，dt 固定 1，900 tick）
 *
 * 来历：2026-10-06 从 line/cards 的临时探针 _probe.mts 转正。它是「死卡审计」方法论
 * 的唯一可复用工具——死卡探测器（src/__tests__/card-liveness.test.ts）回答"有没有死卡"，
 * 本工具回答"为什么死"（哪个子谓词拦住的、失败构成的分布）。
 * 转正原因：chat/sow/harvest/sleep/cook 五张死卡都是靠它定位的，下一个内容线还会用到。
 *
 * 为什么用 .mts：本文件有 top-level await，.ts 在部分 node/tsx 配置下会报错。
 *
 * ⚠ **dt 必须固定为 1**：sim.moveStep 按 `speed*dt` 推进并对路径节点做浮点插值
 *   （golden.test.ts 已钉住「变步长会分叉」），探针一变步长读数就与任何其他跑法不可比。
 *
 * 它测什么（与本任务的红线对应）：
 *  1. 每 tick × 每鼠，对**每张卡**跑一次 condition，记录通过/失败 → 失败率。
 *  2. 对失败的那次，挨个跑「子谓词」探针，记录具体是哪一条拦住的 → 失败构成。
 *  3. 抽卡占比 = 抽签次数（p.uses 累计）/ 总抽签次数 × 100。
 *
 * 它**不改任何 src 行为**：只读 + 只做统计。子谓词探针是独立重写的判定式，
 * 不复用包的私有函数（那些不是导出的）。
 */
import { Sim } from '../src/sim/index.js';
import { ModRegistry } from '../src/mods/index.js';
import type { SimContext } from '../src/sim/context.js';
import type { PawnState } from '../src/sim/types.js';

const SEEDS = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const seeds = SEEDS.length ? SEEDS : [42, 7, 2026, 8888];
const TICKS = 900;
const DT = 1;

// ---------------------------------------------------------------- 子谓词探针
/** 卡片 id → 子谓词列表。**每一条都必须是包里 condition 的原样拆分**，
 *  否则探针就成了"我以为的条件"而不是"真实的条件"——本文件的使用者必须对照源码核对。 */
type SubCheck = (p: PawnState, ctx: SimContext) => boolean;
type SubSpec = { label: string; fn: SubCheck };

function nearestBuilding(ctx: SimContext, tag: string, p: PawnState): { x: number; y: number } | undefined {
  const b = ctx.nearestBuildingByTag(tag, p.pos.x, p.pos.y);
  return b ? { x: b.pos.x, y: b.pos.y } : undefined;
}

function countBy(ctx: SimContext, defId: string, tag?: string): number {
  let n = 0;
  for (const b of ctx.buildingsAll()) {
    if (b.defId !== defId) continue;
    if (tag && !(ctx.tuning.buildings[b.defId]?.tags ?? []).includes(tag)) continue;
    n++;
  }
  return n;
}

function pawnCount(ctx: SimContext): number {
  let n = 0;
  for (const _ of ctx.pawns()) n++;
  return n;
}

function nearestHostileDist(p: PawnState, ctx: SimContext): number {
  let best = Infinity;
  for (const h of ctx.hostiles()) {
    const d = Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y);
    if (d < best) best = d;
  }
  return best;
}

function fieldInStage(ctx: SimContext, p: PawnState, stage: 'empty' | 'ripe', maxR: number): boolean {
  for (const b of ctx.buildingsAll()) {
    if (b.defId !== 'field') continue;
    const v = ctx.scratch['farming.' + b.id];
    const ripe = v !== undefined && v < 0 && ctx.time >= -v;
    if (stage === 'ripe' ? !ripe : ripe) continue;
    if (Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) <= maxR) return true;
  }
  return false;
}

const SUBCONDS: Record<string, SubSpec[]> = {
  eat: [
    { label: 'food<95', fn: (p) => p.needs.food < 95 },
    { label: 'stockpile.food>0', fn: (_p, ctx) => (ctx.stockpile['food'] ?? 0) > 0 },
  ],
  sleep: [{ label: 'rest<70', fn: (p) => p.needs.rest < 70 }],
  build_campfire: [
    { label: '木料>=10', fn: (_p, ctx) => (ctx.stockpile['wood'] ?? 0) >= 10 },
    {
      label: '身边>=24格无火',
      fn: (p, ctx) => ctx.nearestBuildingByTag('fire', p.pos.x, p.pos.y, 24) === undefined,
    },
    {
      label: '>=3只鼠离所有火>16格',
      fn: (_p, ctx) => {
        let far = 0;
        for (const o of ctx.pawns()) {
          const f = ctx.nearestBuildingByTag('fire', o.pos.x, o.pos.y);
          if (!f || Math.hypot(o.pos.x - f.pos.x, o.pos.y - f.pos.y) > 16) far++;
        }
        return far >= 3;
      },
    },
  ],
  build_hut: [
    { label: 'tech满足', fn: (_p, ctx) => ctx.techSatisfied(ctx.tuning.buildings['hut']?.tech) },
    { label: '木料>=12', fn: (_p, ctx) => (ctx.stockpile['wood'] ?? 0) >= 12 },
    { label: 'shelter<ceil(pawns*0.5)', fn: (_p, ctx) => countBy(ctx, 'hut', 'shelter') < Math.ceil(pawnCount(ctx) * 0.5) },
  ],
  build_store: [
    { label: 'tech满足(storage:store)', fn: (_p, ctx) => ctx.techSatisfied(ctx.tuning.buildings['store']?.tech) },
    { label: '木料>=8', fn: (_p, ctx) => (ctx.stockpile['wood'] ?? 0) >= 8 },
    {
      label: 'store<ceil(pawns*0.25)',
      fn: (_p, ctx) => countBy(ctx, 'store') < Math.max(1, Math.ceil(pawnCount(ctx) * 0.25)),
    },
  ],
  build_field: [
    { label: '木料>=6', fn: (_p, ctx) => (ctx.stockpile['wood'] ?? 0) >= 6 },
    {
      label: 'field<ceil(pawns*2)',
      fn: (_p, ctx) => countBy(ctx, 'field') < Math.max(1, Math.ceil(pawnCount(ctx) * 2)),
    },
  ],
  sow_field: [
    { label: '空田在磁铁半径内', fn: (p, ctx) => fieldInStage(ctx, p, 'empty', ctx.tuning.farming.magnetRadius) },
  ],
  harvest_field: [{ label: '熟田在磁铁半径内', fn: (p, ctx) => fieldInStage(ctx, p, 'ripe', ctx.tuning.farming.magnetRadius) }],
  fight: [{ label: '敌人在18格内', fn: (p, ctx) => nearestHostileDist(p, ctx) <= 18 }],
  flee: [{ label: '敌人在18格内', fn: (p, ctx) => nearestHostileDist(p, ctx) <= 18 }],
  chat: [{ label: '同伴在approach内', fn: (p, ctx) => peerDist(p, ctx) <= (ctx.tuning.social as any).approachRadius ?? 26 }],
  gather_berry: [
    {
      label: '浆果在感知半径内(可采)',
      fn: (p, ctx) => {
        const f = ctx.nearestFeature('berry', p.pos.x, p.pos.y, ctx.tuning.gathering.senseRadius);
        if (!f) return false;
        return f.amount > 0;
      },
    },
  ],
  chop_tree: [
    {
      label: '树在感知半径内(可采)',
      fn: (p, ctx) => {
        const f = ctx.nearestFeature('tree', p.pos.x, p.pos.y, ctx.tuning.gathering.senseRadius);
        if (!f) return false;
        return f.amount > 0;
      },
    },
  ],
  wander: [],
};

function peerDist(p: PawnState, ctx: SimContext): number {
  let best = Infinity;
  for (const o of ctx.pawns()) {
    if (o.eid === p.eid) continue;
    const d = Math.hypot(o.pos.x - p.pos.x, o.pos.y - p.pos.y);
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------- 主统计
interface CardStat {
  id: string;
  tries: number;
  fails: number;
  subFails: Map<string, number>;
  subFailsAlone: Map<string, number>; // 该子谓词是**唯一**拦因的次数
  draws: number;
}
const stats = new Map<string, CardStat>();
function stat(id: string): CardStat {
  let s = stats.get(id);
  if (!s) {
    s = { id, tries: 0, fails: 0, subFails: new Map(), subFailsAlone: new Map(), draws: 0 };
    stats.set(id, s);
  }
  return s;
}

let totalDraws = 0;
const perSeedAlive: Record<number, { alive: number; of: number; uses: Record<string, number> }> = {};
// 额外上下文读数
const ctxStats = {
  /** 有熟田的 tick 数（分母 = 总 tick×鼠） */
  ripeFieldPresent: 0,
  emptyFieldPresent: 0,
  /** 有敌的 tick 数 */
  hostilePresent: 0,
  /** 有敌 且 敌在 18 格内的 tick 数 */
  hostileInSense: 0,
  /** 有木料 >= 各门槛的 tick 数 */
  wood: [] as number[],
  /** rest < 70 的 tick 数 */
  restLow: 0,
  /** 身边 24 格内有火的 tick 数 */
  fireNear: 0,
  samples: 0,
};

for (const seed of seeds) {
  const sim = new Sim({ seed, registry: ModRegistry.default() });
  const startCount = [...sim.pawns()].length;
  const usesBefore = new Map<string, number>();
  for (let t = 0; t < TICKS; t++) {
    // ---- condition 统计（在 step 之前跑：与 step 内抽卡看到同一份世界状态，
    //      因为 condition 本身是纯读；统计本身不消耗 rng —— 关键，见下方注释）----
    for (const p of [...sim.pawns()]) {
      ctxStats.samples++;
      ctxStats.wood.push(sim.stockpile['wood'] ?? 0);
      if (p.needs.rest < 70) ctxStats.restLow++;
      if (sim.nearestBuildingByTag('fire', p.pos.x, p.pos.y, 24) !== undefined) ctxStats.fireNear++;
      let anyHostile = false;
      let hostileInSense = false;
      for (const h of sim.hostiles()) {
        anyHostile = true;
        if (Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y) <= sim.tuning.raid.senseRadius) hostileInSense = true;
      }
      if (anyHostile) ctxStats.hostilePresent++;
      if (hostileInSense) ctxStats.hostileInSense++;
      if (fieldInStage(sim, p, 'ripe', sim.tuning.farming.magnetRadius)) ctxStats.ripeFieldPresent++;
      if (fieldInStage(sim, p, 'empty', sim.tuning.farming.magnetRadius)) ctxStats.emptyFieldPresent++;

      for (const card of sim.cards()) {
        const s = stat(card.id);
        s.tries++;
        let ok = true;
        try {
          ok = card.condition ? card.condition(p, sim) : true;
        } catch {
          ok = false;
        }
        if (ok) continue;
        s.fails++;
        const subs = SUBCONDS[card.id] ?? [];
        let blocking = 0;
        for (const sub of subs) {
          let subOk = false;
          try {
            subOk = sub.fn(p, sim);
          } catch {
            subOk = false;
          }
          if (subOk) continue;
          blocking++;
          s.subFails.set(sub.label, (s.subFails.get(sub.label) ?? 0) + 1);
        }
        if (blocking === 1) {
          for (const sub of subs) {
            let subOk = false;
            try {
              subOk = sub.fn(p, sim);
            } catch {
              subOk = false;
            }
            if (!subOk) {
              s.subFailsAlone.set(sub.label, (s.subFailsAlone.get(sub.label) ?? 0) + 1);
              break;
            }
          }
        }
      }
    }
    // 记录抽卡总数（step 之前的 uses 之和，作为分母快照；step 后再读终态）
    let before = 0;
    for (const p of sim.pawns()) before += Object.values(p.uses).reduce((a, b) => a + b, 0);
    sim.step(DT);
    let after = 0;
    for (const p of sim.pawns()) after += Object.values(p.uses).reduce((a, b) => a + b, 0);
    totalDraws += after - before;
    void usesBefore;
  }
  // 终态：被抽中次数按 uses 累计（已死鼠的 uses 随实体销毁 → 这是已知低估，
  // 所以存活/死亡分开在报告里说明）
  const uses: Record<string, number> = {};
  for (const p of sim.pawns()) {
    for (const [id, n] of Object.entries(p.uses)) uses[id] = (uses[id] ?? 0) + n;
  }
  for (const [id, n] of Object.entries(uses)) stat(id).draws += n;
  perSeedAlive[seed] = { alive: [...sim.pawns()].length, of: startCount, uses };
}

// 抽中占比用**存活鼠的 uses 合计 / 总抽卡数**（分子分母同源，分母 = 全程抽卡数）
let aliveDraws = 0;
for (const s of seeds) {
  for (const n of Object.values(perSeedAlive[s].uses)) aliveDraws += n;
}

const rows = [...stats.values()].sort((a, b) => b.tries - a.tries);
console.log(`# 探针：${seeds.length} seed [${seeds.join(',')}] × ${TICKS} tick × dt=${DT}\n`);
console.log(
  '| 卡 | condition 失败率 | 子谓词失败次数（占比） | 唯一拦因 | 被抽中占比(存活鼠 uses/总抽卡) |',
);
console.log('|---|---|---|---|---|');
for (const s of rows) {
  const failRate = ((s.fails / Math.max(1, s.tries)) * 100).toFixed(1);
  const subs = [...s.subFails.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v} (${((v / Math.max(1, s.fails)) * 100).toFixed(1)}%)`)
    .join('<br>');
  const alone = [...s.subFailsAlone.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v} (${((v / Math.max(1, s.fails)) * 100).toFixed(1)}%)`)
    .join('<br>');
  const share = ((aliveDraws > 0 ? s.draws / aliveDraws : 0) * 100).toFixed(1);
  console.log(`| ${s.id} | ${failRate}% | ${subs || '—'} | ${alone || '—'} | ${share}% |`);
}

console.log('\n## 上下文读数（分母 = 总 tick×鼠 抽样）');
const N = Math.max(1, ctxStats.samples);
console.log(`- 抽样数 ${ctxStats.samples}`);
console.log(`- rest<70 的抽样占比 ${((ctxStats.restLow / N) * 100).toFixed(1)}%`);
console.log(`- 身边 24 格内有火的抽样占比 ${((ctxStats.fireNear / N) * 100).toFixed(1)}%`);
console.log(`- 有敌在场占比 ${((ctxStats.hostilePresent / N) * 100).toFixed(1)}%`);
console.log(`- 有敌且敌在感知圈内占比 ${((ctxStats.hostileInSense / N) * 100).toFixed(1)}%`);
console.log(`- 有熟田在磁铁半径内占比 ${((ctxStats.ripeFieldPresent / N) * 100).toFixed(1)}%`);
console.log(`- 有空田在磁铁半径内占比 ${((ctxStats.emptyFieldPresent / N) * 100).toFixed(1)}%`);
const wsum = ctxStats.wood.reduce((a, b) => a + b, 0) / N;
console.log(`- 木料均值 ${wsum.toFixed(1)}`);

console.log('\n## 每 seed 存活 & 卡使用');
for (const s of seeds) {
  const r = perSeedAlive[s];
  console.log(`seed ${s}: 存活 ${r.alive}/${r.of} | ${Object.entries(r.uses).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' ')}`);
}
console.log(`\n总抽卡次数 ${totalDraws}，存活鼠 uses 合计 ${aliveDraws}`);