/**
 * client/hud/panels.ts —— HUD 面板体系：声明式面板注册 + 差分渲染（R3-HUD，2026-10-06）。
 *
 * 解决的问题（旧 hud.ts 的两个结构缺陷）：
 *  1. **无结构**：顶栏/事件/科技/选中是几个各自独立的 DOM id + 各自独立的每帧逻辑，
 *     信息层级靠 CSS 位置隐式表达，"加一个新面板"要改 hud.ts 的 frame() 实现。
 *  2. **每帧重建**：`hud.ts` 每帧对事件 feed 做 `map + join` 全量重建 HTML，
 *     选中面板每帧无条件重写 innerHTML。规模一上去就是 DOM 抖动热点。
 *
 * 本模块的设计：
 *  - **面板 = 声明**（id/slot/图标/标题/是否可折叠/渲染函数）。面板自己声明挂哪个分区（slot），
 *    新玩法包要加面板只需 `registerPanel({...})`，**不改 hud.ts**（这是"可扩展"的落点）。
 *  - **一次差分**：每个面板产出 `key`（定长字符串）+ `html`。key 不变 → 完全不碰 DOM。
 *    纯数据面板可以用 `keyOf()` 只算 key 不算 html（进一步省掉字符串拼接）。
 *  - **插值节流**：`refresh(ms)` 带最小刷新间隔。暂停/选单/切面板等事件可 force 立即刷。
 *
 * 为什么 key 机制能保证性能：HUD 每帧（60fps）被调一次，但**只有 key 变化的那些帧**
 * 会写 innerHTML。key 由定长标量拼成（int/字符串），比较是 O(key 长度) 且无分配；
 * 拼 key 本身也只有几百字符，远小于 innerHTML 重解析的代价。
 */
import type { HudSlot, WorldView } from '../view';

/** 面板声明：一个可挂载的信息区块。 */
export interface PanelDef {
  /** 全局唯一 id（注册面去重键） */
  id: string;
  /** 挂在哪个分区（视觉层级由 slot 决定，而不是每个面板自己写 CSS 坐标） */
  slot: HudSlot;
  /** 标题栏图标（如 🐭 / 🏕 / ⚠） */
  icon?: string;
  /** 标题文本 */
  title?: string;
  /**
   * 排序权重：小在上。分区内部按 slotOrder 稳定排序，
   * 保证「相同数据 → 相同 key」（DOM 顺序变会导致 key 变了却内容没变）。
   */
  order?: number;
  /** 面板内容渲染：产出 { key, html }；key 相同则 HUD 跳过 DOM 写入 */
  render(view: WorldView): PanelOut;
}

/** 面板一次渲染的产物 */
export interface PanelOut {
  /** 内容指纹：不变则完全跳过 DOM（面板自己决定粒度） */
  key: string;
  /** 面板 body 的 HTML */
  html: string;
  /** 空内容时隐藏面板容器（false 时强制显示，如"无科技池"也要给出显式说明） */
  empty?: boolean;
}

/** 面板宿主：管理注册表、DOM 骨架、按分区渲染与差分。 */
export class PanelHost {
  private panels: PanelDef[] = [];
  private bodies = new Map<string, HTMLElement>();
  private wraps = new Map<string, HTMLElement>();
  /** 每个面板上次写入的 key（差分基准） */
  private lastKeys = new Map<string, string>();
  private lastAt = 0;
  /** 本帧是否发生过 DOM 写入（测试/诊断用） */
  lastWrites = 0;

  /**
   * @param host 根容器；面板按 slot 生成分区容器（分区不存在则创建，顺序固定）。
   * @param minIntervalMs 两次 DOM 刷新之间的最小间隔。
   *   为什么默认 100ms（≈10fps）：HUD 内容全是**人类阅读速率**信息（人数/建筑/事件），
   *   60fps 刷新只是白烧 CPU 和触发无意义的重排。但 key 仍每帧比对，
   *   所以**数据没变时一次 DOM 操作都不会发生**——间隔只是限制"数据变了"时的写入频率。
   *   force=true（玩家交互）会跳过间隔，保证点一下立刻有反馈。
   */
  constructor(
    private host: HTMLElement,
    private minIntervalMs = 100,
  ) {}

