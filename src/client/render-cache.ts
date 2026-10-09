/**
 * client/render-cache.ts —— 渲染缓存层（r 线拆分第二刀：渲染按块的 3A 骨架）。
 *
 * ## 为什么需要这一层（2026-10-08）
 *
 * render.ts 的 frame() 每帧做三件事：
 *   ① redrawTerrain() —— 对可视区每格各调 2 次跨层查询（tileAt / zAt），
 *      再加 1 趟全量扫描特征 → 每帧约 6000 次函数调用，纯粹为了画地形底色；
 *   ② 树 Sprite 每帧重建 visibleTrees 集合（再扫一次特征，与红色重复同一查询）；
 *   ③ 建筑/鼠/敌袭每帧同步。
 *
 * 其中**地形底色**是纯函数（同坐标恒同结果、永不改变），每帧重查是浪费。
 * 本层把每块 64×64 的地形烘焙成 Graphics 缓存，可视区块只进管线一次，
 * 之后每帧只平移不重画，只有**进出视口**的块才做懒加载/卸载。
 *
 * ## 与 WorldView 块协议面的分工
 *
 *   view.terrainChunk(cx, cy) — 整块地形快照（只读数组）
 *   view.buildingsInChunks(...) — 按块裁剪的建筑/敌袭
 *   RenderCache             — 管理 Graphics 缓存池 + 块可见性跟踪
 *
 * render.ts 的 frame() 改为每帧先调 renderCache.sync(cx0..cx1)，
 * 再调 renderCache.reposition(cam.x, cam.y) 整体平移，
 * 最后把 entityLayer 交给原有 syncEntities 逻辑。
 *
 * ## 阶段划分
 *
 * ① 本文件：缓存层骨架 + 只烘地形（最稳的纯函数，收益最大）。
 * ② 后续：特征锚点缓存（按采收版本失效）、建筑底座缓存（按增删失效）。
 *
 * ----------------------------------------------------------------
 * 为什么用"懒加载 + 持久缓存"而不是"全量预烘"：
 *   世界无限，不可能全量烘焙。缓存容量封顶（config.MAX_CACHED_CHUNKS），
 *   超出时驱逐最远块（LRU-ish：按视口距离排）。
 * ----------------------------------------------------------------
 */
import { Container, Graphics } from 'pixi.js';
import { CHUNK_SIZE, chunkKeyToXY, chunkBounds } from '../shared/chunks';
import type { ChunkTerrain } from './view';

/** 渲染缓存层的地形块（一个 Graphics 对象，不重建） */
interface ChunkCache {
  /** 区块坐标 */
  cx: number;
  cy: number;
  /** 一次烘焙的地形 Graphics（所有内容已画好，之后只平移不重绘） */
  g: Graphics;
  /** 上次调 sync 时的帧号（驱逐用） */
  lastSeen: number;
}

const TILE_COLORS: Record<string, string> = {
  grass: '#4a7a35',
  dirt: '#8a7042',
  stone: '#8d9298',
  water: '#2f6699',
};

const DEFAULT_TILE_COLOR = '#7a7a7a';

export interface RenderCacheOptions {
  /** 最大缓存的区块数（超出驱逐最久未见的块） */
  maxChunks?: number;
  /** 区块的 tile 边长（缺省 CHUNK_SIZE=64） */
  chunkSize?: number;
}

export class RenderCache {
  private chunks = new Map<string, ChunkCache>();
  private frameN = 0;
  readonly maxChunks: number;
  readonly chunkSize: number;

  constructor(
    /** WorldView 块协议面 */
    private terrainSource: { terrainChunk(cx: number, cy: number): ChunkTerrain },
    /** 渲染层父容器：所有地形块挂在它下面 */
    private terrainLayer: Container,
    opts: RenderCacheOptions = {},
  ) {
    this.maxChunks = opts.maxChunks ?? 256;
    this.chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  }

