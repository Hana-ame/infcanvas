// RemoteSim —— 连 P1 server 的客户端视图（DESIGN §5：权威在 server）
// 实现与本地 Sim 同构的读取面，HUD/Renderer 无需区分本地/远程。
// 用法：?remote=ws://127.0.0.1:8080
import { K_WEARABLE } from '../sim/mods/contracts';
import { EventBus, type GameEvent } from '../sim/core/events';
import type { BehaviorCard } from '../sim/ai/pawn';
import type { TileDef, BuildingDef, ItemDef } from '../sim/defs';
import type { EnvTuning } from '../sim/defs/tuning';
import type { WelcomeTuning } from '../shared/protocol';
import type { FactionTuning } from '../sim/defs/tuning';
import type { Command } from '../sim/sim';
import type { ServerMsg, WelcomeMsg, SnapshotMsg, DeltaMsg } from '../shared/protocol';
import { World, type ChunkData } from '../sim/core/world';

// 协议快照里建筑形状
interface SnapBuilding {
  defId: string; x: number; y: number; hp: number; maxHp: number; faction: string;
  footprint: { x: number; y: number }[];
  def?: BuildingDef;
}

// ---- HUD / Renderer 所需的 sim 公共读取面（本地 Sim 与 RemoteSim 都满足） ----
export interface SimViewHostile { i?: number; enemyId?: string; x: number; y: number; hp: number; maxHp: number; faction?: string }

export interface SimViewPawn {
  dna: { str: number; con: number; siz: number; dex: number; int: number; pow: number; app: number; edu: number; traits: string[]; maxSlots: number };
  slots: (BehaviorCard | null)[];
  job: string; assignedJob?: string;
  needs?: { food: number; rest: number; mood: number; san: number } | null;
  health?: { hp: number; maxHp: number } | null;
  pos: { x: number; y: number };
  faith: number;
  skills: Record<string, number>;
  desires: Record<string, number>;
  oracleBuff?: { until: number; mood: number };
  expectEarn?: number;  // 个人经济预期：工作赚（滚动平均）
  expectSpend?: number; // 个人经济预期：花费花（滚动平均）
  lastDecision?: { drawn: string[]; picked: string; time: number };
  // RW-1（2026-08-15）：工作优先级 + 征召（协议透传自 server pawn.extra）。缺省 = 全自动/
  // 未征召——HUD Work Tab / 征召按钮据此渲染（本地与远程共用同一 SimViewPawn 契约）。
  workPriorities?: Record<string, number>;
  drafted?: boolean;
}

export interface SimViewUnit {
  key: number; members: number[]; memory: { time: number; text: string }[];
  label: string; // 篝火名（2026-08-14 重构：派系=涌现展示，无 id/name/level/资源/看法）
}

export interface SimViewBuilding { def: BuildingDef; defId: string; hp: number; maxHp: number; faction: string }

export interface SimView {
  techs?: ReadonlySet<string>; // 已解锁科技（单机有；远端缺省 undefined → 全部可见）
  techsMap?: Record<string, { name: string; desc: string; fragments: number }>; // 科技表（2026-08-14 加 fragments=所需碎片数；单机有；远端可选）
  techFragments?: Record<string, number>; // 已集碎片（2026-08-14 碎片制；单机有；远端缺省 → 只显已解锁）
  stockpile: Record<string, number>;
  hostiles: SimViewHostile[];
  paused: boolean; speed: number; time: number; dayLength: number; tickHz: number;
  env: { raining: boolean; temperature: number; rainLeft: number };
  tuning: { env?: EnvTuning; needs?: WelcomeTuning['needs']; faction?: Partial<FactionTuning> };
  isNight(): boolean;
  /**
   * 渲染播放时钟：消息驱动的视图（RemoteSim）用它给出帧间连续时间做插值；
   * 本地 Sim（逐帧步进 time）不实现 → 渲染层回退用 time。
   */
  renderNow?(): number;
  pawns: readonly number[];
  pawnPositions: Map<number, { x: number; y: number }>;
  pawnProfile(eid: number): SimViewPawn | null;
  healthOf(eid: number): { hp: number; maxHp: number } | null;
  selected: number[];
  get selectedIds(): number[];
  bus: { on(type: string, fn: (ev: GameEvent) => void): () => void };
  mods: { tiles: Record<string, TileDef>; buildings: Record<string, BuildingDef>; items: Record<string, ItemDef> };
  world: {
    width: number; height: number;
    buildings: Map<number, any>;
    buildingVersion: number;
    getTile(x: number, y: number): string;
    footprintOf(x: number, y: number): { x: number; y: number }[];
    buildKey(x: number, y: number): number;
    canBuildAt(x: number, y: number): boolean;
    canBuildFootprint(x: number, y: number, def: BuildingDef): boolean;
  };
  buildCount: number;
  buildQueueItems: { x: number; y: number; defId: string; progress: number }[];
  events: { time: number; text: string }[];
  historyRecent: { id: number; time: number; day: number; type: string; eid?: number; x?: number; y?: number; cause?: string; data?: Record<string, unknown> }[];
  factionsView(): SimViewUnit[]; // 派系 = 涌现展示（按 fireId 聚合，纯只读）
  buildingAt(x: number, y: number): SimViewBuilding | null;
  buildingDef(id: string): BuildingDef | undefined;
  issueCommand(cmd: Command): void;
  step(dt: number): void;
}

