/**
 * client/interp.ts —— 远程快照的渲染层插值（R1-3）的**纯计算部分**。
 *
 * 问题：服务端 delta ~500ms 一帧，客户端直接画最新位置 = 每 500ms 瞬移一次，
 * 肉眼是明显的「传送感」。做法是保留上一帧位置，在两次快照之间线性插值。
 *
 * 核心红线（ROADMAP 验收）：**插值只存在于渲染层副本，绝不污染逻辑状态**。
 * 具体做法：这里的函数全是纯函数——输入 prev/next/k，输出一个新坐标对象，
 * 不修改任何入参。调用方（remote.ts）把结果存进**独立的渲染投影表**，
 * pawnMap 里的逻辑状态（needs/hp/cardId…）与权威 pos 永远不被改写。
 *
 * 文件头注释里的「为什么不直接改 pawnMap.pos」是有血的教训：
 * 一旦就地改，render 与 HUD 看到的 pos 就不再等于服务端事实，
 * 点选命中、框选范围、事件重放全部会跟着漂，且这种漂移极难定位。
 */
import type { Pos } from '../sim/types';

/**
 * 线性插值（纯函数，不改入参）。
 * k 会先 clamp 到 [0,1]：超出范围不应外推——外推会在快照乱序到达时
 * 把实体甩到天边，clamp 让它最多停在端点上。
 */
export function lerpPos(prev: Pos, next: Pos, k: number): Pos {
  const t = clamp01(k);
  return {
    x: prev.x + (next.x - prev.x) * t,
    y: prev.y + (next.y - prev.y) * t,
  };
}

export function clamp01(k: number): number {
  // NaN 单独处理：它不是「超出范围」，而是「算不出来」——回落到 0（停在起点）最安全。
  if (Number.isNaN(k)) return 0;
  // ±Infinity 是真正的超界，按饱和方向截断（+∞→1、-∞→0），与 lerp 的直觉一致。
  if (k <= 0) return 0;
  if (k >= 1) return 1;
  return k;
}

/**
 * 由「自上次快照到现在的真实经过时间」与「两个快照间隔」算出插值系数 k。
 *
 * 为什么归一化用 deltaSec 而不是固定步长：delta 间隔本身会抖动（网络拥塞时
 * 可能 1.2s 才来一帧），固定步长会让插值在慢帧时「跑过头」——实体追上了
 * 下一帧的目标位置又开始反向抖动。归一化后 k 恒在 [0,1]，慢帧时表现为
 * 插值进行得慢一些（可接受的迟滞），而不是越界抖动。
 *
 * intervalSec 传 0 或负数（首帧/时钟异常）时返回 1——没有区间就没有插值，
 * 直接落在权威位置上，这是最安全的行为。
 */
export function interpK(elapsedSinceLastMs: number, intervalSec: number): number {
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return 1;
  const k = elapsedSinceLastMs / 1000 / intervalSec;
  return clamp01(k);
}

/**
 * 双缓冲位置槽：渲染层专用的一对 prev/next。
 * 每来一帧新快照，advance 把 next 挪到 prev、next 设为新位置；
 * snapshot(clock) 返回插值后的坐标，**不触碰**调用方的权威 pawn 对象。
 *
 * 为什么不直接在 PawnState 上挂 prevPos 字段：PawnState 是协议结构，
 * 往协议里塞渲染态会让服务端也被迫携带它（浪费带宽）且两端模型耦合。
 * 渲染态归渲染层，这是 view.ts 开头「渲染层不持任何逻辑状态」原则的延续——
 * 只不过这里的「状态」是表现状态，不参与任何逻辑判定。
 */
export class InterpSlot {
  prev: Pos;
  next: Pos;
  /** 两次快照之间的模拟时间差（秒）；用于把真实经过时间归一化成 k */
  intervalSec = 0;

  constructor(init: Pos) {
    this.prev = { x: init.x, y: init.y };
    this.next = { x: init.x, y: init.y };
  }

  /** 收到新快照：把当前目标挪成起点。刻意 copy 而非引用——避免入参被后续改写。 */
  advance(p: Pos, newIntervalSec: number): void {
    this.prev = { x: this.next.x, y: this.next.y };
    this.next = { x: p.x, y: p.y };
    this.intervalSec = newIntervalSec;
  }

  /** full/welcome 到达 = 权威对账，直接吸附：插值对账只会造成错误的中间态 */
  snapTo(p: Pos): void {
    this.prev = { x: p.x, y: p.y };
    this.next = { x: p.x, y: p.y };
    this.intervalSec = 0;
  }

  /** 当前应渲染的位置（纯计算，不改本对象与任何外部状态） */
  snapshot(elapsedSinceLastMs: number): Pos {
    return lerpPos(this.prev, this.next, interpK(elapsedSinceLastMs, this.intervalSec));
  }
}
