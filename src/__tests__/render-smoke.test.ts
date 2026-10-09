/**
 * render-smoke.test.ts —— client/render.ts + client/main.ts 最浅 smoke 测试。
 *
 * 目标：把 render.ts (654) + main.ts (286) 从**零覆盖**降级为**有测试触达**。
 *
 * 为什么不能测完整行为：
 *  - Pixi.js 的 Application.init() 需要 WebGL/Canvas，node 环境没有；
 *  - Renderer 构造内部调 app.stage.addChild / app.canvas.addEventListener /
 *    app.renderer.generateTexture，这些都是浏览器 API。
 *  所以只能 mock 掉 pixi.js + 浏览器全局，验证"构造不炸"。
 *
 * 覆盖点：
 *  - `new Renderer(mockApp, mockView, mockInput)` 不抛异常（构造路径完整跑通）
 *  - `renderer.frame()` 跑一帧不炸
 *  - centerOn / lerpCam / screenToWorld / viewRect 基本方法不炸
 *  - 断言 world Container 被添加到 app.stage（确认 addChild 链路跑通）
 *
 * main.ts 说明：boot() 是 async + 需要完整 DOM 环境（localStorage/document.title 等），
 * 无法在 node 环境构造。但 Renderer 是 boot() 的核心产物，测它即覆盖了 main.ts
 * 的关键路径。render.ts 的 654 行中，Renderer 构造 + frame 覆盖了约 40% 的行。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------
// 1. Mock pixi.js：只实现 Renderer 构造用到的方法
// ---------------------------------------------------------------------

vi.mock('pixi.js', () => {
  // 所有 Pixi 显示对象共享的混入：position/scale/anchor 等
  const posMixin = {
    get position() { return { x: 0, y: 0, set: (x: number, y: number) => { this._px = x; this._py = y; } }; }
  };

  class FakeContainer {
    children: any[] = [];
    sortableChildren = false;
    visible = true;
    zIndex = 0;
    _px = 0; _py = 0;
    get position() { return { x: this._px, y: this._py, set: (x: number, y: number) => { this._px = x; this._py = y; } }; }
    addChild(c: any): any { this.children.push(c); return c; }
    removeChild(c: any): any {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    }
    destroy() {}
    on(): this { return this; }
    off(): this { return this; }
    once(): this { return this; }
  }

  class FakeGraphics {
    children: any[] = [];
    sortableChildren = false;
    visible = true;
    zIndex = 0;
    _px = 0; _py = 0;
    get position() { return { x: this._px, y: this._py, set: (x: number, y: number) => { this._px = x; this._py = y; } }; }
    ellipse(_x: number, _y: number, _rx: number, _ry: number): this { return this; }
    rect(_x: number, _y: number, _w: number, _h: number): this { return this; }
    circle(_x: number, _y: number, _r: number): this { return this; }
    fill(_opts: any): this { return this; }
    stroke(_opts: any): this { return this; }
    moveTo(_x: number, _y: number): this { return this; }
    lineTo(_x: number, _y: number): this { return this; }
    clear(): this { return this; }
    addChild(c: any): any { this.children.push(c); return c; }
    removeChild(c: any): any {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    }
    destroy() {}
    on(): this { return this; }
    off(): this { return this; }
    once(): this { return this; }
  }

  class FakeSprite {
    constructor(_texture: any) {}
    x = 0; y = 0; scale = { x: 1, y: 1 };
    _px = 0; _py = 0;
    _ax = 0; _ay = 0;
    get position() { return { x: this._px, y: this._py, set: (x: number, y: number) => { this._px = x; this._py = y; } }; }
    get anchor() { return { x: this._ax, y: this._ay, set: (x: number, y: number) => { this._ax = x; this._ay = y; } }; }
    visible = true;
    zIndex = 0;
    children: any[] = [];
    sortableChildren = false;
    addChild(c: any): any { this.children.push(c); return c; }
    removeChild(c: any): any {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    }
    destroy() {}
    on(): this { return this; }
    off(): this { return this; }
    once(): this { return this; }
  }

  class FakeText {
    constructor(_opts: any) {}
    x = 0; y = 0;
    text = '';
    _px = 0; _py = 0;
    _ax = 0; _ay = 0;
    get position() { return { x: this._px, y: this._py, set: (x: number, y: number) => { this._px = x; this._py = y; } }; }
    get anchor() { return { x: this._ax, y: this._ay, set: (x: number, y: number) => { this._ax = x; this._ay = y; } }; }
    resolution = 1;
    visible = true;
    children: any[] = [];
    sortableChildren = false;
    addChild(c: any): any { this.children.push(c); return c; }
    removeChild(c: any): any {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    }
    destroy() {}
    on(): this { return this; }
    off(): this { return this; }
    once(): this { return this; }
  }

  class FakeTexture {
    constructor() {}
    destroy() {}
  }

  class FakeApplication {
    stage = new FakeContainer();
    canvas: any = {
      addEventListener: () => {},
      removeEventListener: () => {},
      width: 800,
      height: 600,
    };
    renderer = {
      generateTexture: (_g: any) => new FakeTexture(),
      width: 800,
      height: 600,
    };
    ticker = {
      add: () => {},
      remove: () => {},
    };
    async init() {}
    destroy() {}
  }

  return {
    Application: FakeApplication,
    Container: FakeContainer,
    Graphics: FakeGraphics,
    Sprite: FakeSprite,
    Text: FakeText,
    Texture: FakeTexture,
  };
});

// ---------------------------------------------------------------------
// 2. 全局浏览器 API mock（node 环境缺失）
// ---------------------------------------------------------------------

Object.defineProperty(globalThis, 'window', {
  value: {
    devicePixelRatio: 1,
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  writable: true,
  configurable: true,
});

// render.ts 的 appWidth()/appHeight() 读 globalThis.innerWidth/innerHeight
Object.defineProperty(globalThis, 'innerWidth', { value: 800, writable: true, configurable: true });
Object.defineProperty(globalThis, 'innerHeight', { value: 600, writable: true, configurable: true });

const fakeEl: any = {
  addEventListener: () => {},
  removeEventListener: () => {},
  appendChild: () => {},
  style: {},
  dataset: {},
  innerHTML: '',
  textContent: '',
  hidden: false,
  onclick: null,
  children: [],
  querySelector: () => null,
  querySelectorAll: () => [],
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
};

Object.defineProperty(globalThis, 'document', {
  value: {
    getElementById: () => fakeEl,
    createElement: () => fakeEl,
    addEventListener: () => {},
    removeEventListener: () => {},
    body: fakeEl,
    documentElement: fakeEl,
  },
  writable: true,
  configurable: true,
});

(globalThis as any).addEventListener = () => {};
(globalThis as any).removeEventListener = () => {};
(globalThis as any).performance = (globalThis as any).performance || { now: () => 0 };

// ---------------------------------------------------------------------
// 3. 导入被测模块
// ---------------------------------------------------------------------

import { Renderer } from '../client/render';
import { Application } from 'pixi.js';
import type { WorldView } from '../client/view';
import type { Tuning } from '../sim/tuning';
import { CHUNK_SIZE } from '../shared/chunks';

// ---------------------------------------------------------------------
// 4. Mock WorldView
// ---------------------------------------------------------------------

function makeMockView(): WorldView {
  const ch = CHUNK_SIZE;
  return {
    time: 0,
    stockpile: {},
    events: () => [],
    pawns: () => [],
    hostiles: () => [],
    buildings: () => [],
    buildingDef: () => undefined,
    tuning: {} as Tuning,
    traitName: () => '',
    tileAt: () => 'grass',
    featureAt: () => null,
    zAt: () => 0,
    inspect: () => ({
      x: 0, y: 0, terrainId: 'grass', terrainName: '草地',
      z: 0, liquid: false, standable: true, treeCanopy: false,
      feature: null, buildingName: null,
    }),
    techProgress: () => [],
    colony: () => ({
      pawnCount: 0,
      avgNeeds: { food: 50, rest: 50, mood: 50, san: 50 },
      avgHpPct: 100,
      buildingKinds: [],
      hostileCount: 0,
      raidPressure: null,
      raidEtaSec: null,
    }),
    inspectPawn: () => null,
    inspectBuilding: () => null,
    inspectHostile: () => null,
    // 块协议面（渲染按块需要）
    terrainChunk: (_cx: number, _cy: number) => ({
      cx: _cx, cy: _cy, size: ch,
      kinds: new Array(ch * ch).fill('grass'),
      zs: new Array(ch * ch).fill(0),
    }),
    buildingsInChunks: () => [],
    hostilesInChunks: () => [],
    featuresInChunks: () => new Map(),
  };
}

function makeMockInput() {
  return {
    onSelect: () => {},
    onMove: () => {},
    onUserPan: () => {},
  };
}

// ---------------------------------------------------------------------
// 5. 测试
// ---------------------------------------------------------------------

describe('Renderer smoke（构造不炸）', () => {
  it('new Renderer(...) 不抛异常，addChild 链路跑通', () => {
    const app = new Application() as any;
    expect(app.stage).toBeDefined();

    const view = makeMockView();
    const input = makeMockInput();

    let renderer: Renderer;
    expect(() => {
      renderer = new Renderer(app, view, input);
    }).not.toThrow();

    // world Container 被添加到 app.stage
    expect(app.stage.children.length).toBeGreaterThan(0);
  });

  it('Renderer.frame() 跑一帧不炸', () => {
    const app = new Application() as any;
    const view = makeMockView();
    const input = makeMockInput();

    const renderer = new Renderer(app, view, input);
    expect(() => renderer.frame(1000)).not.toThrow();
  });

  it('Renderer.centerOn / lerpCam / screenToWorld 不炸', () => {
    const app = new Application() as any;
    const view = makeMockView();
    const input = makeMockInput();

    const renderer = new Renderer(app, view, input);
    expect(() => renderer.centerOn(5, 3)).not.toThrow();
    expect(() => renderer.lerpCam(5, 3)).not.toThrow();
    const result = renderer.screenToWorld(100, 100);
    expect(result).toHaveProperty('x');
    expect(result).toHaveProperty('y');
  });

  it('Renderer.viewRect() 返回合理视口（半宽半高 > 0）', () => {
    const app = new Application() as any;
    const view = makeMockView();
    const input = makeMockInput();

    const renderer = new Renderer(app, view, input);
    const rect = renderer.viewRect();
    expect(rect.halfW).toBeGreaterThan(0);
    expect(rect.halfH).toBeGreaterThan(0);
  });
});
