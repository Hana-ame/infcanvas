/**
 * client/hud-faces.ts —— HUD 汇总面与详情面的**唯一实现**（R3-HUD）。
 *
 * 为什么单独一个模块（而不是在 LocalView/RemoteSim 各写一遍）：
 * 项目纪律是「双模同脸零分支」——LocalView 与 RemoteSim 必须对 HUD 长同一张脸。
 * 但"同脸"不等于"同一份代码"：两个实现方各自遍历 pawns()/buildings() 各拼一次，
 * 迟早会出现"本地显示 4 只鼠、联机显示 3 只"的漂移，而这类漂移极难排查
 * （看起来像协议问题，实际是两份拼装逻辑分了叉）。
 *
 * 所以把**纯聚合逻辑**抽到这里，两个 WorldView 实现只负责把各自的原始面喂进来。
 * 差异只剩"数据从哪来"（Sim 直接读 / RemoteSim 读快照投影），算法完全同源——
 * 这正是 R2-1 之后确立的分工：协议负责搬运，实现方负责搬运，展示模型由本模块统一拼。
 *
 * 纯函数、零 DOM、零 Pixi —— node 环境可直接单测。
 */
import type { BuildingDetail, ColonySummary, HostileDetail, PawnDetail } from './view';
import { cardLabel } from './presentation';
import type { BuildingState, Hostile, PawnState } from '../sim/types';
import type { Tuning } from '../sim/tuning';
import { K_STOCK_WOOD } from '../mods/contracts';

/** 汇总面所需的原始输入（两种模式的唯一差别就是这堆数据的来源）。 */
export interface FaceInput {
  pawns: Iterable<PawnState>;
  buildings: readonly BuildingState[];
  hostiles: readonly Hostile[];
  tuning: Tuning;
  traitName(trait: string): string;
  /** 最近火堆距离查询；无火返回 null。联机侧由 full 快照的建筑表回答。 */
  nearestFireDist(x: number, y: number): number | null;
  /** 叙事压力原始值与满阈值（raid 包 scratch）；未挂 raid 包时为 null */
  raidPressureRaw: number | null;
}

/**
 * 殖民地汇总。
 *
 * 为什么平均需求值得占一整个面板：此前玩家只能逐只点开看四条需求条，
 * 看不到"我的鼠群整体在饿还是在睡"——而这恰恰是殖民地模拟最该先回答的问题。
 * 平均值是定长标量，正好适合"算一次、拼 key 比对、变了才重画 DOM"的差分管线。
 */
export function buildColonySummary(input: FaceInput): ColonySummary {
  let n = 0;
  let food = 0;
  let rest = 0;
  let mood = 0;
  let san = 0;
  let hp = 0;
  for (const p of input.pawns) {
    n++;
    food += p.needs.food;
    rest += p.needs.rest;
    mood += p.needs.mood;
    san += p.needs.san;
    hp += p.maxHp > 0 ? (p.hp / p.maxHp) * 100 : 0;
  }
  const d = n > 0 ? 1 / n : 0;

  // 建筑按 defId 归并（种类 + 数量 + 是否耗燃料）；排序按名字保证 key 稳定——
  // Map 的插入序依赖遍历序，若不排序会让同一份数据在两种模式下产出不同 key，
  // 差分管线就会误判"每帧都变了"从而退化成每帧重建（正是本轮要消除的性能坑）。
  const byDef = new Map<string, { count: number; name: string; fuelSec?: number }>();
  for (const b of input.buildings) {
    const def = input.tuning.buildings[b.defId];
    let row = byDef.get(b.defId);
    if (!row) {
      row = { count: 0, name: def?.name ?? b.defId, fuelSec: def?.fuelSec };
      byDef.set(b.defId, row);
    }
    row.count++;
  }
  const buildingKinds = [...byDef.entries()]
    .map(([defId, r]) => ({ defId, name: r.name, count: r.count, fuelSec: r.fuelSec }))
    .sort((a, b) => (b.count - a.count) || a.defId.localeCompare(b.defId));

  // 叙事压力：HUD 只读。满阈值即刷怪且回落保留余量，所以"进度"是单调积累的，
  // ETA 用 (阈值 - 当前) / 速率估算——它只是估算，HUD 文案不承诺精确到秒。
  let raidPressure: number | null = null;
  let raidEtaSec: number | null = null;
  if (input.raidPressureRaw !== null) {
    const t = input.tuning.raid;
    const pct = t.pressureThreshold > 0 ? input.raidPressureRaw / t.pressureThreshold : 0;
    raidPressure = Math.max(0, Math.min(1, pct));
    raidEtaSec =
      t.pressurePerSec > 0 ? Math.max(0, (t.pressureThreshold - input.raidPressureRaw) / t.pressurePerSec) : null;
  }

  return {
    pawnCount: n,
    avgNeeds: {
      food: food * d,
      rest: rest * d,
      mood: mood * d,
      san: san * d,
    },
    avgHpPct: hp * d,
    buildingKinds,
    hostileCount: input.hostiles.length,
    raidPressure,
    raidEtaSec,
  };
}

