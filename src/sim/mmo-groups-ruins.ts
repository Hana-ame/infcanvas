/**
 * mmo-groups-ruins.ts —— 殖民者分组与自定义新建编组 (`createColonistGroup`)、独立财产分配 (`price = 0` 交易面板 + 载重计算)、
 *                        遗体弹窗选择带出 (`inspectCorpseLootManifest`, `lootSelectedFromCorpse`)、
 *                        以及远古遗迹建筑搜刮点 (`getRuinSites`, `scavengeRuinSite`)。
 */
import { computeAnatomyCapacities } from './anatomy-health';
import { getPackBeasts } from './social-trade-weathering';
import type { Eid, PawnState, Pos } from './types';
import type { Sim } from './sim';

export * from './mmo-faction-warfare';

/** 各类物品单件重量（kg，用于殖民者分组载重与搜刮遗体/遗迹载重校验） */
export const ITEM_WEIGHT_KG: Record<string, number> = {
  food: 0.5,
  meal: 0.6,
  meat: 0.8,
  rice_grain: 0.4,
  corn_sweet: 0.45,
  wheat_flour: 0.45,
  potato_tuber: 0.5,
  glow_mushroom: 0.35,
  frost_greens: 0.35,
  prime_cut: 0.75,
  fresh_fish: 0.6,
  poultry_egg: 0.3,
  aromatic_spice: 0.2,
  aged_cheese: 0.5,
  wild_honey: 0.4,
  dish_charred_skewer: 0.5,
  dish_campfire_root_stew: 0.55,
  dish_grilled_river_fish: 0.5,
  dish_golden_fried_rice: 0.55,
  dish_creamy_mushroom_ragout: 0.6,
  dish_honey_glazed_ribs: 0.65,
  dish_ratkin_berry_cheese_pie: 0.55,
  dish_polar_spicy_hotpot: 0.7,
  dish_surf_turf_sashimi: 0.65,
  dish_royal_ratkin_banquet: 0.8,
  wood: 1.2,
  stone: 2.5,
  ore: 2.0,
  gold: 1.5,
  jade: 1.5,
  herb: 0.3,
  components: 1.0,
  weapon: 3.5,
  apparel: 4.0,
  bionic_part: 2.0,
};

/** 单个标准健康小人的基础负重上限（kg），驼兽额外增加 +85kg */
export const PAWN_BASE_CARRY_KG = 35;
export const PACK_BEAST_CARRY_KG = 85;

export interface ColonistGroup {
  id: string;
  name: string;
  roleTag: 'home' | 'expedition' | 'caravan' | 'combat';
  memberEids: Eid[];
  packBeastIds: string[];
  inventory: Record<string, number>;
  currentWeightKg: number;
  maxWeightKg: number;
}

export interface ZeroPriceTradeOutcome {
  ok: boolean;
  price: 0;
  fromGroupId: string;
  toGroupId: string;
  transferred: Record<string, number>;
  transferredWeightKg: number;
  weightTransferredKg: number;
  fromWeightKg: number;
  toWeightKg: number;
  toMaxWeightKg: number;
  message: string;
}

export interface CorpseLootManifestItem {
  key: string;
  label: string;
  category: 'weapon' | 'apparel' | 'resource' | 'bionic';
  availableQty: number;
  unitWeightKg: number;
  totalWeightKg: number;
}

export interface CorpseLootManifest {
  ok: boolean;
  corpseEid: Eid;
  corpseName: string;
  corpse?: PawnState;
  entries: CorpseLootManifestItem[];
  items: CorpseLootManifestItem[];
  totalAvailableWeightKg: number;
  totalWeightKg: number;
}

export interface SelectiveCorpseLootOutcome {
  ok: boolean;
  corpseEid: Eid;
  takenItems: Record<string, number>;
  remainingItemsCount: number;
  weightAddedKg: number;
  fullyLooted: boolean;
  corpseFullyStripped: boolean;
  message: string;
}

export interface RuinScavengeSite {
  id: string;
  name: string;
  pos: Pos;
  w: number;
  h: number;
  dangerLevel: 1 | 2 | 3;
  explored: boolean;
  remainingScavenges: number;
  maxScavenges: number;
  lootTable: Record<string, number>;
  lootPool: Record<string, number>;
  relicGear: string[];
  description: string;
  rooms?: { id: string; name: string; x: number; y: number; w: number; h: number }[];
}

