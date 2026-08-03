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
import { generateDna, initSlots, type Dna, type SkillId, BASE_CARDS } from './ai/pawn';
import { initDesires, type DesireId } from './core/desires';
import { initEnv, tickEnv, type EnvState } from './core/env';
import { BUILDINGS, TILES, ITEMS } from './defs';
import { ModRegistry } from './mods/registry';
import type { SimContext } from './systems/context';
import { SystemRegistry } from './systems/registry';
import { NeedsSystem } from './systems/needsSystem';
import { SanSystem } from './systems/sanSystem';
import { DesireSystem } from './systems/desireSystem';
import { SocialSystem } from './systems/socialSystem';
import { EventSystem } from './systems/eventSystem';
import { AutonomousBuildSystem } from './systems/autonomousBuildSystem';
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
}

export interface SimOptions {
  seed?: number;
  pawnCount?: number;
  tickHz?: number;
  mods?: (m: ModRegistry) => void; // mod 挂载：构造时注册系统/卡/意图（DESIGN §7）
}

export interface Command {
  type: 'move' | 'build' | 'haul' | 'mine';
  pawnId?: number;
  x: number;
  y: number;
  buildingId?: string;
}

export interface SaveData {
  time: number;
  dayTime: number;
  stockpile: Record<string, number>;
  tiles: string[];
  buildings: { key: number; defId: string; hp: number; faction: string }[];
  pawns: {
    eid: number; x: number; y: number;
    dna: Dna; slots: ReturnType<typeof initSlots>;
    needs: NeedsData | null; health: HealthData | null;
    faith?: number;
    skills?: Partial<Record<SkillId, number>>;
    desires?: Record<DesireId, number>;
  }[];
}

