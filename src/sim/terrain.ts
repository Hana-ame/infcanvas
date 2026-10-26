/**
 * terrain.ts —— RimWorld 原版风格地形子类型、移动速率、土地肥力、建造承载力、实心山体阻断与斜坡占位规则。
 */
import { hash2 } from './rng';
import { hasSlopeAt, isSolidMountainAt } from './rooms-power-fog';
import type { World } from './world';

export type RimWorldTerrainId =
  | 'deep_water'
  | 'shallow_water'
  | 'marsh'
  | 'rich_soil'
  | 'soil'
  | 'packed_dirt'
  | 'sand'
  | 'gravel'
  | 'rough_stone'
  | 'granite_mountain';

export type TerrainSupportLevel = 'none' | 'light' | 'medium' | 'heavy';

export interface RimWorldTerrainMeta {
  id: RimWorldTerrainId;
  name: string;
  shortName: string;
  baseTile: 'grass' | 'dirt' | 'stone' | 'water' | 'hill';
  z: number;
  passable: boolean;
  /** 是否为不可穿越、不可透视的实心山体 */
  solidMountain?: boolean;
  /** 是否包含高差斜坡 */
  hasSlope?: boolean;
  /** 移动速度倍率 (0..1.2) */
  moveSpeedMul: number;
  /** 土地肥力 (0..1.4，如肥沃黑土 1.4 = 140%) */
  fertility: number;
  /** 地形及高地提供的掩体减伤率 (0..0.55) */
  coverPct: number;
  /** 地基承载等级 */
  supportLevel: TerrainSupportLevel;
  /** RimWorld 原版大地哑光主色与副纹理色 */
  primaryColor: string;
  secondaryColor: string;
}

export interface TerrainEdges {
  shoreN: boolean;
  shoreE: boolean;
  shoreS: boolean;
  shoreW: boolean;
  cliffN: boolean;
  cliffE: boolean;
  cliffS: boolean;
  cliffW: boolean;
}

export interface MultiTileTerrainCheck {
  ok: boolean;
  avgFertility: number;
  avgMoveSpeed: number;
  minZ: number;
  maxZ: number;
  elevDiff: number;
  reason?: string;
  cellReasons: { x: number; y: number; ok: boolean; terrain: RimWorldTerrainMeta; reason?: string }[];
}

const SALT_TERRAIN_SUB = 0x55c3;