  /** 注册一个面板（重复 id 抛错：静默覆盖会让"我的面板怎么没出现"极难排查）。 */
  register(def: PanelDef): void {
    if (this.panels.some((p) => p.id === def.id)) throw new Error(`面板已注册：${def.id}`);
    this.panels.push(def);
    // 排序：分区固定序 + 区内 order。排序一次而非每次 render，保证 DOM 顺序稳定。
    const slotRank = (s: HudSlot): number => SLOT_ORDER.indexOf(s);
    this.panels.sort((a, b) => slotRank(a.slot) - slotRank(b.slot) || (a.order ?? 0) - (b.order ?? 0));
  }

  /** 已注册面板（测试断言用）。 */
  ids(): string[] {
    return this.panels.map((p) => p.id);
  }

  /**
   * 渲染一帧：对每个面板取 {key,html}，key 变了才写 DOM。
   *
   * @param force true = 忽略 minIntervalMs 立即刷新（玩家交互后调用）
   * @param nowMs 当前时间（测试可注入）
   * @returns 本次实际写入 DOM 的面板数（0 = 全部命中缓存，本帧零 DOM 操作）
   */
  refresh(view: WorldView, force = false, nowMs = Date.now()): number {
    if (!force && nowMs - this.lastAt < this.minIntervalMs) return 0;
    this.lastAt = nowMs;
    this.lastWrites = 0;
    for (const def of this.panels) {
      const out = def.render(view);
      const wrap = this.ensureNode(def);
      const key = out.key;
      const changed = this.lastKeys.get(def.id) !== key;
      if (changed) {
        this.lastKeys.set(def.id, key);
        const body = this.bodies.get(def.id)!;
        body.innerHTML = out.html;
        this.lastWrites++;
      }
      // 显隐也要差分：empty 状态翻转也要写 DOM，但只在翻转时（下面的 visibleKey 复用同一机制）。
      const visKey = out.empty ? 'e' : 'n';
      const prevVis = body.dataset.v;
      if (prevVis !== visKey) {
        body.dataset.v = visKey;
        wrap.style.display = out.empty ? 'none' : '';
        if (changed) this.lastWrites++; // 内容与显隐同一帧变的，只算一次写
      }
    }
    return this.lastWrites;
  }

  /** 确保某面板的 DOM 骨架存在（分区 → 标题 → body），返回 body 的外层容器。 */
  private ensureNode(def: PanelDef): HTMLElement {
    let wrap = this.wraps.get(def.id);
    if (wrap) return wrap;
    const slotEl = this.ensureSlot(def.slot);
    wrap = document.createElement('div');
    wrap.className = 'panel';
    wrap.dataset.pid = def.id;
    const head = document.createElement('div');
    head.className = 'panel-head';
    head.textContent = `${def.icon ?? ''} ${def.title ?? def.id}`.trim();
    const body = document.createElement('div');
    body.className = 'panel-body';
    wrap.append(head, body);
    slotEl.appendChild(wrap);
    this.wraps.set(def.id, wrap);
    this.bodies.set(def.id, body);
    return wrap;
  }

  /** 确保某分区容器存在（一次创建，追加到 root 末尾）。 */
  private ensureSlot(slot: HudSlot): HTMLElement {
    const id = `slot-${slot}`;
    let el = this.host.querySelector<HTMLElement>(`#${id}`);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'slot';
      el.dataset.slot = slot;
      this.host.appendChild(el);
    }
    return el;
  }
}

/** 分区渲染顺序 = 信息层级：状态条 → 生命/趋势 → 殖民地 → 威胁 → 详情 → 日志。 */
const SLOT_ORDER: HudSlot[] = ['status', 'vitals', 'colony', 'threat', 'detail', 'log'];

/** HTML 转义：mod 内容（科技名/事件/建筑名）可能带尖括号，进 innerHTML 必须转义。 */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 一条带数值条的指标行（需求/血量统一走它，保证视觉一致）。 */
export function barRow(label: string, val: number, color: string): string {
  const v = Math.max(0, Math.min(100, val));
  return (
    `<div class="mrow"><span class="mk" style="color:${color}">${esc(label)}</span>` +
    `<span class="mbar"><i style="width:${v.toFixed(0)}%;background:${color}"></i></span>` +
    `<span class="mv">${Math.round(val)}</span></div>`
  );
}

/** 把定长数值数组拼成稳定的差分 key（数组长度变化也要体现在 key 里）。 */
export function keyOf(...parts: (string | number)[]): string {
  return parts.join('|');
}