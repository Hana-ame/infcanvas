/**
 * rimworld-work.ts —— RimWorld 手动工作优先级、征召指挥 (Draft R)、多格建造规划校验、单格替代与自动施工执行。
 */
import { mineMineralAt } from './npc-bases';
import { clearAndDisplaceOnBuildingFootprint } from './rimworld-ecology-butcher';
import { inspectRoomAt } from './rooms-power-fog';
import { evaluateMultiTileTerrain, terrainMetaAt } from './terrain';
import { canBuildingReplace } from './world';
import {
  ARCHITECT_BUILDABLES,
  RIMWORLD_WORK_TYPES,
  type ArchitectBuildableDef,
  type FootprintCellStatus,
  type FootprintInspection,
  type RimWorldWorkDef,
  type RimWorldWorkType,
} from './architect-defs';
import type { BuildingState, Eid, PawnState } from './types';
import type { Sim } from './sim';

const PACK_OWNED_BUILDINGS: Record<string, string> = {
  wall: 'fortify',
  tower: 'fortify',
  trap: 'fortify',
  bed: 'medicine',
  field: 'farming',
  campfire: 'building',
  hut: 'building',
  store: 'building',
};

export function ensureRimWorldBuildingsRegistered(sim: Sim, forceAll = false): void {
  for (const b of ARCHITECT_BUILDABLES) {
    const ownerPack = PACK_OWNED_BUILDINGS[b.defId];
    if (!forceAll && ownerPack && !sim.reg.isMounted(ownerPack)) {
      continue;
    }
    if (!sim.tuning.buildings[b.defId]) {
      sim.tuning.buildings[b.defId] = {
        name: b.name,
        cost: b.cost,
        hp: b.hp,
        w: b.w,
        h: b.h,
        passable: b.passable,
        tags: b.tags,
      };
    }
  }
}

export function inspectFootprintCells(
  sim: Sim,
  defId: string,
  xRaw: number,
  yRaw: number,
  rot: 0 | 1 | 2 | 3 = 0,
  opts: { requireIndoorRoom?: boolean } = {},
): FootprintInspection {
  ensureRimWorldBuildingsRegistered(sim, true);
  const x = Math.round(xRaw);
  const y = Math.round(yRaw);
  const def = sim.tuning.buildings[defId];
  const archDef = ARCHITECT_BUILDABLES.find((b) => b.defId === defId);
  const baseW = archDef?.w ?? sim.tuning.buildings[defId]?.w ?? 1;
  const baseH = archDef?.h ?? sim.tuning.buildings[defId]?.h ?? 1;
  const w = rot === 1 || rot === 3 ? baseH : baseW;
  const h = rot === 1 || rot === 3 ? baseW : baseH;

  if (!def) {
    return {
      defId,
      x,
      y,
      w,
      h,
      rot,
      valid: false,
      canAfford: false,
      avgFertility: 0,
      elevDiff: 0,
      cells: [],
      reason: `未知建筑类型：${defId}`,
    };
  }

  let canAfford = true;
  let missingRes = '';
  for (const [resKey, amt] of Object.entries(def.cost)) {
    const have = sim.stockpile[resKey] ?? 0;
    if (have < amt) {
      canAfford = false;
      missingRes = `材料不足：需 ${amt} ${resKey}（当前 ${have}）`;
      break;
    }
  }

  const minFertility = archDef?.minFertility ?? (defId === 'field' ? 0.5 : 0);
  const isLinearStructure = defId === 'wall' || defId === 'door' || defId === 'power_conduit' || defId === 'trap';
  const maxElevDiff = defId === 'slope' || isLinearStructure ? 3 : w >= 5 || h >= 5 ? 1 : w > 1 || h > 1 ? 0 : 1;
  const terrainCheck = evaluateMultiTileTerrain(sim.world, x, y, w, h, {
    minFertility,
    maxElevDiff,
    requireSupport: w * h >= 4 && !def.passable ? 'medium' : 'light',
    allowOnSlope: defId === 'slope',
  });

  const cells: FootprintCellStatus[] = [];
  let firstCellError = terrainCheck.reason;

  for (const c of terrainCheck.cellReasons) {
    const existing = sim.world.buildingAt(c.x, c.y);
    let valid = c.ok;
    let reason = c.reason;
    if (existing) {
      if (canBuildingReplace(defId, existing)) {
        valid = c.ok;
      } else {
        valid = false;
        const exName = existing.customName ?? sim.tuning.buildings[existing.defId]?.name ?? existing.defId;
        reason = existing.defId === 'slope' ? '斜坡占据的位置不能有其他建筑' : `已被【${exName}】占用`;
        if (!firstCellError) firstCellError = `(${c.x},${c.y}) ${reason}`;
      }
    }
    if (valid && archDef?.exteriorOnly) {
      const rm = inspectRoomAt(sim.world, c.x, c.y);
      if (rm.indoors || rm.roofed) {
        valid = false;
        reason = `外部设施【${archDef.name}】不能放置在室内 (${rm.label})`;
        if (!firstCellError) firstCellError = `(${c.x},${c.y}) ${reason}`;
      }
    }
    if (valid && opts.requireIndoorRoom && archDef?.interiorOnly) {
      const rm = inspectRoomAt(sim.world, c.x, c.y);
      if (!rm.indoors || !rm.roofed) {
        valid = false;
        reason = `室内内设/装饰/工作台【${archDef.name}】只能布置在已封顶的封闭房间内（当前为${rm.label}）`;
        if (!firstCellError) firstCellError = `(${c.x},${c.y}) ${reason}`;
      }
    }
    cells.push({
      x: c.x,
      y: c.y,
      valid,
      terrain: c.terrain,
      reason,
    });
  }

  const allCellsValid = cells.every((c) => c.valid);
  const valid = allCellsValid && canAfford;
  const reason = !allCellsValid ? firstCellError : !canAfford ? missingRes : undefined;

  return {
    defId,
    x,
    y,
    w,
    h,
    rot,
    valid,
    canAfford,
    avgFertility: terrainCheck.avgFertility,
    elevDiff: terrainCheck.elevDiff,
    cells,
    reason,
  };
}

