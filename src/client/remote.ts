/**
 * client/remote.ts —— 联机模式的客户端合入层（RemoteSim）。
 *
 * 职责：维护"服务端最新状态投影"，实现 WorldView 供渲染/HUD 零分支复用。
 * 地形：welcome 拿到 seed+tuning 后本地 new World 纯函数推导 tile（零流量）；
 * 特征余量/冷却由 full 快照 world 段 importState 同步。
 * 命令：sendCommand 上行 JSON，服务端白名单校验后走同一 issueCommand 入口。
 *
 * R1 追加（2026-10-05）：
 *  - R1-1 断线重连 + 心跳看门狗：onclose 走指数退避重连；15s 没有任何消息判定假死。
 *  - R1-3 远程渲染插值：渲染位置来自独立的 interpSlots 表，pawnMap 保持权威快照原样。
 *
 * line/net 追加（2026-10-06）——分区块同步：
 *  - setInterest 上报视口区块集合，服务端据此裁剪快照（见 shared/chunks.ts）。
 *  - 收到带 scope 的 full/delta 时只合入 scope 内数据，并**卸载** droppedChunks
 *    的远端区块（否则"服务端没提到"会被误读为"还留着"→ 走回去看到幽灵建筑）。
 *  - 地形仍然零流量自推：区块化只裁剪**实体状态**，hash 推导的地形不在此列。
 */
import { World } from '../sim/world';
import type { BuildingState, Eid, Hostile, LogEvent, PawnState, Pos } from '../sim/types';
import { DEFAULT_TUNING, type Tuning } from '../sim/tuning';
import { TERRAIN_NAME, type TileInspect, type WorldView } from './view';
import { buildBuildingDetail, buildColonySummary, buildHostileDetail, buildPawnDetail } from './hud-faces';
import { K_TAG_FIRE } from '../mods/contracts';
import type { ClientMsg, FullState, ServerMsg } from '../shared/protocol';
import { WATCHDOG_MS } from '../shared/protocol';
import {
  chunksForInterest,
  fromChunkCoords,
  tileChunkKey,
  type ChunkCoord,
} from '../shared/chunks';
import { BackoffState, shouldWatchdogTrip } from './reconnect';
import { InterpSlot } from './interp';

/**
 * 取 WebSocket 构造器（2026-10-06 补）。
 *
 * 为什么不能直接 `new WebSocket(...)`：
 * 浏览器有全局 WebSocket，node ≥22 也有（node 22 起把 undici 的 WebSocket 开放为全局），
 * 但 **node 20 没有**——在那里 `new WebSocket(url)` 直接抛 `WebSocket is not defined`。
 * 后果不只是联机测试挂：RemoteSim 会**静默地永远不重连**，因为异常发生在
 * scheduleReconnect() 之前，排队逻辑根本没机会执行（实测 node20：
 * attempts=1、failures=0、12s 内零重连）。
 *
 * 所以这里显式取构造器并给出可读的缺失原因，同时让 connect() 在缺失时
 * **仍然排队重连**——这样「运行环境不支持」会表现为重连而不是静默死掉。
 */
function resolveWebSocketCtor(): typeof WebSocket | undefined {
  const ctor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  return typeof ctor === 'function' ? ctor : undefined;
}

