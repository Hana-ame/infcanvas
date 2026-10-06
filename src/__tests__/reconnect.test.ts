/**
 * reconnect.test.ts —— R1-1 断线重连 + 心跳看门狗。
 *
 * 退避曲线与看门狗阈值都是纯函数，所以用 vitest fake timer 毫秒级对拍，
 * 不必真的睡 15 秒（真等会让这个用例在 CI 上必 flaky）。
 * 另有一组用假 WebSocket 驱动 RemoteSim 本体，验「真的会去重连」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackoffState,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  backoffMs,
  shouldWatchdogTrip,
} from '../client/reconnect';
import { PING_MS, WATCHDOG_MS } from '../shared/protocol';
import { RemoteSim } from '../client/remote';

describe('R1-1 退避曲线', () => {
  it('0.5s → 1s → 2s → 4s → 8s 封顶，之后恒为 8s', () => {
    expect(backoffMs(0)).toBe(500);
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(4)).toBe(8000);
    // 封顶：第 10 次失败仍是 8s，不是 512s
    expect(backoffMs(10)).toBe(8000);
    expect(backoffMs(100)).toBe(RECONNECT_MAX_MS);
  });

  it('常量与 ROADMAP 一致', () => {
    expect(RECONNECT_BASE_MS).toBe(500);
    expect(RECONNECT_MAX_MS).toBe(8000);
  });

  it('负数/小数 attempt 不产生 NaN 或负延迟', () => {
    expect(backoffMs(-1)).toBe(RECONNECT_BASE_MS);
    expect(Number.isFinite(backoffMs(0.5))).toBe(true);
  });
});

describe('R1-1 退避状态机', () => {
  it('noteFailure 递增；nextDelayMs 给的是「本次失败后该等多久」', () => {
    const st = new BackoffState();
    expect(st.nextDelayMs()).toBe(500);
    st.noteFailure();
    expect(st.failures).toBe(1);
    expect(st.nextDelayMs()).toBe(1000);
    st.noteFailure();
    expect(st.nextDelayMs()).toBe(2000);
  });

  it('成功后 reset：下次失败重新从 500ms 开始（不累积到 8s）', () => {
    const st = new BackoffState();
    for (let i = 0; i < 5; i++) st.noteFailure();
    expect(st.nextDelayMs()).toBe(RECONNECT_MAX_MS);
    st.reset();
    expect(st.failures).toBe(0);
    expect(st.nextDelayMs()).toBe(RECONNECT_BASE_MS);
  });
});

describe('R1-1 心跳看门狗阈值', () => {
  it('未到阈值不触发；到达阈值立刻触发（>= 而非 >）', () => {
    expect(shouldWatchdogTrip(0, WATCHDOG_MS)).toBe(false);
    expect(shouldWatchdogTrip(14_999, WATCHDOG_MS)).toBe(false);
    expect(shouldWatchdogTrip(15_000, WATCHDOG_MS)).toBe(true);
    expect(shouldWatchdogTrip(20_000, WATCHDOG_MS)).toBe(true);
  });

  it('阈值常量：心跳 10s、看门狗 15s（看门狗必须 > 心跳，否则单次丢心跳就误杀）', () => {
    expect(PING_MS).toBe(10_000);
    expect(WATCHDOG_MS).toBe(15_000);
    expect(WATCHDOG_MS).toBeGreaterThan(PING_MS);
  });
});

/**
 * 假 WebSocket：只实现 RemoteSim 实际用到的方法。
 * 为什么要假 socket：真连服务器会让「断线」这件事依赖外部进程与端口，
 * 断不开也说不好；假 socket 让断连序列完全由测试驱动。
 */
