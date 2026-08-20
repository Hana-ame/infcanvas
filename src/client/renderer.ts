// Pixi 渲染器 —— SVG 图标: 地形/建筑/小人 + 相机
// 性能背景：地表一次绘制固定；建筑层按 buildingVersion 版本号增量重绘（不每帧全量）；
// 位置插值平滑远程 500ms 一跳的消息（本地模式同样生效）；实体层按世界 y 排序实现 2.5D 前后遮挡
import { Application, Container, Graphics, Rectangle, Text, TextStyle } from 'pixi.js';
import type { SimView } from './remote';
import type { TileDef } from '../sim/defs';
import { World } from '../sim/core/world';
import { SvgAssets } from './svgLoader';
import { pawnAssetIdFor, hostileAssetId } from './svgAssets';
import { jobLabelOf } from '../sim/defs/jobs';
// 衣物染料色表（clothing 玩法包 2026-08-15：渲染染衣服的 tint 色）；渲染器属于默认玩法
// 装配域，直接引用玩法包常量（色表是玩法语义，不进 shared/内核）
import { K_WORN } from '../sim/mods/contracts';
// 染料色值表（2026-08-15 一致性解耦：色值 = 表现层数据，唯一权威在此；clothing 包只持染料 id
// 与中文色名，服务端不持有颜色值——避免两端色值来源不一致）
const DYE_COLORS: Record<string, string> = {
  red: '#c8605a',
  blue: '#5a7ac8',
  yellow: '#c8a860',
};

const TILE = 32;