const simGroupsMap = new WeakMap<Sim, Map<string, ColonistGroup>>();

export function computeInventoryWeightKg(inv: Record<string, number>): number {
  let sum = 0;
  for (const [k, qty] of Object.entries(inv)) {
    if (qty <= 0) continue;
    sum += qty * (ITEM_WEIGHT_KG[k] ?? 1.0);
  }
  return Number(sum.toFixed(2));
}

export function computePawnMaxCarryKg(p: PawnState): number {
  const caps = computeAnatomyCapacities(p);
  const moveFactor = Math.max(0.25, caps.movingPct / 100);
  const manipFactor = Math.max(0.4, caps.manipulationPct / 100);
  const traitBonus = p.trait === 'strong' || p.boundTraits?.includes('strong') ? 1.25 : 1.0;
  return Number((PAWN_BASE_CARRY_KG * moveFactor * (0.6 + 0.4 * manipFactor) * traitBonus).toFixed(1));
}

export function refreshGroupCarryMetrics(sim: Sim, group?: ColonistGroup): void {
  const map = simGroupsMap.get(sim);
  if (!group) {
    if (map) {
      for (const g of map.values()) refreshGroupCarryMetrics(sim, g);
    }
    return;
  }
  const aliveMembers = group.memberEids.filter((eid) => {
    const p = sim.pawn(eid);
    return Boolean(p && !p.isStranger);
  });
  group.memberEids = aliveMembers;

  let maxWeight = 0;
  for (const eid of aliveMembers) {
    const p = sim.pawn(eid);
    if (p) maxWeight += computePawnMaxCarryKg(p);
  }
  const allBeasts = getPackBeasts(sim);
  for (const bid of group.packBeastIds) {
    if (allBeasts.some((b) => b.id === bid)) maxWeight += PACK_BEAST_CARRY_KG;
  }
  if (maxWeight <= 0) maxWeight = PAWN_BASE_CARRY_KG;

  group.maxWeightKg = Number(maxWeight.toFixed(1));
  group.currentWeightKg = computeInventoryWeightKg(group.inventory);
}

/**
 * 获取或初始化殖民者分组 Map（默认分为 3 组：主力拓荒一组、远征搜刮二组、机动护卫三组）
 * 并确保每个非陌生人殖民者始终拥有有效的 `groupId` 与组成员注册。
 */
export function getColonistGroups(sim: Sim): Map<string, ColonistGroup> {
  let map = simGroupsMap.get(sim);
  if (!map) {
    map = new Map<string, ColonistGroup>();
    simGroupsMap.set(sim, map);

    const colonists = [...sim.pawns()].filter((p) => !p.isStranger);
    const beasts = getPackBeasts(sim);
    const g1 = colonists.filter((_, idx) => idx % 2 === 0).map((p) => p.eid);
    const g2 = colonists.filter((_, idx) => idx % 2 === 1).map((p) => p.eid);

    for (const eid of g1) {
      const p = sim.pawn(eid);
      if (p) p.groupId = 'group_alpha';
    }
    for (const eid of g2) {
      const p = sim.pawn(eid);
      if (p) p.groupId = 'group_beta';
    }

    const initialGroups: ColonistGroup[] = [
      {
        id: 'group_alpha',
        name: '主力拓荒一组 (Alpha Base Group)',
        roleTag: 'home',
        memberEids: g1,
        packBeastIds: beasts[0] ? [beasts[0].id] : [],
        inventory: { wood: 10, stone: 2, food: 8, herb: 4, ore: 2 },
        currentWeightKg: 0,
        maxWeightKg: 0,
      },
      {
        id: 'group_beta',
        name: '远征搜刮二组 (Beta Expedition Group)',
        roleTag: 'expedition',
        memberEids: g2,
        packBeastIds: [],
        inventory: { meal: 10, herb: 6, gold: 4, ore: 4, wood: 6 },
        currentWeightKg: 0,
        maxWeightKg: 0,
      },
      {
        id: 'group_gamma',
        name: '机动护卫三组 (Gamma Guard Group)',
        roleTag: 'combat',
        memberEids: [],
        packBeastIds: [],
        inventory: { meal: 8, herb: 6, components: 4 },
        currentWeightKg: 0,
        maxWeightKg: 0,
      },
    ];

    for (const g of initialGroups) {
      refreshGroupCarryMetrics(sim, g);
      map.set(g.id, g);
    }
  } else {
    const alpha = map.get('group_alpha');
    for (const p of sim.pawns()) {
      if (p.isStranger) continue;
      const gid = p.groupId && map.has(p.groupId) ? p.groupId : 'group_alpha';
      p.groupId = gid;
      const grp = map.get(gid) ?? alpha;
      if (grp && !grp.memberEids.includes(p.eid)) {
        grp.memberEids.push(p.eid);
      }
    }
    for (const g of map.values()) refreshGroupCarryMetrics(sim, g);
  }
  return map;
}

