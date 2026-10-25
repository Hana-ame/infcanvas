/**
 * mmo-ruins.ts —— RimWorld 远古遗迹房间与内部建筑搜刮系统（现已拆分归入 `dlc-ruin-scavenge` 扩展包，默认禁用）
 */
import { isRuinScavengeDlcEnabled } from '../mods/dlc-entry';
import { evaluatePawnActionEfficiency, performPawnTriadAction } from './triad-specialization';
import {
  ITEM_WEIGHT_KG,
  getColonistGroups,
  lootSelectedFromCorpse,
  refreshGroupCarryMetrics,
  type RuinScavengeSite,
} from './mmo-groups-ruins';
import { ensureRimWorldBuildingsRegistered } from './rimworld-work';
import type { BuildingState, Eid } from './types';
import type { Sim } from './sim';

export interface RuinRoomDef {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RuinInteriorPropSpec {
  defId: 'ancient_locker' | 'ancient_crate' | 'ancient_worktable' | 'ancient_cryptosleep_casket';
  customName: string;
  dx: number;
  dy: number;
  loot: Record<string, number>;
  relicGear?: string[];
}

const simRuinsMap = new WeakMap<Sim, Map<string, RuinScavengeSite>>();
const simRuinsArchitectBuilt = new WeakSet<Sim>();
const simRuinFloorTiles = new WeakMap<Sim, Set<string>>();

/** 判断当前世界是否已激活或初始化遗迹搜刮系统（DLC 开启或被显式调用） */
export function hasRuinSitesInitialized(sim: Sim): boolean {
  return simRuinsMap.has(sim) || isRuinScavengeDlcEnabled(sim);
}

/**
 * 判断某格是否为远古遗迹室内铺装地板（供渲染器绘制风化石板地砖）
 */
export function isRuinFloorTile(sim: Sim, x: number, y: number): boolean {
  const set = simRuinFloorTiles.get(sim);
  if (!set) return false;
  return set.has(`${Math.round(x)},${Math.round(y)}`);
}

/**
 * 获取地图上所有遗迹内部可搜刮的建筑列表
 */
export function getRuinScavengeableBuildings(sim: Sim): BuildingState[] {
  getRuinSites(sim);
  const list: BuildingState[] = [];
  for (const b of sim.world.buildings.values()) {
    if (b.isRuinBuilding) list.push(b);
  }
  return list;
}

/**
 * 获取或初始化地图上的远古遗迹建筑群
 */
export function getRuinSites(sim: Sim): Map<string, RuinScavengeSite> {
  let map = simRuinsMap.get(sim);
  if (!map) {
    map = new Map<string, RuinScavengeSite>();
    simRuinsMap.set(sim, map);

    const sites: RuinScavengeSite[] = [
      {
        id: 'ruin_research_vault',
        name: '远古生化实验室遗迹',
        pos: { x: 12, y: -9 },
        w: 8,
        h: 6,
        dangerLevel: 2,
        explored: false,
        remainingScavenges: 3,
        maxScavenges: 3,
        lootTable: { components: 4, herb: 6, gold: 4 },
        lootPool: { components: 4, herb: 6, gold: 4 },
        relicGear: ['仿生视觉芯片 (Bionic Eye)'],
        description: '残破的远古生化实验室，室内遗留有远古实验终端与密封储物柜。',
        rooms: [{ id: 'vault_room_a', name: '生化实验室', x: 12, y: -9, w: 8, h: 6 }],
      },
      {
        id: 'ruin_armory_bunker',
        name: '前线军械库遗迹',
        pos: { x: -13, y: 10 },
        w: 8,
        h: 6,
        dangerLevel: 3,
        explored: false,
        remainingScavenges: 3,
        maxScavenges: 3,
        lootTable: { ore: 8, gold: 5, components: 4 },
        lootPool: { ore: 8, gold: 5, components: 4 },
        relicGear: ['电荷步枪 (Charge Rifle)'],
        description: '风化的旧帝国军械地堡，内部摆放着军用物资箱与装备储物柜。',
        rooms: [{ id: 'armory_room_a', name: '军械储藏室', x: -13, y: 10, w: 8, h: 6 }],
      },
      {
        id: 'ruin_supply_depot',
        name: '旧纪元补给站遗迹',
        pos: { x: 14, y: 11 },
        w: 7,
        h: 6,
        dangerLevel: 1,
        explored: false,
        remainingScavenges: 2,
        maxScavenges: 2,
        lootTable: { meal: 8, food: 10, wood: 8 },
        lootPool: { meal: 8, food: 10, wood: 8 },
        relicGear: ['军用压缩口粮箱'],
        description: '坍塌一角的补给站废墟，房间内留有远古军用物资箱与储物柜。',
        rooms: [{ id: 'depot_room_a', name: '补给站主室', x: 14, y: 11, w: 7, h: 6 }],
      },
      {
        id: 'ruin_cryo_sanctum',
        name: '远古休眠舱室遗迹',
        pos: { x: -14, y: -11 },
        w: 8,
        h: 7,
        dangerLevel: 3,
        explored: false,
        remainingScavenges: 3,
        maxScavenges: 3,
        lootTable: { gold: 8, jade: 6, components: 4 },
        lootPool: { gold: 8, jade: 6, components: 4 },
        relicGear: ['海军动力甲 (Marine Armor)'],
        description: '远古先遣队的休眠舱室，内部有远古休眠舱、实验终端与储物柜可供搜刮。',
        rooms: [{ id: 'sanctum_room_a', name: '休眠舱室', x: -14, y: -11, w: 8, h: 7 }],
      },
    ];

    for (const s of sites) map.set(s.id, s);
  }

  if (sim.playerRimWorldMode && !simRuinsArchitectBuilt.has(sim)) {
    simRuinsArchitectBuilt.add(sim);
    buildPhysicalRuinRoomsAndProps(sim, map);
  }

  return map;
}

const RUIN_INTERIOR_SPECS: Record<string, RuinInteriorPropSpec[]> = {
  ruin_research_vault: [
    {
      defId: 'ancient_worktable',
      customName: '远古实验终端',
      dx: 2,
      dy: 2,
      loot: { components: 2, gold: 2 },
      relicGear: ['仿生视觉芯片 (Bionic Eye)'],
    },
    {
      defId: 'ancient_locker',
      customName: '远古医药储物柜',
      dx: 5,
      dy: 1,
      loot: { herb: 6, components: 1 },
    },
    {
      defId: 'ancient_crate',
      customName: '远古科研物资箱',
      dx: 5,
      dy: 4,
      loot: { gold: 2, components: 1 },
    },
  ],
  ruin_armory_bunker: [
    {
      defId: 'ancient_locker',
      customName: '远古军械储物柜',
      dx: 2,
      dy: 1,
      loot: { ore: 4, components: 2 },
      relicGear: ['电荷步枪 (Charge Rifle)'],
    },
    {
      defId: 'ancient_crate',
      customName: '重型军用弹药箱',
      dx: 5,
      dy: 2,
      loot: { ore: 4, gold: 3 },
    },
    {
      defId: 'ancient_worktable',
      customName: '军械维护终端',
      dx: 2,
      dy: 4,
      loot: { components: 2, gold: 2 },
    },
  ],
  ruin_supply_depot: [
    {
      defId: 'ancient_crate',
      customName: '远古冷链军粮箱',
      dx: 2,
      dy: 2,
      loot: { meal: 8, food: 6 },
      relicGear: ['军用压缩口粮箱'],
    },
    {
      defId: 'ancient_locker',
      customName: '后勤补给储物柜',
      dx: 4,
      dy: 3,
      loot: { food: 4, wood: 8 },
    },
  ],
  ruin_cryo_sanctum: [
    {
      defId: 'ancient_cryptosleep_casket',
      customName: '远古休眠舱',
      dx: 2,
      dy: 2,
      loot: { gold: 4, components: 2 },
      relicGear: ['海军动力甲 (Marine Armor)'],
    },
    {
      defId: 'ancient_worktable',
      customName: '先遣者数据终端',
      dx: 2,
      dy: 4,
      loot: { jade: 4, components: 2 },
    },
    {
      defId: 'ancient_locker',
      customName: '圣殿秘宝储物柜',
      dx: 5,
      dy: 2,
      loot: { gold: 4, jade: 2 },
    },
  ],
};

function buildPhysicalRuinRoomsAndProps(sim: Sim, sites: Map<string, RuinScavengeSite>): void {
  ensureRimWorldBuildingsRegistered(sim, true);
  let floorSet = simRuinFloorTiles.get(sim);
  if (!floorSet) {
    floorSet = new Set<string>();
    simRuinFloorTiles.set(sim, floorSet);
  }

  for (const site of sites.values()) {
    const rooms = site.rooms ?? [
      { id: `${site.id}_room`, name: site.name, x: site.pos.x, y: site.pos.y, w: site.w, h: site.h },
    ];
    for (const rm of rooms) {
      const rw = Math.min(13, rm.w);
      const rh = Math.min(13, rm.h);
      const x0 = rm.x;
      const y0 = rm.y;
      const x1 = x0 + rw - 1;
      const y1 = y0 + rh - 1;

      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          floorSet.add(`${x},${y}`);
          const isEdge = x === x0 || x === x1 || y === y0 || y === y1;
          if (!isEdge) continue;

          const isDoor =
            (x === x0 + Math.floor(rw / 2) && y === y1) ||
            (y === y0 + Math.floor(rh / 2) && x === x0);
          const isBreachGap =
            (x === x1 && y === y0 + 2) ||
            (x === x0 + 2 && y === y0);

          if (isBreachGap && !isDoor) continue;

          const defId = isDoor ? 'door' : 'wall';
          if (!sim.world.buildingAt(x, y)) {
            const b = sim.world.addArchitectBuilding(defId, x, y, {
              allowContiguous: true,
              ignoreTerrain: true,
            });
            if (b) {
              b.ownerPlayerId = 'p_ancient_faction';
              b.customName = isDoor ? '远古遗迹石门' : '远古遗迹断墙';
              b.hp = Math.round(b.hp * 0.75);
            }
          }
        }
      }
    }

