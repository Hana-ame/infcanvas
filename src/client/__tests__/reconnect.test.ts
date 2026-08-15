// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteSim } from '../../client/remote';
import type { WelcomeMsg } from '../../shared/protocol';

// 断线重连：fake WebSocket + fake timers 模拟连接/断开/恢复序列
class FakeWs {
  static instances: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readyState = 0; // 模拟 OPEN=1
  sent: string[] = [];
  closed = false;

  constructor(public url: string) {
    FakeWs.instances.push(this);
  }

  send(d: string): void { this.sent.push(d); }
  close(): void {
    this.closed = true;
    // 模拟真实 WebSocket：close() 后异步触发 onclose
    setTimeout(() => this.onclose?.(), 0);
  }

  static reset(): void { FakeWs.instances = []; }
}

const WELCOME: WelcomeMsg = {
  type: 'welcome', you: 1, seed: 42, tickHz: 20, dayLength: 120,
  tuning: { needs: { foodMoodLow: 30 }, faction: { unitCapChurch: 10, unitCapCampfire: 3 }, env: { dayLength: 120, baseTemp: 18 } },
  world: { width: 4, height: 3 },
  tiles: { grass: { id: 'grass', color: '#3a7d44', passable: true, buildable: true } },
  buildings: {},
  items: {},
  tileGrid: [{ x: 0, y: 0, tiles: ['grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass'] }],
};