// 敌人种类 → 稳定染色（内置两个暖色，mod 新敌人自动散列取值，可辨）
const ENEMY_TINTS: Record<string, number> = { cat: 0xff5555, raider: 0xff6688, boar: 0xcc8855 };
// 敌人染色：不同敌人类型用不同 tint 色（猫=橙/鹰=灰/狼=白等）
function hostileTint(enemyId: string): number {
  const fixed = ENEMY_TINTS[enemyId];
  if (fixed) return fixed;
  let h = 0;
  for (const ch of enemyId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return 0xff0000 | ((Math.abs(h) % 256) << 8) | (Math.abs(h >> 3) % 256);
}

// Canvas 渲染器（tile 绘制 + 建筑精灵 + 小人头像 + 敌人 tint + 光照覆盖 + 篝火光圈）
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
  private ghostDefId: string | null = null; // 2026-08-20 用户⑬自由建造设计:多格建筑按 footprint 整块预览
  // 蓝图层（排队中的建造）
  private blueprintLayer: Graphics;
  private lastBuildQueueVersion = -1;
  // 移动目标标记（右键移动后短暂显示）
  private markerLayer: Graphics;
  private markerLife = 0;
  // 飘字反馈（资源获得等）
  private floaters: { text: Text; life: number; vy: number }[] = [];
  // UIUX 2026-08-14：小人头顶状态图标（饿/困/伤/狂乱）——worldLayer 顶层
  private statusLayer: Container;
  private pawnStatus = new Map<number, Text>();
  // 选中高亮圆环（跟随选中 pawn，黄色脉冲）
  private selectedRing: Graphics;
  // 选中头顶职业标签（UIUX 2026-08-14：与圆环一起给"谁被选中+在干嘛"）
  private selLabel: Text | null = null;
  // 2026-08-20 多选计数气泡
  private selCountLabel: Text | null = null;
  // 2026-08-20 框选（PC 左键拖/触摸单指拖）：虚线矩形 overlay + 框内 pawn 实时预览
  private selBox: Graphics;
  private selBoxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private selPreview = new Set<number>(); // 框内 pawn（画绿色淡圈预览）
  // 血条层（UIUX 2026-08-14：hostile 全部 + 选中 pawn，比 alpha 变暗直观）
  private hpBarLayer: Graphics;
  // 状态阈值（对齐 tuning：hungerAt=30 / crazyAt=25；rest 无 urgentAt 暴露给渲染层，取 20）
  private static STATUS_THRESHOLD = { hungry: 30, sleepy: 20, crazy: 25, hurt: 0.4 } as const;

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
    this.markerLayer = new Graphics();
    this.markerLayer.eventMode = 'none';
    this.statusLayer = new Container();
    this.statusLayer.eventMode = 'none';
    this.selectedRing = new Graphics();
    this.selectedRing.eventMode = 'none';
    this.selBox = new Graphics();
    this.selBox.eventMode = 'none';
    this.selBox.zIndex = 90; // 选框盖在世界上层
    this.hpBarLayer = new Graphics();
    this.hpBarLayer.eventMode = 'none';
    this.worldContainer.addChild(this.terrainLayer);
    this.worldContainer.addChild(this.entityLayer);
    this.worldContainer.addChild(this.blueprintLayer);
    this.worldContainer.addChild(this.markerLayer);
    this.worldContainer.addChild(this.statusLayer); // 状态图标随世界 y 排（2.5D 遮挡自然）
    this.worldContainer.addChild(this.selectedRing);
    this.worldContainer.addChild(this.selBox);
    this.worldContainer.addChild(this.hpBarLayer);
    this.worldContainer.addChild(this.pawnLayer); // 飘字等屏幕上层
    this.worldContainer.addChild(this.ghost);
  }

  // 切换视角：2D 俯视 / 2.5D 同轴（前后遮挡）
  setViewMode(mode: 'top' | 'iso'): void {
    this.viewMode = mode;
    // 2026-08-20 修复：清 tile 缓存（同轴模式地面偏移，旧缓存 tile 不重绘 = 视觉错位）
    for (const [, g] of this.terrainChunkSprites) this.terrainLayer.removeChild(g);
    this.terrainChunkSprites.clear();
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
      this.spawnFloater(pos.x, pos.y, `+${ev.amount}`, ev.item === 'ore' ? '#ffd966' : '#aed581'); // 飘字颜色：矿=金色，其余=浅绿
    });
  }

  // 生成飘字
  private spawnFloater(wx: number, wy: number, text: string, color: string): void {
    const t = new Text({ text, style: new TextStyle({ fontSize: 14, fill: color, fontFamily: 'system-ui' }) });
    t.resolution = this.app.renderer.resolution;
    t.anchor.set(0.5);
    t.position.set(wx * TILE, wy * TILE);
    this.pawnLayer.addChild(t);
    this.floaters.push({ text: t, life: 1.2, vy: -30 }); // 飘字 1.2s 寿命、每秒上飘 30px（淡出按 life/1.2 比例）
  }

  // 小人头顶状态图标（UIUX 2026-08-14）：伤 > 狂乱 > 饿 > 困，一次只显示最紧急一个。
  // 阈值对齐 tuning（hungerAt=30/crazyAt=25）；rest 无 urgentAt 暴露给渲染层，取 20。
  // 状态图标用 Text 池（Map<eid, Text>），增删随小人生命周期，不每帧新建对象。
  private renderPawnStatus(): void {
    const th = Renderer.STATUS_THRESHOLD;
    const alive = new Set(this.sim.pawns);
    for (const [eid, t] of this.pawnStatus) if (!alive.has(eid)) { this.statusLayer.removeChild(t); this.pawnStatus.delete(eid); }
    for (const eid of this.sim.pawns) {
      const p = this.sim.pawnProfile(eid);
      const pos = this.sim.pawnPositions.get(eid);
      if (!p || !pos) continue;
      let icon: string | null = null;
      const h = p.health;
      if (h && h.hp / h.maxHp < th.hurt) icon = '❤️🩹';
      else if (p.needs && p.needs.san < th.crazy) icon = '😵';
      else if (p.needs && p.needs.food < th.hungry) icon = '🍗';
      else if (p.needs && p.needs.rest < th.sleepy) icon = '😴';
      if (icon) {
        let t = this.pawnStatus.get(eid);
        if (!t) {
          t = new Text({ text: icon, style: new TextStyle({ fontSize: 13, fontFamily: 'system-ui' }) });
          t.resolution = this.app.renderer.resolution;
          t.anchor.set(0.5, 1);
          this.statusLayer.addChild(t);
          this.pawnStatus.set(eid, t);
        }
        // 头顶偏移：2.5D 锚格底，图标顶在脚部 y 之上 0.9 格；2D 锚格中，偏移 0.7 格
        const lift = this.viewMode === 'iso' ? -0.95 : -0.7;
        t.position.set(pos.x * TILE + TILE / 2, pos.y * TILE + TILE / 2 + lift * TILE);
        // UIUX 2026-08-14：图标按 1/zoom 反缩放 → 屏幕恒定大小（zoom 0.3 时不缩成芝麻）
        t.scale.set(Math.max(0.5, Math.min(1.5, 1 / this.camera.zoom)));
        t.zIndex = Math.round(pos.y) * 10 + 20;
        t.visible = true;
      } else {
        const t = this.pawnStatus.get(eid);
        if (t) t.visible = false;
      }
    }
    this.statusLayer.sortChildren();
  }

  // 选中高亮圆环（UIUX 2026-08-14）：黄色圆环跟随选中 pawn，替代原来仅 scale 的弱反馈
  // 线宽按 1/zoom 反缩放 → 屏幕恒定（zoom 0.3 时世界变小，环线不跟着变细）
  // 2026-08-20 框选：多选环（selectedIds 全部画环；>4 只画 3 环）+ 计数气泡 + 首位职业标签
  private renderSelectedRing(): void {
    this.selectedRing.clear();
    const ids = this.sim.selectedIds;
    if (ids.length === 0) {
      if (this.selCountLabel) this.selCountLabel.visible = false;
      if (this.selLabel) this.selLabel.visible = false;
      return;
    }
    const show = ids.length > 4 ? ids.slice(0, 3) : ids;
    // 首位 pawn 位置（环 + 职业标签 + 计数气泡锚点）
    const p0 = this.sim.pawnPositions.get(ids[0]);
    if (!p0) return;
    const interp0 = this.interpPos(ids[0], { x: p0.x, y: p0.y }, this.pawnAnim);
    const cx0 = interp0.x * TILE + TILE / 2;
    const cy0 = this.viewMode === 'iso' ? interp0.y * TILE + TILE : interp0.y * TILE + TILE / 2;
    for (const eid of show) {
      const pos = this.sim.pawnPositions.get(eid);
      if (!pos) continue;
      const interp = this.interpPos(eid, { x: pos.x, y: pos.y }, this.pawnAnim);
      const cx = interp.x * TILE + TILE / 2;
      const cy = this.viewMode === 'iso' ? interp.y * TILE + TILE : interp.y * TILE + TILE / 2;
      const w = Math.max(1, 3 / this.camera.zoom);
      this.selectedRing.lineStyle(w, 0xffd700, 0.9);
      this.selectedRing.drawCircle(cx, cy, TILE * 0.72);
    }
    // 多选计数气泡（>1）
    if (ids.length > 1) {
      if (!this.selCountLabel) {
        this.selCountLabel = new Text({ text: '', style: new TextStyle({ fontSize: 16, fontFamily: 'system-ui', fill: '#ffffff', fontWeight: 'bold' }) });
        this.selCountLabel.resolution = this.app.renderer.resolution;
        this.selCountLabel.anchor.set(0.5, 0.5);
        this.selCountLabel.zIndex = 95;
        this.worldContainer.addChild(this.selCountLabel);
      }
      const br = TILE * 0.34;
      this.selectedRing.beginFill(0x111111, 0.85);
      this.selectedRing.drawCircle(cx0 + TILE * 0.72, cy0 - TILE * 0.72, br);
      this.selectedRing.endFill();
      this.selCountLabel.text = `${ids.length}`;
      this.selCountLabel.position.set(cx0 + TILE * 0.72, cy0 - TILE * 0.72);
      this.selCountLabel.scale.set(Math.max(0.6, Math.min(1.6, 1 / this.camera.zoom)));
      this.selCountLabel.visible = true;
    } else if (this.selCountLabel) this.selCountLabel.visible = false;
    // 首位职业标签（多选时显示首个 selected 职业）
    const p = this.sim.pawnProfile(ids[0]);
    if (p && p.job) {
      if (!this.selLabel) {
        this.selLabel = new Text({ text: '', style: new TextStyle({ fontSize: 12, fontFamily: 'system-ui', fill: '#ffd966', fontWeight: 'bold' }) });
        this.selLabel.resolution = this.app.renderer.resolution;
        this.selLabel.anchor.set(0.5, 1);
        this.worldContainer.addChild(this.selLabel);
      }
      const lift = this.viewMode === 'iso' ? -1.35 : -1.1;
      this.selLabel.text = jobLabelOf(p.job);
      this.selLabel.scale.set(Math.max(0.6, Math.min(1.6, 1 / this.camera.zoom)));
      this.selLabel.position.set(cx0, cy0 + lift * TILE * this.selLabel.scale.x);
      this.selLabel.visible = true;
    } else if (this.selLabel) this.selLabel.visible = false;
  }

  // 血条（UIUX 2026-08-14）：hostile 全部 + 选中 pawn；高 4 屏幕像素（/zoom），颜色随 hp 绿→橙→红
  private renderHpBars(): void {
    this.hpBarLayer.clear();
    const h = Math.max(2, 4 / this.camera.zoom);
    const w = TILE * 0.62;
    const bw = Math.max(1, 1.5 / this.camera.zoom);
    const drawBar = (cx: number, topY: number, ratio: number): void => {
      const x = cx - w / 2;
      this.hpBarLayer.rect(x, topY, w, h);
      this.hpBarLayer.fill(0x222233);
      this.hpBarLayer.rect(x + bw, topY + bw, (w - bw * 2) * Math.max(0, ratio), h - bw * 2);
      this.hpBarLayer.fill(ratio > 0.6 ? 0x6fbf4f : ratio > 0.35 ? 0xe8a33d : 0xdd3a3a);
    };
    for (const hst of this.sim.hostiles) {
      const cx = hst.x * TILE + TILE / 2;
      const top = this.viewMode === 'iso' ? hst.y * TILE + TILE - h - 4 : hst.y * TILE + TILE / 2 - TILE / 2 - h - 4;
      drawBar(cx, top, hst.hp / hst.maxHp);
    }
    const eid = this.sim.selectedIds[0];
    if (eid !== undefined) {
      const pos = this.sim.pawnPositions.get(eid);
      const hk = this.sim.healthOf(eid);
      if (pos && hk) {
        const interp = this.interpPos(eid, { x: pos.x, y: pos.y }, this.pawnAnim);
        const cx = interp.x * TILE + TILE / 2;
        const top = this.viewMode === 'iso' ? interp.y * TILE - h - 6 : interp.y * TILE - h - 6;
        drawBar(cx, top, hk.hp / hk.maxHp);
      }
    }
    // 征召标记（RW-1 M2，drafting 玩法包）：被征召的小人画屏幕恒定大小圈环（半径/线宽都按
    // 1/zoom 反缩放 → 任意缩放级别屏幕观感一致）。圈环 = "听我指挥"的命令标识，与血条
    //（被动状态）区分：征召队一眼可辨，蜜蜂则无标记。
    for (const eid of this.sim.pawns) {
      const pr = this.sim.pawnProfile(eid);
      if (!pr?.drafted) continue;
      const pos = this.sim.pawnPositions.get(eid);
      if (!pos) continue;
      const interp = this.interpPos(eid, { x: pos.x, y: pos.y }, this.pawnAnim);
      const cx = interp.x * TILE + TILE / 2;
      const cy = this.viewMode === 'iso' ? interp.y * TILE + TILE : interp.y * TILE + TILE / 2;
      const r = Math.max(12, 22 / this.camera.zoom);
      this.hpBarLayer.circle(cx, cy, r);
      this.hpBarLayer.stroke({ color: 0xffd24c, width: Math.max(1, 2.5 / this.camera.zoom), alpha: 0.95 });
    }
  }

  private updateMarker(dt: number): void {
    if (this.markerLife <= 0) return;
    this.markerLife -= dt;
    this.markerLayer.alpha = Math.max(0, this.markerLife / 1.2);
    if (this.markerLife <= 0) this.markerLayer.clear();
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

  // 地表色块（视口缓存，DESIGN §384：客户端按视口加载/卸载渲染对象——无限地图）
  // 2026-08-14 无限地图：不再全图一次绘制（192×192 是出生区，探索远处会黑屏/爆炸）；
  // 改为按 chunk(64×64) 缓存 Graphics，只保留视口可见 chunk，相机移动时增量挂载/卸载
  private terrainChunkSprites = new Map<string, Graphics>();
  private iconChunkSprites = new Map<string, Graphics>();
  private lastCamTile = { x0: 0, y0: 0, x1: 0, y1: 0 };

  // 视口可见 tile 范围（含安全余量 1 chunk，避免边缘闪烁）
  private viewTileRange(): { x0: number; y0: number; x1: number; y1: number } {
    const cam = this.camera;
    const halfW = (this.app.screen.width / 2) / (TILE * cam.zoom) + 64;
    const halfH = (this.app.screen.height / 2) / (TILE * cam.zoom) + 64;
    return {
      x0: Math.floor(cam.x - halfW),
      y0: Math.floor(cam.y - halfH),
      x1: Math.ceil(cam.x + halfW),
      y1: Math.ceil(cam.y + halfH),
    };
  }

  // 相机移动到未覆盖 tile 范围 → 重建地表/地形图标（增量：只补新 chunk、卸旧 chunk）
  private refreshViewportTerrain(): void {
    const r = this.viewTileRange();
    if (r.x0 === this.lastCamTile.x0 && r.y0 === this.lastCamTile.y0
      && r.x1 === this.lastCamTile.x1 && r.y1 === this.lastCamTile.y1) return;
    this.lastCamTile = r;
    this.drawTileGround();
    this.drawTerrainIcons();
  }

  private drawTileGround(): void {
    const w = this.sim.world;
    const r = this.lastCamTile;
    // 2026-08-20 修复：同轴模式地面 tiles 也要偏移（原 sprites 下移半格但地面不动 = 视觉错位）
    const dy = this.viewMode === 'iso' ? TILE / 2 : 0;
    // 卸载视口外 chunk（超出范围即丢对象；出生区外未知区 getTile 返回 'mountain' 也能画）
    for (const [ck, g] of [...this.terrainChunkSprites]) {
      const c = ck.split(',');
      const cx = Number(c[0]), cy = Number(c[1]);
      if (cx < Math.floor(r.x0 / 64) || cx > Math.floor(r.x1 / 64) || cy < Math.floor(r.y0 / 64) || cy > Math.floor(r.y1 / 64)) {
        this.terrainLayer.removeChild(g);
        this.terrainChunkSprites.delete(ck);
      }
    }
    for (let cy = Math.floor(r.y0 / 64); cy <= Math.floor(r.y1 / 64); cy++) {
      for (let cx = Math.floor(r.x0 / 64); cx <= Math.floor(r.x1 / 64); cx++) {
        const ck = `${cx},${cy}`;
        if (this.terrainChunkSprites.has(ck)) continue; // 已有缓存
        const g = new Graphics();
        const x0 = Math.max(r.x0, cx * 64), x1 = Math.min(r.x1, cx * 64 + 63);
        const y0 = Math.max(r.y0, cy * 64), y1 = Math.min(r.y1, cy * 64 + 63);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const def = this.tileDefOf(w.getTile(x, y));
            g.rect(x * TILE, y * TILE + dy, TILE, TILE);
            g.fill(def.color);
          }
        }
        this.terrainLayer.addChildAt(g, 0);
        this.terrainChunkSprites.set(ck, g);
      }
    }
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

  // 建筑/静态物锚点：始终居中于格（2026-08-20 修复"建筑偏了"——建筑图标此前走 placeEntity,
  // iso 模式被锚到格底,单格/多格建筑整体偏下半格;建筑无"脚",应居中于 footprint）
  private placeEntityCenter(g: Graphics, x: number, y: number): void {
    g.pivot.set(16, 16);
    g.position.set(x * TILE + TILE / 2, y * TILE + TILE / 2);
  }

  // 地形图标（树/矿/水）—— SVG。树进入 entityLayer 参与 2.5D 遮挡。
  // 无限地图视口化（2026-08-14）：与地表同 chunk 缓存，只挂载视口内；重建时树精灵
  // 需要重新登记 treeSprites（2.5D 排序），先清树列表再逐 chunk 补
  private drawTerrainIcons(): void {
    const w = this.sim.world;
    const r = this.lastCamTile;
    // 卸载视口外 chunk 图标（树精灵同步从 treeSprites 移除）
    for (const [ck, g] of [...this.iconChunkSprites]) {
      const c = ck.split(',');
      const cx = Number(c[0]), cy = Number(c[1]);
      if (cx < Math.floor(r.x0 / 64) || cx > Math.floor(r.x1 / 64) || cy < Math.floor(r.y0 / 64) || cy > Math.floor(r.y1 / 64)) {
        this.entityLayer.removeChild(g);
        this.terrainLayer.removeChild(g);
        this.iconChunkSprites.delete(ck);
        this.treeSprites = this.treeSprites.filter((t) => t.g !== g);
      }
    }
    for (let cy = Math.floor(r.y0 / 64); cy <= Math.floor(r.y1 / 64); cy++) {
      for (let cx = Math.floor(r.x0 / 64); cx <= Math.floor(r.x1 / 64); cx++) {
        const ck = `${cx},${cy}`;
        if (this.iconChunkSprites.has(ck)) continue;
        const g = new Graphics();
        const x0 = Math.max(r.x0, cx * 64), x1 = Math.min(r.x1, cx * 64 + 63);
        const y0 = Math.max(r.y0, cy * 64), y1 = Math.min(r.y1, cy * 64 + 63);
        let treeInChunk = false;
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const id = w.getTile(x, y);
            const aid = this.tileIconId(this.tileDefOf(id));
            if (!aid) continue;
            const icon = this.makeIcon(aid);
            if (!icon) continue;
            this.placeEntity(icon, x, y);
            if (id === 'tree') {
              this.treeSprites.push({ g: icon, x, y });
              g.addChild(icon);
              treeInChunk = true;
            } else {
              this.terrainLayer.addChild(icon);
            }
          }
        }
        if (treeInChunk) this.entityLayer.addChild(g); // 树容器随 entityLayer 2.5D 排序
        this.iconChunkSprites.set(ck, g);
      }
    }
    this.sortEntities();
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
    // 无限地图：相机移动到新 tile 范围 → 按视口增量加载/卸载地形（2026-08-14）
    this.refreshViewportTerrain();
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
    this.renderPawnStatus();
    this.renderSelectedRing();
    this.renderSelPreview();
    this.renderHpBars();
    this.sortEntities();
    this.renderGhost();
    this.updateFloaters(dt);
    this.updateMarker(dt);
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
      // 地道入口（另一维度，用户 2026-08-14）：不出现在地形上——不渲染
      //（地表看不到地道；入口位置玩家通过建筑面板/存档得知）
      if (b.def.tags?.includes('tunnel')) continue;
      // 新 key 编码（x + y*2^31，支持负坐标，2026-08-14 无限地图）必须用 World.keyToXY 解码
      const { x, y } = World.keyToXY(key);
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
        // 图标定位到 footprint 中心（居中锚,iso 不再偏下）
        const cx = (minX + maxX) / 2 / TILE;
        const cy = (minY + maxY) / 2 / TILE;
        this.placeEntityCenter(icon, cx, cy);
        if (this.viewMode === 'iso') {
          // iso 前后遮挡：建筑按中心 y 排序（角色 +9 恒在其上）,避免多格建筑与角色层混乱
          icon.zIndex = Math.round(cy) * 10 + 1;
          bg.zIndex = Math.round(cy) * 10;
        }
        icon.alpha = dmg < 0.5 ? 0.6 : 1;
        this.entityLayer.addChild(icon);
        this.buildingSprites.push({ g: icon, x: cx, y: cy });
      }
    }
  }

  // 蓝图（排队中的建造）半透明显示 + 底部进度条（UIUX 2026-08-14：progress/buildTime 实时可见）
  private drawBlueprints(): void {
    this.blueprintLayer.clear();
    const w = this.sim.world;
    for (const b of this.sim.buildQueueItems) {
      const x = b.x * TILE;
      const y = b.y * TILE;
      this.blueprintLayer.rect(x + 1, y + 1, TILE - 2, TILE - 2);
      this.blueprintLayer.fill(0x4cf);
      this.blueprintLayer.alpha = 0.45;
      // 进度条：底色 + 按 progress/buildTime 填充（buildTime 查 def，mod 建筑同样生效）
      const def = this.sim.buildingDef(b.defId);
      const total = def?.buildTime ?? 1;
      const k = Math.min(1, Math.max(0, (b.progress ?? 0) / total));
      this.blueprintLayer.rect(x + 2, y + TILE - 6, TILE - 4, 4);
      this.blueprintLayer.fill(0x112233);
      this.blueprintLayer.rect(x + 2, y + TILE - 6, (TILE - 4) * k, 4);
      this.blueprintLayer.fill(0x4cf);
      this.blueprintLayer.alpha = 1;
    }
    void w;
  }

  // 穿着衣物物品 id（clothing 玩法包 2026-08-15）：本地读 pawnStates.extra.worn.body
  //（存档扩展点），远程读 RemoteSim.wornOf（快照 worn 字段，server 从同一契约填充）
  private simWornOf(eid: number): string | undefined {
    const sim = this.sim as { pawnStates?: Map<number, { extra?: Record<string, unknown> }>; wornOf?: (e: number) => string | undefined };
    const local = sim.pawnStates?.get(eid)?.extra?.[K_WORN];
    if (local) return (local as { body?: string }).body;
    return sim.wornOf?.(eid);
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
        g.hitArea = new Rectangle(-14, -14, 28, 28); // 点击热区 28×28（比图标略大，点选友好）
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
        // 穿着染色衣物的 tint（clothing 玩法包 2026-08-15）：衣物 id 前缀 red/blue/yellow
        // → 布料染成对应色（素衣不改 tint）。契约：本地读 pawnStates.extra.worn.body
        //（存档扩展点），远程读快照 worn 字段（server 从同一契约填充）
        const worn = this.simWornOf(eid);
        const dye = worn?.split('_')[0];
        g.tint = worn && dye && dye in DYE_COLORS ? parseInt(DYE_COLORS[dye]!.replace('#', ''), 16) : 0xffffff;
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

  // 渲染入侵者（红色敌对）—— 用宿主敌对剪影(2026-08-20 修复:此前复用 pawn:strong 仅 tint,
  // 猫/鼠剪影相同;enemyId 专属剪影(cat=尖耳长尾) + mod 新敌人兜底 generic + hostileTint 色阶)
  private renderHostiles(): void {
    let idx = 0;
    for (const h of this.sim.hostiles) {
      let g = this.hostileSprites.get(idx);
      if (!g) {
        const icon = this.makeIcon(hostileAssetId(h.enemyId ?? "generic"), 0.9);
        if (!icon) continue;
        g = icon;
        g.eventMode = 'none';
        this.entityLayer.addChild(g);
        this.hostileSprites.set(idx, g);
      }
      // 按敌人种类稳定着色（enemyId 散列；未带 id 时按阵营兜底），mod 新敌人自动可辨
      g.tint = hostileTint(h.enemyId ?? (h.faction === 'unit' ? 'raider' : 'cat'));
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

  // 根据 DNA 天赋选不同的鼠 SVG（与 HUD 共用同一映射）
  private pawnAssetId(eid: number): string {
    const p = this.sim.pawnProfile(eid);
    return p ? pawnAssetIdFor(p.dna.traits) : 'pawn:mouse';
  }

  // 移动目标标记（右键/触摸移动后显示，1.2s 淡出）
  // UIUX 2026-08-14：从起点的 pawn 位置画箭头线到目标点（方向感），末端圆环 + 箭簇
  showMoveMarker(from: { x: number; y: number } | null, to: { x: number; y: number }): void {
    this.markerLayer.clear();
    const gx = to.x * TILE + TILE / 2;
    const gy = to.y * TILE + TILE / 2;
    if (from) {
      const fx = from.x * TILE + TILE / 2;
      const fy = this.viewMode === 'iso' ? from.y * TILE + TILE : from.y * TILE + TILE / 2;
      const dx = gx - fx;
      const dy = gy - fy;
      const len = Math.hypot(dx, dy);
      if (len > TILE * 0.4) {
        // 线略短于目标点（避免盖住目标圆环），末端画箭簇三角；线宽反缩放保持屏幕恒定
        const ux = dx / len;
        const uy = dy / len;
        const t = Math.min(len - 14, len * 0.8);
        this.markerLayer.moveTo(fx + ux * t, fy + uy * t);
        this.markerLayer.lineTo(gx - ux * 14, gy - uy * 14);
        this.markerLayer.stroke({ color: 0x4cf, width: Math.max(1, 3 / this.camera.zoom), alpha: 0.9 });
        const ax = gx - ux * 16;
        const ay = gy - uy * 16;
        const px = -uy * 6;
        const py = ux * 6;
        this.markerLayer.moveTo(gx - ux * 10, gy - uy * 10);
        this.markerLayer.lineTo(ax + px, ay + py);
        this.markerLayer.lineTo(ax - px, ay - py);
        this.markerLayer.closePath();
        this.markerLayer.fill(0x4cf);
      }
    }
    this.markerLayer.circle(gx, gy, TILE * 0.45);
    this.markerLayer.stroke({ color: 0x4cf, width: Math.max(1, 3 / this.camera.zoom), alpha: 0.9 });
    this.markerLayer.circle(gx, gy, 3);
    this.markerLayer.fill(0x4cf);
    this.markerLayer.alpha = 1;
    this.markerLife = 1.2;
  }

  // 镜头直接跳转到世界坐标（UIUX 2026-08-14：历史面板点击跳转）
  focusOn(wx: number, wy: number): void {
    this.camera.x = wx;
    this.camera.y = wy;
  }

  // 建造幽灵预览:defId 存在时按建筑 footprint 整块高亮(2×2 农田/教堂不再只见单格)
  setGhost(worldTile: { x: number; y: number }, color?: number, defId?: string): void {
    this.ghostPos = worldTile;
    if (defId !== undefined) this.ghostDefId = defId;
    if (color) this.ghostColor = color;
  }

  clearGhost(): void {
    this.ghostPos = null;
    this.ghost.clear();
  }

  private renderGhost(): void {
    this.ghost.clear();
    if (!this.ghostPos) return;
    // footprint 覆盖格集合:多格建筑整块预览;footprintOf 异常时退单格
    let tiles: { x: number; y: number }[] = [{ x: this.ghostPos.x, y: this.ghostPos.y }];
    if (this.ghostDefId) {
      const foot = this.sim.world.footprintOf(this.ghostPos.x, this.ghostPos.y);
      if (foot && foot.length > 0) tiles = foot;
    }
    for (const t of tiles) this.ghost.rect(t.x * TILE + 1, t.y * TILE + 1, TILE - 2, TILE - 2);
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
    // 拖拽平移 = 抓着地图跟手（2026-08-20 修复"鼠标拖动正好都反了"：
    // 原 `-=` 是"滚动窗口"惯例——拖右看左；与 screenToWorld(屏幕右=世界 x 增) 自洽的跟手版本是 `+=`。
    // 鼠标左键拖拽与触摸双指平移都走这里,一并修正）
    this.camera.x += dx / (TILE * this.camera.zoom);
    this.camera.y += dy / (TILE * this.camera.zoom);
  }

  // 缩放钳制 0.3x~4x（zoomBy/zoomAt 共用）：下限防地图翻转、上限防过度放大（可玩性边界）
  zoomBy(factor: number): void {
    this.camera.zoom = Math.max(0.3, Math.min(4, this.camera.zoom * factor));
  }

  // 以屏幕点 (sx,sy) 为中心缩放：该点下的世界格缩放前后屏幕位置不变（滚轮不漂）
  zoomAt(sx: number, sy: number, factor: number): void {
    const cam = this.camera;
    const wx = cam.x + (sx - this.app.screen.width / 2) / (TILE * cam.zoom);
    const wy = cam.y + (sy - this.app.screen.height / 2) / (TILE * cam.zoom);
    cam.zoom = Math.max(0.3, Math.min(4, cam.zoom * factor));
    cam.x = wx - (sx - this.app.screen.width / 2) / (TILE * cam.zoom);
    cam.y = wy - (sy - this.app.screen.height / 2) / (TILE * cam.zoom);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const cam = this.camera;
    const wx = cam.x + (sx - this.app.screen.width / 2) / (TILE * cam.zoom);
    const wy = cam.y + (sy - this.app.screen.height / 2) / (TILE * cam.zoom);
    return { x: Math.floor(wx), y: Math.floor(wy) };
  }

  // ---- 2026-08-20 框选 ----
  // 屏幕坐标框选矩形（虚线 overlay + 框内 pawn 预览高亮）
  setSelBox(sx0: number, sy0: number, sx1: number, sy1: number): void {
    this.selBoxRect = { x0: Math.min(sx0, sx1), y0: Math.min(sy0, sy1), x1: Math.max(sx0, sx1), y1: Math.max(sy0, sy1) };
    this.selBox.clear();
    const r = this.selBoxRect;
    const w = Math.max(1, 1.5 / this.camera.zoom);
    this.selBox.lineStyle(w, 0x4cf, 0.9);
    this.selBox.drawRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    this.selBox.beginFill(0x4cf, 0.12);
    this.selBox.drawRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    this.selBox.endFill();
    // 框内 pawn 预览（世界坐标收集）
    this.selPreview.clear();
    const w0 = this.screenToWorld(r.x0, r.y0);
    const w1 = this.screenToWorld(r.x1, r.y1);
    const x0 = Math.min(w0.x, w1.x), x1 = Math.max(w0.x, w1.x);
    const y0 = Math.min(w0.y, w1.y), y1 = Math.max(w0.y, w1.y);
    for (const eid of this.sim.pawns) {
      const pos = this.sim.pawnPositions.get(eid);
      if (!pos) continue;
      if (pos.x >= x0 && pos.x <= x1 && pos.y >= y0 && pos.y <= y1) this.selPreview.add(eid);
    }
  }

  // 框内 valid pawn id 列表（collectInBox —— 提交框选时读取）
  get boxPawnIds(): number[] { return [...this.selPreview]; }

  // 清选框（结束/取消框选）
  clearSelBox(): void {
    this.selBoxRect = null;
    this.selBox.clear();
    this.selPreview.clear();
  }

  // 框选预览：绿色淡圈标记框内 pawn（ticker 里随 renderSelectedRing 一起画）
  renderSelPreview(): void {
    // 无活动框选 → 无预览（selPreview 已清）
    this.selBox.clear();
    if (!this.selBoxRect) return;
    const r = this.selBoxRect;
    const w = Math.max(1, 1.5 / this.camera.zoom);
    this.selBox.lineStyle(w, 0x4cf, 0.9);
    this.selBox.drawRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    this.selBox.beginFill(0x4cf, 0.12);
    this.selBox.drawRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    this.selBox.endFill();
    for (const eid of this.selPreview) {
      const pos = this.sim.pawnPositions.get(eid);
      if (!pos) continue;
      const cx = pos.x * TILE + TILE / 2;
      const cy = this.viewMode === 'iso' ? pos.y * TILE + TILE : pos.y * TILE + TILE / 2;
      const pw = Math.max(1, 2 / this.camera.zoom);
      this.selBox.lineStyle(pw, 0x3fb950, 0.7);
      this.selBox.drawCircle(cx, cy, TILE * 0.62);
    }
  }

  destroy(): void {
    this.app.destroy({ removeView: true }, { children: true });
  }
}