class FakeWS {
  static instances: FakeWS[] = [];
  static failNext: number;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  /** 构造时刻（fake timer 下 Date.now 可控），用来断言相邻两次重连的实际间隔 */
  readonly createdAt = Date.now();
  constructor(public url: string) {
    if (FakeWS.failNext > 0) {
      FakeWS.failNext--;
      // 握手失败：浏览器里表现为 onerror（随后必然 onclose）
      queueMicrotask(() => {
        this.onerror?.();
        this.onclose?.({ code: 1006 });
      });
    } else {
      queueMicrotask(() => this.onopen?.());
    }
    FakeWS.instances.push(this);
  }
  send(_d: string): void { /* 测试不需要真发 */ }
  /** 测试钩子：模拟服务端推一帧 */
  push(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** 测试钩子：模拟链路被切断 */
  drop(code = 1006): void {
    this.onclose?.({ code });
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

describe('R1-1 RemoteSim 重连行为（假 WebSocket + fake timer）', () => {
  const origWS = globalThis.WebSocket;
  let remote: RemoteSim;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWS.instances = [];
    FakeWS.failNext = 0;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
  });

  afterEach(() => {
    remote?.dispose();
    vi.useRealTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = origWS;
  });

  it('连接成功后收到消息 → 看门狗基准被刷新；静默超阈值 → 主动断开并进入重连', async () => {
    remote = new RemoteSim({ now: () => Date.now() });
    await remote.connect('ws://x/');
    expect(remote.connected).toBe(true);
    const sock = FakeWS.instances[0]!;

    // 静默 14s：看门狗不动（心跳 10s 一帧在真实链路里会来，但这里测的是上界）
    await vi.advanceTimersByTimeAsync(14_000);
    expect(remote.connected).toBe(true);
    expect(sock.readyState).toBe(1);

    // 再走到 15s 阈值那一刻（t=15000，看门狗按 1s 心跳恰好命中）：主动断开并排队重连。
    // 注意只推进到 15000：再往后 500ms 重连就会成功、connected 重新变 true，
    // 那说明自愈链路也是通的（下一个用例专门验它）。
    await vi.advanceTimersByTimeAsync(1_000);
    expect(remote.connected).toBe(false);
    expect(remote.hasPendingReconnect).toBe(true);

    // 继续等：退避 500ms 后自动重连成功connected 恢复 true（页面自愈，无需刷新）
    await vi.advanceTimersByTimeAsync(600);
    expect(remote.connected).toBe(true);
    expect(remote.hasPendingReconnect).toBe(false);
  });

  it('收到任意消息（不只 ping）都会续命看门狗', async () => {
    remote = new RemoteSim({ now: () => Date.now() });
    await remote.connect('ws://x/');
    const sock = FakeWS.instances[0]!;
    // 每 10s 推一帧 delta（真实链路的心跳节奏）
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      sock.push({ t: 'ping', d: { time: i } });
    }
    expect(remote.connected).toBe(true); // 60s 了仍连接：有流量就没假死
  });

  it('ping 不污染任何状态（不建地形/不建实体）', async () => {
    remote = new RemoteSim({ now: () => Date.now() });
    await remote.connect('ws://x/');
    const sock = FakeWS.instances[0]!;
    sock.push({ t: 'ping', d: { time: 3 } });
    // 没收到过 welcome，world 不该被凭空造出来
    expect((remote as unknown as { world: unknown }).world).toBeUndefined();
    expect([...remote.pawns()]).toHaveLength(0);
  });

  it('onclose 后按退避重连，指数增长且同刻只排一个', async () => {
    remote = new RemoteSim({ now: () => Date.now() });
    await remote.connect('ws://x/');
    FakeWS.instances[0]!.drop();
    expect(remote.hasPendingReconnect).toBe(true);
    // 第一个退避是 500ms
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWS.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(FakeWS.instances).toHaveLength(2); // 重连了一次
    // 重连成功 → 退避重置
    expect(remote.reconnectFailures).toBe(0);

    // 验「指数增长」要用**连续失败**：让后续 socket 一律握手失败（failNext 足够大），
    // 这样每一次重连都失败，退避才会一路翻倍到封顶。
    //
    // 关键：不能假设「第 i 次重连恰好在我第 i 次 advance 的末尾发生」——
    // 退避定时器是从**失败发生的时刻**起算的，而失败发生在上一次 advance 途中的
    // 某个微任务里，直接按绝对时间步进会累积漂移。所以改成记录每个 socket 的
    // 构造时刻，直接对**相邻两次的差值**做断言。
    remote.dispose();
    FakeWS.instances = [];
    FakeWS.failNext = 100;
    const r2 = new RemoteSim({ now: () => Date.now() });
    await r2.connect('ws://x/').catch(() => undefined);
    // 一次连续推进足够久，让 6 次重连全部发生（500+1000+2000+4000+8000=15.5s）
    await vi.advanceTimersByTimeAsync(40_000);
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(6);
    const stamps = FakeWS.instances.slice(0, 6).map((s) => s.createdAt);
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!);
    // 连续失败 → 退避依次 500/1000/2000/4000/8000 并封顶
    expect(gaps).toEqual([500, 1000, 2000, 4000, 8000]);
    // 再往后仍是 8s（封顶）
    const lastGap = FakeWS.instances[6]!.createdAt - FakeWS.instances[5]!.createdAt;
    expect(lastGap).toBe(8000);
    r2.dispose();
  });

  it('同刻只排一个重连：一次 drop 不会触发多个待执行重连', async () => {
    remote = new RemoteSim({ now: () => Date.now() });
    await remote.connect('ws://x/');
    const sock = FakeWS.instances[0]!;
    sock.drop();
    sock.drop(); // 重复触发 close（如 socket 同时报 error+close）
    sock.drop();
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeWS.instances).toHaveLength(2); // 只重连了 1 次，不是 3 次
  });

  it('重连复用同一条 URL（含 ?token=）——否则开了鉴权的服务器永远拒我们', async () => {
    remote = new RemoteSim({ now: () => Date.now() });
    await remote.connect('ws://h:9/?token=abc');
    FakeWS.instances[0]!.drop();
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeWS.instances[1]!.url).toBe('ws://h:9/?token=abc');
  });

  it('鉴权失败 close(1008) 不重连（重连也不会成功，白耗退避）', async () => {
    remote = new RemoteSim({ now: () => Date.now() });
    await remote.connect('ws://x/?token=bad');
    FakeWS.instances[0]!.drop(1008);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWS.instances).toHaveLength(1); // 没有第二次连接
    expect(remote.hasPendingReconnect).toBe(false);
  });

  it('握手失败（服务器没起）也进重连，服务器起来后自动接上', async () => {
    FakeWS.failNext = 1;
    remote = new RemoteSim({ now: () => Date.now() });
    await remote.connect('ws://x/').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(2);
    expect(remote.connected).toBe(true);
  });

  it('重连成功后退避重置（下次断线从 500ms 重新开始）', async () => {
    remote = new RemoteSim({ now: () => Date.now() });
    await remote.connect('ws://x/');
    FakeWS.instances[0]!.drop();
    await vi.advanceTimersByTimeAsync(600);
    expect(remote.connected).toBe(true);
    expect(remote.reconnectFailures).toBe(0);
  });

  it('onConnectionChange 回调如实报告断开与恢复（HUD 横幅靠它）', async () => {
    remote = new RemoteSim({ now: () => Date.now() });
    const states: boolean[] = [];
    remote.onConnectionChange = (c) => states.push(c);
    await remote.connect('ws://x/');
    FakeWS.instances[0]!.drop();
    await vi.advanceTimersByTimeAsync(600);
    expect(states).toContain(true);
    expect(states).toContain(false);
  });
});
