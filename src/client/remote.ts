/**
 * client/remote.ts —— 联机模式的客户端合入层（RemoteSim）。
 *
 * 职责：维护"服务端最新状态投影"，实现 WorldView 供渲染/HUD 零分支复用。
 * 地形：welcome 拿到 seed+tuning 后本地 new World 纯函数推导 tile（零流量）；
 * 特征余量/冷却由 full 快照 world 段 importState 同步。
 * 命令：sendCommand 上行 JSON，服务端白名单校验后走同一 issueCommand 入口。
 */
import { World } from '../sim/world';
import type { BuildingState, Eid, Hostile, LogEvent, PawnState } from '../sim/types';
import { DEFAULT_TUNING, type Tuning } from '../sim/tuning';
import { TERRAIN_NAME, type TileInspect, type WorldView } from './view';
import type { ClientMsg, ServerMsg } from '../shared/protocol';

export class RemoteSim implements WorldView {
  time = 0;
  stockpile: Record<string, number> = {};
  private pawnMap = new Map<Eid, PawnState>();
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

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        resolve();
      };
      ws.onerror = () => reject(new Error(`无法连接 ${url}`));
      ws.onclose = () => {
        this.connected = false;
      };
      ws.onmessage = (ev) => this.handle(JSON.parse(ev.data as string) as ServerMsg);
    });
  }

  private handle(msg: ServerMsg): void {
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
      this.time = d.time;
      this.stockpile = d.stockpile;
      for (const p of d.pawns) this.pawnMap.set(p.eid, p);
      for (const eid of d.removedPawns) this.pawnMap.delete(eid);
      this.hostileList = d.hostiles;
      this.buildingList = d.buildings;
      this.eventsList.push(...d.newEvents);
      // 客户端事件列表封顶：服务器环缓冲 200，但 delta 是增量追加——不封顶长局必泄漏
      if (this.eventsList.length > 400) this.eventsList = this.eventsList.slice(-200);
    }
  }

  private applyFull(d: import('../shared/protocol').FullState): void {
    this.time = d.time;
    this.stockpile = d.stockpile;
    this.pawnMap.clear();
    for (const p of d.pawns) this.pawnMap.set(p.eid, structuredClone(p));
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
  /** 测试钩子：绕过 WebSocket 直喂服务器消息（协议形状与真实链路同源）。 */
  handleForTest(msg: ServerMsg): void {
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