/**
 * 殖民者顶栏新建自定义编组（支持直接将当前选中的殖民者编入新组）
 */
export function createColonistGroup(
  sim: Sim,
  customName?: string,
  initialMemberEids: Eid[] = [],
  roleTag: ColonistGroup['roleTag'] = 'expedition',
): { ok: boolean; group: ColonistGroup; message: string } {
  const groups = getColonistGroups(sim);
  const idx = groups.size + 1;
  const id = `group_custom_${idx}_${Math.floor(sim.time)}`;
  const cleanName = (customName ?? '').trim() || `特遣${idx}组`;
  const newGroup: ColonistGroup = {
    id,
    name: cleanName,
    roleTag,
    memberEids: [],
    packBeastIds: [],
    inventory: { meal: 4, herb: 2 },
    currentWeightKg: 0,
    maxWeightKg: 0,
  };
  groups.set(id, newGroup);
  for (const eid of initialMemberEids) {
    const p = sim.pawn(eid);
    if (!p || p.isStranger) continue;
    for (const g of groups.values()) {
      g.memberEids = g.memberEids.filter((m) => m !== eid);
    }
    newGroup.memberEids.push(eid);
    p.groupId = id;
  }
  refreshGroupCarryMetrics(sim);
  const msg = `➕ 已创建新编组【${cleanName}】${newGroup.memberEids.length > 0 ? `（已编入 ${newGroup.memberEids.length} 名殖民者）` : ''}`;
  sim.log(msg);
  return { ok: true, group: newGroup, message: msg };
}

export function assignPawnToGroup(
  sim: Sim,
  eid: Eid,
  targetGroupId: string,
): { ok: boolean; group?: ColonistGroup; message: string } {
  const groups = getColonistGroups(sim);
  const target = groups.get(targetGroupId);
  const p = sim.pawn(eid);
  if (!target || !p) return { ok: false, message: '未找到指定殖民者或目标分组' };
  for (const g of groups.values()) {
    g.memberEids = g.memberEids.filter((id) => id !== eid);
  }
  target.memberEids.push(eid);
  p.groupId = target.id;
  refreshGroupCarryMetrics(sim);
  const msg = `👥 已将 ${p.name} 编入【${target.name}】（当前组最大载重 ${target.maxWeightKg} kg）`;
  sim.log(msg);
  return { ok: true, group: target, message: msg };
}

/**
 * 殖民者分组之间的 `price = 0` 无损财产分配交易面板接口
 * （严格校验目标分组的 `maxWeightKg` 负重上限，超重时拒绝转入）
 */
