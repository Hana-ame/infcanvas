/**
 * client/local-view.ts —— 本地模式视图适配器：直接包 Sim 实现 WorldView。
 * （联机模式对应物是 remote.ts 的 RemoteSim——两者对渲染/HUD 长同一张脸。）
 */
import { CARD_LABEL, TERRAIN_NAME, type TileInspect, type WorldView } from './view';
import type { Sim } from '../sim';
import type { Tuning } from '../sim/tuning';
import type { BuildingState, LogEvent, PawnState } from '../sim/types';

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
}
