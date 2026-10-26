/**
 * corpse-youtube-play.ts —— 战场遗体生成、搜刮/尸检/安葬与 YouTube 热门 RimWorld 视频四大玩点实现。
 */
import { ensurePawnAnatomy } from './anatomy-health';
import { spliceGene } from './genetics-skills';
import { ensureRaiderUnitsRegistered } from './multiplayer-raid';
import { findNearestUnoccupiedTile } from './rimworld-ecology-butcher';
import { placeArchitectBuilding } from './rimworld-work';
import { isStrangerPawn } from './social-trade-weathering';
import type { Eid, PawnState } from './types';
import type { Sim } from './sim';

export interface CorpseLootOutcome {
  ok: boolean;
  message: string;
  corpseEid: Eid;
  lootedItems: Record<string, number>;
  weapon?: string;
  apparel?: string;
}

let nextCorpseEid = 10000;

export function getCorpses(sim: Sim): PawnState[] {
  return [...sim.deadPawnMap.values()];
}
export const getDeadPawns = getCorpses;

export function corpseAt(sim: Sim, x: number, y: number, maxRadius = 1.6): PawnState | null {
  let bestUnlooted: PawnState | null = null;
  let bestUnlootedD = maxRadius;
  let bestAny: PawnState | null = null;
  let bestAnyD = maxRadius;

  for (const c of sim.deadPawnMap.values()) {
    const d = Math.hypot(c.pos.x - x, c.pos.y - y);
    if (d <= bestAnyD) {
      bestAnyD = d;
      bestAny = c;
    }
    if (!c.corpseLooted && d <= bestUnlootedD) {
      bestUnlootedD = d;
      bestUnlooted = c;
    }
  }
  return bestUnlooted ?? bestAny;
}

export function spawnBattlefieldCorpse(
  sim: Sim,
  x: number,
  y: number,
  opts: Partial<PawnState> = {},
): PawnState {
  const eid = opts.eid ?? nextCorpseEid++;
  const pos = sim.playerRimWorldMode
    ? findNearestUnoccupiedTile(sim, x, y, { ignoreCorpseEid: eid, replaceSurfacePlant: true })
    : { x: Math.round(x), y: Math.round(y) };

  const corpse: PawnState = {
    eid,
    name: opts.name ?? `赤爪掠夺者遗体 #${eid - 9999}`,
    pos,
    needs: { food: 0, rest: 0, mood: 0, san: 0 },
    hp: 0,
    maxHp: 100,
    climb: 1,
    trait: opts.trait ?? 'strong',
    cardId: null,
    busyUntil: 0,
    holdUntil: 0,
    atkCd: 0,
    path: [],
    mastery: {},
    uses: {},
    xenotype: opts.xenotype ?? 'feral_marauder',
    equipWeapon: opts.equipWeapon ?? '制式突击步枪 (Assault Rifle)',
    equipApparel: opts.equipApparel ?? '掠夺者防弹背心 (Raider Flak Vest)',
    inventory: opts.inventory ?? { ore: 4, gold: 2, herb: 2, meal: 2 },
    butcherYield: opts.butcherYield ?? { meat: 3, leather: 2 },
    retainedOnCorpse: true,
    corpseLooted: false,
    corpseOrgansHarvested: false,
    corpseButchered: false,
    causeOfDeath: opts.causeOfDeath ?? '交火阵亡',
    deathTime: sim.time,
    isRaiderCorpse: opts.isRaiderCorpse ?? true,
  };
  ensurePawnAnatomy(corpse);
  sim.deadPawnMap.set(eid, corpse);
  return corpse;
}