export class RemoteSim implements WorldView {
  time = 0;
  stockpile: Record<string, number> = {};
  private pawnMap = new Map<Eid, PawnState>();
  /**
   * 渲染层插值槽（R1-3）。**与 pawnMap 严格分离**：
   * pawnMap 存服务端权威快照（点选/框选/HUD 判定都读它），
   * 这里只存表现用的 prev/next，两者互不写入。这是「插值不污染逻辑状态」的实现方式。
   */
  private interpSlots = new Map<Eid, InterpSlot>();
  private hostileList: Hostile[] = [];
  private buildingList: BuildingState[] = [];
  eventsList: LogEvent[] = [];
  /**
   * 当前已加载区块键集合（line/net）。null = 未启用裁剪（全量投影，v1 行为）。
   *
   * 为什么单独一张表而不是靠 buildingList 反推：卸载要按区块批量做，
   * 而 buildingList 是扁平数组；每帧为卸载扫描全表是 O(建筑数) 的无谓开销。
   */
  private loadedChunks: Set<number> | null = null;
  /** 已上报的视口兴趣区（去重用：同一块不重复上行） */
  private lastInterestKey = '';
  /** 本地地形推导器（seed+tuning 与服务器一致；余量随 full 快照同步） */
  world!: World;
  /**
   * 科技抽卡池状态（R2-1）：只随 welcome/full 到达，delta 不更新
   * （与 game-server 的发送策略对称——低频状态走低频通道，避免拖慢 500ms 增量帧）。
   */
  private techsUnlocked = new Set<string>();
  private techFrag: Record<string, number> = {};
  /**
   * HUD 面板依赖的 scratch 子集（R3-HUD）：服务端按 HUD_SCRATCH_KEYS 白名单下发。
   * 只随 welcome/full 到达，delta 不更新——与 techFragments 同节奏（低频全局状态）。
   */
  private hudScratch: Record<string, number> = {};
  _tuning: Tuning = DEFAULT_TUNING;
  connected = false;

  private ws: WebSocket | null = null;
  onCmdUp?: (c: { type: string; args?: Record<string, unknown> }) => void; // 测试钩子

  // ---- R1-1 重连与看门狗状态 ----
  /** 当前使用的服务端地址；重连必须复用它（含 ?token=），所以整条 URL 都要记住 */
  private url = '';
  private readonly backoff = new BackoffState();
  /** 已排队待执行的重连定时器；非 null 表示已有一次重连在等待中（防重复排队） */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 看门狗定时器：周期性检查「距上次收到消息是否已超阈值」 */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** 最近一次收到**任何**服务端消息的时刻（ms）。看门狗的唯一依据。 */
  private lastRecvMs = 0;
  /** 连接状态变化回调：HUD 用它显示/隐藏「与服务器失去连接，重连中…」 */
  onConnectionChange?: (connected: boolean) => void;
  /** 看门狗是否被测试注入时钟（测试里 Date.now 不可控，用 now() 覆盖） */
  private nowFn: () => number = () => Date.now();
  /** 是否允许自动重连（测试里关掉，避免用例结束还在后台重连） */
  autoReconnect = true;

  constructor(opts: { now?: () => number } = {}) {
    if (opts.now) this.nowFn = opts.now;
  }

  /** 当前连续失败次数（测试用） */
  get reconnectFailures(): number {
    return this.backoff.failures;
  }

  /** 是否存在已排队但尚未执行的重连（测试用） */
  get hasPendingReconnect(): boolean {
    return this.reconnectTimer !== null;
  }

