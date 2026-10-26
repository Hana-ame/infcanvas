/**
 * P3 联机认领 + 权威输入消费（服务端）
 *
 * 背景：ClaimMsg / InputMsg / ClaimAckMsg / validClaim / validInput 在协议里早就
 * 定义了，SERVER_COMMANDS 白名单也放行了，但服务端**从未消费过它们**——
 * claimedEid / lastInput 只在连接建立时被初始化为 null，此后没有任何 handler
 * 读写、没有任何 tick 消费。结果：联机客户端连上后收得到世界状态，
 * 却控制不了任何一只鼠。
 *
 * 本文件钉住 P3 的服务端闭环：claim 认领（写 PawnState.controlledBy）+
 * 每 tick 消费 input（moveDir / directAttack）。
 *
 * 断言隔离：disableSystem('behavior')。behavior 是唯一的 per-pawn AI 决策系统，
 * 禁掉之后鼠只可能被 consumeClientInputs 驱动——不禁的话 AI 也会移鼠/打怪，
 * 断言会被污染。注意 pawn-bookkeeping（技能冷却 / 蓄力推进 / 疲劳）不走系统
 * 注册、不受影响，所以"蓄力推进到完成→结算伤害"这条链路是通的。
 *
 * 客户端用真实 WebSocket（node 20/22 同一套，靠 src/__tests__/setup.ts 补）。
 */
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGameServer, type GameServerHandle } from '../server/game-server';
import { ModRegistry } from '../mods';

interface TestClient {
  ws: WebSocket;
  next<T>(t: string, timeoutMs?: number): Promise<T>;
  close(): void;
}

/** 构造即挂缓冲——服务器 open 后立刻发 welcome，等 open 再挂会丢首包 */
function makeClient(url: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const buffer: unknown[] = [];
    const waiters: { t: string; resolve: (m: unknown) => void; timer: NodeJS.Timeout }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as { t: string };
      const i = waiters.findIndex((w) => w.t === m.t);
      if (i >= 0) {
        clearTimeout(waiters[i]!.timer);
        waiters.splice(i, 1)[0]!.resolve(m);
      } else buffer.push(m);
    });
    ws.on('open', () =>
      resolve({
        ws,
        close: () => ws.close(),
        next<T>(t: string, timeoutMs = 8000): Promise<T> {
          const bi = buffer.findIndex((m) => (m as { t: string }).t === t);
          if (bi >= 0) return Promise.resolve(buffer.splice(bi, 1)[0] as T);
          return new Promise<T>((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`等 ${t} 超时`)), timeoutMs);
            waiters.push({ t, resolve: res as (m: unknown) => void, timer });
          });
        },
      }),
    );
    ws.on('error', reject);
  });
}

/** 等一小段，跨过 N 个 tick */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等条件成立，而不是固定 sleep。
 *
 * input 上行到 consumeClientInputs 消费之间隔着一个 tick 周期（tickMs=50），
 * 固定 sleep(40) 刚好可能落在 tick 边界之前——那是"本地过、CI 红"的竞态，
 * 不是逻辑错误。等"可观测事实"（attackWindup 已出现）而不是等一个猜测的时间。
 */
async function waitFor(cond: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(intervalMs);
  }
  throw new Error(`等 ${timeoutMs}ms 超时：条件未成立`);
}

/** 关 AI + 关自动刷敌的干净 registry（见文件头说明） */
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

async function connect(h: GameServerHandle): Promise<TestClient> {
  const c = await makeClient(`ws://127.0.0.1:${h.port}`);
  await c.next('welcome');
  return c;
}

type Ack = { t: 'claimAck'; d: { ok: boolean; eid?: number; reason?: string } };

function sendClaim(c: TestClient, d: unknown): void {
  c.ws.send(JSON.stringify({ t: 'claim', d }));
}
function sendInput(c: TestClient, vx: number, vy: number, act?: 'attack' | 'interact'): void {
  c.ws.send(JSON.stringify({ t: 'input', d: act ? { vx, vy, act } : { vx, vy } }));
}

