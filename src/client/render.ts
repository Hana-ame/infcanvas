// PixiJS 渲染器（2026-08-21 从零重写 v2）——无限世界视口渲染 + 拖动 + 缩放
// 无限 = 只画视口内瓦片（tileAt 确定性生成，无整表）；建筑/鼠/敌按世界坐标投影。
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Sim } from '../sim/sim';
import type { Pos } from '../sim/types';

export const TILE = 32; // 每格像素

export interface Camera { x: number; y: number; zoom: number }

// 地形颜色（无限世界确定性 → 渲染也确定性）
const TILE_COLOR: Record<string, number> = {
  grass: 0x3a5f2a, tree: 0x1f5a25, ore: 0x5a5a6a, water: 0x3a6a8a, stone: 0x8a8a7a,
};

export class Renderer {
  app: Application;
  cam: Camera = { x: 0, y: 0, zoom: 1 };
  private ground = new Container();   // 瓦片层（每帧重建视口矩形）
  private entityLayer = new Container();
  selBox = new Graphics();            // 框选 overlay
  moveMark = new Graphics();          // 移动目标标记
  private buildingSprites = new Map<string, Text>();
  private pawnSprites = new Map<number, Container>();
  private pawnRings = new Map<number, Graphics>();

  constructor(private sim: Sim, container: HTMLElement) {
    this.app = new Application();
    void this.app.init({ background: 0x0f1419, antialias: true, resizeTo: window });
    container.appendChild(this.app.canvas);
    this.app.stage.addChild(this.ground);
    this.app.stage.addChild(this.entityLayer);
    this.app.stage.addChild(this.selBox, this.moveMark);
  }

  destroy(): void { this.app.destroy(true, { children: true }); }

  screenToWorld(sx: number, sy: number): Pos {
    const { cam } = this;
    return {
      x: Math.floor(cam.x + (sx - this.app.screen.width / 2) / (TILE * cam.zoom)),
      y: Math.floor(cam.y + (sy - this.app.screen.height / 2) / (TILE * cam.zoom)),
    };
  }

  worldToScreen(x: number, y: number): Pos {
    const { cam } = this;
    return {
      x: (x + 0.5 - cam.x) * TILE * cam.zoom + this.app.screen.width / 2,
      y: (y + 0.5 - cam.y) * TILE * cam.zoom + this.app.screen.height / 2,
    };
  }

  /** 视口世界范围（整数格，含两端） */
  viewBounds(): { x0: number; y0: number; x1: number; y1: number } {
    const a = this.screenToWorld(0, 0), b = this.screenToWorld(this.app.screen.width, this.app.screen.height);
    return { x0: a.x, y0: a.y, x1: b.x + 1, y1: b.y + 1 };
  }

  zoomAt(sx: number, sy: number, f: number): void {
    const before = this.screenToWorld(sx, sy);
    this.cam.zoom = Math.max(0.3, Math.min(4, this.cam.zoom * f));
    const after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
  }

  pan(dxPx: number, dyPx: number): void {
    this.cam.x -= dxPx / (TILE * this.cam.zoom);
    this.cam.y -= dyPx / (TILE * this.cam.zoom);
  }

  // ---- 每帧 ----
  render(): void {
    // 地面（视口裁剪，无限安全）
    const g = new Graphics();
    const vb = this.viewBounds();
    const { cam } = this;
    const z = TILE * cam.zoom;
    for (let y = vb.y0; y <= vb.y1; y++) {
      for (let x = vb.x0; x <= vb.x1; x++) {
        const tile = this.sim.world.tileAt(x, y);
        const sx = (x - cam.x) * z + this.app.screen.width / 2;
        const sy = (y - cam.y) * z + this.app.screen.height / 2;
        g.rect(sx, sy, z + 0.5, z + 0.5);
        g.fill(TILE_COLOR[tile] ?? 0x333);
        if (tile === 'tree') {
          g.circle(sx + z / 2, sy + z / 2, z * 0.38);
          g.fill(0x2f7a35);
        }
      }
    }
    this.ground.removeChildren().forEach((c) => c.destroy());
    this.ground.addChild(g);

    // 建筑（Text emoji 缓存 + 增量更新）
    for (const [id, b] of this.sim.world.buildings) {
      let t = this.buildingSprites.get(id);
      if (!t) {
        t = new Text({ text: this.sim.reg.buildings.get(b.defId)?.emoji ?? '🧱', style: new TextStyle({ fontSize: TILE * 0.9 }) });
        t.anchor.set(0.5, 0.5);
        this.entityLayer.addChild(t);
        this.buildingSprites.set(id, t);
      }
      const s = this.worldToScreen(b.x, b.y);
      t.position.set(s.x, s.y);
      t.scale.set(cam.zoom);
    }
    for (const id of [...this.buildingSprites.keys()]) {
      if (!this.sim.world.buildings.has(id)) {
        this.buildingSprites.get(id)!.destroy();
        this.buildingSprites.delete(id);
      }
    }

    // 鼠鼠
    for (const [eid, p] of this.sim.pawns) {
      let c = this.pawnSprites.get(eid);
      if (!c) {
        c = new Container();
        const body = new Graphics();
        body.circle(0, 0, TILE * 0.28).fill(0xd8b28a);
        c.addChild(body);
        this.entityLayer.addChild(c);
        this.pawnSprites.set(eid, c);
      }
      const s = this.worldToScreen(p.pos.x, p.pos.y);
      c.position.set(s.x, s.y);
      c.scale.set(cam.zoom);
      // 选中环（按需增删）
      const sel = this.sim.selected.includes(eid);
      const ring = this.pawnRings.get(eid);
      if (sel && !ring) {
        const r = new Graphics();
        r.circle(0, 0, TILE * 0.4).stroke({ color: 0xf8d24a, width: 2 });
        c.addChild(r);
        this.pawnRings.set(eid, r);
      } else if (!sel && ring) {
        ring.destroy();
        c.removeChild(ring);
        this.pawnRings.delete(eid);
      }
    }
    for (const eid of [...this.pawnSprites.keys()]) {
      if (!this.sim.pawns.has(eid)) {
        this.pawnSprites.get(eid)!.destroy();
        this.pawnRings.delete(eid);
        this.pawnSprites.delete(eid);
      }
    }

    // 敌人
    for (const h of this.sim.hostiles) {
      const s = this.worldToScreen(h.x, h.y);
      g // noop 保持构造
    }
  }

  /** 框选矩形（屏幕坐标，null = 清除） */
  setSelBox(a: Pos, b: Pos): void {
    this.selBox.clear();
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
    this.selBox.rect(x, y, w, h).fill({ color: 0x4cf, alpha: 0.15 }).rect(x, y, w, h).stroke({ color: 0x4cf, width: 1.5 });
  }
  clearSelBox(): void { this.selBox.clear(); }
}