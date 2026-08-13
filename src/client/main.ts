// infcanvas 入口 —— P0 单机可玩版 + HUD 菜单；?remote=ws://... 连 P1 server（权威在远端）
import { Sim } from '../sim/sim';
import type { ModRegistry } from '../sim/mods/registry';
import type { SimContext } from '../sim/systems/context';
import { Renderer } from './renderer';
import { RemoteSim } from './remote';
import type { SimView } from './remote';
import { SvgAssets } from './svgLoader';
import { parseModPackage, buildModMount } from '../mods/loader';
import { loadSave, writeSave } from './storage';
import { createHud } from './hud';
import type { HudApi } from './hud';
import { makeDummyCardPlanner } from '../server/dummyLlm';
import { keybindings } from './keybindings';

// 全局 HUD 句柄（attachScene 创建后赋值，供 planner 印卡时通知横幅）
let hudApi: HudApi | null = null;

async function main(): Promise<void> {
  const container = document.getElementById('app')!;
  const isTouch = 'ontouchstart' in window;

  // ---- 连接模式（P1）：?remote=ws://host:port → server 权威，本页只读观察 + 命令 ----
  const remoteUrl = new URLSearchParams(location.search).get('remote');
  if (remoteUrl) {
    const sim = new RemoteSim(remoteUrl);
    await sim.connect();
    (window as unknown as { __sim: unknown }).__sim = sim; // 调试/测试后门（远端视图）
    const assets = new SvgAssets();
    await assets.loadAll();
    const renderer = new Renderer(sim, assets);
    await renderer.init(container);
    (window as unknown as { __renderer: unknown }).__renderer = renderer; // 调试/测试后门
    attachScene(sim, renderer, isTouch);
    return;
  }

  // ---- 单机模式（P0） ----
  // 运行时 mod 加载：?mods=url1,url2
  //  - .mod.json：打包格式（manifest+defs+scripts），fetch → parse → buildModMount（校验/沙箱）
  //  - 其他：ESM 源码 mod（默认导出回调），dev 指向源码路径（vite transform）
  const modUrls = (new URLSearchParams(location.search).get('mods') ?? '').split(',').filter(Boolean);
  const modFns: ((m: ModRegistry) => void)[] = [];
  for (const u of modUrls) {
    try {
      if (u.endsWith('.mod.json')) {
        const pkg = parseModPackage(await (await fetch(u)).text());
        modFns.push(buildModMount(pkg));
        console.log(`[mod] 已挂载包 ${pkg.manifest.id}@${pkg.manifest.version}`);
      } else {
        const m = await import(/* @vite-ignore */ u);
        if (typeof m.default === 'function') modFns.push(m.default);
        else console.warn(`mod ${u}: 没有 default 导出函数`);
      }
    } catch (err) {
      console.error(`[mod] ${u} 加载失败`, err);
    }
  }

  // 固定种子 + 4 小人开局（与 scripts/play.ts、server 默认值一致，保证可复现/可对比）
  const sim = new Sim({
    seed: 20260803,
    pawnCount: 4,
    mods: modFns.length > 0 ? (m) => { for (const f of modFns) f(m); } : undefined,
  });
  (window as unknown as { __sim: Sim }).__sim = sim as unknown as Sim; // 调试/测试后门
  // 读取存档（IndexedDB）
  try {
    const raw = await loadSave<string>();
    if (raw) sim.load(JSON.parse(raw));
  } catch { /* 存档损坏则忽略 */ }
  // 空世界（旧档全灭/坏档）：重开开局，保证有小人可看
  if (sim.pawns.length === 0) {
    sim.respawnPawns(4);
    sim.ensureCamp();
  }
  // 加载 SVG 素材
  const assets = new SvgAssets();
  await assets.loadAll();
  const renderer = new Renderer(sim, assets);
  await renderer.init(container);
  (window as unknown as { __renderer: unknown }).__renderer = renderer; // 调试/测试后门

  // 自动存档（每 30 秒，IndexedDB）
  setInterval(async () => {
    try {
      await writeSave(JSON.stringify(sim.save()));
    } catch { /* 忽略写失败 */ }
  }, 30000);

  // 单机模式也挂 LLM 慢决策层（feedback 印卡）：神谕每 90s 评估局面印一张策略卡
  const planner = makeDummyCardPlanner(sim as unknown as SimContext, {
    mode: 'feedback', interval: 90,
    onPrint: (def) => hudApi?.notifyCard(def),
  });
  attachScene(sim, renderer, isTouch, planner);
}

