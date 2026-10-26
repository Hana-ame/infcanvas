/**
 * client/main.ts —— 客户端入口：100% RimWorld 风格操作界面 + 单格唯一对象生成顺序校准 + 屠宰台与尸体拖回屠宰 + 遗迹内部建筑初始化 + 帧耗时自适应节流。
 */
import './style.css';
import { Application } from 'pixi.js';
import {
  Sim,
  type Eid,
  enforceSingleTileOccupancy,
  getRuinSites,
  isRuinScavengeDlcEnabled,
  placeArchitectBuilding,
  tickPlayerControlledRaiders,
  spawnPackBeast,
  spawnBattlefieldCorpse,
  spawnAncientDangerShrine,
  spawnCreatureCorpse,
} from '../sim';
import { loadSim, snapshotOf } from '../sim/sim-save';
import { encodeSaveDataToFile, decodeSaveDataFromFile } from '../shared/bigint-json';
import { ModRegistry } from '../mods';
import {
  CLIENT_STEP_SEC,
  DEFAULT_PORT,
  DEFAULT_SEED,
  RENDER_DT_CLAMP_SEC,
} from '../sim/tuning';
import { Renderer } from './render';
import { Hud } from './hud';
import { RemoteSim } from './remote';
import { makeHeroControl, type HeroControl } from './hero-control';
import { LocalView } from './local-view';
import type { WorldView } from './view';
import { KeyboardInput, VirtualJoystick } from './input';
import { RimWorldUiController } from './rimworld-ui';

const SAVE_KEY = 'infcanvas-save-v3';