export class Sim implements SimContext {
  ecs: EcsWorld;
  world: World;
  rng: SimRng;
  bus: EventBus;
  tickHz: number;
  time = 0;
  dayLength = 120;
  hasDayCycle = true;
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
  hostiles: { x: number; y: number; hp: number; maxHp: number; targetX: number; targetY: number }[] = [];
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
    cards: BASE_CARDS,
    intents: [],
  });
  private behavior: BehaviorSystem;
  private _started = false;

  constructor(opts: SimOptions = {}) {
    const seed = opts.seed ?? 12345;
    const pawnCount = opts.pawnCount ?? 4;
    this.tickHz = opts.tickHz ?? 20;
    this.ecs = createWorld();
    registerAutoStore(this.ecs, Position);
    registerAutoStore(this.ecs, NeedsComp);
    registerAutoStore(this.ecs, Speed);
    registerAutoStore(this.ecs, Health);
    this.world = new World(seed);
    this.rng = new SimRng(seed + 1);
    this.bus = new EventBus();
    // 所有事件 → 结构化历史
    this.bus.onAny((ev) => this.history.record(ev, this.time, this.time / this.dayLength));

    this.behavior = new BehaviorSystem(this);
    // 应用 mod（在 spawn 前，注册系统/卡/意图）——构造期回调
    opts.mods?.(this.mods);
    this.applyMods();
    this.registerSystems();
    this._started = true;
    this.registry.initAll(this.bus);
    this.spawnPawns(pawnCount);
  }

  // mod 挂载入口：mod 注册新系统/新卡/新意图（DESIGN §7）
  useMods(fn: (m: ModRegistry) => void): void {
    if (this._started) throw new Error('mod 必须在 sim 启动前注册');
    fn(this.mods);
  }

  private applyMods(): void {
    // mod 注册的系统挂到系统注册表
    for (const s of this.mods.allSystems) this.registry.register(s);
    // mod 注册的意图执行器交给行为系统
    for (const [id, fn] of this.mods.intents) {
      this.behavior.registerIntent(id, fn);
    }
  }

  private registerSystems(): void {
    this.registry
      .register(new NeedsSystem(this))
      .register(new SanSystem(this))
      .register(new DesireSystem(this))
      .register(this.behavior)
      .register(new SocialSystem(this))
      .register(new GatherSystem(this))
      .register(new BuildSystem(this))
      .register(new FarmSystem(this))
      .register(new CraftSystem(this))
      .register(new RepairSystem(this))
      .register(new RaidSystem(this))
      .register(new PopulationSystem(this))
      .register(new EventSystem(this, SCRIPTED_EVENTS))
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
      // 玩家命令优先：3 秒内不自动决策
      st.commandCooldown = 3;
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
    const R = 15;
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
    setComponent(this.ecs, eid, Speed, { v: 4 });
    const dna = generateDna(this.seedFor(eid));
    addComponent(this.ecs, eid, Health);
    const maxHp = 40 + Math.floor((dna.con + dna.siz) / 2);
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

  private seedFor(eid: number): number {
    return (this.rng.int(1, 2 ** 31 - 1) ^ eid) >>> 0;
  }

  // ---- 命令 ----
  issueCommand(cmd: Command): void {
    if (cmd.type === 'build') {
      this.queueBuild(cmd.x, cmd.y, cmd.buildingId ?? 'wall');
      return;
    }
    const eids = cmd.pawnId ? [cmd.pawnId] : this.selected;
    for (const eid of eids) {
      if (cmd.type === 'move') this.moveTo(eid, cmd.x, cmd.y);
      else if (cmd.type === 'mine') this.mineAt(eid, cmd.x, cmd.y);
    }
  }

  private queueBuild(x: number, y: number, defId: string): void {
    if (!this.world.canBuildAt(x, y)) return;
    const def = BUILDINGS[defId];
    if (!def) return;
    const cost = { wood: def.size.x * def.size.y * 2, ore: 0 };
    if (this.stockpile.wood < cost.wood) return;
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
    this.prioTimer = 10; // 每 10 秒评估一次环境 → 派系工作优先级
    const s = this.stockpile;
    const pri: Record<string, number> = {};
    // 基线 1.0，短缺的资源对应工作权重升高（AI 下达优先指令）
    const foodLow = (s.food ?? 0) < 60 ? 1.6 : 1;
    const woodLow = s.wood < 40 ? 1.5 : 1;
    const oreLow = s.ore < 15 ? 1.4 : 1;
    const building = this.buildQueue.length > 0 ? 1.8 : 1;
    pri.farm = foodLow;
    pri.chop = woodLow;
    pri.mine = oreLow;
    pri.caveMine = oreLow;
    pri.build = building;
    // 饥饿紧急时优先生产食物
    if ((s.food ?? 0) < 20) pri.farm = 2.4;
    this.factionPriority = pri;
  }

  // ---- 主循环 ----
  step(dt: number): void {
    if (this.paused) return;
    dt *= this.speed;
    this.time += dt;
    this.dayTime = (this.time % this.dayLength) / this.dayLength;
    tickEnv(this.env, dt, this.dayTime, this.rng);
    this.updateFactionPriority(dt);
    this.registry.updateAll(dt);
  }

  // ---- UI 读取 ----
  get pawns(): readonly number[] { return this._pawnList; }  get buildCount(): number { return this.buildQueue.length; }
  get buildQueueItems(): { x: number; y: number; defId: string; progress: number }[] {
    return this.buildQueue.map((b) => ({ x: b.x, y: b.y, defId: b.defId, progress: b.progress }));
  }
  buildingAt(x: number, y: number): { defId: string; hp: number; maxHp: number; faction: string } | null {
    const b = this.world.getBuilding(x, y);
    if (!b) return null;
    return { defId: b.def.id, hp: Math.round(b.hp), maxHp: b.def.hp, faction: b.faction };
  }
  pawnJob(eid: number): string { return this.pawnStates.get(eid)?.job ?? ''; }
  needsOf(eid: number) { return this.readNeeds(eid); }
  healthOf(eid: number) { return this.readHealth(eid); }
  get selectedIds(): number[] { return this.selected; }
  set selectedIds(list: number[]) { this.selected = list; }

  pawnProfile(eid: number): {
    dna: Dna; slots: ReturnType<typeof initSlots>; job: string;
    needs: NeedsData | null; health: HealthData | null; pos: { x: number; y: number };
    faith: number;
    skills: Partial<Record<SkillId, number>>;
    desires: Record<DesireId, number>;
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
      pawns: this._pawnList.map((eid) => {
        const st = this.pawnStates.get(eid)!;
        const pos = this.readPosition(eid)!;
        return {
          eid,
          x: pos.x, y: pos.y,
          dna: st.dna,
          slots: st.slots,
          needs: this.readNeeds(eid),
          health: this.readHealth(eid),
          faith: st.faith ?? 0,
          skills: st.skills ?? {},
          desires: st.desires ?? initDesires(this.rng),
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
    // 重建小人
    for (const eid of this._pawnList) this.killPawn(eid);
    if (data.pawns) {
      for (const p of data.pawns) {
        const eid = this.spawnPawn(Math.round(p.x), Math.round(p.y));
        if (eid === -1) continue;
        const st = this.pawnStates.get(eid)!;
        st.dna = p.dna;
        st.slots = p.slots;
        st.faith = p.faith ?? 0;
        st.skills = p.skills ?? {};
        st.desires = p.desires ?? initDesires(this.rng);
        if (p.needs) this.setNeeds(eid, p.needs);
        if (p.health) this.setHealth(eid, p.health);
      }
    }
  }
}
