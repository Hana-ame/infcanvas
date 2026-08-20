import { EventBus, type GameEvent } from '../sim/core/events';
import type { Command } from '../sim/sim';
import type { ServerMsg, WelcomeMsg, SnapshotMsg, DeltaMsg } from '../shared/protocol';
import { World, MAX_TILE, type ChunkData } from '../sim/core/world';
import type { SimViewHostile, SimViewPawn, SimViewUnit, SimViewBuilding, SimView } from './remote-view';
import { RemoteWorld, type SnapBuilding } from './remote-view';
import type { TileDef, BuildingDef, ItemDef } from '../sim/defs';
import type { EnvTuning, FactionTuning } from '../sim/defs/tuning';
import type { WelcomeTuning } from '../shared/protocol';
import type { BehaviorCard } from '../sim/ai/pawn';
import { K_WEARABLE } from '../sim/mods/contracts';
// Re-export SimView types for backward compatibility (imported by hud.ts etc.)
export type { SimViewHostile, SimViewPawn, SimViewUnit, SimViewBuilding, SimView };
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
  // 看门狗超时（2026-08-20 审计 M1）：5000 默认值 == 服务器全量对账间隔，静默期
  //（暂停/无事件）唯一消息源 5s 一发，零抖动余量 + 后台标签页定时器节流即误断重连。
  // 服务器现每 2s 显式心跳（PingMsg），15s 窗口 = 7 倍余量（仍远小于重连退避）。
  watchdogMs = 15000;

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
    // 任何消息都算心跳（2026-08-20 审计 M1 根修：此前 lastMessageAt 只在连接/看门狗
    // 启动时更新——消息收到也从不刷新，看门狗在静默期竟会"有消息也断线"）
    this.lastMessageAt = Date.now();
    // 权威时间锚定（welcome 无 t；快照/增量/事件/心跳都有）
    if ('t' in m && typeof (m as { t?: unknown }).t === 'number') {
      this.anchorT = (m as { t: number }).t;
      this.anchorWall = performance.now();
    }
    if (m.type === 'ping') return; // 心跳：仅刷新 lastMessageAt（t 锚定已处理），无业务
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
    // 权威快照基线（M2 修复，2026-08-20 审计）：此前整对象 spread delta 进 this.snap——
    // delta 是增量形状（pawns = 逐 pawn 部分字段、顶层字段不全），spread 后 this.snap 变
    // 成"半残快照"：pawns 数组被增量整体替换 → 其余 pawn 从 snap 蒸发；字段缺失 → 读面
    //（isNight/buildCount/buildQueueItems 及未来的对账点）误读 undefined。
    // 现在 this.snap 按"权威全量字段局部合入"维护：pawn 条目逐 eid 字段合并（与
    // pawnCache 共用 merged 对象）、removed 过滤、pawnList 重排；顶层变化字段单点赋值。
    // 全量对账（applySnapshot）仍是最终收敛点——delta 合入只做本地读面保鲜。
    if (!this.snap) this.snap = { type: 'snapshot', t: 0, paused: false, speed: 1, isNight: false, day: 1, weather: { raining: false, temperature: 18 }, stockpile: {}, pawns: [], hostiles: [], buildings: [], buildQueue: [], buildingVersion: 0 };
    else this.snap = { ...this.snap };
    this.snap.t = m.t;
    if (m.paused !== undefined) this.snap.paused = m.paused;
    if (m.speed !== undefined) this.snap.speed = m.speed;
    if (m.isNight !== undefined) this.snap.isNight = m.isNight;
    if (m.day !== undefined) this.snap.day = m.day;
    if (m.weather) this.snap.weather = m.weather;
    if (m.stockpile) this.snap.stockpile = m.stockpile;

    this.time = m.t;
    if (m.paused !== undefined) this.paused = m.paused;
    if (m.speed !== undefined) this.speed = m.speed;
    if (m.day !== undefined) this.day = m.day;
    if (m.weather) this.env = { ...this.env, ...m.weather, rainLeft: this.env.rainLeft };
    if (m.stockpile) this.stockpile = m.stockpile;

    let pawnListChanged = false;
    if (m.pawns) {
      // snap.pawns 随增量同步（M2：逐 eid 合并保全量形状，不整体替换）
      // 2026-08-20 优化：用 Map 代替 findIndex 逐条扫描——delta 每帧多条时 O(n²)→O(n)
      const snapById = new Map(this.snap.pawns.map((p) => [p.eid, p]));
      for (const pd of m.pawns) {
        if (pd.removed) {
          this.pawnCache.delete(pd.eid);
          this.pawnPositions.delete(pd.eid);
          snapById.delete(pd.eid);
          pawnListChanged = true;
          continue;
        }
        const old = this.pawnCache.get(pd.eid);
        // eid 显式拷贝（2026-08-20 审计 M2/L3 补漏）：新 pawn 增量 old=undefined 时 merged
        // 只有变化字段；snap.pawns 直接存 merged，条目缺 eid → pawns 权威序推导出 undefined
        const merged = { ...old, eid: pd.eid } as SnapshotMsg['pawns'][number];
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
        // RW-1（2026-08-15）：征召 delta 合并（drafted 标量）。工作优先级 M1 已撤回。
        if (pd.drafted !== undefined) merged.drafted = pd.drafted;
        // 战场指挥 DLC（field-command 包 2026-08-20）：编制树/生效战术 delta 合并（低频
        // 字段，命令/册封才变化——与 worn 同模式；缺省 undefined = 非指挥官/无战术）
        if (pd.commander !== undefined) merged.commander = pd.commander;
        if (pd.tactic !== undefined) merged.tactic = pd.tactic;
        this.pawnCache.set(pd.eid, merged);
        snapById.set(pd.eid, merged);
        if (pd.x !== undefined && pd.y !== undefined) this.pawnPositions.set(pd.eid, { x: pd.x, y: pd.y });
        if (!old) pawnListChanged = true;
      }
      // Map 保持原快照顺序（更新不换位，新增追加在尾），与旧 findIndex/push 语义一致
      this.snap.pawns = [...snapById.values()];
    }
    if (m.pawnList) {
      this.pawns = m.pawnList;
      // M2：snap.pawns 按权威顺序重排（其余条目字段保持不变）
      const byEid = new Map(this.snap.pawns.map((p) => [p.eid, p]));
      this.snap.pawns = m.pawnList.map((eid) => byEid.get(eid)!).filter(Boolean);
    } else if (pawnListChanged) {
      // 无权威 pawnList 的增量（审计 L3 防御）：跟随 snap 权威序（M2 已逐 eid 合入/追加），
      // 不用 pawnCache 键的 Map 插入序——插入序是本地缓存顺序，与权威出生/招降序无关，
      // 传给渲染/HUD 的 pawns 顺序会与 snapshot/对账漂移。
      this.pawns = this.snap.pawns.map((p) => p.eid);
    }
    if (m.hostiles) {
      this.hostiles = m.hostiles;
      this.snap.hostiles = m.hostiles;
    }
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
    if (m.buildingVersion !== undefined) {
      this.world.buildingVersion = m.buildingVersion;
      this.snap.buildingVersion = m.buildingVersion;
    }
    // M2 收尾：delta 其余整体覆盖字段同步进 snap（buildings 按 key 对齐增量，
    // snap.buildings 与 world.buildings 同源维护——全量对账仍为最终收敛）
    if (m.buildings) {
      const snapB = new Map(this.snap.buildings.map((b) => [b.key, b]));
      for (const b of m.buildings) {
        if (b.removed) snapB.delete(b.key);
        else {
          // delta 建筑无 x/y（增量形状）——snap 是全量形状，用 key 解码补全（与
          // world.buildings 同源：World.keyToXY 是 key 编码的唯一解码器）
          const { x, y } = World.keyToXY(b.key);
          snapB.set(b.key, { key: b.key, defId: b.defId, x, y, hp: b.hp, maxHp: b.maxHp, faction: b.faction, footprint: b.footprint });
        }
      }
      this.snap.buildings = [...snapB.values()];
    }
    if (m.buildQueue) this.snap.buildQueue = m.buildQueue;
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
      drafted: p.drafted === true, // 归一 boolean（协议缺省 = 未征召）
      // 战场指挥 DLC（field-command 包 2026-08-20）：编制树/生效战术回显（协议透传字段直通）
      commander: p.commander,
      tactic: p.tactic,
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
