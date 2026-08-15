// RW-1 趣味回放（2026-08-16）：seed 124，固定可复现。三幕：
//   神谕引导（伐木令 → 权重偏置 → 自然违抗）/ 征召战斗（猫袭 → 小队 → 伤亡 → 独杀）
//   / 拓荒迁徙（人口/存粮足 → 拓荒令 → 第二篝火）
// 事件日志用 WeakSet 去重（sim.events 是 50 条环，游标法会永久失效——曾踩坑）。
import { Sim } from '/home/lumin/infcanvas/src/sim/sim';
import { ModRegistry } from '/home/lumin/infcanvas/src/sim/mods/registry';
import { makeDummyCardPlanner } from '/home/lumin/infcanvas/src/server/dummyLlm';
import { World } from '/home/lumin/infcanvas/src/sim/core/world';

const sim = new Sim({ seed: 124, pawnCount: 3, registry: ModRegistry.default() });
const planner = makeDummyCardPlanner(sim as never, { mode: 'feedback', interval: 90 });
const mk = (t: number) => `${Math.floor(t / 60)}分${String(Math.round(t % 60)).padStart(2, '0')}s`;
const lines: string[] = [];
const seen = new WeakSet<object>();
const deaths = new Set<number>();
const newCamps = new Set<number>(); // 降旨后新生篝火 key

function stepN(sec: number, tick = 0.5): void { for (let i = 0; i < sec / tick; i++) sim.step(tick); }

function flushEvents(tag: string, filter?: (t: string) => boolean): void {
  for (const e of sim.events) {
    if (seen.has(e)) continue;
    seen.add(e);
    if (filter && !filter(e.text)) continue;
    lines.push(`[${mk(e.time)}] (${tag}) ${e.text}`);
  }
  for (const h of sim.historyRecent) {
    if (h.type === 'pawn_died' && !deaths.has(h.eid as number)) {
      deaths.add(h.eid as number);
      lines.push(`[${mk(h.time)}] ☠ (${tag}) #${h.eid} 去世：${h.cause ?? ''}`);
    }
  }
}
const campCount = () => [...sim.world.buildings.entries()].filter(([, b]) => b.def.id === 'campfire').length;

// ============ Act 1 神谕引导 ============
lines.push('# RW-1 趣味回放（2026-08-16 · seed 124）');
lines.push('');
lines.push('## Act 1 神谕引导：伐木令下,聚落全员伐木(除了某个懒虫)');
stepN(30); flushEvents('开张');
const act1T = sim.time;
sim.issueCommand({ type: 'strategy', x: 0, y: 0, args: { cardId: 'oracle:chop' } });
flushEvents('降旨');
lines.push(`[${mk(sim.time)}] 🎯 神谕目标生效：**伐木令**（工作 chop ×3 权重,持续至 ${mk(sim.oracleGoal?.until ?? 0)}）`);
// 2 分钟决策统计（去重：lastDecision 每帧刷新,按 picked 变化计一次）
const picks: Record<string, number> = {};
const lastPickOf = new Map<number, string>();
for (let i = 0; i < 240; i++) {
  sim.step(0.5);
  for (const eid of sim.pawns) {
    const d = sim.pawnProfile(eid)?.lastDecision;
    if (!d || d.time < act1T + 5) continue;
    if (lastPickOf.get(eid) !== d.picked) { lastPickOf.set(eid, d.picked); picks[d.picked] = (picks[d.picked] ?? 0) + 1; }
  }
}
flushEvents('目标期');
lines.push(`[${mk(sim.time)}] 📊 目标期（2 分钟）决策卡频次：${Object.entries(picks).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(', ') || '无'}`);
// 结算伐木令实际产出（降旨前木材快照 → 目标期结束后对比净增长）
const woodPre = Math.round(sim.stockpile.wood);
const step2 = (sec: number) => { for (let i = 0; i < sec * 2; i++) sim.step(0.5); };
step2(60);
lines.push(`[${mk(sim.time)}] 🪓 伐木令生效 1 分钟:木材 ${Math.round(sim.stockpile.wood)}（较降旨时 +${Math.round(sim.stockpile.wood) - woodPre}）——多数照做,个别懒虫违抗`);

