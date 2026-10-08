/**
 * client/main.ts —— 客户端入口：本地单机 / ?remote= 联机 双模（阶段④）。
 *
 * - 本地模式：浏览器内直跑 Sim（与 Node 同一份零 DOM 代码），固定步长推进。
 * - 联机模式（?remote=ws://host:port）：RemoteSim 合入服务端快照，命令上行；
 *   渲染/HUD 与本地共用同一 WorldView，零分支。
 * 存档按钮走 localStorage（本地模式专属；联机的存档权在服务器侧）。
 */
import './style.css';
import { Application } from 'pixi.js';
import { Sim } from '../sim';
import { snapshotOf, loadSim, type SaveData } from '../sim/sim-save';
import { ModRegistry } from '../mods';
import { DEFAULT_PORT, DEFAULT_SEED, CLIENT_STEP_SEC, RENDER_DT_CLAMP_SEC } from '../sim/tuning';
import { Renderer } from './render';
import { Hud } from './hud';
import { RemoteSim } from './remote';
import { LocalView } from './local-view';
import type { WorldView } from './view';

const SAVE_KEY = 'infcanvas-save-v3';

interface Controller {
  view: WorldView;
  /** 本地模式推进时间；联机模式为 no-op（时间由服务器推） */
  tick(realDt: number): void;
  move(x: number, y: number): void;
  paused(): boolean;
}

