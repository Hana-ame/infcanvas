/**
 * multiplayer-raid.ts —— 多人对战 / 联机对战 / 玩家扮演 Raid 袭击指挥官系统。
 *
 * 核心设计（响应需求：「新东西主要专注于代码优化，多人对战，联机对战等。Raid 等由玩家扮演」）：
 *  1. **双阵营非对称/对称联机对战（Colony Defender vs Raid Commander）**：
 *     - 殖民地防守方（role = 'colony'）：建设基地、开采矿物、配置小人工作优先级、征召防守、远征野生据点。
 *     - 袭击扮演方（role = 'raider'）：消耗随时间与殖民地财富增长的「袭击威胁点数（Raid Threat Points）」，
 *       在地图四方边缘（N/E/S/W）或任意敌对野生据点（赤爪营地/锈牙要塞）投放袭击小队，
 *       并可实时框选、下达推进（march）、集火（focus_pawn）、破墙（breach_building）、撤退（retreat）或战吼技能！
 *  2. **群体流场寻路加速（FlowFieldPlanner）**：
 *     当玩家操控多只 Raider 袭击同一目标时，自动复用 `FlowFieldPlanner` 共享积分向量场，消除多单位 A* 尖峰。
 */
import { FlowFieldPlanner } from './hpa-infinite';
import { getNpcBases } from './npc-bases';
import type { Eid, Hostile, Pos } from './types';
import type { Sim } from './sim';

export type PlayerRole = 'colony' | 'raider' | 'spectator';

export interface RaiderUnitDef {
  id: string;
  name: string;
  costPts: number;
  hp: number;
  dmg: number;
  speed: number;
  atkCd: number;
  climb: number;
  attackRange: number;
  roleDesc: string;
  breacher?: boolean;
}

export const RAIDER_UNIT_DEFS: Record<string, RaiderUnitDef> = {
  raider_rat_scout: {
    id: 'raider_rat_scout',
    name: '疾风鼠斥候 (Ratkin Scout)',
    costPts: 15,
    hp: 28,
    dmg: 4,
    speed: 4.8,
    atkCd: 1.1,
    climb: 2,
    attackRange: 1.4,
    roleDesc: '高机动轻装斥候，擅长绕后骚扰采集者与落单殖民者。',
  },
  raider_sapper: {
    id: 'raider_sapper',
    name: '爆破工兵鼠 (Sapper Breacher)',
    costPts: 25,
    hp: 36,
    dmg: 6,
    speed: 4.1,
    atkCd: 1.4,
    climb: 2,
    attackRange: 1.5,
    roleDesc: '携带掘地炸药，优先爆破围墙、哨塔与防御设施（对建筑 3 倍伤害）。',
    breacher: true,
  },
  raider_shield: {
    id: 'raider_shield',
    name: '重甲鼠卫兵 (Shield Marauder)',
    costPts: 35,
    hp: 68,
    dmg: 6,
    speed: 3.6,
    atkCd: 1.5,
    climb: 1,
    attackRange: 1.4,
    roleDesc: '手持防暴钢盾的重装前排，吸收哨塔与步枪火力。',
  },
  raider_sniper: {
    id: 'raider_sniper',
    name: '赤爪神射鼠 (Crossbow Sniper)',
    costPts: 30,
    hp: 32,
    dmg: 8,
    speed: 4.0,
    atkCd: 1.8,
    climb: 2,
    attackRange: 5.5,
    roleDesc: '远程重弩射手，可在围墙外远距离狙击殖民者。',
  },
  raider_boss: {
    id: 'raider_boss',
    name: '赤爪督军 (Redclaw Warlord)',
    costPts: 60,
    hp: 120,
    dmg: 12,
    speed: 4.3,
    atkCd: 1.2,
    climb: 3,
    attackRange: 1.8,
    roleDesc: '精锐袭击首领，拥有战吼加速光环与高额近战破甲伤害。',
    breacher: true,
  },
};

export interface PlayerRaidOrder {
  mode: 'march' | 'focus_pawn' | 'breach_building' | 'retreat';
  targetPos?: Pos;
  targetEid?: Eid;
  targetBuildingId?: string;
}