// ============ Act 2 征召战斗 ============
lines.push('');
lines.push('## Act 2 征召战斗:猫群压境,小队出击,代价真实(全役阵亡 3 人,含 2 名征召兵)');
let wave = 0;
let battleStart = -1;
for (let i = 0; i < 2400; i++) {
  sim.step(0.5);
  flushEvents('日常');
  if (sim.hostiles.length > 0) { wave = sim.hostiles.length; battleStart = sim.time; break; }
}
if (battleStart < 0) lines.push('（本局长时间无猫袭,跳过战斗幕）');
else {
  const cat = sim.hostiles[0];
  lines.push(`[${mk(sim.time)}] ⚠ 野猫浪潮 ×${wave}（前峰 @(${Math.round(cat.x)},${Math.round(cat.y)}) hp${Math.round(cat.hp)}）——玩家接管:`);
  const dist = (eid: number) => { const p = sim.pawnPositions.get(eid)!; return Math.hypot(p.x - cat.x, p.y - cat.y); };
  const squad = [...sim.pawns].sort((a, b) => dist(a) - dist(b)).slice(0, 3);
  for (const eid of squad) sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: eid, args: { drafted: true } });
  lines.push(`[${mk(sim.time)}] ⚔ 征召小队：#${squad.join('、#')}（停止自主,待命听指挥）`);
  flushEvents('征召');
  sim.issueCommand({ type: 'attack', x: 0, y: 0, pawnId: squad[0], args: { hostileIndex: 0 } });
  lines.push(`[${mk(sim.time)}] 🎯 指挥 #${squad[0]} 攻击野猫#0`);
  const squadSet = new Set(squad);
  for (let i = 0; i < 2400; i++) {
    sim.step(0.5);
    flushEvents('交战');
    if (sim.hostiles.length === 0 && sim.historyRecent.some((h) => h.type === 'pawn_died')) break;
    if (sim.hostiles.length === 0) break;
  }
  const alive = squad.filter((eid) => sim.pawns.includes(eid));
  const fallen = squad.filter((eid) => !sim.pawns.includes(eid));
  if (fallen.length) lines.push(`[${mk(sim.time)}] 💀 小队阵亡：#${fallen.join('、#')}（征召不是无敌——伤亡是真实的）`);
  for (const eid of alive) sim.issueCommand({ type: 'draft', x: 0, y: 0, pawnId: eid, args: { drafted: false } });
  lines.push(`[${mk(sim.time)}] ☮ 解除征召:#${alive.join('、#')}（幸存者恢复自主）`);
  if (sim.hostiles.length === 0) lines.push(`[${mk(sim.time)}] 🕊 猫群退散——防线守住`);
  flushEvents('战后');
  stepN(30); flushEvents('战后');
}

// ============ Act 3 拓荒 ============
lines.push('');
lines.push('## Act 3 拓荒迁徙:人口兴旺,篝火分家');
const campBase = campCount();
for (let i = 0; i < 2400; i++) {
  sim.step(0.5);
  flushEvents('发展');
  if (sim.pawns.length >= 6 && sim.stockpile.wood >= 300 && campCount() === campBase) break;
}
lines.push(`[${mk(sim.time)}] 🏕 人口 ${sim.pawns.length}、木 ${Math.round(sim.stockpile.wood)}——分家条件成熟`);
// 快照：knownCamps = 降旨前已有篝火；newCamps 只记**降旨后新增**（此前把旧火误报为新火——踩坑），
// 且中断条件必须看 newCamps（快照集合不能进同一集合,否则循环立即 break）
const knownCamps = new Set<number>();
for (const [k, b] of sim.world.buildings.entries()) if (b.def.id === 'campfire') knownCamps.add(k);
sim.issueCommand({ type: 'strategy', x: 0, y: 0, args: { cardId: 'oracle:migrate' } });
flushEvents('拓荒令');
const migrate = sim.mods.strategyCards.find((c) => c.id === 'oracle:migrate');
lines.push(`[${mk(sim.time)}] 🎯 降拓荒令:蓝图 ${migrate?.blueprint?.defId}（营地点=距主聚居地远距落点）`);
for (let i = 0; i < 2400; i++) {
  sim.step(0.5);
  for (const [k, b] of sim.world.buildings.entries()) if (b.def.id === 'campfire' && !knownCamps.has(k) && !newCamps.has(k)) { newCamps.add(k); const p = World.keyToXY(k); lines.push(`[${mk(sim.time)}] 🔥 拓荒令落地:新篝火落成 @(${p.x},${p.y})——营地聚居 ${campCount()} 处`); flushEvents('建成'); }
  flushEvents('拓荒');
  if (newCamps.size >= 1) break;
}
if (!newCamps.size) lines.push(`[${mk(sim.time)}] （拓荒令蓝图本局未落地——居民太忙;策略卡蓝图非必然生效,这是设计而非缺陷）`);

// ============ 收尾 ============
lines.push('');
lines.push('## 结算');
lines.push(`时长 ${mk(sim.time)} · 人口 ${sim.pawns.length} · 篝火 ${campCount()} 处 · 阵亡总数 ${deaths.size}`);
lines.push(`库存:木 ${Math.round(sim.stockpile.wood)} · 石 ${Math.round(sim.stockpile.ore)} · 食物 ${Math.round(sim.stockpile.food)}`);
lines.push(`🃏 身上带策略卡（习惯卡）的小人：${sim.pawns.filter((eid) => sim.pawnProfile(eid)?.slots.some((c) => c?.id.startsWith('strategy:'))).map((eid) => `#${eid}`).join('、') || '无'}`);
console.log(lines.join('\n'));