export function setPawnWorkPriority(
  sim: Sim,
  eid: Eid,
  workId: RimWorldWorkType,
  priority: 0 | 1 | 2 | 3 | 4,
): boolean {
  const p = sim.pawn(eid);
  if (!p) return false;
  if (!p.workPriorities) p.workPriorities = {};
  p.workPriorities[workId] = priority;
  return true;
}

export function setPawnDrafted(sim: Sim, eids: Eid[], drafted: boolean): number {
  let count = 0;
  for (const eid of eids) {
    const p = sim.pawn(eid);
    if (!p) continue;
    p.drafted = drafted;
    if (drafted) {
      p.cardId = null;
      p.busyUntil = sim.time + 3600;
      p.holdUntil = sim.time + 3600;
      p.path = [];
    } else {
      p.busyUntil = sim.time;
      p.holdUntil = sim.time;
    }
    count++;
  }
  if (count > 0) {
    sim.log(drafted ? `⚔ 已征召 ${count} 名殖民者进入战斗待命状态 (R)` : `🕊 已解除 ${count} 名殖民者的征召状态`);
  }
  return count;
}

export function orderPawnAttackHostile(sim: Sim, eids: Eid[], hostileId: number): boolean {
  const target = sim.hostiles().find((h) => h.id === hostileId);
  if (!target) return false;
  let ordered = 0;
  for (const eid of eids) {
    const p = sim.pawn(eid);
    if (!p) continue;
    p.drafted = true;
    const d = Math.hypot(target.pos.x - p.pos.x, target.pos.y - p.pos.y);
    const shootSkill = p.skills?.find((s) => s.id === 'combat_shoot')?.level ?? 5;
    const range = 3.5 + shootSkill * 0.15;
    if (d <= range) {
      const dmg = Math.round(8 + shootSkill * 0.6);
      sim.damageHostile(target.id, dmg);
      p.atkCd = 1.0;
    } else {
      sim.setPath(p, Math.round(target.pos.x), Math.round(target.pos.y));
    }
    ordered++;
  }
  if (ordered > 0) {
    sim.log(`🎯 ${ordered} 名殖民者集火攻击敌目标 #${hostileId}`);
    return true;
  }
  return false;
}

