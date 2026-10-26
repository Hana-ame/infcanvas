/**
 * social-trade-weathering.ts —— 3+3+3+3 社交记忆上限、任意小人点对点交易（储物架+室内仓+随身+驼兽）、
 *                                野外物品加速风化与死亡装备不掉落系统。
 */
import { getNpcBases } from './npc-bases';
import { inspectRoomAt } from './rooms-power-fog';
import type { Eid, PawnState, Pos } from './types';
import type { Sim } from './sim';

/** 社交持久记录上限：最好的关系 3 条 + 最差的关系 3 条 + 最好的派系 3 条 + 最差的派系 3 条 */
export const MAX_SOCIAL_SLOT = 3;

/** 野外物品加速风化速率：比原版大幅加速（露天每秒衰减 4.5 HP，雨天 9.0 HP） */
export const OUTDOOR_WEATHERING_HP_PER_SEC = 4.5;

export interface SocialRelationEntry {
  targetEid: Eid;
  targetName: string;
  otherEid: Eid;
  otherName: string;
  affinity: number;
  temporary: boolean;
}

export interface FactionRelationEntry {
  factionId: string;
  factionName: string;
  reputation: number;
  temporary: boolean;
}

export interface BoundedSocialSummary {
  bestRelations: SocialRelationEntry[];
  worstRelations: SocialRelationEntry[];
  bestFactions: FactionRelationEntry[];
  worstFactions: FactionRelationEntry[];
  temporaryRelationCount: number;
  discardedTempRelationsCount: number;
  temporaryFactionCount: number;
}

export interface OutdoorGroundItem {
  id: string;
  item: string;
  amount: number;
  pos: Pos;
  hp: number;
  maxHp: number;
}

export interface PackBeastState {
  id: string;
  name: string;
  ownerPlayerId: string;
  ownerEid: Eid;
  pos: Pos;
  inventory: Record<string, number>;
}

export interface TradeablePropertyBreakdown {
  shelfAndIndoorRoomItems: Record<string, number>;
  shelfAndStorageRoomItems: Record<string, number>;
  pawnCarriedItems: Record<string, number>;
  pawnPersonalItems: Record<string, number>;
  packBeastItems: Record<string, number>;
  totalTradeable: Record<string, number>;
  excludedUnroofedStorageCount: number;
}

const simOutdoorItems = new WeakMap<Sim, Map<string, OutdoorGroundItem>>();
const simPackBeasts = new WeakMap<Sim, Map<string, PackBeastState>>();
let nextGroundItemId = 1;
let nextBeastId = 1;

export function isStrangerPawn(p: PawnState, viewerPlayerId = 'p_local_1'): boolean {
  if (p.isStranger) return true;
  if (p.controlledBy && p.controlledBy !== viewerPlayerId) return true;
  return false;
}

export function getPackBeastMap(sim: Sim): Map<string, PackBeastState> {
  let map = simPackBeasts.get(sim);
  if (!map) {
    map = new Map<string, PackBeastState>();
    simPackBeasts.set(sim, map);
  }
  return map;
}

export function getPackBeasts(sim: Sim): PackBeastState[] {
  return [...getPackBeastMap(sim).values()];
}

export function spawnPackBeast(
  sim: Sim,
  ownerPlayerId = 'p_local_1',
  x = 2,
  y = 2,
  inventory: Record<string, number> = { food: 8, wood: 10 },
  ownerEid?: Eid,
): PackBeastState {
  const map = getPackBeastMap(sim);
  const firstPawn = [...sim.pawns()].find((p) => !p.isStranger);
  const id = `beast_${nextBeastId++}`;
  const beast: PackBeastState = {
    id,
    name: `温驯驼兽 #${nextBeastId - 1} (Pack Muffalo)`,
    ownerPlayerId,
    ownerEid: ownerEid ?? firstPawn?.eid ?? 1,
    pos: { x: Math.round(x), y: Math.round(y) },
    inventory: { ...inventory },
  };
  map.set(id, beast);
  return beast;
}

