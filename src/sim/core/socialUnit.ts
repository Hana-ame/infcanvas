// 社会单位（用户 Q9 + 即时指令：以篝火为单位）
// 有篝火 = 独立派系。篝火维护"部落记忆"+ 对其他单位的看法（opinion）。
// 容量分级：篝火维护 2-3 个连接，教堂/神庙（篝火升级）5-10 个。
// 派系 = 看法网络的涌现，不是数据定义。

// level 开放为 string：内置 campfire/church；mod 可 registerUnitLevel 注册新等级 + 容量
export type UnitLevel = string;

import { FACTION_NAMES } from '../defs/factionNames';

export interface UnitOpinion {
  value: number;        // 看法 -100..100（负=敌对，正=友好）
  lastChanged: number;  // 最后变化时间
}

export interface UnitMemory {
  time: number;
  text: string;
}

export interface SocialUnit {
  id: string;
  key: number;            // 建筑 key（篝火/教堂位置）
  level: UnitLevel;
  name: string;
  members: number[];      // 所属 pawn eid
  memory: UnitMemory[];   // 部落记忆
  opinions: Map<string, UnitOpinion>; // 对其他 unit id 的看法
  createdAt: number;
  resources: Record<string, number>; // 派系库存（Q9 贸易/逆差地基）
  tradeBalance: Map<string, number>; // 与其他单位的贸易逆差（正=顺差，负=逆差）
}

// 记忆/看法容量：篝火 2-3，教堂 5-10（用户指定）；未知等级回退最小容量
export const UNIT_CAPACITY: Record<string, number> = {
  campfire: 3,
  church: 10,
};

// 注册新单位等级 + 容量（DESIGN §7 mod 扩展）。同 id 同容量幂等，不同容量抛冲突
export function registerUnitLevel(id: string, capacity: number): void {
  const cap = UNIT_CAPACITY[id];
  if (cap !== undefined) {
    if (cap === capacity) return;
    throw new Error(`unit level "${id}" 冲突（已注册容量 ${cap}）`);
  }
  UNIT_CAPACITY[id] = capacity;
}

let unitSeq = 0;
export function nextUnitId(): string {
  return `u${++unitSeq}`;
}
// 载入存档后恢复序列，避免 id 冲突
export function setUnitSeq(n: number): void {
  unitSeq = n;
}

// 生成派系名（确定性种子）：名字元素查生成表（defs/factionNames.ts 内置，
// 调用方可传 tuning.faction.namePrefixes/nameSuffixes 覆盖）
export function generateUnitName(
  rng: { next(): number },
  names?: { prefixes: readonly string[]; suffixes: readonly string[] },
): string {
  const prefixes = names?.prefixes.length ? names.prefixes : FACTION_NAMES.prefixes;
  const suffixes = names?.suffixes.length ? names.suffixes : FACTION_NAMES.suffixes;
  return prefixes[Math.floor(rng.next() * prefixes.length)] + suffixes[Math.floor(rng.next() * suffixes.length)];
}

// 记录一条部落记忆（容量上限 30 条，超出丢最旧）
export function addMemory(unit: SocialUnit, time: number, text: string): void {
  unit.memory.push({ time, text });
  if (unit.memory.length > 30) unit.memory.splice(0, unit.memory.length - 30);
}

// 调整对某单位的看法（容量超限时遗忘最弱连接）
export function adjustOpinion(unit: SocialUnit, targetId: string, delta: number, now: number): void {
  const cap = UNIT_CAPACITY[unit.level] ?? UNIT_CAPACITY.campfire;
  if (!unit.opinions.has(targetId)) {
    // 新连接：容量满则遗忘信任最弱的
    if (unit.opinions.size >= cap) {
      let weakest: string | null = null;
      let weakestAbs = Infinity;
      for (const [id, op] of unit.opinions) {
        if (Math.abs(op.value) < weakestAbs) { weakestAbs = Math.abs(op.value); weakest = id; }
      }
      if (weakest) unit.opinions.delete(weakest);
    }
    unit.opinions.set(targetId, { value: 0, lastChanged: now });
  }
  const op = unit.opinions.get(targetId)!;
  op.value = Math.max(-100, Math.min(100, op.value + delta));
  op.lastChanged = now;
}