export function placeArchitectBuilding(
  sim: Sim,
  defId: string,
  xRaw: number,
  yRaw: number,
  rot: 0 | 1 | 2 | 3 = 0,
  ownerPlayerId = 'p_local_1',
): { ok: boolean; building?: BuildingState; message: string } {
  ensureRimWorldBuildingsRegistered(sim, true);
  const x = Math.round(xRaw);
  const y = Math.round(yRaw);
  const def = sim.tuning.buildings[defId];
  if (!def) return { ok: false, message: `未知建筑类型：${defId}` };

  for (const [resKey, amt] of Object.entries(def.cost)) {
    const have = sim.stockpile[resKey] ?? 0;
    if (have < amt) {
      return { ok: false, message: `建造 ${def.name} 材料不足：需 ${amt} ${resKey}（当前 ${have}）` };
    }
  }

  let check = inspectFootprintCells(sim, defId, x, y, rot);
  const hitUnreplaceableBuilding = check.cells.some((c) => {
    const ex = sim.world.buildingAt(c.x, c.y);
    return ex !== undefined && !canBuildingReplace(defId, ex);
  });

  if (!check.valid && !hitUnreplaceableBuilding) {
    const onlyBlockedByTree = check.cells.every(
      (c) => c.valid || (c.reason && c.reason.includes('乔木')),
    );
    if (onlyBlockedByTree) {
      sim.world.clearFeaturesInRect(x, y, x + check.w - 1, y + check.h - 1);
      check = inspectFootprintCells(sim, defId, x, y, rot);
    }
  }

  let built: BuildingState | null = null;
  if (check.valid) {
    built = sim.world.addArchitectBuilding(defId, x, y, {
      rot,
      w: check.w,
      h: check.h,
      allowContiguous: true,
      allowReplace: true,
    });
  }

  if (!built && defId !== 'field' && !hitUnreplaceableBuilding) {
    outer: for (let r = 1; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const subCheck = inspectFootprintCells(sim, defId, x + dx, y + dy, rot);
          if (subCheck.valid) {
            built = sim.world.addArchitectBuilding(defId, x + dx, y + dy, {
              rot,
              w: subCheck.w,
              h: subCheck.h,
              allowContiguous: true,
              allowReplace: true,
            });
            if (built) break outer;
          }
        }
      }
    }
  }

  if (!built) {
    return {
      ok: false,
      message: check.reason ?? `(${x},${y}) 多格地形受阻或已被占用，无法建造 ${def.name}`,
    };
  }

  built.ownerPlayerId = ownerPlayerId;
  const { w, h } = sim.world.footprintOf(built);
  clearAndDisplaceOnBuildingFootprint(sim, built.pos.x, built.pos.y, w, h);

  sim.planner.clearRoutes();
  sim.infinitePathfinder.invalidateAtTile(built.pos.x, built.pos.y);

  for (const [resKey, amt] of Object.entries(def.cost)) {
    sim.stockpile[resKey] = (sim.stockpile[resKey] ?? 0) - amt;
  }
  const fertNote =
    defId === 'field' ? ` · 平均肥力 ${Math.round(check.avgFertility * 100)}%` : '';
  const msg = `🏗【建造完成】${def.name} (${w}×${h}) 已落成于 (${built.pos.x}, ${built.pos.y})${fertNote}`;
  sim.log(msg);
  return { ok: true, building: built, message: msg };
}