// ---- 世界视图（只读；tile 增量由 event 更新） ----
// 无限地图（DESIGN §370 双图层 P0 快照形态）：tileGrid = 已生成 chunk 的完整地形
//（chunk 键支持负坐标）；未收到 chunk 的区域 = 未知（'mountain'，P2 流式 watchArea 拉取）
class RemoteWorld {
  width = 192;
  height = 192;
  private chunks = new Map<number, string[]>(); // chunkKey → 完整地形 tile id 数组
  buildings = new Map<number, SnapBuilding>();
  buildingVersion = 0;
  private defs: Record<string, BuildingDef>;

  constructor(defs: Record<string, BuildingDef>) {
    this.defs = defs;
  }

  setWorld(w: WelcomeMsg['world'], chunks: ChunkData[]): void {
    this.width = w.width;
    this.height = w.height;
    this.chunks = new Map();
    for (const c of chunks) this.chunks.set((c.x + 32768) + (c.y + 32768) * 65536, c.tiles);
  }

  getTile(x: number, y: number): string {
    const cx = Math.floor(x / 64);
    const cy = Math.floor(y / 64);
    const chunk = this.chunks.get((cx + 32768) + (cy + 32768) * 65536);
    if (!chunk) return 'mountain'; // 未知区域（server 未下发；P2 流式补齐）
    return chunk[(y - cy * 64) * 64 + (x - cx * 64)] ?? 'grass';
  }

  setTile(x: number, y: number, id: string): void {
    const cx = Math.floor(x / 64);
    const cy = Math.floor(y / 64);
    const ck = (cx + 32768) + (cy + 32768) * 65536;
    const chunk = this.chunks.get(ck);
    if (!chunk) return; // 未下发的 chunk：无本地地形，忽略（server 权威）
    chunk[(y - cy * 64) * 64 + (x - cx * 64)] = id;
  }

  buildKey(x: number, y: number): number { return x + y * 2 ** 31; }

  buildingAt(x: number, y: number): SnapBuilding | null {
    const b = this.buildings.get(this.buildKey(x, y));
    if (b) return b;
    for (const ent of this.buildings.values()) {
      if (ent.footprint.some((f) => f.x === x && f.y === y)) return ent;
    }
    return null;
  }

  footprintOf(x: number, y: number): { x: number; y: number }[] {
    return this.buildingAt(x, y)?.footprint ?? [{ x, y }];
  }

  defOf(id: string): BuildingDef | undefined { return this.defs[id]; }

  canBuildAt(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return !this.buildingAt(x, y);
  }

  canBuildFootprint(x: number, y: number, def: BuildingDef): boolean {
    for (let dx = 0; dx < def.size.x; dx++) {
      for (let dy = 0; dy < def.size.y; dy++) {
        if (!this.canBuildAt(x + dx, y + dy)) return false;
      }
    }
    return true;
  }

