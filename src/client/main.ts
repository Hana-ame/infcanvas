// infcanvas 入口 —— P0 单机可玩版 + HUD 菜单
import { Sim } from '../sim/sim';
import { Renderer } from './renderer';
import { BUILDINGS } from '../sim/defs';

const nf = (v: number | undefined): string => (v === undefined ? '-' : Math.round(v).toString());

function createHud(sim: Sim, onSelectBuild: (id: string | null) => void): { update: (bm: string | null) => void; hint: HTMLElement } {
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;z-index:10;pointer-events:none;font:13px system-ui;color:#eee;';

  // 顶部资源条
  const stock = document.createElement('div');
  stock.style.cssText = 'position:absolute;top:0;left:0;right:0;padding:8px 14px;background:rgba(0,0,0,.6);display:flex;gap:18px;align-items:center;font-weight:600;';
  root.appendChild(stock);

  // 底部建造菜单
  const buildMenu = document.createElement('div');
  buildMenu.style.cssText = 'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.72);border:1px solid #444;border-radius:10px;padding:8px;display:flex;gap:6px;pointer-events:auto;flex-wrap:wrap;justify-content:center;max-width:96%;';
  root.appendChild(buildMenu);

  // 选中面板
  const selPanel = document.createElement('div');
  selPanel.style.cssText = 'position:absolute;top:54px;left:12px;background:rgba(0,0,0,.55);border-radius:8px;padding:8px 12px;min-width:170px;display:none;line-height:1.6;';
  root.appendChild(selPanel);

  // 提示条
  const hint = document.createElement('div');
  hint.style.cssText = 'position:absolute;top:54px;right:12px;background:rgba(0,0,0,.5);border-radius:6px;padding:6px 10px;font-size:12px;text-align:right;';
  root.appendChild(hint);

  const update = (bm: string | null): void => {
    // 资源条
    const s = sim.stockpile;
    const parts = [
      `⏱️ ${Math.floor(sim.time / 60)}分`,
      `🌲木头 ${s.wood}`, `🪨矿 ${s.ore}`, `🍖食物 ${s.food}`,
      `👥 ${sim.pawns.length}人`,
    ];
    stock.textContent = parts.join('  ·  ');

    // 选中
    const sel = sim.selectedIds;
    if (sel.length > 0) {
      const eid = sel[0];
      const p = sim.pawnProfile(eid);
      if (p) {
        selPanel.style.display = 'block';
        const nd = p.needs;
        const hk = p.health;
        const slotCards = p.slots.filter((c) => c !== null).map((c) => c!.name).join('、') || '无';
        selPanel.innerHTML =
          `<b>🐭 小人 ${eid}</b> (${Math.round(p.pos.x)},${Math.round(p.pos.y)})<br>` +
          `<span style="color:#4cf">工作：${p.job || '闲逛'}</span><br>` +
          `HP ${nf(hk?.hp)}/${nf(hk?.maxHp)} · STR ${p.dna.str} · CON ${p.dna.con} · INT ${p.dna.int}<br>` +
          `天赋：${p.dna.traits.join('、') || '无'}<br>` +
          `插槽(${p.slots.filter((c) => c !== null).length}/${p.dna.maxSlots})：${slotCards}<br>` +
          (nd ? `饥饿 ${nf(nd.food)} · 精力 ${nf(nd.rest)} · 心情 ${nf(nd.mood)}` : '');
      } else {
        selPanel.style.display = 'none';
      }
    } else {
      selPanel.style.display = 'none';
    }

    // 提示
    hint.textContent = bm ? `建造【${BUILDINGS[bm]?.name ?? bm}】——在地图点击放置` : '点击建造菜单选择，点地图放置';
  };

  // 建造菜单按钮
  function mkBtn(emoji: string | undefined, label: string, id: string | null): HTMLElement {
    const b = document.createElement('button');
    b.textContent = `${emoji ?? '▪'} ${label}`;
    b.style.cssText = 'border:1px solid #555;background:#333;color:#eee;border-radius:6px;padding:5px 9px;cursor:pointer;font:12px system-ui;';
    b.addEventListener('click', () => onSelectBuild(id));
    return b;
  }
  buildMenu.appendChild(mkBtn('🚫', '取消', null));
  for (const id of Object.keys(BUILDINGS)) {
    const d = BUILDINGS[id];
    buildMenu.appendChild(mkBtn(d.emoji, d.name, id));
  }

  document.body.appendChild(root);
  return { update, hint };
}