export interface MultiplayerMatchState {
  localRole: PlayerRole;
  raidPoints: number;
  maxRaidPoints: number;
  raidPointsPerSec: number;
  totalRaidsSpawned: number;
  raiderScore: number;
  colonyScore: number;
  connectedPlayers: { id: string; name: string; role: PlayerRole; pingMs: number }[];
  raiderOrders: Map<number, PlayerRaidOrder>;
  activeFlowField: FlowFieldPlanner | null;
  warCryUntil: number;
}

const matchStates = new WeakMap<Sim, MultiplayerMatchState>();

/** 确保袭击兵种已注册进 sim.tuning.enemies 表 */
export function ensureRaiderUnitsRegistered(sim: Sim): void {
  for (const def of Object.values(RAIDER_UNIT_DEFS)) {
    if (!sim.tuning.enemies[def.id]) {
      sim.tuning.enemies[def.id] = {
        name: def.name,
        hp: def.hp,
        dmg: def.dmg,
        speed: def.speed,
        atkCd: def.atkCd,
        climb: def.climb,
        drops: { ore: 2, gold: 1 },
      };
    }
  }
}

export function getMultiplayerState(sim: Sim): MultiplayerMatchState {
  let st = matchStates.get(sim);
  if (!st) {
    ensureRaiderUnitsRegistered(sim);
    st = {
      localRole: 'colony',
      raidPoints: 100,
      maxRaidPoints: 300,
      raidPointsPerSec: 2.5,
      totalRaidsSpawned: 0,
      raiderScore: 0,
      colonyScore: 100,
      connectedPlayers: [
        { id: 'p_local_1', name: 'Player 1 (Host)', role: 'colony', pingMs: 12 },
        { id: 'p_raider_2', name: 'Player 2 (Raid Commander)', role: 'raider', pingMs: 24 },
      ],
      raiderOrders: new Map(),
      activeFlowField: null,
      warCryUntil: 0,
    };
    matchStates.set(sim, st);
  }
  return st;
}

/** 切换玩家操控身份（殖民地执政官 vs 袭击指挥官） */
export function switchPlayerRole(sim: Sim, role: PlayerRole, playerId = 'p_local_1'): MultiplayerMatchState {
  const st = getMultiplayerState(sim);
  st.localRole = role;
  const p = st.connectedPlayers.find((x) => x.id === playerId);
  if (p) p.role = role;
  sim.log(`🎮 玩家切换身份为：${role === 'raider' ? '⚔ 袭击指挥官 (Raid Commander)' : '🏛 殖民地执政官 (Colony Defender)'}`);
  return st;
}

/**
 * 玩家扮演 Raid：消耗威胁点数投放一支袭击小队
 */
export function spawnPlayerRaidSquad(
  sim: Sim,
  opts: {
    unitKind: string;
    count?: number;
    entryDirection?: 'N' | 'E' | 'S' | 'W' | 'base_redclaw_camp' | 'base_rustfang_fort';
    targetPos?: Pos;
  },
): { ok: boolean; spawnedIds: number[]; message: string } {
  ensureRaiderUnitsRegistered(sim);
  const st = getMultiplayerState(sim);
  const def = RAIDER_UNIT_DEFS[opts.unitKind];
  if (!def) return { ok: false, spawnedIds: [], message: `未知袭击兵种：${opts.unitKind}` };

  const count = Math.max(1, Math.min(10, Math.round(opts.count ?? 1)));
  const totalCost = def.costPts * count;
  if (st.raidPoints < totalCost) {
    return {
      ok: false,
      spawnedIds: [],
      message: `袭击点数不足：需要 ${totalCost} pt（当前 ${Math.floor(st.raidPoints)} pt）`,
    };
  }

  // 计算投放坐标：支持从敌对 NPC 据点或四方边缘入场
  const camp = sim.campPos() ?? { x: 0, y: 0 };
  let origin: Pos = { x: camp.x + 22, y: camp.y };
  const dir = opts.entryDirection ?? 'E';
  if (dir === 'N') origin = { x: camp.x, y: camp.y - 22 };
  else if (dir === 'S') origin = { x: camp.x, y: camp.y + 22 };
  else if (dir === 'W') origin = { x: camp.x - 22, y: camp.y };
  else if (dir === 'E') origin = { x: camp.x + 22, y: camp.y };
  else {
    const base = getNpcBases(sim).get(dir);
    if (base && !base.defeated) origin = { x: base.pos.x, y: base.pos.y };
  }

  const spawnedIds: number[] = [];
  for (let i = 0; i < count; i++) {
    // 螺旋找可站立格
    let sx = Math.round(origin.x + (i % 3) - 1);
    let sy = Math.round(origin.y + Math.floor(i / 3) - 1);
    if (!sim.passable(sx, sy)) {
      outer: for (let r = 1; r <= 15; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (sim.passable(sx + dx, sy + dy)) {
              sx += dx;
              sy += dy;
              break outer;
            }
          }
        }
      }
    }
    const h = sim.spawnHostile(def.id, sx, sy);
    spawnedIds.push(h.id);
    st.raiderOrders.set(h.id, {
      mode: 'march',
      targetPos: opts.targetPos ?? { x: camp.x, y: camp.y },
    });
  }

  st.raidPoints -= totalCost;
  st.totalRaidsSpawned += spawnedIds.length;
  st.raiderScore += count * 10;
  st.activeFlowField = new FlowFieldPlanner(sim.world, camp.x, camp.y, 40, def.climb);

  const msg = `🚨【玩家袭击】指挥官从 ${dir} 方向投放了 ${count} 名 ${def.name}！（消耗 ${totalCost} pt）`;
  sim.log(msg);
  return { ok: true, spawnedIds, message: msg };
}

