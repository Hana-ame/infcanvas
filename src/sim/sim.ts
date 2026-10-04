/**
 * sim.ts —— 权威模拟本体：实体管理 + 系统步进 + 命令路由 + 事件日志。
 *
 * 零 DOM / 零 Node API：同一份代码跑在 vitest、CLI（tsx）、浏览器、服务端。
 * Sim 实现 SimContext 给玩法包用；玩法包永远只见 SimContext 切面（可单测替换）。
 *
 * 命令路由（原则④能力面）：move 是引擎内建的基础指挥；其余命令由玩法包
 * registerCommand 注册。玩家命令给小人 holdUntil 优先窗口——这是命令层语义
 * （外部输入压过自主抽卡），不是行为规则。
 */
import { mulberry32, type RngFn } from './rng';
import { DEFAULT_TUNING, type Tuning } from './tuning';
import { World } from './world';
import { findPath, planRoute } from './pathfinding';
import type { SimContext, CardWeightHook } from './context';
import type { CardDef } from './cards';
import { behaviorCtor, commit, type GameSystem } from './systems';
import type { BuildingState, Eid, FeatureHit, Hostile, LogEvent, PawnState, Pos } from './types';
import type { SaveData } from './sim-save';
import type { ModRegistry } from '../mods/registry';

export interface SimConfig {
  seed?: number;
  /** 显式指定 = 跳过 bootstrap 出生引导（最小装配/单测用）；缺省交给 bootstrap 包 */
  pawnCount?: number;
  registry: ModRegistry;
  /** 读档恢复：传入存档对象（migrate 后的 SaveData）。装配跳过全部 system.init()
   *  （那是"新开一局"的设定副作用，读档时实体由存档回填），随后回填状态。 */
  restore?: SaveData;
}

export class Sim implements SimContext {
  readonly world: World;
  readonly reg: ModRegistry;
  tuning: Tuning;
  time = 0;
  systems: GameSystem[] = [];
  readonly pawnMap = new Map<Eid, PawnState>();
  readonly hostilesList: Hostile[] = [];
  stockpile: Record<string, number> = {};
  events: LogEvent[] = [];
  selected: Eid[] = []; // 客户端选中（框选/点选），纯 UI 投影
  /** 玩法包运行态暂存（随档）：键 "<包>.<名>"。系统状态放这里而非闭包，存档才能还原 */
  readonly scratch: Record<string, number> = {};
  private rngImpl: RngFn;
  private nextEid = 1;
  private nextHostileId = 1;
  private relations = new Map<string, number>(); // pairKey → -100..100
  /** 锚点对段缓存（篝火航点中转）：键=起终点，值=拼好的路径或 null(不可达)。
   *  建筑增删即清空——火堆网络变了旧段作废。 */
  private routeCache = new Map<string, Pos[] | null>();

  constructor(cfg: SimConfig) {
    this.reg = cfg.registry;
    this.tuning = this.reg.effectiveTuning();
    // 读档时以存档里的 seed 重建世界（地形哈希由 seed 推导，必须一致）
    const seed = cfg.restore?.seed ?? cfg.seed ?? 20260821;
    this.rngImpl = mulberry32(seed);
    this.world = new World(this.tuning, seed, { x: 0, y: 0 });
    // 装配系统（类别序×注册序）→ 全部 ctor 后再统一 init（出生引导能看到完整装配）
    this.systems = this.reg.assemble(this);
    const restoring = cfg.restore !== undefined;
    if (!restoring) for (const s of this.systems) s.init?.();
    else this.applyRestore(cfg.restore!);
    if (cfg.pawnCount !== undefined && !restoring) {
      for (let i = 0; i < cfg.pawnCount; i++) this.spawnPawn(); // 读档时实体来自存档，绝不能再刷
    }
  }

  // ================= SimContext 实现 =================
  rng(): number {
    return this.rngImpl();
  }

  pawns(): IterableIterator<PawnState> {
    return this.pawnMap.values();
  }
  pawn(eid: Eid): PawnState | undefined {
    return this.pawnMap.get(eid);
  }

