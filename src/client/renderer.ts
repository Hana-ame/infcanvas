// Pixi 渲染器 —— SVG 图标: 地形/建筑/小人 + 相机
import { Application, Container, Graphics, Rectangle, Text, TextStyle } from 'pixi.js';
import type { SimView } from './remote';
import type { TileDef } from '../sim/defs';
import { SvgAssets } from './svgLoader';

const TILE = 32;

// 敌人种类 → 稳定染色（内置两个暖色，mod 新敌人自动散列取值，可辨）
const ENEMY_TINTS: Record<string, number> = { wolf: 0xff5555, raider: 0xff6688, boar: 0xcc8855 };
function hostileTint(enemyId: string): number {
  const fixed = ENEMY_TINTS[enemyId];
  if (fixed) return fixed;
  let h = 0;
  for (const ch of enemyId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return 0xff0000 | ((Math.abs(h) % 256) << 8) | (Math.abs(h >> 3) % 256);
}

export class Renderer {
  app: Application;
  worldContainer: Container;
  sim: SimView;
  private assets: SvgAssets;
  private viewMode: 'top' | 'iso' = 'top';
  private entityLayer: Container; // 树/建筑/小人/敌人按 y 前后排序（2.5D）
  private terrainLayer: Container;
  private pawnLayer: Container;
  private treeSprites: { g: Graphics; x: number; y: number }[] = [];
  private buildingSprites: { g: Graphics; x: number; y: number }[] = [];
  private pawnSprites = new Map<number, Graphics>();
  private hostileSprites = new Map<number, Graphics>();
  // 位置插值（远程模式 delta 500ms 一跳，渲染平滑）：记录上一段起终点 + sim 时间，按 k 线性插值
  private pawnAnim = new Map<number, { x0: number; y0: number; x1: number; y1: number; t0: number; t1: number }>();
  private hostileAnim = new Map<number, { x0: number; y0: number; x1: number; y1: number; t0: number; t1: number }>();
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

  constructor(sim: SimView, assets: SvgAssets) {
    this.sim = sim;
    this.assets = assets;
    this.app = new Application();
    this.worldContainer = new Container();
    this.terrainLayer = new Container();
    this.pawnLayer = new Container();
    this.entityLayer = new Container();
    this.entityLayer.sortableChildren = true;
    this.ghost = new Graphics();
    this.ghost.eventMode = 'none';
    this.blueprintLayer = new Graphics();
    this.blueprintLayer.eventMode = 'none';
    this.worldContainer.addChild(this.terrainLayer);
    this.worldContainer.addChild(this.entityLayer);
    this.worldContainer.addChild(this.blueprintLayer);
    this.worldContainer.addChild(this.pawnLayer); // 飘字等屏幕上层
    this.worldContainer.addChild(this.ghost);
  }

  // 切换视角：2D 俯视 / 2.5D 同轴（前后遮挡）
  setViewMode(mode: 'top' | 'iso'): void {
    this.viewMode = mode;
    // 树/建筑重定位到新锚点，全部实体重排 z 顺序
    for (const t of this.treeSprites) this.placeEntity(t.g, t.x, t.y);
    for (const b of this.buildingSprites) this.placeEntity(b.g, b.x, b.y);
    for (const [eid, g] of this.pawnSprites) {
      const pos = this.sim.pawnPositions.get(eid);
      if (pos) this.placeEntity(g, pos.x, pos.y);
    }
    for (let i = 0; i < this.hostileSprites.size; i++) {
      const h = this.sim.hostiles[i];
      const g = this.hostileSprites.get(i);
      if (h && g) this.placeEntity(g, h.x, h.y);
    }
    this.sortEntities();
  }

  // 实体 y 轴前后排序：2.5D 模式按世界 y 设 zIndex（y 越大越靠前/靠下）
  // 2D 模式：固定层级（地形 < 树 < 建筑 < 小人/敌人）
  private sortEntities(): void {
    const iso = this.viewMode === 'iso';
    for (const t of this.treeSprites) t.g.zIndex = iso ? t.y * 10 : 1;
    for (const b of this.buildingSprites) b.g.zIndex = iso ? b.y * 10 + 5 : 2;
    for (const [eid, g] of this.pawnSprites) {
      const pos = this.sim.pawnPositions.get(eid);
      if (pos) g.zIndex = iso ? Math.round(pos.y) * 10 + 9 : 3;
    }
    for (let i = 0; i < this.hostileSprites.size; i++) {
      const h = this.sim.hostiles[i];
      const g = this.hostileSprites.get(i);
      if (h && g) g.zIndex = iso ? Math.round(h.y) * 10 + 9 : 3;
    }
    this.entityLayer.sortChildren();
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
        const def = this.tileDefOf(w.getTile(x, y));
        g.rect(x * TILE, y * TILE, TILE, TILE);
        g.fill(def.color);
      }
    }
    this.terrainLayer.addChildAt(g, 0);
  }

  // tile def 查表（mod 可覆盖/新增 tile；未知 id 给兜底色，渲染不崩）
  private tileDefOf(id: string): TileDef {
    return this.sim.mods.tiles[id] ?? { id, name: id, passable: true, buildable: true, color: '#2a2a3a' };
  }

  // 用 SVG GraphicsContext 生成一个图标（定位到格中心）
  private makeIcon(id: string, scale = 1): Graphics | null {
    const ctx = this.assets.get(id);
    if (!ctx) return null;
    const g = new Graphics(ctx);
    // SVG 是 32x32，缩放到 TILE
    g.scale.set(scale);
    g.pivot.set(16, 16);
    g.position.set(TILE / 2, TILE / 2);
    return g;
  }

  // 实体精灵坐标：2.5D 时锚到格底（脚部落位），2D 时格中心
  private placeEntity(g: Graphics, x: number, y: number): void {
    g.pivot.set(16, 16);
    if (this.viewMode === 'iso') {
      g.position.set(x * TILE + TILE / 2, y * TILE + TILE);
    } else {
      g.position.set(x * TILE + TILE / 2, y * TILE + TILE / 2);
    }
  }

  // 地形图标（树/矿/水）—— SVG。树进入 entityLayer 参与 2.5D 遮挡
  private drawTerrainIcons(): void {
    const w = this.sim.world;
    for (let y = 0; y < w.height; y++) {
      for (let x = 0; x < w.width; x++) {
        const id = w.getTile(x, y);
        const aid = this.tileIconId(this.tileDefOf(id));
        if (!aid) continue;
        const g = this.makeIcon(aid);
        if (!g) continue;
        this.placeEntity(g, x, y);
        if (id === 'tree') {
          this.treeSprites.push({ g, x, y });
          this.entityLayer.addChild(g);
        } else {
          this.terrainLayer.addChild(g);
        }
      }
    }
  }

  // tile 图标选型：def.sprite 显式声明优先 → growable/mineral 推断 → 内置装饰 id（水/石）
  // mod 新 tile：给 sprite 声明（如 'terrain:tree'）即有表现；否则只渲底色不崩
  private tileIconId(def: TileDef): string | null {
    if (def.sprite) return def.sprite;
    if (def.growable) return 'terrain:tree';
    if (def.mineral) return 'terrain:ore';
    if (def.id === 'water') return 'terrain:water';
    if (def.id === 'stone') return 'terrain:stone';
    return null;
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
    this.sortEntities();
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
    // 先移除上一轮的建筑精灵（背景色块 + 图标）
    for (const b of this.buildingSprites) this.entityLayer.removeChild(b.g);
    this.buildingSprites = [];
    for (const [key, b] of w.buildings) {
      const x = key % w.width;
      const y = Math.floor(key / w.width);
      // 多格 footprint：背景色块覆盖全部格
      const dmg = b.hp / b.def.hp;
      const bg = new Graphics();
      const foot = w.footprintOf(x, y);
      const minX = Math.min(...foot.map((f) => f.x)) * TILE;
      const minY = Math.min(...foot.map((f) => f.y)) * TILE;
      const maxX = Math.max(...foot.map((f) => f.x)) * TILE + TILE;
      const maxY = Math.max(...foot.map((f) => f.y)) * TILE + TILE;
      bg.rect(minX, minY, maxX - minX, maxY - minY);
      bg.fill(dmg < 0.5 ? 0x7a2a2a : dmg < 1 ? 0x5a4a3a : b.def.color);
      this.entityLayer.addChild(bg);
      this.buildingSprites.push({ g: bg, x, y });
      const aid = b.def.sprite ?? `building:${b.def.id}`;
      const icon = this.makeIcon(aid);
      if (icon) {
        // 图标定位到 footprint 中心
        const cx = (minX + maxX) / 2 / TILE;
        const cy = (minY + maxY) / 2 / TILE;
        this.placeEntity(icon, cx, cy);
        icon.alpha = dmg < 0.5 ? 0.6 : 1;
        this.entityLayer.addChild(icon);
        this.buildingSprites.push({ g: icon, x: cx, y: cy });
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
        this.entityLayer.addChild(g);
        this.pawnSprites.set(eid, g);
        g.eventMode = 'static';
        g.hitArea = new Rectangle(-14, -14, 28, 28);
        g.on('pointerdown', (e) => {
          e.stopPropagation();
          this.selectPawn(eid);
        });
      }
      const p = this.sim.pawnPositions.get(eid);
      if (!p) continue;
      const pos = this.interpPos(eid, { x: p.x, y: p.y }, this.pawnAnim);
      if (pos) {
        this.placeEntity(g, pos.x, pos.y);
        // 2.5D：按世界 y 排序（前后遮挡）
        if (this.viewMode === 'iso') g.zIndex = Math.round(pos.y) * 10 + 9;
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
    // 清理死亡/消失小人的残留渲染（delta 下死亡经 removed 广播）
    const alive = new Set(this.sim.pawns);
    for (const [eid, g] of this.pawnSprites) {
      if (!alive.has(eid)) {
        this.entityLayer.removeChild(g);
        this.pawnSprites.delete(eid);
        this.pawnAnim.delete(eid);
      }
    }
    this.selected.forEach((eid) => { if (!alive.has(eid)) this.selected.delete(eid); });
  }

  // 渲染位置插值：位置更新（快照/delta）时建立动画段，帧间线性插值到目标
  // 本地模式同样生效（每 tick 都有位置变化，段很短 ≈ 贴合真实）；站定后 k 收敛到 1
  private interpPos(
    eid: number, cur: { x: number; y: number }, anim: Map<number, { x0: number; y0: number; x1: number; y1: number; t0: number; t1: number }>,
  ): { x: number; y: number } {
    const a = anim.get(eid);
    // 播放时钟：RemoteSim 用墙钟 extrapolate 的连续时间（消息 500ms 一跳，time 本身不逐帧前进）
    const t = this.sim.renderNow ? this.sim.renderNow() : this.sim.time;
    if (!a || a.x1 !== cur.x || a.y1 !== cur.y) {
      anim.set(eid, { x0: a?.x1 ?? cur.x, y0: a?.y1 ?? cur.y, x1: cur.x, y1: cur.y, t0: a?.t1 ?? t, t1: t });
      return cur;
    }
    const span = a.t1 - a.t0;
    if (span <= 0) return cur;
    const k = Math.min(1, Math.max(0, (t - a.t0) / span));
    return { x: a.x0 + (a.x1 - a.x0) * k, y: a.y0 + (a.y1 - a.y0) * k };
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
        this.entityLayer.addChild(g);
        this.hostileSprites.set(idx, g);
      }
      // 按敌人种类稳定着色（enemyId 散列；未带 id 时按阵营兜底），mod 新敌人自动可辨
      g.tint = hostileTint(h.enemyId ?? (h.faction === 'unit' ? 'raider' : 'wolf'));
      g.visible = true;
      const pos = this.interpPos(idx, { x: h.x, y: h.y }, this.hostileAnim);
      this.placeEntity(g, pos.x, pos.y);
      if (this.viewMode === 'iso') g.zIndex = Math.round(pos.y) * 10 + 9;
      g.alpha = Math.max(0.4, h.hp / h.maxHp);
      idx++;
    }
    for (let i = idx; i < this.hostileSprites.size; i++) {
      const g = this.hostileSprites.get(i);
      if (g) g.visible = false;
      this.hostileAnim.delete(i);
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
  private pawnAssetId(eid: number): string {
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