    const specs = RUIN_INTERIOR_SPECS[site.id] ?? [];
    for (const sp of specs) {
      const bx = site.pos.x + sp.dx;
      const by = site.pos.y + sp.dy;
      const existing = sim.world.buildingAt(bx, by);
      if (existing) sim.world.removeBuilding(existing.id);

      const prop = sim.world.addArchitectBuilding(sp.defId, bx, by, {
        allowContiguous: true,
        ignoreTerrain: true,
        allowReplace: true,
      });
      if (prop) {
        prop.ownerPlayerId = 'p_ancient_faction';
        prop.isRuinBuilding = true;
        prop.ruinSiteId = site.id;
        prop.customName = sp.customName;
        prop.scavengeLoot = { ...sp.loot };
        prop.scavenged = false;
        if (sp.relicGear) prop.relicGear = [...sp.relicGear];
      }
    }
  }
}

/**
 * 搜刮遗迹内部的单个具体建筑（如远古储物柜、远古军用物资箱、远古实验终端、远古休眠舱）
 */
/** 贴身搜刮最大允许距离（格）：大于此距离视为隔空搜刮，必须先走过去 */
export const SCAVENGE_TOUCH_RANGE = 2.2;

export function scavengeRuinBuilding(
  sim: Sim,
  buildingId: string,
  actorEid?: Eid,
  preferredGroupId?: string,
  opts: { requireProximity?: boolean } = {},
): {
  ok: boolean;
  dispatched?: boolean;
  buildingId: string;
  siteId?: string;
  looted: Record<string, number>;
  gained: Record<string, number>;
  addedWeightKg: number;
  efficiencyMul: number;
  message: string;
} {
  getRuinSites(sim);
  const b = sim.world.buildings.get(buildingId);
  if (!b || !b.isRuinBuilding) {
    return {
      ok: false,
      buildingId,
      looted: {},
      gained: {},
      addedWeightKg: 0,
      efficiencyMul: 1,
      message: '该建筑不是可搜刮的遗迹设施',
    };
  }
  const bName = b.customName ?? sim.tuning.buildings[b.defId]?.name ?? b.defId;
  if (b.scavenged || !b.scavengeLoot || Object.keys(b.scavengeLoot).length === 0) {
    return {
      ok: false,
      buildingId,
      siteId: b.ruinSiteId,
      looted: {},
      gained: {},
      addedWeightKg: 0,
      efficiencyMul: 1,
      message: `【${bName}】已经被搜刮空了（可将其拆解回收建材）`,
    };
  }

  const actor =
    (actorEid !== undefined ? sim.pawn(actorEid) : undefined) ??
    [...sim.pawns()].find((p) => !p.isStranger);

  if (opts.requireProximity && actor) {
    const dist = sim.world.distToBuilding(actor.pos.x, actor.pos.y, b);
    if (dist > SCAVENGE_TOUCH_RANGE) {
      const adj = sim.world.nearestBuildingAdjacent(b, actor.pos.x, actor.pos.y) ?? {
        x: Math.round(b.pos.x),
        y: Math.round(b.pos.y),
      };
      actor.scavengeOrder = {
        targetKind: 'ruin_building',
        targetId: b.id,
        targetPos: { x: adj.x, y: adj.y },
        preferredGroupId,
      };
      actor.activeWork = {
        kind: 'scavenge',
        label: `前往搜刮 ${bName}`,
        targetPos: { x: adj.x, y: adj.y },
        targetId: b.id,
        workTotal: 16,
        workProgress: 0,
        workContinuousSec: 0,
      };
      sim.setPath(actor, adj.x, adj.y);
      const waitMsg = `🚶【不能隔空搜刮】${actor.name} 距离【${bName}】过远 (${dist.toFixed(1)}格)，已派遣步行前往 (${adj.x},${adj.y})，抵达贴身后自动开箱搜刮！`;
      sim.log(waitMsg);
      return {
        ok: false,
        dispatched: true,
        buildingId,
        siteId: b.ruinSiteId,
        looted: {},
        gained: {},
        addedWeightKg: 0,
        efficiencyMul: 1,
        message: waitMsg,
      };
    }
  }

  const triadEval = actor
    ? evaluatePawnActionEfficiency(actor, 'haul')
    : { efficiencyMul: 1.0, canLearn: true };
  if (actor) {
    performPawnTriadAction(actor, 'haul', 8, sim.time);
    actor.activeWork = {
      kind: 'scavenge',
      label: `搜刮 ${bName}`,
      targetPos: { x: b.pos.x, y: b.pos.y },
      targetId: b.id,
      workTotal: 16,
      workProgress: 16,
      workContinuousSec: 0,
    };
  }

  const groups = getColonistGroups(sim);
  const group =
    groups.get(preferredGroupId ?? actor?.groupId ?? 'group_alpha') ??
    groups.get('group_alpha')!;

  const gained: Record<string, number> = {};
  let addedWeightKg = 0;
  for (const [k, baseAmt] of Object.entries(b.scavengeLoot)) {
    if (baseAmt <= 0) continue;
    const amt = Math.max(1, Math.round(baseAmt * triadEval.efficiencyMul));
    gained[k] = amt;
    addedWeightKg += amt * (ITEM_WEIGHT_KG[k] ?? 1.0);
    sim.stockpile[k] = (sim.stockpile[k] ?? 0) + amt;
    group.inventory[k] = (group.inventory[k] ?? 0) + amt;
  }

  b.scavenged = true;
  b.scavengeLoot = {};
  addedWeightKg = Number(addedWeightKg.toFixed(2));
  refreshGroupCarryMetrics(sim, group);

  if (b.ruinSiteId) {
    const site = simRuinsMap.get(sim)?.get(b.ruinSiteId);
    if (site) {
      for (const [k, v] of Object.entries(gained)) {
        if (site.lootTable[k] !== undefined) {
          site.lootTable[k] = Math.max(0, site.lootTable[k] - v);
          if (site.lootTable[k] === 0) delete site.lootTable[k];
        }
      }
      const unlootedLeft = [...sim.world.buildings.values()].filter(
        (x) => x.isRuinBuilding && x.ruinSiteId === site.id && !x.scavenged,
      ).length;
      site.remainingScavenges = unlootedLeft;
      if (unlootedLeft === 0) {
        site.explored = true;
        site.lootTable = {};
      }
    }
  }

  const lootTxt = Object.entries(gained)
    .map(([k, v]) => `+${v} ${k}`)
    .join(', ');
  const msg = `🔍【搜刮建筑完成】${actor ? actor.name : '殖民者'} 搜刮了遗迹建筑【${bName}】：获得 ${lootTxt}（+${addedWeightKg}kg），已运回储物柜！`;
  sim.log(msg);

  return {
    ok: true,
    buildingId,
    siteId: b.ruinSiteId,
    looted: gained,
    gained,
    addedWeightKg,
    efficiencyMul: triadEval.efficiencyMul,
    message: msg,
  };
}

