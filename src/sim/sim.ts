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
export const Health = { hp: [] as number[], maxHp: [] as number[] };

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
  chopTarget?: { x: number; y: number }; // 砍树目标
  chopXY?: { x: number; y: number };
  chopProgress?: number;
  job?: string; // 当前做的事（树/矿/建造/闲逛）
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
  // 昼夜：一天 = 120 秒（现实时间），dayTime 0[深夜]-0.25[凌晨]-0.5[正午]-0.75[黄昏]
  dayLength = 120;
  hasDayCycle = true;
  dayTime = 0; // 0..1
  speed = 1; // 1x/2x/3x
  paused = false;

  pawnStates = new Map<number, PawnState>();
  pawnPositions = new Map<number, { x: number; y: number }>();
  selected: number[] = [];
  private pawnList: number[] = [];
  private _recruitTimer = 0;
  // 敌袭（WorldBox 风格威胁）
  hostiles: { x: number; y: number; hp: number; maxHp: number; targetX: number; targetY: number }[] = [];
  private raidTimer = 60; // 首次袭击倒计时（秒）
  raidActive = false;
  // 行动轨迹缓存：起点格+终点格 → 已算路径（直接读取复用）
  private trailCache = new Map<string, { x: number; y: number }[]>();

  private buildQueue: { x: number; y: number; defId: string; progress: number; faction: string; cost?: { wood: number; ore: number } }[] = [];
  stockpile: Record<string, number> = { wood: 50, ore: 0, food: 30 };

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
    this.spawnPawns(pawnCount);
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

  // 在指定位置生成一个 pawn，返回 eid（用于动态加入）
  private spawnPawn(x: number, y: number): number {
    if (!this.world.inBounds(x, y) || !this.world.isPassable(x, y)) return -1;
    const eid = addEntity(this.ecs);
    addComponent(this.ecs, eid, Position);
    setComponent(this.ecs, eid, Position, { x, y });
    addComponent(this.ecs, eid, Pawn);
    addComponent(this.ecs, eid, NeedsComp);
    setComponent(this.ecs, eid, NeedsComp, initNeeds());
    addComponent(this.ecs, eid, Speed);
    setComponent(this.ecs, eid, Speed, { v: 4 });
    addComponent(this.ecs, eid, Health);
    setComponent(this.ecs, eid, Health, { hp: 100, maxHp: 100 });
    const dna = generateDna(this.seedFor(eid));
    this.pawnStates.set(eid, { dna, slots: initSlots(dna), path: [], pathIndex: 0 });
    this.pawnList.push(eid);
    this.pawnPositions.set(eid, { x, y });
    return eid;
  }

  get pawns(): readonly number[] {
    return this.pawnList;
  }

  // UI 读取建造队列
  get buildCount(): number {
    return this.buildQueue.length;
  }

  // UI 读取工作/状态
  pawnJob(eid: number): string {
    return this.pawnStates.get(eid)?.job ?? '';
  }

  // UI 读取需求
  needsOf(eid: number): { food: number; rest: number; mood: number } | null {
    return readNeeds(this.ecs, eid);
  }

  healthOf(eid: number): { hp: number; maxHp: number } | null {
    return readHealth(this.ecs, eid);
  }

  isNight(): boolean {
    return this.dayTime > 0.72 || this.dayTime < 0.22;
  }

  // UI 同步选中
  get selectedIds(): number[] {
    return this.selected;
  }
  set selectedIds(list: number[]) {
    this.selected = list;
  }

  // UI 读取完整档案（属性/DNA/插槽卡）
  pawnProfile(eid: number): {
    dna: Dna;
    slots: ReturnType<typeof initSlots>;
    job: string;
    needs: { food: number; rest: number; mood: number } | null;
    health: { hp: number; maxHp: number } | null;
    pos: { x: number; y: number };
  } | null {
    const st = this.pawnStates.get(eid);
    if (!st) return null;
    return {
      dna: st.dna,
      slots: st.slots,
      job: st.job ?? '',
      needs: this.needsOf(eid),
      health: this.healthOf(eid),
      pos: this.pawnPositions.get(eid) ?? { x: 0, y: 0 },
    };
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
    }
  }

  // 带轨迹缓存的寻路：相同起终点直接复用，避免重复 A*
  private getPath(sx: number, sy: number, ex: number, ey: number): { x: number; y: number }[] {
    const key = `${sx},${sy}->${ex},${ey}`;
    const cached = this.trailCache.get(key);
    if (cached) return cached;
    const path = findPath(this.world, sx, sy, ex, ey);
    // 只缓存有价值的（长度>2 且可达），避免缓存满
    if (path.length > 0) {
      if (this.trailCache.size > 2048) this.trailCache.clear();
      this.trailCache.set(key, path);
    }
    return path;
  }

  private queueBuild(x: number, y: number, defId: string): void {
    if (!this.world.canBuildAt(x, y)) return;
    const def = BUILDINGS[defId];
    if (!def) return;
    // 建造消耗木材+矿石（简单固定成本）
    const cost = { wood: def.size.x * def.size.y * 2, ore: 0 };
    if (this.stockpile.wood < cost.wood) return; // 木头不足，不给建
    this.buildQueue.push({ x, y, defId, progress: 0, faction: 'player', cost });
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
    if (this.paused) return;
    dt *= this.speed;
    this.time += dt;
    this.dayTime = (this.time % this.dayLength) / this.dayLength;

    // 1. 需求衰减 + 紧急需求 + 饥饿伤害
    const pawnIds = query(this.ecs, [Pawn, NeedsComp]);
    for (const eid of pawnIds) {
      if (!this.pawnStates.has(eid)) continue;
      const n = readNeeds(this.ecs, eid);
      if (!n) continue;
      tickNeeds(n, dt);
      // 夜晚：精力消耗加快（夜深人困）
      if (this.isNight()) n.rest -= 0.12 * dt;
      setComponent(this.ecs, eid, NeedsComp, n);
      // 饿死：食物耗尽持续掉血
      const h = readHealth(this.ecs, eid);
      if (n.food <= 0 && h) {
        h.hp -= 2.5 * dt;
        if (Math.floor(h.hp) < 0) {
          h.hp = 0;
          this.killPawn(eid);
        }
        setComponent(this.ecs, eid, Health, h);
      }
      const urgent = urgentNeedAction(n);
      const st = this.pawnStates.get(eid);
      if (urgent && st && this.pawnStates.has(eid)) st.urgent = urgent;
    }

    // 2. 行为 + 移动
    this.updatePawns(dt);

    // 3. 建造
    this.updateBuilds(dt);

    // 4. 采矿
    this.updateMining(dt);

    // 5. 农田产出食物
    this.updateFarms(dt);

    // 6. 人口发展
    this.updatePopulation(dt);

    // 7. 敌袭 + 战斗
    this.updateRaids(dt);
    this.updateCombat(dt);
  }

  // 敌袭：定期从地图边缘刷入侵者，走向殖民地中心
  private updateRaids(dt: number): void {
    if (this.pawnList.length === 0) return;
    if (!this.raidActive) {
      this.raidTimer -= dt;
      if (this.raidTimer <= 0) {
        this.raidActive = true;
        this.spawnRaid(Math.floor(2 + this.pawnList.length * 0.5));
      }
      return;
    }
    // 敌袭已清空则结束
    if (this.hostiles.length === 0) this.raidActive = false;
  }

  private spawnRaid(count: number): void {
    const w = this.world;
    // 随机一个边
    const edge = Math.floor(this.rng.next() * 4);
    const cx = Math.floor(w.width / 2);
    const cy = Math.floor(w.height / 2);
    for (let i = 0; i < count; i++) {
      let x: number, y: number;
      if (edge === 0) { x = this.rng.int(0, w.width - 1); y = 0; }
      else if (edge === 1) { x = this.rng.int(0, w.width - 1); y = w.height - 1; }
      else if (edge === 2) { x = 0; y = this.rng.int(0, w.height - 1); }
      else { x = w.width - 1; y = this.rng.int(0, w.height - 1); }
      this.hostiles.push({ x, y, hp: 60, maxHp: 60, targetX: cx, targetY: cy });
    }
  }

  // 战斗：入侵者靠近殖民地 → 自动接敌伤害
  private updateCombat(dt: number): void {
    if (this.hostiles.length === 0) return;
    // 入侵者向目标移动
    for (const h of this.hostiles) {
      const dx = h.targetX - h.x;
      const dy = h.targetY - h.y;
      const d = Math.hypot(dx, dy);
      const speed = 3.5;
      const step = speed * dt;
      if (d > step) {
        h.x += (dx / d) * step;
        h.y += (dy / d) * step;
      }
    }
    // 靠近据点时对入侵者尝试攻击（有 pawn 在场）
    for (let i = this.hostiles.length - 1; i >= 0; i--) {
      const h = this.hostiles[i];
      // 找离它最近的 pawn 战斗
      let nearest: number | null = null;
      let nd = 5; // 交战距离（格）
      for (const eid of this.pawnList) {
        const pos = this.pawnPositions.get(eid);
        if (!pos) continue;
        const d = Math.hypot(pos.x - h.x, pos.y - h.y);
        if (d < nd) { nd = d; nearest = eid; }
      }
      if (nearest !== null) {
        // 我方攻击
        const dmg = 8 * dt;
        h.hp -= dmg;
        if (h.hp <= 0) {
          this.hostiles.splice(i, 1);
          this.stockpile.ore += 2; // 击杀掉落
          continue;
        }
        // 敌人反击
        const hk = this.healthOf(nearest);
        if (hk) {
          const eco = Math.min(hk.hp, 5 * dt);
          hk.hp -= eco;
          setComponent(this.ecs, nearest, Health, { hp: Math.max(0, hk.hp), maxHp: hk.maxHp });
          if (hk.hp <= 0) this.killPawn(nearest);
        }
      }
    }
  }

  // 人口：食物充足时偶有新人加入
  private updatePopulation(dt: number): void {
    if (this.pawnList.length >= 12) return;
    this._recruitTimer += dt;
    if (this._recruitTimer < 45) return;
    if (this.stockpile.food < 60) { this._recruitTimer = 30; return; }
    this._recruitTimer = 0;
    this.spawnPawnAtEdge();
  }

  private spawnPawnAtEdge(): void {
    // 在出生点附近新增一个小人
    const cx = Math.floor(this.world.width / 2);
    const cy = Math.floor(this.world.height / 2);
    for (let r = 2; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = cx + dx, y = cy + dy;
          if (this.world.inBounds(x, y) && this.world.isPassable(x, y)) {
            const eid = this.spawnPawn(x, y);
            if (eid !== -1) return;
          }
        }
      }
    }
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

  private killPawn(eid: number): void {
    // 从活动列表移除（渲染层会随 pawnPositions 消失）
    const idx = this.pawnList.indexOf(eid);
    if (idx >= 0) this.pawnList.splice(idx, 1);
    this.pawnStates.delete(eid);
    this.pawnPositions.delete(eid);
    this.selected = this.selected.filter((s) => s !== eid);
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
    void dt;
    // 自主 AI：空闲时自动找活干
    this.assignAutoWork(eid, st, pos);
  }

  // 自主找活干：优先级 = 建造 > 砍树 > 采矿 > 闲逛
  private assignAutoWork(eid: number, st: PawnState, pos: PositionData): void {
    // 已在干活（砍/采/建中）则不要打断
    if (st.chopXY || st.mining) return;
    const w = this.world;

    // 1. 建造（有蓝图且附近有空闲耗时）
    if (this.buildQueue.length > 0) {
      const b = this.buildQueue[0];
      const def = BUILDINGS[b.defId];
      st.job = `建造:${def.name}`;
      this.moveTo(eid, b.x, b.y);
      return;
    }

    // 2. 砍树：找最近的树
    const tree = this.findNearest(pos, (x, y) => w.getTile(x, y) === 'tree', true);
    if (tree) {
      st.job = '伐木';
      st.chopTarget = tree;
      this.moveAdjacent(eid, tree.x, tree.y);
      return;
    }

    // 3. 采矿：找最近的矿
    const ore = this.findNearest(pos, (x, y) => w.getTile(x, y) === 'ore', true);
    if (ore) {
      st.job = '采矿';
      st.mineTarget = ore;
      this.moveAdjacent(eid, ore.x, ore.y);
      return;
    }

    // 4. 闲逛
    st.job = '闲逛';
  }

  // 在半径内找最近的（allowNonPassable=true 时目标格本身可不可走无所谓）
  private findNearest(pos: PositionData, cond: (x: number, y: number) => boolean, allowNonPassable = false): { x: number; y: number } | null {
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

  // 移动到目标旁的一个可走格
  private moveAdjacent(eid: number, tx: number, ty: number): void {
    const pos = readPosition(this.ecs, eid);
    if (!pos) return;
    // 找 target 邻域可走格
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

  private onArrive(eid: number, st: PawnState): void {
    if (st.mineTarget) {
      const { x, y } = st.mineTarget;
      st.mineTarget = undefined;
      st.mining = { x, y, progress: 0 };
    } else if (st.chopTarget) {
      // 到达树旁，开始砍树
      const { x, y } = st.chopTarget;
      st.chopTarget = undefined;
      st.chopProgress = 0;
      st.chopXY = { x, y };
    }
  }

  private updateBuilds(dt: number): void {
    for (let i = this.buildQueue.length - 1; i >= 0; i--) {
      const b = this.buildQueue[i];
      b.progress += dt;
      const def = BUILDINGS[b.defId];
      if (b.progress >= def.buildTime) {
        // 扣除成本（在完成时扣，简化）
        if (b.cost) {
          this.stockpile.wood -= b.cost.wood;
        }
        this.world.placeBuilding(b.x, b.y, b.defId, b.faction);
        this.trailCache.clear(); // 地形变化，缓存失效
        this.buildQueue.splice(i, 1);
      }
    }
  }

  // 农田产出食物（简化：每块 farm 格缓慢产出）
  private updateFarms(dt: number): void {
    let farms = 0;
    for (const [key, b] of this.world.buildings) {
      if (b.def.id === 'farm') farms++;
    }
    if (farms > 0) {
      this.stockpile.food += farms * 0.2 * dt;
      if (this.stockpile.food > 500) this.stockpile.food = 500;
    }
  }

  private updateMining(dt: number): void {
    for (const eid of this.pawnList) {
      const st = this.pawnStates.get(eid);
      // 采矿
      if (st?.mining) {
        st.mining.progress += dt;
        if (st.mining.progress >= 3) {
          const { x, y } = st.mining;
          this.world.setTile(x, y, 'dirt');
          this.stockpile.ore++;
          st.mining = undefined;
          this.trailCache.clear();
        }
      }
      // 砍树
      if (st?.chopXY) {
        st.chopProgress = (st.chopProgress ?? 0) + dt;
        if (st.chopProgress >= 2.5) {
          const { x, y } = st.chopXY;
          this.world.setTile(x, y, 'grass');
          this.stockpile.wood += 3;
          st.chopXY = undefined;
          st.chopProgress = undefined;
          this.trailCache.clear();
        }
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

function readHealth(_world: EcsWorld, eid: number): { hp: number; maxHp: number } | null {
  if (Health.hp[eid] === undefined) return null;
  return { hp: Health.hp[eid], maxHp: Health.maxHp[eid] };
}
