// DLC 隔离测试助手（2026-08-20，用户「不添加核心，单独测试 DLC 包」）：
// 创建只挂载指定 DLC 包（+其 requires 依赖）的最小 Sim，不加载默认 playstyle。
// 用法：
//   const { sim, ctx } = await createDlcTest('seasons');
//   sim.step(1); expect(ctx.events).toContain('春天来了');
//
// 背景：ModRegistry.default() 挂载全部 46 个包 → 测试一个 DLC 要等全部装配。
// 本助手用 bare registry（只有内核 defs + 指定 DLC），秒级初始化 + 隔离验证。

import { Sim } from '../../../sim/sim';
import { ModRegistry } from '../../../sim/mods/registry';
import { World } from '../../../sim/core/world';
import { EventBus } from '../../../sim/core/events';
import { SimRng } from '../../../sim/core/rng';
import { TILES, BUILDINGS, ITEMS } from '../../../sim/defs';
import { ENEMIES } from '../../../sim/defs/enemies';
import { RECIPES } from '../../../sim/defs/recipes';
import { BASE_CARDS } from '../../../sim/ai/pawn';
import { TECHS } from '../../../sim/defs/techs';
import { TUNING } from '../../../sim/defs/tuning';
import { STRATEGY_CARDS } from '../../../sim/defs/strategyCards';
import type { SimContext } from '../../../sim/systems/context';
import type { ModPack } from '../../pack';
import { PLAYSTYLE_PACKS } from '../playstyle';
import { registerPack, topoSort } from '../../pack';

export interface DlcTestContext {
  sim: Sim;
  registry: ModRegistry;
  // 快捷方法
  step(dt: number): void;
  spawnPawn(x?: number, y?: number): number;
  getEvents(): { time: number; text: string }[];
  getNeed(eid: number, field: string): number | undefined;
  setNeed(eid: number, field: string, value: number): void;
  build(x: number, y: number, defId: string): boolean;
}

// 创建只挂载指定 DLC 包的测试环境
export function createDlcTest(
  packIds: string | string[],
  opts?: { seed?: number; pawnCount?: number; extraPacks?: string[] },
): DlcTestContext {
  const ids = Array.isArray(packIds) ? packIds : [packIds];
  const seed = opts?.seed ?? 42;
  const pawnCount = opts?.pawnCount ?? 1;

  // 创建 bare registry（内核 defs + 无 playstyle 包）
  const registry = new ModRegistry({
    tiles: TILES, buildings: BUILDINGS, items: ITEMS, enemies: ENEMIES,
    cards: BASE_CARDS, recipes: RECIPES, tuning: TUNING, intents: [], works: [],
  });
  for (const c of STRATEGY_CARDS) registry.registerStrategyCard(c);
  for (const techId of Object.keys(TECHS)) registry.registerTech(TECHS[techId]);

  // 挂载指定的 DLC 包（+ requires 依赖自动解析）
  const packsToMount: ModPack[] = [];
  const resolveDeps = (id: string, seen: Set<string>): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const pack = PLAYSTYLE_PACKS[id];
    if (!pack) throw new Error(`DLC 包 "${id}" 不存在于 PLAYSTYLE_PACKS`);
    // 先挂依赖
    for (const dep of pack.requires ?? []) resolveDeps(dep, seen);
    packsToMount.push(pack);
  };
  const seen = new Set<string>();
  for (const id of [...ids, ...(opts?.extraPacks ?? [])]) resolveDeps(id, seen);
  // pawnCount > 0 时自动加 bootstrap（出生刷人）
  if (pawnCount > 0) resolveDeps("bootstrap", seen);

  // 按拓扑序挂载
  for (const pack of packsToMount) registry.mount(pack);
  // 跳过契约校验（隔离测试可能缺跨包契约写方）

  // 创建 Sim
  const sim = new Sim({ seed, pawnCount, registry });

  return {
    sim,
    registry,
    step: (dt: number) => sim.step(dt),
    spawnPawn: (x?: number, y?: number) => sim.spawnPawn(x ?? 96, y ?? 96),
    getEvents: () => sim.events,
    getNeed: (eid: number, field: string) => {
      const n = sim.readNeeds(eid);
      return n ? (n as unknown as Record<string, number>)[field] : undefined;
    },
    setNeed: (eid: number, field: string, value: number) => sim.setNeedField(eid, field, value),
    build: (x: number, y: number, defId: string) => sim.world.placeBuilding(x, y, defId, 'player'),
  };
}