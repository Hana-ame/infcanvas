// 浏览器入口（2026-08-21 从零重写）——极简主循环 + 输入
// 鼠标：左键点选/框选，右键移动，滚轮缩放，中键平移。触摸：单指平移/轻点/长按。

import { Sim } from '../sim/sim';
import { ModRegistry } from '../mods/registry';
import { CORE_PACKS, defaultPlaystyle } from '../mods/packs';
import { Renderer } from './render';

function main(): void {
  const reg = new ModRegistry();
  reg.mountMany(CORE_PACKS); // 挂核心包（注册进目录）
  reg.mount(defaultPlaystyle); // 聚合包
  const sim = new Sim({ registry: reg, pawnCount: 4 });
  const renderer = new Renderer(sim);

  (window as unknown as { __sim: unknown }).__sim = sim; // 调试后门

  // ---- 输入 ----
  const cvs = renderer.cvs;
  const screenPos = (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY });
  let dragStart: { x: number; y: number } | null = null;
  let dragging = false;
  let boxSel: { x: number; y: number } | null = null; // 框选起点

  // 点选/框选
  cvs.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragStart = screenPos(e);
    dragging = false;
    boxSel = screenPos(e);
  });
  cvs.addEventListener('mousemove', (e) => {
    if (!dragStart) return;
    if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 5) dragging = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragStart) return;
    if (dragging && boxSel) {
      // 框选：矩形内鼠
      const a = renderer.screenToWorld(boxSel.x, boxSel.y);
      const b = renderer.screenToWorld(e.clientX, e.clientY);
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      sim.selected = [...sim.pawns.values()]
        .filter((p) => p.pos.x >= x0 && p.pos.x <= x1 && p.pos.y >= y0 && p.pos.y <= y1)
        .map((p) => p.eid);
    } else if (!dragging) {
      // 点选/建筑
      const w = renderer.screenToWorld(e.clientX, e.clientY);
      const bld = sim.world.buildingAt(w.x, w.y);
      if (bld) { sim.selected = []; }
      else {
        const hit = [...sim.pawns.values()].find((p) => Math.hypot(p.pos.x - w.x, p.pos.y - w.y) < 0.6);
        sim.selected = hit ? [hit.eid] : [];
      }
    }
    dragStart = null; dragging = false; boxSel = null;
  });

  // 右键移动
  cvs.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const w = renderer.screenToWorld(e.clientX, e.clientY);
    sim.issueCommand('move', { eids: [...sim.selected], x: w.x, y: w.y }, 'player');
  });
  // 滚轮缩放
  cvs.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 0.9 : 1.1);
  });
  // 中键平移
  let midDrag = false, midPrev: { x: number; y: number } | null = null;
  cvs.addEventListener('mousedown', (e) => { if (e.button === 1) { midDrag = true; midPrev = screenPos(e); } });
  window.addEventListener('mousemove', (e) => {
    if (!midDrag || !midPrev) return;
    renderer.cam.x += (midPrev.x - e.clientX) / renderer.cam.zoom;
    midPrev = screenPos(e);
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 1) midDrag = false; });



  // ---- 主循环 ----
  let last = performance.now();
  const TICK = 1000 / 20; // 20 步/秒
  function frame(): void {
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;
    let acc = dt;
    while (acc >= TICK) { sim.step(TICK / 1000); acc -= TICK; }
    renderer.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();