async function boot(): Promise<void> {
  const app = new Application();
  // resolution 必须跟物理像素走：缺省 1 时高 DPI 屏会把低分辨率画面拉伸，
  // 整个画面发虚像蒙了层雾（2026-08-21 用户反馈「为什么雾蒙蒙的」）；autoDensity 让
  // CSS 尺寸保持逻辑像素、背缓冲用物理像素。
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  await app.init({
    background: '#101410',
    resizeTo: window,
    antialias: true,
    resolution: dpr,
    autoDensity: true,
  });
  document.getElementById('app')!.appendChild(app.canvas);

  const remoteArg = new URLSearchParams(location.search).get('remote');
  const selected = new Set<number>();
  /** R3-HUD：选中非鼠目标（建筑 id / 敌袭单位 id）。与 selected 互斥：
   *  点鼠清空这两个，点建筑/敌人清空 selected（语义单一：详情面板同时只描述一个对象）。 */
  let selBuilding: string | null = null;
  let selHostile: number | null = null;
  let paused = false;
  let speed = 3;
  // R1-1 断连横幅（仅联机用；本地模式永远 hidden）
  const banner = document.getElementById('hud-banner')!;
  banner.hidden = true;

  let ctrl: Controller;
  // 联机句柄提到外层：渲染循环每帧要用它上报视口（setInterest 内部有指纹节流）。
  // 本地单机模式恒为 null —— 单机不需要裁剪，本地进程本来就持有全部世界。
  let remoteCtl: RemoteSim | null = null;
  if (remoteArg) {
    document.title = 'infcanvas · 联机观察/指挥';
    // 本地专属按钮在联机模式是哑按钮：存档权在服务器侧，直接隐藏防误导
    for (const id of ['btn-save', 'btn-load', 'btn-new']) {
      document.getElementById(id)!.style.display = 'none';
    }
    const remote = new RemoteSim();
    remoteCtl = remote;
    // R1-1 断连横幅：断连/重连期间让玩家知道「不是卡了，是在重连」，
    // 否则玩家会对着冻结的世界反复点击。所有权交给 main 的 render loop 控制显隐。
    remote.onConnectionChange = (connected) => {
      banner.hidden = connected;
    };
    // 等首包（welcome）到达再起渲染，否则没有 tuning 无法建地形推导器
    // 注意：首连失败不致命——onerror 已排好退避重连，这里吞掉错误让页面继续跑，
    // 等服务器起来后自动接上（这正是 R1-1 要的行为）。
    await remote.connect(remoteArg).catch(() => undefined);
    ctrl = {
      view: remote,
      tick() {}, // 时间由服务器推进
      move(x, y) {
        remote.sendCommand('move', { eids: [...selected], x, y });
      },
      paused: () => false,
    };
  } else {
    // 本地：支持 ?seed=；?save=1 从 localStorage 恢复
    const params = new URLSearchParams(location.search);
    const savedRaw = params.get('save') === '1' ? localStorage.getItem(SAVE_KEY) : null;
    let sim: Sim;
    if (savedRaw) {
      sim = loadSim(JSON.parse(savedRaw), ModRegistry.default());
      history.replaceState(null, '', location.pathname + location.search.replace(/[?&]save=1/, ''));
    } else {
      sim = new Sim({ seed: Number(params.get('seed') ?? DEFAULT_SEED), registry: ModRegistry.default() });
    }
    let acc = 0;
    const view = new LocalView(sim);
    ctrl = {
      view,
      tick(realDt: number) {
        if (paused) return;
        acc += realDt * speed;
        let steps = 0;
        // 固定步长推进：步长来自 tuning.ts §0 的 CLIENT_STEP_SEC（= 2.5 × SIM_DT_SEC），
        // 不是这里的字面量——历史 bug 就是把 0.25 当契约基准写进 sim 侧注释（P1）。
        while (acc >= CLIENT_STEP_SEC && steps < 32) {
          sim.step(CLIENT_STEP_SEC);
          acc -= CLIENT_STEP_SEC;
          steps++;
        }
        if (acc > 8) acc = 0; // 后台标签页回来不补帧雪崩
      },
      move(x, y) {
        sim.selected = [...selected];
        sim.issueCommand('move', { eids: [...selected], x, y });
      },
      paused: () => paused,
    };
  }

  let followCam = true; // 默认跟随：否则鼠走远了用户看到空地（按钮可关）
  const renderer = new Renderer(app, ctrl.view, {
    onSelect(eid) {
      selected.clear();
      if (eid !== null) selected.add(eid);
      // 点到鼠即取消非鼠选中：详情面板同时只描述一个对象
      if (eid !== null) {
        selBuilding = null;
        selHostile = null;
      }
      renderer.selected = selected;
      hud.forceNow(); // R3-HUD：交互后立即刷 HUD（不等节流窗）
    },
    // R1-4 框选：整批替换选中集合（不是叠加——叠加会让「再框一次」无法缩小范围）
    onSelectMany(eids) {
      selected.clear();
      for (const id of eids) selected.add(id);
      selBuilding = null;
      selHostile = null;
      renderer.selected = selected;
      hud.forceNow();
    },
    // R3-HUD：点到建筑/敌袭单位 → 详情面板切换目标（清空鼠选中）
    onPickNonPawn(pick) {
      selected.clear();
      renderer.selected = selected;
      selBuilding = pick.buildingId;
      selHostile = pick.hostileId;
      hud.forceNow();
    },
    onMove(x, y) {
      if (selected.size === 0) return;
      ctrl.move(x, y);
    },
    onUserPan() {
      // 手动平移即交出镜头控制权：跟随若开着会被 lerp 拉回去，两个力打架
      if (followCam) {
        followCam = false;
        const b = document.getElementById('btn-follow');
        if (b) b.textContent = '🎯 跟随鼠群：关';
      }
    },
  });
  renderer.centerOn(0, 0);

  const hud = new Hud(ctrl.view, {
    onPauseToggle() {
      paused = !paused;
      return paused;
    },
    onSpeedCycle() {
      speed = speed === 1 ? 3 : speed === 3 ? 8 : 1;
      return speed;
    },
    onFollowToggle() {
      followCam = !followCam;
      if (followCam) renderer.centerOn(...centroid(ctrl.view));
      return followCam;
    },
    onNewWorld() {
      location.search = `seed=${Math.floor(Math.random() * 100000)}`;
    },
    onSave() {
      if (!(ctrl.view instanceof Sim)) return; // 联机模式存档权在服务器
      localStorage.setItem(SAVE_KEY, JSON.stringify(snapshotOf(ctrl.view)));
      flash('💾 已保存到浏览器');
    },
    onLoad() {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) {
        flash('⚠ 没有找到存档');
        return;
      }
      location.href = `${location.pathname}?save=1`;
    },
  });

  // 相机跟随开关（默认关）；centroid 供开启瞬间直接对准质心
  function centroid(v: WorldView): [number, number] {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const p of v.pawns()) {
      sx += p.pos.x;
      sy += p.pos.y;
      n++;
    }
    return n ? [sx / n, sy / n] : [0, 0];
  }
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      paused = !paused;
    }
  });
  function flash(text: string): void {
    const el = document.getElementById('hud-hint')!;
    el.textContent = text;
    setTimeout(() => {
      el.textContent = HINT;
    }, 2000);
  }
  const HINT = '左键点鼠选中 → 点地面/右键指挥移动｜拖拽平移·滚轮缩放｜空格暂停｜移动鼠标看左下角地块信息';

  // ---- 地块信息面板：固定在左下角，不跟随鼠标；可开关隐藏 ----
  const tip = document.getElementById('hud-tip')!;
  let tipVisible = true;
  document.getElementById('btn-tip')!.onclick = (ev) => {
    tipVisible = !tipVisible;
    tip.style.display = tipVisible ? 'block' : 'none';
    (ev.target as HTMLElement).textContent = `📋 地块信息：${tipVisible ? '开' : '关'}`;
  };
  app.canvas.addEventListener('mousemove', (e) => {
    if (!tipVisible) return;
    const w = renderer.screenToWorld(e.clientX, e.clientY);
    const info = ctrl.view.inspect(w.x, w.y);
    const lines: string[] = [];
    lines.push(`<span class="t-name">${info.terrainName}</span> <span class="muted">(${Math.round(info.x)},${Math.round(info.y)})</span>`);
    // z 高度模型：海拔与立足性
    if (info.liquid) lines.push('<span class="bad">z=0 · 水面无法立足</span>');
    else {
      lines.push(`<span class="ok">z=${info.z}</span><span class="muted">${info.standable ? '· 可立足' : `· 需攀爬 ≥${info.z}`}</span>`);
    }
    if (info.treeCanopy) lines.push('<span class="bad">大树树冠</span>');
    if (info.feature) lines.push(`${info.feature.kind === 'tree' ? '🌳' : '🍓'} ${info.feature.label}`);
    if (info.buildingName) lines.push(`🏠 ${info.buildingName}`);
    tip.innerHTML = lines.join('<br>');
    tip.style.display = 'block';
  });
  app.canvas.addEventListener('mouseleave', () => {
    if (!tipVisible) return;
    tip.style.display = 'block'; // 离开画布时保留最后一条信息（不隐藏）
  });

  let last = performance.now();
  app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min(RENDER_DT_CLAMP_SEC, (now - last) / 1000);
    last = now;
    ctrl.tick(dt);
    if (followCam) {
      const [cx, cy] = centroid(ctrl.view);
      renderer.lerpCam(cx, cy);
    }
    renderer.frame(now);
    // R3-HUD：把非鼠选中一并喂给 HUD（详情面板同时只描述一个对象）
    hud.frame(paused, selected, selBuilding, selHostile);
    // 联机分区块同步（line/net 收尾）：把当前视口上报给服务端做快照裁剪。
    //
    // 为什么放在这里而不是镜头事件里：视口同时受**平移、缩放、窗口 resize** 三者影响，
    // 事件驱动要挂三个入口、漏一个就出现"缩小后请求了一堆看不见的块"或"放大后缺块"。
    // 每帧一次调用的成本是纯计算（无分配、无序列化）——真正的上行由
    // RemoteSim.setInterest 内部的区块集合指纹节流挡住，集合没变就不发。
    if (remoteCtl !== null) {
      const v = renderer.viewRect();
      // 半径取外接圆：矩形视口按圆订阅会多带一点四角，换来"任何缩放/窗口比例下都不漏块"。
      remoteCtl.setInterest(v.x, v.y, Math.hypot(v.halfW, v.halfH));
    }
  });
  void flash;
}

boot().catch((err) => {
  document.getElementById('app')!.innerHTML =
    `<div style="color:#f88;font:14px system-ui;padding:24px">启动失败：${String(err)}<br>` +
    `联机地址是否正确？服务器是否已启动（npm run server -- ${DEFAULT_PORT}）？</div>`;
});