export function transferBetweenColonistGroupsZeroPrice(
  sim: Sim,
  fromGroupId: string,
  toGroupId: string,
  itemsToTransfer: Record<string, number> | Array<{ item: string; qty: number }>,
): ZeroPriceTradeOutcome {
  const groups = getColonistGroups(sim);
  const fromGrp = groups.get(fromGroupId);
  const toGrp = groups.get(toGroupId);

  if (!fromGrp || !toGrp) {
    return {
      ok: false,
      price: 0,
      fromGroupId,
      toGroupId,
      transferred: {},
      transferredWeightKg: 0,
      weightTransferredKg: 0,
      fromWeightKg: 0,
      toWeightKg: 0,
      toMaxWeightKg: 0,
      message: '未找到源分组或目标分组',
    };
  }

  refreshGroupCarryMetrics(sim, fromGrp);
  refreshGroupCarryMetrics(sim, toGrp);

  let deltaWeight = 0;
  const validated: Record<string, number> = {};

  const entries: Array<[string, number]> = Array.isArray(itemsToTransfer)
    ? itemsToTransfer.map((x) => [x.item, x.qty])
    : Object.entries(itemsToTransfer);

  for (const [item, rawQty] of entries) {
    const qty = Math.floor(rawQty);
    if (qty <= 0) continue;
    const avail = fromGrp.inventory[item] ?? 0;
    if (avail < qty) {
      return {
        ok: false,
        price: 0,
        fromGroupId,
        toGroupId,
        transferred: {},
        transferredWeightKg: 0,
        weightTransferredKg: 0,
        fromWeightKg: fromGrp.currentWeightKg,
        toWeightKg: toGrp.currentWeightKg,
        toMaxWeightKg: toGrp.maxWeightKg,
        message: `【${fromGrp.name}】库存不足：${item} 仅有 ${avail}（请求调拨 ${qty}）`,
      };
    }
    validated[item] = qty;
    deltaWeight += qty * (ITEM_WEIGHT_KG[item] ?? 1.0);
  }

  deltaWeight = Number(deltaWeight.toFixed(2));
  if (toGrp.currentWeightKg + deltaWeight > toGrp.maxWeightKg + 1e-6) {
    return {
      ok: false,
      price: 0,
      fromGroupId,
      toGroupId,
      transferred: {},
      transferredWeightKg: 0,
      weightTransferredKg: 0,
      fromWeightKg: fromGrp.currentWeightKg,
      toWeightKg: toGrp.currentWeightKg,
      toMaxWeightKg: toGrp.maxWeightKg,
      message: `⚠ 载重不足（超出【${toGrp.name}】负重上限）！当前 ${toGrp.currentWeightKg} kg + 调入 ${deltaWeight} kg > 上限 ${toGrp.maxWeightKg} kg`,
    };
  }

  for (const [item, qty] of Object.entries(validated)) {
    fromGrp.inventory[item] = Math.max(0, (fromGrp.inventory[item] ?? 0) - qty);
    if (fromGrp.inventory[item] === 0) delete fromGrp.inventory[item];
    toGrp.inventory[item] = (toGrp.inventory[item] ?? 0) + qty;
  }

  refreshGroupCarryMetrics(sim, fromGrp);
  refreshGroupCarryMetrics(sim, toGrp);

  const summary = Object.entries(validated)
    .map(([k, v]) => `${k}×${v}`)
    .join(', ');
  const msg = `⚖ [Price=0 分组调拨] 从【${fromGrp.name}】向【${toGrp.name}】无偿划拨：${summary}（总重 ${deltaWeight} kg，目标组载重 ${toGrp.currentWeightKg}/${toGrp.maxWeightKg} kg）`;
  sim.log(msg);

  return {
    ok: true,
    price: 0,
    fromGroupId,
    toGroupId,
    transferred: validated,
    transferredWeightKg: deltaWeight,
    weightTransferredKg: deltaWeight,
    fromWeightKg: fromGrp.currentWeightKg,
    toWeightKg: toGrp.currentWeightKg,
    toMaxWeightKg: toGrp.maxWeightKg,
    message: msg,
  };
}

/**
 * 打开遗体搜刮清单窗口（死亡不掉落地面，装备与随身背包留在遗体上，供玩家弹窗勾选要带出的物品）
 */
export function inspectCorpseLootManifest(sim: Sim, corpseEid: Eid): CorpseLootManifest {
  const c = sim.deadPawnMap.get(corpseEid);
  if (!c) {
    return {
      ok: false,
      corpseEid,
      corpseName: '未知遗体',
      entries: [],
      items: [],
      totalAvailableWeightKg: 0,
      totalWeightKg: 0,
    };
  }

  const items: CorpseLootManifestItem[] = [];
  if (c.equipWeapon) {
    const w = ITEM_WEIGHT_KG.weapon;
    items.push({
      key: 'equipWeapon',
      label: `武器：${c.equipWeapon}`,
      category: 'weapon',
      availableQty: 1,
      unitWeightKg: w,
      totalWeightKg: w,
    });
  }
  if (c.equipApparel) {
    const w = ITEM_WEIGHT_KG.apparel;
    items.push({
      key: 'equipApparel',
      label: `护甲：${c.equipApparel}`,
      category: 'apparel',
      availableQty: 1,
      unitWeightKg: w,
      totalWeightKg: w,
    });
  }

  for (const [k, qty] of Object.entries(c.inventory ?? {})) {
    if (qty <= 0) continue;
    const unitW = ITEM_WEIGHT_KG[k] ?? 1.0;
    items.push({
      key: k,
      label: `随身物资：${k}`,
      category: 'resource',
      availableQty: qty,
      unitWeightKg: unitW,
      totalWeightKg: Number((unitW * qty).toFixed(2)),
    });
  }

  const totalW = Number(items.reduce((acc, it) => acc + it.totalWeightKg, 0).toFixed(2));
  return {
    ok: true,
    corpseEid: c.eid,
    corpseName: c.name,
    corpse: c,
    entries: items,
    items,
    totalAvailableWeightKg: totalW,
    totalWeightKg: totalW,
  };
}

