/**
 * client/input.ts —— 主角直接操控输入层（P1 MVP，2026-10-13）。
 *
 * 设计背景：改版目标 = 暗黑-like 直接操控（KB proj-infcanvas-direct-control-proposal-2026-10-13，
 * 终版口径：以人操纵为主 + 成功率判定，可跳过抽卡）。本文件是"人操纵"的输入面：
 * 键盘（WASD/方向键）与触屏虚拟摇杆都产出**归一化方向向量**，喂给 sim 的 moveDir。
 *
 * 结构：**纯逻辑与 DOM 接线分离**（node 单测只测纯函数/纯状态机，不碰 window）：
 *  - `moveVector(keys)` / `joystickVector(dx,dy)`：纯函数（向量合成 + 归一化 + 死区）；
 *  - `KeyboardInput`：键状态机（down/up/vector 纯逻辑，attach/detach 才碰 DOM）；
 *  - `VirtualJoystick`：触屏摇杆（pointer 事件 → 向量），P1 默认仅在触摸设备挂载。
 *
 * 为什么不把按键直写主角坐标：移动本体走 sim.moveDir（权威侧位移 + 碰撞），
 * 输入层只声明"方向意图"，符合"以人操纵为主、不强制过卡"的口径。
 */

/** 方向键绑定：键码 → 单位方向（WASD + 方向键双套，两套同时按 = 同向合并）。 */
export const KEY_DIRS: Record<string, { x: number; y: number }> = {
  KeyW: { x: 0, y: -1 },
  ArrowUp: { x: 0, y: -1 },
  KeyS: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: 1 },
  KeyA: { x: -1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  KeyD: { x: 1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

/** 由一组按下的键码合成移动向量：同向合并、对角归一化到 1/√2。纯函数。 */
export function moveVector(keys: Iterable<string>): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const k of keys) {
    const d = KEY_DIRS[k];
    if (d) {
      x += d.x;
      y += d.y;
    }
  }
  if (x === 0 && y === 0) return { x: 0, y: 0 };
  const len = Math.hypot(x, y);
  return { x: x / len, y: y / len };
}

/**
 * 摇杆原始位移 → 归一化向量（带死区）。纯函数。
 * deadzone 语义：摇杆推杆低于该比例视为"没推"（避免指尖抖动漂移）；
 * 位移长度 > 1 时钳制到 1（方向优先，幅度仅用于归一化）。
 */
export function joystickVector(dx: number, dy: number, deadzone = 0.15): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (len < deadzone || len === 0) return { x: 0, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** 键盘状态机（纯逻辑，可 node 单测；DOM 接线在 attach/detach）。 */
export class KeyboardInput {
  private keys = new Set<string>();

  down(code: string): void {
    this.keys.add(code);
  }
  up(code: string): void {
    this.keys.delete(code);
  }
  isDown(code: string): boolean {
    return this.keys.has(code);
  }
  /** 当前移动向量（按下的方向键合成）。 */
  vector(): { x: number; y: number } {
    return moveVector(this.keys);
  }
  attach(): void {
    if (typeof window === 'undefined') return; // node 单测不挂 DOM
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // 按键连发不重复触发 down（浏览器 keydown 会 repeat）
  }
  detach(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
  private onKeyDown = (e: KeyboardEvent): void => {
    if (KEY_DIRS[e.code]) {
      // 方向键/WASD 不抢浏览器滚动（箭头键会滚页）
      if (e.code.startsWith('Arrow')) e.preventDefault();
      this.down(e.code);
    }
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.up(e.code);
  };
}

export interface JoystickCallbacks {
  /** 摇杆向量变化（归一化；回中 = {0,0}）。 */
  onVector(v: { x: number; y: number }): void;
}

/**
 * 触屏虚拟摇杆（P1）：在宿主元素上按下/拖动 → 相对起点位移 → 归一化向量。
 * DOM 接线隔离在 attach/detach（node 单测不构造本类）。
 * 为什么不在主画布上直接画摇杆：画布同时承载点选/平移/缩放，摇杆要独立命中区
 * （画布事件与摇杆事件互不干扰，避免"推摇杆的同时在画布上画框"）。
 */
export class VirtualJoystick {
  private active = false;
  private origin = { x: 0, y: 0 };
  private last = { x: 0, y: 0 };
  /** 摇杆活动半径（CSS px）：位移超过该半径视为满推。 */
  private readonly radius: number;

  constructor(
    private el: HTMLElement,
    private cb: JoystickCallbacks,
    opts: { radius?: number } = {},
  ) {
    this.radius = opts.radius ?? 48;
    // 可选视觉圆钮：跟随推杆位移（拿不到就只报向量，不影响逻辑）
    const knob = el.querySelector('[data-joy-knob]');
    this.knob = knob instanceof HTMLElement ? knob : null;
  }

  private knob: HTMLElement | null = null;

  attach(): void {
    this.el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  }
  detach(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
  }
  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.active = true;
    this.origin = { x: e.clientX, y: e.clientY };
    this.last = { x: 0, y: 0 };
    this.renderKnob(0, 0);
    this.cb.onVector({ x: 0, y: 0 });
  };
  private onMove = (e: PointerEvent): void => {
    if (!this.active) return;
    const dx = e.clientX - this.origin.x;
    const dy = e.clientY - this.origin.y;
    const norm = joystickVector(dx / this.radius, dy / this.radius);
    // 去抖：位移差 < 2% 不回调（避免高频微动刷帧）
    if (Math.abs(norm.x - this.last.x) < 0.02 && Math.abs(norm.y - this.last.y) < 0.02) return;
    this.last = norm;
    this.renderKnob(norm.x, norm.y);
    this.cb.onVector(norm);
  };
  private onUp = (): void => {
    if (!this.active) return;
    this.active = false;
    this.renderKnob(0, 0);
    this.cb.onVector({ x: 0, y: 0 });
  };
  /** 圆钮跟随推杆位移（满推 = 半径 px）；无钮时跳过。 */
  private renderKnob(nx: number, ny: number): void {
    if (!this.knob) return;
    this.knob.style.transform = `translate(${nx * this.radius}px, ${ny * this.radius}px)`;
  }
}

/** 综合输入源（P1）：键盘向量优先，摇杆向量在键盘为空时兜底。 */
export interface InputSource {
  vector(): { x: number; y: number };
}