export function lootCorpse(sim: Sim, corpseEid: Eid, looterEid?: Eid): CorpseLootOutcome {
  const corpse = sim.deadPawnMap.get(corpseEid);
  if (!corpse) {
    return { ok: false, message: `未找到编号 #${corpseEid} 的遗体`, corpseEid, lootedItems: {} };
  }
  if (corpse.corpseLooted) {
    return {
      ok: false,
      message: `【${corpse.name}】的遗体已经被搜刮过了（可继续执行战地尸检、屠宰或安葬清理）`,
      corpseEid,
      lootedItems: {},
    };
  }

  const looter = looterEid !== undefined ? sim.pawn(looterEid) : [...sim.pawns()].find((p) => !p.isStranger);
  const lootedItems: Record<string, number> = {};

  for (const [k, v] of Object.entries(corpse.inventory ?? {})) {
    if (v <= 0) continue;
    lootedItems[k] = (lootedItems[k] ?? 0) + v;
    sim.stockpile[k] = (sim.stockpile[k] ?? 0) + v;
    if (looter) {
      if (!looter.inventory) looter.inventory = {};
      looter.inventory[k] = (looter.inventory[k] ?? 0) + v;
    }
  }
  corpse.inventory = {};

  const weapon = corpse.equipWeapon;
  const apparel = corpse.equipApparel;
  if (weapon) {
    if (looter) looter.equipWeapon = weapon;
    lootedItems['ore'] = (lootedItems['ore'] ?? 0) + 3;
    sim.stockpile['ore'] = (sim.stockpile['ore'] ?? 0) + 3;
  }
  if (apparel) {
    if (looter) looter.equipApparel = apparel;
    lootedItems['components'] = (lootedItems['components'] ?? 0) + 1;
    sim.stockpile['components'] = (sim.stockpile['components'] ?? 0) + 1;
  }

  corpse.equipWeapon = undefined;
  corpse.equipApparel = undefined;
  corpse.corpseLooted = true;

  const itemSummary = Object.entries(lootedItems)
    .map(([k, v]) => `+${v} ${k}`)
    .join(', ');
  const gearSummary = [weapon ? `武器【${weapon}】` : '', apparel ? `护甲【${apparel}】` : '']
    .filter(Boolean)
    .join('、');

  const actorName = looter ? looter.name : '殖民地';
  const msg = `🎒【搜刮尸体】${actorName} 搜刮了【${corpse.name}】的遗体：缴获 ${gearSummary || '随身装具'}${itemSummary ? ` 及物资 (${itemSummary})` : ''}！`;
  sim.log(msg);

  return { ok: true, message: msg, corpseEid, lootedItems, weapon, apparel };
}

export function harvestCorpseOrgan(
  sim: Sim,
  corpseEid: Eid,
): { ok: boolean; message: string; gained: Record<string, number> } {
  const corpse = sim.deadPawnMap.get(corpseEid);
  if (!corpse) return { ok: false, message: '未找到指定遗体', gained: {} };
  if (corpse.corpseOrgansHarvested) {
    return { ok: false, message: `【${corpse.name}】的遗体已进行过器官/义体摘除`, gained: {} };
  }
  corpse.corpseOrgansHarvested = true;
  const gained = { herb: 3, components: 2, gold: 3 };
  for (const [k, v] of Object.entries(gained)) {
    sim.stockpile[k] = (sim.stockpile[k] ?? 0) + v;
  }
  const msg = `🫀【战地尸检】已从【${corpse.name}】遗体提取可用生物器官与义体组件（+3 医疗药草, +2 精密零件, +3 黄金价值）！`;
  sim.log(msg);
  return { ok: true, message: msg, gained };
}

export function buryCorpseInSitu(
  sim: Sim,
  corpseEid: Eid,
  actorEid?: Eid,
): { ok: boolean; message: string; graveId?: string } {
  const corpse = sim.deadPawnMap.get(corpseEid);
  if (!corpse) return { ok: false, message: '未找到指定遗体' };
  const actor = actorEid ? sim.pawn(actorEid) : [...sim.pawns()].find((p) => !p.isStranger);

  if (actor) {
    actor.activeWork = {
      kind: 'bury',
      label: '原地掩埋遗体',
      targetPos: { x: corpse.pos.x, y: corpse.pos.y },
      targetId: corpseEid,
      workTotal: 40,
      workProgress: 0,
      workContinuousSec: 0,
    };
  }

  const grave = sim.world.addArchitectBuilding('grave', corpse.pos.x, corpse.pos.y, {
    allowContiguous: true,
    ignoreTerrain: true,
    allowReplace: true,
  });
  if (grave) {
    grave.ownerPlayerId = sim.activePlayerId;
    grave.buriedPawnName = corpse.name;
    grave.buriedItems = { ...(corpse.inventory ?? {}) };
    grave.buriedWeapon = corpse.equipWeapon;
    grave.buriedApparel = corpse.equipApparel;
    grave.isRobbed = false;
  }
  sim.deadPawnMap.delete(corpseEid);

  for (const p of sim.pawns()) {
    if (!p.isStranger) {
      p.needs.mood = Math.min(100, p.needs.mood + 5);
    }
  }

  const actorName = actor ? actor.name : '殖民者';
  const msg = `⚰【原地掩埋】${actorName} 消耗工作量将【${corpse.name}】就地掩埋为坟墓，全员心情 +5（支持盗墓/掘墓）`;
  sim.log(msg);
  return { ok: true, message: msg, graveId: grave?.id };
}

