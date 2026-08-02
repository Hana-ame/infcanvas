// Sim —— P0 单机仿真核心（bitecs ECS）
// 目标：可玩的单殖民地闭环。P1 起 server 复用同一份。
import {
  createWorld, addEntity, addComponent, setComponent, getComponent, query,
  observe, onSet,
  type World as EcsWorld,
} from 'bitecs';
import { World } from './core/world';
import { findPath } from './core/pathfinding';
import { SimRng } from './core/rng';
import { initNeeds, tickNeeds, urgentNeedAction, type Needs } from './core/needs';
import { generateDna, initSlots, pickNextAction, type Dna } from './ai/pawn';
import { BUILDINGS } from './defs';

// ---- ECS 组件定义（bitecs 0.4：SoA 数组存储，组件 = { field: [], ... }） ----
export interface PositionData { x: number; y: number }
export interface NeedsData { food: number; rest: number; mood: number }
export interface SpeedData { v: number }

export const Position = { x: [] as number[], y: [] as number[] };
export const Pawn = {} as { _flag?: number[] };
export const NeedsComp = { food: [] as number[], rest: [] as number[], mood: [] as number[] };
export const Speed = { v: [] as number[] };

// 注册组件数据的自动存储 observer：setComponent 时把数据写进 SoA 数组
function registerAutoStore(world: EcsWorld, component: Record<string, number[]>): void {
  observe(world, onSet(component), (eid: number, data: Record<string, number>) => {
    for (const key of Object.keys(data)) {
      const arr = component[key];
      if (Array.isArray(arr)) arr[eid] = data[key];
    }
  });
}

export interface PawnState {
  dna: Dna;
  slots: ReturnType<typeof initSlots>;
  path: { x: number; y: number }[];
  pathIndex: number;
  urgent?: 'eat' | 'rest';
  mining?: { x: number; y: number; progress: number };
  mineTarget?: { x: number; y: number };
}

export interface SimOptions {
  seed?: number;
  pawnCount?: number;
  tickHz?: number;
}

export interface Command {
  type: 'move' | 'build' | 'haul' | 'mine';
  pawnId?: number;
  x: number;
  y: number;
  buildingId?: string;
}

export class Sim {
  ecs: EcsWorld;
  world: World;
  rng: SimRng;
  tickHz: number;
  time = 0;

  pawnStates = new Map<number, PawnState>();
  pawnPositions = new Map<number, { x: number; y: number }>();
  selected: number[] = [];
  private pawnList: number[] = [];

  private buildQueue: { x: number; y: number; defId: string; progress: number; faction: string }[] = [];
  stockpile: Record<string, number> = { wood: 0, ore: 0, food: 0 };

  constructor(opts: SimOptions = {}) {
    const seed = opts.seed ?? 12345;
    const pawnCount = opts.pawnCount ?? 4;
    this.tickHz = opts.tickHz ?? 20;
    this.ecs = createWorld();
    registerAutoStore(this.ecs, Position);
    registerAutoStore(this.ecs, NeedsComp);
    registerAutoStore(this.ecs, Speed);
    this.world = new World(seed);
    this.rng = new SimRng(seed + 1);
    this.spawnPawns(pawnCount);
  }

  private spawnPawns(count: number): void {
    const cx = Math.floor(this.world.width / 2);
    const cy = Math.floor(this.world.height / 2);
    for (let i = 0; i < count; i++) {
      const eid = addEntity(this.ecs);
      const x = cx + (i % 3) - 1;
      const y = cy + Math.floor(i / 3) - 1;
      addComponent(this.ecs, eid, Position);
      setComponent(this.ecs, eid, Position, { x, y });
      addComponent(this.ecs, eid, Pawn);
      addComponent(this.ecs, eid, NeedsComp);
      setComponent(this.ecs, eid, NeedsComp, initNeeds());
      addComponent(this.ecs, eid, Speed);
      setComponent(this.ecs, eid, Speed, { v: 4 });
      const dna = generateDna(this.seedFor(eid));
      this.pawnStates.set(eid, { dna, slots: initSlots(dna), path: [], pathIndex: 0 });
      this.pawnList.push(eid);
      this.pawnPositions.set(eid, { x, y });
    }
  }

  get pawns(): readonly number[] {
    return this.pawnList;
  }

  private seedFor(eid: number): number {
    return (this.rng.int(1, 2 ** 31 - 1) ^ eid) >>> 0;
  }

  // ---- 命令 ----
  issueCommand(cmd: Command): void {
    if (cmd.type === 'build') {
      // 建造不需要选中小人，直接入队
      this.queueBuild(cmd.x, cmd.y, cmd.buildingId ?? 'wall');
      return;
    }
    const eids = cmd.pawnId ? [cmd.pawnId] : this.selected;
    for (const eid of eids) {
      if (cmd.type === 'move') this.moveTo(eid, cmd.x, cmd.y);
      else if (cmd.type === 'mine') this.mineAt(eid, cmd.x, cmd.y);
    }
  }

  private moveTo(eid: number, x: number, y: number): void {
    const pos = readPosition(this.ecs, eid);
    if (!pos) return;
    const path = findPath(this.world, Math.round(pos.x), Math.round(pos.y), Math.round(x), Math.round(y));
    const st = this.pawnStates.get(eid);
    if (st) {
      st.path = path;
      st.pathIndex = 0;
      st.mineTarget = undefined;
      st.mining = undefined;
    }
  }