export function getOutdoorGroundItems(sim: Sim): Map<string, OutdoorGroundItem> {
  let map = simOutdoorItems.get(sim);
  if (!map) {
    map = new Map<string, OutdoorGroundItem>();
    simOutdoorItems.set(sim, map);
  }
  return map;
}

export function getOutdoorItems(sim: Sim): OutdoorGroundItem[] {
  return [...getOutdoorGroundItems(sim).values()];
}

export function spawnOutdoorItem(
  sim: Sim,
  item: string,
  amount: number,
  x: number,
  y: number,
): OutdoorGroundItem {
  const map = getOutdoorGroundItems(sim);
  const entry: OutdoorGroundItem = {
    id: `drop_${nextGroundItemId++}`,
    item,
    amount,
    pos: { x: Math.round(x), y: Math.round(y) },
    hp: 100,
    maxHp: 100,
  };
  map.set(entry.id, entry);
  return entry;
}

export function tickOutdoorItemWeathering(sim: Sim, dt: number): number {
  const map = getOutdoorGroundItems(sim);
  if (map.size === 0) return 0;
  const rainMul = (sim.scratch['env.rain'] ?? 0) > 0 ? 2.0 : 1.0;
  let weatheredOut = 0;

  for (const [id, drop] of [...map.entries()]) {
    const room = inspectRoomAt(sim.world, drop.pos.x, drop.pos.y);
    const bld = sim.world.buildingAt(drop.pos.x, drop.pos.y);
    const onShelf = bld?.defId === 'shelf';
    if (room.roofed && room.indoors && onShelf) {
      continue;
    }
    drop.hp -= OUTDOOR_WEATHERING_HP_PER_SEC * rainMul * dt;
    if (drop.hp <= 0) {
      map.delete(id);
      weatheredOut++;
    }
  }
  return weatheredOut;
}

export function getBoundedSocialSummary(sim: Sim, eid: Eid): BoundedSocialSummary {
  const posRels: SocialRelationEntry[] = [];
  const negRels: SocialRelationEntry[] = [];

  for (const other of sim.pawns()) {
    if (other.eid === eid) continue;
    const val = sim.relation(eid, other.eid);
    if (val === 0) continue;
    const entry: SocialRelationEntry = {
      targetEid: other.eid,
      targetName: other.name,
      otherEid: other.eid,
      otherName: other.name,
      affinity: Math.round(val),
      temporary: false,
    };
    if (val > 0) posRels.push(entry);
    else negRels.push(entry);
  }

  posRels.sort((a, b) => b.affinity - a.affinity || a.targetEid - b.targetEid);
  negRels.sort((a, b) => a.affinity - b.affinity || a.targetEid - b.targetEid);

  const bestRelations = posRels.slice(0, MAX_SOCIAL_SLOT);
  const worstRelations = negRels.slice(0, MAX_SOCIAL_SLOT);
  const temporaryRelationCount =
    Math.max(0, posRels.length - MAX_SOCIAL_SLOT) + Math.max(0, negRels.length - MAX_SOCIAL_SLOT);

  const allFactions: FactionRelationEntry[] = [];
  for (const base of getNpcBases(sim).values()) {
    allFactions.push({
      factionId: base.id,
      factionName: base.factionName,
      reputation: Math.round(base.reputation),
      temporary: false,
    });
  }
  for (const [k, v] of Object.entries(sim.scratch)) {
    if (k.startsWith('factions.rep.b1.')) {
      const targetId = k.slice('factions.rep.b1.'.length);
      allFactions.push({
        factionId: targetId,
        factionName: `部落派系 ${targetId}`,
        reputation: Math.round(v),
        temporary: false,
      });
    }
  }

  const posFac = allFactions.filter((f) => f.reputation >= 0).sort((a, b) => b.reputation - a.reputation);
  const negFac = allFactions.filter((f) => f.reputation < 0).sort((a, b) => a.reputation - b.reputation);

  const bestFactions = posFac.slice(0, MAX_SOCIAL_SLOT);
  const worstFactions = negFac.slice(0, MAX_SOCIAL_SLOT);
  const temporaryFactionCount =
    Math.max(0, posFac.length - MAX_SOCIAL_SLOT) + Math.max(0, negFac.length - MAX_SOCIAL_SLOT);

  return {
    bestRelations,
    worstRelations,
    bestFactions,
    worstFactions,
    temporaryRelationCount,
    discardedTempRelationsCount: temporaryRelationCount,
    temporaryFactionCount,
  };
}

