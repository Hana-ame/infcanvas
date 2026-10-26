/**
 * client/render.ts —— RimWorld 正交俯视渲染器主控：
 *  - 严格拦截右键拖动平移后的 contextmenu 事件，确保右键拖动/右键移动后绝不弹出菜单；
 *  - 支持左键按住拖拽连续铺设墙体/电缆蓝图与批量作业指令；
 *  - 树木占地 1×1，同时保留丰满大树冠贴图居中于 (ax + 0.5, ay + 0.5)；
 *  - 视口裁剪 + 百人同屏 LOD + 视野缓存 + 静态层脏标记 + 水平迷雾跨度合并。
 */
import { type Application, Container, Graphics } from 'pixi.js';
import type { BuildingState, Eid, Pos, Sim } from '../sim';
import { setSimCameraViewport } from '../sim/rimworld-ecology-butcher';
import { getPlayerFogSources, hasLineOfSight } from '../sim/power-fog-engine';
import { hasSlopeAt, isSolidMountainAt } from '../sim/rooms-power-fog';
import { RenderCache } from './render-cache';
import { drawBuildingsOnGraphics } from './render-buildings';
import { drawTwoByTwoTreeGraphic, redrawHostileGraphic, redrawPawnGraphic, type PawnSprite, } from './render-entities';
import { drawFogSpansOverlay, drawWorldResourcesAndCorpses, type MapOverlayMode, } from './render-overlays';
import { hideRimWorldFloatMenu } from './ui-float-menu';
import { eidsInRect } from './selection';
import type { WorldView } from './view';
export interface InputCallbacks {
  onSelect(eid: Eid | null): void;
  onSelectMany?(eids: Eid[]): void;
  onPickNonPawn?(pick: { buildingId: string | null; hostileId: number | null }): void;
  onMove(x: number, y: number): void;
  onUserPan?(): void;
  onCanvasLeftClick?(wx: number, wy: number): boolean;
  onCanvasRightClick?(screenX: number, screenY: number, wx: number, wy: number): boolean;
  isLineDragDesignatorActive?(): boolean;
  onCanvasDragLine?(cells: { x: number; y: number }[]): boolean;
}
export interface BlueprintPreviewState {
  kind: 'none' | 'build' | 'order' | 'raid_march';
  defId?: string;
  rot?: number;
  w?: number;
  h?: number;
  cells?: Array<{ x: number; y: number; valid: boolean }>;
}
interface VisualWalkState {
  x: number;
  y: number;
  stridePhase: number;
  moving: boolean;
}
export const MIN_ZOOM_TILE_PX = 18;
export const MAX_ZOOM_TILE_PX = 48;
function computeOrthogonalLineCells(p0: Pos, p1: Pos): Pos[] {
  const x0 = Math.round(p0.x);
  const y0 = Math.round(p0.y);
  const x1 = Math.round(p1.x);
  const y1 = Math.round(p1.y);
  const out: Pos[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  if (dx >= dy) {
    const stepX = x1 >= x0 ? 1 : -1;
    for (let x = x0; x !== x1 + stepX; x += stepX) out.push({ x, y: y0 });
    if (y1 !== y0) {
      const stepY = y1 >= y0 ? 1 : -1;
      for (let y = y0 + stepY; y !== y1 + stepY; y += stepY) out.push({ x: x1, y });
    }
  } else {
    const stepY = y1 >= y0 ? 1 : -1;
    for (let y = y0; y !== y1 + stepY; y += stepY) out.push({ x: x0, y });
    if (x1 !== x0) {
      const stepX = x1 >= x0 ? 1 : -1;
      for (let x = x0 + stepX; x !== x1 + stepX; x += stepX) out.push({ x, y: y1 });
    }
  }
  return out;
}
export class Renderer {
  readonly world = new Container();
  private gameContainer = new Container();
  private terrainLayer = new Container();
  private floorG = new Graphics();
  private overlayG = new Graphics();
  private entityLayer = new Container();
  private fogG = new Graphics();
  private previewG = new Graphics();
  private boxG = new Graphics();
  private pawnSprites = new Map<Eid, PawnSprite>();
  private visualWalk = new Map<Eid, VisualWalkState>();
  private hostileG = new Map<number, { root: Container; g: Graphics; key: string }>();
  private hostileWalk = new Map<number, { x: number; y: number }>();
  private treeG = new Map<string, Graphics>();
  private visibleTrees = new Set<string>();
  private lastTreeTilePx = 0;
  private lastSlopeBldKey = '';
  private lastVisCacheKey = '';
  private cachedVisSet: Set<string> | null = null;
  private lastFloorKey = '';
  private lastFogKey = '';
  private lastTreeScanKey = '';
  private renderCache: RenderCache;
  private lastFrameMs = 0;
  public smoothedFps = 60;
  public lastRenderCostMs = 0.5;
  public mapOverlayMode: MapOverlayMode = 'none';
  TILE = 28;
  cam: Pos = { x: 0, y: 0 };
  selected: ReadonlySet<Eid> = new Set();
  hoverTile: Pos | null = null;
  blueprintPreview: BlueprintPreviewState = { kind: 'none' };
  constructor(
    private app: Application,
    private view: WorldView,
    private input: InputCallbacks,
  ) {
    this.lastTreeTilePx = this.TILE;
    this.renderCache = new RenderCache(this.view, this.terrainLayer, {
      tilePx: this.TILE,
      maxZ: this.view.tuning?.world?.maxZ ?? 4,
      hasSlopeAt: (tx, ty) => {
        const s = this.getLocalSim();
        return s ? hasSlopeAt(s.world, tx, ty) : false;
      },
    });
    this.gameContainer.addChild(this.terrainLayer);
    this.gameContainer.addChild(this.floorG);
    this.gameContainer.addChild(this.overlayG);
    this.entityLayer.sortableChildren = true;
    this.gameContainer.addChild(this.entityLayer);
    this.gameContainer.addChild(this.fogG);
    this.gameContainer.addChild(this.previewG);
    this.gameContainer.addChild(this.boxG);
    this.world.addChild(this.gameContainer);
    app.stage.addChild(this.world);
    this.bindInput();
  }
  private getLocalSim(): Sim | null {
    // LocalView 的 sim 是 private 构造参数，类型层看不到；
    // 用结构化断言取出（仅本地模式存在，联机模式返回 null）。
    const lv = this.view as unknown as { sim?: Sim };
    return lv.sim ?? null;
  }
  clearAllTreeGraphics(): void {
    for (const sp of this.treeG.values()) {
      this.entityLayer.removeChild(sp);
      sp.clear();
      sp.destroy();
    }
    this.treeG.clear();
  }
  centerOn(x: number, y: number): void {
    this.cam.x = x;
    this.cam.y = y;
  }
  lerpCam(x: number, y: number, rate = 0.06): void {
    this.cam.x += (x - this.cam.x) * rate;
    this.cam.y += (y - this.cam.y) * rate;
  }
  screenToWorld(sx: number, sy: number): Pos {
    return this.toWorld(sx, sy);
  }
  viewRect(): { x: number; y: number; halfW: number; halfH: number } {
    const halfW = Math.ceil(appWidth() / 2 / this.TILE) + 2;
    const halfH = Math.ceil(appHeight() / 2 / this.TILE) + 2;
    return { x: this.cam.x, y: this.cam.y, halfW, halfH };
  }
  private toWorld(sx: number, sy: number): Pos {
    return {
      x: (sx - appWidth() / 2) / this.TILE + this.cam.x - 0.5,
      y: (sy - appHeight() / 2) / this.TILE + this.cam.y - 0.5,
    };
  }
  private drag:
    | { kind: 'pan'; sx: number; sy: number; cx: number; cy: number; button: number; moved: boolean }
    | { kind: 'box'; sx: number; sy: number }
    | { kind: 'line_designate'; sx: number; sy: number; startTile: Pos; endTile: Pos }
    | null = null;
  private spaceHeld = false;
  boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  boxHits: Eid[] = [];
  private eidsInBox(r: { x0: number; y0: number; x1: number; y1: number }): Eid[] {
    const minX = Math.min(r.x0, r.x1);
    const maxX = Math.max(r.x0, r.x1);
    const minY = Math.min(r.y0, r.y1);
    const maxY = Math.max(r.y0, r.y1);
    const a = this.toWorld(minX, minY);
    const b = this.toWorld(maxX, maxY);
    return eidsInRect({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }, this.view.pawns());
  }
  private pickNonPawn(wx: number, wy: number): void {
    let hostileId: number | null = null;
    let hBest = 0.95;
    for (const h of this.view.hostiles()) {
      const d = Math.hypot(h.pos.x - wx, h.pos.y - wy);
      if (d <= hBest) {
        hBest = d;
        hostileId = h.id;
      }
    }
    if (hostileId !== null) {
      this.input.onPickNonPawn?.({ buildingId: null, hostileId });
      return;
    }
    let buildingId: string | null = null;
    let bBest = 0.65;
    for (const b of this.view.buildings()) {
      const { w, h } = this.footprintOfBuilding(b);
      const dx = Math.max(b.pos.x - wx, 0, wx - (b.pos.x + w - 1));
      const dy = Math.max(b.pos.y - wy, 0, wy - (b.pos.y + h - 1));
      const d = Math.hypot(dx, dy);
      if (d <= bBest) {
        bBest = d;
        buildingId = b.id;
      }
    }
    this.input.onPickNonPawn?.({ buildingId, hostileId: null });
  }
  private footprintOfBuilding(b: BuildingState): { w: number; h: number } {
    if (b.w !== undefined && b.h !== undefined) return { w: b.w, h: b.h };
    const def = this.view.buildingDef(b.defId);
    const bw = def?.w ?? 1;
    const bh = def?.h ?? 1;
    if (b.rot === 1 || b.rot === 3) return { w: bh, h: bw };
    return { w: bw, h: bh };
  }
  drawBox(g: Graphics): void {
    if (!this.boxRect) return;
    const a = this.toWorld(this.boxRect.x0, this.boxRect.y0);
    const b = this.toWorld(this.boxRect.x1, this.boxRect.y1);
    const x0 = Math.min(a.x, b.x) + 0.5;
    const y0 = Math.min(a.y, b.y) + 0.5;
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    g.rect(x0 * this.TILE, y0 * this.TILE, w * this.TILE, h * this.TILE)
      .fill({ color: 0xffd94a, alpha: 0.14 })
      .stroke({ width: 1.8, color: 0xffd94a, alpha: 0.85 });
  }
  private bindInput(): void {
    const c = this.app.canvas;
    const PAN_DRAG_PX = 5;
    let suppressNextContextMenu = false;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') this.spaceHeld = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceHeld = false;
    });
    c.addEventListener(
      'contextmenu',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true },
    );
    c.addEventListener('mousedown', (e) => {
      if (e.button === 1 || e.button === 2 || (e.button === 0 && (e.ctrlKey || this.spaceHeld))) {
        hideRimWorldFloatMenu();
        this.drag = {
          kind: 'pan',
          sx: e.clientX,
          sy: e.clientY,
          cx: this.cam.x,
          cy: this.cam.y,
          button: e.button,
          moved: false,
        };
        return;
      }
      if (e.button !== 0) return;
      const w = this.toWorld(e.clientX, e.clientY);
      if (this.input.isLineDragDesignatorActive?.()) {
        const tile = { x: Math.round(w.x), y: Math.round(w.y) };
        this.drag = {
          kind: 'line_designate',
          sx: e.clientX,
          sy: e.clientY,
          startTile: tile,
          endTile: tile,
        };
        return;
      }
      if (this.input.onCanvasLeftClick?.(w.x, w.y)) {
        return;
      }
      this.drag = { kind: 'box', sx: e.clientX, sy: e.clientY };
    });
    window.addEventListener('mousemove', (e) => {
      const rect = c.getBoundingClientRect();
      const hw = this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
      this.hoverTile = { x: Math.round(hw.x), y: Math.round(hw.y) };
      if (!this.drag) return;
      if (this.drag.kind === 'pan') {
        const dxPx = e.clientX - this.drag.sx;
        const dyPx = e.clientY - this.drag.sy;
        if (!this.drag.moved && Math.hypot(dxPx, dyPx) >= PAN_DRAG_PX) {
          this.drag.moved = true;
          hideRimWorldFloatMenu();
        }
        if (this.drag.moved) {
          this.cam.x = this.drag.cx - dxPx / this.TILE;
          this.cam.y = this.drag.cy - dyPx / this.TILE;
          this.input.onUserPan?.();
        }
        return;
      }
      if (this.drag.kind === 'line_designate') {
        this.drag.endTile = { x: Math.round(hw.x), y: Math.round(hw.y) };
        return;
      }
      const d = Math.hypot(e.clientX - this.drag.sx, e.clientY - this.drag.sy);
      if (d < 6 && !this.boxRect) return;
      this.boxRect = { x0: this.drag.sx, y0: this.drag.sy, x1: e.clientX, y1: e.clientY };
      this.boxHits = this.eidsInBox(this.boxRect);
    });
    window.addEventListener('mouseup', (e) => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (d.kind === 'pan') {
        if (d.button === 2) {
          if (d.moved) {
            suppressNextContextMenu = true;
            hideRimWorldFloatMenu();
            setTimeout(() => {
              suppressNextContextMenu = false;
            }, 120);
          } else if (!suppressNextContextMenu) {
            const w = this.toWorld(e.clientX, e.clientY);
            if (!this.input.onCanvasRightClick?.(e.clientX, e.clientY, w.x, w.y)) {
              this.input.onMove(Math.round(w.x), Math.round(w.y));
            }
          }
        }
        return;
      }
      if (d.kind === 'line_designate') {
        const cells = computeOrthogonalLineCells(d.startTile, d.endTile);
        if (cells.length <= 1) {
          const w = this.toWorld(e.clientX, e.clientY);
          this.input.onCanvasLeftClick?.(w.x, w.y);
        } else {
          this.input.onCanvasDragLine?.(cells);
        }
        return;
      }
      if (this.boxRect) {
        const hits = this.eidsInBox(this.boxRect);
        this.boxRect = null;
        this.boxHits = [];
        if (this.input.onSelectMany) this.input.onSelectMany(hits);
        else this.input.onSelect(hits[0] ?? null);
        return;
      }
      const w = this.toWorld(e.clientX, e.clientY);
      let best: Eid | null = null;
      let bestD = 0.78;
      for (const p of this.view.pawns()) {
        const vp = this.visualWalk.get(p.eid) ?? p.pos;
        const dist = Math.hypot(vp.x - w.x, vp.y - w.y);
        if (dist < bestD) {
          bestD = dist;
          best = p.eid;
        }
      }
      if (best !== null) {
        this.input.onSelect(best);
      } else {
        this.pickNonPawn(w.x, w.y);
      }
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.TILE = Math.max(MIN_ZOOM_TILE_PX, Math.min(MAX_ZOOM_TILE_PX, Math.round(this.TILE * factor)));
      },
      { passive: false },
    );
    const TOUCH_TAP_PX = 10;
    const LONG_PRESS_MS = 450;
    let touch: {
      id: number;
      sx: number;
      sy: number;
      cx: number;
      cy: number;
      moved: boolean;
      longFired: boolean;
      timer: ReturnType<typeof setTimeout>;
    } | null = null;
    c.addEventListener(
      'touchstart',
      (e) => {
        if (touch || e.changedTouches.length === 0) return;
        const t = e.changedTouches[0];
        if ((e.target as HTMLElement)?.closest?.('#joy, #rw-root')) return;
        e.preventDefault();
        const state = {
          id: t.identifier,
          sx: t.clientX,
          sy: t.clientY,
          cx: this.cam.x,
          cy: this.cam.y,
          moved: false,
          longFired: false,
          timer: setTimeout(() => {
            if (!touch || touch.moved) return;
            touch.longFired = true;
            const w = this.toWorld(touch.sx, touch.sy);
            this.input.onMove(Math.round(w.x), Math.round(w.y));
          }, LONG_PRESS_MS),
        };
        touch = state;
      },
      { passive: false },
    );
    c.addEventListener(
      'touchmove',
      (e) => {
        if (!touch) return;
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          if (t.identifier !== touch.id) continue;
          const dx = t.clientX - touch.sx;
          const dy = t.clientY - touch.sy;
          if (!touch.moved && Math.hypot(dx, dy) > TOUCH_TAP_PX) {
            touch.moved = true;
            clearTimeout(touch.timer);
          }
          if (touch.moved) {
            e.preventDefault();
            this.cam.x = touch.cx - dx / this.TILE;
            this.cam.y = touch.cy - dy / this.TILE;
            this.input.onUserPan?.();
          }
        }
      },
      { passive: false },
    );
    const endTouch = (e: TouchEvent) => {
      const t = touch; // 闭包内先取局部引用：touch 会被其他闭包改写，跨闭包赋值后 TS 不再保留外层窄化
      if (!t) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier !== t.id) continue;
        clearTimeout(t.timer);
        const wasTap = !t.moved && !t.longFired;
        const { sx, sy } = t;
        touch = null;
        if (wasTap) {
          const w = this.toWorld(sx, sy);
          let best: Eid | null = null;
          let bestD = 1.0;
          for (const p of this.view.pawns()) {
            const d = Math.hypot(p.pos.x - w.x, p.pos.y - w.y);
            if (d < bestD) {
              bestD = d;
              best = p.eid;
            }
          }
          this.input.onSelect(best);
        }
      }
    };
    c.addEventListener('touchend', endTouch);
    c.addEventListener('touchcancel', endTouch);
  }
  frame(nowMs?: number): void {
    const t0 = performance.now();
    const dtSec = this.lastFrameMs > 0 ? Math.min(0.1, (t0 - this.lastFrameMs) / 1000) : 0.016;
    if (this.lastFrameMs > 0) {
      const instFps = 1000 / Math.max(1, t0 - this.lastFrameMs);
      this.smoothedFps = this.smoothedFps * 0.9 + instFps * 0.1;
    }
    this.lastFrameMs = t0;
    const T = this.TILE;
    const sim = this.getLocalSim();
    if (sim) {
      const tagVer = String(sim.world.tagVersionNow());
      if (tagVer !== this.lastSlopeBldKey) {
        this.lastSlopeBldKey = tagVer;
        this.renderCache.clear();
      }
    }
    if (T !== this.lastTreeTilePx) {
      this.lastTreeTilePx = T;
      this.clearAllTreeGraphics();
      this.lastFloorKey = '';
      this.lastFogKey = '';
      this.lastTreeScanKey = '';
    }
    this.renderCache.setTilePx(T);
    const { x, y, halfW, halfH } = this.viewRect();
    const vx0 = Math.floor(x - halfW);
    const vx1 = Math.ceil(x + halfW);
    const vy0 = Math.floor(y - halfH);
    const vy1 = Math.ceil(y + halfH);
    if (sim) {
      setSimCameraViewport(sim, { x0: vx0, y0: vy0, x1: vx1, y1: vy1 });
    }
    this.renderCache.sync(vx0, vy0, vx1, vy1);
    const visSet = this.computeVisibleSet(vx0, vy0, vx1, vy1);
    const tagVer = sim ? sim.world.tagVersionNow() : 0;
    const floorKey = `${vx0},${vy0},${vx1},${vy1}|${T}|${tagVer}|${this.lastVisCacheKey}`;
    if (floorKey !== this.lastFloorKey) {
      this.lastFloorKey = floorKey;
      drawBuildingsOnGraphics(
        this.floorG,
        this.view.buildings(),
        visSet,
        T,
        (b) => this.footprintOfBuilding(b),
        sim ? (tx, ty) => isSolidMountainAt(sim.world, tx, ty) : undefined,
      );
    }
    drawWorldResourcesAndCorpses(
      this.overlayG,
      this.view,
      sim,
      vx0,
      vy0,
      vx1,
      vy1,
      visSet,
      T,
      this.selected,
      this.visualWalk,
      this.mapOverlayMode,
    );
    this.scanVisibleTrees(vx0, vy0, vx1, vy1, visSet, tagVer);
    this.syncEntities(nowMs, dtSec, visSet);
    const fogKey = `${vx0},${vy0},${vx1},${vy1}|${T}|${this.lastVisCacheKey}`;
    if (fogKey !== this.lastFogKey) {
      this.lastFogKey = fogKey;
      drawFogSpansOverlay(this.fogG, sim, visSet, vx0, vy0, vx1, vy1, T);
    }
    this.drawBlueprintPreview();
    this.boxG.clear();
    this.drawBox(this.boxG);
    this.world.position.set(
      appWidth() / 2 - (this.cam.x + 0.5) * T,
      appHeight() / 2 - (this.cam.y + 0.5) * T,
    );
    this.lastRenderCostMs = performance.now() - t0;
  }
  private computeVisibleSet(x0: number, y0: number, x1: number, y1: number): Set<string> | null {
    const sim = this.getLocalSim();
    if (!sim || !sim.playerRimWorldMode) return null;
    const sources = getPlayerFogSources(sim, sim.activePlayerId);
    const srcSig = sources.map((s) => `${s.x},${s.y},${s.radius}`).join(';');
    const cacheKey = `${sim.activePlayerId}|${x0},${y0},${x1},${y1}|${sim.world.tagVersionNow()}|${srcSig}`;
    if (cacheKey === this.lastVisCacheKey && this.cachedVisSet) {
      return this.cachedVisSet;
    }
    this.lastVisCacheKey = cacheKey;
    const vis = new Set<string>();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const isDeepMountain =
          isSolidMountainAt(sim.world, tx, ty) &&
          isSolidMountainAt(sim.world, tx + 1, ty) &&
          isSolidMountainAt(sim.world, tx - 1, ty) &&
          isSolidMountainAt(sim.world, tx, ty + 1) &&
          isSolidMountainAt(sim.world, tx, ty - 1);
        if (isDeepMountain) continue;
        for (const src of sources) {
          const d = Math.hypot(tx - src.x, ty - src.y);
          const elevBonus = src.sourceKind === 'great_bonfire' || src.sourceKind === 'electric_beacon_tower' ? 2 : 0;
          if (d <= src.radius && hasLineOfSight(sim.world, src.x, src.y, tx, ty, elevBonus)) {
            vis.add(`${tx},${ty}`);
            break;
          }
        }
      }
    }
    this.cachedVisSet = vis;
    return vis;
  }
  private drawBlueprintPreview(): void {
    const g = this.previewG;
    g.clear();
    const T = this.TILE;
    if (this.drag && this.drag.kind === 'line_designate') {
      const cells = computeOrthogonalLineCells(this.drag.startTile, this.drag.endTile);
      for (const c of cells) {
        g.rect(c.x * T + 1, c.y * T + 1, T - 2, T - 2)
          .fill({ color: 0x4cd964, alpha: 0.35 })
          .stroke({ width: 1.8, color: 0x7ef09d, alpha: 0.95 });
      }
      return;
    }
    if (!this.hoverTile) return;
    const hx = this.hoverTile.x;
    const hy = this.hoverTile.y;
    if (this.blueprintPreview.kind === 'build' && this.blueprintPreview.cells && this.blueprintPreview.cells.length > 0) {
      const w = this.blueprintPreview.w ?? 1;
      const h = this.blueprintPreview.h ?? 1;
      for (const c of this.blueprintPreview.cells) {
        const col = c.valid ? 0x4cd964 : 0xff4d4d;
        g.rect(c.x * T + 1, c.y * T + 1, T - 2, T - 2)
          .fill({ color: col, alpha: 0.32 })
          .stroke({ width: 1.5, color: col, alpha: 0.9 });
      }
      const allOk = this.blueprintPreview.cells.every((c) => c.valid);
      const bx = hx * T;
      const by = hy * T;
      const bw = w * T;
      const bh = h * T;
      g.rect(bx, by, bw, bh).stroke({ width: 2.4, color: allOk ? 0x7ef09d : 0xff6b6b });
      const rot = this.blueprintPreview.rot ?? 0;
      const cx = bx + bw / 2;
      const cy = by + bh / 2;
      const dx = rot === 1 ? 6 : rot === 3 ? -6 : 0;
      const dy = rot === 0 ? -6 : rot === 2 ? 6 : 0;
      g.circle(cx + dx, cy + dy, 3.5).fill(allOk ? '#ffffff' : '#ff9999');
      return;
    }
    g.rect(hx * T + 1, hy * T + 1, T - 2, T - 2).stroke({
      width: 1.4,
      color: this.blueprintPreview.kind === 'order' ? 0xf5d451 : 0xffffff,
      alpha: 0.55,
    });
  }
  private scanVisibleTrees(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    visSet: Set<string> | null,
    tagVer: number,
  ): void {
    const sim = this.getLocalSim();
    const scanKey = `${x0},${y0},${x1},${y1}|${tagVer}|${this.lastVisCacheKey}|${Math.floor((sim?.time ?? 0) / 2)}`;
    if (scanKey === this.lastTreeScanKey) return;
    this.lastTreeScanKey = scanKey;
    const next = new Set<string>();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (visSet && !visSet.has(`${tx},${ty}`)) continue;
        if (sim && sim.world.buildingAt(tx, ty)) continue;
        const f = this.view.featureAt(tx, ty);
        if (f?.kind === 'tree') next.add(`${tx},${ty}`);
      }
    }
    this.visibleTrees = next;
  }
  private syncEntities(nowMs: number | undefined, dtSec: number, visSet: Set<string> | null): void {
    const T = this.TILE;
    const sim = this.getLocalSim();
    const totalPawns = sim ? sim.pawnMap.size : 10;
    const compactLod = totalPawns >= 50;
    const vRect = this.viewRect();
    const minVx = vRect.x - vRect.halfW - 2;
    const maxVx = vRect.x + vRect.halfW + 2;
    const minVy = vRect.y - vRect.halfH - 2;
    const maxVy = vRect.y + vRect.halfH + 2;
    const seenPawns = new Set<Eid>();
    for (const p of this.view.pawns()) {
      const targetPos = this.view.renderPos?.(p.eid, nowMs) ?? p.pos;
      let vw = this.visualWalk.get(p.eid);
      if (!vw) {
        vw = { x: targetPos.x, y: targetPos.y, stridePhase: 0, moving: false };
        this.visualWalk.set(p.eid, vw);
      } else {
        const dx = targetPos.x - vw.x;
        const dy = targetPos.y - vw.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.004) {
          const stepRate = Math.min(1, dtSec * 8.5);
          vw.x += dx * stepRate;
          vw.y += dy * stepRate;
          vw.stridePhase = (vw.stridePhase + dist * 6.5) % (Math.PI * 2);
          vw.moving = true;
        } else {
          vw.x = targetPos.x;
          vw.y = targetPos.y;
          vw.moving = false;
        }
      }
      if (vw.x < minVx || vw.x > maxVx || vw.y < minVy || vw.y > maxVy) {
        const existingSp = this.pawnSprites.get(p.eid);
        if (existingSp) existingSp.root.visible = false;
        seenPawns.add(p.eid);
        continue;
      }
      const tileKey = `${Math.round(vw.x)},${Math.round(vw.y)}`;
      if (p.isStranger && visSet && !visSet.has(tileKey)) continue;
      seenPawns.add(p.eid);
      let sp = this.pawnSprites.get(p.eid);
      if (!sp) {
        sp = this.makePawn();
        this.pawnSprites.set(p.eid, sp);
        this.entityLayer.addChild(sp.root);
      }
      const bobY = vw.moving ? Math.sin(vw.stridePhase * 2) * (T * 0.055) : 0;
      sp.root.position.set((vw.x + 0.5) * T, (vw.y + 0.5) * T + bobY);
      sp.root.rotation = vw.moving ? Math.sin(vw.stridePhase) * 0.06 : 0;
      sp.root.zIndex = vw.y + 0.5;
      const wProgBucket = p.activeWork ? Math.round((p.activeWork.workProgress / Math.max(1, p.activeWork.workTotal)) * 10) : -1;
      const key = `${T}|${compactLod ? 1 : 0}|${Math.round(p.hp)}|${Math.round(p.needs.mood / 4)}|${p.cardId ?? ''}|${p.trait}|${p.xenotype ?? 'ratkin'}|${p.drafted ? 1 : 0}|${p.isStranger ? 1 : 0}|${p.formerColonist ? 1 : 0}|${this.selected.has(p.eid) ? 1 : 0}|${wProgBucket}|${p.inMeleeGrapple ? 1 : 0}`;
      if (sp.key !== key) {
        sp.key = key;
        redrawPawnGraphic(sp, p, this.selected.has(p.eid), T, compactLod);
      }
      sp.root.visible = true;
    }
    for (const [eid, sp] of this.pawnSprites) {
      if (!seenPawns.has(eid)) {
        this.entityLayer.removeChild(sp.root);
        sp.root.destroy();
        this.pawnSprites.delete(eid);
        this.visualWalk.delete(eid);
      }
    }
    const seenHostiles = new Set<number>();
    for (const h of this.view.hostiles()) {
      let hw = this.hostileWalk.get(h.id);
      if (!hw) {
        hw = { x: h.pos.x, y: h.pos.y };
        this.hostileWalk.set(h.id, hw);
      } else {
        const rate = Math.min(1, dtSec * 8.5);
        hw.x += (h.pos.x - hw.x) * rate;
        hw.y += (h.pos.y - hw.y) * rate;
      }
      if (visSet && !visSet.has(`${Math.round(hw.x)},${Math.round(hw.y)}`)) continue;
      seenHostiles.add(h.id);
      let entry = this.hostileG.get(h.id);
      if (!entry) {
        const root = new Container();
        const g = new Graphics();
        root.addChild(g);
        entry = { root, g, key: '' };
        this.hostileG.set(h.id, entry);
        this.entityLayer.addChild(root);
      }
      entry.root.position.set((hw.x + 0.5) * T, (hw.y + 0.5) * T);
      entry.root.zIndex = hw.y + 0.5;
      const hKey = `${T}|${h.kind}|${Math.round(h.hp)}/${h.maxHp}`;
      if (entry.key !== hKey) {
        entry.key = hKey;
        redrawHostileGraphic(entry.g, h, T);
      }
    }
    for (const [id, entry] of this.hostileG) {
      if (!seenHostiles.has(id)) {
        this.entityLayer.removeChild(entry.root);
        entry.root.destroy();
        this.hostileG.delete(id);
        this.hostileWalk.delete(id);
      }
    }
    const seenTree = new Set<string>();
    const treeOffset = sim?.world.rimWorldSingleOccupancy ? 0.5 : 1.0;
    for (const ak of this.visibleTrees) {
      seenTree.add(ak);
      const [ax, ay] = ak.split(',').map(Number);
      let g = this.treeG.get(ak);
      if (!g) {
        g = drawTwoByTwoTreeGraphic(T, ax * 31 + ay * 17);
        this.treeG.set(ak, g);
        this.entityLayer.addChild(g);
      }
      g.position.set((ax + treeOffset) * T, (ay + treeOffset) * T);
      g.zIndex = ay + 0.85;
    }
    for (const [ak, g] of this.treeG) {
      if (!seenTree.has(ak)) {
        this.entityLayer.removeChild(g);
        g.clear();
        g.destroy();
        this.treeG.delete(ak);
      }
    }
  }
  private makePawn(): PawnSprite {
    const root = new Container();
    const body = new Graphics();
    const bars = new Graphics();
    root.addChild(body, bars);
    return { root, body, bars, key: '' };
  }
}
function appWidth(): number {
  return globalThis.innerWidth ?? 1280;
}
function appHeight(): number {
  return globalThis.innerHeight ?? 720;
}
