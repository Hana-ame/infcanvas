// 建筑缓存共享工具（2026-08-20 架构优化：减少耦合）
// 多个系统（san/needs/repair/raid）各自维护建筑列表缓存，代码重复。
// 本模块提供统一的按 tag 缓存 + 最近匹配查询，一处实现多处复用。
import type { SimContext } from './context';
import { World } from '../core/world';

export interface CachedBuilding {
  key: number;
  x: number;
  y: number;
  defId: string;
  hp: number;
  maxHp: number;
  faction: string;
  def: { tags?: string[]; aura?: { radius?: number; moodPerSec?: number; restPerSec?: number; sanPerSec?: number }; meta?: Record<string, unknown> };
}

// 按 tag 缓存建筑列表（每 tick 构建，同 crowdGrid/buildCrowdGrid 策略）
export function buildTagIndex(ctx: SimContext): Map<string, CachedBuilding[]> {
  const idx = new Map<string, CachedBuilding[]>();
  for (const [key, b] of ctx.world.buildings) {
    const { x, y } = World.keyToXY(key);
    const cached: CachedBuilding = {
      key, x, y, defId: b.def.id, hp: b.hp, maxHp: b.def.hp, faction: b.faction,
      def: { tags: b.def.tags, aura: b.def.aura, meta: b.def.meta },
    };
    if (!b.def.tags) continue;
    for (const tag of b.def.tags) {
      let bucket = idx.get(tag);
      if (!bucket) { bucket = []; idx.set(tag, bucket); }
      bucket.push(cached);
    }
  }
  return idx;
}

// 从 tag 缓存查最近命中（O(命中数)，通常 < 20）
export function findNearestTagged(
  pos: { x: number; y: number },
  candidates: CachedBuilding[] | undefined,
  maxDist: number,
): CachedBuilding | null {
  if (!candidates || candidates.length === 0) return null;
  let best: CachedBuilding | null = null;
  let bestD = maxDist * maxDist;
  for (const c of candidates) {
    const d = (c.x - pos.x) ** 2 + (c.y - pos.y) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// 检查范围内是否有某 tag 建筑（布尔，短路）
export function hasTaggedInRange(
  pos: { x: number; y: number },
  candidates: CachedBuilding[] | undefined,
  range: number,
): boolean {
  if (!candidates) return false;
  const r2 = range * range;
  for (const c of candidates) {
    if ((c.x - pos.x) ** 2 + (c.y - pos.y) ** 2 <= r2) return true;
  }
  return false;
}

// 获取范围内所有某 tag 建筑（用于 aura 效果等）
export function getTaggedInRange(
  pos: { x: number; y: number },
  candidates: CachedBuilding[] | undefined,
  range: number,
): CachedBuilding[] {
  if (!candidates) return [];
  const r2 = range * range;
  const out: CachedBuilding[] = [];
  for (const c of candidates) {
    if ((c.x - pos.x) ** 2 + (c.y - pos.y) ** 2 <= r2) out.push(c);
  }
  return out;
}