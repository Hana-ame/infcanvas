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
import { eidsInRect } from './selection';

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
  /** R1-4 框选：一次选中一批（单击点选走 onSelect，两者不冲突——拖动阈值区分） */
  onSelectMany?(eids: number[]): void;
  /**
   * R3-HUD：点中**建筑/敌袭单位**（而不是鼠）时上报。HUD 详情面板据此展示
   * 建筑明细（种类/耐久/燃料）或敌袭单位档案（血量/距离/是否警戒）。
   * 命中优先级：鼠 > 敌袭 > 建筑（离镜头中心更近的优先）；全空则三个都 null。
   */
  onPickNonPawn?(pick: { buildingId: string | null; hostileId: number | null }): void;
  onMove(x: number, y: number): void;
  onUserPan?(): void;
}

export class Renderer {
  private world = new Container();
  private gameContainer = new Container();
  private terrainG = new Graphics();
  private floorG = new Graphics();
  private entityLayer = new Container();
  /** 框选矩形图层（R1-4）：单独一层，画在实体之上且不参与 y 排序 */
  private boxG = new Graphics();
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
    this.gameContainer.addChild(this.boxG);
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
  /**
   * 拖拽会话。R1-4 之后左键拖不再是「平移」而是「画选框」，
   * 所以这个结构体必须同时承载两种意图，靠 kind 区分。
   */
  private drag:
    | {
        kind: 'pan';
        sx: number;
        sy: number;
        cx: number;
        cy: number;
        /** 0=左键(带空格) 1=中键 2=右键。右键不带拖动时是「指挥移动」而非平移 */
        button: number;
      }
    | { kind: 'box'; sx: number; sy: number }
    | null = null;
  /** 空格按住 = 平移修饰键（左键拖画框时用） */
  private spaceHeld = false;
  /** 框选矩形（屏幕坐标；null = 当前没在画框） */
  private boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** 框选命中集合（每帧从权威 pawns 计算） */
  private boxHits: number[] = [];
  /**
   * 屏幕矩形 → 命中哪些实体的 eid（R1-4）。
   * 只做「屏幕→世界」的换算，判定本身交给 selection.ts 的纯函数。
   *
   * 判据用 view.pawns() 的**权威**坐标而非插值坐标：插值会让「框住」在边缘飘忽，
   * 而命令要对的是服务端事实——所见未必所得在这里是有意为之。
   */
  eidsInBox(r: { x0: number; y0: number; x1: number; y1: number }): number[] {
    // 先在屏幕上归一（反向拖拽也要得到同一个矩形），再换算成世界矩形
    const minX = Math.min(r.x0, r.x1);
    const maxX = Math.max(r.x0, r.x1);
    const minY = Math.min(r.y0, r.y1);
    const maxY = Math.max(r.y0, r.y1);
    const a = this.toWorld(minX, minY);
    const b = this.toWorld(maxX, maxY);
    return eidsInRect({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }, this.view.pawns());
  }

  /**
   * R3-HUD：点中非鼠目标（敌袭单位 / 建筑）时上报，供 HUD 详情面板展示。
   *
   * 命中阈值按"看得见的精灵尺寸"给：敌人画得比鼠小，阈值相应收紧（1.2 → 0.9），
   * 否则在密集营地里点篝火很容易误判成旁边的鼠。
   *
   * 敌袭优先于建筑：敌袭是**当前威胁**，玩家在危机时刻点东西时，多半是想看威胁，
   * 而不是想看篝火耐久。渲染层零逻辑——只做命中判定并上报，优先级是表现层选择。
   */
  private pickNonPawn(wx: number, wy: number): void {
    let hostileId: number | null = null;
    let hBest = 0.9;
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
    let bBest = 1.0;
    for (const b of this.view.buildings()) {
      const def = this.view.buildingDef(b.defId);
      // 多格建筑（棚屋/仓库 2×2）：命中任一占位格都算选中，否则只能点左上角
      const w = def?.w ?? 1;
      const h2 = def?.h ?? 1;
      const dx = Math.max(b.pos.x - wx, 0, wx - (b.pos.x + w - 1));
      const dy = Math.max(b.pos.y - wy, 0, wy - (b.pos.y + h2 - 1));
      const d = Math.hypot(dx, dy);
      if (d <= bBest) {
        bBest = d;
        buildingId = b.id;
      }
    }
    this.input.onPickNonPawn?.({ buildingId, hostileId: null });
  }

  /**
   * 把选框画在实体层之上。
   * 为什么用世界坐标而非屏幕坐标：相机一直在动，屏幕坐标的框会「粘」在屏幕上
   * 相对地平移，看起来像是框跟着鼠标跑而不是框住世界。
   */
  private drawBox(g: Graphics): void {
    if (!this.boxRect) return;
    const a = this.toWorld(this.boxRect.x0, this.boxRect.y0);
    const b = this.toWorld(this.boxRect.x1, this.boxRect.y1);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    g.rect(x * this.TILE, y * this.TILE, Math.abs(b.x - a.x) * this.TILE, Math.abs(b.y - a.y) * this.TILE)
      .fill({ color: 0x7ec97e, alpha: 0.15 })
      .stroke({ color: 0x7ec97e, alpha: 0.9, width: 1.5 });
  }