async function main(): Promise<void> {
  const container = document.getElementById('app')!;
  const isTouch = 'ontouchstart' in window;

  const sim = new Sim({ seed: 20260803, pawnCount: 4 });
  const renderer = new Renderer(sim);
  await renderer.init(container);

  let buildMode: string | null = null;
  const hud = createHud(sim, (id) => {
    buildMode = id;
    hud.update(buildMode);
  });

  // ---- 输入（Pointer Events，鼠标/触摸统一） ----
  const canvas = renderer.app.canvas;
  const uiBase = `infcanvas · ${isTouch ? '双指拖动/缩放 · 点选/长按移动' : '右键移动 · 左键选中'} · 建造菜单在下方`;

  type Pt = { x: number; y: number };
  const pointers = new Map<number, Pt>();
  let touchActive = false;
  let twoMoved = false;
  let midLast: Pt | null = null;
  let pinchDist = 0;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  const screenPos = (e: { clientX: number; clientY: number }): Pt => ({ x: e.clientX, y: e.clientY });
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const midPnt = (pts: Pt[]): Pt => {
    const t = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
    return { x: t.x / pts.length, y: t.y / pts.length };
  };
  const clearLP = () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } };

  const placeLong = (pos: Pt) => {
    const world = renderer.screenToWorld(pos.x, pos.y);
    if (buildMode) {
      sim.issueCommand({ type: 'build', x: world.x, y: world.y, buildingId: buildMode });
    } else if (sim.selectedIds.length > 0) {
      sim.issueCommand({ type: 'move', x: world.x, y: world.y });
    }
  };

  // 鼠标左键拖动平移（PC）
  let mouseDragging = false;
  let mouseDragStart: Pt | null = null;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      mouseDragStart = screenPos(e);
      mouseDragging = false;
    }
  });
  canvas.addEventListener('mousemove', (e) => {
    if (mouseDragStart && e.buttons & 1) {
      const cur = screenPos(e);
      const moved = dist(mouseDragStart, cur);
      if (moved > 5) mouseDragging = true;
      if (mouseDragging) {
        renderer.setCamera(e.movementX, e.movementY);
      }
    }
  });
  window.addEventListener('mouseup', () => {
    mouseDragStart = null;
    mouseDragging = false;
  });

  // 鼠标左键：选中（或放置建造）——仅在未拖动的点击时触发
  canvas.addEventListener('click', (e) => {
    if (e.button !== 0 || mouseDragging) return;
    const pos = screenPos(e);
    if (buildMode) {
      const world = renderer.screenToWorld(pos.x, pos.y);
      sim.issueCommand({ type: 'build', x: world.x, y: world.y, buildingId: buildMode });
    } else {
      renderer.selectNearest(pos.x, pos.y, 26);
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, screenPos(e));
    touchActive = touchActive || e.pointerType !== 'mouse';
    if (pointers.size >= 2) {
      twoMoved = true;
      clearLP();
      const pts = [...pointers.values()];
      midLast = midPnt(pts);
      pinchDist = dist(pts[0], pts[1]);
    } else if (pointers.size === 1 && e.pointerType !== 'mouse') {
      // 触摸单指：长按 = 移动
      const start = screenPos(e);
      longPressTimer = setTimeout(() => {
        if (pointers.size === 1) {
          placeLong(start);
          pointers.delete(e.pointerId);
        }
      }, 400);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = screenPos(e);
    pointers.set(e.pointerId, cur);
    if (!touchActive) return;
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const mid = midPnt(pts);
      const d = dist(pts[0], pts[1]);
      if (midLast) renderer.setCamera(mid.x - midLast.x, mid.y - midLast.y);
      if (pinchDist > 0 && d > 0) renderer.zoomBy(d / pinchDist);
      midLast = mid;
      pinchDist = d;
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    clearLP();
    const wasTwo = pointers.size >= 2;
    pointers.delete(e.pointerId);
    if (wasTwo) return;
    if (!twoMoved && e.pointerType !== 'mouse' && pointers.size === 0) {
      placeLong(screenPos(e));
    }
  });

  canvas.addEventListener('pointercancel', (e) => {
    clearLP();
    pointers.delete(e.pointerId);
    if (pointers.size < 2) twoMoved = false;
  });

  // 鼠标右键：移动（或放置）
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    placeLong(screenPos(e));
  });

  // 鼠标中键拖动 / 滚轮缩放
  let midDrag = false;
  canvas.addEventListener('mousedown', (e) => { if (e.button === 1) midDrag = true; });
  canvas.addEventListener('mousemove', (e) => { if (midDrag) renderer.setCamera(e.movementX, e.movementY); });
  canvas.addEventListener('mouseup', (e) => { if (e.button === 1) midDrag = false; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.zoomBy(e.deltaY > 0 ? 0.9 : 1.1);
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
    hud.update(buildMode);
  });

  if (import.meta.hot) {
    import.meta.hot.dispose(() => renderer.destroy());
  }
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#f00;padding:20px">${err instanceof Error ? err.stack : String(err)}</pre>`;
});