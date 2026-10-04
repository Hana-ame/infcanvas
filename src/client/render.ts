/**
 * client/render.ts —— PixiJS 正交俯视渲染器（阶段④）。
 *
 * 结构：
 *  - terrainG：可视区地形，一次 Graphics 重画。只在"视口键"变化或周期到点时重画。
 *  - floorG：建筑底座，每帧重画（防漂移——与实体图标频率不一致会错位）。
 *  - entityLayer：鼠/猫/建筑图标/**树 Sprite**，y 排序（sortableChildren），
 *    位置每帧同步。树 Sprite 由 Graphics 预生成纹理再实例化——贴图样式而非几何色块。
 *
 * 渲染层零逻辑：只读 WorldView 快照 + 把输入翻译成回调（onSelect/onCommand）。
 */
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { WorldView } from './view';
import { TRAIT_COLOR, cardLabel } from './view';

const TILE_COLORS: Record<string, string> = {
  grass: '#4a7a35',
  dirt: '#8a7042',
  stone: '#8d9298',
  water: '#2f6699',
};

interface PawnSprite {
  root: Container;
  body: Graphics;
  name: Text;
  label: Text;
  bars: Graphics;
  barTags: Text[];
  key: string;
}

export interface RenderInput {
  onSelect(eid: number | null): void;
  onMove(x: number, y: number): void;
  onUserPan?(): void;
}

export class Renderer {
  private world = new Container();
  private gameContainer = new Container();
  private terrainG = new Graphics();
  private floorG = new Graphics();
  private entityLayer = new Container();
  private pawnSprites = new Map<number, PawnSprite>();
  private hostileG = new Map<number, Graphics>();
  private buildingG = new Map<string, Container>();
  /** 树 Sprite：锚点键 → Sprite（贴图样，由 Graphics 预生成纹理再实例化） */
  private treeSprites = new Map<string, Sprite>();
  /** 当前可见树锚点集合（每当地形重画时重新扫描） */
  private visibleTrees = new Set<string>();
  private treeTexture: Texture | null = null;

  private TILE = 20;
  private cam = { x: 0, y: 0 };
  /** 选中高亮集合（HUD 层维护选择状态，渲染只照做） */
  selected = new Set<number>();

  constructor(
    private app: Application,
    private view: WorldView,
    private input: RenderInput,
  ) {
    this.gameContainer.addChild(this.terrainG);
    this.gameContainer.addChild(this.floorG);
    this.entityLayer.sortableChildren = true;
    this.gameContainer.addChild(this.entityLayer);
    this.world.addChild(this.gameContainer);
    app.stage.addChild(this.world);
    this.bindInput();
    this.generateTreeTexture();
  }

  /** 预生成树贴图（阴影+树干+三层树冠），之后所有树 Sprite 共用此纹理 */
  private generateTreeTexture(): void {
    const g = new Graphics();
    // 画布 64×64，树占据中心约 56×56（四周留白防裁剪）
    // 阴影（底部椭圆）
    g.ellipse(32, 54, 22, 6).fill({ color: 0x000000, alpha: 0.2 });
    // 树干
    g.rect(29, 28, 6, 24).fill('#5c4023');
    // 下层树冠（最大最暗的深绿）
    g.circle(32, 26, 24).fill('#1f3a18');
    // 中层树冠
    g.circle(28, 22, 18).fill('#2d5a20');
    // 上层高光（偏左上的亮绿斑）
    g.circle(24, 17, 10).fill({ color: 0x4d8a35, alpha: 0.7 });
    // 生成纹理（分辨率 1：保持与屏幕像素匹配，缩放到 2×TILE 时清晰）
    this.treeTexture = this.app.renderer.generateTexture(g);
  }

  centerOn(x: number, y: number): void {
    this.cam.x = x;
    this.cam.y = y;
  }

  lerpCam(x: number, y: number, rate = 0.06): void {
    this.cam.x += (x - this.cam.x) * rate;
    this.cam.y += (y - this.cam.y) * rate;
  }

