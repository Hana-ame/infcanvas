/**
 * render-cache.test.ts —— 渲染缓存层测试（r 线拆分第二刀）。
 *
 * 目标：验证 RenderCache 的块烘焙 / 同步 / 驱逐逻辑，不依赖真实 Pixi。
 * 用 `await import` 确保 mock 在 pixi.js 被引用前生效。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChunkTerrain } from '../client/view';
import { CHUNK_SIZE } from '../shared/chunks';

// ---------------------------------------------------------------------
// Mock pixi.js（vitest hoists 到文件顶部）
// ---------------------------------------------------------------------

vi.mock('pixi.js', () => {
  const eventMethods = {
    emit() { return this; },
    on() { return this; },
    off() { return this; },
    once() { return this; },
    addListener() { return this; },
    removeListener() { return this; },
  };

  class _Container {
    children: any[] = [];
    _px = 0; _py = 0; _destroyed = false; parent: any = null;
    constructor() { Object.assign(this, eventMethods); }
    get position() { return { x: this._px, y: this._py, set: (x: number, y: number) => { this._px = x; this._py = y; } }; }
    addChild(c: any): any { this.children.push(c); c.parent = this; return c; }
    removeChild(c: any): any {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    }
    destroy(_opts?: any) { this._destroyed = true; this.children = []; }
  }

  class _Graphics {
    children: any[] = [];
    _px = 0; _py = 0; _destroyed = false; parent: any = null;
    constructor() { Object.assign(this, eventMethods); }
    get position() { return { x: this._px, y: this._py, set: (x: number, y: number) => { this._px = x; this._py = y; } }; }
    rect(_x: number, _y: number, _w: number, _h: number): this { return this; }
    fill(_color: any): this { return this; }
    circle(_x: number, _y: number, _r: number): this { return this; }
    clear(): this { return this; }
    destroy(_opts?: any) { this._destroyed = true; }
    addChild(c: any): any { this.children.push(c); return c; }
    removeChild(c: any): any {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    }
  }

  return {
    Container: _Container,
    Graphics: _Graphics,
    Sprite: class {
      x = 0; y = 0; scale: any = { x: 1, y: 1 };
      _px = 0; _py = 0; _ax = 0; _ay = 0;
      visible = true; zIndex = 0; children: any[] = []; parent: any = null;
      constructor() { Object.assign(this, eventMethods); }
      get position() { return { x: this._px, y: this._py, set: (x: number, y: number) => { this._px = x; this._py = y; } }; }
      get anchor() { return { x: this._ax, y: this._ay, set: (x: number, y: number) => { this._ax = x; this._ay = y; } }; }
      addChild(c: any): any { this.children.push(c); return c; }
      destroy(_opts?: any) { this._destroyed = true; }
    },
    Text: class {
      x = 0; y = 0; text = '';
      _px = 0; _py = 0; _ax = 0; _ay = 0;
      resolution = 1; visible = true; children: any[] = []; parent: any = null;
      constructor() { Object.assign(this, eventMethods); }
      get position() { return { x: this._px, y: this._py, set: (x: number, y: number) => { this._px = x; this._py = y; } }; }
      get anchor() { return { x: this._ax, y: this._ay, set: (x: number, y: number) => { this._ax = x; this._ay = y; } }; }
      addChild(c: any): any { this.children.push(c); return c; }
      destroy(_opts?: any) { this._destroyed = true; }
    },
    Texture: class {
      constructor() { Object.assign(this, eventMethods); }
      destroy(_opts?: any) {}
    },
    Application: class {
      stage: any = null;
      canvas: any = { addEventListener: () => {}, style: {} };
      renderer: any = { generateTexture: () => ({ destroy: () => {} }) };
      ticker: any = { add: () => {}, remove: () => {} };
      constructor() { this.stage = new _Container(); }
      async init() { /* noop */ }
      destroy() {}
    },
  };
});

