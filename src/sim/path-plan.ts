/**
 * path-plan.ts —— 路径规划策略：航点缓存 + 双档迭代预算 + 有限范围 A* 分段导航。
 */
import { findPath, planRoute } from './pathfinding';
import type { BuildingState, Pos } from './types';
import { K_TAG_WAYPOINT } from '../mods/contracts';

export const LONG_DIST = 24;
export const SHORT_MAX_ITER = 1500;
export const LONG_MAX_ITER = 8000;
export const SEGMENT_MAX_ITER = 1500;

export interface AnchorSource {
  tagVersionNow(): number;
  buildingsByTag(tag: string): readonly BuildingState[];
}

export interface PlanInput {
  canStep(fx: number, fy: number, ax: number, ay: number): boolean;
  canStand(ax: number, ay: number): boolean;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

export class RoutePlanner {
  private readonly src: AnchorSource;
  private anchorList: Pos[] = [];
  private anchorVersion = -1;
  private routeCache = new Map<string, Pos[] | null>();

  constructor(src: AnchorSource) {
    this.src = src;
  }

  clearRoutes(): void {
    this.routeCache.clear();
  }

  anchors(): readonly Pos[] {
    const v = this.src.tagVersionNow();
    if (v !== this.anchorVersion) {
      const out: Pos[] = [];
      const seen = new Set<string>();
      for (const b of this.src.buildingsByTag('fire')) {
        const k = `${b.pos.x},${b.pos.y}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ x: b.pos.x, y: b.pos.y });
        }
      }
      for (const b of this.src.buildingsByTag(K_TAG_WAYPOINT)) {
        const k = `${b.pos.x},${b.pos.y}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ x: b.pos.x, y: b.pos.y });
        }
      }
      this.anchorList = out;
      this.anchorVersion = v;
    }
    return this.anchorList;
  }

  plan(inp: PlanInput): Pos[] {
    const { canStep, canStand, sx, sy, tx, ty } = inp;
    const anchors = this.anchors();
    const isLong = Math.abs(tx - sx) + Math.abs(ty - sy) > LONG_DIST;
    if (isLong && anchors.length > 0) {
      return planRoute(canStep, canStand, sx, sy, tx, ty, anchors, SEGMENT_MAX_ITER, SEGMENT_MAX_ITER, this.routeCache);
    }
    const maxIter = isLong ? LONG_MAX_ITER : SHORT_MAX_ITER;
    let path = findPath(canStep, canStand, sx, sy, tx, ty, maxIter);
    if (path.length === 0 && !(sx === tx && sy === ty)) {
      path = planRoute(canStep, canStand, sx, sy, tx, ty, anchors, maxIter, SEGMENT_MAX_ITER, this.routeCache, true);
    }
    return path;
  }
}