describe('RemoteSim 断线重连（P1）', () => {
  let originalWs: typeof WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWs.reset();
    originalWs = globalThis.WebSocket;
    globalThis.WebSocket = FakeWs as unknown as typeof WebSocket;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    globalThis.WebSocket = originalWs;
    vi.useRealTimers();
  });

  async function connectSim(): Promise<RemoteSim> {
    const rs = new RemoteSim('ws://fake');
    const p = rs.connect();
    const ws = FakeWs.instances[0];
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify(RECOVERABLE_WELCOME()) });
    await p;
    return rs;
  }

  function RECOVERABLE_WELCOME(): WelcomeMsg {
    return { ...RECOVER, tileGrid: [...RECOVER.tileGrid] };
  }

  it('连接成功后断开 → 自动重连（指数退避）→ welcome 恢复', async () => {
    const rs = await connectSim();
    const statuses: string[] = [];
    rs.onStatus = (s) => statuses.push(s);
    expect(rs.status).toBe('connected');

    // 断线
    FakeWs.instances[0]!.onclose?.();
    expect(statuses[0]).toBe('reconnecting');
    expect(document.getElementById('remote-hint')?.textContent).toContain('自动重连');

    // 第一次退避 1s → 第二次重连
    vi.advanceTimersByTime(1001);
    expect(FakeWs.instances.length).toBe(2);
    expect(statuses).toEqual(['reconnecting', 'reconnecting']);
    expect(rs.status).toBe('reconnecting');

    // 重连成功：onopen + 新 welcome → connected，hint 清除
    const ws2 = FakeWs.instances[1]!;
    ws2.onopen?.();
    expect(statuses[statuses.length - 1]).toBe('connected');
    ws2.onmessage?.({ data: JSON.stringify(RECOVERABLE_WELCOME()) });
    expect(document.getElementById('remote-hint')).toBeNull();
    expect(FakeWs.instances[1]!.closed).toBe(false);
  });

  it('断线后延迟随次数指数增长，封顶 15s', async () => {
    const rs = await connectSim();
    rs.onStatus = () => {};
    for (let i = 0; i < 3; i++) {
      FakeWs.instances[FakeWs.instances.length - 1]!.onclose?.();
      // 退避轮次 1,2,4 → 推进到下一次 open
      vi.advanceTimersByTime(1000 * 2 ** i + 1);
      expect(FakeWs.instances.length).toBe(i + 2);
    }
    // 第 4 次断开：delay = min(15000, 8000) = 8000
    FakeWs.instances[FakeWs.instances.length - 1]!.onclose?.();
    vi.advanceTimersByTime(7999);
    expect(FakeWs.instances.length).toBe(4); // 还没到
    vi.advanceTimersByTime(2);
    expect(FakeWs.instances.length).toBe(5);
  });

  it('看门狗：connected 后无消息超时 → 主动断开重连（server 假死兜底）', async () => {
    const rs = await connectSim();
    rs.watchdogMs = 3000;
    const statuses: string[] = [];
    rs.onStatus = (s) => statuses.push(s);
    // 正常消息流刷新看门狗（模拟 snapshot 到达）
    FakeWs.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'snapshot', t: 1, paused: false, speed: 1, isNight: false, day: 1, weather: { raining: false, temperature: 18 }, stockpile: {}, pawns: [], hostiles: [], buildings: [], buildQueue: [], buildingVersion: 0 }) });
    vi.advanceTimersByTime(2000);
    expect(FakeWs.instances[0]!.closed).toBe(false); // 还有消息，不断
    // 静默超过 watchdogMs → 主动 close → 重连调度
    vi.advanceTimersByTime(2000);
    expect(FakeWs.instances[0]!.closed).toBe(true);
    vi.advanceTimersByTime(1); // 让 close() 排队的 onclose 回调落拍
    expect(statuses).toContain('reconnecting');
    // 恢复：重连 socket 上持续收到消息（模拟 2Hz snapshot）→ 不再主动断
    vi.advanceTimersByTime(1001);
    const ws2 = FakeWs.instances[1]!;
    ws2.onopen?.();
    const snap = () => ws2.onmessage?.({ data: JSON.stringify({ type: 'snapshot', t: 2, paused: false, speed: 1, isNight: false, day: 1, weather: { raining: false, temperature: 18 }, stockpile: {}, pawns: [], hostiles: [], buildings: [], buildQueue: [], buildingVersion: 0 }) });
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(500);
      snap();
    }
    expect(ws2.closed).toBe(false);
  });

  it('首次连接失败 → connect reject（不进入重连）', async () => {
    const rs = new RemoteSim('ws://fake');
    const p = rs.connect();
    FakeWs.instances[0]!.onclose?.();
    await expect(p).rejects.toThrow(/连接失败/);
    expect(FakeWs.instances.length).toBe(1);
    expect(rs.status).toBe('connecting');
  });

  it('destroy() 停止重连并关闭 socket', async () => {
    const rs = await connectSim();
    FakeWs.instances[0]!.onclose?.();
    rs.destroy();
    expect(rs.status).toBe('offline');
    vi.advanceTimersByTime(5000);
    expect(FakeWs.instances.length).toBe(1); // 没有新连接
  });

  it('重连后快照数据继续流动（server 时间继续前进）', async () => {
    const rs = await connectSim();
    FakeWs.instances[0]!.onclose?.();
    vi.advanceTimersByTime(1001);
    const ws2 = FakeWs.instances[1]!;
    ws2.onopen?.();
    ws2.onmessage?.({ data: JSON.stringify(RECOVERABLE_WELCOME()) });
    ws2.onmessage?.({ data: JSON.stringify({ type: 'snapshot', t: 999, paused: false, speed: 1, isNight: false, day: 9, weather: { raining: false, temperature: 20 }, stockpile: { wood: 1 }, pawns: [], hostiles: [], buildings: [], buildQueue: [], buildingVersion: 3 }) });
    expect(rs.time).toBe(999);
  });

  it('tick delta：增量合并进视图（位置/需求/job 更新、新 pawn、死亡 removed、建筑 hp）', async () => {
    const rs = await connectSim();
    vi.advanceTimersByTime(500);
    const ws0 = FakeWs.instances[0]!;
    // 全量底
    ws0.onmessage?.({ data: JSON.stringify({ type: 'snapshot', t: 10, paused: false, speed: 1, isNight: false, day: 1, weather: { raining: false, temperature: 18 }, stockpile: { wood: 3 }, pawns: [{ eid: 1, x: 5, y: 5, hp: 50, maxHp: 50, job: '伐木', faith: 0, attrs: { str: 10, con: 10, siz: 10, dex: 10, int: 10, pow: 10, app: 10, edu: 10 }, skills: { work: 20 }, traits: [], maxSlots: 3, slots: [], desires: {} }], hostiles: [], buildings: [{ defId: 'campfire', x: 2, y: 2, hp: 100, maxHp: 100, faction: 'a', footprint: [{ x: 2, y: 2 }] }], buildQueue: [], buildingVersion: 1 }) });
    expect(rs.pawnProfile(1)!.pos).toEqual({ x: 5, y: 5 });

    // delta 1：位置 + job + needs 变化 → 只合并这些字段
    ws0.onmessage?.({ data: JSON.stringify({ type: 'delta', t: 10.5, pawns: [{ eid: 1, x: 6, y: 7, job: '闲逛', needs: { food: 20, rest: 30, mood: 60, san: 90 } }] }) });
    const p = rs.pawnProfile(1)!;
    expect(p.pos).toEqual({ x: 6, y: 7 });
    expect(p.job).toBe('闲逛');
    expect(p.needs!.food).toBe(20);
    expect(p.dna.str).toBe(10); // attrs 未被 delta 覆盖，保留旧值
    expect(p.skills.work).toBe(20);
    expect(rs.healthOf(1)!.hp).toBe(50);

    // delta 2：新 pawn 首现（带 attrs）+ pawnList
    ws0.onmessage?.({ data: JSON.stringify({ type: 'delta', t: 11, pawns: [{ eid: 2, x: 1, y: 1, hp: 40, maxHp: 50, job: '采矿', faith: 0.1, attrs: { str: 12, con: 11, siz: 10, dex: 9, int: 10, pow: 11, app: 8, edu: 12 }, skills: {}, traits: [], maxSlots: 3, slots: [], desires: {} }], pawnList: [1, 2] }) });
    expect(rs.pawnProfile(2)!.dna.dex).toBe(9);
    expect(rs.pawns).toEqual([1, 2]);

    // delta 3：建筑 hp 变化 + 全局 stockpile/day
    ws0.onmessage?.({ data: JSON.stringify({ type: 'delta', t: 11.5, day: 2, stockpile: { wood: 5 }, buildings: [{ key: 2 + 2 * 2 ** 31, defId: 'campfire', hp: 80, maxHp: 100, faction: 'a', footprint: [{ x: 2, y: 2 }] }] }) });
    expect(rs.day).toBe(2);
    expect(rs.stockpile.wood).toBe(5);
    expect(rs.buildingAt(2, 2)!.hp).toBe(80);
    expect(rs.time).toBe(11.5);

    // delta 4：pawn 死亡 removed
    ws0.onmessage?.({ data: JSON.stringify({ type: 'delta', t: 12, pawns: [{ eid: 2, removed: true }], pawnList: [1] }) });
    expect(rs.pawnProfile(2)).toBeNull();
    expect(rs.pawnPositions.has(2)).toBe(false);
    expect(rs.pawns).toEqual([1]);
  });
});

const RECOVER: WelcomeMsg = {
  type: 'welcome', you: 1, seed: 42, tickHz: 20, dayLength: 120,
  tuning: { needs: { foodMoodLow: 30 }, faction: { unitCapChurch: 10, unitCapCampfire: 3 }, env: { dayLength: 120, baseTemp: 18 } },
  world: { width: 4, height: 3 },
  tiles: { grass: { id: 'grass', color: '#3a7d44', passable: true, buildable: true } },
  buildings: {},
  items: {},
  tileGrid: [{ x: 0, y: 0, tiles: ['grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass'] }],
};