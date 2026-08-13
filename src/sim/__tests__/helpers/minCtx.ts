// 最小 SimContext 测试助手（2026-08-14 插件化纪律：每个系统可脱离完整 Sim 单独测试）
// 设计（AGENTS.md §插件化）：系统只依赖 SimContext 接口、不碰 Sim 本体。
// 本 helper 用真实基建（World/EventBus/SimRng/ModRegistry/TUNING）+ 桩方法构造最小 ctx，
// 单测可注入系统并直接 update/触发 bus 事件验证 —— 不必 new Sim() 全栈跑。
import { Sim } from '../../sim';
import { World } from '../../core/world';
import { EventBus } from '../../core/events';
import { SimRng } from '../../core/rng';
import { ModRegistry } from '../../mods/registry';
import { TUNING } from '../../defs/tuning';
import type { SimContext } from '../../systems/context';
import type { PawnState } from '../../sim';
import type { Dna } from '../../ai/pawn';
import { generateDna, initSlots } from '../../ai/pawn';

export interface MinCtx extends SimContext {
  // 测试辅助：直接读写底层字段（桩方法内部用）
  _pawnList: number[];
  _pawnStates: Map<number, PawnState>;
  _pawnPositions: Map<number, { x: number; y: number }>;
  _needs: Map<number, { food: number; rest: number; mood: number; san: number }>;
  _health: Map<number, { hp: number; maxHp: number }>;
  _history: { type: string; data?: Record<string, unknown>; eid?: number }[];
  _log: string[];
  _spawned: { x: number; y: number }[];
  _killed: number[];
  _moods: Map<number, number>;
  _trailCleared: number;
  _skills: Map<number, Partial<Record<import('../../ai/pawn').SkillId, number>>>;
  _outcomes: { eid: number; key: string; outcome: number }[];
  _earn: { eid: number | null; item: string; amount: number }[];
  _spend: { eid: number | null; item: string; amount: number }[];
  _unlockedTechs: string[];
  _upgrades: { x: number; y: number; defId: string }[];
  _moodAdj: Map<number, number>;
}

