/**
 * client/reconnect.ts —— 断线重连的**纯状态机**（R1-1），不含任何定时器/网络调用。
 *
 * 为什么要抽成纯函数：重连逻辑天然涉及定时器与回调，直接在 RemoteSim 里写就只能
 * 靠真实等待来测（十几秒且不稳定，CI 上必 flaky）。把「下一次该等多久」「看门狗
 * 是否超时」全部做成纯函数后，可用 vitest fake timer 毫秒级对拍。
 *
 * 退避曲线：0.5s → 1s → 2s → 4s → 8s 封顶，每次成功连上后重置。
 * 封顶 8s 而非无限，是因为玩家要的是「服务器回来后自动恢复」，
 * 8s 的最长等待完全可接受，而无限退避会让重启后的恢复时间不可预测。
 */

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 8000;

/**
 * 退避时长：第 attempt 次失败后应等待的毫秒数（attempt 从 0 起）。
 * 封顶到 RECONNECT_MAX_MS：反复失败时最多等 8s，兼顾响应性与服务端压力。
 */
export function backoffMs(attempt: number): number {
  if (attempt <= 0) return RECONNECT_BASE_MS;
  const v = RECONNECT_BASE_MS * Math.pow(2, attempt);
  return Math.min(RECONNECT_MAX_MS, v);
}

/**
 * 看门狗判定：距上次收到消息 elapsedMs 超过阈值即判定假死。
 * 用 >= 而非 >：阈值语义是「最多容忍这么久」，到达阈值的那一刻就该动手。
 */
export function shouldWatchdogTrip(elapsedMs: number, thresholdMs: number): boolean {
  return elapsedMs >= thresholdMs;
}

/**
 * 重连退避状态机（纯逻辑，无副作用）。
 * 持 attempt 计数，产出 delay，外部负责真的 setTimeout。
 * 之所以不自己管定时器：本模块要能被 fake timer 精确驱动，
 * 而混进真实定时器会让「未连接时是否还在排队重连」这类状态难以断言。
 */
export class BackoffState {
  private attempt = 0;

  /** 一次连接失败后的等待时长（毫秒）。连续调用不递增——由 noteFailure 驱动。 */
  nextDelayMs(): number {
    return backoffMs(this.attempt);
  }

  /** 记录一次失败，准备下一次退避 */
  noteFailure(): void {
    this.attempt++;
  }

  /** 连接成功（open 或收到 welcome）后重置，下次失败从 0.5s 重新开始 */
  reset(): void {
    this.attempt = 0;
  }

  /** 当前已连续失败次数（测试与调试用） */
  get failures(): number {
    return this.attempt;
  }
}