export function robGrave(
  sim: Sim,
  graveBuildingId: string,
  actorEid?: Eid,
): { ok: boolean; message: string; unearthedLoot?: Record<string, number> } {
  const grave = sim.world.buildings.get(graveBuildingId);
  if (!grave || grave.defId !== 'grave') return { ok: false, message: '未找到指定坟墓' };
  if (grave.isRobbed) return { ok: false, message: '该坟墓已经被盗掘过了' };

  const actor = actorEid ? sim.pawn(actorEid) : [...sim.pawns()].find((p) => !p.isStranger);
  if (actor) {
    actor.activeWork = {
      kind: 'rob_grave',
      label: '盗墓/掘墓',
      targetPos: { x: grave.pos.x, y: grave.pos.y },
      targetId: graveBuildingId,
      workTotal: 50,
      workProgress: 0,
      workContinuousSec: 0,
    };
  }

  grave.isRobbed = true;
  grave.hp = Math.max(1, Math.round(grave.hp * 0.3));

  const looted: Record<string, number> = { ...(grave.buriedItems ?? {}) };
  if (grave.buriedWeapon) looted['weapon'] = 1;
  if (grave.buriedApparel) looted['apparel'] = 1;
  if (Object.keys(looted).length === 0) {
    looted['gold'] = 3;
    looted['bone'] = 2;
  }

  for (const [k, v] of Object.entries(looted)) {
    sim.stockpile[k] = (sim.stockpile[k] ?? 0) + v;
  }

  for (const p of sim.pawns()) {
    if (!p.isStranger) {
      p.needs.mood = Math.max(0, p.needs.mood - 12);
    }
  }

  const actorName = actor ? actor.name : '殖民者';
  const lootTxt = Object.entries(looted)
    .map(([k, v]) => `${k}×${v}`)
    .join(', ');
  const msg = `💀【掘墓盗墓】${actorName} 掘开了【${grave.buriedPawnName ?? '无名逝者'}】的坟墓，盗出战利品：${lootTxt}！全员心情受到严重打击 (-12 心情)！`;
  sim.log(msg);
  return { ok: true, message: msg, unearthedLoot: looted };
}

export function buryOrCremateCorpse(sim: Sim, corpseEid: Eid): { ok: boolean; message: string } {
  const corpse = sim.deadPawnMap.get(corpseEid);
  if (!corpse) return { ok: false, message: '未找到指定遗体' };
  if (!corpse.corpseLooted) {
    lootCorpse(sim, corpseEid);
  }
  sim.deadPawnMap.delete(corpseEid);
  for (const p of sim.pawns()) {
    if (!p.isStranger) {
      p.needs.mood = Math.min(100, p.needs.mood + 5);
    }
  }
  const msg = `⚰【入土安葬】已妥善安葬/火化【${corpse.name}】的遗体，全员心情 +5`;
  sim.log(msg);
  return { ok: true, message: msg };
}

export function deployKillboxTrapMaze(
  sim: Sim,
  anchorX = 8,
  anchorY = 0,
): { ok: boolean; message: string; builtCount: number } {
  sim.stockpile['wood'] = (sim.stockpile['wood'] ?? 0) + 80;
  sim.stockpile['ore'] = (sim.stockpile['ore'] ?? 0) + 50;

  let builtCount = 0;
  const tryBuild = (defId: string, x: number, y: number) => {
    const b = sim.world.addArchitectBuilding(defId, x, y, {
      allowContiguous: true,
      ignoreTerrain: false,
    });
    if (b) {
      b.ownerPlayerId = sim.activePlayerId;
      builtCount++;
    }
  };

  for (let dx = 0; dx < 5; dx++) {
    tryBuild('wall', anchorX + dx, anchorY - 2);
    tryBuild('wall', anchorX + dx, anchorY + 2);
  }
  for (let dx = 0; dx < 5; dx++) {
    tryBuild('trap', anchorX + dx, anchorY + (dx % 2 === 0 ? -1 : 1));
    tryBuild('trap', anchorX + dx, anchorY);
  }
  tryBuild('tower', anchorX - 2, anchorY - 1);
  tryBuild('turret', anchorX - 1, anchorY - 2);
  tryBuild('turret', anchorX - 1, anchorY + 2);
  tryBuild('wood_generator', anchorX - 4, anchorY - 3);
  tryBuild('power_conduit', anchorX - 2, anchorY - 2);

  sim.planner.clearRoutes();
  const msg = `🛡【Killbox 杀戮区落成】已在 (${anchorX}, ${anchorY}) 部署九曲尖刺陷阱走廊 + 沙袋掩体 + 双联迷你机枪塔（共落成 ${builtCount} 座防御工事）！`;
  sim.log(msg);
  return { ok: true, message: msg, builtCount };
}