export function executeArchitectOrder(
  sim: Sim,
  orderKind: 'mine' | 'chop' | 'harvest' | 'deconstruct',
  xRaw: number,
  yRaw: number,
  actorEid?: Eid,
): { ok: boolean; message: string } {
  const x = Math.round(xRaw);
  const y = Math.round(yRaw);

  if (orderKind === 'deconstruct') {
    const b = sim.world.buildingAt(x, y);
    if (!b) return { ok: false, message: `(${x},${y}) 没有可拆除的建筑` };
    const def = sim.tuning.buildings[b.defId];
    const bLabel = b.customName ?? def?.name ?? b.defId;
    sim.removeBuilding(b.id);
    if (def?.cost && !b.isBlueprint) {
      for (const [k, v] of Object.entries(def.cost)) {
        sim.stockpile[k] = (sim.stockpile[k] ?? 0) + Math.max(1, Math.floor(v * 0.75));
      }
    }
    const msg = `🔨 已拆除建筑【${bLabel}】并回收建材`;
    sim.log(msg);
    return { ok: true, message: msg };
  }

  if (orderKind === 'mine') {
    for (let r = 0; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const res = mineMineralAt(sim, actorEid ?? null, x + dx, y + dy);
          if (res.ok) {
            return { ok: true, message: `⛏ 成功开采 ${res.name}：+${res.gained} ${res.item}` };
          }
        }
      }
    }
    if (sim.world.tileAt(x, y) === 'stone') {
      sim.stockpile['stone'] = (sim.stockpile['stone'] ?? 0) + 4;
      sim.stockpile['ore'] = (sim.stockpile['ore'] ?? 0) + 2;
      const msg = `⛏ 凿击花岗岩层 (${x},${y})：+4 石块, +2 钢铁`;
      sim.log(msg);
      return { ok: true, message: msg };
    }
    return { ok: false, message: `(${x},${y}) 附近没有可开采的矿脉或岩层` };
  }

  if (orderKind === 'chop' || orderKind === 'harvest') {
    const wanted = orderKind === 'chop' ? 'tree' : 'berry';
    const f = sim.nearestFeature(wanted, x, y, 4);
    if (!f) return { ok: false, message: `(${x},${y}) 附近没有可${orderKind === 'chop' ? '砍伐的树木' : '采收的浆果'}` };
    const left = sim.takeOne(f.x, f.y);
    if (left < 0) return { ok: false, message: '该资源正在再生冷却中' };
    const key = wanted === 'tree' ? 'wood' : 'food';
    const gain = wanted === 'tree' ? 4 : 3;
    sim.stockpile[key] = (sim.stockpile[key] ?? 0) + gain;
    if (wanted === 'tree') {
      sim.stockpile['wild_honey'] = (sim.stockpile['wild_honey'] ?? 0) + 1;
      sim.stockpile['glow_mushroom'] = (sim.stockpile['glow_mushroom'] ?? 0) + 1;
    } else {
      sim.stockpile['aromatic_spice'] = (sim.stockpile['aromatic_spice'] ?? 0) + 1;
      sim.stockpile['frost_greens'] = (sim.stockpile['frost_greens'] ?? 0) + 1;
    }
    const bonusTxt = wanted === 'tree' ? ', +1 琥珀百花蜜, +1 荧光菌' : ', +1 秘制香辛料, +1 霜叶菜';
    const msg = `${wanted === 'tree' ? '🪓 砍伐乔木' : '🍓 采收野果'} (${f.x},${f.y})：+${gain} ${key}${bonusTxt}`;
    sim.log(msg);
    return { ok: true, message: msg };
  }

  return { ok: false, message: '未知命令' };
}

export function placeArchitectBlueprint(
  sim: Sim,
  defId: string,
  xRaw: number,
  yRaw: number,
  rot: 0 | 1 | 2 | 3 = 0,
  ownerPlayerId = 'p_local_1',
  opts: { requireIndoorRoom?: boolean } = {},
): { ok: boolean; building?: BuildingState; message: string } {
  ensureRimWorldBuildingsRegistered(sim, true);
  const x = Math.round(xRaw);
  const y = Math.round(yRaw);
  const def = sim.tuning.buildings[defId];
  if (!def) return { ok: false, message: `未知建筑类型：${defId}` };

  let check = inspectFootprintCells(sim, defId, x, y, rot, opts);
  const hitUnreplaceableBuilding = check.cells.some((cl) => {
    const ex = sim.world.buildingAt(cl.x, cl.y);
    return ex !== undefined && !canBuildingReplace(defId, ex);
  });

  if (!check.valid && !hitUnreplaceableBuilding) {
    const onlyBlockedByTree = check.cells.every(
      (c) => c.valid || (c.reason && c.reason.includes('乔木')),
    );
    if (onlyBlockedByTree) {
      sim.world.clearFeaturesInRect(x, y, x + check.w - 1, y + check.h - 1);
      check = inspectFootprintCells(sim, defId, x, y, rot, opts);
    }
  }

  let built: BuildingState | null = null;
  if (check.valid) {
    built = sim.world.addArchitectBuilding(defId, x, y, {
      rot,
      w: check.w,
      h: check.h,
      allowContiguous: true,
      allowReplace: true,
      isBlueprint: true,
    });
  }

  if (!built) {
    return {
      ok: false,
      message: check.reason ?? `(${x},${y}) 地形受阻或已被占用，无法放置蓝图 ${def.name}`,
    };
  }

  built.ownerPlayerId = ownerPlayerId;
  built.isBlueprint = true;
  built.targetDefId = defId;
  built.materialsNeeded = { ...def.cost };
  built.materialsDelivered = {};
  for (const k of Object.keys(def.cost)) built.materialsDelivered[k] = 0;
  built.workTotal = defId === 'wall' || defId === 'door' || defId === 'power_conduit' ? 18 : Math.max(28, check.w * check.h * 14);
  built.workProgress = 0;

  sim.planner.clearRoutes();
  sim.infinitePathfinder.invalidateAtTile(built.pos.x, built.pos.y);

  const neededTxt = Object.entries(def.cost).map(([k, v]) => `${k}×${v}`).join(', ');
  const msg = `🏗【蓝图规划】已放置【${def.name}】蓝图 (${check.w}×${check.h})，殖民者将自动运送建材 (${neededTxt || '无需材料'}) 并施工`;
  sim.log(msg);
  return { ok: true, building: built, message: msg };
}