  private queueBuild(x: number, y: number, defId: string): void {
    if (!this.world.canBuildAt(x, y)) return;
    const def = BUILDINGS[defId];
    if (!def) return;
    this.buildQueue.push({ x, y, defId, progress: 0, faction: 'player' });
  }

  private mineAt(eid: number, x: number, y: number): void {
    const st = this.pawnStates.get(eid);
    if (!st) return;
    const tile = this.world.getTileDef(x, y);
    if (!tile.mineral) return;
    const pos = readPosition(this.ecs, eid);
    if (!pos) return;
    const path = findPath(this.world, Math.round(pos.x), Math.round(pos.y), x, y);
    st.path = path;
    st.pathIndex = 0;
    st.mineTarget = { x, y };
  }

  // ---- 主循环 ----
  step(dt: number): void {
    this.time += dt;

    // 1. 需求衰减 + 紧急需求
    const pawnIds = query(this.ecs, [Pawn, NeedsComp]);
    for (const eid of pawnIds) {
      const n = readNeeds(this.ecs, eid);
      if (!n) continue;
      tickNeeds(n, dt);
      setComponent(this.ecs, eid, NeedsComp, n);
      const urgent = urgentNeedAction(n);
      const st = this.pawnStates.get(eid);
      if (urgent && st) st.urgent = urgent;
    }

    // 2. 行为 + 移动
    this.updatePawns(dt);

    // 3. 建造
    this.updateBuilds(dt);

    // 4. 采矿
    this.updateMining(dt);
  }

  private updatePawns(dt: number): void {
    for (const eid of this.pawnList) {
      const st = this.pawnStates.get(eid);
      if (!st) continue;
      const pos = readPosition(this.ecs, eid);
      if (!pos) continue;

      // 紧急需求优先
      if (st.urgent) {
        this.handleUrgent(eid, st, dt);
        continue;
      }

      // 走路
      if (st.path && st.pathIndex < st.path.length) {
        const target = st.path[st.pathIndex];
        const dx = target.x - pos.x;
        const dy = target.y - pos.y;
        const dist = Math.hypot(dx, dy);
        const sp = readSpeed(this.ecs, eid);
        const speed = sp?.v ?? 4;
        const move = speed * dt;
        if (dist <= move) {
          pos.x = target.x;
          pos.y = target.y;
          st.pathIndex++;
          if (st.pathIndex >= st.path.length) {
            st.path = [];
            this.onArrive(eid, st);
          }
        } else {
          pos.x += (dx / dist) * move;
          pos.y += (dy / dist) * move;
        }
        setComponent(this.ecs, eid, Position, pos);
        this.pawnPositions.set(eid, { x: pos.x, y: pos.y });
        continue;
      }

      // 空闲：按插槽挑动作（P0 简化：无紧急则闲逛，等玩家命令）
      this.doAction(eid, st, pos, dt);
    }
  }

  private handleUrgent(eid: number, st: PawnState, dt: number): void {
    const n = readNeeds(this.ecs, eid);
    if (!n) return;
    if (st.urgent === 'eat' && n.food >= 70) { st.urgent = undefined; return; }
    if (st.urgent === 'rest' && n.rest >= 70) { st.urgent = undefined; return; }
    if (st.urgent === 'eat' && this.stockpile.food > 0) {
      this.stockpile.food--;
      n.food = Math.min(100, n.food + 50);
      setComponent(this.ecs, eid, NeedsComp, n);
      st.urgent = undefined;
    } else if (st.urgent === 'rest') {
      n.rest = Math.min(100, n.rest + 40);
      setComponent(this.ecs, eid, NeedsComp, n);
      st.urgent = undefined;
    }
  }

  private doAction(eid: number, st: PawnState, pos: PositionData, dt: number): void {
    // P0 简化：玩家命令驱动。空闲时原地不动，等右键指令。
    void eid; void st; void pos; void dt;
  }

  private onArrive(eid: number, st: PawnState): void {
    if (st.mineTarget) {
      const { x, y } = st.mineTarget;
      st.mineTarget = undefined;
      st.mining = { x, y, progress: 0 };
    }
  }

  private updateBuilds(dt: number): void {
    for (let i = this.buildQueue.length - 1; i >= 0; i--) {
      const b = this.buildQueue[i];
      b.progress += dt;
      const def = BUILDINGS[b.defId];
      if (b.progress >= def.buildTime) {
        this.world.placeBuilding(b.x, b.y, b.defId, b.faction);
        this.buildQueue.splice(i, 1);
      }
    }
  }

  private updateMining(dt: number): void {
    for (const eid of this.pawnList) {
      const st = this.pawnStates.get(eid);
      if (!st?.mining) continue;
      st.mining.progress += dt;
      if (st.mining.progress >= 3) {
        const { x, y } = st.mining;
        this.world.setTile(x, y, 'dirt');
        this.stockpile.ore++;
        st.mining = undefined;
      }
    }
  }
}

// ---- SoA 数组读取辅助（bitecs 0.4：组件 = 数组，直接读 Position.x[eid]） ----
function readPosition(_world: EcsWorld, eid: number): PositionData | null {
  if (Position.x[eid] === undefined) return null;
  return { x: Position.x[eid], y: Position.y[eid] };
}

function readSpeed(_world: EcsWorld, eid: number): SpeedData | null {
  if (Speed.v[eid] === undefined) return null;
  return { v: Speed.v[eid] };
}

function readNeeds(_world: EcsWorld, eid: number): NeedsData | null {
  if (NeedsComp.food[eid] === undefined) return null;
  return { food: NeedsComp.food[eid], rest: NeedsComp.rest[eid], mood: NeedsComp.mood[eid] };
}
