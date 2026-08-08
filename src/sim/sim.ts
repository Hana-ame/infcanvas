// Sim —— 组装层（系统挂载 + 主循环 + 命令 + UI 读取）
// 架构：Sim 实现 SimContext，系统通过 context 操作 sim，事件经 EventBus 流动
import {
  createWorld, addEntity, addComponent, setComponent, query,
  type World as EcsWorld,
} from 'bitecs';
import { World } from './core/world';
import { findPath } from './core/pathfinding';
import { SimRng } from './core/rng';
import { initNeeds } from './core/needs';
import { EventBus } from './core/events';
import { HistoryLog } from './core/history';
import { generateDna, initSlots, type Dna, type SkillId, BASE_CARDS, TRAIT_CARDS } from './ai/pawn';
import { initDesires, type DesireId } from './core/desires';
import { initEnv, tickEnv, type EnvState } from './core/env';
import { addMemory, setUnitSeq, type SocialUnit } from './core/socialUnit';
import { initLean, adjustLean, type LeanKey } from './core/lean';
import { BUILDINGS, TILES, ITEMS, type BuildingDef } from './defs';
import { ENEMIES } from './defs/enemies';
import { RECIPES } from './defs/recipes';
import { TUNING, type TuningConfig } from './defs/tuning';
import type { RecipeDef } from './defs/recipes';
import { ModRegistry } from './mods/registry';
import type { SimContext } from './systems/context';
import { SystemRegistry } from './systems/registry';
import { NeedsSystem } from './systems/needsSystem';
import { SanSystem } from './systems/sanSystem';
import { DesireSystem } from './systems/desireSystem';
import { SocialSystem } from './systems/socialSystem';
import { EventSystem } from './systems/eventSystem';
import { AutonomousBuildSystem } from './systems/autonomousBuildSystem';
import { SocialUnitSystem } from './systems/socialUnitSystem';
import { SCRIPTED_EVENTS } from './systems/scripts';
import { BehaviorSystem } from './systems/cardSystem';
import { GatherSystem } from './systems/gatherSystem';
import { BuildSystem } from './systems/buildSystem';
import { FarmSystem } from './systems/farmSystem';
import { CraftSystem } from './systems/craftSystem';
import { RepairSystem } from './systems/repairSystem';
import { RaidSystem } from './systems/raidSystem';
import { PopulationSystem } from './systems/populationSystem';

// ---- ECS 组件定义 ----
export interface PositionData { x: number; y: number }
export interface NeedsData { food: number; rest: number; mood: number; san: number }
export interface SpeedData { v: number }
export interface HealthData { hp: number; maxHp: number }

export const Position = { x: [] as number[], y: [] as number[] };
export const Pawn = {} as { _flag?: number[] };
export const NeedsComp = { food: [] as number[], rest: [] as number[], mood: [] as number[], san: [] as number[] };
export const Speed = { v: [] as number[] };
export const Health = { hp: [] as number[], maxHp: [] as number[] };

function registerAutoStore(world: EcsWorld, component: Record<string, number[]>): void {
  observe(world, onSet(component), (eid: number, data: Record<string, number>) => {
    for (const key of Object.keys(data)) {
      const arr = component[key];
      if (Array.isArray(arr)) arr[eid] = data[key];
    }
  });
}

import { observe, onSet } from 'bitecs';

export interface PawnState {
  dna: Dna;
  slots: ReturnType<typeof initSlots>;
  path: { x: number; y: number }[];
  pathIndex: number;
  urgent?: 'eat' | 'rest';
  mining?: { x: number; y: number; progress: number };
  mineTarget?: { x: number; y: number };
  chopTarget?: { x: number; y: number };
  caveTarget?: { x: number; y: number }; // 矿洞工作目标
  caveWork?: { x: number; y: number; progress: number; duration?: number }; // 矿洞内持续采掘
  chopXY?: { x: number; y: number };
  chopProgress?: number;
  prayTarget?: { x: number; y: number }; // 祈祷点（篝火）
  praying?: { x: number; y: number; progress: number };
  healTarget?: { x: number; y: number }; // 疗伤点
  healing?: { progress: number };
  commandCooldown?: number; // 玩家命令后的一段时间不自动决策
  faith?: number; // 信仰度（祈祷积累，影响违抗与心情）
  defyCd?: number; // 违抗后的冷却时间（秒）
  crazyCooldown?: number; // 狂乱乱跑冷却
  skills?: Partial<Record<SkillId, number>>; // COC 技能（百分制，越用越强）
  desires?: Record<DesireId, number>; // 七宗罪满足度（DESIGN §3）
  relationships?: Map<number, number>; // 对其他小人的好感度（社交系统）
  socialCd?: number; // 社交冷却
  job?: string;
  // 最近决策记录（设计文档：小人闪过哪3个念头、选了哪个）
  lastDecision?: { drawn: string[]; picked: string; time: number };
  lastSeries?: string; // 上一轮执行的卡系列（马尔可夫偏置，DESIGN §6）
  oracleBuff?: { until: number; mood: number }; // 神谕祝福（到期时间戳，心情加成）
  assignedJob?: string; // 指派职业（Q10 生产线：lumberjack/miner/farmer/crafter）
  lean?: Record<LeanKey, number>; // 行为倾向（勒沙特列反馈：按 profit 自平衡）
  onArriveWork?: () => void; // mod 工作的到达回执（非序列化，仅当 tick 行为态：走到点后调用）
}

