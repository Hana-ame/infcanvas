// 浏览器入口（2026-08-21 从零重写 v2）——Pixi 渲染 + HUD + 全输入
// PC: 左键点选/拖=框选 · 右键=移动 · 滚轮=缩放 · 中键拖=平移 · 空格=回营地
// 触摸: 单指拖=平移 · 双指=缩放 · 轻点=点选 · 长按=移动(450ms)
import { Sim } from '../sim/sim';
import { ModRegistry } from '../mods/registry';
import { CORE_PACKS, defaultPlaystyle } from '../mods/packs';
import { Renderer } from './render';
import { createHud } from './hud';

function main(): void {
  const reg = new ModRegistry();
  reg.mountMany(CORE_PACKS);
  reg.mount(defaultPlaystyle);
  const sim = new Sim({ registry: reg, pawnCount: 4 });
  const container = document.getElementById('app')!;
  const renderer = new Renderer(sim, container);
  const hud = createHud(sim, () => {});

  (window as unknown as { __sim: unknown }).__sim = sim;

  const canvas = renderer.app.canvas;
  type Pt = { x: number; y: number };
  const screenPos = (e: { clientX: number; clientY: number }): Pt => ({ x: e.clientX, y: e.clientY });
  const pointers = new Map<number, Pt>();

  let downStart: Pt | null = null;
  let dragging = false;
  let boxStart: Pt | null = null;
  let boxActive = false;
  let longPress: ReturnType<typeof setTimeout> | null = null;
  const clearLP = () => { if (longPress) { clearTimeout(longPress); longPress = null; } };

  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, screenPos(e));
    if (pointers.size === 1 && (e.pointerType === 'mouse' ? e.button === 0 : true)) {
      downStart = screenPos(e);
      boxStart = screenPos(e);
      dragging = false;
      boxActive = false;
      if (e.pointerType !== 'mouse' && (hud as unknown as { buildMode: { current: string | null } }).buildMode === undefined ) {
        const sx = screenPos(e);
        longPress = setTimeout(() => {
          if (pointers.size === 1 && downStart) {
            const w = renderer.screenToWorld(sx.x, sx.y);
            sim.issueCommand('move', { eids: hud.selected.current, x: w.x, y: w.y }, 'player');
          }
        }, 450);
      }
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, screenPos(e));
    if (!prev) return;
    const cur = screenPos(e);
    // 双指：跟手平移（简化，缩放另测距离）
    if (pointers.size === 2) { clearLP(); renderer.pan(prev.x - cur.x, prev.y - cur.y); return; }
    if (downStart && Math.hypot(cur.x - downStart.x, cur.y - downStart.y) > 6) dragging = true;
    // 触摸单指 = 平移
    if (e.pointerType !== 'mouse' && pointers.size === 1 && downStart && Math.hypot(cur.x - downStart.x, cur.y - downStart.y) > 12) {
      clearLP();
      renderer.pan(prev.x - cur.x, prev.y - cur.y);
      return;
    }
    // PC 左键拖 = 框选
    if (e.pointerType === 'mouse' && dragging && boxStart) {
      boxActive = true;
      renderer.setSelBox(boxStart, cur);
    }
  });

  const endPointer = (e: PointerEvent): void => {
    clearLP();
    pointers.delete(e.pointerId);
    if (e.pointerType === 'mouse' && e.button === 0 && downStart) {
      if (boxActive && boxStart) {
        const a = renderer.screenToWorld(boxStart.x, boxStart.y);
        const b = renderer.screenToWorld(e.clientX, e.clientY);
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        hud.selected.current = [...sim.pawns.values()]
          .filter((p) => p.pos.x >= x0 && p.pos.x <= x1 && p.pos.y >= y0 && p.pos.y <= y1)
          .map((p) => p.eid);
        renderer.clearSelBox();
      } else if (!dragging) {
        const w = renderer.screenToWorld(e.clientX, e.clientY);
        const hit = [...sim.pawns.values()].find((p) => Math.hypot(p.pos.x - w.x, p.pos.y - w.y) < 0.6);
        hud.selected.current = hit ? [hit.eid] : [];
      }
    }
    downStart = null; dragging = false; boxStart = null; boxActive = false;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // 右键 = 移动
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const w = renderer.screenToWorld(e.clientX, e.clientY);
    sim.issueCommand('move', { eids: hud.selected.current, x: w.x, y: w.y }, 'player');
    const s = renderer.worldToScreen(w.x, w.y);
    renderer.moveMark.clear();
    renderer.moveMark.circle(s.x, s.y, 6).fill(0x4cf);
  });

  // 滚轮缩放
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 0.9 : 1.1);
  });

  // 中键拖 = 平移
  let midDrag = false, midPrev: Pt | null = null;
  canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button === 1) { midDrag = true; midPrev = screenPos(e); } });
  canvas.addEventListener('pointermove', (e) => {
    if (midDrag && midPrev && e.pointerType === 'mouse') {
      const cur = screenPos(e);
      renderer.pan(cur.x - midPrev.x, cur.y - midPrev.y);
      midPrev = cur;
    }
  });
  canvas.addEventListener('pointerup', (e) => { if (e.button === 1) midDrag = false; });

  // 触摸双指缩放
  let pinchDist = 0;
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.size === 2 && e.pointerType !== 'mouse') {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchDist > 0 && d > 0) {
        const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
        renderer.zoomAt(mid.x, mid.y, d / pinchDist);
      }
      pinchDist = d;
    } else pinchDist = 0;
  });

  // 键盘
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hud.selected.current = [];
    if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON') {
      e.preventDefault();
      const camp = sim.campPos();
      if (camp) { renderer.cam.x = camp.x; renderer.cam.y = camp.y; }
    }
  });

  // 主循环
  let last = performance.now();
  const TICK = 1000 / 20;
  function frame(): void {
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;
    let acc = dt;
    while (acc >= TICK) { sim.step(TICK / 1000); acc -= TICK; }
    renderer.render();
    hud.update();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