export function haulMaterialToBlueprint(
  sim: Sim,
  blueprintId: string,
  actorEid?: Eid,
): { ok: boolean; message: string; allDelivered: boolean } {
  const b = sim.world.buildings.get(blueprintId);
  if (!b || !b.isBlueprint || !b.materialsNeeded) {
    return { ok: false, message: '未找到指定蓝图', allDelivered: false };
  }
  const actor = actorEid ? sim.pawn(actorEid) : [...sim.pawns()].find((p) => !p.isStranger);
  let hauledAny = false;
  let missingKey = '';

  if (!b.materialsDelivered) b.materialsDelivered = {};
  for (const [k, needed] of Object.entries(b.materialsNeeded)) {
    const cur = b.materialsDelivered[k] ?? 0;
    if (cur < needed) {
      const diff = needed - cur;
      const haveStock = sim.stockpile[k] ?? 0;
      if (haveStock <= 0) {
        missingKey = k;
        continue;
      }
      const toHaul = Math.min(diff, haveStock);
      sim.stockpile[k] -= toHaul;
      b.materialsDelivered[k] = cur + toHaul;
      hauledAny = true;
    }
  }

  const allDelivered = Object.entries(b.materialsNeeded).every(([k, v]) => (b.materialsDelivered?.[k] ?? 0) >= v);

  if (actor) {
    actor.activeWork = {
      kind: 'haul_blueprint',
      label: `运送建材 (${b.targetDefId ?? b.defId})`,
      targetPos: { x: b.pos.x, y: b.pos.y },
      targetId: b.id,
      workTotal: 20,
      workProgress: 20,
      workContinuousSec: 0,
    };
  }

  const msg = allDelivered
    ? `📦 建材已全部运抵【${b.targetDefId ?? b.defId}】蓝图工地，开始施工！`
    : hauledAny
      ? `📦 已向【${b.targetDefId ?? b.defId}】蓝图运输材料`
      : `⚠ 库存缺少所需材料：${missingKey}`;
  sim.log(msg);
  return { ok: hauledAny || allDelivered, message: msg, allDelivered };
}

