/**
 * rimworld-ecology-butcher.ts —— RimWorld 生态与单格唯一对象系统：
 *  1. 生成顺序与替代规则（单格唯一建筑/实体/可选中对象：地形 -> 建筑/遗迹 -> 矿物 -> 植物(树1×1) -> 实体）；
 *  2. 小动物视野外生成（强制在玩家战争迷雾视野与摄像机视口之外生成野生动物，随后自然漫步入场）；
 *  3. 植物蔓延机制（成熟乔木与浆果丛按土壤肥力与局部密度上限向邻近空置肥沃地块自然繁衍蔓延，乔木占地 1×1）；
 *  4. 生物死亡生成尸体 + 拖回屠宰台屠宰分解（猎杀/击毙动物不再凭空刷肉入库，而是留下动物尸体，由小人拖回屠宰台/营火屠宰产出肉与毛皮）。
 */
import { ensurePawnAnatomy } from './anatomy-health';
import { getColonistGroups, refreshGroupCarryMetrics } from './mmo-groups-ruins';
import { getRuinSites, hasRuinSitesInitialized } from './mmo-ruins';
import { depleteMineralAt, getNpcBases, mineralAt } from './npc-bases';
import { getPlayerFogSources, isTileVisibleToPlayer } from './power-fog-engine';
import { hasSlopeAt, isSolidMountainAt } from './rooms-power-fog';
import { getOutdoorGroundItems, getPackBeastMap, isStrangerPawn } from './social-trade-weathering';
import { terrainMetaAt } from './terrain';
import type { BuildingState, Eid, Hostile, PawnState, Pos } from './types';
import type { Sim } from './sim';
export type SelectableObjectKind =
  | 'pawn'
  | 'hostile'
  | 'corpse'
  | 'pack_beast'
  | 'outdoor_item'
  | 'building'
  | 'plant'
  | 'mineral'
  | 'ruin'
  | 'npc_base';
export interface SelectableTileHit {
  kind: SelectableObjectKind;
  x: number;
  y: number;
  id: string | number;
  label: string;
}
export interface CameraViewportRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface ButcherCorpseOutcome {
  ok: boolean;
  message: string;
  corpseEid: Eid;
  butcherBuildingId?: string;
  hauledFrom?: Pos;
  butcheredAt?: Pos;
  gained: Record<string, number>;
}
const simCameraViewport = new WeakMap<Sim, CameraViewportRect | null>();
let nextAnimalCorpseEid = 30000;
export const PLANT_SPREAD_INTERVAL_SEC = 10;
export const ANIMAL_BUTCHER_SPECS: Record<
  string,
  { label: string; yields: Record<string, number>; workSec: number }