/**
 * 兼容旧接口：搜刮指定遗迹内的全部未搜刮建筑
 */
export function scavengeRuinSite(
  sim: Sim,
  siteId: string,
  actorEidOrGroupId?: Eid | string,
  maybeActorEid?: Eid,
): {
  ok: boolean;
  siteId: string;
  looted: Record<string, number>;
  gained: Record<string, number>;
  addedWeightKg: number;
  efficiencyMul: number;
  message: string;
} {
  const site = getRuinSites(sim).get(siteId);
  if (!site) {
    return {
      ok: false,
      siteId,
      looted: {},
      gained: {},
      addedWeightKg: 0,
      efficiencyMul: 1,
      message: '未找到指定遗迹',
    };
  }
  if (site.explored || site.remainingScavenges <= 0) {
    return {
      ok: false,
      siteId,
      looted: {},
      gained: {},
      addedWeightKg: 0,
      efficiencyMul: 1,
      message: `【${site.name}】内的建筑已被全部搜刮完毕`,
    };
  }

  const actorEid = typeof actorEidOrGroupId === 'number' ? actorEidOrGroupId : maybeActorEid;
  const preferredGroupId = typeof actorEidOrGroupId === 'string' ? actorEidOrGroupId : undefined;

  const targetProps = [...sim.world.buildings.values()].filter(
    (b) => b.isRuinBuilding && b.ruinSiteId === siteId && !b.scavenged,
  );

  if (targetProps.length > 0) {
    const totalGained: Record<string, number> = {};
    let totalKg = 0;
    let eff = 1;
    for (const prop of targetProps) {
      const sub = scavengeRuinBuilding(sim, prop.id, actorEid, preferredGroupId);
      if (sub.ok) {
        eff = sub.efficiencyMul;
        totalKg += sub.addedWeightKg;
        for (const [k, v] of Object.entries(sub.gained)) {
          totalGained[k] = (totalGained[k] ?? 0) + v;
        }
      }
    }
    site.explored = true;
    site.remainingScavenges = 0;
    site.lootTable = {};
    totalKg = Number(totalKg.toFixed(2));
    const lootTxt = Object.entries(totalGained)
      .map(([k, v]) => `+${v} ${k}`)
      .join(', ');
    const msg = `🔍【遗迹建筑搜刮完成】已搜刮【${site.name}】内的 ${targetProps.length} 座远古设施：获得 ${lootTxt}（+${totalKg}kg）`;
    return {
      ok: true,
      siteId,
      looted: totalGained,
      gained: totalGained,
      addedWeightKg: totalKg,
      efficiencyMul: eff,
      message: msg,
    };
  }

  const actor =
    (actorEid !== undefined ? sim.pawn(actorEid) : undefined) ??
    [...sim.pawns()].find((p) => !p.isStranger);
  const triadEval = actor
    ? evaluatePawnActionEfficiency(actor, 'haul')
    : { efficiencyMul: 1.0, canLearn: true };
  if (actor) performPawnTriadAction(actor, 'haul', 10, sim.time);

  const groups = getColonistGroups(sim);
  const group =
    groups.get(preferredGroupId ?? actor?.groupId ?? 'group_alpha') ??
    groups.get('group_alpha')!;

  site.remainingScavenges = 0;
  site.explored = true;
  const gained: Record<string, number> = {};
  let addedWeightKg = 0;
  for (const [k, baseAmt] of Object.entries(site.lootTable)) {
    const amt = Math.max(1, Math.round(baseAmt * triadEval.efficiencyMul));
    gained[k] = amt;
    addedWeightKg += amt * (ITEM_WEIGHT_KG[k] ?? 1.0);
    sim.stockpile[k] = (sim.stockpile[k] ?? 0) + amt;
    group.inventory[k] = (group.inventory[k] ?? 0) + amt;
  }
  site.lootTable = {};
  addedWeightKg = Number(addedWeightKg.toFixed(2));
  refreshGroupCarryMetrics(sim, group);

  const lootTxt = Object.entries(gained)
    .map(([k, v]) => `+${v} ${k}`)
    .join(', ');
  const msg = `🔍【遗迹搜刮完成】${actor ? actor.name : '远征队'} 搜刮了【${site.name}】内的设施：获得 ${lootTxt}（+${addedWeightKg}kg）！`;
  sim.log(msg);

  return {
    ok: true,
    siteId,
    looted: gained,
    gained,
    addedWeightKg,
    efficiencyMul: triadEval.efficiencyMul,
    message: msg,
  };
}