  applySnapshot(snap: SnapshotMsg): void {
    this.buildings = new Map();
    for (const b of snap.buildings) {
      // key = 协议自带（World 编码，2026-08-15 审计修复：与 delta 身份统一，不再重拼）
      this.buildings.set(b.key, {
        ...b,
        def: this.defs[b.defId] ?? { id: b.defId, name: b.defId, size: { x: 1, y: 1 }, hp: b.maxHp, color: '#888', passable: true, buildTime: 3 },
      });
    }
    this.buildingVersion = snap.buildingVersion;
  }
}

// ---- 客户端视图 ----
export class RemoteSim {
  ws!: WebSocket;
  bus: EventBus;
  selected: number[] = [];
  dayLength = 120; // welcome 消息覆盖为 server 真实值（与 tuning 同源）
  tickHz = 20;

  time = 0;
  paused = false;
  speed = 1;
  day = 1;
  env = { raining: false, temperature: 18, rainLeft: 0 };
  tuning = { env: undefined } as { env?: EnvTuning; needs?: WelcomeTuning['needs']; faction?: Partial<FactionTuning> };
  // 渲染用播放时钟：权威消息把 t 锚定到墙钟，帧间 extrapolate（t + 墙钟流逝 × speed），
  // 让插值渲染有连续的 sim 时间（消息 500ms 一跳，直接读 time 则每帧恒等）
  private anchorT = 0;
  private anchorWall = 0;
  renderNow(): number {
    if (this.paused) return this.anchorT;
    return this.anchorT + (performance.now() - this.anchorWall) * this.speed;
  }
  stockpile: Record<string, number> = {};
  hostiles: SnapshotMsg['hostiles'] = [];
  pawns: number[] = [];
  pawnPositions = new Map<number, { x: number; y: number }>();
  events: { time: number; text: string }[] = [];
  historyRecent: { id: number; time: number; day: number; type: string; eid?: number; x?: number; y?: number; cause?: string; data?: Record<string, unknown> }[] = [];
  mods: {
    tiles: Record<string, TileDef>;
    buildings: Record<string, BuildingDef>;
    items: Record<string, ItemDef>;
    cards: Record<string, { id: string; name: string }>;
  };

  world: RemoteWorld;

  private snap: SnapshotMsg | null = null;
  private pawnCache = new Map<number, SnapshotMsg['pawns'][number]>();
  private resolveConnected: (() => void) | null = null;
  private rejectConnected: ((e: Error) => void) | null = null;
  private connectedOnce = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private lastMessageAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  // 心跳阈值：超过此时长没收到任何 server 消息 → 判定断线（server 假死/网络黑洞），主动重连
  watchdogMs = 5000;

  // 连接状态（HUD 可显示）：connecting 初次 / connected / reconnecting 断线重连 / offline 已销毁
  status: 'connecting' | 'connected' | 'reconnecting' | 'offline' = 'connecting';
  onStatus?: (s: RemoteSim['status']) => void;