export interface SimOptions {
  seed?: number;
  pawnCount?: number;
  tickHz?: number;
  mods?: (m: ModRegistry) => void; // mod 挂载：构造时注册系统/卡/意图（DESIGN §7）
}

export interface Command {
  type: 'move' | 'build' | 'haul' | 'mine' | 'oracle' | 'assign';
  pawnId?: number;
  x: number;
  y: number;
  buildingId?: string;
  job?: string; // assign 命令用（lumberjack/miner/farmer/crafter）
}

export interface SaveData {
  time: number;
  dayTime: number;
  stockpile: Record<string, number>;
  tiles: string[];
  buildings: { key: number; defId: string; hp: number; faction: string }[];
  pawns: {
    eid: number; x: number; y: number;
    dna: Dna; slots: (string | null)[]; // 卡 id（非函数）——JSON-safe
    needs: NeedsData | null; health: HealthData | null;
    faith?: number;
    skills?: Partial<Record<SkillId, number>>;
    desires?: Record<DesireId, number>;
    oracleBuff?: { until: number; mood: number };
    assignedJob?: string;
  }[];
  units?: {
    id: string; key: number; level: 'campfire' | 'church'; name: string;
    members: number[]; memory: { time: number; text: string }[];
    opinions: [string, { value: number; lastChanged: number }][];
    resources: Record<string, number>;
    tradeBalance: [string, number][];
    createdAt: number;
  }[];
  playerUnitId?: string | null;
}

export class Sim implements SimContext {
  ecs: EcsWorld;
  world: World;
  rng: SimRng;
  bus: EventBus;
  tickHz: number;
  time = 0;
  dayLength = 120;
  dayTime = 0;
  speed = 1;
  paused = false;
  events: { time: number; text: string }[] = [];
  env: EnvState = initEnv(); // 天气/气温（DESIGN §6）
  // 派系优先级（用户 Q8：AI 按环境下达工作优先指令）：卡 id → 权重倍率
  factionPriority: Record<string, number> = {};
  private prioTimer = 0;

  pawnStates = new Map<number, PawnState>();
  pawnPositions = new Map<number, { x: number; y: number }>();
  selected: number[] = [];
  hostiles: { x: number; y: number; hp: number; maxHp: number; targetX: number; targetY: number; name?: string; faction?: string; enemyId?: string; speed?: number; dmgPerSec?: number; loot?: { item: string; amount: number } }[] = [];
  buildQueue: { x: number; y: number; defId: string; progress: number; faction: string; cost?: { wood: number; ore: number } }[] = [];
  stockpile: Record<string, number> = { wood: 50, ore: 0, food: 30, tools: 0 };

  private _pawnList: number[] = [];
  private trailCache = new Map<string, { x: number; y: number }[]>();
  private registry = new SystemRegistry();
  // 结构化历史日志（仿真日志：事实来自 sim，LLM 只润色）
  history = new HistoryLog();
  // mod 注册表（DESIGN §7 扩展性原则）
  mods = new ModRegistry({
    tiles: TILES,
    buildings: BUILDINGS,
    items: ITEMS,
    enemies: ENEMIES,
    cards: BASE_CARDS,
    recipes: RECIPES,
    tuning: TUNING,
    intents: [],
    works: [],
  });
  // 平衡参数总表（mod 可覆盖）——getter 保证 mods 回调后读到覆盖后的值
  get tuning(): TuningConfig {
    return this.mods.tuning;
  }

  // mod 可覆盖的 def 查询（SimContext）
  buildingDef(id: string): BuildingDef | undefined {
    return this.mods.buildings[id];
  }
  recipe(id: string): RecipeDef | undefined {
    return this.mods.recipes[id];
  }
  private behavior: BehaviorSystem;
  private _started = false;
  socialUnits: SocialUnitSystem; // 篝火单位/部落记忆/派系涌现
  playerUnitId: string | null = null; // 玩家所属单位（Q3 团灭附身）

