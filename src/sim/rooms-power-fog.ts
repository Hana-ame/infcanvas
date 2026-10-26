/**
 * rooms-power-fog.ts —— 房间封顶 (>13×13 算室外)、高差斜坡 (`slope` 连通 z±1 且消除地形边界)
 *                       以及实心山体阻断判定。
 */
import type { Pos } from './types';
import type { Sim } from './sim';
import type { World } from './world';

/** 房间封顶最大边长：大于 13×13 的房间无法封顶，算作室外 */
export const MAX_ROOFED_ROOM_DIM = 13;
export const MAX_ROOM_SIDE = 13;
export const MAX_ROOFED_ROOM_AREA = MAX_ROOFED_ROOM_DIM * MAX_ROOFED_ROOM_DIM; // 169

/**
 * ⚠️ 这里曾重复定义 MAX_POWER_GRID_NODES / MAX_POWER_GRID_SPAN / MAX_ZOOM_FOG_RADIUS /
 * PAWN_VISION_RADIUS / GREAT_BONFIRE_FOG_RADIUS / ELECTRIC_BEACON_FOG_RADIUS 六个常量
 * （与 power-fog-engine.ts 逐字重复）。两个模块都被 src/sim/index.ts 用 `export *` 汇聚，
 * Rollup 视为同名冲突而整体丢弃 → `vite build` 直接失败，而 `tsc --noEmit` 与 vitest 全绿，
 * 只有构建才炸（2026-10-26 合并时发现）。
 * 唯一真相源：src/sim/power-fog-engine.ts（那才是真正引用它们的模块）。
 * 本模块一个都不用，故整块删除而非 re-export（避免与 power-fog-engine → 本模块的已有依赖边构成环）。
 */

/** 斜坡 (`slope`) 的通行耗时惩罚乘数（1.55× 耗时，即移速 ×0.645 移速惩罚） */
export const SLOPE_LADDER_SPEED_PENALTY_MUL = 1.55;

export interface RoomInspection {
  enclosed: boolean;
  roofed: boolean;
  indoors: boolean;
  width: number;
  height: number;
  tileCount: number;
  cells: Pos[];
  reason: string;
  label: string;
}

