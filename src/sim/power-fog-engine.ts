/**
 * power-fog-engine.ts —— 电网规模损耗与超限 0W 熔断机制 (`evaluatePowerGrids`)、
 *                        以及跟随 Player 的独立战争迷雾与高差视线遮挡 (`hasLineOfSight`：低处不能看高处)。
 */
import { hasSlopeAt, isSolidMountainAt } from './rooms-power-fog';
import type { BuildingState, Pos } from './types';
import type { World } from './world';
import type { Sim } from './sim';

export const MAX_POWER_GRID_NODES = 32;
export const MAX_POWER_GRID_SPAN = 36;
export const MAX_ZOOM_FOG_RADIUS = 28;
export const PAWN_VISION_RADIUS = 13;
export const GREAT_BONFIRE_FOG_RADIUS = 22;
export const ELECTRIC_BEACON_FOG_RADIUS = 38;

function resolveWorld(simOrWorld: Sim | World): World {
  return 'world' in simOrWorld ? simOrWorld.world : simOrWorld;
}

export interface PowerGridStatus {
  gridId: number;
  buildingIds: string[];
  nodeCount: number;
  spanX: number;
  spanY: number;
  maxSpan: number;
  spanTiles: number;
  rawSupplyW: number;
  demandW: number;
  lossRatio: number;
  scaleLossPct: number;
  overloadRefused: boolean;
  effectiveSupplyW: number;
  netPowerW: number;
  powered: boolean;
  statusText: string;
}

export const POWER_BUILDING_SPECS: Record<
  string,
  { supplyW: number; demandW: number; isConduit?: boolean; isBattery?: boolean }
> = {
  wood_generator: { supplyW: 1000, demandW: 0 },
  solar_generator: { supplyW: 1400, demandW: 0 },
  wind_turbine: { supplyW: 1650, demandW: 0 },
  standing_lamp: { supplyW: 0, demandW: 30 },
  battery: { supplyW: 200, demandW: 0, isBattery: true },
  power_conduit: { supplyW: 0, demandW: 15, isConduit: true },
  electric_beacon_tower: { supplyW: 0, demandW: 250 },
  turret: { supplyW: 0, demandW: 80 },
  gene_assembler: { supplyW: 0, demandW: 150 },
  research_bench: { supplyW: 0, demandW: 60 },
};

const powerGridCache = new WeakMap<World, { tagVer: number; count: number; grids: PowerGridStatus[] }>();

