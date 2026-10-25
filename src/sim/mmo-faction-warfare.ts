/**
 * mmo-faction-warfare.ts —— Online MMO 跨阵营探险、开战、盗窃 (`-25` 好感)、绑架 (`-45` 好感)
 *                           以及不同关系等级 (`ally` / `neutral` / `hostile` / `nemesis`) 的差异化做法。
 */
import { getNpcBases } from './npc-bases';
import { ensurePawnTriads } from './triad-specialization';
import type { Eid } from './types';
import type { Sim } from './sim';

/** 盗窃自动降低的好感度 */
export const STEAL_REP_PENALTY = -25;
/** 绑架自动降低的好感度 */
export const KIDNAP_REP_PENALTY = -45;

export type FactionRelationTier = 'ally' | 'neutral' | 'hostile' | 'nemesis';

export interface FactionBehaviorRule {
  tier: FactionRelationTier;
  tierLabel: string;
  canTrade: boolean;
  canRequestAid: boolean;
  shootsOnSight: boolean;
  sendsRetaliationRaids: boolean;
  priceDiscountPct: number;
  behaviorSummary: string;
}

export function getFactionRelationTier(reputation: number): FactionRelationTier {
  if (reputation >= 40) return 'ally';
  if (reputation >= 0) return 'neutral';
  if (reputation > -70) return 'hostile';
  return 'nemesis';
}

/**
 * 不同关系等级对应不同的阵营做法（既支持直接传入好感数值 `reputation: number`，也支持传入 `(sim, baseId)`）：
 *  - `ally` (`>= 40`)：开放优惠贸易、可呼叫盟军空投驰援、绝不主动攻击。
 *  - `neutral` (`0 .. 39`)：仅允许常规贸易与赠礼，不派援军，若遭盗窃/绑架会立刻翻脸。
 *  - `hostile` (`-69 .. -1`)：全面断绝贸易，见本阵营小鼠即开火射击 (`shootsOnSight = true`)。
 *  - `nemesis` (`<= -70`)：死敌血仇，不仅见面格杀勿论，还会定期主动派遣报复袭击部队 (`sendsRetaliationRaids = true`)！
 */
export function getFactionBehaviorByRelation(
  repOrSim: number | Sim,
  maybeBaseId?: string,
): FactionBehaviorRule {
  let reputation = 0;
  if (typeof repOrSim === 'number') {
    reputation = repOrSim;
  } else if (maybeBaseId) {
    reputation = getNpcBases(repOrSim).get(maybeBaseId)?.reputation ?? 0;
  }
  const tier = getFactionRelationTier(reputation);
  switch (tier) {
    case 'ally':
      return {
        tier,
        tierLabel: '生死盟友 (Ally)',
        canTrade: true,
        canRequestAid: true,
        shootsOnSight: false,
        sendsRetaliationRaids: false,
        priceDiscountPct: 20,
        behaviorSummary: '开放盟友贸易折扣 (-20%)、允许呼叫火枪队驰援、共享边境视野。',
      };
    case 'neutral':
      return {
        tier,
        tierLabel: '中立观望 (Neutral)',
        canTrade: true,
        canRequestAid: false,
        shootsOnSight: false,
        sendsRetaliationRaids: false,
        priceDiscountPct: 0,
        behaviorSummary: '允许常规商队贸易与赠礼；若发生盗窃或绑架将大幅降低好感并转为敌对。',
      };
    case 'hostile':
      return {
        tier,
        tierLabel: '敌对交战 (Hostile)',
        canTrade: false,
        canRequestAid: false,
        shootsOnSight: true,
        sendsRetaliationRaids: false,
        priceDiscountPct: 0,
        behaviorSummary: '全面封锁贸易，巡逻队见到我方探险小鼠立即开火拦截。',
      };
    case 'nemesis':
      return {
        tier,
        tierLabel: '死敌血仇 (Nemesis)',
        canTrade: false,
        canRequestAid: false,
        shootsOnSight: true,
        sendsRetaliationRaids: true,
        priceDiscountPct: 0,
        behaviorSummary: '不死不休！见面格杀勿论，且主动派遣精锐掠夺小队突袭我方基地。',
      };
  }
}

export interface FactionCrimeOutcome {
  ok: boolean;
  crimeKind: 'steal' | 'kidnap';
  baseId: string;
  repBefore: number;
  repAfter: number;
  repDelta: number;
  relationTierAfter: FactionRelationTier;
  behaviorAfter: FactionBehaviorRule;
  stolenLoot?: Record<string, number>;
  kidnappedPawnEid?: Eid;
  retaliationSpawnedCount: number;
  message: string;
}

