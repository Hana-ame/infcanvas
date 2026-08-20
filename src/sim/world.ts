// 世界（2026-08-21 从零重写 v2）——无限地图 + 建筑
// 无限 = 不存 tile 数组，tileAt(x,y) 确定性哈希生成（视口按需渲染，永远不整表）。
// 营地中心 = (0,0)，附近 6 格保证平坦草地（出生/建造安全区）。

import type { Building, Pos, TileId } from './types';

const TILE_PASS: Record<TileId, boolean> = { grass: true, tree: true, ore: true, stone: true, water: false };

// 确定性 2D 哈希 → 0..1（同一坐标永远同值，跨帧稳定）
// 2026-08-21 修复：原实现用算术右移 >> 使值域只有 0..0.5 → 大陆度判定全进水
// → 改无符号右移 >>> 保证 0..2^32 均匀
function hash2(x: number, y: number): number {
  let h = (x * 73856093) ^ (y * 19349663);
  h = ((h >>> 13) ^ h) * 2654435761;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class World {
  /** 建筑（有限集：只存玩家建造物）key = `${x},${y}` */
  buildings = new Map<string, Building>();
  /** 营地中心（鼠的"家"） */
  spawn: Pos = { x: 0, y: 0 };

  /** 地形：确定性生成（出生区平坦 + 外圈渐水 → 群岛风格） */
  tileAt(x: number, y: number): TileId {
    const r = Math.hypot(x, y);
    if (r < 6) return 'grass'; // 出生区平坦
    // 大陆度：粗粒度噪声决定海洋/陆地（越远越可能水）
    const continent = hash2(Math.floor(x / 24), Math.floor(y / 24)) * 0.6 + hash2(Math.floor(x / 8), Math.floor(y / 8)) * 0.4;
    if (continent < 0.32 * (1 + r / 60)) return 'water';
    // 陆地点缀
    const d = hash2(x, y);
    if (d < 0.05) return 'tree';
    if (d < 0.065) return 'ore';
    if (d < 0.08) return 'stone';
    return 'grass';
  }

  passable(x: number, y: number): boolean {
    return TILE_PASS[this.tileAt(x, y)] && !this.buildingAt(x, y);
  }

  buildingAt(x: number, y: number): Building | undefined {
    return this.buildings.get(`${x},${y}`);
  }

  addBuilding(defId: string, x: number, y: number, hp: number): Building | null {
    if (!TILE_PASS[this.tileAt(x, y)]) return null;
    if (this.buildingAt(x, y)) return null;
    const b: Building = { id: `${x},${y}`, defId, x, y, hp };
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

  /** 最近的目标格（半径内扫描——无限世界无"全图扫描"） */
  nearestOf(kind: 'tree' | 'ore' | 'campfire', fromX: number, fromY: number, radius: number): Pos | null {
    let best: Pos | null = null;
    let bestD = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = fromX + dx, y = fromY + dy;
        let hit = false;
        if (kind === 'tree' && this.tileAt(x, y) === 'tree') hit = true;
        else if (kind === 'ore' && this.tileAt(x, y) === 'ore') hit = true;
        else if (kind === 'campfire') {
          const b = this.buildingAt(x, y);
          if (b && b.defId === 'campfire') hit = true;
        }
        if (!hit) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = { x, y }; }
      }
    }
    return best;
  }
}