export function constructBlueprint(
  sim: Sim,
  blueprintId: string,
  actorEid?: Eid,
  workStep = 18,
): { ok: boolean; completed: boolean; message: string } {
  const b = sim.world.buildings.get(blueprintId);
  if (!b || !b.isBlueprint) {
    return { ok: false, completed: false, message: '未找到指定蓝图' };
  }
  const def = sim.tuning.buildings[b.targetDefId ?? b.defId];
  const actor = actorEid ? sim.pawn(actorEid) : [...sim.pawns()].find((p) => !p.isStranger);

  if (b.materialsNeeded) {
    const allDelivered = Object.entries(b.materialsNeeded).every(([k, v]) => (b.materialsDelivered?.[k] ?? 0) >= v);
    if (!allDelivered) {
      const hRes = haulMaterialToBlueprint(sim, blueprintId, actorEid);
      if (!hRes.allDelivered) {
        return { ok: false, completed: false, message: hRes.message };
      }
    }
  }

  if (actor) {
    if (!actor.activeWork || actor.activeWork.targetId !== blueprintId) {
      actor.activeWork = {
        kind: 'construct',
        label: `建造 (${def?.name ?? b.defId})`,
        targetPos: { x: b.pos.x, y: b.pos.y },
        targetId: b.id,
        workTotal: b.workTotal ?? 24,
        workProgress: b.workProgress ?? 0,
        workContinuousSec: 0,
      };
    }
    actor.activeWork.workContinuousSec = (actor.activeWork.workContinuousSec ?? 0) + 1;
    let fatigue = 1.0;
    if (actor.activeWork.workContinuousSec > 12) {
      fatigue = Math.max(0.25, 1.0 - (actor.activeWork.workContinuousSec - 12) * 0.04);
    }
    b.workProgress = Math.min(b.workTotal ?? 24, (b.workProgress ?? 0) + workStep * fatigue);
    actor.activeWork.workProgress = b.workProgress;
  } else {
    b.workProgress = Math.min(b.workTotal ?? 24, (b.workProgress ?? 0) + workStep);
  }

  const completed = (b.workProgress ?? 0) >= (b.workTotal ?? 24);
  if (completed) {
    b.isBlueprint = false;
    b.hp = def?.hp ?? 100;
    sim.world.finalizeBlueprintPassability(b.id);
    const { w, h } = sim.world.footprintOf(b);
    clearAndDisplaceOnBuildingFootprint(sim, b.pos.x, b.pos.y, w, h);
    sim.planner.clearRoutes();
    sim.infinitePathfinder.invalidateAtTile(b.pos.x, b.pos.y);
    if (actor?.activeWork?.targetId === blueprintId) {
      actor.activeWork = undefined;
    }
    const msg = `🎉【建造完工】${def?.name ?? b.defId} 已落成使用！`;
    sim.log(msg);
    return { ok: true, completed: true, message: msg };
  }

  const pct = Math.round(((b.workProgress ?? 0) / (b.workTotal ?? 24)) * 100);
  return { ok: true, completed: false, message: `🔨 施工中... 进度 ${pct}%` };
}

/**
 * RimWorld 自动施工循环：空闲殖民者自动前往未完工的墙体/家具蓝图运输材料并施工建造。
 */
export function tickRimWorldBlueprintWork(sim: Sim, dt: number): void {
  if (!sim.playerRimWorldMode) return;
  const blueprints: BuildingState[] = [];
  for (const b of sim.world.buildings.values()) {
    if (b.isBlueprint) blueprints.push(b);
  }
  if (blueprints.length === 0) return;

  for (const p of sim.pawns()) {
    if (p.isStranger || p.drafted || p.haulingCorpseEid !== undefined) continue;
    const constructPrio = p.workPriorities?.['construct'] ?? 2;
    if (constructPrio === 0) continue;

    // 找距离该殖民者最近且有材料可建的蓝图
    let bestBp: BuildingState | undefined;
    let bestD = Infinity;
    for (const bp of blueprints) {
      if (!bp.isBlueprint) continue;
      const canSupply =
        !bp.materialsNeeded ||
        Object.entries(bp.materialsNeeded).every(
          ([k, need]) => (bp.materialsDelivered?.[k] ?? 0) + (sim.stockpile[k] ?? 0) >= need,
        );
      if (!canSupply) continue;
      const d = Math.hypot(bp.pos.x - p.pos.x, bp.pos.y - p.pos.y);
      if (d < bestD) {
        bestD = d;
        bestBp = bp;
      }
    }
    if (!bestBp) continue;

    if (bestD > 1.75) {
      if (p.path.length === 0) {
        const adj = sim.world.nearestBuildingAdjacent(bestBp, p.pos.x, p.pos.y) ?? bestBp.pos;
        sim.setPath(p, adj.x, adj.y);
      }
      continue;
    }

    p.path = [];
    constructBlueprint(sim, bestBp.id, p.eid, dt * 16);
  }
}

export {
  ARCHITECT_BUILDABLES,
  RIMWORLD_WORK_TYPES,
  terrainMetaAt,
  type ArchitectBuildableDef,
  type FootprintCellStatus,
  type FootprintInspection,
  type RimWorldWorkDef,
  type RimWorldWorkType,
};
