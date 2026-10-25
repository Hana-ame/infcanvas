/**
 * sim-commands.ts —— Sim 权威命令分发器与交互动作实现（从 sim.ts 拆出，保持每个文件职责单一且 <500 行）。
 */
import { usePawnSkill, spliceGene } from './genetics-skills';
import { tradeWithNpcBase, giftNpcBase, requestAllyReinforcements, assaultNpcBase } from './npc-bases';
import { spawnPlayerRaidSquad, orderPlayerRaiders, switchPlayerRole } from './multiplayer-raid';
import {
  setPawnDrafted,
  orderPawnAttackHostile,
  setPawnWorkPriority,
  placeArchitectBuilding,
  executeArchitectOrder,
  type RimWorldWorkType,
} from './rimworld-work';
import {
  bandageBodyPartWithHerb,
  amputateBodyPart,
  transplantBodyPart,
} from './anatomy-health';
import {
  corpseAt,
  lootCorpse,
  harvestCorpseOrgan,
  buryOrCremateCorpse,
  deployKillboxTrapMaze,
  dispenseNutrientPasteMeals,
  createBiotechSuperSoldier,
  breachAncientDangerShrine,
} from './corpse-youtube-play';
import { kidnapFromFaction, stealFromFaction } from './mmo-faction-warfare';
import {
  assignPawnToGroup,
  executeZeroPriceGroupTrade,
  lootSelectedFromCorpse,
} from './mmo-groups-ruins';
import { getRuinScavengeableBuildings, getRuinSites, orderScavengeRuinBuilding, scavengeRuinBuilding, scavengeRuinSite } from './mmo-ruins';
import { consumeCulinaryDish, cookCulinaryDish } from './culinary-dishes';
import { executePawnToPawnTrade } from './social-trade-weathering';
import { toggleSimDlc } from '../mods/dlc-entry';
import type { BuildingState, Eid, InteractOutcome, PawnState, Pos } from './types';
import type { Sim } from './sim';

export function executeSimInteract(sim: Sim, eid: Eid): InteractOutcome | null {
  const p = sim.pawnMap.get(eid);
  if (!p || (p.interactCd ?? 0) > 0) return null;
  const r = sim.tuning.hero.interactRange;
  const cd = (v: number) => {
    p.interactCd = v;
  };

  // 1. 优先检查附近是否有尚未搜刮的尸体
  const nearbyCorpse = corpseAt(sim, p.pos.x, p.pos.y, r);
  if (nearbyCorpse && !nearbyCorpse.corpseLooted) {
    lootCorpse(sim, nearbyCorpse.eid, eid);
    cd(0.5);
    return { kind: 'loot_corpse', corpseEid: nearbyCorpse.eid };
  }

  // 2. 检查附近是否有遗迹内部可搜刮的具体建筑（储物柜/物资箱/实验终端/休眠舱）
  for (const rb of getRuinScavengeableBuildings(sim)) {
    if (!rb.scavenged && Math.hypot(rb.pos.x - p.pos.x, rb.pos.y - p.pos.y) <= r + 1.5) {
      scavengeRuinBuilding(sim, rb.id, eid, p.groupId ?? 'group_beta');
      cd(0.6);
      return { kind: 'scavenge_ruin', siteId: rb.ruinSiteId ?? rb.id };
    }
  }

  // 2b. 兜底兼容：检查附近是否有可搜刮的遗迹点
  for (const site of getRuinSites(sim).values()) {
    if (site.remainingScavenges > 0 && Math.hypot(site.pos.x - p.pos.x, site.pos.y - p.pos.y) <= r + 1.5) {
      scavengeRuinSite(sim, site.id, p.groupId ?? 'group_beta', eid);
      cd(0.6);
      return { kind: 'scavenge_ruin', siteId: site.id };
    }
  }

  // 3. 检查附近是否有可对话的 NPC
  let bestNpc: typeof p | undefined;
  let bestNpcD = r;
  for (const other of sim.pawnMap.values()) {
    if (other.eid === eid || other.controlledBy !== undefined) continue;
    const d = Math.hypot(other.pos.x - p.pos.x, other.pos.y - p.pos.y);
    if (d <= bestNpcD) {
      bestNpcD = d;
      bestNpc = other;
    }
  }
  if (bestNpc) {
    sim.openDialogue(bestNpc.eid);
    cd(0.5);
    return { kind: 'npc', npcEid: bestNpc.eid };
  }

  // 4. 采集浆果或砍树
  for (const kind of ['berry', 'tree'] as const) {
    const f = sim.nearestFeature(kind, p.pos.x, p.pos.y, r);
    if (!f) continue;
    if (sim.distToFeatureRect(p.pos.x, p.pos.y, sim.featureRect(f)) > r) continue;
    const item = kind === 'berry' ? 'food' : 'wood';
    if (sim.rollSuccess(sim.tuning.successRate.pickup)) {
      const left = sim.takeOne(f.x, f.y);
      if (left >= 0) {
        sim.stockpile[item] = (sim.stockpile[item] ?? 0) + 1;
        cd(0.5);
        return { kind: 'pickup', item, gained: 1 };
      }
    }
    cd(1.0);
    sim.log(`🤚 ${p.name} 没采到（手慢了）`);
    return { kind: 'pickup-fail' };
  }

  // 5. 航点与篝火/庇护所交互
  const wp = sim.nearestBuildingByTag('waypoint', p.pos.x, p.pos.y, r);
  if (wp) {
    const others = sim.world.buildingsByTag('waypoint');
    let other: BuildingState | null = null;
    let bestD = Infinity;
    for (const b of others) {
      if (b.id === wp.id) continue;
      const d = Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y);
      if (d < bestD) {
        bestD = d;
        other = b;
      }
    }
    if (other) {
      const from = { ...p.pos };
      if (sim.playerRimWorldMode) {
        sim.setPath(p, other.pos.x, other.pos.y);
        cd(1.0);
        sim.log(`🚶 ${p.name} 朝航点 (${other.pos.x},${other.pos.y}) 步行前进`);
        return { kind: 'use', tag: 'waypoint' };
      }
      p.pos = { x: other.pos.x, y: other.pos.y };
      p.path = [];
      cd(1.0);
      sim.log(`🌀 ${p.name} 沿航点传送到了 ${other.pos.x},${other.pos.y}`);
      return { kind: 'teleport', from, to: { ...p.pos } };
    }
  }

  for (const tag of ['fire', 'shelter'] as const) {
    const b = sim.nearestBuildingByTag(tag, p.pos.x, p.pos.y, r);
    if (!b) continue;
    p.needs.mood = Math.min(100, p.needs.mood + 3);
    p.needs.san = Math.min(100, p.needs.san + 3);
    cd(1.0);
    sim.log(`🔥 ${p.name} 在 ${b.defId} 旁歇了歇（心情/理智 +3）`);
    return { kind: 'use', tag };
  }
  return { kind: 'none' };
}