  constructor(opts: SimOptions = {}) {
    const seed = opts.seed ?? 12345;
    const pawnCount = opts.pawnCount ?? 4;
    this.tickHz = opts.tickHz ?? 20;
    // 应用 mod（在 world/spawn 前，可覆盖 defs/tuning/配方）——构造期回调
    opts.mods?.(this.mods);
    this.ecs = createWorld();
    registerAutoStore(this.ecs, Position);
    registerAutoStore(this.ecs, NeedsComp);
    registerAutoStore(this.ecs, Speed);
    registerAutoStore(this.ecs, Health);
    this.world = new World(seed, { tiles: this.mods.tiles, buildings: this.mods.buildings });
    this.rng = new SimRng(seed + 1);
    this.bus = new EventBus();
    // 所有事件 → 结构化历史
    this.bus.onAny((ev) => this.history.record(ev, this.time, this.time / this.dayLength));
    // 建篝火/教堂 → 创建/升级派系单位
    this.bus.on('building_built', (ev) => {
      if (ev.type === 'building_built') {
        const key = this.world.buildKey(ev.x, ev.y);
        this.socialUnits.onBuildingBuilt(key, ev.defId, this.time);
      }
    });

    this.behavior = new BehaviorSystem(this);
    this.socialUnits = new SocialUnitSystem(this);
    this.applyMods();
    this.registerSystems();
    this._started = true;
    this.registry.initAll(this.bus);
    this.spawnPawns(pawnCount);
    // 出生点篝火 → 首个派系单位
    this.ensureInitialCamp();
  }

  private applyMods(): void {
    // mod 注册的系统挂到系统注册表
    for (const s of this.mods.allSystems) this.registry.register(s);
    // mod 注册的意图执行器交给行为系统
    for (const [id, fn] of this.mods.intents) {
      this.behavior.registerIntent(id, fn);
    }
    // mod 注册的工作类型执行器交给行为系统
    for (const [type, fn] of this.mods.works) {
      this.behavior.registerWork(type, fn);
    }
  }

  private registerSystems(): void {
    this.registry
      .register(new NeedsSystem(this))
      .register(new SanSystem(this))
      .register(new DesireSystem(this))
      .register(this.behavior)
      .register(this.socialUnits)
      .register(new SocialSystem(this))
      .register(new GatherSystem(this))
      .register(new BuildSystem(this))
      .register(new FarmSystem(this))
      .register(new CraftSystem(this))
      .register(new RepairSystem(this))
      .register(new RaidSystem(this))
      .register(new PopulationSystem(this))
      .register(new EventSystem(this, [...SCRIPTED_EVENTS, ...this.mods.events]))
      .register(new AutonomousBuildSystem(this));
  }

  // ---- 系统可通过 SimContext 访问 ----
  get pawnList(): readonly number[] { return this._pawnList; }

  readPosition(eid: number): PositionData | null {
    if (Position.x[eid] === undefined) return null;
    return { x: Position.x[eid], y: Position.y[eid] };
  }
  readNeeds(eid: number): NeedsData | null {
    if (NeedsComp.food[eid] === undefined) return null;
    return { food: NeedsComp.food[eid], rest: NeedsComp.rest[eid], mood: NeedsComp.mood[eid], san: NeedsComp.san[eid] ?? 100 };
  }
  readHealth(eid: number): HealthData | null {
    if (Health.hp[eid] === undefined) return null;
    return { hp: Health.hp[eid], maxHp: Health.maxHp[eid] };
  }
  readSpeed(eid: number): SpeedData | null {
    if (Speed.v[eid] === undefined) return null;
    return { v: Speed.v[eid] };
  }
  setNeeds(eid: number, n: NeedsData): void { setComponent(this.ecs, eid, NeedsComp, n); }
  setHealth(eid: number, h: HealthData): void { setComponent(this.ecs, eid, Health, h); }
  setPosition(eid: number, p: PositionData): void { setComponent(this.ecs, eid, Position, p); }

  isNight(): boolean {
    return this.dayTime > 0.72 || this.dayTime < 0.22;
  }

  moveTo(eid: number, x: number, y: number): void {
    const pos = this.readPosition(eid);
    if (!pos) return;
    const path = this.getPath(Math.round(pos.x), Math.round(pos.y), Math.round(x), Math.round(y));
    const st = this.pawnStates.get(eid);
    if (st) {
      st.path = path;
      st.pathIndex = 0;
      st.mineTarget = undefined;
      st.mining = undefined;
      st.chopTarget = undefined;
      st.chopXY = undefined;
      st.chopProgress = undefined;
      st.prayTarget = undefined;
      st.praying = undefined;
      st.healTarget = undefined;
      st.healing = undefined;
      // 玩家命令优先：短暂时间内不自动决策
      st.commandCooldown = this.tuning.card.commandCooldown;
    }
  }