/**
 * 从遗体弹窗中按玩家勾选的条目与数量选择性带出物资（校验执行搜刮小人/小队的负重上限，未勾选物品继续留在遗体上）
 */
export const executeZeroPriceGroupTrade = transferBetweenColonistGroupsZeroPrice;

export function lootSelectedFromCorpse(
  sim: Sim,
  corpseEid: Eid,
  looterEidOrSelected: Eid | Record<string, number> | Array<{ key: string; qty: number }>,
  selectedKeysAndQty?: Record<string, number> | Array<{ key: string; qty: number }>,
  opts: { requireProximity?: boolean } = {},
): SelectiveCorpseLootOutcome {
  const c = sim.deadPawnMap.get(corpseEid);
  if (!c) {
    return {
      ok: false,
      corpseEid,
      takenItems: {},
      remainingItemsCount: 0,
      weightAddedKg: 0,
      fullyLooted: false,
      corpseFullyStripped: false,
      message: `未找到编号 #${corpseEid} 的遗体`,
    };
  }

  const looterEid = typeof looterEidOrSelected === 'number' ? looterEidOrSelected : undefined;
  const rawSel =
    typeof looterEidOrSelected === 'number'
      ? (selectedKeysAndQty ?? {})
      : looterEidOrSelected;

  const looter = (looterEid !== undefined ? sim.pawn(looterEid) : undefined) ?? [...sim.pawns()].find((p) => !p.isStranger);

  if (opts.requireProximity && looter) {
    const dist = Math.hypot(looter.pos.x - c.pos.x, looter.pos.y - c.pos.y);
    if (dist > 2.2) {
      looter.scavengeOrder = {
        targetKind: 'corpse',
        targetId: c.eid,
        targetPos: { x: Math.round(c.pos.x), y: Math.round(c.pos.y) },
        selectedQuantities: rawSel,
      };
      looter.activeWork = {
        kind: 'scavenge',
        label: `前往搜刮 ${c.name}`,
        targetPos: { x: Math.round(c.pos.x), y: Math.round(c.pos.y) },
        targetId: c.eid,
        workTotal: 14,
        workProgress: 0,
        workContinuousSec: 0,
      };
      sim.setPath(looter, Math.round(c.pos.x), Math.round(c.pos.y));
      const waitMsg = `🚶【不能隔空搜刮】${looter.name} 距离【${c.name}】过远 (${dist.toFixed(1)}格)，已派遣走过去贴身搜刮！`;
      sim.log(waitMsg);
      return {
        ok: false,
        corpseEid,
        takenItems: {},
        remainingItemsCount: inspectCorpseLootManifest(sim, corpseEid).items.length,
        weightAddedKg: 0,
        fullyLooted: false,
        corpseFullyStripped: false,
        message: waitMsg,
      };
    }
  }

  const groups = getColonistGroups(sim);
  const targetGroup = groups.get(looter?.groupId ?? 'group_alpha') ?? groups.get('group_alpha')!;
  refreshGroupCarryMetrics(sim, targetGroup);

  let neededWeight = 0;
  const toTake: Record<string, number> = {};

  const selPairs: Array<[string, number]> = Array.isArray(rawSel)
    ? rawSel.map((x) => [x.key, x.qty])
    : Object.entries(rawSel);

  for (const [key, reqQtyRaw] of selPairs) {
    const reqQty = Math.floor(reqQtyRaw);
    if (reqQty <= 0) continue;

    if (key === 'equipWeapon' || key === 'weapon') {
      if (!c.equipWeapon) continue;
      toTake.equipWeapon = 1;
      neededWeight += ITEM_WEIGHT_KG.weapon;
    } else if (key === 'equipApparel' || key === 'apparel') {
      if (!c.equipApparel) continue;
      toTake.equipApparel = 1;
      neededWeight += ITEM_WEIGHT_KG.apparel;
    } else {
      const avail = c.inventory?.[key] ?? 0;
      const take = Math.min(avail, reqQty);
      if (take > 0) {
        toTake[key] = take;
        neededWeight += take * (ITEM_WEIGHT_KG[key] ?? 1.0);
      }
    }
  }

  neededWeight = Number(neededWeight.toFixed(2));
  if (Object.keys(toTake).length === 0) {
    return {
      ok: false,
      corpseEid,
      takenItems: {},
      remainingItemsCount: inspectCorpseLootManifest(sim, corpseEid).items.length,
      weightAddedKg: 0,
      fullyLooted: Boolean(c.corpseLooted),
      corpseFullyStripped: Boolean(c.corpseLooted),
      message: '未勾选任何可带出的遗体物品',
    };
  }

  if (targetGroup && targetGroup.currentWeightKg + neededWeight > targetGroup.maxWeightKg + 1e-6) {
    return {
      ok: false,
      corpseEid,
      takenItems: {},
      remainingItemsCount: inspectCorpseLootManifest(sim, corpseEid).items.length,
      weightAddedKg: 0,
      fullyLooted: false,
      corpseFullyStripped: false,
      message: `⚠ 搜刮带出失败：所选物品重 ${neededWeight} kg，超出小队【${targetGroup.name}】剩余负重（${targetGroup.currentWeightKg}/${targetGroup.maxWeightKg} kg）！请减少勾选数量或调派驼兽。`,
    };
  }

  const gainedSummary: string[] = [];
  for (const [key, qty] of Object.entries(toTake)) {
    if (key === 'equipWeapon') {
      const wName = c.equipWeapon!;
      delete c.equipWeapon;
      if (looter) looter.equipWeapon = wName;
      sim.stockpile['ore'] = (sim.stockpile['ore'] ?? 0) + 3;
      if (targetGroup) targetGroup.inventory['weapon'] = (targetGroup.inventory['weapon'] ?? 0) + 1;
      gainedSummary.push(`武器[${wName}]`);
    } else if (key === 'equipApparel') {
      const aName = c.equipApparel!;
      delete c.equipApparel;
      if (looter) looter.equipApparel = aName;
      sim.stockpile['wood'] = (sim.stockpile['wood'] ?? 0) + 2;
      if (targetGroup) targetGroup.inventory['apparel'] = (targetGroup.inventory['apparel'] ?? 0) + 1;
      gainedSummary.push(`护甲[${aName}]`);
    } else {
      if (c.inventory) {
        c.inventory[key] = Math.max(0, (c.inventory[key] ?? 0) - qty);
        if (c.inventory[key] === 0) delete c.inventory[key];
      }
      sim.stockpile[key] = (sim.stockpile[key] ?? 0) + qty;
      if (targetGroup) targetGroup.inventory[key] = (targetGroup.inventory[key] ?? 0) + qty;
      if (looter) {
        looter.inventory = looter.inventory ?? {};
        looter.inventory[key] = (looter.inventory[key] ?? 0) + qty;
      }
      gainedSummary.push(`${key}×${qty}`);
    }
  }

  refreshGroupCarryMetrics(sim, targetGroup);
  const afterManifest = inspectCorpseLootManifest(sim, corpseEid);
  const fullyLooted = afterManifest.items.length === 0;
  c.corpseLooted = fullyLooted;
  if (fullyLooted && !c.isAnimalCorpse) {
    sim.deadPawnMap.delete(corpseEid);
  }

  const msg = `🎒 ${looter?.name ?? '殖民者'} 从【${c.name}】选择带出了：${gainedSummary.join('、')}（负重 +${neededWeight} kg${fullyLooted ? '，遗体已全部搜空' : `，剩余 ${afterManifest.items.length} 项留在遗体上`}）`;
  sim.log(msg);

  return {
    ok: true,
    corpseEid,
    takenItems: toTake,
    remainingItemsCount: afterManifest.items.length,
    weightAddedKg: neededWeight,
    fullyLooted,
    corpseFullyStripped: fullyLooted,
    message: msg,
  };
}

export * from './mmo-ruins';
