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
  let uiBase = (): string => `infcanvas · ${isTouch ? '拖动平移 · 点选/长按移动' : '右键移动 · 左键选中'} · ${isTouch ? '双指缩放' : '滚轮缩放'} · B 建造`;

  // 手势状态
  const pointers = new Map<number, { x: number; y: number }>();
  let gestureMoved = false; // 本次手势是否已拖动过
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let pinchDist = 0;
  let panStartDist = 0;

  const screenPos = (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY });

  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  const clearLongPress = () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  };

  function handleLongPress(start: { x: number; y: number }, pointerId: number) {
    longPressTimer = setTimeout(() => {
      if (!gestureMoved && pointers.has(pointerId)) {
        const world = renderer.screenToWorld(start.x, start.y);
        sim.issueCommand({ type: 'move', x: world.x, y: world.y });
        ui.textContent = uiBase() + ' · 已下达移动命令';
      }
    }, 400);
  }

  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, screenPos(e));
    gestureMoved = false;

    if (pointers.size === 1 && e.pointerType !== 'mouse') {
      // 触摸单指：起长按定时器（>400ms 触发移动命令）
      handleLongPress(screenPos(e), e.pointerId);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = screenPos(e);

    // 双指缩放
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const d = dist(p1, p2);
      if (panStartDist) {
        renderer.zoomBy(d / panStartDist);
      }
      panStartDist = d;
      pointers.set(e.pointerId, cur);
      clearLongPress();
      return;
    }

    // 单指/鼠标拖动平移
    const moved = dist(prev, cur);
    if (moved > 4) {
      gestureMoved = true;
      clearLongPress();
      renderer.setCamera(cur.x - prev.x, cur.y - prev.y);
    }
    pointers.set(e.pointerId, cur);
  });

  canvas.addEventListener('pointerup', (e) => {
    clearLongPress();
    pointers.delete(e.pointerId);

    // 触摸点按（未拖动）→ 选中/建造
    if (!gestureMoved && e.pointerType !== 'mouse' && pointers.size === 0) {
      handleTap(screenPos(e));
    }
  });

  canvas.addEventListener('pointercancel', (e) => {
    clearLongPress();
    pointers.delete(e.pointerId);
  });

  function handleTap(pos: { x: number; y: number }) {
    const world = renderer.screenToWorld(pos.x, pos.y);
    if (buildMode) {
      sim.issueCommand({ type: 'build', x: world.x, y: world.y, buildingId: buildMode });
    }
    // 选中交给 renderer 的 pawn pointerdown（若点到 pawn）
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