describe('P3 认领（claim / claimAck）', () => {
  it('d:{} → server 分配第一只未认领鼠，写 controlledBy 并回 ack', async () => {
    const h = await up();
    try {
      const pawns = [...h.sim.pawns()];
      const first = pawns[0]!;
      expect(first.controlledBy).toBeUndefined();

      const c = await connect(h);
      try {
        sendClaim(c, {});
        const ack = await c.next<Ack>('claimAck');
        expect(ack.d.ok).toBe(true);
        expect(ack.d.eid).toBe(first.eid);
        // 归属真的落到了 PawnState 上（不是只记在连接态）
        expect(h.sim.pawn(first.eid)!.controlledBy).toBe('1');
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });

  it('两个连接各自 d:{} → 拿到不同的鼠，不重复分配', async () => {
    const h = await up();
    try {
      const a = await connect(h);
      const b = await connect(h);
      try {
        sendClaim(a, {});
        sendClaim(b, {});
        const ra = await a.next<Ack>('claimAck');
        const rb = await b.next<Ack>('claimAck');
        expect(ra.d.ok && rb.d.ok).toBe(true);
        expect(ra.d.eid).not.toBe(rb.d.eid);
        // 各自只认领了一只
        expect([...h.sim.pawns()].filter((p) => p.controlledBy !== undefined).length).toBe(2);
      } finally {
        a.close();
        b.close();
      }
    } finally {
      await h.close();
    }
  });

  it('认领已被别人占的鼠 → reason=taken，且不动原归属', async () => {
    const h = await up();
    try {
      const first = [...h.sim.pawns()][0]!;
      const second = [...h.sim.pawns()][1]!;
      const a = await connect(h);
      const b = await connect(h);
      try {
        sendClaim(a, {});
        const ra = await a.next<Ack>('claimAck');
        sendClaim(b, { eid: ra.d.eid! });
        const rb = await b.next<Ack>('claimAck');
        expect(rb.d.ok).toBe(false);
        expect(rb.d.reason).toBe('taken');
        // 原归属没被碰掉；B 也没挂上别的鼠
        expect(h.sim.pawn(first.eid)!.controlledBy).toBe('1');
        expect(h.sim.pawn(second.eid)!.controlledBy).toBeUndefined();
      } finally {
        a.close();
        b.close();
      }
    } finally {
      await h.close();
    }
  });

  it('认领不存在的 eid → reason=noSuchPawn', async () => {
    const h = await up();
    try {
      const c = await connect(h);
      try {
        sendClaim(c, { eid: 999999 });
        const ack = await c.next<Ack>('claimAck');
        expect(ack.d.ok).toBe(false);
        expect(ack.d.reason).toBe('noSuchPawn');
        expect([...h.sim.pawns()].filter((p) => p.controlledBy !== undefined).length).toBe(0);
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });

  it('坏形状 claim 静默丢弃：不崩、不回 ack、不计入 rejectedCommands', async () => {
    const h = await up();
    try {
      const rejected0 = h.rejectedCommands();
      const c = await connect(h);
      try {
        // 三种坏形状：eid 非整数、eid 非数字、d 整体缺失
        for (const bad of [{ eid: -1 }, { eid: 'x' }, undefined]) sendClaim(c, bad);
        await sleep(120); // 跨过 2 个 tick：真崩了/真回包了会在这之前暴露
        // 服务器还活着且在推进（没被坏消息带崩）
        expect(h.sim.time).toBeGreaterThan(0);
        expect([...h.sim.pawns()].filter((p) => p.controlledBy !== undefined).length).toBe(0);
        expect(h.rejectedCommands()).toBe(rejected0); // 坏 claim 不算"有人在攻击服务器"
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });
});

describe('P3 权威输入消费（每 tick 消费 claim 的鼠）', () => {
  it('input 让鼠真的移动（behavior 已禁：位移只可能来自输入）', async () => {
    const h = await up();
    try {
      const c = await connect(h);
      try {
        sendClaim(c, {});
        const ack = await c.next<Ack>('claimAck');
        const p = h.sim.pawn(ack.d.eid!)!;
        const x0 = p.pos.x;
        const y0 = p.pos.y;

        sendInput(c, 1, 0); // 持续 +x 意图
        await sleep(200); // 4 个 tick，dt=0.05 × hero.speed 4.5 ≈ 0.9 格

        expect(p.pos.x).toBeGreaterThan(x0); // x 真的动了
        expect(p.pos.y).toBe(y0); // 没往 y 走
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });

  it('未认领的连接发 input 无效：不移动、不偷偷认领', async () => {
    const h = await up();
    try {
      const c = await connect(h);
      try {
        const first = [...h.sim.pawns()][0]!;
        const x0 = first.pos.x;
        sendInput(c, 1, 0);
        await sleep(150);
        expect(first.pos.x).toBe(x0); // 观察模式：输入被忽略
        expect(first.controlledBy).toBeUndefined();
        expect([...h.sim.pawns()].filter((p) => p.controlledBy !== undefined).length).toBe(0);
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });

  it('坏形状 input 静默丢弃（超大向量被 validInput 拦下）', async () => {
    const h = await up();
    try {
      const c = await connect(h);
      try {
        sendClaim(c, {});
        const ack = await c.next<Ack>('claimAck');
        const p = h.sim.pawn(ack.d.eid!)!;
        const x0 = p.pos.x;

        // 长度 >1：validInput 拒绝 → 服务端忽略 → 鼠不该被甩飞
        c.ws.send(JSON.stringify({ t: 'input', d: { vx: 99, vy: 0 } }));
        await sleep(150);
        expect(p.pos.x).toBeCloseTo(x0, 6);
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });

  it('act=attack → 权威侧 directAttack 生效：蓄力推进到完成，相邻敌袭掉血', async () => {
    const h = await up();
    try {
      const c = await connect(h);
      try {
        const p0 = [...h.sim.pawns()][0]!;
        // 敌袭放在鼠右侧一格（1.75 攻击距离内），行为已禁所以它不会自己跑
        const hostile = h.sim.spawnHostile('cat', p0.pos.x + 1, p0.pos.y);
        const hp0 = hostile.hp;
        expect(hp0).toBeGreaterThan(0);

        sendClaim(c, {});
        const ack = await c.next<Ack>('claimAck');
        expect(ack.d.eid).toBe(p0.eid);

        const hp1 = h.sim.hostiles().find((x) => x.id === hostile.id)!.hp;
        expect(hp1).toBe(hp0); // 认领本身不产生伤害

        sendInput(c, 0, 0, 'attack');
        const p = h.sim.pawn(p0.eid)!;
        // 等"蓄力已开始"这个可观测事实（见 waitFor 注释）
        await waitFor(() => p.attackWindup !== undefined);
        // attackWindup 只有一处写入（sim.ts:540 directAttack），AI 不走这条路径
        // —— 所以这个断言是"服务端确实消费了 input"的干净证据
        expect(p.attackTargetId).toBe(hostile.id);

        await waitFor(() => p.attackWindup === undefined); // 0.8s 蓄力完成即清
        const hp2 = h.sim.hostiles().find((x) => x.id === hostile.id)!.hp;
        expect(hp2).toBeLessThan(hp1); // 结算了伤害
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });
});

describe('P3 断线释放与换角色', () => {
  it('断线 → 释放认领，另一连接能认领到同一只鼠', async () => {
    const h = await up();
    try {
      const first = [...h.sim.pawns()][0]!;
      const a = await connect(h);
      sendClaim(a, {});
      await a.next<Ack>('claimAck');
      expect(h.sim.pawn(first.eid)!.controlledBy).toBe('1');

      a.close(); // 断线
      await sleep(80); // 等 close 事件被处理

      // 断线即释放（刻意取舍，见 releaseClaim 注释）：不该被幽灵 id 永久占住
      expect(h.sim.pawn(first.eid)!.controlledBy).toBeUndefined();

      const b = await connect(h);
      try {
        sendClaim(b, {});
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

  it('同一连接换角色 → 旧的被清掉，不留下孤儿的受控鼠', async () => {
    const h = await up();
    try {
      const c = await connect(h);
      try {
        sendClaim(c, {});
        const a = await c.next<Ack>('claimAck');
        const [pa, pb] = [...h.sim.pawns()];
        expect(a.d.ok).toBe(true);
        expect(h.sim.pawn(pa!.eid)!.controlledBy).toBe('1');

        sendClaim(c, { eid: pb!.eid });
        const b = await c.next<Ack>('claimAck');
        expect(b.d.ok).toBe(true);
        expect(h.sim.pawn(pb!.eid)!.controlledBy).toBe('1');
        expect(h.sim.pawn(pa!.eid)!.controlledBy).toBeUndefined(); // 换掉了，不留孤儿

        // 重复认领同一只 = 幂等，不报错
        sendClaim(c, { eid: pb!.eid });
        const c2 = await c.next<Ack>('claimAck');
        expect(c2.d.ok).toBe(true);
        expect(c2.d.eid).toBe(pb!.eid);
      } finally {
        c.close();
      }
    } finally {
      await h.close();
    }
  });
});