  /** 屏幕像素 → 世界坐标（悬停属性卡/外部拾取用） */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return this.toWorld(sx, sy);
  }
  private toWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - appWidth() / 2) / this.TILE + this.cam.x,
      y: (sy - appHeight() / 2) / this.TILE + this.cam.y,
    };
  }
  // ---------------- 输入 ----------------
  private drag: { sx: number; sy: number; cx: number; cy: number } | null = null;
  private bindInput(): void {
    const cv = this.app.canvas;
    cv.addEventListener('mousedown', (e) => {
      if (e.button === 0 || e.button === 1) {
        this.drag = { sx: e.clientX, sy: e.clientY, cx: this.cam.x, cy: this.cam.y };
      }
    });
    addEventListener('mousemove', (e) => {
      const d = this.drag;
      if (!d) return;
      this.cam.x = d.cx - (e.clientX - d.sx) / this.TILE;
      this.cam.y = d.cy - (e.clientY - d.sy) / this.TILE;
      this.input.onUserPan?.();
    });
    addEventListener('mouseup', (e) => {
      if (!this.drag) return;
      const moved = Math.hypot(e.clientX - this.drag.sx, e.clientY - this.drag.sy);
      this.drag = null;
      if (moved > 5 || e.button !== 0) return;
      const w = this.toWorld(e.clientX, e.clientY);
      let hit: number | null = null;
      for (const p of this.view.pawns()) {
        if (Math.hypot(p.pos.x - w.x, p.pos.y - w.y) <= 1.2) hit = p.eid;
      }
      this.input.onSelect(hit);
    });
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const w = this.toWorld(e.clientX, e.clientY);
      this.input.onMove(Math.round(w.x), Math.round(w.y));
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this.toWorld(e.clientX, e.clientY);
      this.TILE = Math.max(8, Math.min(44, this.TILE * (e.deltaY > 0 ? 0.9 : 1.1)));
      const after = this.toWorld(e.clientX, e.clientY);
      this.cam.x += before.x - after.x;
      this.cam.y += before.y - after.y;
    }, { passive: false });
  }

  // ---------------- 每帧刷新 ----------------
  frame(nowMs: number): void {
    // 相机 = 移动 gameContainer 变换，所有子层（地形/底座/实体）一起走，绝不漂移
    this.gameContainer.position.set(
      -this.cam.x * this.TILE + appWidth() / 2,
      -this.cam.y * this.TILE + appHeight() / 2,
    );
    // 全部三件套每帧重画——此前 viewKey 节流（半格才更新）导致地形/底座
    // 与实体层（每帧更新）错位，拖拽时"飘移"（用户反馈「svg拖动的时候都会飘」）。
    // 地形 ~2000 rects + 特征哈希，实测 <1ms/帧，无需节流。
    this.redrawTerrain();
    this.redrawFloors();
    this.scanVisibleTrees();
    this.syncEntities();
  }

  /** 扫描视口内树锚点，更新 visibleTrees 集合 */
  private scanVisibleTrees(): void {
    const halfW = Math.ceil(appWidth() / 2 / this.TILE) + 2;
    const halfH = Math.ceil(appHeight() / 2 / this.TILE) + 2;
    const x0 = Math.round(this.cam.x) - halfW;
    const y0 = Math.round(this.cam.y) - halfH;
    const next = new Set<string>();
    for (let ty = y0; ty <= y0 + 2 * halfH; ty++) {
      for (let tx = x0; tx <= x0 + 2 * halfW; tx++) {
        const f = this.view.featureAt(tx, ty);
        if (f?.kind === 'tree') next.add(`${tx},${ty}`);
      }
    }
    this.visibleTrees = next;
  }

  private redrawTerrain(): void {
    const g = this.terrainG;
    g.clear();
    const halfW = Math.ceil(appWidth() / 2 / this.TILE) + 2;
    const halfH = Math.ceil(appHeight() / 2 / this.TILE) + 2;
    const x0 = Math.round(this.cam.x) - halfW;
    const y0 = Math.round(this.cam.y) - halfH;
    const maxZ = this.view.tuning?.world?.maxZ ?? 4;
    // 第一趟：只画地形底色 + z 高度阴影（高处亮、低处暗）
    for (let ty = y0; ty <= y0 + 2 * halfH; ty++) {
      for (let tx = x0; tx <= x0 + 2 * halfW; tx++) {
        const kind = this.view.tileAt(tx, ty);
        g.rect(tx * this.TILE, ty * this.TILE, this.TILE + 0.5, this.TILE + 0.5).fill(TILE_COLORS[kind] ?? '#7a7a7a');
        // z 高度明暗叠加：z 越大越亮（白色 alpha 随 z 线性增长）
        const z = this.view.zAt(tx, ty);
        if (z > 0) {
          g.rect(tx * this.TILE, ty * this.TILE, this.TILE + 0.5, this.TILE + 0.5)
            .fill({ color: 0x000000, alpha: Math.max(0, ((maxZ - z) / maxZ) * 0.22) });
        }
      }
    }
    // 第二趟：浆果丛画在地形之上（树已是 Sprite 实体层，不在 terrainG 里画）
    for (let ty = y0; ty <= y0 + 2 * halfH; ty++) {
      for (let tx = x0; tx <= x0 + 2 * halfW; tx++) {
        const f = this.view.featureAt(tx, ty);
        if (!f || f.kind === 'tree') continue;
        const px = tx * this.TILE;
        const py = ty * this.TILE;
        const ccx = px + this.TILE / 2;
        const ccy = py + this.TILE / 2;
        g.circle(ccx, ccy, this.TILE * 0.36).fill('#35502a');
        for (let i = 0; i < f.amount; i++) {
          g.rect(ccx - 4 + i * 3.2, ccy - 2 + (i % 2) * 4, 2.4, 2.4).fill('#c9403a');
        }
      }
    }
    // 第三趟：z 数字标签（只在放大到能看清时显示）
    this.syncZLabels(x0, y0, halfW, halfH);
  }

  /** z 数字标签池：只在 TILE ≥ 24 时可见，Text 对象复用避免每帧重建 */
  private zLabelLayer = new Container();
  private zLabels: Text[] = [];
  private zLabelInit = false;

  private syncZLabels(x0: number, y0: number, halfW: number, halfH: number): void {
    if (!this.zLabelInit) {
      this.zLabelInit = true;
      this.world.addChild(this.zLabelLayer);
      this.zLabelLayer.zIndex = 50;
    }
    this.zLabelLayer.visible = true;

    let idx = 0;
    for (let ty = y0; ty <= y0 + 2 * halfH; ty++) {
      for (let tx = x0; tx <= x0 + 2 * halfW; tx++) {
        const z = this.view.zAt(tx, ty);
        if (idx >= this.zLabels.length) {
          const t = new Text({
            text: '',
            style: {
              fontSize: 11,
              fill: '#ffffff',
              fontWeight: 'bold',
              stroke: { color: '#000000', width: 2.5 },
            },
          });
          t.anchor.set(0.5, 0.5);
          t.resolution = 2;
          this.zLabelLayer.addChild(t);
          this.zLabels.push(t);
        }
        const label = this.zLabels[idx];
        label.visible = true;
        label.position.set(tx * this.TILE + this.TILE / 2, ty * this.TILE + this.TILE - 4);
        label.text = `${z}`;
        idx++;
      }
    }
    for (let i = idx; i < this.zLabels.length; i++) {
      this.zLabels[i].visible = false;
    }
  }

  private redrawFloors(): void {
    const g = this.floorG;
    g.clear();
    for (const b of this.view.buildings()) {
      const def = this.view.buildingDef(b.defId);
      if (!def) continue;
      const w = def.w ?? 1;
      const h = def.h ?? 1;
      const px = b.pos.x * this.TILE;
      const py = b.pos.y * this.TILE;
      g
        .rect(px + 1, py + 1, w * this.TILE - 2, h * this.TILE - 2)
        .fill({ color: def.tags.includes('fire') ? 0x5a3a20 : 0x4a3b2c, alpha: 0.9 })
        .stroke({ width: 1.5, color: '#2a2018' });
    }
  }

  private syncEntities(): void {
    const seenPawns = new Set<number>();
    for (const p of this.view.pawns()) {
      seenPawns.add(p.eid);
      let sp = this.pawnSprites.get(p.eid);
      if (!sp) {
        sp = this.makePawn();
        this.pawnSprites.set(p.eid, sp);
        this.entityLayer.addChild(sp.root);
      }
      const s = p.pos.x * this.TILE + this.TILE / 2;
      const t = p.pos.y * this.TILE + this.TILE / 2;
      sp.root.position.set(s, t);
      sp.root.zIndex = p.pos.y;
      const key = `${p.hp}|${cardLabel(p.cardId)}|${p.trait}|${this.selected.has(p.eid) ? 1 : 0}`;
      if (sp.key !== key) {
        sp.key = key;
        redrawPawn(sp, p, this.view, this.selected.has(p.eid));
      }
      sp.root.visible = true;
    }
    for (const [eid, sp] of this.pawnSprites) {
      if (!seenPawns.has(eid)) {
        sp.root.destroy({ children: true });
        this.pawnSprites.delete(eid);
      }
    }

    // 敌对单位
    const seenHostiles = new Set<number>();
    for (const h of this.view.hostiles()) {
      seenHostiles.add(h.id);
      let g = this.hostileG.get(h.id);
      if (!g) {
        g = drawCat();
        this.hostileG.set(h.id, g);
        this.entityLayer.addChild(g);
      }
      g.position.set(h.pos.x * this.TILE + this.TILE / 2, h.pos.y * this.TILE + this.TILE / 2);
      g.zIndex = h.pos.y;
    }
    for (const [id, g] of this.hostileG) {
      if (!seenHostiles.has(id)) {
        g.destroy({ children: true });
        this.hostileG.delete(id);
      }
    }

    // 建筑图标
    const seenB = new Set<string>();
    for (const b of this.view.buildings()) {
      seenB.add(b.id);
      let g = this.buildingG.get(b.id);
      if (!g) {
        const def = this.view.buildingDef(b.defId);
        const icon = new Text({
          text: def?.tags.includes('fire') ? '🔥' : def?.tags.includes('storage') ? '📦' : '🏚',
          style: { fontSize: 22 },
        });
        icon.anchor.set(0.5, 0.62);
        g = icon;
        this.buildingG.set(b.id, g);
        this.entityLayer.addChild(g);
      }
      const def2 = this.view.buildingDef(b.defId);
      const w = def2?.w ?? 1;
      const h = def2?.h ?? 1;
      const cxp = b.pos.x * this.TILE + (w * this.TILE) / 2;
      const cyp = b.pos.y * this.TILE + (h * this.TILE) / 2;
      g.position.set(cxp, cyp);
      g.zIndex = cyp;
    }
    for (const [id, g] of this.buildingG) {
      if (!seenB.has(id)) {
        g.destroy({ children: true });
        this.buildingG.delete(id);
      }
    }

    // ---- 树 Sprite（贴图样式，实体层参与 y 排序）----
    const seenTree = new Set<string>();
    for (const ak of this.visibleTrees) {
      seenTree.add(ak);
      let sp = this.treeSprites.get(ak);
      if (!sp) {
        if (!this.treeTexture) continue;
        sp = new Sprite(this.treeTexture);
        sp.anchor.set(0.5, 1);
        this.treeSprites.set(ak, sp);
        this.entityLayer.addChild(sp);
      }
      const [ax, ay] = ak.split(',').map(Number);
      // 树 Sprite 锚在 2×2 块中心底部（anchor 0.5,1）
      const cxp = ax * this.TILE + this.TILE; // 2×2 块中心 x
      const cyp = ay * this.TILE + 2 * this.TILE; // 2×2 块底部 y
      sp.position.set(cxp, cyp);
      sp.zIndex = ay + 2; // 树底深度
      // 缩放到 2×2 格大小（纹理标称 64×64，scale 按实际像素=2*TILE/64）
      const targetSize = this.TILE * 2;
      sp.scale.set(targetSize / 64, targetSize / 64);
    }
    for (const [ak, sp] of this.treeSprites) {
      if (!seenTree.has(ak)) {
        sp.destroy();
        this.treeSprites.delete(ak);
      }
    }
  }

  private makePawn(): PawnSprite {
    const root = new Container();
    const body = new Graphics();
    const name = new Text({ text: '', style: { fontSize: 10, fill: '#ffffff' } });
    name.anchor.set(0.5, 1);
    name.position.set(0, -this.TILE * 0.7);
    const label = new Text({ text: '', style: { fontSize: 10, fill: '#ffe9a8' } });
    label.anchor.set(0.5, 0);
    label.position.set(0, this.TILE * 0.8);
    const bars = new Graphics();
    root.addChild(body, name, label, bars);
    // 单字标注
    const TAGS = ['食', '眠', '情', '智'];
    const barTags = TAGS.map((t, i) => {
      const tx = new Text({ text: t, style: { fontSize: 7, fill: '#cdd7cf' } });
      tx.anchor.set(1, 0);
      tx.position.set(-13, 20.5 + i * 3);
      root.addChild(tx);
      return tx;
    });
    const heart = new Text({ text: '❤', style: { fontSize: 7, fill: '#e08a8a' } });
    heart.anchor.set(1, 0);
    heart.position.set(-11, -23);
    root.addChild(heart);
    return { root, body, name, label, bars, barTags: [...barTags, heart], key: '' };
  }
}

