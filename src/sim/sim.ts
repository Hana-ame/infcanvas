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
import { K_TAG_WAYPOINT } from '../mods/contracts';

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
  /**
   * 科技抽卡池运行态（R2-1）：已解锁科技 id + 各科技已攒碎片数。
   *
   * 为什么是显式字段而不放 ctx.scratch（scratch 是 Record<string,number>，
   * 已解锁是"集合"塞不进去；碎片数倒是能塞）。理由有三：
   *  1. 存档契约：已解锁是**世界事实**，必须整份进 SaveData（读档后门控判定才一致）；
   *  2. 协议契约：联机 HUD 的科技面板要看到解锁进度，走 FullState 一段透传；
   *  3. 可读性：scratch 是"包私有运行态"，科技是跨包共享事实（tech-pool 写 / building 读）。
   */
  private techsUnlocked = new Set<string>();
  readonly techFragments: Record<string, number> = {};
  private rngImpl: RngFn;
  private nextEid = 1;
  private nextHostileId = 1;
  private relations = new Map<string, number>(); // pairKey → -100..100
  /** 锚点对段缓存（篝火航点中转）：键=起终点，值=拼好的路径或 null(不可达)。
   *  建筑增删即清空——火堆网络变了旧段作废。 */
  private routeCache = new Map<string, Pos[] | null>();
  /**
   * 火堆锚点列表缓存（2026-10-06 性能线新增）+ 它对应的 world.tagVersion。
   *
   * 原缺陷（现象/根因）：setPath **每次调用**都重新遍历整个建筑表重建锚点数组：
   *   `for (const b of this.world.buildings.values()) if (tags.includes('fire')) anchors.push({...})`
   *   而 setPath 是行为系统里最热的入口（采/砍/走/跑/睡五类卡动作都会调它），
   *   每只鼠每 tick 可达 1 次。建筑数随局增长（实测 900s 局里 7~14 座），
   *   于是"为了取 1~3 个火堆坐标"每次都付一次全表扫描 + N 次 tags.includes
   *   + 每座一个新对象分配。
   *
   * 优化思路：锚点列表**只依赖建筑表**，而建筑表变更频率极低
   *   （建造卡才增删，实测 900 tick 里 7~14 次），天敌是"高频读 / 低频写"。
   *   所以缓存一份 + 用 world.tagVersion()（每次建筑增删 +1）判过期，
   *   变了才重建。读侧 O(1)，写侧 O(建筑数) 但极少发生。
   *
   * 为什么不是"每次都重建"就够用：旧项目回退空间索引的原因正是
   * 「索引构建开销 > 节省」。这里的差别是**构建频率**：空间索引每 tick 重建
   * （×900 = 900 次），这份锚点表 900 tick 只重建 ~10 次，相差两个数量级。
   *
   * 与 routeCache 的分工：routeCache 缓存的是"起终点对 → 路径"，
   * 本缓存是"锚点列表"本身。前者建筑增删就清空，后者跟着 tagVersion 走。
   */
  private fireAnchors: Pos[] = [];
  private fireAnchorsVersion = -1;

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
    // 未注册的 kind：抛清晰错误而不是让下一行 `def.hp` 抛
    // 「Cannot read properties of undefined (reading 'hp')」。
    // 读档后 spawn 一个本装配里没有的敌人类型 = 调用方的装配错误，属 bug 不是边界情况。
    if (!def) throw new Error(`spawnHostile：未注册的敌人类别「${kind}」（缺挂载注册它的玩法包）`);
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
      // 判空（2026-10-07 R4-GEN 集成期补）：读一个「含 raider 的存档」但当前装配
      // 没挂 factions 包时，`def` 为 undefined。此处**必须照常击杀并 despawn**——
      // 缺判空会抛 TypeError，而 raid.tickCats 已加 `if (!def) continue` 跳过未知类，
      // 结果是这只 raider **永远无法被杀死、变成不灭的隐形障碍**（比报错更坏）。
      // 降级策略：drops 视为空表、名字用 kind 兜底，日志语义仍成立。
      const def = this.tuning.enemies[h.kind];
      // 掉落（R3-3 起支持）：把 drops 表写进营地库存。这是**世界事实**（随档/进协议），
      // 不是行为规则，所以进内核而不是 hunting 包——做成"拾取卡"需要尸体实体系统，
      // 成本远高于收益。缺省 undefined = 不掉落，日志与改动前逐字一致（golden 基线不动）。
      const drops = def?.drops ?? {};
      const dropTxt = Object.entries(drops)
        .map(([k, v]) => `+${v} ${k}`)
        .join(' ');
      for (const [k, v] of Object.entries(drops)) {
        this.stockpile[k] = (this.stockpile[k] ?? 0) + v;
      }
      this.despawnHostile(id);
      this.log(dropTxt ? `${def?.name ?? h.kind} 被击退了（${dropTxt}）` : `${def?.name ?? h.kind} 被击退了`);
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

  // ---- 科技抽卡池面（R2-1 实现；查询面见 context.ts 的语义注释）----
  techUnlocked(): ReadonlySet<string> {
    return this.techsUnlocked;
  }
  techOrder(): string[] {
    return this.reg.techOrder();
  }
  techFragmentsOf(techId: string): number {
    return this.techFragments[techId] ?? 0;
  }
  grantTechFragment(techId: string): 'progress' | 'unlocked' | 'dup' | 'unknown' {
    const def = this.tuning.techs[techId];
    if (!def) return 'unknown'; // 表里没有（如 mod 热卸载了科技）→ 不静默累计
    // 重复卡：已解锁科技再抽到 = 白抽，不累计（用户 2026-08-15 裁决：稀释而非奖励）
    if (this.techsUnlocked.has(techId)) return 'dup';
    const next = (this.techFragments[techId] ?? 0) + 1;
    this.techFragments[techId] = next;
    if (next < def.fragments) return 'progress';
    // 攒满：解锁整卡。碎片数清零（进度条归零，HUD 靠"已解锁"态显示而非残留计数）
    this.techFragments[techId] = 0;
    this.techsUnlocked.add(techId);
    this.log(`🔬 科技解锁：${def.name}`);
    return 'unlocked';
  }

  /** 建筑门控判定（R2-1）：科技表为空（tech-pool 未挂）时一律放行——
   *  "卸载科技包 = 永无科技但核心照跑"，否则卸载会锁死整个建造玩法。 */
  techSatisfied(tech?: readonly string[]): boolean {
    if (!tech || tech.length === 0) return true;
    for (const id of tech) {
      // 门控引用的科技不在表里（mod 未挂/热卸载）= 不阻断建造：
      // 门控是"需要先解锁"，不是"必须存在于表"，否则数据半残就锁死世界。
      if (this.tuning.techs[id] !== undefined && !this.techsUnlocked.has(id)) return false;
    }
    return true;
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
  /**
   * 火堆航点锚点列表（性能线缓存版）。
   *
   * 走 world 的 tag 倒排桶而不是重扫全表 —— 语义与原实现逐字一致：
   * 原代码 `for (b of buildings.values()) if (tags.includes('fire')) push({x,y})`，
   * 现在 `buildingsByTag('fire')` 的桶就是同一个集合（桶序 = 插入序 = 原迭代序），
   * 只是把"过滤"提前到建筑增删时做了一次。planRoute 对锚点做 sort+slice(0,2)
   * 取最近两个，**并列时的胜出者依赖迭代序** —— 桶序与原序一致，所以结果不变。
   *
   * 返回的是缓存数组本体（不给副本）：planRoute 只读它
   * （`[...anchors].sort()` 自己会拷），给副本等于把这次优化又抵消掉。
   */
  private fireAnchorsList(): readonly Pos[] {
    const v = this.world.tagVersionNow();
    if (v !== this.fireAnchorsVersion) {
      // 航点 = fire 桶 ∪ waypoint 桶（K_TAG_WAYPOINT，见 contracts.ts 注释）。
      // 顺序刻意固定为「fire 先、waypoint 后」，各自保持插入序：planRoute 内部按到
      // 起点/终点的距离排序，等距时 Array.sort 稳定保留输入序 ⇒ 输入序必须确定。
      // fire 排在前面保证**无 waypoint 建筑时与改动前逐位相同**（golden 基线不动）。
      // 去重：篝火同时挂两个标签，会在两个桶各出现一次。
      const out: Pos[] = [];
      const seen = new Set<string>();
      for (const b of this.world.buildingsByTag('fire')) {
        const k = `${b.pos.x},${b.pos.y}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ x: b.pos.x, y: b.pos.y });
        }
      }
      for (const b of this.world.buildingsByTag(K_TAG_WAYPOINT)) {
        const k = `${b.pos.x},${b.pos.y}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ x: b.pos.x, y: b.pos.y });
        }
      }
      this.fireAnchors = out;
      this.fireAnchorsVersion = v;
    }
    return this.fireAnchors;
  }

  setPath(p: PawnState, txRaw: number, tyRaw: number): boolean {
    // 双档迭代上限：近距离低预算快速失败，远距离高预算。两档是搜索预算（实现参数）
    // 不是玩法数值，故内联于此；玩法数值一律进 tuning。
    // 起终点整数量化：小人坐标连续（moveStep 插值），浮点进 A* 会解码错位/返回空
    // （真实踩坑：半路重规划全部静默失败）。findPath 内部也会兜底 round。
    const tx = Math.round(txRaw);
    const ty = Math.round(tyRaw);
    const sx = Math.round(p.pos.x);
    const sy = Math.round(p.pos.y);
    const dist = Math.abs(tx - sx) + Math.abs(ty - sy);
    // 按边注入 z 判定：|Δz| ≤ 该鼠攀爬（岩层上不去就是上不去，A* 自动绕行）
    const stepOk = (fx: number, fy: number, ax: number, ay: number): boolean =>
      this.world.canStep(fx, fy, ax, ay, p.climb);
    const goalOk = (ax: number, ay: number): boolean => this.world.canStand(ax, ay);

    // ⚡ R4-Battle 有限范围 A* + 标志位导航（用户架构指令 2026-10-06：
    //   「使用有限范围的 A* 为了无限地图支撑。地图上会设置大坐标标志位置点」）。
    //
    // 原缺陷（现象/根因）：长距（>24 格）时直连 A* 用 8000 迭代上限——实测
    //   长距单次 1.6ms（64 鼠下 setPath 占 45% 耗时），且 8000 迭代上限意味着
    //   搜索范围随地图变大而变贵 = **依赖地图尺寸**，撑不起无限地图。
    // 修法：**长距默认走标志位导航**（planRoute：起点→最近标志位→…→目标的分段
    //   有限 A*，每段 1500 迭代），直连 A* 只用于短距（≤24 格）。
    //   标志位 = 火堆锚点（fireAnchors，已有 tag 倒排 + tagVersion 缓存）。
    //   行为差异：长距路径会绕标志位（分段最优 ≠ 全局直连最优），属架构性变更，
    //   golden 换血时记录。
    const anchors = this.fireAnchorsList();
    const isLong = dist > 24;
    let path: Pos[];
    if (isLong && anchors.length > 0) {
      // 长距 + 有标志位：直接走分段导航（不再先试 8000 迭代直连）
      path = planRoute(stepOk, goalOk, sx, sy, tx, ty, anchors, 1500, 1500, this.routeCache);
    } else {
      const maxIter = isLong ? 8000 : 1500;
      path = findPath(stepOk, goalOk, sx, sy, tx, ty, maxIter);
      // 直连失败 → 借火堆锚点分段中转（远距离/隔地形时是唯一可行路径）
      if (path.length === 0 && !(sx === tx && sy === ty)) {
        path = planRoute(stepOk, goalOk, sx, sy, tx, ty, anchors, maxIter, 1500, this.routeCache);
      }
    }
    p.path = path;
    const ok = path.length > 0 || (sx === tx && sy === ty);
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

  /**
   * 按区块分片步进（line/net 2026-10-06）：只推进 activeChunks 覆盖到的区块里的实体。
   *
   * ## 与 step 的关系：**它是 step 的子集，不是替代**
   *
   * `activeChunks === null` 时行为与 step 逐位相同（所有区块都被 admit）——
   * 这是设计上的关键：服务器可以按"有客户端订阅 + 有实体"的并集决定要不要分片，
   * 单机本地模式永远走 null 路径，**零行为变化**。
   *
   * ## 确定性保证（本方法能存在的前提）
   *
   * 分片只做"跳过"，不重排：admitted 全集时，各系统 updateChunked 的遍历顺序
   * 与 update 完全相同 → rng 消费序列相同 → 抽卡序列相同 → 整局相同。
   * 推论（也是本方法的限制）：**admitted ≠ 全集时，被跳过的鼠在那一 tick 完全不动**
   * （不抽卡、不推进、不消耗 rng）。这是"分片"的本质代价，不是 bug。
   * 于是它只适合"跳过的区块里没有玩家关心的实体"——服务器据此只 admit
   * 有客户端订阅的区块，而**玩家的鼠必然在自己订阅的区块里**，所以玩家的鼠永不被跳过。
   *
   * ⚠️ 换来的代价是真实的：视口外的鼠（AI 独自在远方劳作）会被跳过分片 tick。
   * 它们的状态不变，玩家看不见；但如果玩家把镜头移过去，它们会"从暂停中醒来"。
   * 这与"客户端只是不显示远处实体"是同一个语义，服务器仍在权威推进自己那部分。
   */
  stepChunked(dt: number, activeChunks: ReadonlySet<number> | null): void {
    this.time += dt;
    this.world.now = this.time;
    for (const sys of this.systems) {
      if (activeChunks === null) sys.update?.(dt);
      else if (sys.updateChunked) sys.updateChunked(dt, activeChunks);
      else sys.update?.(dt); // 没实现分片的面照常全量（正确性优先于收益）
    }
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
    // 科技抽卡池状态随档（R2-1）：碎片数 + 已解锁集合。
    // 缺字段回落空（旧档经迁移后 techs/techFragments 可能不存在）——"没有科技进度"
    // 等价于"还没抽到任何碎片"，不是坏档。
    this.techsUnlocked = new Set(d.techs ?? []);
    for (const k of Object.keys(this.techFragments)) delete this.techFragments[k];
    Object.assign(this.techFragments, d.techFragments ?? {});
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