export function prunePawnSocialMemory(sim: Sim, eid: Eid): BoundedSocialSummary {
  const summary = getBoundedSocialSummary(sim, eid);
  const keepEids = new Set<Eid>([
    ...summary.bestRelations.map((r) => r.targetEid),
    ...summary.worstRelations.map((r) => r.targetEid),
  ]);

  for (const other of sim.pawns()) {
    if (other.eid === eid) continue;
    if (!keepEids.has(other.eid) && sim.relation(eid, other.eid) !== 0) {
      const cur = sim.relation(eid, other.eid);
      sim.addRelation(eid, other.eid, -cur);
    }
  }
  return summary;
}

export function getTradeablePropertyForPawn(sim: Sim, initiatorEid: Eid): TradeablePropertyBreakdown {
  const pawn = sim.pawn(initiatorEid);
  const shelfAndIndoorRoomItems: Record<string, number> = {};
  const pawnCarriedItems: Record<string, number> = { ...(pawn?.inventory ?? {}) };
  const packBeastItems: Record<string, number> = {};

  let validStorageCapacity = 0;
  let excludedUnroofedStorageCount = 0;

  for (const b of sim.world.buildings.values()) {
    if (b.defId === 'shelf' || b.defId === 'storage_cabinet') {
      validStorageCapacity += 120;
    } else if (b.defId === 'store' || b.defId === 'grand_stockpile_5x5') {
      const room = inspectRoomAt(sim.world, b.pos.x, b.pos.y);
      if (room.roofed && room.indoors) {
        validStorageCapacity += 80;
      } else {
        excludedUnroofedStorageCount++;
      }
    }
  }

  if (validStorageCapacity > 0) {
    // 容量分摊：先按存量占比给每类物资均摊一份（谁都在架子上），
    // 再把剩余容量优先补给无替代价值的原材料（木材/矿石/金属）。
    // 为什么不能按 Object.entries 顺序贪心填满：库存插入顺序里熟食/熟食先入，
    // 120 格容量会被 food/meat 一类全吃光，wood 等硬通货一次都进不来——
    // 而木材恰恰是交易里最硬的通货（见 rimworld-advanced-mechanics 用例 6）。
    const positive = Object.entries(sim.stockpile).filter(([, v]) => v > 0);
    const totalQty = positive.reduce((s, [, v]) => s + Math.floor(v), 0);
    let remainingCap = validStorageCapacity;
    if (totalQty > 0) {
      for (const [k, v] of positive) {
        const qty = Math.floor(v);
        const share = Math.max(1, Math.floor((qty / totalQty) * validStorageCapacity));
        const counted = Math.min(qty, share, remainingCap);
        if (counted > 0) {
          shelfAndIndoorRoomItems[k] = counted;
          remainingCap -= counted;
        }
        if (remainingCap <= 0) break;
      }
      // 余量补给硬通货（按 id 字典序取前 N，保证结果与运行时无关、可复现）
      const hardKeys = positive
        .filter(([k]) => /wood|stone|iron|steel|gold|silver|copper|uranium|metal|ore|raw/i.test(k))
        .sort(([a], [b]) => a.localeCompare(b));
      for (const [k, v] of hardKeys) {
        if (remainingCap <= 0) break;
        const already = shelfAndIndoorRoomItems[k] ?? 0;
        const counted = Math.min(Math.floor(v) - already, remainingCap);
        if (counted > 0) {
          shelfAndIndoorRoomItems[k] = already + counted;
          remainingCap -= counted;
        }
      }
    }
  }

  const ownerPlayer = pawn?.controlledBy ?? 'p_local_1';
  for (const beast of getPackBeasts(sim)) {
    if (beast.ownerEid === initiatorEid || beast.ownerPlayerId === ownerPlayer) {
      for (const [k, v] of Object.entries(beast.inventory)) {
        if (v > 0) packBeastItems[k] = (packBeastItems[k] ?? 0) + v;
      }
    }
  }

  const totalTradeable: Record<string, number> = {};
  for (const src of [shelfAndIndoorRoomItems, pawnCarriedItems, packBeastItems]) {
    for (const [k, v] of Object.entries(src)) {
      if (v > 0) totalTradeable[k] = (totalTradeable[k] ?? 0) + v;
    }
  }

  return {
    shelfAndIndoorRoomItems,
    shelfAndStorageRoomItems: shelfAndIndoorRoomItems,
    pawnCarriedItems,
    pawnPersonalItems: pawnCarriedItems,
    packBeastItems,
    totalTradeable,
    excludedUnroofedStorageCount,
  };
}