export function evaluatePowerGrids(simOrWorld: Sim | World): PowerGridStatus[] {
  const world = resolveWorld(simOrWorld);
  const cached = powerGridCache.get(world);
  if (cached && cached.tagVer === world.tagVersionNow() && cached.count === world.buildings.size) {
    return cached.grids;
  }

  const powerBuildings: BuildingState[] = [];
  for (const b of world.buildings.values()) {
    if (POWER_BUILDING_SPECS[b.defId]) {
      powerBuildings.push(b);
    }
  }
  if (powerBuildings.length === 0) {
    powerGridCache.set(world, { tagVer: world.tagVersionNow(), count: world.buildings.size, grids: [] });
    return [];
  }

  const visited = new Set<string>();
  const grids: PowerGridStatus[] = [];
  let nextGridId = 1;

  const isConnected = (a: BuildingState, b: BuildingState): boolean => {
    const ra = world.buildingRect(a);
    const rb = world.buildingRect(b);
    const dx = Math.max(ra.x0 - rb.x1, 0, rb.x0 - ra.x1);
    const dy = Math.max(ra.y0 - rb.y1, 0, rb.y0 - ra.y1);
    const dist = Math.hypot(dx, dy);
    const aCond = a.defId === 'power_conduit';
    const bCond = b.defId === 'power_conduit';
    return dist <= (aCond || bCond ? 2.5 : 5.2);
  };

  for (const seed of powerBuildings) {
    if (visited.has(seed.id)) continue;
    const comp: BuildingState[] = [seed];
    visited.add(seed.id);
    let head = 0;
    while (head < comp.length) {
      const cur = comp[head++];
      for (const other of powerBuildings) {
        if (visited.has(other.id)) continue;
        if (isConnected(cur, other)) {
          visited.add(other.id);
          comp.push(other);
        }
      }
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let nodeCount = 0;
    let rawSupplyW = 0;
    let demandW = 0;

    for (const b of comp) {
      const rect = world.buildingRect(b);
      if (rect.x0 < minX) minX = rect.x0;
      if (rect.x1 > maxX) maxX = rect.x1;
      if (rect.y0 < minY) minY = rect.y0;
      if (rect.y1 > maxY) maxY = rect.y1;
      nodeCount += rect.w * rect.h;
      const spec = POWER_BUILDING_SPECS[b.defId];
      if (spec) {
        rawSupplyW += spec.supplyW;
        demandW += spec.demandW;
      }
    }

    const spanX = maxX >= minX ? maxX - minX + 1 : 1;
    const spanY = maxY >= minY ? maxY - minY + 1 : 1;
    const maxSpan = Math.max(spanX, spanY);
    const spanTiles = Math.hypot(spanX, spanY);

    if (nodeCount > MAX_POWER_GRID_NODES || maxSpan > MAX_POWER_GRID_SPAN || spanTiles > MAX_POWER_GRID_SPAN) {
      grids.push({
        gridId: nextGridId++,
        buildingIds: comp.map((b) => b.id),
        nodeCount,
        spanX,
        spanY,
        maxSpan,
        spanTiles,
        rawSupplyW,
        demandW,
        lossRatio: 1.0,
        scaleLossPct: 1.0,
        overloadRefused: true,
        effectiveSupplyW: 0,
        netPowerW: 0,
        powered: false,
        statusText: `0W (节点${nodeCount}/${MAX_POWER_GRID_NODES}, 跨度${maxSpan}/${MAX_POWER_GRID_SPAN})`,
      });
      continue;
    }

    const lossRatio = Math.min(
      0.92,
      0.014 * nodeCount + 0.0009 * nodeCount * nodeCount + 0.006 * maxSpan,
    );
    const effectiveSupplyW = Math.round(rawSupplyW * (1 - lossRatio));
    const netPowerW = effectiveSupplyW - demandW;
    const powered = effectiveSupplyW > 0 && effectiveSupplyW >= demandW;

    grids.push({
      gridId: nextGridId++,
      buildingIds: comp.map((b) => b.id),
      nodeCount,
      spanX,
      spanY,
      maxSpan,
      spanTiles,
      rawSupplyW,
      demandW,
      lossRatio,
      scaleLossPct: lossRatio,
      overloadRefused: false,
      effectiveSupplyW,
      netPowerW,
      powered,
      statusText: `${effectiveSupplyW}W / ${demandW}W (损耗${Math.round(lossRatio * 100)}%)`,
    });
  }

  powerGridCache.set(world, { tagVer: world.tagVersionNow(), count: world.buildings.size, grids });
  return grids;
}

export function getBuildingPowerGrid(simOrWorld: Sim | World, buildingId: string): PowerGridStatus | null {
  const grids = evaluatePowerGrids(simOrWorld);
  return grids.find((g) => g.buildingIds.includes(buildingId)) ?? null;
}

export function isBuildingPowered(simOrWorld: Sim | World, buildingId: string): boolean {
  const g = getBuildingPowerGrid(simOrWorld, buildingId);
  return g ? g.powered && !g.overloadRefused : false;
}

export interface FogSource {
  x: number;
  y: number;
  radius: number;
  kind: 'base' | 'pawn' | 'great_bonfire' | 'electric_beacon_tower';
  sourceKind: 'base' | 'pawn' | 'great_bonfire' | 'electric_beacon_tower';
}

const fogSourcesTickCache = new WeakMap<
  Sim,
  { time: number; playerId: string; bldCount: number; pawnCount: number; sources: FogSource[] }
>();

export function getPlayerFogSources(sim: Sim, playerId = 'p_local_1'): FogSource[] {
  const cached = fogSourcesTickCache.get(sim);
  if (
    cached &&
    cached.time === sim.time &&
    cached.playerId === playerId &&
    cached.bldCount === sim.world.buildings.size &&
    cached.pawnCount === sim.pawnMap.size &&
    sim.pawnMap.size >= 20
  ) {
    return cached.sources;
  }

  const sources: FogSource[] = [];
  if (playerId === 'p_local_1') {
    const camp = sim.campPos() ?? sim.world.spawn;
    sources.push({ x: camp.x, y: camp.y, radius: MAX_ZOOM_FOG_RADIUS, kind: 'base', sourceKind: 'base' });
    const stride = sim.pawnMap.size > 24 ? Math.ceil(sim.pawnMap.size / 16) : 1;
    let idx = 0;
    for (const p of sim.pawns()) {
      idx++;
      if (stride > 1 && idx % stride !== 0) continue;
      const owner = p.controlledBy ?? 'p_local_1';
      if (owner !== playerId || p.isStranger) continue;
      sources.push({ x: p.pos.x, y: p.pos.y, radius: PAWN_VISION_RADIUS, kind: 'pawn', sourceKind: 'pawn' });
    }
  } else {
    for (const p of sim.pawns()) {
      if (p.controlledBy === playerId) {
        sources.push({ x: p.pos.x, y: p.pos.y, radius: PAWN_VISION_RADIUS, kind: 'pawn', sourceKind: 'pawn' });
      }
    }
    for (const h of sim.hostiles()) {
      if (h.kind.startsWith('raider')) {
        sources.push({ x: h.pos.x, y: h.pos.y, radius: PAWN_VISION_RADIUS, kind: 'pawn', sourceKind: 'pawn' });
      }
    }
    if (sources.length === 0) {
      sources.push({ x: 36, y: 30, radius: MAX_ZOOM_FOG_RADIUS, kind: 'base', sourceKind: 'base' });
    }
  }

  const grids = evaluatePowerGrids(sim.world);
  for (const b of sim.world.buildings.values()) {
    const owner = b.ownerPlayerId ?? 'p_local_1';
    if (owner !== playerId) continue;
    const center = sim.world.buildingCenter(b);
    if (b.defId === 'great_bonfire') {
      sources.push({
        x: center.x,
        y: center.y,
        radius: GREAT_BONFIRE_FOG_RADIUS,
        kind: 'great_bonfire',
        sourceKind: 'great_bonfire',
      });
    } else if (b.defId === 'electric_beacon_tower') {
      const g = grids.find((gr) => gr.buildingIds.includes(b.id));
      if (g && g.powered && !g.overloadRefused) {
        sources.push({
          x: center.x,
          y: center.y,
          radius: ELECTRIC_BEACON_FOG_RADIUS,
          kind: 'electric_beacon_tower',
          sourceKind: 'electric_beacon_tower',
        });
      }
    }
  }

  fogSourcesTickCache.set(sim, {
    time: sim.time,
    playerId,
    bldCount: sim.world.buildings.size,
    pawnCount: sim.pawnMap.size,
    sources,
  });
  return sources;
}

/**
 * 视线与海拔高差判定 (`低处不能看高处`)：
 *  - 观察者位于 `(x0, y0)`，海拔为 `srcZ = world.zAt(sx, sy) + elevBonus`；
 *  - 目标格 `(x1, y1)` 海拔为 `dstZ = world.zAt(tx, ty)`；
 *  - 若 `dstZ > srcZ`（目标在更高处）：除非是紧邻 1 格的斜坡入口 (`steps <= 1 && dstZ === srcZ + 1 && (hasSlopeAt(sx,sy) || hasSlopeAt(tx,ty))`)，否则返回 `false`（低处不能看高处）；
 *  - 视线射线途经任何高于 `srcZ` 的地形格 (`world.zAt(mx, my) > srcZ`) 或实心山体时，视线被遮挡返回 `false`。
 */
export function hasLineOfSight(
  simOrWorld: Sim | World,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  elevBonus = 0,
): boolean {
  const world = resolveWorld(simOrWorld);
  const sx = Math.round(x0);
  const sy = Math.round(y0);
  const tx = Math.round(x1);
  const ty = Math.round(y1);
  if (sx === tx && sy === ty) return true;

  const srcZ = world.zAt(sx, sy) + elevBonus;
  const dstZ = world.zAt(tx, ty);
  const steps = Math.max(Math.abs(tx - sx), Math.abs(ty - sy));

  // 低处不能看高处（紧邻斜坡格允许看见以便走上斜坡）
  if (dstZ > srcZ) {
    const canSeeAdjacentSlope =
      steps <= 1 &&
      dstZ === srcZ + 1 &&
      (hasSlopeAt(world, sx, sy) || hasSlopeAt(world, tx, ty));
    if (!canSeeAdjacentSlope) return false;
  }

  if (isSolidMountainAt(world, tx, ty)) {
    const hasOpenNeighbor =
      !isSolidMountainAt(world, tx + 1, ty) ||
      !isSolidMountainAt(world, tx - 1, ty) ||
      !isSolidMountainAt(world, tx, ty + 1) ||
      !isSolidMountainAt(world, tx, ty - 1);
    if (!hasOpenNeighbor) return false;
  }
  if (steps <= 1) return true;
  const stride = steps > 12 ? 2 : 1;
  for (let i = 1; i < steps; i += stride) {
    const mx = Math.round(sx + ((tx - sx) * i) / steps);
    const my = Math.round(sy + ((ty - sy) * i) / steps);
    if (mx !== tx || my !== ty) {
      if (world.zAt(mx, my) > srcZ) return false;
      if (isSolidMountainAt(world, mx, my)) return false;
    }
  }
  return true;
}

export function isTileVisibleToPlayer(
  sim: Sim,
  playerId: string,
  ix: number,
  iy: number,
  precomputedSources?: FogSource[],
): boolean {
  const x = Math.round(ix);
  const y = Math.round(iy);
  const sources = precomputedSources ?? getPlayerFogSources(sim, playerId);
  for (const s of sources) {
    const d = Math.hypot(x - s.x, y - s.y);
    if (d <= s.radius) {
      const elevBonus = s.sourceKind === 'great_bonfire' || s.sourceKind === 'electric_beacon_tower' ? 2 : 0;
      if (hasLineOfSight(sim.world, s.x, s.y, x, y, elevBonus)) {
        return true;
      }
    }
  }
  return false;
}

export function clampPathToPlayerFog(sim: Sim, playerId: string, rawPath: Pos[]): Pos[] {
  if (rawPath.length === 0) return [];
  const sources = getPlayerFogSources(sim, playerId);
  const out: Pos[] = [];
  for (const pt of rawPath) {
    if (!isTileVisibleToPlayer(sim, playerId, pt.x, pt.y, sources)) {
      break;
    }
    out.push(pt);
  }
  return out;
}