> = {
  rabbit: { label: '野兔尸体 (Rabbit Corpse)', yields: { meat: 2, poultry_egg: 1, leather: 1 }, workSec: 3.5 },
  deer: { label: '野鹿尸体 (Deer Corpse)', yields: { meat: 4, prime_cut: 2, leather: 2, herb: 1 }, workSec: 5.0 },
  cat: { label: '野猫尸体 (Cat Corpse)', yields: { meat: 3, prime_cut: 1, leather: 2 }, workSec: 4.0 },
};
export function setSimCameraViewport(sim: Sim, rect: CameraViewportRect | null): void {
  simCameraViewport.set(sim, rect);
}
export function getSimCameraViewport(sim: Sim): CameraViewportRect | null {
  return simCameraViewport.get(sim) ?? null;
}
/** 判定坐标 (ix, iy) 是否已经被任何建筑、实体或可选中对象占用（单格唯一性） */
export function isTileOccupiedBySelectable(
  sim: Sim,
  ix: number,
  iy: number,
  opts: {
    ignorePawnEid?: Eid;
    ignoreHostileId?: number;
    ignoreCorpseEid?: Eid;
    ignorePackBeastId?: string;
    ignoreDropId?: string;
    ignorePlants?: boolean;
    ignorePassableBuildings?: boolean;
  } = {},
): boolean {
  const x = Math.round(ix);
  const y = Math.round(iy);
  const bld = sim.world.buildingAt(x, y);
  if (bld) {
    if (!opts.ignorePassableBuildings || !sim.tuning.buildings[bld.defId]?.passable) return true;
  }
  for (const p of sim.pawnMap.values()) {
    if (opts.ignorePawnEid !== undefined && p.eid === opts.ignorePawnEid) continue;
    if (Math.round(p.pos.x) === x && Math.round(p.pos.y) === y) return true;
  }
  for (const h of sim.hostilesList) {
    if (opts.ignoreHostileId !== undefined && h.id === opts.ignoreHostileId) continue;
    if (Math.round(h.pos.x) === x && Math.round(h.pos.y) === y) return true;
  }
  for (const c of sim.deadPawnMap.values()) {
    if (opts.ignoreCorpseEid !== undefined && c.eid === opts.ignoreCorpseEid) continue;
    if (c.hauledByEid !== undefined) continue;
    if (Math.round(c.pos.x) === x && Math.round(c.pos.y) === y) return true;
  }
  for (const beast of getPackBeastMap(sim).values()) {
    if (opts.ignorePackBeastId !== undefined && beast.id === opts.ignorePackBeastId) continue;
    if (Math.round(beast.pos.x) === x && Math.round(beast.pos.y) === y) return true;
  }
  for (const drop of getOutdoorGroundItems(sim).values()) {
    if (opts.ignoreDropId !== undefined && drop.id === opts.ignoreDropId) continue;
    if (Math.round(drop.pos.x) === x && Math.round(drop.pos.y) === y) return true;
  }
  if (!opts.ignorePlants) {
    if (sim.world.featureAt(x, y) !== null || sim.world.treeBlockAt(x, y)) return true;
    if (mineralAt(sim.world, x, y) !== null) return true;
  }
  return false;
}
/** 查询坐标 (ix, iy) 处唯一的可选中对象 */
export function getSelectableObjectAt(sim: Sim, ix: number, iy: number): SelectableTileHit | null {
  const x = Math.round(ix);
  const y = Math.round(iy);
  for (const p of sim.pawnMap.values()) {
    if (Math.round(p.pos.x) === x && Math.round(p.pos.y) === y) {
      return { kind: 'pawn', x, y, id: p.eid, label: p.name };
    }
  }
  for (const h of sim.hostilesList) {
    if (Math.round(h.pos.x) === x && Math.round(h.pos.y) === y) {
      const def = sim.tuning.enemies[h.kind];
      return { kind: 'hostile', x, y, id: h.id, label: def?.name ?? h.kind };
    }
  }
  for (const c of sim.deadPawnMap.values()) {
    if (Math.round(c.pos.x) === x && Math.round(c.pos.y) === y) {
      return { kind: 'corpse', x, y, id: c.eid, label: c.name };
    }
  }
  for (const beast of getPackBeastMap(sim).values()) {
    if (Math.round(beast.pos.x) === x && Math.round(beast.pos.y) === y) {
      return { kind: 'pack_beast', x, y, id: beast.id, label: beast.name };
    }
  }
  for (const drop of getOutdoorGroundItems(sim).values()) {
    if (Math.round(drop.pos.x) === x && Math.round(drop.pos.y) === y) {
      return { kind: 'outdoor_item', x, y, id: drop.id, label: `${drop.item}×${drop.amount}` };
    }
  }
  const bld = sim.world.buildingAt(x, y);
  if (bld) {
    const def = sim.tuning.buildings[bld.defId];
    return { kind: 'building', x, y, id: bld.id, label: def?.name ?? bld.defId };
  }
  const feat = sim.world.featureAt(x, y);
  if (feat) {
    return { kind: 'plant', x, y, id: `${feat.x},${feat.y}`, label: feat.kind === 'tree' ? '乔木 (1×1)' : '浆果丛' };
  }
  const min = mineralAt(sim.world, x, y);
  if (min) {
    return { kind: 'mineral', x, y, id: `${min.x},${min.y}`, label: min.name };
  }
  if (hasRuinSitesInitialized(sim)) {
    for (const ruin of getRuinSites(sim).values()) {
      if (x >= ruin.pos.x && x < ruin.pos.x + ruin.w && y >= ruin.pos.y && y < ruin.pos.y + ruin.h) {
        return { kind: 'ruin', x, y, id: ruin.id, label: ruin.name };
      }
    }
  }
  for (const base of getNpcBases(sim).values()) {
    if (Math.abs(base.pos.x - x) <= 2 && Math.abs(base.pos.y - y) <= 2) {
      return { kind: 'npc_base', x, y, id: base.id, label: base.name };
    }
  }
  return null;
}
/** 螺旋查找距离 (targetX, targetY) 最近的无冲突单格可通行位置 */
export function findNearestUnoccupiedTile(
  sim: Sim,
  targetX: number,
  targetY: number,
  opts: {
    maxRadius?: number;
    ignorePawnEid?: Eid;
    ignoreHostileId?: number;
    ignoreCorpseEid?: Eid;
    ignorePackBeastId?: string;
    ignoreDropId?: string;
    replaceSurfacePlant?: boolean;
  } = {},
): Pos {
  const ox = Math.round(targetX);
  const oy = Math.round(targetY);
  const maxR = opts.maxRadius ?? 12;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cx = ox + dx;
        const cy = oy + dy;
        if (isSolidMountainAt(sim.world, cx, cy)) continue;
        if (!sim.world.standableTile(cx, cy)) continue;
        if (sim.world.treeBlockAt(cx, cy)) continue;
        const occupied = isTileOccupiedBySelectable(sim, cx, cy, {
          ...opts,
          ignorePlants: Boolean(opts.replaceSurfacePlant),
        });
        if (!occupied) {
          if (opts.replaceSurfacePlant) {
            sim.world.clearFeatureAt(cx, cy);
            depleteMineralAt(sim.world, cx, cy);
          }
          return { x: cx, y: cy };
        }
      }
    }
  }
  return { x: ox, y: oy };
}
/** 建筑放置时清理覆盖格内的自然植物与地表矿物，并将处于覆盖格内的实体推挤到邻近空置单格 */
export function clearAndDisplaceOnBuildingFootprint(
  sim: Sim,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  sim.world.clearFeaturesInRect(x, y, x + w - 1, y + h - 1);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      depleteMineralAt(sim.world, x + dx, y + dy);
    }
  }
  const inFootprint = (px: number, py: number) => {
    const rx = Math.round(px);
    const ry = Math.round(py);
    return rx >= x && rx < x + w && ry >= y && ry < y + h;
  };
  for (const c of sim.deadPawnMap.values()) {
    if (inFootprint(c.pos.x, c.pos.y)) {
      c.pos = findNearestUnoccupiedTile(sim, c.pos.x, c.pos.y, { ignoreCorpseEid: c.eid, replaceSurfacePlant: true });
    }
  }
  for (const drop of getOutdoorGroundItems(sim).values()) {
    if (inFootprint(drop.pos.x, drop.pos.y)) {
      drop.pos = findNearestUnoccupiedTile(sim, drop.pos.x, drop.pos.y, { ignoreDropId: drop.id, replaceSurfacePlant: true });
    }
  }
  for (const beast of getPackBeastMap(sim).values()) {
    if (inFootprint(beast.pos.x, beast.pos.y)) {
      beast.pos = findNearestUnoccupiedTile(sim, beast.pos.x, beast.pos.y, { ignorePackBeastId: beast.id, replaceSurfacePlant: true });
    }
  }
  for (const p of sim.pawnMap.values()) {
    if (inFootprint(p.pos.x, p.pos.y)) {
      const free = findNearestUnoccupiedTile(sim, p.pos.x, p.pos.y, { ignorePawnEid: p.eid, replaceSurfacePlant: true });
      p.pos.x = free.x;
      p.pos.y = free.y;
    }
  }
}
/** 全局单格唯一性校准（生成顺序：地形/斜坡 -> 建筑/遗迹/据点 -> 矿物 -> 植物 -> 可选中实体） */
export function enforceSingleTileOccupancy(sim: Sim): { resolvedConflicts: number } {
  sim.world.rimWorldSingleOccupancy = true;
  let resolvedConflicts = 0;
  for (const b of sim.world.buildings.values()) {
    const { w, h } = sim.world.footprintOf(b);
    resolvedConflicts += sim.world.clearFeaturesInRect(b.pos.x, b.pos.y, b.pos.x + w - 1, b.pos.y + h - 1);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        depleteMineralAt(sim.world, b.pos.x + dx, b.pos.y + dy);
      }
    }
  }
  const taken = new Set<string>();
  for (const b of sim.world.buildings.values()) {
    const { w, h } = sim.world.footprintOf(b);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        taken.add(`${Math.round(b.pos.x + dx)},${Math.round(b.pos.y + dy)}`);
      }
    }
  }
  const placeUnique = (pos: Pos): Pos => {
    const ox = Math.round(pos.x);
    const oy = Math.round(pos.y);
    for (let r = 0; r <= 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const cx = ox + dx;
          const cy = oy + dy;
          const k = `${cx},${cy}`;
          if (taken.has(k)) continue;
          if (isSolidMountainAt(sim.world, cx, cy) || !sim.world.standableTile(cx, cy)) continue;
          if (sim.world.treeBlockAt(cx, cy)) continue;
          sim.world.clearFeatureAt(cx, cy);
          depleteMineralAt(sim.world, cx, cy);
          taken.add(k);
          if (cx !== ox || cy !== oy) resolvedConflicts++;
          return { x: cx, y: cy };
        }
      }
    }
    taken.add(`${ox},${oy}`);
    return { x: ox, y: oy };
  };
  for (const p of sim.pawnMap.values()) {
    const np = placeUnique(p.pos);
    p.pos.x = np.x;
    p.pos.y = np.y;
  }
  for (const h of sim.hostilesList) {
    const np = placeUnique(h.pos);
    h.pos.x = np.x;
    h.pos.y = np.y;
  }
  for (const c of sim.deadPawnMap.values()) {
    if (c.hauledByEid !== undefined) continue;
    const np = placeUnique(c.pos);
    c.pos.x = np.x;
    c.pos.y = np.y;
  }
  for (const beast of getPackBeastMap(sim).values()) {
    const np = placeUnique(beast.pos);
    beast.pos.x = np.x;
    beast.pos.y = np.y;
  }
  for (const drop of getOutdoorGroundItems(sim).values()) {
    const np = placeUnique(drop.pos);
    drop.pos.x = np.x;
    drop.pos.y = np.y;
  }
  return { resolvedConflicts };
}
/** 判定坐标 (ix, iy) 是否处于玩家视野与摄像机视口之外 */
export function isOutsidePlayerFieldOfView(sim: Sim, ix: number, iy: number): boolean {
  const x = Math.round(ix);
  const y = Math.round(iy);
  const camRect = getSimCameraViewport(sim);
  if (camRect) {
    if (x >= camRect.x0 - 1 && x <= camRect.x1 + 1 && y >= camRect.y0 - 1 && y <= camRect.y1 + 1) {
      return false;
    }
  }
  if (isTileVisibleToPlayer(sim, sim.activePlayerId, x, y)) {
    return false;
  }
  return true;
}
/** 在玩家视野外（战争迷雾外 + 摄像机视口外）生成一只野生小动物（野兔 rabbit 或 野鹿 deer） */
export function spawnWildAnimalOutsideView(
  sim: Sim,
  preferredKind?: 'rabbit' | 'deer',
): Hostile | null {
  const camp = sim.campPos() ?? sim.world.spawn;
  const sources = getPlayerFogSources(sim, sim.activePlayerId);
  let maxVisionR = 28;
  for (const src of sources) {
    const d = Math.hypot(src.x - camp.x, src.y - camp.y) + src.radius;
    if (d > maxVisionR) maxVisionR = d;
  }
  const camRect = getSimCameraViewport(sim);
  if (camRect) {
    const camR = Math.max(
      Math.hypot(camRect.x0 - camp.x, camRect.y0 - camp.y),
      Math.hypot(camRect.x1 - camp.x, camRect.y1 - camp.y),
    );
    if (camR > maxVisionR) maxVisionR = camR;
  }
  const baseAngle = sim.rng() * Math.PI * 2;
  const kinds: ('rabbit' | 'deer')[] = ['rabbit', 'deer'];
  const chosenKind =
    preferredKind ??
    (sim.tuning.enemies['rabbit'] && sim.tuning.enemies['deer']
      ? kinds[Math.floor(sim.rng() * kinds.length)]
      : sim.tuning.enemies['rabbit']
        ? 'rabbit'
        : 'deer');
  if (!sim.tuning.enemies[chosenKind]) return null;
  for (let attempt = 0; attempt < 24; attempt++) {
    const ang = baseAngle + (attempt * Math.PI * 2) / 12;
    const dist = maxVisionR + 3 + (attempt % 6) * 2;
    const cx = Math.round(camp.x + Math.cos(ang) * dist);
    const cy = Math.round(camp.y + Math.sin(ang) * dist);
    for (let r = 0; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const sx = cx + dx;
          const sy = cy + dy;
          if (!isOutsidePlayerFieldOfView(sim, sx, sy)) continue;
          if (!sim.passable(sx, sy)) continue;
          if (isTileOccupiedBySelectable(sim, sx, sy)) continue;
          return sim.spawnHostile(chosenKind, sx, sy);
        }
      }
    }
  }
  return null;
}
/** 植物蔓延机制：扫描中心点半径内的成熟植物（tree / berry），向邻近肥沃且未占用的 1×1 地块自然繁衍新植株 */
export function spreadPlantsStep(
  sim: Sim,
  opts: { center?: Pos; radius?: number; maxNewPlants?: number } = {},
): { spreadCount: number; newPlants: { x: number; y: number; kind: 'tree' | 'berry' }[] } {
  const center = opts.center ?? sim.campPos() ?? sim.world.spawn;
  const radius = opts.radius ?? 26;
  const maxNew = opts.maxNewPlants ?? 3;
  const newPlants: { x: number; y: number; kind: 'tree' | 'berry' }[] = [];
  const cx0 = Math.round(center.x);
  const cy0 = Math.round(center.y);
  const parents: { x: number; y: number; kind: 'tree' | 'berry' }[] = [];
  for (let y = cy0 - radius; y <= cy0 + radius; y += 2) {
    for (let x = cx0 - radius; x <= cx0 + radius; x += 2) {
      const f = sim.world.featureAt(x, y);
      if (f && f.amount >= 2) {
        parents.push({ x: f.x, y: f.y, kind: f.kind });
      }
    }
  }
  if (parents.length === 0) {
    parents.push({ x: cx0 + 7, y: cy0 + 2, kind: 'berry' });
  }
  const offsets = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [2, 1],
    [-2, -1],
    [1, -2],
    [-1, 2],
    [2, 0],
    [0, 2],
  ];
  const startIdx = Math.floor(sim.time) % Math.max(1, parents.length);
  for (let i = 0; i < parents.length && newPlants.length < maxNew; i++) {
    const parent = parents[(startIdx + i) % parents.length];
    for (const [dx, dy] of offsets) {
      if (newPlants.length >= maxNew) break;
      const nx = parent.x + dx;
      const ny = parent.y + dy;
      if (Math.abs(nx - sim.world.spawn.x) <= 3 && Math.abs(ny - sim.world.spawn.y) <= 3) continue;
      if (isSolidMountainAt(sim.world, nx, ny) || hasSlopeAt(sim.world, nx, ny)) continue;
      const meta = terrainMetaAt(sim.world, nx, ny);
      if (!meta.passable || meta.fertility < 0.5) continue;
      if (isTileOccupiedBySelectable(sim, nx, ny)) continue;
      let nearPlants = 0;
      for (let py = ny - 2; py <= ny + 2; py++) {
        for (let px = nx - 2; px <= nx + 2; px++) {
          if (sim.world.featureAt(px, py)) nearPlants++;
        }
      }
      if (nearPlants >= 3) continue;
      const spreadKind: 'tree' | 'berry' =
        parent.kind === 'tree' && sim.world.mod2(nx) === 0 && sim.world.mod2(ny) === 0 ? 'tree' : 'berry';
      if (sim.world.addSpreadPlant(nx, ny, spreadKind)) {
        newPlants.push({ x: nx, y: ny, kind: spreadKind });
        break;
      }
    }
  }
  if (newPlants.length > 0) {
    sim.log(`🌱【植物蔓延】自然植被向周围肥沃土壤繁衍了 ${newPlants.length} 株新植物`);
  }
  return { spreadCount: newPlants.length, newPlants };
}
export function tickPlantSpread(sim: Sim, dt: number): void {
  if (!sim.playerRimWorldMode) return;
  let acc = (sim.scratch['ecology.plantSpreadAcc'] ?? 0) + dt;
  if (acc < PLANT_SPREAD_INTERVAL_SEC) {
    sim.scratch['ecology.plantSpreadAcc'] = acc;
    return;
  }
  acc -= PLANT_SPREAD_INTERVAL_SEC;
  sim.scratch['ecology.plantSpreadAcc'] = acc;
  spreadPlantsStep(sim, { maxNewPlants: 1 });
}
/** 生物（野兔/野鹿/野猫等）死亡时在死亡格生成对应的生物尸体 */
export function spawnCreatureCorpse(
  sim: Sim,
  hostileOrKind: Hostile | string,
  xRaw?: number,
  yRaw?: number,
): PawnState {
  const kind = typeof hostileOrKind === 'string' ? hostileOrKind : hostileOrKind.kind;
  const rawX = typeof hostileOrKind === 'string' ? (xRaw ?? 0) : hostileOrKind.pos.x;
  const rawY = typeof hostileOrKind === 'string' ? (yRaw ?? 0) : hostileOrKind.pos.y;
  const hId = typeof hostileOrKind === 'string' ? undefined : hostileOrKind.id;
  const def = sim.tuning.enemies[kind];
  const spec = ANIMAL_BUTCHER_SPECS[kind];
  const defaultYields: Record<string, number> = spec
    ? { ...spec.yields }
    : {
        meat: Math.max(2, def?.drops?.['meat'] ?? 2),
        leather: 1,
        ...(def?.drops?.['herb'] ? { herb: def.drops['herb'] } : {}),
      };
  const pos = findNearestUnoccupiedTile(sim, rawX, rawY, {
    ignoreHostileId: hId,
    replaceSurfacePlant: true,
  });
  const eid = hId !== undefined ? 30000 + hId : nextAnimalCorpseEid++;
  const corpseName = spec ? spec.label : `${def?.name ?? kind}尸体 (#${hId ?? eid - 30000})`;
  const corpse: PawnState = {
    eid,
    name: corpseName,
    pos,
    needs: { food: 0, rest: 0, mood: 0, san: 0 },
    hp: 0,
    maxHp: def?.hp ?? 20,
    climb: 1,
    trait: 'tough',
    cardId: null,
    busyUntil: 0,
    holdUntil: 0,
    atkCd: 0,
    path: [],
    mastery: {},
    uses: {},
    isAnimalCorpse: true,
    animalKind: kind,
    corpseButchered: false,
    butcherYield: defaultYields,
    inventory: { ...defaultYields },
    retainedOnCorpse: true,
    corpseLooted: false,
    corpseOrgansHarvested: false,
    causeOfDeath: '狩猎/交战击毙',
    deathTime: sim.time,
    isRaiderCorpse: false,
  };
  ensurePawnAnatomy(corpse);
  sim.deadPawnMap.set(eid, corpse);
  return corpse;
}
/** 查找殖民地最近的屠宰点（优先 2×1 屠宰台 butcher_table -> 其次 stove -> campfire -> great_bonfire -> 营地中心） */
export function findNearestButcherSpot(
  sim: Sim,
  fromPos: Pos,
): { pos: Pos; building?: BuildingState; stationName: string } {
  const priorityOrder = ['butcher_table', 'stove', 'campfire', 'great_bonfire', 'store', 'shelf'];
  for (const wantedDef of priorityOrder) {
    let bestB: BuildingState | undefined;
    let bestD = Infinity;
    for (const b of sim.world.buildings.values()) {
      if (b.isBlueprint || b.defId !== wantedDef) continue;
      const d = Math.hypot(b.pos.x - fromPos.x, b.pos.y - fromPos.y);
      if (d < bestD) {
        bestD = d;
        bestB = b;
      }
    }
    if (bestB) {
      const adj = sim.world.nearestBuildingAdjacent(bestB, fromPos.x, fromPos.y) ?? {
        x: bestB.pos.x,
        y: bestB.pos.y,
      };
      const bName = sim.tuning.buildings[bestB.defId]?.name ?? bestB.defId;
      return { pos: adj, building: bestB, stationName: bName };
    }
  }
  const camp = sim.campPos() ?? sim.world.spawn;
  return { pos: { x: Math.round(camp.x), y: Math.round(camp.y) }, stationName: '营地临时屠宰点' };
}
/** 将尸体拖回屠宰台/屠宰点并执行屠宰分解 */
export function haulAndButcherCorpse(
  sim: Sim,
  corpseEid: Eid,
  actorEid?: Eid,
): ButcherCorpseOutcome {
  const corpse = sim.deadPawnMap.get(corpseEid);
  if (!corpse) {
    return { ok: false, message: `未找到编号 #${corpseEid} 的尸体`, corpseEid, gained: {} };
  }
  const actor =
    (actorEid !== undefined ? sim.pawn(actorEid) : undefined) ??
    [...sim.pawns()].find((p) => !isStrangerPawn(p, sim.activePlayerId));
  const hauledFrom: Pos = { x: corpse.pos.x, y: corpse.pos.y };
  const spot = findNearestButcherSpot(sim, hauledFrom);
  const butcheredAt = findNearestUnoccupiedTile(sim, spot.pos.x, spot.pos.y, {
    ignoreCorpseEid: corpse.eid,
    ignorePawnEid: actor?.eid,
    replaceSurfacePlant: true,
  });
  corpse.pos = { x: butcheredAt.x, y: butcheredAt.y };
  if (actor) {
    actor.pos = { x: butcheredAt.x, y: butcheredAt.y };
    actor.path = [];
    actor.haulingCorpseEid = undefined;
    actor.activeWork = {
      kind: 'butcher',
      label: `屠宰分解 ${corpse.name}`,
      targetPos: { x: butcheredAt.x, y: butcheredAt.y },
      targetId: corpse.eid,
      workTotal: 20,
      workProgress: 20,
      workContinuousSec: 0,
    };
  }
  const baseYield = corpse.butcherYield ?? {
    meat: corpse.isAnimalCorpse ? 3 : 2,
    leather: corpse.isAnimalCorpse ? 2 : 1,
  };
  const cookSkill = actor?.skills?.find((s) => s.id === 'plants_cook')?.level ?? 6;
  const tableBonus = spot.building?.defId === 'butcher_table' ? 1.25 : 1.0;
  const skillMul = Math.max(0.8, (0.85 + cookSkill * 0.025) * tableBonus);
  const gained: Record<string, number> = {};
  for (const [k, v] of Object.entries(baseYield)) {
    if (v <= 0) continue;
    const amt = Math.max(1, Math.round(v * skillMul));
    gained[k] = (gained[k] ?? 0) + amt;
  }
  if (!corpse.isAnimalCorpse && !corpse.corpseLooted) {
    for (const [k, v] of Object.entries(corpse.inventory ?? {})) {
      if (v > 0 && !(k in gained)) {
        gained[k] = (gained[k] ?? 0) + v;
      }
    }
  }
  for (const [k, v] of Object.entries(gained)) {
    sim.stockpile[k] = (sim.stockpile[k] ?? 0) + v;
  }
  const groups = getColonistGroups(sim);
  const targetGroup = groups.get(actor?.groupId ?? 'group_alpha') ?? groups.get('group_alpha');
  if (targetGroup) {
    for (const [k, v] of Object.entries(gained)) {
      targetGroup.inventory[k] = (targetGroup.inventory[k] ?? 0) + v;
    }
    refreshGroupCarryMetrics(sim, targetGroup);
  }
  if (!corpse.isAnimalCorpse) {
    for (const p of sim.pawns()) {
      if (!p.isStranger) p.needs.mood = Math.max(0, p.needs.mood - 6);
    }
  }
  corpse.corpseButchered = true;
  corpse.corpseLooted = true;
  sim.deadPawnMap.delete(corpseEid);
  const yieldTxt = Object.entries(gained)
    .map(([k, v]) => `+${v} ${k}`)
    .join(', ');
  const actorName = actor ? actor.name : '殖民者';
  const msg = `🔪【拖回屠宰】${actorName} 将【${corpse.name}】从 (${hauledFrom.x},${hauledFrom.y}) 拖回【${spot.stationName}】(${butcheredAt.x},${butcheredAt.y}) 屠宰分解：获得 ${yieldTxt}！`;
  sim.log(msg);
  return {
    ok: true,
    message: msg,
    corpseEid,
    butcherBuildingId: spot.building?.id,
    hauledFrom,
    butcheredAt,
    gained,
  };
}
export const butcherCorpse = haulAndButcherCorpse;
/** 殖民者自动拖尸与屠宰推进循环 */
export function tickRimWorldButcherHaul(sim: Sim, dt: number): void {
  if (!sim.playerRimWorldMode) return;
  const animalCorpses = [...sim.deadPawnMap.values()].filter(
    (c) => c.isAnimalCorpse && !c.corpseButchered,
  );
  if (animalCorpses.length === 0) return;
  for (const corpse of animalCorpses) {
    let hauler = corpse.hauledByEid !== undefined ? sim.pawn(corpse.hauledByEid) : undefined;
    if (!hauler || hauler.drafted || hauler.isStranger) {
      corpse.hauledByEid = undefined;
      let bestPawn: PawnState | undefined;
      let bestD = Infinity;
      for (const p of sim.pawns()) {
        if (p.isStranger || p.drafted) continue;
        if (p.haulingCorpseEid !== undefined && p.haulingCorpseEid !== corpse.eid) continue;
        const cookPrio = p.workPriorities?.['cook'] ?? 3;
        const haulPrio = p.workPriorities?.['haul'] ?? 3;
        const huntPrio = p.workPriorities?.['hunt'] ?? 3;
        if (cookPrio === 0 && haulPrio === 0 && huntPrio === 0) continue;
        const d = Math.hypot(p.pos.x - corpse.pos.x, p.pos.y - corpse.pos.y);
        if (d < bestD) {
          bestD = d;
          bestPawn = p;
        }
      }
      if (!bestPawn) continue;
      hauler = bestPawn;
      corpse.hauledByEid = hauler.eid;
      hauler.haulingCorpseEid = corpse.eid;
    }
    const distToCorpse = Math.hypot(hauler.pos.x - corpse.pos.x, hauler.pos.y - corpse.pos.y);
    if (distToCorpse > 1.65) {
      if (hauler.path.length === 0) sim.setPath(hauler, corpse.pos.x, corpse.pos.y);
      continue;
    }
    const spot = findNearestButcherSpot(sim, hauler.pos);
    const distToSpot = Math.hypot(hauler.pos.x - spot.pos.x, hauler.pos.y - spot.pos.y);
    corpse.pos.x = Math.round(hauler.pos.x);
    corpse.pos.y = Math.round(hauler.pos.y);
    if (distToSpot > 1.85) {
      hauler.activeWork = {
        kind: 'haul_corpse',
        label: `拖回尸体 (${corpse.name})`,
        targetPos: { x: spot.pos.x, y: spot.pos.y },
        targetId: corpse.eid,
        workTotal: 10,
        workProgress: 5,
        workContinuousSec: 0,
      };
      if (hauler.path.length === 0) {
        if (!sim.setPath(hauler, spot.pos.x, spot.pos.y)) {
          haulAndButcherCorpse(sim, corpse.eid, hauler.eid);
        }
      }
      continue;
    }
    hauler.path = [];
    const butcherKey = `butcher.progress.${corpse.eid}`;
    const curProg = (sim.scratch[butcherKey] ?? 0) + dt;
    const spec = ANIMAL_BUTCHER_SPECS[corpse.animalKind ?? 'rabbit'];
    const totalSec = spec?.workSec ?? 3.5;
    hauler.activeWork = {
      kind: 'butcher',
      label: `屠宰分解 (${corpse.name})`,
      targetPos: { x: spot.pos.x, y: spot.pos.y },
      targetId: corpse.eid,
      workTotal: totalSec,
      workProgress: Math.min(totalSec, curProg),
      workContinuousSec: curProg,
    };
    if (curProg >= totalSec) {
      delete sim.scratch[butcherKey];
      hauler.haulingCorpseEid = undefined;
      hauler.activeWork = undefined;
      haulAndButcherCorpse(sim, corpse.eid, hauler.eid);
    } else {
      sim.scratch[butcherKey] = curProg;
    }
  }
}
