// RemoteSim —— 连 P1 server 的客户端视图（DESIGN §5：权威在 server）
// 实现与本地 Sim 同构的读取面，HUD/Renderer 无需区分本地/远程。
// 用法：?remote=ws://127.0.0.1:8080
import { EventBus, type GameEvent } from '../sim/core/events';
import type { BehaviorCard } from '../sim/ai/pawn';
import type { TileDef, BuildingDef, ItemDef } from '../sim/defs';
import type { EnvTuning } from '../sim/defs/tuning';
import type { Command } from '../sim/sim';
import type { ServerMsg, WelcomeMsg, SnapshotMsg } from '../shared/protocol';

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
  lastDecision?: { drawn: string[]; picked: string; time: number };
}

export interface SimViewUnit {
  id: string; name: string; level: 'campfire' | 'church'; members: number[];
  resources: Record<string, number>; memory: { text: string }[];
  opinions: Map<string, { value: number }>; createdAt: number;
}

export interface SimViewBuilding { def: BuildingDef; defId: string; hp: number; maxHp: number; faction: string }

export interface SimView {
  stockpile: Record<string, number>;
  hostiles: SimViewHostile[];
  paused: boolean; speed: number; time: number; dayLength: number; tickHz: number;
  env: { raining: boolean; temperature: number; rainLeft: number };
  tuning: { env?: EnvTuning };
  isNight(): boolean;
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
  buildQueueItems: { x: number; y: number; defId: string }[];
  events: { time: number; text: string }[];
  historyRecent: { id: number; time: number; day: number; type: string; eid?: number; x?: number; y?: number; cause?: string; data?: Record<string, unknown> }[];
  socialUnits: { units: Map<string, SimViewUnit> };
  playerUnitId: string | null;
  unitAt(x: number, y: number): SimViewUnit | null;
  buildingAt(x: number, y: number): SimViewBuilding | null;
  buildingDef(id: string): BuildingDef | undefined;
  issueCommand(cmd: Command): void;
  step(dt: number): void;
}

// ---- 世界视图（只读；tile 增量由 event 更新） ----
class RemoteWorld {
  width = 192;
  height = 192;
  private grid: string[] = [];
  buildings = new Map<number, SnapBuilding>();
  buildingVersion = 0;
  private defs: Record<string, BuildingDef>;

  constructor(defs: Record<string, BuildingDef>) {
    this.defs = defs;
  }

  setWorld(w: WelcomeMsg['world'], grid: string[]): void {
    this.width = w.width;
    this.height = w.height;
    this.grid = grid;
  }

  getTile(x: number, y: number): string {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 'water';
    return this.grid[y * this.width + x] ?? 'grass';
  }

  setTile(x: number, y: number, id: string): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.grid[y * this.width + x] = id;
  }

  buildKey(x: number, y: number): number { return y * this.width + x; }

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
      this.buildings.set(this.buildKey(b.x, b.y), {
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
  dayLength = 120;
  tickHz = 20;

  time = 0;
  paused = false;
  speed = 1;
  day = 1;
  env = { raining: false, temperature: 18, rainLeft: 0 };
  tuning = { env: undefined } as { env?: EnvTuning };
  stockpile: Record<string, number> = {};
  hostiles: SnapshotMsg['hostiles'] = [];
  pawns: number[] = [];
  pawnPositions = new Map<number, { x: number; y: number }>();
  events: { time: number; text: string }[] = [];
  historyRecent: { id: number; time: number; day: number; type: string; eid?: number; x?: number; y?: number; cause?: string; data?: Record<string, unknown> }[] = [];
  socialUnits = { units: new Map<string, SimViewUnit>() };
  playerUnitId: null = null;

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

  constructor(private url: string) {
    this.bus = new EventBus();
    this.mods = { tiles: {}, buildings: {}, items: {}, cards: {} };
    this.world = new RemoteWorld(this.mods.buildings);
    // 远端命令入口：type 直接透传给 server（server 端权威校验）
    this.issueCommand = (cmd: Command) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'cmd', cmd }));
    };
  }

  // 连接并等 welcome（世界底 + defs 只读表）。失败 reject（超时/断开）
  connect(): Promise<RemoteSim> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => console.log(`[remote] 已连接 ${this.url}`);
      ws.onerror = () => reject(new Error(`remote: 连接失败 ${this.url}`));
      ws.onclose = () => { this.hint('⚠ 与服务器断开'); };
      ws.onmessage = (e) => {
        try { this.onMessage(String(e.data)); } catch (err) { console.error('[remote] 消息解析失败', err); }
      };
      this.resolveConnected = () => { resolve(this); this.resolveConnected = null; };
      setTimeout(() => {
        if (!this.snap && !this.world.buildingVersion) reject(new Error(`remote: welcome 超时 ${this.url}`));
      }, 6000);
    });
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
    if (m.type === 'welcome') {
      this.tickHz = m.tickHz;
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
        this.mods.items[id] = { id, name: d.name, stackable: true, maxStack: 99 };
      }
      this.resolveConnected?.();
    } else if (m.type === 'snapshot') {
      this.applySnapshot(m);
    } else if (m.type === 'event') {
      for (const ev of m.events) {
        if (ev.kind === 'tileChanged' && ev.x !== undefined && ev.y !== undefined && ev.tileId) {
          this.world.setTile(ev.x, ev.y, ev.tileId);
        } else if (ev.kind === 'resourceGained' && ev.eid !== undefined) {
          const g: GameEvent = { type: 'resource_gained', eid: ev.eid, item: ev.item ?? '', amount: ev.amount ?? 0 };
          this.bus.emit(g);
        } else if (ev.kind === 'feed' && ev.text) {
          this.events.push({ time: m.t, text: ev.text });
          if (this.events.length > 30) this.events.splice(0, this.events.length - 30);
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

  isNight(): boolean { return this.snap?.isNight ?? false; }

  get buildCount(): number { return this.snap?.buildQueue.length ?? 0; }
  get buildQueueItems(): { x: number; y: number; defId: string }[] { return this.snap?.buildQueue ?? []; }
  get selectedIds(): number[] { return this.selected; }

  healthOf(eid: number): { hp: number; maxHp: number } | null {
    const p = this.pawnCache.get(eid);
    return p ? { hp: p.hp, maxHp: p.maxHp } : null;
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
    };
  }

  buildingAt(x: number, y: number): { defId: string; def: BuildingDef; hp: number; maxHp: number; faction: string } | null {
    const b = this.world.buildingAt(x, y);
    if (!b) return null;
    return { defId: b.defId, def: this.buildingDef(b.defId) ?? fallbackDef(b.defId), hp: b.hp, maxHp: b.maxHp, faction: b.faction };
  }

  buildingDef(id: string): BuildingDef | undefined { return this.mods.buildings[id]; }

  unitAt(): null { return null; }

  issueCommand: (cmd: Command) => void = () => {};

  // ---- 本地单机专属操作：远程模式无意义，no-op ----
  step(): void {}
  save(): string { return ''; }
  load(): void {}
  respawnPawns(): void {}
  ensureCamp(): void {}
}

function fallbackDef(id: string): BuildingDef {
  return { id, name: id, size: { x: 1, y: 1 }, hp: 50, color: '#888', passable: true, buildTime: 3 };
}
