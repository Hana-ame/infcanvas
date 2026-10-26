/**
 * P3 无感：服务端同时支持远程 WS 客户端与同进程本地客户端
 *
 * 背景：`createGameServer` 原先硬编码 `new WebSocketServer(...)`，只有一条
 * 传输通道。这带来两个真实缺口：
 *   1. 浏览器本地模式跑的是**浏览器内独立 Sim**，与 server 完全无关——
 *      "server 支持本地"今天根本不成立；
 *   2. 无头测试/嵌入式宿主只能靠真实 TCP 往返，`ws` 又是 node-only。
 *
 * 本文件钉住 `localConnect()`：与远程 WS 客户端**共用 handleConnection**，
 * 同一段命令白名单、参数校验、claim 认领、input 消费、区块裁剪、心跳。
 * 语义一致的保证来自"同一段代码"，测试负责证明这条通道真的活着、
 * 两种通道真的能共存、跑出的是同一种效果。
 *
 * 断言隔离：disableSystem('behavior')（同 p3-claim-input.test.ts），
 * 禁掉 per-pawn AI 决策系统，鼠只可能被 consumeClientInputs 驱动。
 * 注意 pawn-bookkeeping（技能冷却/蓄力推进/疲劳）不走系统注册，蓄力链路是通的。
 */
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/game-server';
import { ModRegistry } from '../mods';
import type { ClientMsg } from '../shared/protocol';

type Ack = { t: 'claimAck'; d: { ok: boolean; eid?: number; reason?: string } };

/** 两种通道归一到同一形状：这是"无感"在测试里的投影 */
interface AnyClient {
  sendClaim(d: unknown): void;
  sendInput(vx: number, vy: number, act?: 'attack' | 'interact'): void;
  /** 发任意原始消息（坏形状测试用：绕过上面三个方法的类型收窄） */
  sendRaw(msg: unknown): void;
  next<T>(t: string, timeoutMs?: number): Promise<T>;
  close(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等条件成立，而不是固定 sleep。
 * input 上行到 consumeClientInputs 消费之间隔着一个 tick 周期（tickMs=50），
 * 固定 sleep(40) 刚好可能落在 tick 边界之前——那是"本地过、CI 红"的竞态。
 * 等"可观测事实"而不是等一个猜测的时间。
 */
async function waitFor(cond: () => boolean, timeoutMs = 4000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(intervalMs);
  }
  throw new Error(`等 ${timeoutMs}ms 超时：条件未成立`);
}

/** 带缓冲的 next：构造时立刻挂回调，避免丢掉 welcome 首包 */
function buffered() {
  const buffer: unknown[] = [];
  const waiters: { t: string; resolve: (m: unknown) => void; timer: NodeJS.Timeout }[] = [];
  return {
    push(m: unknown): void {
      const t = (m as { t: string }).t;
      const i = waiters.findIndex((w) => w.t === t);
      if (i >= 0) {
        clearTimeout(waiters[i]!.timer);
        waiters.splice(i, 1)[0]!.resolve(m);
      } else buffer.push(m);
    },
    next<T>(t: string, timeoutMs = 8000): Promise<T> {
      const bi = buffer.findIndex((m) => (m as { t: string }).t === t);
      if (bi >= 0) return Promise.resolve(buffer.splice(bi, 1)[0] as T);
      return new Promise<T>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`等 ${t} 超时`)), timeoutMs);
        waiters.push({ t, resolve: res as (m: unknown) => void, timer });
      });
    },
  };
}