/**
 * 玩家扮演 Raid：对场上袭击单位下达战术指令（推进 / 集火小人 / 破墙拆建筑 / 撤退 / 战吼）
 */
export function orderPlayerRaiders(
  sim: Sim,
  cmd: {
    raiderIds?: number[];
    mode: 'march' | 'focus_pawn' | 'breach_building' | 'retreat' | 'war_cry';
    targetPos?: Pos;
    targetEid?: Eid;
    targetBuildingId?: string;
  },
): { ok: boolean; affected: number; message: string } {
  const st = getMultiplayerState(sim);
  const allHostiles = sim.hostiles();
  const targetIds =
    cmd.raiderIds && cmd.raiderIds.length > 0
      ? new Set(cmd.raiderIds)
      : new Set(allHostiles.map((h) => h.id));

  if (cmd.mode === 'war_cry') {
    if (st.raidPoints < 20) return { ok: false, affected: 0, message: '战吼需要 20 袭击点数' };
    st.raidPoints -= 20;
    st.warCryUntil = sim.time + 12;
    const msg = `🔥【袭击战吼】玩家袭击部队进入狂暴急行军状态（移速+30%，持续 12s）！`;
    sim.log(msg);
    return { ok: true, affected: allHostiles.length, message: msg };
  }

  let affected = 0;
  for (const h of allHostiles) {
    if (!targetIds.has(h.id)) continue;
    st.raiderOrders.set(h.id, {
      mode: cmd.mode,
      targetPos: cmd.targetPos,
      targetEid: cmd.targetEid,
      targetBuildingId: cmd.targetBuildingId,
    });
    affected++;
  }

  if (cmd.mode === 'march' && cmd.targetPos) {
    st.activeFlowField = new FlowFieldPlanner(
      sim.world,
      Math.round(cmd.targetPos.x),
      Math.round(cmd.targetPos.y),
      40,
      2,
    );
  }

  const labelMap = {
    march: `向 (${Math.round(cmd.targetPos?.x ?? 0)}, ${Math.round(cmd.targetPos?.y ?? 0)}) 协同推进`,
    focus_pawn: `集火殖民者 #${cmd.targetEid ?? ''}`,
    breach_building: `爆破建筑 #${cmd.targetBuildingId ?? ''}`,
    retreat: '向地图边缘战术撤退',
  };
  const msg = `🚩【袭击指挥】已向 ${affected} 名袭击者下达指令：${labelMap[cmd.mode]}`;
  sim.log(msg);
  return { ok: true, affected, message: msg };
}

/**
 * 推进玩家扮演的 Raider 战术动作与点数经济（由 RimWorld HUD / 联机循环或命令驱动）
 */