export interface PowerGridComponent {
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

export interface PlayerFogSource {
  x: number;
  y: number;
  radius: number;
  kind: 'base' | 'pawn' | 'great_bonfire' | 'electric_beacon_tower';
  sourceKind: 'base' | 'pawn' | 'great_bonfire' | 'electric_beacon_tower';
}

export interface SlopeTraversalResult {
  ok: boolean;
  allowed: boolean;
  viaSlope: boolean;
  requiresClimbCheck: boolean;
  requiresClimbRoll: boolean;
  speedPenaltyMul: number;
}

function resolveWorld(simOrWorld: Sim | World): World {
  return 'world' in simOrWorld ? simOrWorld.world : simOrWorld;
}

/**
 * 判定坐标 (x, y) 是否为不可穿越、不可透视的实心山体（Granite Mountain, stone 且 z >= 3）。
 */
export function isSolidMountainAt(simOrWorld: Sim | World, ix: number, iy: number): boolean {
  const world = resolveWorld(simOrWorld);
  const x = Math.round(ix);
  const y = Math.round(iy);
  if (
    Math.abs(x - world.spawn.x) <= world.tuning.world.spawnClearRadius &&
    Math.abs(y - world.spawn.y) <= world.tuning.world.spawnClearRadius
  ) {
    return false;
  }
  return world.zAt(x, y) >= 3 && world.tileAt(x, y) === 'stone';
}

/**
 * 判定坐标 (x, y) 是否存在天然斜坡或人工建造的斜坡（连通 z±1 海拔高度且不渲染地形高差边界）。
 * 使用 World 内部 O(1) 缓存加速。
 */
export function hasSlopeAt(simOrWorld: Sim | World, ix: number, iy: number): boolean {
  const world = resolveWorld(simOrWorld);
  const x = Math.round(ix);
  const y = Math.round(iy);
  const b = world.buildingAt(x, y);
  if (b && !b.isBlueprint && b.defId === 'slope') return true;
  return world.naturalSlopeAt(x, y);
}

/**
 * 极速布尔判定：从 (fx, fy) 移动到 (tx, ty) 是否允许通过高差（供 A* 寻路热点循环直接调用，避免对象分配和平地冗余斜坡查询）。
 */
export function canStepElevationFast(
  world: World,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  drafted = false,
): boolean {
  const dz = Math.abs(world.zAt(tx, ty) - world.zAt(fx, fy));
  if (dz === 0) return true;
  if (dz > 1) return false;
  if (drafted) return true;
  return hasSlopeAt(world, fx, fy) || hasSlopeAt(world, tx, ty);
}

/**
 * 检查从 (fx, fy) 移动到 (tx, ty) 的高差斜坡规则：
 *  - 斜坡格子连通 z±1 的地方；
 *  - 若高差 Δz == 1：
 *    - 普通未征召状态 (`!drafted`)：必须经过斜坡 (`hasSlopeAt`)，耗时乘以 `SLOPE_LADDER_SPEED_PENALTY_MUL (1.55)`；
 *    - 征召状态 (`drafted`)：无斜坡时允许强行攀爬/跳下 Δz == 1 的断崖（耗时 2.5 倍、有摔伤风险）。
 */
export function canTraverseElevationWithSlope(
  simOrWorld: Sim | World,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  drafted = false,
): SlopeTraversalResult {
  const world = resolveWorld(simOrWorld);
  const rx0 = Math.round(fx);
  const ry0 = Math.round(fy);
  const rx1 = Math.round(tx);
  const ry1 = Math.round(ty);
  if (isSolidMountainAt(world, rx1, ry1)) {
    return {
      ok: false,
      allowed: false,
      viaSlope: false,
      requiresClimbCheck: false,
      requiresClimbRoll: false,
      speedPenaltyMul: 1,
    };
  }
  const dz = Math.abs(world.zAt(rx1, ry1) - world.zAt(rx0, ry0));
  if (dz > 1) {
    return {
      ok: false,
      allowed: false,
      viaSlope: false,
      requiresClimbCheck: false,
      requiresClimbRoll: false,
      speedPenaltyMul: 1,
    };
  }
  const slopeHere = hasSlopeAt(world, rx0, ry0) || hasSlopeAt(world, rx1, ry1);
  if (dz === 0) {
    return {
      ok: true,
      allowed: true,
      viaSlope: slopeHere,
      requiresClimbCheck: false,
      requiresClimbRoll: false,
      speedPenaltyMul: slopeHere ? SLOPE_LADDER_SPEED_PENALTY_MUL : 1,
    };
  }
  if (slopeHere) {
    return {
      ok: true,
      allowed: true,
      viaSlope: true,
      requiresClimbCheck: false,
      requiresClimbRoll: false,
      speedPenaltyMul: SLOPE_LADDER_SPEED_PENALTY_MUL,
    };
  }
  if (drafted) {
    return {
      ok: true,
      allowed: true,
      viaSlope: false,
      requiresClimbCheck: true,
      requiresClimbRoll: true,
      speedPenaltyMul: 2.5,
    };
  }
  return {
    ok: false,
    allowed: false,
    viaSlope: false,
    requiresClimbCheck: false,
    requiresClimbRoll: false,
    speedPenaltyMul: 1,
  };
}

const roomInspectCache = new WeakMap<
  World,
  { tagVer: number; map: Map<number, RoomInspection> }
>();

/**
 * 房间闭合与封顶判定（带按建筑版本号自动失效的瓦片级记忆化缓存）：
 *  - 未建成的蓝图 (`b.isBlueprint`) 不作为墙体边界；
 *  - 大于 13×13 的房间无法封顶，算作室外（width > 13 || height > 13 || tileCount > 169 => roofed: false, indoors: false）。
 */
export function inspectRoomAt(simOrWorld: Sim | World, ix: number, iy: number): RoomInspection {
  const world = resolveWorld(simOrWorld);
  const startX = Math.round(ix);
  const startY = Math.round(iy);
  const cellKey = (startX + 32768) * 65536 + (startY + 32768);
  const tagVer = world.tagVersionNow();

  let cacheEntry = roomInspectCache.get(world);
  if (!cacheEntry || cacheEntry.tagVer !== tagVer) {
    cacheEntry = { tagVer, map: new Map<number, RoomInspection>() };
    roomInspectCache.set(world, cacheEntry);
  } else {
    const cached = cacheEntry.map.get(cellKey);
    if (cached) return cached;
  }

  const isBoundary = (x: number, y: number): boolean => {
    const b = world.buildingAt(x, y);
    if (b && !b.isBlueprint && (b.defId === 'wall' || b.defId === 'door')) return true;
    if (isSolidMountainAt(world, x, y)) return true;
    return false;
  };

  if (isBoundary(startX, startY)) {
    const reason = '墙体/门/山体';
    const res: RoomInspection = {
      enclosed: false,
      roofed: false,
      indoors: false,
      width: 1,
      height: 1,
      tileCount: 1,
      cells: [{ x: startX, y: startY }],
      reason,
      label: reason,
    };
    cacheEntry.map.set(cellKey, res);
    return res;
  }

  const visited = new Set<number>();
  const queue: Pos[] = [{ x: startX, y: startY }];
  visited.add(cellKey);

  let minX = startX;
  let maxX = startX;
  let minY = startY;
  let maxY = startY;
  let leaked = false;
  const MAX_SEARCH_TILES = 260;

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.x < minX) minX = cur.x;
    if (cur.x > maxX) maxX = cur.x;
    if (cur.y < minY) minY = cur.y;
    if (cur.y > maxY) maxY = cur.y;