/**
 * 玩家在界面/右键菜单中下达「搜刮遗迹建筑」指令（强制执行「搜刮不能隔空搜刮」：未贴身时自动派遣小人走过去）
 */
export function orderScavengeRuinBuilding(
  sim: Sim,
  buildingId: string,
  actorEid?: Eid,
  preferredGroupId?: string,
) {
  return scavengeRuinBuilding(sim, buildingId, actorEid, preferredGroupId, { requireProximity: true });
}

/**
 * 每帧推进小人非隔空搜刮订单：当小人步行抵达遗迹建筑或遗体贴身范围 (`<= SCAVENGE_TOUCH_RANGE`) 后，推进搜刮读条并完成搜刮
 */
export function tickRimWorldScavengeOrders(sim: Sim, dt: number): void {
  for (const p of sim.pawns()) {
    const ord = p.scavengeOrder;
    if (!ord) continue;
    if (p.drafted || p.isStranger) {
      p.scavengeOrder = undefined;
      continue;
    }
    if (ord.targetKind === 'ruin_building') {
      const b = sim.world.buildings.get(String(ord.targetId));
      if (!b || b.scavenged) {
        p.scavengeOrder = undefined;
        if (p.activeWork?.kind === 'scavenge') p.activeWork = undefined;
        continue;
      }
      const dist = sim.world.distToBuilding(p.pos.x, p.pos.y, b);
      if (dist > SCAVENGE_TOUCH_RANGE) {
        if (p.path.length === 0) {
          const adj = sim.world.nearestBuildingAdjacent(b, p.pos.x, p.pos.y) ?? b.pos;
          if (!sim.setPath(p, adj.x, adj.y)) {
            p.scavengeOrder = undefined;
            if (p.activeWork?.kind === 'scavenge') p.activeWork = undefined;
          }
        }
        continue;
      }
      p.path = [];
      const bName = b.customName ?? sim.tuning.buildings[b.defId]?.name ?? b.defId;
      const progKey = `scav.prog.${p.eid}.${b.id}`;
      const curProg = (sim.scratch[progKey] ?? 0) + dt * 10;
      p.activeWork = {
        kind: 'scavenge',
        label: `贴身搜刮 ${bName}`,
        targetPos: { x: b.pos.x, y: b.pos.y },
        targetId: b.id,
        workTotal: 16,
        workProgress: Math.min(16, curProg),
        workContinuousSec: curProg / 10,
      };
      if (curProg >= 16) {
        delete sim.scratch[progKey];
        p.scavengeOrder = undefined;
        p.activeWork = undefined;
        scavengeRuinBuilding(sim, b.id, p.eid, ord.preferredGroupId, { requireProximity: false });
      } else {
        sim.scratch[progKey] = curProg;
      }
    } else if (ord.targetKind === 'corpse') {
      const c = sim.deadPawnMap.get(Number(ord.targetId));
      if (!c || c.corpseLooted) {
        p.scavengeOrder = undefined;
        if (p.activeWork?.kind === 'scavenge') p.activeWork = undefined;
        continue;
      }
      const dist = Math.hypot(p.pos.x - c.pos.x, p.pos.y - c.pos.y);
      if (dist > SCAVENGE_TOUCH_RANGE) {
        if (p.path.length === 0) {
          if (!sim.setPath(p, Math.round(c.pos.x), Math.round(c.pos.y))) {
            p.scavengeOrder = undefined;
            if (p.activeWork?.kind === 'scavenge') p.activeWork = undefined;
          }
        }
        continue;
      }
      p.path = [];
      const progKey = `scav.corpse.${p.eid}.${c.eid}`;
      const curProg = (sim.scratch[progKey] ?? 0) + dt * 12;
      p.activeWork = {
        kind: 'scavenge',
        label: `贴身搜刮 ${c.name}`,
        targetPos: { x: c.pos.x, y: c.pos.y },
        targetId: c.eid,
        workTotal: 14,
        workProgress: Math.min(14, curProg),
        workContinuousSec: curProg / 12,
      };
      if (curProg >= 14) {
        delete sim.scratch[progKey];
        p.scavengeOrder = undefined;
        p.activeWork = undefined;
        lootSelectedFromCorpse(sim, c.eid, p.eid, ord.selectedQuantities ?? {}, { requireProximity: false });
      } else {
        sim.scratch[progKey] = curProg;
      }
    }
  }
}