  connect(url: string): Promise<void> {
    this.url = url;
    return new Promise((resolve, reject) => {
      let settled = false;
      const Ctor = resolveWebSocketCtor();
      if (!Ctor) {
        // 运行环境没有 WebSocket（典型：node 20）。**照样排队重连**，
        // 否则 autoReconnect 模式下会静默停止自愈；错误信息要说清根因，
        // 不能让排查的人以为是服务器没起来。
        const err = new Error(
          '当前运行环境没有全局 WebSocket（node 22+ / 浏览器才内置）。请换 node 22，或在入口注入 WebSocket 实现。',
        );
        this.scheduleReconnect();
        reject(err);
        return;
      }
      let ws: WebSocket;
      try {
        ws = new Ctor(url);
      } catch (e) {
        this.scheduleReconnect();
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this.backoff.reset();
        this.lastRecvMs = this.nowFn();
        this.startWatchdog();
        this.onConnectionChange?.(true);
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      // 握手失败（服务器没起来/token 不对）走 onerror；把重连也排上，
      // 否则「服务器还没启动就打开页面」会永远卡在失败态
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`无法连接 ${url}`));
        }
        this.scheduleReconnect();
      };
      ws.onclose = (ev) => {
        this.connected = false;
        this.stopWatchdog();
        this.onConnectionChange?.(false);
        // 鉴权失败 close(1008)：重连多少次都不会成功，白白耗退避计时器
        if (ev?.code === 1008) return;
        this.scheduleReconnect();
      };
      ws.onmessage = (ev) => {
        // **每一条**消息都刷新看门狗基准——不只 ping。
        // 判据是「链路是否活着」，delta/full 到达同样证明链路通。
        this.lastRecvMs = this.nowFn();
        this.handle(JSON.parse(ev.data as string) as ServerMsg);
      };
    });
  }

  /**
   * 排队一次重连（同刻只排一个）。
   * 退避时长由纯状态机给出，定时器由这里负责——这样退避曲线本身可被 fake timer 单测。
   */
  private scheduleReconnect(): void {
    if (!this.autoReconnect) return;
    if (this.reconnectTimer !== null) return; // 已在排队中
    const delay = this.backoff.nextDelayMs();
    this.backoff.noteFailure();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // 重连复用原 URL（含 ?token=）：服务端换了地址的场景不在本需求内，
      // 但 token 必须在——否则开了 SERVER_TOKEN 的服务器会永远拒我们。
      this.connect(this.url).catch(() => {
        /* 重连失败已由 onerror/onclose 各自排队下一次；这里吞掉避免 unhandled rejection */
      });
    }, delay);
  }

  /**
   * 看门狗：每 1s 检查一次，超过 WATCHDOG_MS 没收到任何消息就主动断开重连。
   * 为什么要主动断：TCP 半开连接（拔网线/休眠/NAT 超时）时 socket 不会收到 close，
   * 界面却已经「看起来连着」，玩家会一直对着一张冻结的世界点右键。
   * 主动 close() 会触发 onclose，从而进入正常的退避重连路径。
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (!this.connected) return;
      const elapsed = this.nowFn() - this.lastRecvMs;
      if (!shouldWatchdogTrip(elapsed, WATCHDOG_MS)) return;
      this.stopWatchdog();
      this.connected = false;
      this.onConnectionChange?.(false);
      const sock = this.ws;
      this.ws = null;
      // close() 会异步触发 onclose → scheduleReconnect；这里先置 null 防重复排队
      try {
        sock?.close();
      } catch {
        this.scheduleReconnect();
      }
      if (!sock) this.scheduleReconnect();
    }, 1000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** 主动断开并停止一切自动行为（页面卸载/测试收尾用） */
  dispose(): void {
    this.autoReconnect = false;
    this.stopWatchdog();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.ws;
    this.ws = null;
    this.connected = false;
    try {
      sock?.close();
    } catch {
      /* 已关闭，忽略 */
    }
  }

  private handle(msg: ServerMsg): void {
    // ping：只更新心跳基准（onmessage 已统一刷过），不触碰任何状态。
    // 显式 return 是为了让它不落进下面的 delta/full 分支（ping 没有 d.pawns）。
    if (msg.t === 'ping') return;
    if (msg.t === 'welcome') {
      this._tuning = msg.d.tuning;
      // 客户端本地世界：只做纯函数查询（tile/feature），不参与模拟
      this.world = new World(structuredClone(msg.d.tuning), msg.d.seed, { x: 0, y: 0 });
      this.applyFull(msg.d);
      return;
    }
    if (msg.t === 'full') {
      this.applyFull(msg.d);
      return;
    }
    if (msg.t === 'delta') {
      const d = msg.d;
      const prevTime = this.time;
      this.time = d.time;
      this.stockpile = d.stockpile;
      for (const p of d.pawns) {
        // 先取旧位置再覆盖：pushInterp 需要「上一权威位」作为插值起点，
        // 而 pawnMap.set 会立刻把旧值顶掉。顺序反了会导致第一帧也瞬移。
        const priorPos = this.pawnMap.get(p.eid)?.pos;
        this.pawnMap.set(p.eid, p);
        this.pushInterp(p.eid, p.pos, priorPos, d.time - prevTime);
      }
      for (const eid of d.removedPawns) {
        this.pawnMap.delete(eid);
        this.interpSlots.delete(eid); // 渲染槽必须同步清理，否则渲染会画出已死的鼠
      }
      this.eventsList.push(...d.newEvents);
      // 客户端事件列表封顶：服务器环缓冲 200，但 delta 是增量追加——不封顶长局必泄漏
      if (this.eventsList.length > 400) this.eventsList = this.eventsList.slice(-200);

      // 区块化：delta 的 scope 只说明"变化可能发生在哪些块"，**不能用来卸载**；
      // 卸载只认 droppedChunks。两者分开是协议里刻意区分的语义。
      if (d.scope || d.droppedChunks) {
        this.applyChunkScope(d.scope, d.droppedChunks, () => {
          // scope 内 = 本帧的权威值，整体替换（裁剪后 hostiles/buildings 就是 scope 内的全集）
          this.hostileList = d.hostiles;
          this.buildingList = d.buildings;
        });
      } else {
        this.hostileList = d.hostiles;
        this.buildingList = d.buildings;
      }
    }
  }

  /**
   * 记一帧插值（R1-3）：prev ← 旧 next，next ← 本帧权威位置。
   * **只写 interpSlots，不碰 pawnMap**——逻辑状态保持服务端事实原样。
   * deltaSec 是本帧与上帧的模拟时间差；≤0（首帧/时间未前进）时槽内间隔记 0，
   * interpK 会返回 1 → 直接落在权威位置，符合「没有区间就没有插值」。
   */
  private pushInterp(eid: Eid, pos: Pos, priorPos: Pos | undefined, deltaSec: number): void {
    let slot = this.interpSlots.get(eid);
    if (!slot) {
      // delta 里出现陌生 eid（welcome 之后新出生、或 full 漏了它）：
      // 用「上一权威位置」建槽再 advance，这样第一帧就有插值起点、不会瞬移。
      // 没有上一位置可用（真的是第一次见到这只）时只能吸附——没有起点就无法插值。
      slot = new InterpSlot(priorPos ?? pos);
      this.interpSlots.set(eid, slot);
    }
    slot.advance(pos, deltaSec);
  }

  private applyFull(d: FullState): void {
    // 带 scope 的 full = "本 scope 的权威对账"：scope 外必须卸载。
    // 缺省 scope（旧服务端/未开裁剪）= 保持全量投影，与 v1 行为逐位相同。
    if (d.scope) {
      this.applyChunkScope(d.scope, undefined, (inScope) => {
        this.applyFullInner(d, inScope);
      });
      return;
    }
    this.applyFullInner(d, null);
  }

  /** full 的真正实现；inScope = null 表示"不裁剪，全部保留"。 */
  private applyFullInner(d: FullState, inScope: ReadonlySet<number> | null): void {
    this.time = d.time;
    this.stockpile = d.stockpile;
    // 先只清 scope 内的 pawn（裁剪时），避免把别的区块的也清掉
    if (inScope === null) {
      this.pawnMap.clear();
      this.interpSlots.clear();
    } else {
      for (const [eid, p] of [...this.pawnMap]) {
        if (inScope.has(tileChunkKey(p.pos.x, p.pos.y).key)) {
          this.pawnMap.delete(eid);
          this.interpSlots.delete(eid);
        }
      }
    }
    for (const p of d.pawns) {
      this.pawnMap.set(p.eid, structuredClone(p));
      // full = 权威对账，直接吸附不插值（R1-3）：插值对账只会渲染出错误的中间态
      this.interpSlots.set(p.eid, new InterpSlot(p.pos));
    }
    this.hostileList = d.hostiles;
    this.buildingList = d.buildings;
    this.eventsList = d.events;
    this.world.importState(d.world);
    this.world.now = d.time; // 与读档同理：再生冷却的基准时钟必须对齐
    // 科技状态整份覆盖（full 是权威快照）：替换而非累加，否则 delta 后的陈旧
    // techsUnlocked 会永久残留——客户端不做"科技回退"推理。
    this.techsUnlocked = new Set(d.techs ?? []);
    this.techFrag = { ...(d.techFragments ?? {}) };
    // HUD scratch 子集整体覆盖（full 是权威快照）；缺字段回落空对象
    // ——老服务端不带该字段时表现为"威胁面板显示未知"，不是假 0%（R3-HUD 向前兼容）。
    this.hudScratch = { ...(d.hudScratch ?? {}) };
  }

  /**
   * 渲染层专用坐标（R1-3）：返回插值后的位置，供 renderer 逐帧读取。
   *
   * 这是**唯一**允许看插值的地方——HUD、点选命中、框选判定一律继续用
   * pawns() 的权威坐标。若让它们也读插值值，就会出现「看到的鼠」与「被选中的鼠」
   * 不是同一只的错位，批量指挥就会指挥错对象。
   *
   * @param nowMs 渲染时钟（默认 Date.now）
   */
  renderPos(eid: Eid, nowMs?: number): Pos | undefined {
    const slot = this.interpSlots.get(eid);
    if (!slot) return this.pawnMap.get(eid)?.pos;
    return slot.snapshot((nowMs ?? this.nowFn()) - this.lastRecvMs);
  }

  sendCommand(type: string, args?: Record<string, unknown>): void {
    const msg: ClientMsg = { t: 'cmd', c: { type, args } };
    this.onCmdUp?.({ type, args });
    this.ws?.send(JSON.stringify(msg));
  }

  /**
   * 上报视口兴趣区（line/net）：服务端据此裁剪快照。
   *
   * **节流到"区块集合真的变了"才上行**：渲染层每帧都会调（相机平滑移动），
   * 若照单全收就是 60Hz 上行（比 2Hz 下行还贵，净亏）。
   * 判据用区块键集合的**长度+首末键**做指纹——这不是严格哈希，但漏判的代价
   * 只是"这一帧没上报"（下一帧补上），而错判的代价（上报了没变的）
   * 只是多一条小消息，所以偏向保守（宁可多发）。精确去重留待实测出现带宽问题再做。
   *
   * 半径默认 192 tile（3 个 chunk 跨度）：覆盖 1080p 全屏 22px/格的视野约 40 格，
   * 留出 4.8 倍余量应对镜头惯性移动。调小的收益是带宽，调大的是"走回去不用等刷新"。
   */
  setInterest(x: number, y: number, r = 192): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || r <= 0) return;
    const keys = chunksForInterest({ x, y, r });
    const fp = `${keys.length}:${keys[0] ?? ''}:${keys[keys.length - 1] ?? ''}`;
    if (fp === this.lastInterestKey) return;
    this.lastInterestKey = fp;
    const msg: ClientMsg = { t: 'interest', d: { x, y, r } };
    this.ws?.send(JSON.stringify(msg));
  }

  /** 当前已加载区块数（测试/调试用：观察"走远后卸载"是否真的发生） */
  get loadedChunkCount(): number {
    return this.loadedChunks === null ? -1 : this.loadedChunks.size;
  }

  /**
   * 合入带 scope 的快照（line/net）。
   *
   * 三件事，顺序不能换：
   *  1. 先**卸载** droppedChunks（走远时清掉远端投影）；
   *  2. 再**整体替换**本帧 scope 内的数据（full 语义 = 权威对账）；
   *  3. 最后登记 loadedChunks。
   *
   * 卸载必须在替换之前吗？不必须，但**同一次调用里完成**才行：
   * 若把卸载推迟到下一帧，会出现"同一区块先被 dropped 标记、又在本帧 full 里
   * 出现"的顺序，客户端若按顺序处理就会先删后加（多一次重建开销）；
   * 反序则是先加后删（当帧丢失刚收到的数据，表现为"走回来时建筑闪一下才出现"）。
   * 同调用内做完 + 作用域内先删后加，两个方向都不闪。
   */
  private applyChunkScope(
    scope: ChunkCoord[] | undefined,
    dropped: ChunkCoord[] | undefined,
    replace: (inScope: ReadonlySet<number> | null) => void,
  ): void {
    const scopeKeys = scope ? new Set(fromChunkCoords(scope)) : null;
    if (dropped && dropped.length > 0) {
      for (const c of dropped) {
        // 用 chunkKey 而不是"伪造坐标再反解"：这里做的就是编码，直接调
        // chunks.ts 的唯一入口 fromChunkCoords，**不在客户端另写一份解码**。
        const key = fromChunkCoords([c])[0];
        this.loadedChunks?.delete(key);
        this.unloadChunk(key);
      }
    }
    if (scopeKeys) {
      if (this.loadedChunks === null) this.loadedChunks = new Set();
      for (const k of scopeKeys) this.loadedChunks.add(k);
    }
    replace(scopeKeys);
  }

  /** 卸载一个区块的本地投影：建筑/敌袭按区块过滤掉。
   *  pawnMap **不**卸载——鼠是玩家直接指挥的对象，且数量少；
   *  卸载它们会让"走出视野再走回来"时选中状态与插值槽全部失效（更糟的体验）。
   *  建筑才是带宽与内存的大头，也是"幽灵建筑"的主要来源。 */
  private unloadChunk(key: number): void {
    this.buildingList = this.buildingList.filter((b) => tileChunkKey(b.pos.x, b.pos.y).key !== key);
    this.hostileList = this.hostileList.filter((h) => tileChunkKey(h.pos.x, h.pos.y).key !== key);
  }

  // ---- WorldView ----
  pawns(): Iterable<PawnState> {
    return this.pawnMap.values();
  }
  /** 单只投影（只读用途；测试/调试） */
  pawn(eid: number): Readonly<PawnState> | undefined {
    return this.pawnMap.get(eid);
  }
  /**
   * 测试钩子：绕过 WebSocket 直喂服务器消息（协议形状与真实链路同源）。
   *
   * 刻意与真实链路保持一致：onmessage 里会先刷新 lastRecvMs（看门狗与插值的时间基准），
   * 这里也必须刷新。早期版本漏了这一步，导致插值基准停在 0、
   * 表现为「测试里刚喂完帧就等于插值终点」——测试与真实行为分叉，
   * 恰恰是这类钩子最危险的失效模式。
   */
  handleForTest(msg: ServerMsg): void {
    this.lastRecvMs = this.nowFn();
    this.handle(msg);
  }
  hostiles(): readonly Hostile[] {
    return this.hostileList;
  }
  buildings(): BuildingState[] {
    return this.buildingList;
  }
  get tuning(): Tuning {
    return this._tuning;
  }
  zAt(x: number, y: number): number {
    return this.world?.zAt(x, y) ?? 0;
  }
  buildingsAll(): Iterable<BuildingState> {
    return this.buildingList;
  }
  events(): LogEvent[] {
    return this.eventsList.slice(-8);
  }
  buildingDef(defId: string) {
    return this._tuning.buildings[defId];
  }
  traitName(trait: string): string {
    return this._tuning.traits[trait]?.name ?? trait;
  }
  tileAt(x: number, y: number): string {
    return this.world.tileAt(x, y);
  }
  featureAt(x: number, y: number) {
    return this.world.featureAt(x, y);
  }
  techProgress(): import('./view').TechProgressRow[] {
    // 与 LocalView 同构：顺序取自 tuning 科技表（welcome 已带全表 tuning），状态取自 full 快照
    const techs = this._tuning.techs ?? {};
    return Object.keys(techs)
      .sort((a, b) => techs[a].order - techs[b].order || a.localeCompare(b))
      .map((id) => ({
        id,
        name: techs[id].name ?? id,
        have: this.techFrag[id] ?? 0,
        need: techs[id].fragments ?? 1,
        unlocked: this.techsUnlocked.has(id),
      }));
  }
  /** 与 LocalView 同构：联机模式的地形来自本地推导 World + full 快照运行态，信息等价 */
  inspect(x: number, y: number): TileInspect {
    const w = this.world;
    const terrainId = w.tileAt(x, y);
        const f = w.featureAt(x, y);
    const b = w.buildingAt(x, y);
    const treeCanopy = w.treeBlockAt(x, y) && !b; // 权威判定：树冠可悬在水/岩上，地形推断会漏
    return {
      x,
      y,
      terrainId,
      terrainName: TERRAIN_NAME[terrainId] ?? terrainId,
      z: w.zAt(x, y),
      liquid: w.tuning.tiles[w.tileAt(x, y)]?.liquid ?? false,
      standable: w.canStand(x, y),
      treeCanopy,
      feature: f
        ? {
            kind: f.kind,
            amount: f.amount,
            label: f.kind === 'tree' ? `大树（余 ${f.amount} 木）` : `浆果丛（余 ${f.amount} 果）`,
          }
        : null,
      buildingName: b ? this.tuning.buildings[b.defId]?.name ?? b.defId : null,
    };
  }

  // ---- HUD 汇总面 / 详情面（R3-HUD）：与 LocalView 同算法（hud-faces.ts），只有取数路径不同 ----
  /**
   * 最近火堆距离：走本地 World 的建筑表（full 快照已把建筑表合入 importState 之外的
   * buildingList，且 world.buildings 也由 importState 同步）——与本地模式同一份寻址逻辑，
   * 不做"联机近似"。
   */
  private fireDist(x: number, y: number): number | null {
    let best: number | null = null;
    for (const b of this.buildingList) {
      if (!(this._tuning.buildings[b.defId]?.tags ?? []).includes(K_TAG_FIRE)) continue;
      const d = Math.hypot(b.pos.x - x, b.pos.y - y);
      if (best === null || d < best) best = d;
    }
    return best;
  }

  colony(): import('./view').ColonySummary {
    return buildColonySummary({
      pawns: this.pawnMap.values(),
      buildings: this.buildingList,
      hostiles: this.hostileList,
      tuning: this._tuning,
      traitName: (t) => this.traitName(t),
      nearestFireDist: (x, y) => this.fireDist(x, y),
      // 压力值来自服务端下发的白名单子集；未挂 raid 包时服务端不下发该键 → null（面板隐藏而非显示假 0%）
      raidPressureRaw: this.hudScratch['raid.pressure'] ?? null,
    });
  }

  inspectPawn(eid: number): import('./view').PawnDetail | null {
    const p = this.pawnMap.get(eid);
    if (!p) return null;
    return buildPawnDetail(p, (t) => this.traitName(t), (x, y) => this.fireDist(x, y));
  }

  inspectBuilding(id: string): import('./view').BuildingDetail | null {
    const b = this.buildingList.find((x) => x.id === id);
    if (!b) return null;
    return buildBuildingDetail(b, this.buildingList, this._tuning);
  }

  inspectHostile(id: number): import('./view').HostileDetail | null {
    const h = this.hostileList.find((x) => x.id === id);
    if (!h) return null;
    return buildHostileDetail(h, this.hostileList, this.pawnMap.values(), this._tuning);
  }
}