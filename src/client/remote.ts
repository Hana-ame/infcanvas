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
 */
import { World } from '../sim/world';
import type { BuildingState, Eid, Hostile, LogEvent, PawnState, Pos } from '../sim/types';
import { DEFAULT_TUNING, type Tuning } from '../sim/tuning';
import { TERRAIN_NAME, type TileInspect, type WorldView } from './view';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { WATCHDOG_MS } from '../shared/protocol';
import { BackoffState, shouldWatchdogTrip } from './reconnect';
import { InterpSlot } from './interp';

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
  /** 本地地形推导器（seed+tuning 与服务器一致；余量随 full 快照同步） */
  world!: World;
  /**
   * 科技抽卡池状态（R2-1）：只随 welcome/full 到达，delta 不更新
   * （与 game-server 的发送策略对称——低频状态走低频通道，避免拖慢 500ms 增量帧）。
   */
  private techsUnlocked = new Set<string>();
  private techFrag: Record<string, number> = {};
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
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
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
      this.hostileList = d.hostiles;
      this.buildingList = d.buildings;
      this.eventsList.push(...d.newEvents);
      // 客户端事件列表封顶：服务器环缓冲 200，但 delta 是增量追加——不封顶长局必泄漏
      if (this.eventsList.length > 400) this.eventsList = this.eventsList.slice(-200);
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

  private applyFull(d: import('../shared/protocol').FullState): void {
    this.time = d.time;
    this.stockpile = d.stockpile;
    this.pawnMap.clear();
    this.interpSlots.clear();
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
}