export function dispatchSimCommand(
  sim: Sim,
  type: string,
  args: Record<string, unknown> = {},
  source: 'player' | 'system' = 'player',
): void {
  if (type === 'move') {
    const eids = ((args.eids as Eid[]) ?? (args.eid !== undefined ? [args.eid as Eid] : sim.selected)).filter(
      (e) => sim.pawnMap.has(e),
    );
    const tx = args.x as number;
    const ty = args.y as number;
    for (const eid of eids) {
      const p = sim.pawnMap.get(eid)!;
      p.cardId = null;
      p.busyUntil = 0;
      p.holdUntil = sim.time + 5;
      if (!sim.setPath(p, tx, ty)) {
        sim.log(`⚠ ${p.name} 无法行进至 (${tx},${ty})（山体阻挡、高差无斜坡或超出视野范围）`);
      }
    }
    return;
  }
  if (type === 'draft') {
    const eids = ((args.eids as Eid[]) ?? (args.eid !== undefined ? [args.eid as Eid] : sim.selected)).filter((e) => sim.pawnMap.has(e));
    setPawnDrafted(sim, eids, Boolean(args.drafted ?? true));
    return;
  }
  if (type === 'attack_hostile') {
    const eids = ((args.eids as Eid[]) ?? (args.eid !== undefined ? [args.eid as Eid] : sim.selected)).filter((e) => sim.pawnMap.has(e));
    orderPawnAttackHostile(sim, eids, Number(args.hostileId));
    return;
  }
  if (type === 'work_priority') {
    setPawnWorkPriority(sim, Number(args.eid), args.workId as RimWorldWorkType, Number(args.priority) as 0 | 1 | 2 | 3 | 4);
    return;
  }
  if (type === 'architect_build') {
    placeArchitectBuilding(
      sim,
      String(args.defId),
      Number(args.x),
      Number(args.y),
      (Number(args.rot ?? 0) % 4) as 0 | 1 | 2 | 3,
      String(args.ownerPlayerId ?? sim.activePlayerId),
    );
    return;
  }
  if (type === 'architect_order') {
    executeArchitectOrder(sim, args.orderKind as 'mine' | 'chop' | 'harvest' | 'deconstruct', Number(args.x), Number(args.y), args.eid as Eid | undefined);
    return;
  }
  if (type === 'use_skill') {
    usePawnSkill(sim, Number(args.eid), Number(args.slotIndex ?? 0));
    return;
  }
  if (type === 'splice_gene') {
    const p = sim.pawnMap.get(Number(args.eid));
    if (p && spliceGene(p, String(args.geneId))) {
      sim.log(`🧬 ${p.name} 植入了基因：${String(args.geneId)}`);
    }
    return;
  }
  if (type === 'pawn_trade') {
    executePawnToPawnTrade(
      sim,
      Number(args.initiatorEid),
      Number(args.targetEid),
      String(args.giveItem ?? 'wood'),
      Number(args.giveQty ?? 2),
      String(args.wantItem ?? 'food'),
      Number(args.wantQty ?? 2),
    );
    return;
  }
  if (type === 'group_zero_trade') {
    executeZeroPriceGroupTrade(
      sim,
      String(args.fromGroupId ?? 'group_alpha'),
      String(args.toGroupId ?? 'group_beta'),
      (args.transfers as Record<string, number>) ?? {},
    );
    return;
  }
  if (type === 'assign_group') {
    assignPawnToGroup(sim, Number(args.eid), String(args.groupId ?? 'group_alpha'));
    return;
  }
  if (type === 'loot_corpse') {
    if (args.selectedQuantities) {
      lootSelectedFromCorpse(
        sim,
        Number(args.corpseEid),
        args.looterEid !== undefined ? Number(args.looterEid) : (args.selectedQuantities as Record<string, number>),
        args.looterEid !== undefined ? (args.selectedQuantities as Record<string, number>) : undefined,
      );
    } else {
      lootCorpse(sim, Number(args.corpseEid), args.looterEid !== undefined ? Number(args.looterEid) : undefined);
    }
    return;
  }
  if (type === 'scavenge_building') {
    orderScavengeRuinBuilding(
      sim,
      String(args.buildingId),
      args.actorEid !== undefined ? Number(args.actorEid) : undefined,
      args.groupId ? String(args.groupId) : undefined,
    );
    return;
  }
  if (type === 'cook_dish') {
    cookCulinaryDish(
      sim,
      String(args.recipeId ?? 'dish_golden_fried_rice'),
      args.cookEid !== undefined ? Number(args.cookEid) : undefined,
      Boolean(args.allowAutoSubstitute ?? true),
    );
    return;
  }
  if (type === 'eat_dish') {
    consumeCulinaryDish(
      sim,
      Number(args.pawnEid ?? 1),
      args.dishId ? String(args.dishId) : undefined,
    );
    return;
  }
  if (type === 'scavenge_ruin') {
    scavengeRuinSite(
      sim,
      String(args.siteId),
      String(args.groupId ?? 'group_beta'),
      args.actorEid !== undefined ? Number(args.actorEid) : undefined,
    );
    return;
  }
  if (type === 'mmo_kidnap') {
    kidnapFromFaction(sim, String(args.baseId));
    return;
  }
  if (type === 'mmo_steal') {
    stealFromFaction(sim, String(args.baseId), args.actorEid !== undefined ? Number(args.actorEid) : undefined, String(args.item ?? 'gold'));
    return;
  }
  if (type === 'autopsy_corpse') {
    harvestCorpseOrgan(sim, Number(args.corpseEid));
    return;
  }
  if (type === 'bury_corpse') {
    buryOrCremateCorpse(sim, Number(args.corpseEid));
    return;
  }
  if (type === 'deploy_killbox') {
    deployKillboxTrapMaze(sim, Number(args.x ?? 8), Number(args.y ?? 0));
    return;
  }
  if (type === 'dispense_paste') {
    dispenseNutrientPasteMeals(sim, Number(args.batches ?? 4));
    return;
  }
  if (type === 'super_soldier') {
    createBiotechSuperSoldier(sim, args.eid !== undefined ? Number(args.eid) : undefined);
    return;
  }
  if (type === 'breach_ancient_danger') {
    breachAncientDangerShrine(sim, Number(args.x ?? -8), Number(args.y ?? -6));
    return;
  }
  if (type === 'bandage_part') {
    bandageBodyPartWithHerb(sim, Number(args.patientEid), String(args.partId), args.doctorEid ? Number(args.doctorEid) : undefined);
    return;
  }
  if (type === 'amputate_part') {
    amputateBodyPart(sim, Number(args.patientEid), String(args.partId));
    return;
  }
  if (type === 'transplant_part') {
    transplantBodyPart(sim, Number(args.patientEid), String(args.partId), Boolean(args.bionic));
    return;
  }
  if (type === 'raid_spawn') {
    spawnPlayerRaidSquad(sim, {
      unitKind: String(args.unitKind ?? 'raider_rat_scout'),
      count: Number(args.count ?? 1),
      entryDirection: (args.entryDirection as 'N' | 'E' | 'S' | 'W') ?? 'E',
      targetPos: args.targetPos as Pos | undefined,
    });
    return;
  }
  if (type === 'raid_order') {
    orderPlayerRaiders(sim, {
      raiderIds: args.raiderIds as number[] | undefined,
      mode: (args.mode as 'march' | 'focus_pawn' | 'breach_building' | 'retreat' | 'war_cry') ?? 'march',
      targetPos: args.targetPos as Pos | undefined,
      targetEid: args.targetEid as Eid | undefined,
      targetBuildingId: args.targetBuildingId as string | undefined,
    });
    return;
  }
  if (type === 'switch_role') {
    switchPlayerRole(sim, (args.role as 'colony' | 'raider') ?? 'colony');
    return;
  }
  if (type === 'base_trade') {
    tradeWithNpcBase(sim, String(args.baseId), Number(args.offerIndex ?? 0));
    return;
  }
  if (type === 'base_gift') {
    giftNpcBase(sim, String(args.baseId), String(args.item ?? 'wood'), Number(args.amount ?? 10));
    return;
  }
  if (type === 'base_ally') {
    requestAllyReinforcements(sim, String(args.baseId));
    return;
  }
  if (type === 'base_assault') {
    assaultNpcBase(sim, String(args.baseId));
    return;
  }
  if (type === 'dlc_toggle') {
    toggleSimDlc(sim, String(args.dlcId), args.enable as boolean | undefined);
    return;
  }
  const handler = sim.reg.commands.get(type);
  if (handler) handler(sim, args, source);
  else sim.log(`⚠ 未知命令：${type}`);
}