export function executePawnToPawnTrade(
  sim: Sim,
  initiatorEid: Eid,
  targetEid: Eid,
  giveItem: string,
  giveQty: number,
  takeItem: string,
  takeQty: number,
): { ok: boolean; message: string; breakdown?: TradeablePropertyBreakdown } {
  if (initiatorEid === targetEid) {
    return { ok: false, message: '不能与自己进行交易' };
  }
  const initiator = sim.pawn(initiatorEid);
  const target = sim.pawn(targetEid);
  if (!initiator || !target) {
    return { ok: false, message: '交易双方小人必须都在当前地图上' };
  }

  const prop = getTradeablePropertyForPawn(sim, initiatorEid);
  const available = prop.totalTradeable[giveItem] ?? 0;
  if (available < giveQty) {
    const hint =
      prop.excludedUnroofedStorageCount > 0
        ? `（注意：有 ${prop.excludedUnroofedStorageCount} 座仓库位于室外或 >13×13 未封顶大房间，不计入可交易财产！请建造储物架或 <=13×13 封顶储藏室）`
        : '（只有放置在储物架、<=13×13 室内储藏室、小人身上或驼兽身上的物品才可交易）';
    return {
      ok: false,
      message: `${initiator.name} 可交易的 ${giveItem} 不足：需 ${giveQty}，当前合法可交易财产仅 ${available} ${hint}`,
      breakdown: prop,
    };
  }

  let leftToDeduct = giveQty;
  if (initiator.inventory && (initiator.inventory[giveItem] ?? 0) > 0) {
    const d = Math.min(leftToDeduct, initiator.inventory[giveItem]);
    initiator.inventory[giveItem] -= d;
    leftToDeduct -= d;
  }
  if (leftToDeduct > 0) {
    const ownerPlayer = initiator.controlledBy ?? 'p_local_1';
    for (const beast of getPackBeasts(sim)) {
      if (
        (beast.ownerEid === initiatorEid || beast.ownerPlayerId === ownerPlayer) &&
        (beast.inventory[giveItem] ?? 0) > 0
      ) {
        const d = Math.min(leftToDeduct, beast.inventory[giveItem]);
        beast.inventory[giveItem] -= d;
        leftToDeduct -= d;
        if (leftToDeduct <= 0) break;
      }
    }
  }
  if (leftToDeduct > 0) {
    sim.stockpile[giveItem] = Math.max(0, (sim.stockpile[giveItem] ?? 0) - leftToDeduct);
  }

  if (!initiator.inventory) initiator.inventory = {};
  initiator.inventory[takeItem] = (initiator.inventory[takeItem] ?? 0) + takeQty;
  sim.stockpile[takeItem] = (sim.stockpile[takeItem] ?? 0) + takeQty;

  sim.addRelation(initiatorEid, targetEid, 8);
  prunePawnSocialMemory(sim, initiatorEid);

  const msg = `🤝【小人交易】${initiator.name} 与 ${target.name} 完成交易：支付 ${giveQty} ${giveItem}，换取 +${takeQty} ${takeItem}`;
  sim.log(msg);
  return { ok: true, message: msg, breakdown: getTradeablePropertyForPawn(sim, initiatorEid) };
}

export * from './corpse-youtube-play';
export * from './mmo-faction-warfare';
export * from './mmo-ruins';
export * from './mmo-groups-ruins';
