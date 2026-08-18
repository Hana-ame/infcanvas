// 存档/读档逻辑（2026-08-16 文件结构拆分：从 sim.ts 抽出，~140 行 → 独立维护）
// 设计：saveSim 返回全量序列化状态；loadSim 按版本迁移+还原。版本化（SAVE_VERSION=1 +
// SAVE_MIGRATIONS 迁移表）保证旧档兼容 + 新格式防旧版误读。
import type { Sim } from './sim';
import type { SaveData } from './types';
import type { ChunkData } from './core/world';
import { World } from './core/world';
import { BASE_CARDS, TRAIT_CARDS, cardFromDef } from './ai/pawn';
import type { BehaviorCard } from './ai/pawn';
import { INTERESTS } from './defs/interests';
import { initDesires } from './core/desires';
import { TUNING } from './defs/tuning';

// 兴趣卡静态表（id → 卡）：存档 load/save 按卡 id 还原用（与 TRAIT_CARDS 同策略）。
// 背景：兴趣休闲卡（interest:xxx）是 initSlots 注入卡槽的，不属于 mods.cards/基础卡/天赋卡，
// load 时若不查此表 → 还原成 null → 娱乐活动丢失（存档往返测试暴露）。v2026-08-13。
const INTEREST_CARDS: Map<string, BehaviorCard> = new Map(
  Object.values(INTERESTS).filter((i) => i.card).map((i) => [i.card!.id, cardFromDef(i.card!)]),
);

export const SAVE_VERSION = 1;
export const SAVE_MIGRATIONS: ((d: SaveData) => void)[] = [
  // v0→v1 显式 no-op：兼容点全为缺省语义（tiles 双格式/slots 双形态/techUnlockedAt 缺省
  // 读档时刻起算/wounds 惰性迁移/spawnPawn 就近安置——无需重写，作用于 load 读值时的默认回落）
  () => {},
];

export function saveSim(sim: Sim): SaveData {
  return {
    saveVersion: SAVE_VERSION,
    time: sim.time,
    dayTime: sim.dayTime,
    stockpile: { ...sim.stockpile },
    tiles: sim.world.serializeChunks(),
    buildings: sim.world.serializeBuildings(),
    techs: [...sim.techs],
    techFragments: { ...sim.techFragments },
    techUnlockedAt: { ...sim.techUnlockedAt },
    pawns: sim['_pawnList'].map((eid: number) => {
      const st = sim.pawnStates.get(eid)!;
      const pos = sim.readPosition(eid)!;
      return {
        eid, x: pos.x, y: pos.y,
        dna: st.dna,
        slots: st.slots.map((c) => (c ? { id: c.id, m: c.mastery ?? 0, u: c.lastUsed ?? 0 } : null)),
        needs: sim.readNeeds(eid),
        health: sim.readHealth(eid),
        faith: st.faith ?? 0,
        skills: st.skills ?? {},
        desires: st.desires ?? initDesires(sim['rng'], sim.tuning.desire),
        inventory: st.inventory ?? {},
        oracleBuff: st.oracleBuff,
        assignedJob: st.assignedJob,
        fireId: st.fireId ?? null,
        knownFires: st.knownFires,
        extra: st.extra ?? {},
      };
    }),
  };
}

