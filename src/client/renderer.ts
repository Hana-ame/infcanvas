// Pixi 渲染器 —— P0：地形 + 建筑 + 小人 + 相机
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { Sim } from '../sim/sim';
import { TILES, BUILDINGS } from '../sim/defs';

const TILE = 32; // 每格像素

export class Renderer {
  app: Application;
  worldContainer: Container;
  sim: Sim;
  private tileLayer: Graphics;
  private buildingLayer: Graphics;
  private pawnLayer: Container;
  private pawnSprites = new Map<number, Graphics>();
  private camera = { x: 0, y: 0, zoom: 1 };
  private selected = new Set<number>();

  constructor(sim: Sim) {
    this.sim = sim;
    this.app = new Application();
    this.worldContainer = new Container();
    this.tileLayer = new Graphics();
    this.buildingLayer = new Graphics();
    this.pawnLayer = new Container();
    this.worldContainer.addChild(this.tileLayer);
    this.worldContainer.addChild(this.buildingLayer);
    this.worldContainer.addChild(this.pawnLayer);
  }

  async init(container: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: window,
      background: '#1a1a2e',
      antialias: false,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    container.appendChild(this.app.canvas);
    this.app.stage.addChild(this.worldContainer);

    // 相机初始位置：出生点中心
    const cx = this.sim.world.width / 2;
    const cy = this.sim.world.height / 2;
    this.camera.x = cx;
    this.camera.y = cy;

    this.app.ticker.add(() => {
      this.render();
    });
  }

  // 渲染一帧：只重绘可见范围（性能简化：P0 全量地形一次绘制，小人在相机变换中移动）
  private render(): void {
    const cam = this.camera;
    // 世界容器变换
    this.worldContainer.position.set(this.app.screen.width / 2, this.app.screen.height / 2);
    this.worldContainer.scale.set(cam.zoom);
    this.worldContainer.pivot.set(cam.x * TILE, cam.y * TILE);

    this.renderPawns();
  }

  // 地形一次绘制（P0：世界小，全量画；后期改可见 chunk 增量）
  drawTiles(): void {
    const w = this.sim.world;
    this.tileLayer.clear();
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        const tile = w.getTile(x, y);
        const def = TILES[tile];
        this.tileLayer.rect(x * TILE, y * TILE, TILE, TILE);
        this.tileLayer.fill(def.color);
      }
    }
  }

  drawBuildings(): void {
    const w = this.sim.world;
    this.buildingLayer.clear();
    for (const [key, b] of w.buildings) {
      const x = key % w.width;
      const y = Math.floor(key / w.width);
      this.buildingLayer.rect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2);
      this.buildingLayer.fill(b.def.color);
    }
  }

  private renderPawns(): void {
    // 简化：P0 每个 pawn 一个 Graphics，位置跟随 sim
    for (const eid of this.sim.pawns) {
      let g = this.pawnSprites.get(eid);
      if (!g) {
        g = new Graphics();
        g.circle(0, 0, TILE * 0.35);
        g.fill(0xffffff);
        this.pawnLayer.addChild(g);
        this.pawnSprites.set(eid, g);
        g.eventMode = 'static';
        g.on('pointerdown', (e) => {
          e.stopPropagation();
          this.selectPawn(eid);
        });
      }
      const pos = this.sim.pawnPositions.get(eid);
      if (pos) {
        g.position.set(pos.x * TILE, pos.y * TILE);
        // 选中高亮
        g.tint = this.selected.has(eid) ? 0xffd700 : 0xffffff;
      }
    }
  }

  selectPawn(eid: number): void {
    this.selected.clear();
    this.selected.add(eid);
    this.sim.selected = [eid];
  }

  setCamera(dx: number, dy: number): void {
    this.camera.x -= dx / (TILE * this.camera.zoom);
    this.camera.y -= dy / (TILE * this.camera.zoom);
  }

  zoomBy(factor: number): void {
    this.camera.zoom = Math.max(0.2, Math.min(4, this.camera.zoom * factor));
  }

  // 屏幕坐标 -> 世界 tile 坐标
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
