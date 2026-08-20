// 世界（2026-08-21 从零重写）——地形 + 建筑 + 光照 + 视野查询
// 固定尺寸地图（从零阶段不做无限地图；简单直接，后续可扩展）
import type { Building, Pos, TileId } from './types';

export const MAP_W = 64;
export const MAP_H = 64;

// 简单确定性地形生成：同心环 = 外向扩的草甸，局部点缀树/矿/水
function genTile(x: number, y: number): TileId {
  const cx = MAP_W / 2, cy = MAP_H / 2;
  const r = Math.hypot(x - cx, y - cy);
  // 伪随机（确定性，避免依赖外部 rng）
  const h = (x * 73856093 ^ y * 19349663) >>> 0;
  const rand = (h % 1000) / 1000;
  if (r > 26) return 'water';               // 外环水（边界）
  if (rand < 0.06) return 'tree';            // 6% 树
  if (rand < 0.08) return 'ore';             // 2% 矿
  if (rand < 0.1) return 'stone';            // 2% 石
  return 'grass';
}

const TILE_PASS: Record<TileId, boolean> = { grass: true, tree: true, ore: true, stone: true, water: false };

export class World {
  tiles: TileId[][] = [];
  buildings = new Map<string, Building>();  // key = `${x},${y}`
  spawn = { x: MAP_W / 2 | 0, y: MAP_H / 2 | 0 }; // 营地中心

  constructor() {
    for (let y = 0; y < MAP_H; y++) {
      const row: TileId[] = [];
      for (let x = 0; x < MAP_W; x++) row.push(genTile(x, y));
      this.tiles.push(row);
    }
  }

  tile(x: number, y: number): TileId {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return 'water';
    return this.tiles[y]![x]!;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
  }

  passable(x: number, y: number): boolean {
    return TILE_PASS[this.tile(x, y)] && !this.buildingAt(x, y);
  }

  buildingAt(x: number, y: number): Building | undefined {
    return this.buildings.get(`${x},${y}`);
  }

  addBuilding(defId: string, x: number, y: number): Building | null {
    if (!this.inBounds(x, y) || !TILE_PASS[this.tile(x, y)]) return null;
    if (this.buildingAt(x, y)) return null;
    const b: Building = { id: `${x},${y}`, defId, x, y, hp: 100 };
    this.buildings.set(b.id, b);
    return b;
  }

  damageBuilding(x: number, y: number, dmg: number): boolean {
    const b = this.buildingAt(x, y);
    if (!b) return false;
    b.hp -= dmg;
    if (b.hp <= 0) { this.buildings.delete(b.id); return true; }
    return false;
  }

  // 最近的目标格（找食物/木材/营地）
  nearestOf(kind: 'tree' | 'ore' | 'campfire', fromX: number, fromY: number, radius = 20): Pos | null {
    let best: Pos | null = null;
    let bestD = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = fromX + dx, y = fromY + dy;
        if (!this.inBounds(x, y)) continue;
        let hit = false;
        if (kind === 'tree' && this.tile(x, y) === 'tree') hit = true;
        else if (kind === 'ore' && this.tile(x, y) === 'ore') hit = true;
        else if (kind === 'campfire') {
          const b = this.buildingAt(x, y);
          if (b && b.defId === 'campfire') hit = true;
        }
        if (!hit) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = { x, y }; }
      }
    }
    return best;
  }
}