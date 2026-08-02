// infcanvas 入口 —— P0 单机可玩版
import { Sim } from '../sim/sim';
import { Renderer } from './renderer';
import { BUILDINGS } from '../sim/defs';

// DOM UI 容器
function createUI(): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:8px 12px;background:rgba(0,0,0,.5);color:#eee;font:12px/1.4 system-ui;z-index:10;pointer-events:none;display:flex;gap:16px;align-items:center;';
  document.body.appendChild(el);
  return el;
}

async function main(): Promise<void> {
  const container = document.getElementById('app')!;

  const sim = new Sim({ seed: 20260803, pawnCount: 4 });
  const renderer = new Renderer(sim);
  await renderer.init(container);

  // 地形/建筑一次性绘制
  renderer.drawTiles();
  renderer.drawBuildings();

  const ui = createUI();
  ui.textContent = `infcanvas · 4 个小人 · 右键移动 · 左键选中小人 · 滚轮缩放`;

  // ---- 输入（Pointer Events 统一处理鼠标/触摸） ----
  const canvas = renderer.app.canvas;
  const isTouch = 'ontouchstart' in window;
  let buildMode: string | null = null;
  let uiBase = (): string => `infcanvas · ${isTouch ? '双指拖动 · 点选/长按移动' : '右键移动 · 左键选中'} · ${isTouch ? '双指缩放' : '滚轮缩放'} · B 建造`;

  // 手势状态
  type Pt = { x: number; y: number };
  const pointers = new Map<number, Pt>();
  let touchActive = false; // 是否有触摸指针
  let twoMoved = false; // 是否已进入双指/发生位移
  let midPanch: Pt | null = null; // 双指手势起始中点
  let pinchDist = 0;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  const screenPos = (e: { clientX: number; clientY: number }): Pt => ({ x: e.clientX, y: e.clientY });

  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

  const midpoint = (pts: Pt[]): Pt => {
    const total = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: total.x / pts.length, y: total.y / pts.length };
  };

  const clearLongPress = () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  };

  function startLongPress(start: Pt, pointerId: number) {
    clearLongPress();
    longPressTimer = setTimeout(() => {
      // 单指停在原地超过 400ms → 移动命令
      if (pointers.size === 1 && !twoMoved && pointers.has(pointerId)) {
        const world = renderer.screenToWorld(start.x, start.y);
        clearLongPress();
        sim.issueCommand({ type: 'move', x: world.x, y: world.y });
        ui.textContent = uiBase() + ' · 已下达移动命令';
        pointers.delete(pointerId);
      }
    }, 400);
  }

  canvas.addEventListener('pointerdown', (e) => {
    const pos = screenPos(e);
    pointers.set(e.pointerId, pos);
    touchActive = touchActive || e.pointerType !== 'mouse';

    if (pointers.size >= 2) {
      // 第二指落下 → 进入双指手势
      twoMoved = true;
      clearLongPress();
      const pts = [...pointers.values()];
      midPanch = midpoint(pts);
      pinchDist = dist(pts[0], pts[1]);
    } else if (pointers.size === 1 && e.pointerType !== 'mouse') {
      // 触摸单指：起长按（移动命令）
      startLongPress(pos, e.pointerId);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = screenPos(e);
    pointers.set(e.pointerId, cur);

    if (!touchActive) return; // 触摸手势只在触摸时处理

    if (pointers.size === 2) {
      // 双指：平移（中点位移）+ 缩放（距离比）
      const pts = [...pointers.values()];
      const mid = midpoint(pts);
      const d = dist(pts[0], pts[1]);
      if (midPanch) {
        renderer.setCamera(mid.x - midPanch.x, mid.y - midPanch.y);
      }
      if (pinchDist > 0 && d > 0) {
        renderer.zoomBy(d / pinchDist);
      }
      midPanch = mid;
      pinchDist = d;
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    clearLongPress();
    const wasTwoFinger = pointers.size >= 2;
    pointers.delete(e.pointerId);

    if (wasTwoFinger) {
      // 双指抬起一只 → 退出双指，重置
      const remain = [...pointers.values()];
      if (remain.length === 1) twoMoved = false;
      return;
    }

    // 单指抬起：若未发生双指/未长按 → 视为点选/建造
    if (!twoMoved && e.pointerType !== 'mouse' && pointers.size === 0) {
      handleTap(screenPos(e));
    }
  });

  canvas.addEventListener('pointercancel', (e) => {
    clearLongPress();
    pointers.delete(e.pointerId);
    if (pointers.size < 2) twoMoved = false;
  });

  function handleTap(pos: Pt) {
    const world = renderer.screenToWorld(pos.x, pos.y);
    if (buildMode) {
      sim.issueCommand({ type: 'build', x: world.x, y: world.y, buildingId: buildMode });
    }
    // 选中交给 pixi router 的 pawn pointerdown（若点到 pawn）
  }

  // 鼠标：右键移动 / 中键或右键拖动 / 滚轮缩放
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const world = renderer.screenToWorld(e.clientX, e.clientY);
    if (buildMode) {
      sim.issueCommand({ type: 'build', x: world.x, y: world.y, buildingId: buildMode });
    } else {
      sim.issueCommand({ type: 'move', x: world.x, y: world.y });
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      // 中键拖动
      pointers.set(2, screenPos(e));
    }
  });
  canvas.addEventListener('mousemove', (e) => {
    const prev = pointers.get(2);
    if (prev && e.buttons & 4) {
      const cur = screenPos(e);
      renderer.setCamera(cur.x - prev.x, cur.y - prev.y);
      pointers.set(2, cur);
    }
  });
  canvas.addEventListener('mouseup', (e) => {
    if (e.button === 1) pointers.delete(2);
  });

  canvas.addEventListener('mouseup', (e) => {
    if (e.button === 1) pointers.delete(2);
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.zoomBy(e.deltaY > 0 ? 0.9 : 1.1);
  });

  // 键盘：B = 进入建造模式
  window.addEventListener('keydown', (e) => {
    if (e.key === 'b' || e.key === 'B') {
      buildMode = buildMode === 'wall' ? null : 'wall';
      ui.textContent = buildMode ? `建造模式：${BUILDINGS[buildMode].name}（左键/点按放置，B 取消）` : uiBase();
    }
  });

  // ---- 主循环 ----
  let acc = 0;
  const tickMs = 1000 / sim.tickHz;
  let last = performance.now();
  renderer.app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;
    acc += dt;
    while (acc >= tickMs) {
      sim.step(tickMs / 1000);
      acc -= tickMs;
    }
  });

  // HMR
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      renderer.destroy();
    });
  }
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#f00;padding:20px">${err instanceof Error ? err.stack : String(err)}</pre>`;
});