  constructor(private url: string) {
    this.bus = new EventBus();
    this.mods = { tiles: {}, buildings: {}, items: {}, cards: {} };
    this.world = new RemoteWorld(this.mods.buildings);
    // 远端命令入口：type 直接透传给 server（server 端权威校验）
    this.issueCommand = (cmd: Command) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'cmd', cmd }));
    };
  }

  // 连接并等 welcome（世界底 + defs 只读表）。首次连接失败 reject；连上后的断开自动重连
  connect(): Promise<RemoteSim> {
    this.openSocket();
    return new Promise((resolve, reject) => {
      this.resolveConnected = () => { resolve(this); this.resolveConnected = null; this.rejectConnected = null; };
      this.rejectConnected = reject;
    });
  }

  // 主动关闭（页面卸载），停止重连
  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopWatchdog();
    this.ws?.close();
    this.status = 'offline';
    this.onStatus?.(this.status);
  }

  private openSocket(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.setStatus(this.connectedOnce ? 'reconnecting' : 'connecting');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.setStatus('connected');
      this.hideHint();
      this.startWatchdog();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      try { this.onMessage(String(e.data)); } catch (err) { console.error('[remote] 消息解析失败', err); }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopWatchdog();
      if (!this.connectedOnce) {
        // 首次连接失败：让调用方知道（红屏提示配置错误）
        this.rejectConnected?.(new Error(`remote: 连接失败 ${this.url}`));
        this.rejectConnected = null;
        return;
      }
      this.scheduleReconnect();
    };
    // 首次连接 welcome 超时兜底（server 活着但没响应）
    setTimeout(() => {
      if (!this.connectedOnce && !this.snap && this.rejectConnected) {
        this.rejectConnected(new Error(`remote: welcome 超时 ${this.url}`));
        this.rejectConnected = null;
      }
    }, 6000);
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.reconnectAttempt++;
    this.setStatus('reconnecting');
    // 指数退避：1s → 2s → 4s…封顶 15s（server 重启风暴时避免客户端同时重连轰炸）
    const delay = Math.min(15000, 1000 * 2 ** (this.reconnectAttempt - 1));
    this.hint(`⚠ 与服务器断开，${Math.round(delay / 1000)} 秒后自动重连（第 ${this.reconnectAttempt} 次）`);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private setStatus(s: RemoteSim['status']): void {
    this.status = s;
    this.onStatus?.(s);
  }

  // 看门狗：connected 期间定时检查消息新鲜度；静默超时 → 主动断开触发重连
  private startWatchdog(): void {
    this.stopWatchdog();
    this.lastMessageAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      if (this.status !== 'connected') return;
      if (Date.now() - this.lastMessageAt > this.watchdogMs) {
        console.warn(`[remote] 心跳超时（${this.watchdogMs}ms 无消息），主动重连`);
        this.ws?.close();
      }
    }, 1000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
  }

  private hideHint(): void {
    const el = document.getElementById('remote-hint');
    if (el) el.remove();
  }

  private hint(text: string): void {
    let el = document.getElementById('remote-hint');
    if (!el) {
      el = document.createElement('div');
      el.id = 'remote-hint';
      el.style.cssText = 'position:fixed;top:44px;left:50%;transform:translateX(-50%);z-index:20;background:rgba(200,60,60,.9);color:#fff;border-radius:8px;padding:6px 14px;font:13px system-ui;';
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  private onMessage(raw: string): void {
    const m = JSON.parse(raw) as ServerMsg;
    // 权威时间锚定（welcome 无 t；快照/增量/事件都有）
    if ('t' in m && typeof (m as { t?: unknown }).t === 'number') {
      this.anchorT = (m as { t: number }).t;
      this.anchorWall = performance.now();
    }
    if (m.type === 'welcome') {
      this.connectedOnce = true;
      this.tickHz = m.tickHz;
      this.dayLength = m.dayLength;
      this.tuning = { needs: m.tuning.needs, faction: m.tuning.faction, env: { dayLength: m.tuning.env.dayLength, baseTemp: m.tuning.env.baseTemp } as EnvTuning };
      this.world.setWorld(m.world, m.tileGrid);
      for (const [id, d] of Object.entries(m.tiles)) {
        this.mods.tiles[id] = { id, name: id, passable: d.passable, buildable: d.buildable, color: d.color, emoji: d.emoji, sprite: d.sprite, mineral: false, growable: false };
      }
      for (const [id, d] of Object.entries(m.buildings)) {
        this.mods.buildings[id] = {
          id, name: d.name, size: d.size, color: d.color, emoji: d.emoji, passable: d.passable,
          hp: d.hp, buildTime: 3, costWood: d.costWood, costOre: d.costOre, capabilities: [],
        };
      }
      for (const [id, d] of Object.entries(m.items)) {
        // w = 可穿标记（clothing 玩法包：HUD 穿衣按钮过滤；读 ItemDef.meta.wearable）
        this.mods.items[id] = { id, name: d.name, meta: d.w ? { [K_WEARABLE]: true } : undefined };
      }
      this.resolveConnected?.();
    } else if (m.type === 'snapshot') {
      this.applySnapshot(m);
    } else if (m.type === 'delta') {
      this.applyDelta(m);
    } else if (m.type === 'event') {
      for (const ev of m.events) {
        if (ev.kind === 'tileChanged' && ev.x !== undefined && ev.y !== undefined && ev.tileId) {
          this.world.setTile(ev.x, ev.y, ev.tileId);
        } else if (ev.kind === 'resourceGained' && ev.eid !== undefined) {
          const g: GameEvent = { type: 'resource_gained', eid: ev.eid, item: ev.item ?? '', amount: ev.amount ?? 0 };
          this.bus.emit(g);
        } else if (ev.kind === 'feed' && ev.text) {
          this.events.push({ time: m.t, text: ev.text });
          if (this.events.length > 30) this.events.splice(0, this.events.length - 30); // feed 本地只留最近 30 条（HUD 只用 5 条，防无限增长）
        }
      }
    }
  }

  private applySnapshot(m: SnapshotMsg): void {
    this.snap = m;
    this.time = m.t;
    this.paused = m.paused;
    this.speed = m.speed;
    this.day = m.day;
    this.env = { raining: m.weather.raining, temperature: m.weather.temperature, rainLeft: 0 };
    this.stockpile = m.stockpile;
    this.hostiles = m.hostiles;
    this.world.applySnapshot(m);

    const old = new Set(this.pawnPositions.keys());
    const now = new Set<number>();
    this.pawnCache.clear();
    for (const p of m.pawns) {
      this.pawnCache.set(p.eid, p);
      this.pawnPositions.set(p.eid, { x: p.x, y: p.y });
      now.add(p.eid);
    }
    for (const eid of old) if (!now.has(eid)) this.pawnPositions.delete(eid);
    this.pawns = m.pawns.map((p) => p.eid);
  }

  // tick delta：把变化量合并进本地缓存（身份对齐：pawn eid / 建筑 key）
  private applyDelta(m: DeltaMsg): void {
    this.snap = { ...this.snap ?? { type: 'snapshot', t: 0, paused: false, speed: 1, isNight: false, day: 1, weather: { raining: false, temperature: 18 }, stockpile: {}, pawns: [], hostiles: [], buildings: [], buildQueue: [], buildingVersion: 0 }, ...m as unknown as SnapshotMsg };
    this.time = m.t;
    if (m.paused !== undefined) this.paused = m.paused;
    if (m.speed !== undefined) this.speed = m.speed;
    if (m.day !== undefined) this.day = m.day;
    if (m.weather) this.env = { ...this.env, ...m.weather, rainLeft: this.env.rainLeft };
    if (m.stockpile) this.stockpile = m.stockpile;

    let pawnListChanged = false;
    if (m.pawns) {
      for (const pd of m.pawns) {
        if (pd.removed) {
          this.pawnCache.delete(pd.eid);
          this.pawnPositions.delete(pd.eid);
          pawnListChanged = true;
          continue;
        }
        const old = this.pawnCache.get(pd.eid);
        const merged = { ...old } as SnapshotMsg['pawns'][number];
        if (pd.x !== undefined) merged.x = pd.x;
        if (pd.y !== undefined) merged.y = pd.y;
        if (pd.hp !== undefined) merged.hp = pd.hp;
        if (pd.maxHp !== undefined) merged.maxHp = pd.maxHp;
        if (pd.job !== undefined) merged.job = pd.job;
        if (pd.assignedJob !== undefined) merged.assignedJob = pd.assignedJob;
        if (pd.needs) merged.needs = pd.needs;
        if (pd.faith !== undefined) merged.faith = pd.faith;
        if (pd.attrs) merged.attrs = pd.attrs;
        if (pd.skills) merged.skills = pd.skills;
        if (pd.traits) merged.traits = pd.traits;
        if (pd.maxSlots !== undefined) merged.maxSlots = pd.maxSlots;
        if (pd.slots) merged.slots = pd.slots;
        if (pd.desires) merged.desires = pd.desires;
        if (pd.lastDecision) merged.lastDecision = pd.lastDecision;
        // worn 合并（2026-08-15 审计：diff.ts 已发 worn 变化，此处漏合并 → 远程穿衣后
        // pawnCache.worn 不更新，染色 tint 等 5s 全量对账才刷新；'' = 脱衣（协议归一），
        // || undefined 归一为空 —— wornOf 返回值统一（snapshot/delta 无穿着都是 undefined））
        if (pd.worn !== undefined) merged.worn = pd.worn || undefined;
        // RW-1（2026-08-15）：工作优先级与征召 delta 合并。workPriorities 在 diff 归一为
        // {}（= 清除全部回到自动），客户端按"收到即更新"（空对象 = 自动）；drafted 标量。
        if (pd.workPriorities !== undefined) merged.workPriorities = pd.workPriorities;
        if (pd.drafted !== undefined) merged.drafted = pd.drafted;
        this.pawnCache.set(pd.eid, merged);
        if (pd.x !== undefined && pd.y !== undefined) this.pawnPositions.set(pd.eid, { x: pd.x, y: pd.y });
        if (!old) pawnListChanged = true;
      }
    }
    if (m.pawnList) {
      this.pawns = m.pawnList;
    } else if (pawnListChanged) {
      this.pawns = [...this.pawnCache.keys()];
    }
    if (m.hostiles) this.hostiles = m.hostiles;
    if (m.buildings) {
      for (const b of m.buildings) {
        if (b.removed) {
          this.world.buildings.delete(b.key);
        } else {
          // 新 key 编码（2026-08-14 无限地图）：World.keyToXY 解码（负坐标支持）
          const { x, y } = World.keyToXY(b.key);
          this.world.buildings.set(b.key, {
            defId: b.defId, x, y,
            hp: b.hp, maxHp: b.maxHp, faction: b.faction, footprint: b.footprint,
            def: this.mods.buildings[b.defId] ?? fallbackDef(b.defId),
          });
        }
      }
    }
    if (m.buildingVersion !== undefined) this.world.buildingVersion = m.buildingVersion;
  }

  isNight(): boolean { return this.snap?.isNight ?? false; }

  get buildCount(): number { return this.snap?.buildQueue.length ?? 0; }
  get buildQueueItems(): { x: number; y: number; defId: string; progress: number }[] { return this.snap?.buildQueue ?? []; }
  get selectedIds(): number[] { return this.selected; }

  healthOf(eid: number): { hp: number; maxHp: number } | null {
    const p = this.pawnCache.get(eid);
    return p ? { hp: p.hp, maxHp: p.maxHp } : null;
  }

  // 穿着衣物物品 id（clothing 玩法包 2026-08-15）：渲染染色 tint 用——远程端 pawn 数据在
  // pawnCache（快照 worn 字段，server 从 PawnState.extra.worn.body 契约填充）
  wornOf(eid: number): string | undefined {
    return this.pawnCache.get(eid)?.worn;
  }

  pawnProfile(eid: number): SimViewPawn | null {
    const p = this.pawnCache.get(eid);
    if (!p) return null;
    return {
      dna: { ...p.attrs, traits: p.traits, maxSlots: p.maxSlots },
      slots: p.slots.map((c) => ({ id: c.id, name: c.name } as BehaviorCard)),
      job: p.job ?? '',
      assignedJob: p.assignedJob,
      needs: p.needs,
      health: { hp: p.hp, maxHp: p.maxHp },
      pos: this.pawnPositions.get(eid) ?? { x: 0, y: 0 },
      faith: p.faith,
      skills: p.skills,
      desires: p.desires,
      lastDecision: p.lastDecision,
      workPriorities: p.workPriorities,
      drafted: p.drafted === true, // 归一 boolean（协议缺省 = 未征召）
    };
  }

  buildingAt(x: number, y: number): { defId: string; def: BuildingDef; hp: number; maxHp: number; faction: string } | null {
    const b = this.world.buildingAt(x, y);
    if (!b) return null;
    return { defId: b.defId, def: this.buildingDef(b.defId) ?? fallbackDef(b.defId), hp: b.hp, maxHp: b.maxHp, faction: b.faction };
  }

  buildingDef(id: string): BuildingDef | undefined { return this.mods.buildings[id]; }

  factionsView(): SimViewUnit[] { return []; } // 远端无实时涌现派系（HUD 用建筑/个体数据）

  issueCommand: (cmd: Command) => void = () => {};

  // ---- 本地单机专属操作：远程模式无意义，no-op ----
  step(): void {}
  save(): string { return ''; }
  load(): void {}
  respawnPawns(): void {}
  ensureCamp(): void {}
}

// 未知建筑 id 兜底 def：server 升级新增建筑而 client 欢迎表未含时，HUD/渲染不崩（只显示 id）
function fallbackDef(id: string): BuildingDef {
  return { id, name: id, size: { x: 1, y: 1 }, hp: 50, color: '#888', passable: true, buildTime: 3 };
}