export function terrainMetaAt(world: World, ix: number, iy: number): RimWorldTerrainMeta {
  const x = Math.round(ix);
  const y = Math.round(iy);
  const baseTile = world.tileAt(x, y);
  const z = world.zAt(x, y);
  const elev = world.elev(x, y);
  const moist = world.moist(x, y);
  const subHash = hash2(x, y, SALT_TERRAIN_SUB);
  const waterLv = world.tuning.world.waterLevel;
  const slope = hasSlopeAt(world, x, y);

  if (baseTile === 'water') {
    const isDeep = elev < waterLv * 0.72;
    if (isDeep) {
      return {
        id: 'deep_water',
        name: '深水区 (Deep Water)',
        shortName: '深水',
        baseTile,
        z,
        passable: false,
        moveSpeedMul: 0,
        fertility: 0,
        coverPct: 0,
        supportLevel: 'none',
        primaryColor: '#26455c',
        secondaryColor: '#1d364a',
      };
    }
    return {
      id: 'shallow_water',
      name: '浅水滩 (Shallow Water)',
      shortName: '浅水',
      baseTile,
      z,
      passable: false,
      moveSpeedMul: 0.38,
      fertility: 0,
      coverPct: 0,
      supportLevel: 'none',
      primaryColor: '#385e78',
      secondaryColor: '#456f8c',
    };
  }

  if (baseTile === 'stone') {
    if (isSolidMountainAt(world, x, y)) {
      return {
        id: 'granite_mountain',
        name: '实心花岗岩山体 (Solid Granite Mountain)',
        shortName: '花岗岩山体',
        baseTile,
        z,
        passable: false,
        solidMountain: true,
        hasSlope: false,
        moveSpeedMul: 0,
        fertility: 0,
        coverPct: 0.75,
        supportLevel: 'none',
        primaryColor: '#383a3d',
        secondaryColor: '#292b2e',
      };
    }
    return {
      id: 'rough_stone',
      name: '粗糙花岗岩地面 (Rough Hewn Granite)',
      shortName: '粗糙岩地',
      baseTile,
      z,
      passable: true,
      hasSlope: slope,
      moveSpeedMul: 0.94,
      fertility: 0,
      coverPct: 0.2,
      supportLevel: 'heavy',
      primaryColor: '#5c5e61',
      secondaryColor: '#4d4f52',
    };
  }

  const inSpawn =
    Math.abs(x - world.spawn.x) <= world.tuning.world.spawnClearRadius &&
    Math.abs(y - world.spawn.y) <= world.tuning.world.spawnClearRadius;
  if (!inSpawn && elev < waterLv + 0.042 && moist > 0.62) {
    return {
      id: 'marsh',
      name: '沼泽泥地 (Marshy Soil)',
      shortName: '沼泽',
      baseTile,
      z,
      passable: true,
      hasSlope: slope,
      moveSpeedMul: 0.62,
      fertility: 1.0,
      coverPct: 0,
      supportLevel: 'light',
      primaryColor: '#475240',
      secondaryColor: '#3a4434',
    };
  }

  if (z >= 2 && (subHash < 0.55 || baseTile === 'dirt')) {
    return {
      id: 'gravel',
      name: '山麓砾石 (Stony Gravel)',
      shortName: '砾石地',
      baseTile,
      z,
      passable: true,
      hasSlope: slope,
      moveSpeedMul: 0.9,
      fertility: 0.7,
      coverPct: 0.1,
      supportLevel: 'heavy',
      primaryColor: '#635c51',
      secondaryColor: '#544e44',
    };
  }

  if (baseTile === 'dirt') {
    if (!inSpawn && moist < 0.34) {
      return {
        id: 'sand',
        name: '荒原沙地 (Sand)',
        shortName: '沙地',
        baseTile,
        z,
        passable: true,
        hasSlope: slope,
        moveSpeedMul: 0.84,
        fertility: 0.1,
        coverPct: 0,
        supportLevel: 'medium',
        primaryColor: '#9c8966',
        secondaryColor: '#8a7857',
      };
    }
    return {
      id: 'packed_dirt',
      name: '夯实泥地 (Packed Dirt)',
      shortName: '泥地',
      baseTile,
      z,
      passable: true,
      hasSlope: slope,
      moveSpeedMul: 1.05,
      fertility: 0.5,
      coverPct: 0,
      supportLevel: 'heavy',
      primaryColor: '#78654b',
      secondaryColor: '#69573f',
    };
  }

  if (moist >= 0.58 && z <= 1) {
    return {
      id: 'rich_soil',
      name: '肥沃黑土 (Rich Soil · 140%肥力)',
      shortName: '肥沃黑土',
      baseTile,
      z,
      passable: true,
      hasSlope: slope,
      moveSpeedMul: 0.92,
      fertility: 1.4,
      coverPct: 0,
      supportLevel: 'heavy',
      primaryColor: '#3e452e',
      secondaryColor: '#333925',
    };
  }

  return {
    id: 'soil',
    name: '普通壤土 (Soil · 100%肥力)',
    shortName: '壤土',
    baseTile,
    z,
    passable: true,
    hasSlope: slope,
    moveSpeedMul: 1.0,
    fertility: 1.0,
    coverPct: 0,
    supportLevel: 'heavy',
    primaryColor: '#565c40',
    secondaryColor: '#4b5037',
  };
}

export function terrainEdgesAt(world: World, ix: number, iy: number): TerrainEdges {
  const x = Math.round(ix);
  const y = Math.round(iy);
  const selfWater = world.tileAt(x, y) === 'water';
  const z = world.zAt(x, y);
  return {
    shoreN: !selfWater && world.tileAt(x, y - 1) === 'water',
    shoreE: !selfWater && world.tileAt(x + 1, y) === 'water',
    shoreS: !selfWater && world.tileAt(x, y + 1) === 'water',
    shoreW: !selfWater && world.tileAt(x - 1, y) === 'water',
    cliffN: z > world.zAt(x, y - 1),
    cliffE: z > world.zAt(x + 1, y),
    cliffS: z > world.zAt(x, y + 1),
    cliffW: z > world.zAt(x - 1, y),
  };
}

export function terrainStepCost(world: World, fx: number, fy: number, tx: number, ty: number): number {
  const baseDist = fx !== tx && fy !== ty ? Math.SQRT2 : 1;
  const meta = terrainMetaAt(world, tx, ty);
  if (!meta.passable || meta.solidMountain || meta.moveSpeedMul <= 0) return Infinity;
  const dz = Math.max(0, meta.z - world.zAt(fx, fy));
  const slopeMul = 1 + dz * 0.45;
  return (baseDist / meta.moveSpeedMul) * slopeMul;
}