export function dispenseNutrientPasteMeals(
  sim: Sim,
  batches = 4,
): { ok: boolean; message: string; mealsProduced: number } {
  let hasDispenser = false;
  for (const b of sim.world.buildings.values()) {
    if (b.defId === 'nutrient_paste_dispenser') {
      hasDispenser = true;
      break;
    }
  }
  if (!hasDispenser) {
    sim.stockpile['wood'] = (sim.stockpile['wood'] ?? 0) + 10;
    sim.stockpile['ore'] = (sim.stockpile['ore'] ?? 0) + 12;
    placeArchitectBuilding(sim, 'nutrient_paste_dispenser', -3, -2, 0, sim.activePlayerId);
  }

  let mealsProduced = 0;
  for (let i = 0; i < batches; i++) {
    if ((sim.stockpile['meat'] ?? 0) >= 1) {
      sim.stockpile['meat'] -= 1;
      sim.stockpile['meal'] = (sim.stockpile['meal'] ?? 0) + 2;
      mealsProduced += 2;
    } else if ((sim.stockpile['food'] ?? 0) >= 1) {
      sim.stockpile['food'] -= 1;
      sim.stockpile['meal'] = (sim.stockpile['meal'] ?? 0) + 2;
      mealsProduced += 2;
    }
  }
  if (mealsProduced === 0) {
    sim.stockpile['meal'] = (sim.stockpile['meal'] ?? 0) + 4;
    mealsProduced = 4;
  }

  const msg = `🧪【营养膏合成机】已将生鲜食材按 1:2 翻倍合成为 +${mealsProduced} 份无菌营养膏膳食 (零食物中毒风险)！`;
  sim.log(msg);
  return { ok: true, message: msg, mealsProduced };
}

export function createBiotechSuperSoldier(
  sim: Sim,
  eid?: Eid,
): { ok: boolean; message: string; genesAdded: string[] } {
  const pawn =
    (eid !== undefined ? sim.pawn(eid) : undefined) ??
    [...sim.pawns()].find((p) => !isStrangerPawn(p, sim.activePlayerId));
  if (!pawn) return { ok: false, message: '未找到可改造的殖民者', genesAdded: [] };

  const superGenes = ['gene_iron_fur', 'gene_fast_metabolism', 'gene_sharpshooter', 'gene_tunnel_claws'];
  const genesAdded: string[] = [];
  for (const gid of superGenes) {
    if (spliceGene(pawn, gid)) {
      genesAdded.push(gid);
    }
  }
  pawn.xenotype = 'ratkin_vanguard';
  pawn.hp = pawn.maxHp;
  const msg = `🧬【Biotech 基因超兵】已为 ${pawn.name} 注入全套皇家鼠卫超兵基因（钢毛皮甲+高速代谢+鹰眼狙击+掘地利爪）！`;
  sim.log(msg);
  return { ok: true, message: msg, genesAdded };
}

export function spawnAncientDangerShrine(
  sim: Sim,
  x = -8,
  y = -6,
): { ok: boolean; message: string; casketId?: string } {
  const b = sim.world.addArchitectBuilding('ancient_cryptosleep_casket', x, y, {
    allowContiguous: true,
    ignoreTerrain: true,
  });
  if (b) b.ownerPlayerId = sim.activePlayerId;
  const msg = `🏛【远古威慑神殿】已在 (${x}, ${y}) 发现封闭的远古休眠舱 (Ancient Cryptosleep Casket)！`;
  sim.log(msg);
  return { ok: true, message: msg, casketId: b?.id };
}

export function breachAncientDangerShrine(
  sim: Sim,
  x = -8,
  y = -6,
): { ok: boolean; message: string; spawnedMechIds: number[]; lootGained: Record<string, number> } {
  ensureRaiderUnitsRegistered(sim);
  if (!sim.tuning.enemies['siege_rat_mech']) {
    sim.tuning.enemies['siege_rat_mech'] = {
      name: '重装破城机械鼠甲 (Siege Mechanoid)',
      hp: 140,
      dmg: 14,
      speed: 3.5,
      atkCd: 1.5,
      climb: 2,
      drops: { ore: 8, gold: 4 },
    };
  }

  spawnBattlefieldCorpse(sim, x + 1, y + 1, {
    name: '远古休眠舱宇航员遗体 (Ancient Soldier)',
    equipWeapon: '闪耀世界电荷步枪 (Charge Rifle)',
    equipApparel: '远古海军动力甲 (Marine Armor)',
    inventory: { gold: 8, components: 5, herb: 4, meal: 4 },
    causeOfDeath: '休眠舱低温衰竭',
  });

  const mech = sim.spawnHostile('siege_rat_mech', x + 2, y);
  const lootGained = { gold: 10, components: 6, herb: 5, ore: 12 };
  for (const [k, v] of Object.entries(lootGained)) {
    sim.stockpile[k] = (sim.stockpile[k] ?? 0) + v;
  }

  const msg = `⚠【远古威慑开启】破拆远古休眠舱唤醒了机械族守卫 (#${mech.id})！同时发现了可搜刮的【远古宇航员遗体】与闪耀世界宝藏 (+10 黄金, +6 精密零件, +5 草药)！`;
  sim.log(msg);
  return { ok: true, message: msg, spawnedMechIds: [mech.id], lootGained };
}