export function executeChooseDialogueOption(
  sim: Sim,
  i: number,
): 'applied' | 'rejected' | 'closed' | 'invalid' {
  if (!sim.dialogue) return 'invalid';
  const { npcEid, dialogueId } = sim.dialogue;
  let hero: PawnState | undefined;
  for (const p of sim.pawnMap.values()) {
    if (p.controlledBy !== undefined) {
      hero = p;
      break;
    }
  }
  const npc = sim.pawnMap.get(npcEid);
  if (!hero && npc) {
    let bestD = Infinity;
    for (const p of sim.pawnMap.values()) {
      if (p.eid === npc.eid) continue;
      const d = Math.hypot(p.pos.x - npc.pos.x, p.pos.y - npc.pos.y);
      if (d < bestD) {
        bestD = d;
        hero = p;
      }
    }
  }
  if (
    !hero ||
    !npc ||
    Math.hypot(hero.pos.x - npc.pos.x, hero.pos.y - npc.pos.y) > sim.tuning.hero.interactRange
  ) {
    sim.closeDialogue();
    return 'closed';
  }
  const def = sim.tuning.dialogues[dialogueId];
  const opt = def?.options[i];
  if (!opt) {
    sim.closeDialogue();
    return 'invalid';
  }
  if (opt.rollSuccess && !sim.rollSuccess(sim.tuning.successRate.dialogue)) {
    sim.log(`💬 ${def.name} 摇头拒绝了`);
    sim.closeDialogue();
    return 'rejected';
  }
  if (opt.stock) {
    for (const [k, v] of Object.entries(opt.stock)) {
      sim.stockpile[k] = (sim.stockpile[k] ?? 0) + v;
    }
    sim.log(`💬 收下物资：${JSON.stringify(opt.stock)}`);
  }
  if (opt.techFragment) {
    const r = sim.grantTechFragment(opt.techFragment);
    if (r === 'unknown') sim.log(`💬 「${def.name}」提到的委托还没有对应的科技池条目`);
    else sim.log(`💬 委托进度：${opt.techFragment} ${r}`);
  }
  if (opt.close) {
    sim.closeDialogue();
    return 'closed';
  }
  return 'applied';
}