  moveAdjacent(eid: number, tx: number, ty: number): void {
    const pos = this.readPosition(eid);
    if (!pos) return;
    let target: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = tx + dx, ny = ty + dy;
        if (!this.world.inBounds(nx, ny)) continue;
        if (!this.world.isPassable(nx, ny)) continue;
        const d = (nx - tx) * (nx - tx) + (ny - ty) * (ny - ty);
        if (d < bestD) { bestD = d; target = { x: nx, y: ny }; }
      }
    }
    if (!target) return;
    const path = this.getPath(Math.round(pos.x), Math.round(pos.y), target.x, target.y);
    const st = this.pawnStates.get(eid);
    if (st) {
      st.path = path;
      st.pathIndex = 0;
    }
  }

  findNearest(pos: PositionData, cond: (x: number, y: number) => boolean, allowNonPassable = false): { x: number; y: number } | null {
    const R = this.mods.tuning.pawn.scanRadius;
    let best: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (let r = 1; r <= R; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = Math.round(pos.x) + dx;
          const y = Math.round(pos.y) + dy;
          if (!this.world.inBounds(x, y)) continue;
          if (!allowNonPassable && !this.world.isPassable(x, y)) continue;
          if (cond(x, y)) {
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; best = { x, y }; }
          }
        }
      }
    }
    return best;
  }

  spawnPawn(x: number, y: number): number {
    if (!this.world.inBounds(x, y) || !this.world.isPassable(x, y)) return -1;
    const eid = addEntity(this.ecs);
    addComponent(this.ecs, eid, Position);
    setComponent(this.ecs, eid, Position, { x, y });
    addComponent(this.ecs, eid, Pawn);
    addComponent(this.ecs, eid, NeedsComp);
    setComponent(this.ecs, eid, NeedsComp, initNeeds());
    addComponent(this.ecs, eid, Speed);
    setComponent(this.ecs, eid, Speed, { v: this.tuning.pawn.baseSpeed });
    const dna = generateDna(this.seedFor(eid));
    addComponent(this.ecs, eid, Health);
    const maxHp = this.tuning.pawn.hpBase + Math.floor((dna.con + dna.siz) / 2);
    setComponent(this.ecs, eid, Health, { hp: maxHp, maxHp });
    // COC 技能初始值：INT + EDU 高 → 起点高（百分制）
    const intBase = Math.floor((dna.int - 30) / 4) + Math.floor((dna.edu - 30) / 8);
    this.pawnStates.set(eid, {
      dna,
      slots: initSlots(dna, [...this.mods.cards.values()]),
      path: [],
      pathIndex: 0,
      skills: { work: 20 + intBase, fight: 15 + intBase, craft: 15 + intBase, social: 10 + intBase, faith: 10 + intBase },
      desires: initDesires(this.rng),
      lean: initLean(this.rng),
    });
    this._pawnList.push(eid);
    this.pawnPositions.set(eid, { x, y });
    this.bus.emit({ type: 'pawn_spawned', eid, x, y });
    return eid;
  }

  killPawn(eid: number): void {
    const idx = this._pawnList.indexOf(eid);
    if (idx >= 0) this._pawnList.splice(idx, 1);
    this.pawnStates.delete(eid);
    this.pawnPositions.delete(eid);
    this.selected = this.selected.filter((s) => s !== eid);
  }

  rollEvent(eid: number, dc: number): { success: boolean; roll: number } {
    const roll = this.rng.int(1, 100);
    const st = this.pawnStates.get(eid);
    const dna = st?.dna;
    const intBonus = dna ? Math.floor((dna.int - 50) / 10) : 0;
    return { success: roll <= dc + intBonus, roll };
  }

  // 技能检定：成功阈值 = dc + 技能值/10 加成（技能越高越稳，COC 式成长收益）
  rollEventSkill(eid: number, dc: number, skill: SkillId): { success: boolean; roll: number } {
    const roll = this.rng.int(1, 100);
    const bonus = Math.floor((this.skillOf(eid, skill) - 10) / 10);
    return { success: roll <= dc + bonus, roll };
  }

  // COC 八属性读取
  dnaOf(eid: number) {
    const st = this.pawnStates.get(eid);
    if (!st) return null;
    const { str, con, int, siz, dex, app, pow, edu } = st.dna;
    return { str, con, int, siz, dex, app, pow, edu };
  }

  adjustMood(eid: number, delta: number): void {
    const n = this.readNeeds(eid);
    if (!n) return;
    n.mood = Math.max(0, Math.min(100, n.mood + delta));
    this.setNeeds(eid, n);
    this.bus.emit({ type: 'mood_changed', eid, delta });
  }

  // COC 技能：读取（无则用下限 10）
  skillOf(eid: number, skill: SkillId): number {
    return this.pawnStates.get(eid)?.skills?.[skill] ?? 10;
  }

  // 行为倾向反馈（勒沙特列原理）：执行某行为后按实际收益调整倾向
  recordLean(eid: number, key: LeanKey, profit: number): void {
    const st = this.pawnStates.get(eid);
    if (!st) return;
    st.lean = st.lean ?? initLean(this.rng);
    adjustLean(st.lean, key, profit);
  }

  // 倾向读取（抽卡权重调制用）
  leanOf(eid: number, key: LeanKey): number {
    return this.pawnStates.get(eid)?.lean?.[key] ?? 50;
  }

  // 技能成长（COC 规则）：掷 d100 > 当前值 → +1d10，越用越强、边际递减
  growSkill(eid: number, skill: SkillId): void {
    const st = this.pawnStates.get(eid);
    if (!st) return;
    const cur = st.skills?.[skill] ?? 10;
    if (cur >= 100) return;
    const roll = this.rng.int(1, 100);
    if (roll > cur) {
      const gain = this.rng.int(1, 10);
      st.skills = { ...st.skills, [skill]: Math.min(100, cur + gain) };
      if (gain >= 8) this.logEvent('📈 技能精进');
    }
  }

  logEvent(text: string): void {
    this.events.push({ time: this.time, text });
    if (this.events.length > 50) this.events.shift();
  }

  clearTrailCache(): void {
    this.trailCache.clear();
  }

  private getPath(sx: number, sy: number, ex: number, ey: number): { x: number; y: number }[] {
    const key = `${sx},${sy}->${ex},${ey}`;
    const cached = this.trailCache.get(key);
    if (cached) return cached;
    const path = findPath(this.world, sx, sy, ex, ey);
    if (path.length > 0) {
      if (this.trailCache.size > 2048) this.trailCache.clear();
      this.trailCache.set(key, path);
    }
    return path;
  }

  private spawnPawns(count: number): void {
    const cx = Math.floor(this.world.width / 2);
    const cy = Math.floor(this.world.height / 2);
    for (let i = 0; i < count; i++) {
      const x = cx + (i % 3) - 1;
      const y = cy + Math.floor(i / 3) - 1;
      this.spawnPawn(x, y);
    }
  }

  // 出生点首个篝火 → 第一个派系单位（Q9：有篝火 = 独立派系）
  private ensureInitialCamp(): void {
    const cx = Math.floor(this.world.width / 2);
    const cy = Math.floor(this.world.height / 2);
    const starter = this.mods.tuning.autobuild.starterBuilding; // 出生建筑（mod 可换基地建筑）
    if (this.world.placeBuilding(cx, cy + 2, starter, 'auto')) {
      this.socialUnits.onBuildingBuilt(this.world.buildKey(cx, cy + 2), starter, this.time);
      this.bus.emit({ type: 'building_built', x: cx, y: cy + 2, defId: starter });
    }
    // 出生小人归入最近的派系单位
    for (const eid of this.pawns) this.socialUnits.assignPawn(eid);
    // 初始单位为玩家所属（Q3 团灭附身的基础）
    this.playerUnitId = this.socialUnits.units.size > 0 ? [...this.socialUnits.units.keys()][0] : null;
  }

  // 空世界（旧档全灭/坏档）重开：重建出生点小人 + 初始营地（供客户端恢复局面）
  respawnPawns(count: number): void {
    for (const eid of [...this._pawnList]) this.killPawn(eid);
    this.spawnPawns(count);
  }

  // 若出生点没有篝火则重建（空世界重开用）
  ensureCamp(): void {
    const cx = Math.floor(this.world.width / 2);
    const cy = Math.floor(this.world.height / 2);
    if (!this.world.getBuilding(cx, cy + 2)) {
      this.ensureInitialCamp();
    } else {
      for (const eid of this.pawns) this.socialUnits.assignPawn(eid);
      this.playerUnitId = this.socialUnits.units.size > 0 ? [...this.socialUnits.units.keys()][0] : null;
    }
  }

  // 团灭附身（Q3）：玩家所属单位成员清零 → 视角转移到最近的存活单位
  private checkPossession(): void {
    if (!this.playerUnitId) return;
    const unit = this.socialUnits.units.get(this.playerUnitId);
    // 单位已不存在（被征服）或成员全灭
    if (!unit || unit.members.length === 0) {
      const others = [...this.socialUnits.units.values()].filter((u) => u.id !== this.playerUnitId && u.members.length > 0);
      if (others.length > 0) {
        const next = others[0];
        this.playerUnitId = next.id;
        this.logEvent(`👁 本体团灭，神谕附身于 ${next.name}`);
        addMemory(next, this.time, `👁 神谕降临，接管了 ${next.name}`);
      } else {
        this.playerUnitId = null;
        this.logEvent('👁 所有派系已覆灭，世界陷入沉寂');
      }
    }
  }

  private seedFor(eid: number): number {
    return (this.rng.int(1, 2 ** 31 - 1) ^ eid) >>> 0;
  }

  // ---- 命令 ----
  issueCommand(cmd: Command): void {
    if (cmd.type === 'build') {
      this.queueBuild(cmd.x, cmd.y, cmd.buildingId ?? this.mods.tuning.autobuild.fallbackBuilding);
      return;
    }
    if (cmd.type === 'oracle') {
      this.oracleInfluence(cmd.x, cmd.y);
      return;
    }
    if (cmd.type === 'assign') {
      for (const eid of this.selected) {
        const st = this.pawnStates.get(eid);
        if (st) {
          st.assignedJob = cmd.job || undefined;
          this.logEvent(st.assignedJob ? `📋 指派 #${eid} 为 ${this.jobLabel(cmd.job!)}` : `📋 取消 #${eid} 的指派`);
        }
      }
      return;
    }
    const eids = cmd.pawnId ? [cmd.pawnId] : this.selected;
    for (const eid of eids) {
      if (cmd.type === 'move') this.moveTo(eid, cmd.x, cmd.y);
      else if (cmd.type === 'mine') this.mineAt(eid, cmd.x, cmd.y);
    }
  }

  private jobLabel(job: string): string {
    const map: Record<string, string> = { lumberjack: '伐木工', miner: '矿工', farmer: '农民', crafter: '工匠' };
    return map[job] ?? job;
  }

  // 产出归集（Q9）：建筑附近单位获得产出（玩家单位=全局）
  addProductionNear(x: number, y: number, item: string, amount: number): void {
    this.socialUnits.addProductionNear(x, y, item, amount);
  }

  // 建筑升级（篝火→教堂）
  upgradeBuilding(x: number, y: number, defId: string, faction: string): boolean {
    return this.world.upgradeBuilding(x, y, defId, faction);
  }

  // 神谕影响（用户 Q2/Q3）：在具备 'oracle' 能力的建筑发布，祝福附近的高信仰小人  // 玩家不直接指挥 → 只影响"目标层"（心情/信仰），执行仍由小人自主
  private oracleInfluence(x: number, y: number): void {
    // 必须落在声明了 oracle 能力的建筑上（数据驱动：mod 加"神圣建筑"声明 capabilities:['oracle'] 即可）
    const b = this.world.getBuilding(x, y);
    if (!b || !(b.def.capabilities?.includes?.('oracle'))) {
      this.logEvent('⛪ 神谕只能在神圣祭坛降下');
      return;
    }
    const f = this.mods.tuning.faith;
    const R = f.oracleRadius;
    let affected = 0;
    for (const eid of this.pawnList) {
      const pos = this.pawnPositions.get(eid);
      if (!pos) continue;
      const d = Math.hypot(pos.x - x, pos.y - y);
      if (d > R) continue;
      const st = this.pawnStates.get(eid);
      if (!st) continue;
      // 信任过滤：信仰越高影响越深；低信仰者几乎不受影响
      const trust = (st.faith ?? 0) / 100;
      if (trust < f.oracleTrustAt) continue;
      st.oracleBuff = { until: this.time + f.oracleDuration, mood: f.oracleMood * trust };
      this.adjustMood(eid, Math.round(f.oracleMood / 2 * trust));
      st.faith = Math.min(100, (st.faith ?? 0) + f.oracleFaith);
      affected++;
    }
    if (affected > 0) this.logEvent(`✨ 神谕降下，${affected} 位信众受到祝福`);
    else this.logEvent('✨ 神谕降下，却无人聆听');
  }

  private queueBuild(x: number, y: number, defId: string): void {
    const def = this.buildingDef(defId);
    if (!def) return;
    if (!this.world.canBuildFootprint(x, y, def)) return;
    const cost = {
      wood: def.costWood ?? def.size.x * def.size.y * 2,
      ore: def.costOre ?? 0,
    };
    if (this.stockpile.wood < cost.wood) return;
    if (cost.ore > 0 && this.stockpile.ore < cost.ore) return;
    this.buildQueue.push({ x, y, defId, progress: 0, faction: 'player', cost });
  }

  private mineAt(eid: number, x: number, y: number): void {
    const st = this.pawnStates.get(eid);
    if (!st) return;
    const tile = this.world.getTileDef(x, y);
    if (!tile.mineral) return;
    const pos = this.readPosition(eid);
    if (!pos) return;
    const path = this.getPath(Math.round(pos.x), Math.round(pos.y), x, y);
    st.path = path;
    st.pathIndex = 0;
    st.mineTarget = { x, y };
  }

  private updateFactionPriority(dt: number): void {
    this.prioTimer -= dt;
    if (this.prioTimer > 0) return;
    this.prioTimer = this.mods.tuning.faction.priorityTimer; // 每 N 秒评估一次环境 → 派系工作优先级
    const s = this.stockpile;
    const pri: Record<string, number> = {};
    // 基线 1.0，短缺的资源对应工作权重升高（数据驱动：规则表 tuning.card.priority）
    for (const r of this.mods.tuning.card.priority) {
      let boost = 1;
      const low = this.priorityStock(r.resource, s);
      if (low < r.lowAt) boost = r.boost;
      if (r.urgentAt !== undefined && low < r.urgentAt && r.urgentBoost !== undefined) boost = r.urgentBoost;
      pri[r.cardId] = boost;
    }
    this.factionPriority = pri;
  }

  // 取某资源当前量（'queue'：非空返回 -1 恒触发 boost，空返回 Infinity 恒不触发）
  private priorityStock(resource: string, s: Record<string, number>): number {
    if (resource === 'queue') return this.buildQueue.length > 0 ? -1 : Infinity;
    return s[resource] ?? 0;
  }

  // ---- 主循环 ----
  step(dt: number): void {
    if (this.paused) return;
    dt *= this.speed;
    // mod 钩子：step 前（可读改 sim 状态）
    this.mods.runHooks('step:before', { sim: this, dt });
    this.time += dt;
    this.dayTime = (this.time % this.dayLength) / this.dayLength;
    tickEnv(this.env, dt, this.dayTime, this.rng, this.tuning.env);
    this.updateFactionPriority(dt);
    this.registry.updateAll(dt);
    this.checkPossession(); // Q3 团灭附身
    // mod 钩子：step 后（观察结果）
    this.mods.runHooks('step:after', { sim: this, dt });
  }

  // ---- UI 读取 ----
  get pawns(): readonly number[] { return this._pawnList; }  get buildCount(): number { return this.buildQueue.length; }
  get buildQueueItems(): { x: number; y: number; defId: string; progress: number }[] {
    return this.buildQueue.map((b) => ({ x: b.x, y: b.y, defId: b.defId, progress: b.progress }));
  }
  buildingAt(x: number, y: number): { def: BuildingDef; defId: string; hp: number; maxHp: number; faction: string } | null {
    const b = this.world.getBuilding(x, y);
    if (!b) return null;
    return { def: b.def, defId: b.def.id, hp: Math.round(b.hp), maxHp: b.def.hp, faction: b.faction };
  }

  // 篝火/教堂 → 所属派系单位（部落记忆/看法）
  unitAt(x: number, y: number) {
    const key = this.world.buildKey(x, y);
    return this.socialUnits.unitAtKey(key);
  }

  // 征服（Q9：战争征服/吞并）：敌方摧毁某单位核心篝火/教堂 → 该单位被吞并
  // 成员并入征服者，记忆记录，地图标记征服（Q3 团灭附身的基础）
  conquestOf(coreKey: number, conquerorName: string): void {
    const victim = this.socialUnits.unitAtKey(coreKey);
    if (!victim) return;
    // 找征服者单位（按名字）
    let conqueror: SocialUnit | null = null;
    for (const u of this.socialUnits.units.values()) {
      if (u.name === conquerorName && u.id !== victim.id) { conqueror = u; break; }
    }
    if (!conqueror) return;
    // 吞并：victim 成员并入 conqueror，victim 移除
    for (const eid of victim.members) {
      if (!conqueror.members.includes(eid)) conqueror.members.push(eid);
      this.socialUnits.membership.set(eid, conqueror.id);
    }
    addMemory(conqueror, this.time, `⚔ 征服了 ${victim.name}，部族并入`);
    addMemory(victim, this.time, `🏳 ${victim.name} 被 ${conqueror.name} 征服`);
    this.socialUnits.units.delete(victim.id);
    this.logEvent(`🏳 ${victim.name} 被 ${conqueror.name} 征服吞并！`);
    this.bus.emit({ type: 'faction_event', kind: 'conquest', from: conqueror.name, to: victim.name });
  }
  pawnJob(eid: number): string { return this.pawnStates.get(eid)?.job ?? ''; }
  healthOf(eid: number) { return this.readHealth(eid); }
  get selectedIds(): number[] { return this.selected; }
  set selectedIds(list: number[]) { this.selected = list; }

  pawnProfile(eid: number): {
    dna: Dna; slots: ReturnType<typeof initSlots>; job: string;
    needs: NeedsData | null; health: HealthData | null; pos: { x: number; y: number };
    faith: number;
    skills: Partial<Record<SkillId, number>>;
    desires: Record<DesireId, number>;
    oracleBuff?: { until: number; mood: number };
    assignedJob?: string;
    lastDecision?: { drawn: string[]; picked: string; time: number };
  } | null {
    const st = this.pawnStates.get(eid);
    if (!st) return null;
    return {
      dna: st.dna, slots: st.slots, job: st.job ?? '',
      needs: this.readNeeds(eid), health: this.readHealth(eid),
      pos: this.pawnPositions.get(eid) ?? { x: 0, y: 0 },
      faith: st.faith ?? 0,
      skills: st.skills ?? {},
      desires: st.desires ?? initDesires(this.rng),
      oracleBuff: st.oracleBuff,
      assignedJob: st.assignedJob,
      lastDecision: st.lastDecision,
    };
  }

  // ---- 历史查询 ----
  historyQuery(opts?: { type?: string; eid?: number; limit?: number }) {
    return this.history.query(opts);
  }
  get historyRecent() { return this.history.recent; }

  // ---- 存档 ----
  save(): SaveData {
    return {
      time: this.time,
      dayTime: this.dayTime,
      stockpile: { ...this.stockpile },
      tiles: this.world.serializeTiles(),
      buildings: this.world.serializeBuildings(),
      units: [...this.socialUnits.units.values()].map((u) => ({
        id: u.id, key: u.key, level: u.level, name: u.name,
        members: [...u.members], memory: [...u.memory],
        opinions: [...u.opinions.entries()],
        resources: { ...u.resources },
        tradeBalance: [...u.tradeBalance.entries()],
        createdAt: u.createdAt,
      })),
      playerUnitId: this.playerUnitId,
      pawns: this._pawnList.map((eid) => {
        const st = this.pawnStates.get(eid)!;
        const pos = this.readPosition(eid)!;
        return {
          eid,
          x: pos.x, y: pos.y,
          dna: st.dna,
          slots: st.slots.map((c) => (c ? c.id : null)),
          needs: this.readNeeds(eid),
          health: this.readHealth(eid),
          faith: st.faith ?? 0,
          skills: st.skills ?? {},
          desires: st.desires ?? initDesires(this.rng),
          oracleBuff: st.oracleBuff,
          assignedJob: st.assignedJob,
        };
      }),
    };
  }

  load(data: SaveData): void {
    this.time = data.time ?? 0;
    this.dayTime = data.dayTime ?? 0;
    if (data.stockpile) this.stockpile = { wood: 50, ore: 0, food: 30, tools: 0, ...data.stockpile };
    if (data.tiles) this.world.loadTiles(data.tiles);
    if (data.buildings) this.world.loadBuildings(data.buildings);
    // 恢复社会单位（派系记忆/看法/库存）
    this.socialUnits.units.clear();
    this.socialUnits.membership.clear();
    if (data.units) {
      for (const u of data.units) {
        this.socialUnits.units.set(u.id, {
          id: u.id, key: u.key, level: u.level, name: u.name,
          // members/membership 由下方重新 spawn 小人时填充（旧 eid 作废）
          members: [],
          memory: [...u.memory],
          opinions: new Map(u.opinions),
          resources: { ...u.resources },
          tradeBalance: new Map(u.tradeBalance),
          createdAt: u.createdAt,
        });
      }
    }
    this.playerUnitId = data.playerUnitId ?? null;
    // 恢复单位 id 序列，避免新单位 id 冲突
    let maxSeq = 0;
    for (const id of this.socialUnits.units.keys()) {
      const m = /^u(\d+)$/.exec(id);
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
    }
    setUnitSeq(maxSeq);
    // 重建小人（拷贝列表遍历，否则 killPawn 的 splice 会跳过隔一个）
    for (const eid of [...this._pawnList]) this.killPawn(eid);
    if (data.pawns) {
      for (const p of data.pawns) {
        const eid = this.spawnPawn(Math.round(p.x), Math.round(p.y));
        if (eid === -1) continue;
        const st = this.pawnStates.get(eid)!;
        st.dna = p.dna;
        // 卡槽存 id（JSON-safe）：还原时按 id 从 mod 卡 → 基础卡 → 天赋卡 重取；查不到降级 null（抽卡跳过）
        st.slots = (p.slots ?? []).map((id) => {
          if (!id) return null;
          return this.mods.cards.get(id) ?? BASE_CARDS.find((b) => b.id === id) ?? Object.values(TRAIT_CARDS).find((c) => c.id === id) ?? null;
        });
        st.faith = p.faith ?? 0;
        st.skills = p.skills ?? {};
        st.desires = p.desires ?? initDesires(this.rng);
        st.oracleBuff = p.oracleBuff;
        st.assignedJob = p.assignedJob;
        if (p.needs) this.setNeeds(eid, p.needs);
        if (p.health) this.setHealth(eid, p.health);
      }
    }
    // 重建后把小人重新归入最近的派系单位（否则 members 恒空 → 首轮 step 误判团灭附身）
    for (const eid of this._pawnList) this.socialUnits.assignPawn(eid);
    // 玩家单位若已不存在（坏档）则置空，由 checkPossession 逻辑接管
    if (this.playerUnitId && !this.socialUnits.units.has(this.playerUnitId)) this.playerUnitId = null;
  }
}