export function loadSim(sim: Sim, data: SaveData): void {
  const loadVersion = data.saveVersion ?? 0;
  if (loadVersion > SAVE_VERSION) {
    throw new Error(`存档版本 ${loadVersion} 高于本构建支持的 ${SAVE_VERSION}（请用新版读取；旧版读新档会损坏格式，故拒绝载入）`);
  }
  for (let v = loadVersion; v < SAVE_VERSION; v++) {
    const migrate = SAVE_MIGRATIONS[v];
    if (migrate) migrate(data);
  }
  sim.techs = new Set(data.techs ?? []);
  sim.techFragments = data.techFragments ? { ...data.techFragments } : {};
  sim.time = data.time ?? 0;
  sim.dayTime = data.dayTime ?? 0;
  sim.techUnlockedAt = {};
  for (const t of sim.techs) sim.techUnlockedAt[t] = data.techUnlockedAt?.[t] ?? sim.time;
  sim.dayTime = data.dayTime ?? 0;
  if (data.stockpile) sim.stockpile = { ...TUNING.population.startStockpile, ...data.stockpile };
  // 地形：全量 string[] 或 chunk 覆盖层
  if (data.tiles) {
    if (Array.isArray(data.tiles[0])) {
      sim.world.loadChunks(data.tiles as ChunkData[]);
    } else {
      sim.world.loadTiles(data.tiles as string[]);
    }
  }
  // 建筑：还原（含 footprint/索引/fireMemory）
  if (data.buildings) sim.world.loadBuildings(data.buildings);
  // 篝火区域记忆随建筑重建（loadBuildings 已恢复建筑；旧档无 fireMemory，从空开始）
  sim.world.fireMemory.clear();
  for (const [key, b] of sim.world.buildings) {
    if (b.def.id === 'campfire' || b.def.tags?.includes('anchor')) {
      sim.world.fireMemory.set(key, [{ time: sim.time, text: '🏕 营地重建' }]);
    }
  }
  // 重建小人（先清空再逐条恢复，与原 load 同语义——data.pawns 缺省也清空，避免读旧坏档
  // 残留当前局小人）
  for (const eid of [...sim['_pawnList'] as number[]]) sim.killPawn(eid);
  if (data.pawns) {
    for (const p of data.pawns) {
      let eid = sim.spawnPawn(Math.round(p.x), Math.round(p.y));
      // 救援：原坐标不可走 → 就近可走格安置（2026-08-16 审查修复：此前 spawnPawn 返 -1
      // 直接 continue → 存档坐标漂移的小人静默失踪，玩家无任何提示）
      if (eid === -1) {
        const rescue = sim.findNearest({ x: Math.round(p.x), y: Math.round(p.y) }, (x, y) =>
          sim.world.inBounds(x, y) && sim.world.isPassable(x, y, undefined, sim.tuning.pawn.climb) && !sim.world.getBuilding(x, y),
        );
        if (rescue) eid = sim.spawnPawn(rescue.x, rescue.y);
        if (eid === -1) {
          sim.logEvent('⚠ 读档：小人无处安置，已跳过');
          continue;
        }
      }
      const st = sim.pawnStates.get(eid);
      if (!st) continue;
      st.dna = p.dna;
      // 卡槽还原：按 id 从 mod 卡 → 基础卡 → 天赋卡 → 兴趣卡 重取；查不到降级 null
      st.slots = (p.slots ?? []).map((slot) => {
        if (!slot) return null;
        const id = typeof slot === 'string' ? slot : slot.id;
        const found = sim.mods.cards.get(id) ?? BASE_CARDS.find((b) => b.id === id) ?? Object.values(TRAIT_CARDS).find((c) => c.id === id) ?? INTEREST_CARDS.get(id) ?? null;
        if (!found) return null;
        const card = { ...found };
        if (typeof slot === 'object') {
          card.mastery = slot.m;
          card.lastUsed = slot.u;
        }
        return card;
      });
      if (p.needs) sim.setNeeds(eid, p.needs);
      if (p.health) sim.setHealth(eid, p.health);
      if (p.faith !== undefined) st.faith = p.faith;
      if (p.skills) st.skills = { ...p.skills };
      if (p.desires) st.desires = { ...p.desires };
      if (p.inventory) st.inventory = { ...p.inventory };
      if (p.assignedJob) st.assignedJob = p.assignedJob;
      if (p.fireId !== undefined) st.fireId = p.fireId;
      if (p.knownFires) st.knownFires = { ...p.knownFires };
      if (p.extra) st.extra = { ...p.extra };
      if (p.oracleBuff) st.oracleBuff = { ...p.oracleBuff };
    }
  }
  for (const eid of sim.pawns) sim.socialUnits.assignPawn(eid);
}