// ---------------------------------------------------------------------
// 测试：所有 pixi.js 依赖都在动态 import 内使用
// ---------------------------------------------------------------------

function makeDummyTerrain(cx: number, cy: number): ChunkTerrain {
  const size = CHUNK_SIZE;
  const kinds: string[] = new Array(size * size).fill('grass');
  const zs: number[] = new Array(size * size).fill(0);
  return { cx, cy, size, kinds, zs };
}

describe('RenderCache 构造与烘焙', () => {
  async function setup() {
    const { Container } = await import('pixi.js');
    const { RenderCache } = await import('../client/render-cache');
    return { Container, RenderCache };
  }

  it('构造不炸', async () => {
    const { Container, RenderCache } = await setup();
    const layer = new Container();
    const cache = new RenderCache(
      { terrainChunk: (cx, cy) => makeDummyTerrain(cx, cy) },
      layer,
    );
    expect(cache.chunkCount).toBe(0);
  });

  it('sync 加载视口内的块', async () => {
    const { Container, RenderCache } = await setup();
    const layer = new Container();
    const cache = new RenderCache(
      { terrainChunk: (cx, cy) => makeDummyTerrain(cx, cy) },
      layer,
      { maxChunks: 256 },
    );
    cache.sync(0, 0, 63, 63);
    expect(cache.chunkCount).toBe(1);
    cache.sync(0, 0, 127, 127);
    expect(cache.chunkCount).toBe(4);
  });

  it('重复 sync 同一视口不增加块数（缓存命中）', async () => {
    const { Container, RenderCache } = await setup();
    const layer = new Container();
    const cache = new RenderCache(
      { terrainChunk: (cx, cy) => makeDummyTerrain(cx, cy) },
      layer,
      { maxChunks: 256 },
    );
    cache.sync(0, 0, 127, 127);
    expect(cache.chunkCount).toBe(4);
    cache.sync(0, 0, 127, 127);
    cache.sync(0, 0, 127, 127);
    expect(cache.chunkCount).toBe(4);
  });

  it('移出视口后块被驱逐', async () => {
    const { Container, RenderCache } = await setup();
    const layer = new Container();
    const cache = new RenderCache(
      { terrainChunk: (cx, cy) => makeDummyTerrain(cx, cy) },
      layer,
      { maxChunks: 256 },
    );
    // 视口覆盖 0..63 tile → 1 块 (cx=0, cy=0)
    cache.sync(0, 0, 63, 63);
    expect(cache.chunkCount).toBe(1);
    // 移到远处：960..1023 tile → 1 块 (cx=15, cy=15)
    cache.sync(960, 960, 1023, 1023);
    expect(cache.chunkCount).toBe(1); // 旧块被驱逐，新块加载 = 还是 1 块
    expect(layer.children.length).toBe(1); // 只有新块
  });

  it('clear 释放全部缓存', async () => {
    const { Container, RenderCache } = await setup();
    const layer = new Container();
    const cache = new RenderCache(
      { terrainChunk: (cx, cy) => makeDummyTerrain(cx, cy) },
      layer,
      { maxChunks: 256 },
    );
    cache.sync(0, 0, 127, 127);
    expect(cache.chunkCount).toBe(4);
    cache.clear();
    expect(cache.chunkCount).toBe(0);
    expect(layer.children.length).toBe(0);
  });

  it('超出 maxChunks 驱逐远处块', async () => {
    const { Container, RenderCache } = await setup();
    const layer = new Container();
    const cache = new RenderCache(
      { terrainChunk: (cx, cy) => makeDummyTerrain(cx, cy) },
      layer,
      { maxChunks: 4 },
    );
    cache.sync(0, 0, 127, 127);
    expect(cache.chunkCount).toBe(4);
    cache.sync(1000, 1000, 1127, 1127);
    expect(cache.chunkCount).toBe(4);
    expect(layer.children.length).toBe(4);
  });
});
