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

  // ---- 输入 ----
  const canvas = renderer.app.canvas;
  let panning = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1 || e.button === 2) {
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (panning) {
      renderer.setCamera(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    }
  });

  canvas.addEventListener('mouseup', (e) => {
    if (e.button === 1 || e.button === 2) panning = false;
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // 右键 = 移动命令（给选中的小人）
    const world = renderer.screenToWorld(e.clientX, e.clientY);
    sim.issueCommand({ type: 'move', x: world.x, y: world.y });
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.zoomBy(e.deltaY > 0 ? 0.9 : 1.1);
  });

  // 键盘：B = 进入建造模式，选墙
  let buildMode: string | null = null;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'b' || e.key === 'B') {
      buildMode = buildMode === 'wall' ? null : 'wall';
      ui.textContent = buildMode ? `建造模式：${BUILDINGS[buildMode].name}（左键放置，B 取消）` : `infcanvas · 右键移动 · 左键选中 · B 建造`;
    }
  });

  // 左键点击：选中（若在建造模式则放置建筑）
  canvas.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    const world = renderer.screenToWorld(e.clientX, e.clientY);
    if (buildMode) {
      sim.issueCommand({ type: 'build', x: world.x, y: world.y, buildingId: buildMode });
    }
    // 非建造模式：左键选中交给 renderer 的 pawn pointerdown
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
