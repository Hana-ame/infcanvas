// Pixi 渲染器 —— SVG 图标: 地形/建筑/小人 + 相机
import { Application, Container, Graphics, Rectangle, Text, TextStyle } from 'pixi.js';
import { Sim } from '../sim/sim';
import { TILES, BUILDINGS } from '../sim/defs';
import { SvgAssets, type AssetId } from './svgLoader';

const TILE = 32;

export class Renderer {
  app: Application;
  worldContainer: Container;
  sim: Sim;
  private assets: SvgAssets;
  private terrainLayer: Container;
  private buildingLayer: Container;
  private pawnLayer: Container;
  private pawnSprites = new Map<number, Graphics>();
  private hostileSprites = new Map<number, Graphics>();
  private camera = { x: 0, y: 0, zoom: 1 };
  private selected = new Set<number>();
  private lastBuildingVersion = -1;
  private nightOverlay!: Graphics;
  // 建造幽灵预览
  private ghost: Graphics;
  private ghostPos: { x: number; y: number } | null = null;
  private ghostColor = 0x4cf;
  // 蓝图层（排队中的建造）
  private blueprintLayer: Graphics;
  private lastBuildQueueVersion = -1;
  // 飘字反馈（资源获得等）
  private floaters: { text: Text; life: number; vy: number }[] = [];

  constructor(sim: Sim, assets: SvgAssets) {
    this.sim = sim;
    this.assets = assets;
    this.app = new Application();
    this.worldContainer = new Container();
    this.terrainLayer = new Container();
    this.buildingLayer = new Container();
    this.pawnLayer = new Container();
    this.ghost = new Graphics();
    this.ghost.eventMode = 'none';
    this.blueprintLayer = new Graphics();
    this.blueprintLayer.eventMode = 'none';
    this.worldContainer.addChild(this.terrainLayer);
    this.worldContainer.addChild(this.blueprintLayer);
    this.worldContainer.addChild(this.buildingLayer);
    this.worldContainer.addChild(this.pawnLayer);
    this.worldContainer.addChild(this.ghost);
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

    this.app.ticker.add(() => this.render(this.app.ticker.deltaMS / 1000));
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

    // 订阅事件：资源获得飘字
    this.sim.bus.on('resource_gained', (ev) => {
      if (ev.type !== 'resource_gained') return;
      const pos = this.sim.pawnPositions.get(ev.eid) ?? { x: 0, y: 0 };
      this.spawnFloater(pos.x, pos.y, `+${ev.amount}`, ev.item === 'ore' ? '#ffd966' : '#aed581');
    });
  }

  // 生成飘字
  private spawnFloater(wx: number, wy: number, text: string, color: string): void {
    const t = new Text({ text, style: new TextStyle({ fontSize: 14, fill: color, fontFamily: 'system-ui' }) });
    t.resolution = this.app.renderer.resolution;
    t.anchor.set(0.5);
    t.position.set(wx * TILE, wy * TILE);
    this.pawnLayer.addChild(t);
    this.floaters.push({ text: t, life: 1.2, vy: -30 });
  }

  private updateFloaters(dt: number): void {
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      f.text.y += f.vy * dt;
      f.text.alpha = Math.max(0, f.life / 1.2);
      if (f.life <= 0) {
        this.pawnLayer.removeChild(f.text);
        this.floaters.splice(i, 1);
      }
    }
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

  // 用 SVG GraphicsContext 生成一个图标（定位到格中心）
  private makeIcon(id: AssetId, scale = 1): Graphics | null {
    const ctx = this.assets.get(id);
    if (!ctx) return null;
    const g = new Graphics(ctx);
    // SVG 是 32x32，缩放到 TILE
    g.scale.set(scale);
    g.pivot.set(16, 16);
    g.position.set(TILE / 2, TILE / 2);
    return g;
  }