  spawnPawn(x?: number, y?: number): Eid {
    const eid = this.nextEid++;
    const pos = x !== undefined && y !== undefined ? { x, y } : this.findSpawn();
    const traitIds = Object.keys(this.tuning.traits);
    const p: PawnState = {
      eid,
      name: `鼠${eid}`,
      pos,
      needs: { food: 90, rest: 90, mood: 70, san: 90 },
      hp: this.tuning.pawn.hp,
      maxHp: this.tuning.pawn.hp,
      trait: traitIds[Math.floor(this.rng() * traitIds.length)],
      climb: this.tuning.pawn.climb,
      cardId: null,
      busyUntil: 0,
      holdUntil: 0,
      atkCd: 0,
      path: [],
      mastery: {},
      uses: {},
    };
    this.pawnMap.set(eid, p);
    this.log(`🐭 ${p.name} 出生（${this.tuning.traits[p.trait].name}）`);
    return eid;
  }

  killPawn(eid: Eid, cause: string): void {
    const p = this.pawnMap.get(eid);
    if (!p) return;
    this.pawnMap.delete(eid);
    this.selected = this.selected.filter((s) => s !== eid);
    this.log(`💀 ${p.name} 死亡（${cause}）`);
  }

  /** 出生点：营地锚点附近螺旋找可站格 */
  private findSpawn(): Pos {
    const anchor = this.campPos() ?? this.world.spawn;
    for (let r = 0; r <= 10; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.passable(anchor.x + dx, anchor.y + dy)) return { x: anchor.x + dx, y: anchor.y + dy };
        }
      }
    }
    return { ...anchor };
  }

  /** 营地锚点 = 距鼠群质心最近的篝火（无火回世界原点）。标签键见 mods/contracts K_TAG_FIRE */
  campPos(): Pos | null {
    const c = this.meanPawnPos();
    const fire = this.world.nearestBuildingByTag('fire', c.x, c.y);
    return fire ? fire.pos : null;
  }
  private meanPawnPos(): Pos {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const p of this.pawnMap.values()) {
      sx += p.pos.x;
      sy += p.pos.y;
      n++;
    }
    return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
  }

  hostiles(): readonly Hostile[] {
    return this.hostilesList;
  }
  spawnHostile(kind: string, x: number, y: number): Hostile {
    const def = this.tuning.enemies[kind];
    const h: Hostile = {
      id: this.nextHostileId++,
      kind,
      pos: { x, y },
      hp: def.hp,
      maxHp: def.hp,
      atkCd: def.atkCd, // 初值=cd：落地先观察一拍，防首帧秒咬（旧项目踩坑结论）
    };
    this.hostilesList.push(h);
    this.log(`${def.name} 出没！`);
    return h;
  }
  despawnHostile(id: number): void {
    const i = this.hostilesList.findIndex((h) => h.id === id);
    if (i >= 0) this.hostilesList.splice(i, 1);
  }

  damagePawn(eid: Eid, dmg: number, cause: string): void {
    const p = this.pawnMap.get(eid);
    if (!p) return;
    p.hp -= dmg;
    if (p.hp <= 0) this.killPawn(eid, cause);
  }
  damageHostile(id: number, dmg: number): void {
    const h = this.hostilesList.find((x) => x.id === id);
    if (!h) return;
    h.hp -= dmg;
    if (h.hp <= 0) {
      this.despawnHostile(id);
      this.log(`${this.tuning.enemies[h.kind].name} 被击退了`);
    }
  }

  passable(x: number, y: number): boolean {
    return this.world.canStand(x, y);
  }
  zAt(x: number, y: number): number {
    return this.world.zAt(x, y);
  }
  canStep(fx: number, fy: number, tx: number, ty: number, climb: number): boolean {
    return this.world.canStep(fx, fy, tx, ty, climb);
  }
  featureAt(x: number, y: number): FeatureHit | null {
    return this.world.featureAt(x, y);
  }
  nearestFeature(kind: FeatureHit['kind'], x: number, y: number, maxR: number): FeatureHit | null {
    return this.world.nearestFeature(kind, x, y, maxR);
  }
  takeOne(x: number, y: number): number {
    return this.world.takeOne(x, y);
  }
  featureRect(f: FeatureHit): { x0: number; y0: number; x1: number; y1: number } {
    return this.world.featureRect(f);
  }
  distToFeatureRect(px: number, py: number, r: { x0: number; y0: number; x1: number; y1: number }): number {
    return this.world.distToFeatureRect(px, py, r);
  }
  nearestFreeAdjacent(rect: { x0: number; y0: number; x1: number; y1: number }, fx: number, fy: number): Pos | null {
    return this.world.nearestFreeAdjacent(rect, fx, fy);
  }
  nearestBuildingByTag(tag: string, x: number, y: number, maxR = Infinity): BuildingState | undefined {
    return this.world.nearestBuildingByTag(tag, x, y, maxR);
  }
  buildingsAll(): Iterable<BuildingState> {
    return this.world.buildings.values();
  }
  addBuilding(defId: string, x: number, y: number): BuildingState | null {
    this.routeCache.clear(); // 火堆网络变化→航点段落全部作废
    return this.world.addBuilding(defId, x, y);
  }
  removeBuilding(id: string): void {
    this.routeCache.clear();
    this.world.removeBuilding(id);
  }

  relation(a: Eid, b: Eid): number {
    return this.relations.get(pairKey(a, b)) ?? 0;
  }
  addRelation(a: Eid, b: Eid, delta: number): void {
    const k = pairKey(a, b);
    const v = Math.max(-100, Math.min(100, (this.relations.get(k) ?? 0) + delta));
    this.relations.set(k, v);
  }

  // ---- 移动服务 ----
  setPath(p: PawnState, txRaw: number, tyRaw: number): boolean {
    // 双档迭代上限：近距离低预算快速失败，远距离高预算。两档是搜索预算（实现参数）
    // 不是玩法数值，故内联于此；玩法数值一律进 tuning。
    // 起终点整数量化：小人坐标连续（moveStep 插值），浮点进 A* 会解码错位/返回空
    // （真实踩坑：半路重规划全部静默失败）。findPath 内部也会兜底 round。
    const tx = Math.round(txRaw);
    const ty = Math.round(tyRaw);
    const dist = Math.abs(tx - Math.round(p.pos.x)) + Math.abs(ty - Math.round(p.pos.y));
    const maxIter = dist <= 24 ? 1500 : 8000;
    // 按边注入 z 判定：|Δz| ≤ 该鼠攀爬（岩层上不去就是上不去，A* 自动绕行）
    const stepOk = (fx: number, fy: number, ax: number, ay: number): boolean =>
      this.world.canStep(fx, fy, ax, ay, p.climb);
    const goalOk = (ax: number, ay: number): boolean => this.world.canStand(ax, ay);

    // 直连 → 失败则借火堆锚点分段中转（远距离/隔地形时是唯一可行路径）
    const anchors: Pos[] = [];
    for (const b of this.world.buildings.values()) {
      if (this.tuning.buildings[b.defId].tags.includes('fire')) anchors.push({ x: b.pos.x, y: b.pos.y });
    }
    let path = findPath(stepOk, goalOk, p.pos.x, p.pos.y, tx, ty, maxIter);
    if (path.length === 0 && !(Math.round(p.pos.x) === tx && Math.round(p.pos.y) === ty)) {
      path = planRoute(stepOk, goalOk, p.pos.x, p.pos.y, tx, ty, anchors, maxIter, 1500, this.routeCache);
    }
    p.path = path;
    const ok = path.length > 0 || (Math.round(p.pos.x) === tx && Math.round(p.pos.y) === ty);
    return ok;
  }
  moveStep(p: PawnState, dt: number): void {
    let budget = this.tuning.pawn.speed * dt;
    while (budget > 0 && p.path.length > 0) {
      const next = p.path[0];
      const dx = next.x - p.pos.x;
      const dy = next.y - p.pos.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        p.pos.x = next.x;
        p.pos.y = next.y;
        p.path.shift();
        budget -= d;
      } else {
        p.pos.x += (dx / d) * budget;
        p.pos.y += (dy / d) * budget;
        budget = 0;
      }
    }
  }
  adjacent(p: PawnState, x: number, y: number, r = 1.5): boolean {
    return Math.hypot(p.pos.x - x, p.pos.y - y) <= r;
  }

  // ---- 决策引擎面 ----
  cards(): readonly CardDef[] {
    return this.reg.cards;
  }
  cardById(id: string): CardDef | undefined {
    return this.reg.cardById(id);
  }
  weightHooks(): readonly CardWeightHook[] {
    return this.reg.weightHooks;
  }
  finishCard(p: PawnState): void {
    p.busyUntil = this.time; // 下 tick 重抽
  }

  log(text: string): void {
    this.events.push({ time: this.time, text });
    if (this.events.length > this.tuning.events.maxLog) {
      this.events.splice(0, this.events.length - this.tuning.events.maxLog); // 批量裁剪防长局膨胀
    }
  }

  command(type: string, args: Record<string, unknown> = {}): void {
    this.issueCommand(type, args, 'system');
  }

  // ---- 命令路由 ----
  issueCommand(type: string, args: Record<string, unknown> = {}, source: 'player' | 'system' = 'player'): void {
    if (type === 'move') {
      // move = 引擎内建基础指挥。eids 批量（框选）/ 单 eid / 当前选中
      const eids = ((args.eids as Eid[]) ?? (args.eid !== undefined ? [args.eid as Eid] : this.selected)).filter(
        (e) => this.pawnMap.has(e),
      );
      const tx = args.x as number;
      const ty = args.y as number;
      for (const eid of eids) {
        const p = this.pawnMap.get(eid)!;
        p.cardId = null; // 玩家指挥打断自主行为
        p.busyUntil = 0;
        p.holdUntil = this.time + 5; // 优先窗口内不重新自主抽卡
        if (!this.setPath(p, tx, ty)) {
          this.log(`⚠ ${p.name} 去不了 (${tx},${ty})`); // 点了水/岩：给玩家回声而不是无声站立
        }
      }
      return;
    }
    const handler = this.reg.commands.get(type);
    if (handler) handler(this, args, source);
    else this.log(`⚠ 未知命令：${type}`);
  }

  // ---- 步进 ----
  step(dt: number): void {
    this.time += dt;
    this.world.now = this.time; // 单时钟源：world 特征再生跟随 sim 时钟
    for (const sys of this.systems) sys.update?.(dt);
  }
  run(seconds: number, dt = 1): void {
    for (let t = 0; t < seconds; t++) this.step(dt);
  }

  // ---- 存档面（结构见 sim-save.ts；这里只暴露最小访问器）----
  rngState(): number {
    return this.rngImpl.getState();
  }
  nextEidValue(): number {
    return this.nextEid;
  }
  nextHostileIdValue(): number {
    return this.nextHostileId;
  }
  exportRelations(): [string, number][] {
    return [...this.relations.entries()];
  }

  /** 从存档对象回填状态（在构造器 restore 路径调用；init 已被跳过） */
  private applyRestore(d: SaveData): void {
    this.time = d.time;
    this.rngImpl.setState(d.rngState);
    this.nextEid = d.nextEid;
    this.nextHostileId = d.nextHostileId;
    this.pawnMap.clear();
    for (const p of d.pawns) this.pawnMap.set(p.eid, structuredClone(p));
    this.hostilesList.length = 0;
    this.hostilesList.push(...d.hostiles.map((h) => structuredClone(h)));
    this.stockpile = { ...d.stockpile };
    this.relations.clear();
    for (const [k, v] of d.relations) this.relations.set(k, v);
    this.events = structuredClone(d.events);
    Object.keys(this.scratch).forEach((k) => delete this.scratch[k]);
    Object.assign(this.scratch, d.scratch);
    this.world.importState(d.world);
    this.world.now = d.time; // 单时钟源必须随档：否则再生冷却相对新时钟全部误判（真实踩坑）
  }

  /** 测试/CLI 演示专用：强制某鼠立即执行指定卡（绕过抽签）。
   *  刻意不进 SimContext——玩法系统永远走真实抽卡；这个口子只给测试，
   *  且内部复用与真实抽卡同一条 commit 路径（统计/熟练度语义不漂移）。 */
  debugForceCard(eid: Eid, cardId: string): boolean {
    const card = this.reg.cardById(cardId);
    const p = this.pawnMap.get(eid);
    if (!card || !p) return false;
    p.cardId = null;
    p.busyUntil = this.time;
    commit(this, p, card);
    return true;
  }
}

function pairKey(a: Eid, b: Eid): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}
