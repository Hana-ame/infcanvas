// RemoteSim —— 连 P1 server 的客户端视图（DESIGN §5：权威在 server）
// 实现与本地 Sim 同构的读取面，HUD/Renderer 无需区分本地/远程。
// 用法：?remote=ws://127.0.0.1:8080
import type { BehaviorCard } from '../sim/ai/pawn';
import type { TileDef, BuildingDef, ItemDef } from '../sim/defs';
import type { EnvTuning } from '../sim/defs/tuning';
import type { WelcomeTuning, WelcomeMsg } from '../shared/protocol';
import type { FactionTuning } from '../sim/defs/tuning';
import type { Command } from '../sim/sim';
import type { SnapshotMsg } from '../shared/protocol';
import type { GameEvent } from '../sim/core/events';
import { World, MAX_TILE, type ChunkData } from '../sim/core/world';

// 协议快照里建筑形状
export interface SnapBuilding {
  defId: string; x: number; y: number; hp: number; maxHp: number; faction: string;
  footprint: { x: number; y: number }[];
  def?: BuildingDef;
}

// ---- HUD / Renderer 所需的 sim 公共读取面（本地 Sim 与 RemoteSim 都满足） ----
export interface SimViewHostile { i?: number; enemyId?: string; name?: string; x: number; y: number; hp: number; maxHp: number; faction?: string; taming?: { progress: number; tamer: number }; owner?: number; dashCd?: number }

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
  // RW-1（2026-08-15）：征召（协议透传自 server pawn.extra）。缺省 = 未征召——
  // HUD 征召按钮据此渲染（本地与远程共用同一 SimViewPawn 契约）。工作优先级 M1 已撤回。
  drafted?: boolean;
  // 战场指挥 DLC（field-command 包 2026-08-16）：编制树/生效战术回显（协议透传）。
  // 缺省 undefined = 非指挥官/无战术——HUD 指挥面板据此渲染（远程与本地同契约）。
  commander?: { role: 'officer' | 'general'; subordinates: number[] };
  tactic?: string;
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
export class RemoteWorld {
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
    // 无限地图边界（2026-08-16 审计 L2）：此前用 this.width/height 判界并把负坐标全拒——
    // 与 server/sim 的 ±MAX_TILE 防御边界不一致（welcome 的 width/height 只是初始区块，
    // 不是世界边界）→ 客户端 ghost 说"不可建"而 server 实际接受，UI 与权威漂移。
    // 对齐 sim.world.inBounds 同款语义：|坐标| ≤ MAX_TILE 即"坐标可访问"。
    if (Math.abs(x) > MAX_TILE || Math.abs(y) > MAX_TILE) return false;
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
