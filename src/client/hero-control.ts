/**
 * client/hero-control.ts —— 主角操控层（P3 无感）。
 *
 * 一层极薄的适配：把「移动方向 / 攻击 / 交互」三种**意图**翻译成权威侧调用。
 *   - 本地模式（sim）→ 直接调浏览器内 Sim 的 moveDir / directAttack / interact；
 *   - 联机模式（remote）→ 走 RemoteSim 上行 input，服务端每 tick 消费最新一份。
 *
 * 上层（main.ts）只跟 HeroControl 打交道，完全不知道底下是哪条传输——
 * 这就是「无感」的落点：同一份按键处理代码，两种模式产出同一种意图。
 *
 * 为什么单独一个文件而不是塞进 main.ts：main.ts 是启动编排层（429 行），
 * 再混进传输分支会让「无感」退化成散落各处的 `remoteCtl ? ... : ...` 三元。
 *
 * 语义对齐（两端必须一致，否则手感就会"有感"）：
 *  - 移动是**持续意图**：每帧上报最新方向，服务端/本地每 tick 消费一次。
 *    松键上报 (0,0) —— 服务端据此清 lastInput 停下（见 consumeClientInputs），
 *    本地 moveDir(0,0) 天然不动。两端都是"松键即停"。
 *  - 动作是**一次性脉冲**：attack / interact 消费即弃，服务端 lastInput 清零，
 *    本地 directAttack/interact 自带 atkCd 冷却。两端都是"按一次打一次"。
 */
import type { Sim } from '../sim';
import type { Eid } from '../sim/types';
import type { RemoteSim } from './remote';

/** 主角操控的对外契约：上层只看见意图，看不见传输 */
export interface HeroControl {
  /** 当前受控鼠；null = 观察模式（未认领） */
  get eid(): Eid | null;
  setEid(eid: Eid | null): void;
  /** 持续移动意图。dt 仅本地路径需要（moveDir 按秒结算位移） */
  move(vx: number, vy: number, dt: number): void;
  /** 一次性动作意图 */
  act(kind: 'attack' | 'interact'): void;
}

/**
 * 远程输入的最小发送间隔（ms）。
 *
 * 服务端 tick 是 20Hz（tickMs=50），按 60Hz 上行会把三分之一的消息直接覆盖掉
 * ——白跑带宽。33ms ≈ 30Hz，比 tick 快一档，手感不丢。0 = 不节流（测试用）。
 */
export const REMOTE_INPUT_MIN_INTERVAL_MS = 33;

/**
 * 造一个 HeroControl。
 *
 * sim / remote 二选一（本地模式传 sim、联机模式传 remote）。都传 sim 优先——
 * 本地模式即使挂着 remote 变量也不该误走网络。
 */
export function makeHeroControl(opts: {
  sim: Sim | null;
  remote: RemoteSim | null;
  minIntervalMs?: number;
  clock?: () => number;
}): HeroControl {
  const { sim, remote } = opts;
  const minIntervalMs = opts.minIntervalMs ?? REMOTE_INPUT_MIN_INTERVAL_MS;
  const clock = opts.clock ?? (() => Date.now());
  let eid: Eid | null = null;
  let lastRemoteMoveMs = 0;

  return {
    get eid(): Eid | null {
      return eid;
    },
    setEid(next: Eid | null): void {
      eid = next;
    },
    move(vx: number, vy: number, dt: number): void {
      if (eid === null) return;
      if (sim) {
        const p = sim.pawn(eid);
        if (p) sim.moveDir(p, vx, vy, dt);
        return;
      }
      if (!remote) return;
      // 节流：超过间隔才上行。松键帧（0,0）同样节流——服务端消费后清 lastInput，
      // 少发一帧不影响"停下"这个语义。
      if (minIntervalMs > 0) {
        const now = clock();
        if (lastRemoteMoveMs !== 0 && now - lastRemoteMoveMs < minIntervalMs) return;
        lastRemoteMoveMs = now;
      }
      remote.sendInput(vx, vy);
    },
    act(kind: 'attack' | 'interact'): void {
      if (eid === null) return;
      if (sim) {
        if (kind === 'attack') sim.directAttack(eid);
        else sim.interact(eid);
        return;
      }
      remote?.sendInput(0, 0, kind);
    },
  };
}