async function boot() {
  const app = new Application();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  await app.init({
    background: '#171c16',
    resizeTo: window,
    antialias: true,
    resolution: dpr,
    autoDensity: true,
  });
  document.getElementById('app')!.appendChild(app.canvas);

  const remoteArg = new URLSearchParams(location.search).get('remote');
  const selected = new Set<Eid>();
  let selBuilding: string | null = null;
  let selHostile: number | null = null;
  let selBase: string | null = null;
  let paused = false;
  let speed = 1;

  const banner = document.getElementById('hud-banner');
  if (banner) banner.hidden = true;

  let ctrl: {
    view: WorldView;
    tick(realDt: number): void;
    move(x: number, y: number): void;
    paused(): boolean;
  };
  let remoteCtl: RemoteSim | null = null;
  let localSim: Sim | null = null;
  let heroEid: Eid | null = null;
  /** P3 无感：主角操控的传输无关路径（WASD/J/E 只跟它打交道） */
  let heroCtl: HeroControl | null = null;
  const keyboard = new KeyboardInput();
  let joyVec = { x: 0, y: 0 };

  if (remoteArg) {
    document.title = 'InfCanvas · RimWorld 联机指挥与对抗';
    for (const id of ['btn-save', 'btn-load', 'btn-new']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    const remote = new RemoteSim();
    remoteCtl = remote;
    remote.onConnectionChange = (connected) => {
      if (banner) banner.hidden = connected;
    };
    await remote.connect(remoteArg).catch(() => undefined);
    // P3 无感：连上即认领一只鼠，之后 WASD/J/E 与本地模式同键同义。
    // 失败（服务器没起/鉴权失败）时 claim 返回 reason='disconnected'，
    // heroCtl.eid 保持 null = 观察模式，不会出现"能按键却没反应"的假象。
    void remote.claim().then((ack) => {
      if (ack.ok && typeof ack.eid === 'number') {
        heroEid = ack.eid;
        selected.add(ack.eid);
        heroCtl?.setEid(ack.eid);
      }
    });
    ctrl = {
      view: remote,
      tick() {},
      move(x, y) {
        remote.sendCommand('move', { eids: [...selected], x, y });
      },
      paused: () => false,
    };
  } else {
    const params = new URLSearchParams(location.search);
    let savedRaw: string | null = null;
    try {
      savedRaw = params.get('save') === '1' ? localStorage.getItem(SAVE_KEY) : null;
    } catch {
      savedRaw = null;
    }
    let sim: Sim;
    if (savedRaw) {
      sim = loadSim(decodeSaveDataFromFile(JSON.parse(savedRaw)), ModRegistry.default());
      try {
        history.replaceState(null, '', location.pathname + location.search.replace(/[?&]save=1/, ''));
      } catch {
        // ignore in sandboxed iframe
      }
    } else {
      sim = new Sim({
        seed: Number(params.get('seed') ?? DEFAULT_SEED),
        registry: ModRegistry.default(),
        playerRimWorldMode: true,
      });
    }
    sim.enableRimWorldPlayerRules('p_local_1');

    sim.stockpile['wood'] = Math.max(sim.stockpile['wood'] ?? 0, 60);
    sim.stockpile['ore'] = (sim.stockpile['ore'] ?? 0) + 32;
    sim.stockpile['stone'] = (sim.stockpile['stone'] ?? 0) + 24;
    sim.stockpile['gold'] = (sim.stockpile['gold'] ?? 0) + 8;
    sim.stockpile['herb'] = (sim.stockpile['herb'] ?? 0) + 12;

    // 初始化远古遗迹房间与内部可搜刮建筑（远古储物柜、军用物资箱、实验终端、休眠舱）
    if (isRuinScavengeDlcEnabled(sim)) getRuinSites(sim);

    // 开局建造一座 6×5 封闭室内工坊与厨房房间 (x=-6..-1, y=-7..-3)，供玩家直接点击房间体验「选中房间布置内设/装饰/工作台」
    for (let rx = -6; rx <= -1; rx++) {
      for (let ry = -7; ry <= -3; ry++) {
        const isEdge = rx === -6 || rx === -1 || ry === -7 || ry === -3;
        if (!isEdge) continue;
        const isDoor = rx === -3 && ry === -3;
        const b = sim.world.addArchitectBuilding(isDoor ? 'door' : 'wall', rx, ry, {
          allowContiguous: true,
          ignoreTerrain: true,
          allowReplace: true,
        });
        if (b) b.ownerPlayerId = 'p_local_1';
      }
    }
    placeArchitectBuilding(sim, 'stove', -5, -6, 0, 'p_local_1');
    placeArchitectBuilding(sim, 'butcher_table', -3, -6, 0, 'p_local_1');
    placeArchitectBuilding(sim, 'shelf', -5, -4, 0, 'p_local_1');
    placeArchitectBuilding(sim, 'great_bonfire', 3, -3, 0, 'p_local_1');
    spawnAncientDangerShrine(sim, -8, -5);
    spawnPackBeast(sim, 'p_local_1', 3, 2, { food: 10, wood: 12, ore: 6, herb: 4 });
    spawnBattlefieldCorpse(sim, 5, -2, {
      name: '赤爪先锋斥候遗体 (可搜尸/屠宰)',
      equipWeapon: '精准栓动步枪 (Bolt-Action Rifle)',
      equipApparel: '掠夺者防弹背心 (Flak Vest)',
      inventory: { ore: 6, gold: 3, herb: 2, meal: 2 },
      butcherYield: { meat: 3, leather: 2 },
      causeOfDeath: '前哨交火阵亡',
    });
    spawnCreatureCorpse(sim, 'deer', -4, 2);

    const strangerEid = sim.spawnPawn(6, -3);
    const stranger = sim.pawn(strangerEid);
    if (stranger) {
      stranger.name = '旅鼠·墨菲(陌生人)';
      stranger.isStranger = true;
      stranger.controlledBy = 'p_stranger_faction';
      stranger.inventory = { food: 15, herb: 6, gold: 4, wood: 10 };
    }

    enforceSingleTileOccupancy(sim);

    localSim = sim;
    const heroParam = Number(params.get('hero'));
    const firstPawn = [...sim.pawns()].find((p) => !p.isStranger);
    heroEid =
      Number.isFinite(heroParam) && sim.pawnMap.has(heroParam)
        ? heroParam
        : firstPawn
          ? firstPawn.eid
          : null;
    if (firstPawn) selected.add(firstPawn.eid);
    keyboard.attach();
    if ('ontouchstart' in window) {
      const joyEl = document.getElementById('joy');
      if (joyEl) {
        joyEl.hidden = false;
        new VirtualJoystick(joyEl, { onVector: (v) => (joyVec = v) });
      }
    }
    let acc = 0;
    const view = new LocalView(sim);
    ctrl = {
      view,
      tick(realDt) {
        if (paused) return;
        acc += realDt * speed;
        let steps = 0;
        const tStep0 = performance.now();
        while (acc >= CLIENT_STEP_SEC && steps < 8) {
          sim.step(CLIENT_STEP_SEC);
          tickPlayerControlledRaiders(sim, CLIENT_STEP_SEC);
          acc -= CLIENT_STEP_SEC;
          steps++;
          if (performance.now() - tStep0 > 12) break;
        }
        if (acc > 3) acc = 0;
      },
      move(x, y) {
        sim.selected = [...selected];
        sim.issueCommand('move', { eids: [...selected], x, y });
      },
      paused: () => paused,
    };
  }

  // P3 无感：本地/联机共用一条意图路径。sim 优先（本地模式即使挂着 remoteCtl
  // 变量也不该误走网络），所以这里传两个、让 hero-control 自己判。
  heroCtl = makeHeroControl({ sim: localSim, remote: remoteCtl });
  if (heroEid !== null) heroCtl.setEid(heroEid);

  let followCam = false;
  let rwUi: RimWorldUiController | null = null;

  const renderer = new Renderer(app, ctrl.view, {
    onSelect(eid) {
      selected.clear();
      if (eid !== null) selected.add(eid);
      if (eid !== null) {
        selBuilding = null;
        selHostile = null;
        selBase = null;
      }
      renderer.selected = selected;
      hud.forceNow();
      rwUi?.forceRefresh();
    },
    onSelectMany(eids) {
      selected.clear();
      for (const id of eids) selected.add(id);
      selBuilding = null;
      selHostile = null;
      selBase = null;
      renderer.selected = selected;
      hud.forceNow();
      rwUi?.forceRefresh();
    },
    onPickNonPawn(pick) {
      selected.clear();
      renderer.selected = selected;
      selBuilding = pick.buildingId;
      selHostile = pick.hostileId;
      hud.forceNow();
      rwUi?.forceRefresh();
    },
    onMove(x, y) {
      if (selected.size === 0) return;
      ctrl.move(x, y);
    },
    onUserPan() {
      followCam = false;
    },
    onCanvasLeftClick(wx, wy) {
      return rwUi ? rwUi.handleCanvasLeftClick(wx, wy) : false;
    },
    onCanvasRightClick(sx, sy, wx, wy) {
      return rwUi ? rwUi.handleCanvasRightClick(sx, sy, wx, wy) : false;
    },
    isLineDragDesignatorActive() {
      return rwUi ? rwUi.isLineDragDesignatorActive() : false;
    },
    onCanvasDragLine(cells) {
      return rwUi ? rwUi.handleCanvasDragLine(cells) : false;
    },
  });
  renderer.selected = selected;
  renderer.centerOn(0, 0);

  const doSave = () => {
    if (!localSim) return;
    const encoded = encodeSaveDataToFile(snapshotOf(localSim) as unknown as Record<string, unknown>);
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(encoded));
      rwUi?.showToast('殖民地存档已保存至浏览器');
    } catch {
      rwUi?.showToast('浏览器存储受限');
    }
  };
  const doLoad = () => {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) {
        rwUi?.showToast('没有找到存档记录');
        return;
      }
      location.href = `${location.pathname}?save=1`;
    } catch {
      rwUi?.showToast('无法读取存档');
    }
  };
  const doNewWorld = () => {
    location.search = `seed=${Math.floor(Math.random() * 100_000)}`;
  };

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
    onNewWorld: doNewWorld,
    onSave: doSave,
    onLoad: doLoad,
  });

  rwUi = new RimWorldUiController({
    getSim: () => localSim,
    getSelected: () => selected,
    setSelected: (eids) => {
      selected.clear();
      for (const id of eids) selected.add(id);
      selBuilding = null;
      selHostile = null;
      selBase = null;
      renderer.selected = selected;
    },
    getSelectedBuilding: () => selBuilding,
    getSelectedHostile: () => selHostile,
    getSelectedBase: () => selBase,
    setSelectedBase: (b) => {
      selBase = b;
    },
    centerCameraOn: (x, y) => {
      followCam = false;
      renderer.centerOn(x, y);
    },
    getZoomTilePx: () => renderer.TILE,
    setZoomTilePx: (tilePx) => {
      renderer.TILE = tilePx;
    },
    getMapOverlayMode: () => renderer.mapOverlayMode,
    setMapOverlayMode: (mode) => {
      renderer.mapOverlayMode = mode;
    },
    getPerfStats: () => ({
      fps: renderer.smoothedFps,
      renderMs: renderer.lastRenderCostMs,
    }),
    getPaused: () => paused,
    setPaused: (p) => {
      paused = p;
    },
    getSpeed: () => speed,
    setSpeed: (s) => {
      speed = s;
    },
    onSave: doSave,
    onLoad: doLoad,
    onNewWorld: doNewWorld,
    issueCommand: (type, args) => {
      if (remoteCtl) remoteCtl.sendCommand(type, args);
      else if (localSim) localSim.issueCommand(type, args);
    },
    setBlueprintPreview: (preview) => {
      renderer.blueprintPreview = preview;
    },
  });

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
      rwUi?.forceRefresh();
    }
    // P3 无感：J/E 走同一条意图路径（本地 directAttack/interact，联机上行 input）
    if (e.code === 'KeyJ') heroCtl?.act('attack');
    if (e.code === 'KeyE') {
      // 对话是纯客户端 UI 态（联机模式不存在），所以只有本地分支先看它
      if (localSim?.dialogue) localSim.closeDialogue();
      else heroCtl?.act('interact');
    }
  });

  app.canvas.addEventListener('mousemove', (e) => {
    const w = renderer.screenToWorld(e.clientX, e.clientY);
    rwUi?.updateCellHover(w.x, w.y);
  });

  let last = performance.now();
  app.ticker.add(() => {
    const now = performance.now();
    const dt = Math.min(RENDER_DT_CLAMP_SEC, (now - last) / 1000);
    last = now;
    ctrl.tick(dt);
    const kv = keyboard.vector();
    const v = kv.x !== 0 || kv.y !== 0 ? kv : joyVec;
    if (v.x !== 0 || v.y !== 0) {
      // P3 无感：WASD 驱动主角（本地 moveDir / 联机上行 input），相机跟着主角走。
      // 这是 input.ts 从 P1 就写下的设计口径（"方向向量喂给 sim.moveDir"），
      // 此前一直没接线、WASD 一直在平移相机。相机平移另有中键/右键/Ctrl+左键
      // 拖拽（render.ts 的 pan 分支），不吃 WASD。
      heroCtl?.move(v.x, v.y, dt);
      if (heroEid !== null) {
        for (const q of ctrl.view.pawns()) {
          if (q.eid === heroEid) {
            renderer.lerpCam(q.pos.x, q.pos.y, 0.18); // 比默认 0.06 快，追上 4.5 格/秒
            break;
          }
        }
      }
    } else if (followCam) {
      const [cx, cy] = centroid(ctrl.view);
      renderer.lerpCam(cx, cy);
    }
    renderer.frame(now);
    hud.frame(paused, selected, selBuilding, selHostile);
    rwUi?.frame();

    if (remoteCtl !== null) {
      const vRect = renderer.viewRect();
      remoteCtl.setInterest(vRect.x, vRect.y, Math.hypot(vRect.halfW, vRect.halfH));
    }
  });
}

boot().catch((err) => {
  document.getElementById('app')!.innerHTML =
    `<div style="color:#f88;font:14px system-ui;padding:24px">启动失败：${String(err)}<br>` +
    `联机地址是否正确？服务器是否已启动（npm run server -- ${DEFAULT_PORT}）？</div>`;
});