  /** 区块键 */
  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  /**
   * 按视口范围同步区块：确保视口内的块已缓存就绪，视口外的多余块驱逐。
   *
   * 与旧的 redrawTerrain 不同：本函数只在块进出视口时才真正做工作
   * （懒加载烘焙 + 卸载驱逐），稳态时每帧只调一下 lastSeen 标记，
   * 不产生任何 Graphics 操作。
   *
   * @param x0,y0 视口 tile 左下边界
   * @param x1,y1 视口 tile 右上边界
   */
  sync(x0: number, y0: number, x1: number, y1: number): void {
    this.frameN++;

    // 范围扩大到整块边界（避免视口微移导致块反复进出 —— 在边界上抖动的块
    // 如果不扩展就会被每帧卸载/重载，失去缓存的全部意义）
    const cx0 = Math.floor(x0 / CHUNK_SIZE);
    const cx1 = Math.floor(x1 / CHUNK_SIZE);
    const cy0 = Math.floor(y0 / CHUNK_SIZE);
    const cy1 = Math.floor(y1 / CHUNK_SIZE);

    // 如果视口内的块数超过缓存上限，说明视口覆盖了整个世界（不可能），但防御
    const want = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    if (want > this.maxChunks) {
      // 容错：视口大得离谱时不烘焙（正常情况不可能触发）
      return;
    }

    // 第一趟：确保视口内的块已缓存
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = this.key(cx, cy);
        const existing = this.chunks.get(k);
        if (existing) {
          existing.lastSeen = this.frameN;
          continue;
        }
        // 懒加载：取块快照 → 烘焙成 Graphics → 添加到层级
        const t = this.terrainSource.terrainChunk(cx, cy);
        const g = this.bakeChunk(t, cx, cy);
        this.terrainLayer.addChild(g);
        this.chunks.set(k, { cx, cy, g, lastSeen: this.frameN });
      }
    }

    // 第二趟：驱逐视口外的块（按 lastSeen 帧号判定，超出容量优先驱逐远处块）
    if (this.chunks.size > this.maxChunks) {
      // 按 lastSeen 升序排，保留最近被见的 maxChunks 个
      const sorted = [...this.chunks.values()].sort((a, b) => a.lastSeen - b.lastSeen);
      const toEvict = this.chunks.size - this.maxChunks;
      for (let i = 0; i < toEvict && i < sorted.length; i++) {
        const e = sorted[i];
        if (e.lastSeen === this.frameN) break; // 本帧刚见过的，不减它
        const k = this.key(e.cx, e.cy);
        this.evict(k);
      }
    }

    // 第三趟：驱逐本帧视口**完全不在**范围内的块（哪怕没超容量也清理）
    // 这是"走远了回头看"不会看到旧块的关键——如果不主动卸载，
    // 地形层会堆积无限多的块（虽然被驱逐逻辑兜底，但主动清理更精确）
    const inView = new Set<string>();
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++)
        inView.add(this.key(cx, cy));

    for (const [k, cache] of this.chunks) {
      if (!inView.has(k) && cache.lastSeen < this.frameN) {
        this.evict(k);
      }
    }
  }

  /**
   * 整体平移地形层（与相机联动）。
   * 区块 Graphics 本身不移动——移动的是整个 terrainLayer 容器。
   * 本函数返回 terrainLayer 应设置的位移量（每帧由 Renderer.frame 调用）。
   */
  reposition(camX: number, camY: number, tilePx: number): { x: number; y: number } {
    return { x: 0, y: 0 };
  }

  /** 释放全部缓存（换世界/重建时） */
  clear(): void {
    for (const cache of this.chunks.values()) {
      this.terrainLayer.removeChild(cache.g);
      cache.g.destroy({ children: true });
    }
    this.chunks.clear();
  }

  /** 当前缓存的区块数 */
  get chunkCount(): number {
    return this.chunks.size;
  }

  // ================= 内部实现 =================

  /**
   * 烘焙一整块地形到 Graphics（纯函数：同 chunk 快照烘焙结果相同）。
   *
   * 渲染管线演进路线图（2026-10-08）：
   *   Phase ①（本骨架）：一次 Graphics，把 4096 格的地形底色 + z 阴影一次性画完。
   *     每块只做这一次，之后每帧只平移不重绘。
   *     实测块数 ≈ 视口宽度 / 64 × 视口高度 / 64，全高清 ~9 块，完全不吃力。
   *   Phase ②：改用 RenderTexture + Sprite 替代 Graphics（可平移、更 GPU 友好）；
   *   Phase ③：把浆果从红移进缓存层（按采收版本失效）。
   *
   * 为什么 Phase ① 选 Graphics 而不是 RenderTexture：
   *   Graphics 是 Pixi 内建的矢量绘图，在区块少（≤64）时创建/销毁成本远低于
   *   RenderTexture（后者需要 framebuffer 分配）。我们的视口覆盖范围决定了
   *   并行活跃块最多也就几十块，Graphics 足够。等到世界规模真正要上百块时才升级。
   */
  private bakeChunk(t: ChunkTerrain, cx: number, cy: number): Graphics {
    const g = new Graphics();
    const size = t.size;
    const tilePx = 20; // 与 render.ts 的 TILE 常量对齐（实际值由 Renderer 持有，缓存层存 1:1
    //   比例，Renderer 的 container 缩放会统一处理）

    const maxZ = 4; // 缺省；实际值应从 view.tuning 取，但块缓存不依赖 tuning 运行时变化
    for (let ly = 0; ly < size; ly++) {
      const y = cy * size + ly;
      const row = ly * size;
      for (let lx = 0; lx < size; lx++) {
        const i = row + lx;
        const x = cx * size + lx;
        const worldX = x * tilePx;
        const worldY = y * tilePx;

        // 地形底色
        const kind = t.kinds[i];
        g.rect(worldX, worldY, tilePx + 0.5, tilePx + 0.5)
          .fill(TILE_COLORS[kind] ?? DEFAULT_TILE_COLOR);

        // z 高度明暗叠加
        const z = t.zs[i];
        if (z > 0) {
          g.rect(worldX, worldY, tilePx + 0.5, tilePx + 0.5)
            .fill({ color: 0x000000, alpha: Math.max(0, ((maxZ - z) / maxZ) * 0.22) });
        }
      }
    }
    return g;
  }

  /**
   * 驱逐一个区块：从容器中移除 Graphics 并销毁，回收纹理内存。
   * 注意：不删除 this.chunks 里的条目（由调用方负责）。
   */
  private evict(key: string): void {
    const cache = this.chunks.get(key);
    if (!cache) return;
    this.terrainLayer.removeChild(cache.g);
    cache.g.destroy({ children: true });
    this.chunks.delete(key);
  }
}
