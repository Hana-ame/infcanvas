// Pixi 渲染器 —— Emoji 图标: 地形/建筑/小人 + 相机
import { Application, Container, Graphics, Rectangle, Text, TextStyle } from 'pixi.js';
import { Sim } from '../sim/sim';
import { TILES, BUILDINGS, ITEM_EMOJI } from '../sim/defs';

const TILE = 32;

const terrainStyle = (s: number): TextStyle => new TextStyle({
  fontSize: s,
  fontFamily: 'system-ui, "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
});

export class Renderer {
  app: Application;
  worldContainer: Container;
  sim: Sim;
  private terrainLayer: Container; // emoji 图标（树/矿/水）
  private buildingLayer: Container;
  private pawnLayer: Container;
  private pawnTexts = new Map<number, Text>();
  private pawnJobIcons = new Map<number, Text>();
  private hostileTexts = new Map<number, Text>();
  private camera = { x: 0, y: 0, zoom: 1 };
  private selected = new Set<number>();
  private lastBuildingVersion = -1;
  private tilesDrawn = false;
  private nightOverlay!: Graphics;

  constructor(sim: Sim) {
    this.sim = sim;
    this.app = new Application();
    this.worldContainer = new Container();
    this.terrainLayer = new Container();
    this.buildingLayer = new Container();
    this.pawnLayer = new Container();
    this.worldContainer.addChild(this.terrainLayer);
    this.worldContainer.addChild(this.buildingLayer);
    this.worldContainer.addChild(this.pawnLayer);
  }

  async init(container: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: window,
      background: '#1a1a2e',
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    container.appendChild(this.app.canvas);
    this.app.stage.addChild(this.worldContainer);

    const cx = this.sim.world.width / 2;
    const cy = this.sim.world.height / 2;
    this.camera.x = cx;
    this.camera.y = cy;

    this.app.ticker.add(() => this.render());
    this.drawTileGround();
    this.drawTerrainIcons();

    // 夜晚遮罩（屏幕层，覆盖整个世界）
    this.nightOverlay = new Graphics();
    this.nightOverlay.eventMode = 'none';
    this.app.stage.addChild(this.nightOverlay);
    this.nightOverlay.rect(0, 0, 1000, 1000);
    this.nightOverlay.fill(0x0a1030);
    this.nightOverlay.alpha = 0;
    this.nightOverlay.zIndex = 999;
    this.app.stage.sortableChildren = true;
  }