  // 地形图标（树/矿/水）—— SVG
  private drawTerrainIcons(): void {
    const w = this.sim.world;
    const assetByTile: Record<string, AssetId> = {
      tree: 'terrain:tree',
      ore: 'terrain:ore',
      water: 'terrain:water',
      stone: 'terrain:stone',
    };
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        const tile = w.getTile(x, y);
        const aid = assetByTile[tile];
        if (!aid) continue;
        const g = this.makeIcon(aid);
        if (!g) continue;
        g.position.set(x * TILE + TILE / 2, y * TILE + TILE / 2);
        this.terrainLayer.addChild(g);
      }
    }
  }

  private render(dt = 0.016): void {
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
    // 蓝图变化时重绘
    const bq = this.sim.buildCount;
    if (bq !== this.lastBuildQueueVersion) {
      this.lastBuildQueueVersion = bq;
      this.drawBlueprints();
    }
    this.renderPawns();
    this.renderHostiles();
    this.renderGhost();
    this.updateFloaters(dt);
    // 夜晚遮罩跟随屏幕大小 + 夜色
    this.nightOverlay.clear();
    this.nightOverlay.rect(0, 0, this.app.screen.width, this.app.screen.height);
    this.nightOverlay.fill(0x0a1030);
    this.nightOverlay.alpha = this.sim.isNight() ? 0.45 : 0;
  }

  // 只重绘有变化的建筑层
  private drawRebuildings(): void {
    const w = this.sim.world;
    this.buildingLayer.removeChildren();
    for (const [key, b] of w.buildings) {
      const x = key % w.width;
      const y = Math.floor(key / w.width);
      const bg = new Graphics();
      bg.rect(x * TILE, y * TILE, TILE, TILE);
      // 受损建筑显示红色底色（破损提示）
      const dmg = b.hp / b.def.hp;
      bg.fill(dmg < 0.5 ? 0x7a2a2a : dmg < 1 ? 0x5a4a3a : b.def.color);
      this.buildingLayer.addChild(bg);
      const aid = `building:${b.def.id}` as AssetId;
      const icon = this.makeIcon(aid);
      if (icon) {
        icon.position.set(x * TILE + TILE / 2, y * TILE + TILE / 2);
        icon.alpha = dmg < 0.5 ? 0.6 : 1;
        this.buildingLayer.addChild(icon);
      }
    }
  }

  // 蓝图（排队中的建造）半透明显示
  private drawBlueprints(): void {
    this.blueprintLayer.clear();
    const w = this.sim.world;
    for (const b of this.sim.buildQueueItems) {
      const x = b.x * TILE;
      const y = b.y * TILE;
      this.blueprintLayer.rect(x + 1, y + 1, TILE - 2, TILE - 2);
      this.blueprintLayer.fill(0x4cf);
      this.blueprintLayer.alpha = 0.45;
    }
    void w;
  }

  private renderPawns(): void {
    for (const eid of this.sim.pawns) {
      let g = this.pawnSprites.get(eid);
      if (!g) {
        const icon = this.makeIcon(this.pawnAssetId(eid));
        if (!icon) continue;
        g = icon;
        this.pawnLayer.addChild(g);
        this.pawnSprites.set(eid, g);
        g.eventMode = 'static';
        g.hitArea = new Rectangle(-14, -14, 28, 28);
        g.on('pointerdown', (e) => {
          e.stopPropagation();
          this.selectPawn(eid);
        });
      }
      const pos = this.sim.pawnPositions.get(eid);
      if (pos) {
        g.position.set(pos.x * TILE + TILE / 2, pos.y * TILE + TILE / 2);
        const sel = this.selected.has(eid);
        g.scale.set((sel ? 1.15 : 1));
        // 受伤（血量低）变暗
        const hk = this.sim.healthOf(eid);
        g.alpha = sel ? 1 : 0.9;
        if (hk && hk.hp / hk.maxHp < 0.4) {
          g.alpha = Math.max(0.35, hk.hp / hk.maxHp);
        }
      }
    }
  }

  // 渲染入侵者（红色敌对）—— 用狼 SVG
  private renderHostiles(): void {
    let idx = 0;
    for (const h of this.sim.hostiles) {
      let g = this.hostileSprites.get(idx);
      if (!g) {
        const icon = this.makeIcon('pawn:strong', 0.9);
        if (!icon) continue;
        g = icon;
        g.eventMode = 'none';
        // 染红区分敌我
        g.tint = 0xff5555;
        this.pawnLayer.addChild(g);
        this.hostileSprites.set(idx, g);
      }
      g.visible = true;
      g.position.set(h.x * TILE + TILE / 2, h.y * TILE + TILE / 2);
      g.alpha = Math.max(0.4, h.hp / h.maxHp);
      idx++;
    }
    for (let i = idx; i < this.hostileSprites.size; i++) {
      const g = this.hostileSprites.get(i);
      if (g) g.visible = false;
    }
  }

  selectPawn(eid: number): void {
    this.selected.clear();
    this.selected.add(eid);
    this.sim.selected = [eid];
  }

  clearSelection(): void {
    this.selected.clear();
    this.sim.selected = [];
  }

  // 根据 DNA 天赋选不同的鼠 SVG
  private pawnAssetId(eid: number): AssetId {
    const p = this.sim.pawnProfile(eid);
    if (!p) return 'pawn:mouse';
    const t = p.dna.traits;
    if (t.includes('强壮')) return 'pawn:strong';
    if (t.includes('虔诚')) return 'pawn:devout';
    if (t.includes('懒惰')) return 'pawn:lazy';
    if (t.includes('热爱工作')) return 'pawn:workaholic';
    if (t.includes('夜猫子')) return 'pawn:owl';
    return 'pawn:mouse';
  }

  // 建造幽灵预览
  setGhost(worldTile: { x: number; y: number }, color?: number): void {
    this.ghostPos = worldTile;
    if (color) this.ghostColor = color;
  }

  clearGhost(): void {
    this.ghostPos = null;
    this.ghost.clear();
  }

  private renderGhost(): void {
    this.ghost.clear();
    if (!this.ghostPos) return;
    const gx = this.ghostPos.x * TILE;
    const gy = this.ghostPos.y * TILE;
    this.ghost.rect(gx, gy, TILE, TILE);
    this.ghost.fill(this.ghostColor);
    this.ghost.alpha = 0.4;
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