// 共享场景：输入绑定 + 主循环（单机与远端共用；远端 sim.step 为 no-op）
function attachScene(
  sim: SimView,
  renderer: Renderer,
  isTouch: boolean,
  planner?: { tick(dt: number): void },
): void {
  let buildMode: string | null = null;
  const hud = createHud(sim, (id) => {
    buildMode = id;
    if (!id) renderer.clearGhost();
    hud.refreshHint(buildMode);
    hud.update(buildMode);
  }, (factor) => renderer.zoomBy(factor), (mode) => renderer.setViewMode(mode));
  hudApi = hud;
  hud.refreshHint(null);

  // ---- 输入（Pointer Events，鼠标/触摸统一） ----
  const canvas = renderer.app.canvas;
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

  // 统一"落下"语义：建造放置 / 移动命令（带目标标记反馈）
  const placeLong = (pos: Pt) => {
    const world = renderer.screenToWorld(pos.x, pos.y);
    if (buildMode) {
      sim.issueCommand({ type: 'build', x: world.x, y: world.y, buildingId: buildMode });
    // 移动选中 pawn。带 pawnId：远程模式 server 无 selected 镜像，显式指定
    } else if (sim.selectedIds.length > 0) {
      sim.issueCommand({ type: 'move', x: world.x, y: world.y, pawnId: sim.selectedIds[0] });
      renderer.showMoveMarker(sim.pawnPositions.get(sim.selectedIds[0]) ?? null, world);
    }
  };

  // 取消当前交互态（ESC）：建造模式 → 退出；选中 → 取消；面板 → 关闭
  const cancel = () => {
    if (buildMode) {
      buildMode = null;
      renderer.clearGhost();
      hud.refreshHint(null);
    }
    hud.selectedBuilding.current = null;
    renderer.clearSelection();
    hud.closePanels();
    hud.update(null);
  };

  // 鼠标左键拖动：建造模式 → 连铺（沿途每格放置一次）；否则 → 平移（PC）
  let mouseDragging = false;
  let mouseDragStart: Pt | null = null;
  let dragPlaced = new Set<number>(); // 本次拖拽已放置的格（去重）

  const tryDragPlace = (e: { clientX: number; clientY: number }): void => {
    if (!buildMode) return;
    const world = renderer.screenToWorld(e.clientX, e.clientY);
    // 格唯一 key（世界宽 <100000，x + y*100000 不会碰撞；连铺去重用）
    const k = world.x + world.y * 100000;
    if (dragPlaced.has(k)) return;
    dragPlaced.add(k);
    sim.issueCommand({ type: 'build', x: world.x, y: world.y, buildingId: buildMode });
  };

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      mouseDragStart = screenPos(e);
      mouseDragging = false;
      dragPlaced.clear();
      if (buildMode) tryDragPlace(e); // 按下即放第一格
    }
  });
  canvas.addEventListener('mousemove', (e) => {
    if (mouseDragStart && e.buttons & 1) {
      const cur = screenPos(e);
      const moved = dist(mouseDragStart, cur);
      if (moved > 5) mouseDragging = true; // 位移超 5px 才判为拖动（区分"点击"与"拖动"）
      if (buildMode) {
        // 建造模式：按住拖动 = 连铺（不平移）
        tryDragPlace(e);
      } else if (mouseDragging) {
        renderer.setCamera(e.movementX, e.movementY);
      }
    }
    // 建造模式：显示幽灵预览
    if (buildMode && !mouseDragging) {
      const wt = renderer.screenToWorld(e.clientX, e.clientY);
      const def = sim.buildingDef(buildMode);
      const can = def ? sim.world.canBuildFootprint(wt.x, wt.y, def) : sim.world.canBuildAt(wt.x, wt.y);
      renderer.setGhost(wt, can ? 0x4cf : 0xf44);
    }
  });
  window.addEventListener('mouseup', () => {
    mouseDragStart = null;
    mouseDragging = false;
  });

  // 鼠标左键：选中/取消（或放置建造）——仅在未拖动的点击时触发
  // 语义：点建筑=选中；点小人=选中；点空白=取消选择（不自动就近补选，避免误选）
  canvas.addEventListener('click', (e) => {
    if (e.button !== 0 || mouseDragging) return;
    const pos = screenPos(e);
    // 建造模式：mousedown 已放置（单击/连铺统一走 press-drag），click 不重复放置
    if (buildMode) return;
    const world = renderer.screenToWorld(pos.x, pos.y);
    const b = sim.buildingAt(world.x, world.y);
    if (b) {
      // 选中建筑
      hud.selectedBuilding.current = { x: world.x, y: world.y };
      sim.selected = [];
      renderer.clearSelection();
      hud.update(null);
      return;
    }
    // 点空白：取消选择（先清后探测，避免点空白还粘着上一个选中）
    hud.selectedBuilding.current = null;
    renderer.clearSelection();
    hud.update(null);
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
      // 触摸单指：长按 400ms 判定为移动（短于滑动节奏，避免与拖动/点选误触）
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
    renderer.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 0.9 : 1.1);
  });

  // 键盘快捷键：全部走可配置键位表（hud 改键面板可改，localStorage 持久化）
  window.addEventListener('keydown', (e) => {
    if (hud.isCapturingKey()) return; // 改键捕获中（capture 监听已拦截，双保险）
    const act = keybindings.actionFor(e);
    if (!act) return;
    e.preventDefault();
    switch (act) {
      case 'pause':
        sim.paused = !sim.paused;
        break;
      case 'speed1': sim.paused = false; sim.speed = 1; break;
      case 'speed2': sim.paused = false; sim.speed = 2; break;
      case 'speed3': sim.paused = false; sim.speed = 3; break;
      case 'zoomIn': renderer.zoomBy(1.2); break;
      case 'zoomOut': renderer.zoomBy(0.8); break;
      case 'cancel':
        cancel();
        break;
      case 'buildWall':
        buildMode = buildMode === 'wall' ? null : 'wall';
        if (!buildMode) renderer.clearGhost();
        hud.refreshHint(buildMode);
        break;
      case 'viewToggle':
        hud.toggleViewMode();
        break;
      case 'helpToggle':
      case 'historyToggle':
      case 'factionToggle':
        hud.togglePanel(act);
        break;
      case 'menuFold':
        hud.toggleFold();
        break;
    }
    hud.update(buildMode);
  });

  // 相机边缘滚动（PC）
  let mousePos: { x: number; y: number } | null = null;
  window.addEventListener('mousemove', (e) => {
    mousePos = { x: e.clientX, y: e.clientY };
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
    // 神谕慢决策层（单机模式）：按游戏时间推进印卡节奏
    planner?.tick(dt / 1000);
    // 鼠标靠屏幕边缘时自动平移（PC 导航）
    if (mousePos && !isTouch) {
      const m = 24; // 边缘触发距离（px）
      const vx = 14; // 边缘滚动速度（屏幕 px/帧，随 zoom 折算到世界位移）
      if (mousePos.x < m) renderer.setCamera(-vx, 0);
      else if (mousePos.x > window.innerWidth - m) renderer.setCamera(vx, 0);
      if (mousePos.y < m) renderer.setCamera(0, -vx);
      else if (mousePos.y > window.innerHeight - m) renderer.setCamera(0, vx);
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