/**
 * 选中一只鼠的档案。
 *
 * 熟练度与卡用次数此前**完全不可见**——而"一切皆抽卡"是本项目的核心红线：
 * 玩家看不到一只鼠养成过什么习惯，就无法理解它为什么总抽同一张卡。
 * 把这两张表接进选中面板，红线才第一次对玩家可见。
 */
export function buildPawnDetail(
  p: PawnState,
  traitName: (t: string) => string,
  nearestFireDist: (x: number, y: number) => number | null,
): PawnDetail {
  // 只留玩家真正在养成的那几项：v < 1 的是"抽过一次就再没抽中"，列出来只是噪声。
  const mastery = Object.entries(p.mastery)
    .filter(([, m]) => m.v >= 1)
    .map(([cardId, m]) => ({ cardId, label: cardLabel(cardId), v: Math.round(m.v) }))
    .sort((a, b) => b.v - a.v || a.cardId.localeCompare(b.cardId))
    .slice(0, 5);
  const uses = Object.entries(p.uses)
    .filter(([, n]) => n > 0)
    .map(([cardId, n]) => ({ cardId, label: cardLabel(cardId), n }))
    .sort((a, b) => b.n - a.n || a.cardId.localeCompare(b.cardId))
    .slice(0, 5);
  return {
    eid: p.eid,
    name: p.name,
    trait: p.trait,
    traitName: traitName(p.trait),
    cardLabel: cardLabel(p.cardId),
    needs: { ...p.needs },
    hpPct: p.maxHp > 0 ? (p.hp / p.maxHp) * 100 : 0,
    nearFireDist: nearestFireDist(p.pos.x, p.pos.y),
    mastery,
    uses,
  };
}

/** 选中一座建筑的档案：把 tuning 的定义与运行态拼在一起（HUD 不自己查表就不会漏 defId） */
export function buildBuildingDetail(
  b: BuildingState,
  all: readonly BuildingState[],
  tuning: Tuning,
): BuildingDetail {
  const def = tuning.buildings[b.defId];
  let sameKindCount = 0;
  for (const o of all) if (o.defId === b.defId) sameKindCount++;
  return {
    id: b.id,
    defId: b.defId,
    name: def?.name ?? b.defId,
    hp: b.hp,
    maxHp: def?.hp ?? b.hp,
    w: def?.w ?? 1,
    h: def?.h ?? 1,
    tags: def?.tags ?? [],
    fuelSec: def?.fuelSec,
    cost: { ...(def?.cost ?? {}) },
    sameKindCount,
  };
}

/** 选中敌袭单位的档案：名字 + 血量 + 它到底离营地多远（此前只有一个血条） */
export function buildHostileDetail(
  h: Hostile,
  all: readonly Hostile[],
  pawns: Iterable<PawnState>,
  tuning: Tuning,
): HostileDetail {
  let best = Infinity;
  for (const p of pawns) {
    const d = Math.hypot(h.pos.x - p.pos.x, h.pos.y - p.pos.y);
    if (d < best) best = d;
  }
  return {
    id: h.id,
    kind: h.kind,
    name: tuning.enemies[h.kind]?.name ?? h.kind,
    hp: h.hp,
    maxHp: h.maxHp,
    distToNearestPawn: best === Infinity ? -1 : best,
    engaging: best <= tuning.raid.senseRadius,
  };
}

/** 燃料消耗的文案（HUD 用；集中在此避免两处各写一份中文规则导致不一致） */
export function fuelLabel(fuelSec: number | undefined): string {
  if (fuelSec === undefined) return '免维护';
  return `每 ${fuelSec}s 耗 1 ${K_STOCK_WOOD === 'wood' ? '木' : K_STOCK_WOOD}`;
}