export function stealFromFaction(
  sim: Sim,
  baseId: string,
  actorEid?: Eid,
  targetItem = 'gold',
): FactionCrimeOutcome {
  const base = getNpcBases(sim).get(baseId);
  const actor = (actorEid ? sim.pawn(actorEid) : undefined) ?? [...sim.pawns()].find((p) => !p.isStranger);
  if (!base || base.defeated) {
    return {
      ok: false,
      crimeKind: 'steal',
      baseId,
      repBefore: 0,
      repAfter: 0,
      repDelta: 0,
      relationTierAfter: 'neutral',
      behaviorAfter: getFactionBehaviorByRelation(0),
      retaliationSpawnedCount: 0,
      message: '目标阵营据点不存在或已被摧毁',
    };
  }

  const repBefore = base.reputation;
  base.reputation = Math.max(-100, base.reputation + STEAL_REP_PENALTY);
  const repAfter = base.reputation;
  const behaviorAfter = getFactionBehaviorByRelation(repAfter);
  if (behaviorAfter.shootsOnSight) {
    base.attitude = 'hostile';
  }

  const avail = base.lootStock[targetItem] ?? 0;
  const stolenQty = avail > 0 ? Math.min(avail, 4) : 3;
  if (avail > 0) base.lootStock[targetItem] = Math.max(0, avail - stolenQty);
  sim.stockpile[targetItem] = (sim.stockpile[targetItem] ?? 0) + stolenQty;

  let retaliationSpawnedCount = 0;
  if (behaviorAfter.shootsOnSight) {
    sim.spawnHostile('raider', base.pos.x - 2, base.pos.y);
    retaliationSpawnedCount = 1;
  }

  const msg = `🕵【阵营盗窃】${actor ? actor.name : '探险队'} 从【${base.name}】窃取了 ${stolenQty} ${targetItem}！好感度自动降低 ${STEAL_REP_PENALTY}（${repBefore} → ${repAfter}，当前关系：${behaviorAfter.tierLabel}）`;
  sim.log(msg);
  return {
    ok: true,
    crimeKind: 'steal',
    baseId,
    repBefore,
    repAfter,
    repDelta: STEAL_REP_PENALTY,
    relationTierAfter: behaviorAfter.tier,
    behaviorAfter,
    stolenLoot: { [targetItem]: stolenQty },
    retaliationSpawnedCount,
    message: msg,
  };
}

export function kidnapFromFaction(sim: Sim, baseId: string, actorEid?: Eid): FactionCrimeOutcome {
  const base = getNpcBases(sim).get(baseId);
  const actor = (actorEid ? sim.pawn(actorEid) : undefined) ?? [...sim.pawns()].find((p) => !p.isStranger);
  if (!base || base.defeated || base.garrisonCount <= 0) {
    return {
      ok: false,
      crimeKind: 'kidnap',
      baseId,
      repBefore: base?.reputation ?? 0,
      repAfter: base?.reputation ?? 0,
      repDelta: 0,
      relationTierAfter: getFactionRelationTier(base?.reputation ?? 0),
      behaviorAfter: getFactionBehaviorByRelation(base?.reputation ?? 0),
      retaliationSpawnedCount: 0,
      message: '目标阵营据点已无驻军可供绑架',
    };
  }

  const repBefore = base.reputation;
  base.reputation = Math.max(-100, base.reputation + KIDNAP_REP_PENALTY);
  const repAfter = base.reputation;
  base.garrisonCount = Math.max(0, base.garrisonCount - 1);

  const behaviorAfter = getFactionBehaviorByRelation(repAfter);
  if (behaviorAfter.shootsOnSight) {
    base.attitude = 'hostile';
  }

  const newEid = sim.spawnPawn((actor?.pos.x ?? 0) + 1, (actor?.pos.y ?? 0) + 1);
  const captured = sim.pawn(newEid);
  if (captured) {
    captured.name = `俘虏鼠·#${newEid}(原${base.factionName.slice(0, 2)})`;
    captured.xenotype = base.xenotype;
    captured.groupId = 'group_beta';
    ensurePawnTriads(captured, sim.world.seed);
  }

  let retaliationSpawnedCount = 0;
  if (behaviorAfter.shootsOnSight) {
    const wave = behaviorAfter.sendsRetaliationRaids ? 2 : 1;
    for (let i = 0; i < wave; i++) {
      sim.spawnHostile('raider', base.pos.x - 3 + i, base.pos.y - 2);
      retaliationSpawnedCount++;
    }
  }

  const msg = `⛓【阵营绑架】${actor ? actor.name : '探险队'} 突袭【${base.name}】绑架了 1 名驻军归入我方！好感度暴跌 ${KIDNAP_REP_PENALTY}（${repBefore} → ${repAfter}，当前关系：${behaviorAfter.tierLabel}，敌方派出 ${retaliationSpawnedCount} 名追兵）`;
  sim.log(msg);
  return {
    ok: true,
    crimeKind: 'kidnap',
    baseId,
    repBefore,
    repAfter,
    repDelta: KIDNAP_REP_PENALTY,
    relationTierAfter: behaviorAfter.tier,
    behaviorAfter,
    kidnappedPawnEid: newEid,
    retaliationSpawnedCount,
    message: msg,
  };
}
