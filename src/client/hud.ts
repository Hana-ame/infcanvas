/**
 * client/hud.ts —— DOM HUD 层：**薄编排器**（R3-HUD，2026-10-06 重构）。
 *
 * 本文件现在只做三件事：
 *  1. 绑定控制按钮 → 发意图回调（玩家输入 → HudCallbacks；HUD 不自己改模拟）。
 *  2. 挂载内建面板到 PanelHost（分区 + 差分渲染，见 hud/panels.ts）。
 *  3. 每帧把「选中交互态 + 世界快照」交给面板刷新（交互后 force 一帧跳过节流）。
 *
 * 旧实现（顶栏/科技/feed/选中各自每帧手写 innerHTML）挪进了 hud/default-panels.ts 的
 * 声明式面板里，并升级为 key 差分 + 刷新节流。重构前后 HUD 的行为契约不变：
 * 只读 WorldView + 发意图回调，**不持任何模拟状态**。
 */
import type { HudCallbacks } from './hud-callbacks';
import type { WorldView } from './view';
import { PanelHost } from './hud/panels';
import { defaultPanels, selCtx, techPanelHtml, type SelectionCtx } from './hud/default-panels';

export type { HudCallbacks } from './hud-callbacks';

export class Hud {
  private host: PanelHost;
  /** 科技面板内容指纹（与 PanelHost 的 key 差分同一套机制） */
  private techCache = '';
  /** 选中交互态（玩家的，不是模拟的）：每帧由 main.ts 的交互结果喂进来 */
  private sel: SelectionCtx = selCtx(new Set(), null, null, 0);
  /** 交互后置位：下一帧强制跳过节流窗（点击/选中必须立刻有反馈） */
  private pendingForce = false;

  constructor(
    private view: WorldView,
    private cb: HudCallbacks,
  ) {
    // 控制按钮：全部只发意图回调，HUD 不直接改模拟（原则④：玩家输入 = 命令面）。
    const pauseBtn = document.getElementById('btn-pause')!;
    pauseBtn.onclick = () => {
      const paused = this.cb.onPauseToggle();
      pauseBtn.textContent = paused ? '▶ 继续' : '⏸ 暂停';
    };
    const speedBtn = document.getElementById('btn-speed')!;
    speedBtn.onclick = (ev) => {
      const v = this.cb.onSpeedCycle();
      (ev.target as HTMLElement).textContent = `⏩ 速度 ×${v}`;
    };
    const followBtn = document.getElementById('btn-follow')!;
    followBtn.onclick = () => {
      followBtn.textContent = `🎯 跟随鼠群：${this.cb.onFollowToggle() ? '开' : '关'}`;
    };
    const nw = document.getElementById('btn-new');
    if (nw) nw.onclick = () => this.cb.onNewWorld();
    const save = document.getElementById('btn-save');
    if (save) save.onclick = () => this.cb.onSave();
    const load = document.getElementById('btn-load');
    if (load) load.onclick = () => this.cb.onLoad();

    // 面板宿主：分区容器由 PanelHost 按需创建（#hud-panels 是它们的根）。
    const root = document.getElementById('hud-panels') ?? createFallbackRoot();
    this.host = new PanelHost(root, HUD_REFRESH_MS);
    for (const p of defaultPanels(() => this.sel)) this.host.register(p);

    // 构造时先画一帧：否则页面加载后 HUD 要等第一次 ticker 才出现内容（空白闪一下）
    this.renderTech(true);
  }

  /**
   * 每帧调用（main.ts 的 app.ticker）。
   *
   * 性能契约（这轮重构的核心）：
   *  - **key 差分**：每个面板只产出 key + html，key 不变 → 一个字节的 DOM 都不写。
   *    旧实现里事件 feed 每帧 `map+join` 重建、选中面板每帧无条件重写 innerHTML，
   *    这两处的每帧 DOM 重建已消除。
   *  - **节流**：数据变了也最多每 100ms 写一次（内容是人类阅读速率信息）；
   *    交互后的那一帧强制刷新（forceNow），保证点击立刻有反馈。
   */
  frame(paused: boolean, selected: Set<number>, buildingId: string | null = null, hostileId: number | null = null): void {
    this.sel = selCtx(selected, buildingId, hostileId, this.view.time);
    const force = this.pendingForce;
    this.pendingForce = false;
    this.host.refresh(this.view, force);
    this.renderTech(force);
  }

  /** 玩家交互后调用：下一帧立即刷新（跳过节流窗）。选中/点击变化是低频事件。 */
  forceNow(): void {
    this.pendingForce = true;
  }

  /**
   * 科技抽卡池面板（R2-1 保留）：折叠 <details>，低频信息。
   * 与 PanelHost 同样走 key 差分 + 100ms 节流，不引入第二套刷新策略。
   */
  private renderTech(force = false): void {
    const body = document.getElementById('hud-tech-body');
    if (!body) return;
    const { key, html } = techPanelHtml(this.view);
    if (!force && key === this.techCache) return;
    this.techCache = key;
    body.innerHTML = html;
  }

  /** 供测试/诊断：本帧实际 DOM 写入次数（0 = 全部命中缓存）。 */
  writesLastFrame(): number {
    return this.host.lastWrites;
  }
}

/**
 * HUD 刷新节流（ms）。
 * 为什么 100ms：HUD 内容（人口/建筑/事件/均值）全是**人类阅读速率**信息，
 * 10fps 已绰绰有余；60fps 重写 innerHTML 是纯浪费的 CPU 与无意义的重排。
 * 注意这不影响正确性：key 每帧都在比对，数据真变了最迟 100ms 内一定显示出来；
 * 且 force 路径（玩家交互）完全跳过节流。
 */
const HUD_REFRESH_MS = 100;

/** #hud-panels 缺失时的兜底根（防 index.html 与代码版本不匹配导致面板无处挂载）。 */
function createFallbackRoot(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'hud-panels';
  document.body.appendChild(el);
  return el;
}