  private bindInput(): void {
    const cv = this.app.canvas;
    // 左键（或按住空格时的左键）拖拽=画选框；中键/右键拖=平移。
    // 为什么不把左键平移留着：框选需要「按下—拖动—抬起」这条手势，
    // 若左键仍平移就与之冲突。改用中键/右键拖 + 空格+左键拖 两条平移入口。
    cv.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.drag = this.spaceHeld
          ? { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: this.cam.x, cy: this.cam.y, button: 0 }
          : { kind: 'box', sx: e.clientX, sy: e.clientY };
        if (!this.spaceHeld) this.boxRect = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
        return;
      }
      if (e.button === 1 || e.button === 2) {
        // 中键拖 = 平移；中键还要显式 preventDefault，否则浏览器会开自动滚动条
        if (e.button === 1) e.preventDefault();
        // 右键：先记下位置，等 mouseup 时看是否拖动过——拖了=平移，没拖=指挥移动。
        // 右键在抬起时才决定语义，是为了让「右键单击=指挥」这个高频操作不被拖动判断误伤。
        this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: this.cam.x, cy: this.cam.y, button: e.button };
      }
    });
    // 空格 = 平移修饰键。与 main.ts 的空格暂停冲突——这里按住不放才是平移，
    // 单击（按下即松开）才触发暂停，见 keyup 分支的说明。
    addEventListener('keydown', (e) => {
      if (e.code === 'Space') this.spaceHeld = true;
    });
    addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceHeld = false;
    });
    addEventListener('mousemove', (e) => {
      const d = this.drag;
      if (!d) return;
      if (d.kind === 'box') {
        this.boxRect = { x0: d.sx, y0: d.sy, x1: e.clientX, y1: e.clientY };
        return;
      }
      this.cam.x = d.cx - (e.clientX - d.sx) / this.TILE;
      this.cam.y = d.cy - (e.clientY - d.sy) / this.TILE;
      this.input.onUserPan?.();
    });
    addEventListener('mouseup', (e) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      if (d.kind === 'box') {
        const moved = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
        this.boxRect = null;
        if (moved > 5) {
          // 拖动过 = 框选：一次选中框内全部（R1-4）
          this.boxHits = this.eidsInBox({ x0: d.sx, y0: d.sy, x1: e.clientX, y1: e.clientY });
          this.input.onSelectMany?.(this.boxHits);
          return;
        }
        // 没拖动 = 普通点选（保持原有单击选单只的手感）
        const w = this.toWorld(e.clientX, e.clientY);
        let hit: number | null = null;
        for (const p of this.view.pawns()) {
          if (Math.hypot(p.pos.x - w.x, p.pos.y - w.y) <= 1.2) hit = p.eid;
        }
        this.input.onSelect(hit);
        // R3-HUD：没点到鼠才去点建筑/敌人（点中鼠时清空另外两格选中，语义单一）
        if (!hit) this.pickNonPawn(w.x, w.y);
        return;
      }
      // 平移：拖动过才算平移（并通知上层关掉相机跟随，否则两个力打架）
      if (d.kind === 'pan') {
        const moved = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 5;
        if (d.button === 2 && !moved) {
          // 右键单击 = 指挥选中的一批鼠移动到此处（R1-4：eids 是数组，批量天然支持）
          const w = this.toWorld(e.clientX, e.clientY);
          this.input.onMove(Math.round(w.x), Math.round(w.y));
          return;
        }
        if (moved) this.input.onUserPan?.();
      }
    });
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault(); // 右键菜单会打断拖拽手势；指挥改在 mouseup 里发
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
    this.syncEntities(nowMs);
    // 选框层每帧重画：内容只有一条矩形，开销可忽略（Graphics.clear 后重画）
    this.boxG.clear();
    this.drawBox(this.boxG);
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

  private syncEntities(nowMs: number): void {
    const seenPawns = new Set<number>();
    for (const p of this.view.pawns()) {
      seenPawns.add(p.eid);
      let sp = this.pawnSprites.get(p.eid);
      if (!sp) {
        sp = this.makePawn();
        this.pawnSprites.set(p.eid, sp);
        this.entityLayer.addChild(sp.root);
      }
      // R1-3：绘制位置优先用渲染层插值坐标（联机），无该能力时回退权威 pos（本地）。
      // 只影响「画在哪」，不影响命中判定——mouseup 里命中仍读 view.pawns() 的 p.pos。
      const draw = this.view.renderPos?.(p.eid, nowMs) ?? p.pos;
      const s = draw.x * this.TILE + this.TILE / 2;
      const t = draw.y * this.TILE + this.TILE / 2;
      sp.root.position.set(s, t);
      sp.root.zIndex = draw.y;
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
          text: def?.tags.includes('fire')
            ? '🔥'
            : def?.tags.includes('storage')
              ? '📦'
              : def?.tags.includes('field')
                ? '🌾' // 农田：与棚屋 🏚 区分，否则全部落到兜底图标（表现层契约，见 PLAYING 图例）
                : '🏚',
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