function redrawPawn(sp: PawnSprite, p: import('../sim/types').PawnState, view: WorldView, selected: boolean): void {
  const b = sp.body;
  b.clear();
  if (selected) {
    b.circle(0, 0, 14).stroke({ width: 2, color: '#ffd94a' });
  }
  b.circle(0, 0, 7.5).fill(TRAIT_COLOR[p.trait] ?? '#aaaaaa');
  b.circle(-4.5, -5, 2.4).fill(TRAIT_COLOR[p.trait] ?? '#aaaaaa');
  b.circle(4.5, -5, 2.4).fill(TRAIT_COLOR[p.trait] ?? '#aaaaaa');
  sp.name.text = `${p.name}·${view.traitName(p.trait)}`;
  sp.label.text = cardLabel(p.cardId);
  const bars = sp.bars;
  bars.clear();
  const rows: [number, string][] = [
    [p.needs.food, '#d98a3a'],
    [p.needs.rest, '#4a7dc9'],
    [p.needs.mood, '#c96f9c'],
    [p.needs.san, '#8a6fc9'],
  ];
  rows.forEach(([v, c], i) => {
    bars.rect(-11, 22 + i * 3, 22 * (v / 100), 2).fill(c);
    bars.rect(-11, 22 + i * 3, 22, 2).stroke({ width: 0.5, color: '#00000044' });
  });
  bars.rect(-9, -16, 18 * Math.max(0, p.hp / p.maxHp), 2.6).fill('#7ec97e');
}

function drawCat(): Graphics {
  const g = new Graphics();
  g.ellipse(0, 0, 10, 6.5).fill('#b08ea0');
  g.poly([-5, -3, -1, -9, 2.5, -3]).fill('#b08ea0');
  g.poly([1, -3, 5, -8.5, 7, -2.5]).fill('#b08ea0');
  g.moveTo(9, 0);
  g.quadraticCurveTo(17, -6, 14, -11);
  g.stroke({ width: 2.4, color: '#b08ea0' });
  g.circle(6.5, -2, 1.2).fill('#3a2530');
  return g;
}

function appWidth(): number {
  return globalThis.innerWidth ?? 1280;
}
function appHeight(): number {
  return globalThis.innerHeight ?? 720;
}