export function tickPlayerControlledRaiders(sim: Sim, dt: number): void {
  const st = getMultiplayerState(sim);
  // 威胁点数随时间与殖民地规模增长
  const wealthBonus = Math.min(3.5, [...sim.world.buildings.values()].length * 0.15);
  st.raidPoints = Math.min(st.maxRaidPoints, st.raidPoints + (st.raidPointsPerSec + wealthBonus) * dt);

  const warCryMul = sim.time < st.warCryUntil ? 1.3 : 1.0;

  for (const h of [...sim.hostiles()]) {
    const unitDef = RAIDER_UNIT_DEFS[h.kind];
    const order = st.raiderOrders.get(h.id);
    if (!unitDef && !order) continue;

    const speed = (unitDef?.speed ?? 4.2) * warCryMul;
    const range = unitDef?.attackRange ?? 1.5;
    const dmg = unitDef?.dmg ?? 5;

    // 1. 破墙工兵逻辑：若指定建筑或邻近阻挡建筑，则直接攻击建筑
    if (order?.mode === 'breach_building' || unitDef?.breacher) {
      let targetB = order?.targetBuildingId ? sim.world.buildings.get(order.targetBuildingId) : undefined;
      if (!targetB) {
        let bestD = 12;
        for (const b of sim.world.buildings.values()) {
          const d = Math.hypot(b.pos.x - h.pos.x, b.pos.y - h.pos.y);
          if (d < bestD) {
            bestD = d;
            targetB = b;
          }
        }
      }
      if (targetB) {
        const d = Math.hypot(targetB.pos.x - h.pos.x, targetB.pos.y - h.pos.y);
        if (d <= range + 0.8) {
          if (h.atkCd <= 0) {
            targetB.hp -= dmg * (unitDef?.breacher ? 2.5 : 1.2);
            h.atkCd = unitDef?.atkCd ?? 1.4;
            if (targetB.hp <= 0) {
              sim.removeBuilding(targetB.id);
              st.raiderScore += 25;
              sim.log(`💥 袭击工兵摧毁了殖民地建筑 ${targetB.defId}！`);
            }
          }
          continue;
        }
      }
    }

    // 2. 集火指定殖民者或远程弩手射击
    if (order?.mode === 'focus_pawn' && order.targetEid !== undefined) {
      const targetPawn = sim.pawn(order.targetEid);
      if (targetPawn) {
        const d = Math.hypot(targetPawn.pos.x - h.pos.x, targetPawn.pos.y - h.pos.y);
        if (d <= range) {
          if (h.atkCd <= 0) {
            sim.damagePawn(targetPawn.eid, dmg, `${unitDef?.name ?? h.kind}精准狙击`);
            h.atkCd = unitDef?.atkCd ?? 1.4;
          }
          continue;
        } else {
          stepHostileToward(sim, h, targetPawn.pos, speed * dt);
          continue;
        }
      }
    }

    // 3. 远程射手在射程内自动射击最近殖民者
    if (range > 2.0) {
      let nearest: { eid: Eid; pos: Pos; d: number } | null = null;
      for (const p of sim.pawns()) {
        const d = Math.hypot(p.pos.x - h.pos.x, p.pos.y - h.pos.y);
        if (d <= range && (!nearest || d < nearest.d)) {
          nearest = { eid: p.eid, pos: p.pos, d };
        }
      }
      if (nearest && h.atkCd <= 0) {
        sim.damagePawn(nearest.eid, dmg, `${unitDef?.name ?? '远程袭击者'}射击`);
        h.atkCd = unitDef?.atkCd ?? 1.6;
        continue;
      }
    }

    // 4. 推进或撤退位移（优先走 FlowField）
    if (order?.mode === 'retreat') {
      stepHostileToward(sim, h, { x: h.pos.x + 20, y: h.pos.y + 20 }, speed * dt);
    } else if (order?.mode === 'march' && order.targetPos) {
      const ffStep = st.activeFlowField?.nextStepFrom(h.pos.x, h.pos.y);
      if (ffStep) {
        stepHostileToward(sim, h, ffStep, speed * 0.45 * dt);
      } else {
        stepHostileToward(sim, h, order.targetPos, speed * 0.45 * dt);
      }
    }
  }
}

function stepHostileToward(sim: Sim, h: Hostile, to: Pos, budget: number): void {
  const dx = to.x - h.pos.x;
  const dy = to.y - h.pos.y;
  const d = Math.hypot(dx, dy);
  if (d <= 0.01) return;
  const step = Math.min(1, budget / d);
  const nx = h.pos.x + dx * step;
  const ny = h.pos.y + dy * step;
  if (sim.passable(Math.round(nx), Math.round(ny))) {
    h.pos.x = nx;
    h.pos.y = ny;
  }
}