// 构造最小 ctx：真实世界 + 桩方法。tests 可用 override 替换/追加字段。
export function makeMinCtx(seed = 1, override?: Partial<MinCtx>): MinCtx {
  const world = new World(seed);
  const bus = new EventBus();
  const rng = new SimRng(seed);
  const mods = ModRegistry.default();
  const tuning = TUNING;

  const _pawnList: number[] = [];
  const _pawnStates = new Map<number, PawnState>();
  const _pawnPositions = new Map<number, { x: number; y: number }>();
  const _needs = new Map<number, { food: number; rest: number; mood: number; san: number }>();
  const _health = new Map<number, { hp: number; maxHp: number }>();
  const _history: MinCtx['_history'] = [];
  const _log: string[] = [];
  const _spawned: { x: number; y: number }[] = [];
  const _killed: number[] = [];
  const _moods = new Map<number, number>();
  const _trailCleared = 0;
  const _skills = new Map<number, Partial<Record<import('../../ai/pawn').SkillId, number>>>();
  const _outcomes: MinCtx['_outcomes'] = [];
  const _earn: MinCtx['_earn'] = [];
  const _spend: MinCtx['_spend'] = [];
  const _unlockedTechs: string[] = [];
  const _upgrades: { x: number; y: number; defId: string }[] = [];
  const _moodAdj = new Map<number, number>();

  // 桩方法：返回确定性可断言的结果，测试用 _ 前缀字段读回
  const ctx: MinCtx = {
    // ---- 只读基建 ----
    ecs: null as never, // 系统不直接用 ecs（需要时测试 override）
    world,
    rng,
    bus,
    mods,
    tuning,
    time: 0,
    dayTime: 0,
    dayLength: 120,
    env: { raining: false, temperature: 20 },
    stockpile: {},
    hostiles: [],
    buildQueue: [],
    pawnStates: _pawnStates,
    pawnPositions: _pawnPositions,
    pawnList: _pawnList,
    techs: new Set<string>(),
    socialUnits: {
      onCampfireBuilt: (_key: number) => {},
      assignPawn: (_eid: number) => {},
      unassignPawn: (_eid: number) => {},
      addMemory: (_key: number, _text: string) => {},
      fireHistory: (_key: number, _limit?: number) => [] as string[],
    },
    oracleGoal: null as never,
    factionPriority: {},

    // ---- 数据驱动查询 ----
    buildingDef: (id) => mods.buildings[id],
    recipe: (id) => mods.recipes[id],
    techBuildWeight: () => 0,

    // ---- 世界操作 ----
    unlockTech: (id) => { _unlockedTechs.push(id); return true; },
    setOracleGoal: () => {},
    addProductionNear: (x, y, item, amount) => { ctx.stockpile[item] = (ctx.stockpile[item] ?? 0) + amount; },
    upgradeBuilding: (x, y, defId) => { _upgrades.push({ x, y, defId }); return true; },
    isNight: () => false,

    // ---- 小人读写 ----
    readPosition: (eid) => _pawnPositions.get(eid) ?? null,
    readNeeds: (eid) => _needs.get(eid) ?? null,
    readHealth: (eid) => _health.get(eid) ?? null,
    readSpeed: (eid) => ({ v: 1 }),
    setNeeds: (eid, n) => { _needs.set(eid, { ...n }); },
    setHealth: (eid, h) => { _health.set(eid, { ...h }); },
    setPosition: (eid, p) => { _pawnPositions.set(eid, { ...p }); },
    moveTo: (eid, x, y) => { _pawnPositions.set(eid, { x, y }); },
    moveAdjacent: (eid, tx, ty) => { _pawnPositions.set(eid, { x: tx, y: ty }); },
    findNearest: (pos, cond, _allow, _radius) => {
      for (let r = 1; r < 40; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
            const x = pos.x + dx, y = pos.y + dy;
            if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
            if (cond(x, y)) return { x, y };
          }
        }
      }
      return null;
    },
    spawnPawn: (x, y) => {
      _spawned.push({ x, y });
      const eid = _pawnList.length + 9000;
      _pawnList.push(eid);
      const dna = generateDna(eid);
      _pawnStates.set(eid, { dna, slots: initSlots(dna), path: [], pathIndex: 0, job: '闲逛' });
      _pawnPositions.set(eid, { x, y });
      _needs.set(eid, { food: 100, rest: 100, mood: 100, san: 100 });
      _health.set(eid, { hp: 100, maxHp: 100 });
      return eid;
    },
    killPawn: (eid) => { _killed.push(eid); },
    dnaOf: (eid) => _pawnStates.get(eid)?.dna ?? null,
    rollEvent: (eid, dc) => ({ success: rng.next() * 100 >= dc, roll: Math.floor(rng.next() * 100) }),
    rollEventSkill: (eid, dc, skill) => {
      const s = _skills.get(eid)?.[skill] ?? 10;
      const roll = Math.floor(rng.next() * 100);
      return { success: roll >= dc, roll };
    },
    adjustMood: (eid, delta) => { _moodAdj.set(eid, delta); },
    issueCommand: () => {},
    recordEarn: (eid, item, amount) => { _earn.push({ eid, item, amount }); },
    recordSpend: (eid, item, amount) => { _spend.push({ eid, item, amount }); },
    flowRatio: () => 0,
    logEvent: (text) => { _log.push(text); },
    clearTrailCache: () => { ctx._trailCleared++; },
    skillOf: (eid, skill) => _skills.get(eid)?.[skill] ?? 10,
    growSkill: (eid, skill) => { _skills.set(eid, { ...(_skills.get(eid) ?? {}), [skill]: (_skills.get(eid)?.[skill] ?? 10) + 1 }); },
    recordOutcome: (eid, key, outcome) => { _outcomes.push({ eid, key, outcome }); },
    leanOf: () => 0,
    historyQuery: () => _history,

    // ---- 测试观测 ----
    _pawnList,
    _pawnStates,
    _pawnPositions,
    _needs,
    _health,
    _history,
    _log,
    _spawned,
    _killed,
    _moods,
    _trailCleared: 0,
    _skills,
    _outcomes,
    _earn,
    _spend,
    _unlockedTechs,
    _upgrades,
    _moodAdj,
  };

  // helper: 从 Sim 克隆一个真实的 ctx（当系统需要真 Sim 行为时）
  return Object.assign(ctx, override ?? {}) as MinCtx;
}

// 便捷：把某个系统 attach 到 ctx 并返回（测试直接用）
export function attach<T extends object>(ctx: MinCtx, sys: T & { init?(bus: EventBus): void }): T {
  sys.init?.(ctx.bus);
  return sys;
}

export { Sim, EventBus, World, SimRng, ModRegistry, TUNING };