  // 地表色块（一次绘制，固定）
  private drawTileGround(): void {
    const g = new Graphics();
    const w = this.sim.world;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        const def = TILES[w.getTile(x, y)];
        g.rect(x * TILE, y * TILE, TILE, TILE);
        g.fill(def.color);
      }
    }
    this.terrainLayer.addChildAt(g, 0);
  }

  // 地形图标（树/矿/水）—— 用 Text emoji
  private drawTerrainIcons(): void {
    const w = this.sim.world;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        const def = TILES[w.getTile(x, y)];
        if (!def.emoji) continue;
        const t = new Text({ text: def.emoji, style: terrainStyle(18) });
        t.resolution = this.app.renderer.resolution;
        t.anchor.set(0.5);
        t.position.set(x * TILE + TILE / 2, y * TILE + TILE / 2);
        this.terrainLayer.addChild(t);
      }
    }
  }

  private render(): void {
    const cam = this.camera;
    this.worldContainer.position.set(this.app.screen.width / 2, this.app.screen.height / 2);
    this.worldContainer.scale.set(cam.zoom);
    this.worldContainer.pivot.set(cam.x * TILE, cam.y * TILE);
    // 建筑变化时重绘（动态建造）
    const ver = this.sim.world.buildingVersion;
    if (ver !== this.lastBuildingVersion) {
      this.lastBuildingVersion = ver;
      this.drawRebuildings();
    }
    this.renderPawns();
    this.renderHostiles();
    // 夜晚遮罩跟随屏幕大小 + 夜色
    this.nightOverlay.clear();
    this.nightOverlay.rect(0, 0, this.app.screen.width, this.app.screen.height);
    this.nightOverlay.fill(0x0a1030);
    this.nightOverlay.alpha = this.sim.isNight() ? 0.45 : 0;
  }

  // 只重绘有变化的建筑层
  private drawRebuildings(): void {
    const w = this.sim.world;
    // 移除多余节点，重建建筑层（P0 数据量小，全量可行）
    this.buildingLayer.removeChildren();
    for (const [key, b] of w.buildings) {
      const x = key % w.width;
      const y = Math.floor(key / w.width);
      const bg = new Graphics();
      bg.rect(x * TILE, y * TILE, TILE, TILE);
      bg.fill(b.def.color);
      this.buildingLayer.addChild(bg);
      if (b.def.emoji) {
        const t = new Text({ text: b.def.emoji, style: terrainStyle(22) });
        t.resolution = this.app.renderer.resolution;
        t.anchor.set(0.5);
        t.position.set(x * TILE + TILE / 2, y * TILE + TILE / 2);
        this.buildingLayer.addChild(t);
      }
    }
  }

  private renderPawns(): void {
    const jobEmoji: Record<string, string> = {
      '伐木': '🪓', '采矿': '⛏️', '建造': '🧱', '闲逛': '', '': '',
    };
    for (const eid of this.sim.pawns) {
      let t = this.pawnTexts.get(eid);
      if (!t) {
        t = new Text({ text: '🐭', style: terrainStyle(24) });
        t.resolution = this.app.renderer.resolution;
        t.anchor.set(0.5);
        this.pawnLayer.addChild(t);
        this.pawnTexts.set(eid, t);
        t.eventMode = 'static';
        t.hitArea = new Rectangle(-14, -14, 28, 28);
        t.on('pointerdown', (e) => {
          e.stopPropagation();
          this.selectPawn(eid);
        });
      }
      const pos = this.sim.pawnPositions.get(eid);
      if (pos) {
        t.position.set(pos.x * TILE, pos.y * TILE);
        t.alpha = this.selected.has(eid) ? 1 : 0.9;
        t.scale.set(this.selected.has(eid) ? 1.15 : 1);
        // 受伤（血量低）变暗红色提示
        const hk = this.sim.healthOf(eid);
        if (hk && hk.hp / hk.maxHp < 0.4) {
          t.alpha = Math.max(0.35, hk.hp / hk.maxHp);
        }
        // 工作图标（显示在头顶）
        const job = this.sim.pawnJob(eid);
        const icon = jobEmoji[job] ?? '';
        let jt = this.pawnJobIcons.get(eid);
        if (icon) {
          if (!jt) {
            jt = new Text({ text: '', style: terrainStyle(12) });
            jt.resolution = this.app.renderer.resolution;
            jt.anchor.set(0.5, 1);
            this.pawnLayer.addChild(jt);
            this.pawnJobIcons.set(eid, jt);
          }
          jt.text = icon;
          jt.position.set(pos.x * TILE, pos.y * TILE - 14);
          jt.visible = true;
        } else if (jt) {
          jt.visible = false;
        }
      }
    }
  }

  // 渲染入侵者（红色敌对）
  private renderHostiles(): void {
    // 先隐藏多余的
    let idx = 0;
    for (const h of this.sim.hostiles) {
      let t = this.hostileTexts.get(idx);
      if (!t) {
        t = new Text({ text: '🐺', style: terrainStyle(24) });
        t.resolution = this.app.renderer.resolution;
        t.anchor.set(0.5);
        t.eventMode = 'none';
        this.pawnLayer.addChild(t);
        this.hostileTexts.set(idx, t);
      }
      t.visible = true;
      t.position.set(h.x * TILE, h.y * TILE);
      // 血量低变淡
      t.alpha = Math.max(0.4, h.hp / h.maxHp);
      idx++;
    }
    // 多余的隐藏
    for (let i = idx; i < this.hostileTexts.size; i++) {
      const t = this.hostileTexts.get(i);
      if (t) t.visible = false;
    }
  }

  selectPawn(eid: number): void {
    this.selected.clear();
    this.selected.add(eid);
    this.sim.selected = [eid];
  }

  // 点选最近的 pawn（半径内），返回是否选中
  selectNearest(sx: number, sy: number, radiusPix = 24): boolean {
    const world = this.screenToWorld(sx, sy);
    let best: { eid: number; d: number } | null = null;
    for (const eid of this.sim.pawns) {
      const pos = this.sim.pawnPositions.get(eid);
      if (!pos) continue;
      const d = Math.hypot(pos.x - world.x, pos.y - world.y);
      if (d * TILE <= radiusPix && (!best || d < best.d)) best = { eid, d };
    }
    if (best) {
      this.selectPawn(best.eid);
      return true;
    }
    this.selected.clear();
    this.sim.selected = [];
    return false;
  }

  setCamera(dx: number, dy: number): void {
    this.camera.x -= dx / (TILE * this.camera.zoom);
    this.camera.y -= dy / (TILE * this.camera.zoom);
  }

  zoomBy(factor: number): void {
    this.camera.zoom = Math.max(0.3, Math.min(4, this.camera.zoom * factor));
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const cam = this.camera;
    const wx = cam.x + (sx - this.app.screen.width / 2) / (TILE * cam.zoom);
    const wy = cam.y + (sy - this.app.screen.height / 2) / (TILE * cam.zoom);
    return { x: Math.floor(wx), y: Math.floor(wy) };
  }

  destroy(): void {
    this.app.destroy({ removeView: true }, { children: true });
  }
}