    if (queue.length > MAX_SEARCH_TILES) {
      leaked = true;
      break;
    }

    const neighbors = [
      [cur.x + 1, cur.y],
      [cur.x - 1, cur.y],
      [cur.x, cur.y + 1],
      [cur.x, cur.y - 1],
    ];
    for (let i = 0; i < 4; i++) {
      const nx = neighbors[i][0];
      const ny = neighbors[i][1];
      const nk = (nx + 32768) * 65536 + (ny + 32768);
      if (visited.has(nk)) continue;
      if (isBoundary(nx, ny)) continue;
      visited.add(nk);
      queue.push({ x: nx, y: ny });
    }
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const tileCount = queue.length;

  let res: RoomInspection;
  if (leaked) {
    const reason = '室外';
    res = {
      enclosed: false,
      roofed: false,
      indoors: false,
      width,
      height,
      tileCount,
      cells: queue,
      reason,
      label: reason,
    };
  } else if (width > MAX_ROOFED_ROOM_DIM || height > MAX_ROOFED_ROOM_DIM || tileCount > MAX_ROOFED_ROOM_AREA) {
    const reason = `室外(${width}×${height})`;
    res = {
      enclosed: true,
      roofed: false,
      indoors: false,
      width,
      height,
      tileCount,
      cells: queue,
      reason,
      label: reason,
    };
  } else {
    const reason = `室内(${width}×${height})`;
    res = {
      enclosed: true,
      roofed: true,
      indoors: true,
      width,
      height,
      tileCount,
      cells: queue,
      reason,
      label: reason,
    };
    for (const c of queue) {
      cacheEntry.map.set((c.x + 32768) * 65536 + (c.y + 32768), res);
    }
  }

  cacheEntry.map.set(cellKey, res);
  return res;
}

export * from './power-fog-engine';