export function tacticalCoverAt(world: World, ix: number, iy: number): number {
  const x = Math.round(ix);
  const y = Math.round(iy);
  let best = terrainMetaAt(world, x, y).coverPct;
  const dirs = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dx, dy] of dirs) {
    const b = world.buildingAt(x + dx, y + dy);
    if (b) {
      const tags = world.tuning.buildings[b.defId]?.tags ?? [];
      if (tags.includes('wall')) best = Math.max(best, 0.75);
      else if (tags.includes('tower') || tags.includes('turret')) best = Math.max(best, 0.55);
      else if (!world.tuning.buildings[b.defId]?.passable) best = Math.max(best, 0.4);
    }
    if (dx !== 0 || dy !== 0) {
      if (world.treeBlockAt(x + dx, y + dy)) best = Math.max(best, 0.35);
    }
  }
  return Math.min(0.85, best);
}

export function evaluateMultiTileTerrain(
  world: World,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: {
    requireSupport?: TerrainSupportLevel;
    minFertility?: number;
    maxElevDiff?: number;
    allowOnSlope?: boolean;
  } = {},
): MultiTileTerrainCheck {
  const minFertility = opts.minFertility ?? 0;
  const maxElevDiff = opts.maxElevDiff ?? (w > 1 || h > 1 ? 0 : 1);
  const reqSupport = opts.requireSupport ?? (w * h >= 4 ? 'medium' : 'light');
  const supportRank: Record<TerrainSupportLevel, number> = {
    none: 0,
    light: 1,
    medium: 2,
    heavy: 3,
  };

  let sumFert = 0;
  let sumSpeed = 0;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let firstError: string | undefined;
  const cellReasons: MultiTileTerrainCheck['cellReasons'] = [];

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const cx = Math.round(x + dx);
      const cy = Math.round(y + dy);
      const meta = terrainMetaAt(world, cx, cy);
      sumFert += meta.fertility;
      sumSpeed += meta.moveSpeedMul;
      if (meta.z < minZ) minZ = meta.z;
      if (meta.z > maxZ) maxZ = meta.z;

      let cellOk = true;
      let cellReason: string | undefined;

      if (minFertility > 0 && meta.fertility < minFertility) {
        cellOk = false;
        cellReason = `${meta.shortName}肥力不足 (${Math.round(meta.fertility * 100)}% < ${Math.round(minFertility * 100)}%)`;
      } else if (meta.solidMountain) {
        cellOk = false;
        cellReason = '实心花岗岩山体不可穿越或直接建造';
      } else if (!opts.allowOnSlope && meta.hasSlope) {
        cellOk = false;
        cellReason = '斜坡占据的位置不能有其他建筑';
      } else if (!meta.passable || !world.standableTile(cx, cy)) {
        cellOk = false;
        cellReason = `${meta.shortName}不可通行`;
      } else if (world.treeBlockAt(cx, cy)) {
        cellOk = false;
        cellReason = '被 2×2 乔木树冠阻挡（需先砍伐）';
      } else if (supportRank[meta.supportLevel] < supportRank[reqSupport]) {
        cellOk = false;
        cellReason = `${meta.shortName}地基松软，无法承载该建筑`;
      }

      if (!cellOk && !firstError) firstError = `(${cx},${cy}) ${cellReason}`;
      cellReasons.push({ x: cx, y: cy, ok: cellOk, terrain: meta, reason: cellReason });
    }
  }

  const count = Math.max(1, w * h);
  const elevDiff = maxZ >= minZ ? maxZ - minZ : 0;
  if (elevDiff > maxElevDiff) {
    const elevMsg = `多格地基高差过大 (z=${minZ}..${maxZ}，需平整地形)`;
    if (!firstError) firstError = elevMsg;
    for (const c of cellReasons) {
      if (c.terrain.z !== minZ) {
        c.ok = false;
        c.reason = c.reason ?? elevMsg;
      }
    }
  }

  return {
    ok: firstError === undefined,
    avgFertility: sumFert / count,
    avgMoveSpeed: sumSpeed / count,
    minZ: Number.isFinite(minZ) ? minZ : 0,
    maxZ: Number.isFinite(maxZ) ? maxZ : 0,
    elevDiff,
    reason: firstError,
    cellReasons,
  };
}