/** 远程 WS 客户端（node 20/22 同一套，靠 src/__tests__/setup.ts 补 WebSocket） */
function wsClient(h: GameServerHandle): Promise<AnyClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}`);
    const b = buffered();
    ws.on('message', (d) => b.push(JSON.parse(String(d))));
    ws.on('open', () =>
      resolve({
        sendClaim: (d) => ws.send(JSON.stringify({ t: 'claim', d })),
        sendInput: (vx, vy, act) =>
          ws.send(JSON.stringify({ t: 'input', d: act ? { vx, vy, act } : { vx, vy } })),
        sendRaw: (m) => ws.send(JSON.stringify(m)),
        next: b.next,
        close: () => ws.close(),
      }),
    );
    ws.on('error', reject);
  });
}

/** 本地（同进程）客户端：不走网络，直接与权威 sim 对接 */
function localClient(h: GameServerHandle): Promise<AnyClient> {
  return new Promise((resolve) => {
    const lc = h.localConnect();
    const b = buffered();
    // 立刻挂回调：localConnect 内部已注册进连接表，welcome 会立刻从 queued 补发过来
    lc.onMessage((m) => b.push(m));
    const sendRaw = (m: unknown): void => lc.send(m as ClientMsg);
    void b.next('welcome').then(() =>
      resolve({
        sendClaim: (d) => sendRaw({ t: 'claim', d }),
        sendInput: (vx, vy, act) => sendRaw({ t: 'input', d: act ? { vx, vy, act } : { vx, vy } }),
        sendRaw,
        next: b.next,
        close: () => lc.close(),
      }),
    );
  });
}

/** 关 AI + 关自动刷敌的干净 registry */
function quietRegistry(): ModRegistry {
  const reg = ModRegistry.default();
  reg.overrideTuning((t) => {
    t.raid.pressurePerSec = 0;
  });
  reg.disableSystem('behavior');
  return reg;
}

async function up(seed = 4242): Promise<GameServerHandle> {
  return createGameServer({
    registry: quietRegistry(),
    seed,
    port: 0,
    tickMs: 50,
    deltaMs: 60_000,
    fullMs: 60_000,
    pingMs: 60_000,
  });
}

describe('P3 本地通道（localConnect）基本闭环', () => {
  it('首包 welcome 与远程对称：构造即挂回调不丢包', async () => {
    const h = await up();
    try {
      const c = await localClient(h);
      try {
        // welcome 已在 localClient() 内等到；这里确认 claim 也能走完
        c.sendClaim({});
        const ack = await c.next<Ack>('claimAck');
        expect(ack.d.ok).toBe(true);
        expect(typeof ack.d.eid).toBe('number');
        expect(h.sim.pawn(ack.d.eid!)!.controlledBy).toBe('1');
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });

  it('claim + 移动输入 → 鼠真的移动（behavior 已禁：位移只可能来自输入）', async () => {
    const h = await up();
    try {
      const c = await localClient(h);
      try {
        c.sendClaim({});
        const ack = await c.next<Ack>('claimAck');
        const p = h.sim.pawn(ack.d.eid!)!;
        const x0 = p.pos.x;
        const y0 = p.pos.y;

        c.sendInput(1, 0); // 持续 +x 意图
        await sleep(200); // 4 个 tick，dt=0.05 × hero.speed 4.5 ≈ 0.9 格

        expect(p.pos.x).toBeGreaterThan(x0);
        expect(p.pos.y).toBe(y0);
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });

  it('act=attack → 蓄力推进到完成，相邻敌袭掉血', async () => {
    const h = await up();
    try {
      const c = await localClient(h);
      try {
        const p0 = [...h.sim.pawns()][0]!;
        const hostile = h.sim.spawnHostile('cat', p0.pos.x + 1, p0.pos.y);
        const hp0 = hostile.hp;

        c.sendClaim({});
        const ack = await c.next<Ack>('claimAck');
        expect(ack.d.eid).toBe(p0.eid);

        c.sendInput(0, 0, 'attack');
        const p = h.sim.pawn(p0.eid)!;
        // attackWindup 全库只有一处写入（sim.ts directAttack），AI 不走这条路径
        await waitFor(() => p.attackWindup !== undefined);
        expect(p.attackTargetId).toBe(hostile.id);

        await waitFor(() => p.attackWindup === undefined);
        const hp2 = h.sim.hostiles().find((x) => x.id === hostile.id)!.hp;
        expect(hp2).toBeLessThan(hp0);
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });

  it('坏形状 input 从本地通道发送也被 validInput 拦下（不崩、不移动）', async () => {
    const h = await up();
    try {
      const c = await localClient(h);
      try {
        c.sendClaim({});
        const ack = await c.next<Ack>('claimAck');
        const p = h.sim.pawn(ack.d.eid!)!;
        const x0 = p.pos.x;

        // 长度 >1：validInput 拒绝 → 服务端忽略 → 鼠不该被甩飞
        c.sendRaw({ t: 'input', d: { vx: 99, vy: 0 } });
        await sleep(150);
        expect(p.pos.x).toBeCloseTo(x0, 6);
        expect(h.sim.time).toBeGreaterThan(0); // 服务器还活着且在推进
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });

  it('本地通道断线 → 释放认领，另一连接能认领到同一只鼠', async () => {
    const h = await up();
    try {
      const first = [...h.sim.pawns()][0]!;
      const a = await localClient(h);
      a.sendClaim({});
      await a.next<Ack>('claimAck');
      expect(h.sim.pawn(first.eid)!.controlledBy).toBe('1');

      a.close();
      await sleep(60); // 等 close 事件被处理

      // 断线即释放（与远程通道同一套 disconnect）：不该被幽灵 id 永久占住
      expect(h.sim.pawn(first.eid)!.controlledBy).toBeUndefined();

      const b = await wsClient(h);
      try {
        b.sendClaim({});
        const rb = await b.next<Ack>('claimAck');
        expect(rb.d.ok).toBe(true);
        expect(rb.d.eid).toBe(first.eid);
      } finally {
        b.close();
      }
    } finally {
      await h.close();
    }
  });
});

describe('P3 无感：远程与本地等价', () => {
  it('同一服务器同时接 WS 与本地客户端：两条通道各认领各驱动，互不干扰', async () => {
    const h = await up();
    try {
      const [a, b] = await Promise.all([wsClient(h), localClient(h)]);
      try {
        a.sendClaim({});
        b.sendClaim({});
        const ra = await a.next<Ack>('claimAck');
        const rb = await b.next<Ack>('claimAck');

        // 各认领一只，不重复分配
        expect(ra.d.ok && rb.d.ok).toBe(true);
        expect(ra.d.eid).not.toBe(rb.d.eid);
        // 各自只认领了一只；归属键 = 连接到达序的客户端编号。
        // 不假设谁先到：localConnect 同步注册，通常比 WS 握手先到拿 #1。
        const owners = [h.sim.pawn(ra.d.eid!)!.controlledBy, h.sim.pawn(rb.d.eid!)!.controlledBy].sort();
        expect(owners).toEqual(['1', '2']);

        // 同一份输入，两条通道都真的驱动了自己的鼠
        const pa = h.sim.pawn(ra.d.eid!)!;
        const pb = h.sim.pawn(rb.d.eid!)!;
        const ax = pa.pos.x, ay = pa.pos.y, bx = pb.pos.x, by = pb.pos.y;
        a.sendInput(0, 1);
        b.sendInput(-1, 0);
        await sleep(200);
        expect(pa.pos.y).toBeGreaterThan(ay); // WS 通道：+y 生效
        expect(pb.pos.x).toBeLessThan(bx);    // 本地通道：-x 生效
        expect(pa.pos.x).toBe(ax);            // 没串味
        expect(pb.pos.y).toBe(by);
      } finally {
        a.close();
        b.close();
      }
    } finally {
      await h.close();
    }
  });

  it('同一脚本经两种通道：服务端可观测效果一致', async () => {
    type Effects = {
      claimedEid: number;
      controlledBy: string;
      movedForward: boolean;
      attackTargeted: boolean;
      hostileTookDamage: boolean;
    };
    async function drive(h: GameServerHandle, mk: (h: GameServerHandle) => Promise<AnyClient>): Promise<Effects> {
      const c = await mk(h);
      const p0 = [...h.sim.pawns()][0]!;
      const hostile = h.sim.spawnHostile('cat', p0.pos.x + 1, p0.pos.y);
      const hp0 = hostile.hp;
      try {
        c.sendClaim({});
        const ack = await c.next<Ack>('claimAck');
        const p = h.sim.pawn(ack.d.eid!)!;

        // 阶段 1：移动
        const x0 = p.pos.x;
        c.sendInput(1, 0);
        await sleep(160);
        const movedForward = p.pos.x > x0;

        // 阶段 2：攻击
        c.sendInput(0, 0, 'attack');
        await waitFor(() => p.attackWindup !== undefined);
        const attackTargeted = p.attackTargetId === hostile.id;
        await waitFor(() => p.attackWindup === undefined);
        const hp2 = h.sim.hostiles().find((x) => x.id === hostile.id)!.hp;

        return {
          claimedEid: ack.d.eid!,
          controlledBy: p.controlledBy ?? '',
          movedForward,
          attackTargeted,
          hostileTookDamage: hp2 < hp0,
        };
      } finally {
        c.close();
      }
    }

    // 同一 seed 的两个独立服务器，各走一条通道；确定性由 golden 保证，
    // 这里比的是"两种通道拿到的是不是同一种效果"。
    const hWs = await up(777);
    const hLoc = await up(777);
    try {
      const [eWs, eLoc] = await Promise.all([drive(hWs, wsClient), drive(hLoc, localClient)]);
      expect(eLoc).toEqual(eWs);
      // 顺带断言效果本身是真的（两边都对，而不是两边都静默失败）
      expect(eLoc).toEqual({
        claimedEid: expect.any(Number),
        controlledBy: '1',
        movedForward: true,
        attackTargeted: true,
        hostileTookDamage: true,
      });
    } finally {
      await hWs.close();
      await hLoc.close();
    }
  });
});
