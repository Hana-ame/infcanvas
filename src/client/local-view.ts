/**
 * client/local-view.ts —— 本地模式视图适配器：直接包 Sim 实现 WorldView。
 * （联机模式对应物是 remote.ts 的 RemoteSim——两者对渲染/HUD 长同一张脸。）
 */
import type { TileInspect, ChunkTerrain, WorldView } from './view';
import { CARD_LABEL, TERRAIN_NAME } from './presentation';
import { buildBuildingDetail, buildColonySummary, buildHostileDetail, buildPawnDetail } from './hud-faces';
import { K_TAG_FIRE } from '../mods/contracts';
import type { Sim } from '../sim';
import type { Tuning } from '../sim/tuning';
import type { BuildingState, FeatureHit, Hostile, LogEvent, PawnState } from '../sim/types';
import { CHUNK_SIZE, chunkBounds, chunkKeyToXY, tileChunkKey } from '../shared/chunks';

export class LocalView implements WorldView {
  constructor(private sim: Sim) {}
  get time(): number {
    return this.sim.time;
  }
  get stockpile(): Record<string, number> {
    return this.sim.stockpile;
  }
  events(): LogEvent[] {
    return this.sim.events.slice(-8);
  }
  pawns(): Iterable<PawnState> {
    return this.sim.pawns();
  }
  hostiles() {
    return this.sim.hostiles();
  }
  buildings(): BuildingState[] {
    return [...this.sim.world.buildings.values()];
  }
  get tuning(): Tuning {
    return this.sim.tuning;
  }
  zAt(x: number, y: number): number {
    return this.sim.zAt(x, y);
  }
  buildingsAll(): Iterable<BuildingState> {
    return this.buildings();
  }
  buildingDef(defId: string) {
    return this.sim.tuning.buildings[defId];
  }
  traitName(trait: string): string {
    return this.sim.tuning.traits[trait]?.name ?? trait;
  }
  tileAt(x: number, y: number): string {
    return this.sim.world.tileAt(x, y);
  }
  featureAt(x: number, y: number) {
    return this.sim.world.featureAt(x, y);
  }
  cardLabel(id: string | null | undefined): string {
    return CARD_LABEL[id ?? ''] ?? '';
  }
  techProgress(): import('./view').TechProgressRow[] {
    // 本地模式：直接读 Sim 的科技状态 + tuning 科技表，按 TECH_ORDER（抽卡顺序）排列
    const order = this.sim.reg.techOrder();
    return order.map((id) => {
      const def = this.sim.tuning.techs[id];
      return {
        id,
        name: def?.name ?? id,
        have: this.sim.techFragments[id] ?? 0,
        need: def?.fragments ?? 1,
        unlocked: this.sim.techUnlocked().has(id), // 只走公开访问器（techsUnlocked 是 private）
      };
    });
  }

  /** 单格悬停信息：地形/通行/特征（锚点才有）/建筑，一次拼好给 HUD */
  inspect(x: number, y: number): TileInspect {
    const w = this.sim.world;
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
      buildingName: b ? this.sim.tuning.buildings[b.defId]?.name ?? b.defId : null,
    };
  }

  // ---- HUD 汇总面 / 详情面（R3-HUD）：算法在 hud-faces.ts，这里只提供本地取数 ----
  /**
   * 最近火堆距离（本地：直接问 World）。扫描半径封顶 999 格——
   * HUD 只用它显示"取暖中/在外过夜"，超出这个量级再精确也没有信息价值。
   */
  private fireDist(x: number, y: number): number | null {
    const f = this.sim.world.nearestBuildingByTag(K_TAG_FIRE, x, y, 999);
    return f ? Math.hypot(f.pos.x - x, f.pos.y - y) : null;
  }

  colony(): import('./view').ColonySummary {
    return buildColonySummary({
      pawns: this.sim.pawns(),
      buildings: [...this.sim.world.buildings.values()],
      hostiles: this.sim.hostiles(),
      tuning: this.sim.tuning,
      traitName: (t) => this.traitName(t),
      nearestFireDist: (x, y) => this.fireDist(x, y),
      raidPressureRaw: this.sim.scratch['raid.pressure'] ?? null,
    });
  }

  inspectPawn(eid: number): import('./view').PawnDetail | null {
    const p = this.sim.pawnMap.get(eid);
    if (!p) return null;
    return buildPawnDetail(p, (t) => this.traitName(t), (x, y) => this.fireDist(x, y));
  }

  inspectBuilding(id: string): import('./view').BuildingDetail | null {
    const b = this.sim.world.buildings.get(id);
    if (!b) return null;
    return buildBuildingDetail(b, [...this.sim.world.buildings.values()], this.sim.tuning);
  }

  inspectHostile(id: number): import('./view').HostileDetail | null {
    const h = this.sim.hostiles().find((x) => x.id === id);
    if (!h) return null;
    return buildHostileDetail(h, this.sim.hostiles(), this.sim.pawns(), this.sim.tuning);
  }

  // ---- 区块协议面（渲染按块）----
  // 本地模式：块内数据全在 World 里，直接推导。地形是纯函数，所以整块可以一次取完
  // 让渲染层烘焙缓存；建筑走 chunk-1 拆出的区块索引（World 已有门面）。

  terrainChunk(cx: number, cy: number): ChunkTerrain {
    const size = CHUNK_SIZE;
    const w = this.sim.world;
    const x0 = cx * size;
    const y0 = cy * size;
    const kinds: string[] = new Array(size * size);
    const zs: number[] = new Array(size * size);
    for (let ly = 0; ly < size; ly++) {
      const y = y0 + ly;
      const row = ly * size;
      for (let lx = 0; lx < size; lx++) {
        const i = row + lx;
        const x = x0 + lx;
        kinds[i] = w.tileAt(x, y);
        zs[i] = w.zAt(x, y);
      }
    }
    return { cx, cy, size, kinds, zs };
  }

  /** 走 chunk-1 拆出的区块索引（真源表 → 派生视图），不自扫建筑表 */
  buildingsInChunks(keys: Iterable<number>): BuildingState[] {
    return [...this.sim.world.buildingsInChunks(keys)];
  }

  hostilesInChunks(keys: Iterable<number>): Hostile[] {
    const wanted = new Set(keys);
    return this.sim.hostiles().filter((h) => wanted.has(tileChunkKey(h.pos.x, h.pos.y).key));
  }

  /**
   * 一批区块内的特征锚点。
   * ⚠ 这是**全块枚举**（每块 4096 格），不是增量索引——特征锚点是哈希推导的，
   * 不存在"只登记被采过的"这种真源表。因此本面**不可每帧调用**：
   * 渲染层要缓存时须配特征版本号（采收/再生驱动），那是下一阶段的事（见 DESIGN.md）。
   */
  featuresInChunks(keys: Iterable<number>): Map<string, FeatureHit> {
    const out = new Map<string, FeatureHit>();
    const w = this.sim.world;
    for (const key of keys) {
      const { cx, cy } = chunkKeyToXY(key);
      const b = chunkBounds(cx, cy);
      for (let y = b.y0; y <= b.y1; y++) {
        for (let x = b.x0; x <= b.x1; x++) {
          const f = w.featureAt(x, y);
          if (f) out.set(`${x},${y}`, f);
        }
      }
    }
    return out;
  }
}